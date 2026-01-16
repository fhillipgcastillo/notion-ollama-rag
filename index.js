import express from "express";
import axios from "axios";
import { Client } from "@notionhq/client";
import { Document } from "flexsearch";
import "dotenv/config";
import crypto from "crypto";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const app = express();
app.use(express.json());

const index = new Document({
  document: {
    id: "id",
    index: ["content", "title"],
    store: ["content", "title", "pageId", "chunkIndex"],
  },
  tokenize: "forward",
  cache: 100,
});

function chunkText(text, size = 800, overlap = 100) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const chunk = text.slice(i, i + size);
    chunks.push(chunk.trim());
    i += size - overlap;
  }
  return chunks;
}

async function extractTextFromBlocks(pageId) {
  // Fetch blocks and recursively gather plain text
  const blocks = [];
  let cursor = undefined;
  do {
    const resp = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);

  // Extract text
  let text = "";
  for (const b of blocks) {
    // handle common types
    const type = b.type;
    if (type === "paragraph" || type === "heading_1" || type === "heading_2" || type === "heading_3") {
      const rich = b[type]?.rich_text || [];
      for (const r of rich) {
        if (r.type === "text") text += r.plain_text;
        else text += r.plain_text || "";
      }
      text += "\n\n";
    } else if (type === "bulleted_list_item" || type === "numbered_list_item" || type === "to_do") {
      const rich = b[type]?.rich_text || [];
      for (const r of rich) text += r.plain_text || "";
      text += "\n";
    } else if (type === "code") {
      text += (b.code?.plain_text || "") + "\n\n";
    } else {
      // fallback attempt to read `plain_text` from available fields
      const raw = JSON.stringify(b);
      // avoid bloat: skip
    }
  }
  return text.trim();
}

async function getPageTitle(pageId) {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    // title is in properties; find a title property
    const props = page.properties || {};
    for (const key of Object.keys(props)) {
      const p = props[key];
      if (p.type === "title" && Array.isArray(p.title) && p.title.length) {
        return p.title.map(t => t.plain_text).join("") || "Untitled";
      }
    }
  } catch (e) {
    // ignore
  }
  return "Untitled";
}

async function indexNotionPages(pageIds = []) {
  index.clear();
  for (const pageId of pageIds) {
    try {
      const title = await getPageTitle(pageId);
      const text = await extractTextFromBlocks(pageId);
      if (!text) continue;
      const chunks = chunkText(text, 1000, 200);
      for (let i = 0; i < chunks.length; i++) {
        const id = crypto.createHash("sha1").update(pageId + ":" + i).digest("hex");
        index.add({
          id,
          content: chunks[i],
          title,
          pageId,
          chunkIndex: i,
        });
      }
      console.log(`Indexed page: ${title} (${pageId}) -> ${chunks.length} chunks`);
    } catch (err) {
      console.error("Index error for", pageId, err.message || err);
    }
  }
}

function buildPrompt(retrievedChunks, question) {
  const header = "You are given the following excerpts from my Notion notes. Use them to answer the question precisely and cite which page title the info came from when relevant.\n\n";
  const context = retrievedChunks.map((c, idx) => `---\n[${c.title}] chunk#${c.chunkIndex}\n${c.content}\n`).join("\n");
  const q = `\n\nQuestion: ${question}\nAnswer:`;
  // Optional: instruct output format
  return header + context + q;
}

async function askOllama(prompt) {
  const url = `${process.env.OLLAMA_URL.replace(/\/$/, "")}/api/generate`;
  const body = {
    model: process.env.OLLAMA_MODEL,
    prompt,
    stream: false,
    // optionally set other fields per Ollama API
  };
  const resp = await axios.post(url, body, { timeout: 120000 });
  // Ollama's response shape may vary; adapt if needed.
  // Many Ollama endpoints return { "response": "..." } or similar.
  if (resp.data?.response) return resp.data.response;
  if (typeof resp.data === "string") return resp.data;
  // fallback: stringify
  return JSON.stringify(resp.data);
}

// ===================================================

// HTTP endpoints
app.post("/reindex", async (req, res) => {
  const pageIds = (process.env.COMMA_SEPARATED_PAGE_IDS || "").split(",").filter(Boolean)
    .concat(Array.isArray(req.body.pageIds) ? req.body.pageIds : []);
  if (pageIds.length === 0) return res.status(400).json({ error: "no pageIds" });
  await indexNotionPages(pageIds);
  res.json({ indexed: pageIds.length });
});

app.post("/ask", async (req, res) => {
  const { query, topK = 5 } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });

  // search
  const results = index.search({
    query,
    limit: topK,
    enrich: true,
  });

  // FlexSearch Document search returns list of docs per result; flatten:
  const docs = [];
  for (const r of results) {
    if (r.result && r.result.length) {
      for (const doc of r.result) {
        // doc is stored document
        docs.push(doc);
      }
    }
  }

  // De-duplicate and pick topK
  const seen = new Set();
  const retrieved = [];
  for (const d of docs) {
    if (!d || !d.id) continue;
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    retrieved.push(d);
    if (retrieved.length >= topK) break;
  }

  const prompt = buildPrompt(retrieved, query);
  try {
    const answer = await askOllama(prompt);
    res.json({ answer, usedChunks: retrieved.length });
  } catch (err) {
    console.error(err?.response?.data || err.message || err);
    res.status(500).json({ error: "ollama error", details: err?.message || err });
  }
});

const PORT = process.env.PORT || 3030;
app.listen(PORT, async () => {
  console.log(`Bridge listening on http://localhost:${PORT}`);
  // On startup, optionally auto-index pages supplied in env
  const envPages = (process.env.COMMA_SEPARATED_PAGE_IDS || "").split(",").filter(Boolean);
  if (envPages.length) {
    console.log("Auto-indexing pages from COMMA_SEPARATED_PAGE_IDS...");
    await indexNotionPages(envPages);
    console.log("Indexing done.");
  } else {
    console.log("No pages provided for auto-index (set COMMA_SEPARATED_PAGE_IDS) — call /reindex with pageIds or POST to /reindex.");
  }
});

