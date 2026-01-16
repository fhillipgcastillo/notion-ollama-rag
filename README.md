## Project: Notion → Ollama RAG Bridge (Node.js)

**Purpose**
A small local bridge that:

* Fetches and indexes Notion page content
* Performs fast local retrieval over chunks
* Builds a focused prompt with retrieved context
* Sends prompt to a local Ollama model and returns the answer

This repository implements a minimal, production-oriented foundation for asking questions about your Notion notes using a locally hosted LLM (Ollama).

---

## Prerequisites

* Node.js 18+ (or compatible)
* npm
* Local Ollama instance running and a model downloaded

  * Default Ollama HTTP API endpoint: `http://localhost:11434` (or your ngrok URL)
* A Notion integration token with **Edit** access to the pages you will index
* (Optional) ngrok / Cloudflare Tunnel if you need remote access

---

## Environment variables setup

1. Copy the example environment file to create your local configuration:

```bash
cp .env.example .env
```

2. Open `.env` and configure the following variables with your actual values:

```
NOTION_TOKEN=secret_xxx                    # Your Notion integration token
OLLAMA_URL=http://localhost:11434          # or https://<your-ngrok>.ngrok.app
OLLAMA_MODEL=llama3.1                      # The Ollama model to use
PORT=3000                                   # Server port
COMMA_SEPARATED_PAGE_IDS=pageid1,pageid2   # (Optional) Initial pages to auto-index
```

**Security note:** The `.env` file contains sensitive information like your Notion token and page IDs. This file is already included in `.gitignore` to prevent accidentally exposing these credentials. Never commit `.env` to source control.

---

## Install

```bash
npm install
```

(If using the example code, ensure `package.json` includes `"type": "module"` when using ESM imports.)

---

## Run (development)

```bash
node index.js
```

Expected log on startup:

```
Bridge listening on http://localhost:3000
Auto-indexing pages from COMMA_SEPARATED_PAGE_IDS... (if set)
```

---

## HTTP API (basic usage)

### 1) Reindex pages

* Endpoint: `POST /reindex`
* Purpose: fetch and index one or more Notion pages
* Body:

```json
{ "pageIds": ["PAGE_ID_1", "PAGE_ID_2"] }
```

Response: `{ "indexed": <count> }`

### 2) Ask a question

* Endpoint: `POST /ask`
* Purpose: perform retrieval over the local index and forward a prompt to Ollama
* Body:

```json
{ "query": "What are the action items for server backups?", "topK": 5 }
```

Response example:

```json
{ "answer": "...", "usedChunks": 3 }
```

---

## How it works (summary)

1. `reindex` uses the Notion API to read blocks for each provided page ID and convert them to plain text.
2. Text is chunked (configurable chunk size & overlap) and added to a local search index (FlexSearch Document) with metadata (title, pageId, chunkIndex).
3. `ask` runs a search against the index, selects top-K chunks, builds a prompt that includes those chunks and the user question, and sends it to Ollama's `/api/generate` endpoint.
4. The returned text is forwarded to the client and can also be written back to Notion as a block if desired.

---

## Getting Notion Page IDs

From a Notion page URL such as:

```
https://www.notion.so/Project-Notes-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

The page ID is the UUID part (with or without dashes). Convert to dashed UUID if necessary:

```
aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
```

---

## Example cURL usage

Reindex pages:

```bash
curl -X POST http://localhost:3000/reindex \
  -H "Content-Type: application/json" \
  -d '{"pageIds":["PAGE_ID_1","PAGE_ID_2"]}'
```

Ask a question:

```bash
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"query":"What are the main takeaways from my notes about X?","topK":5}'
```

---

## Troubleshooting

* **No results / empty answer**

  * Confirm the pages are shared with your Notion integration and `NOTION_TOKEN` has proper scope.
  * Ensure `indexNotionPages` succeeded (check logs for "Indexed page")
  * Increase `topK` to include more chunks.

* **Ollama connection errors**

  * Verify `OLLAMA_URL` is reachable. If Ollama runs locally at `http://localhost:11434`, use that.
  * If using ngrok, ensure the tunnel is active and forwarding correctly.

* **Indexing slow or incomplete**

  * Large pages may need larger chunk sizes or higher overlap.
  * Consider batching index operations or persisting index to disk.

---

## Security & deployment notes

* Do not expose the bridge publicly without authentication.
* If you must expose it, add at minimum:

  * Basic token auth
  * IP allowlist
  * HTTPS (use ngrok or TLS)
* Prefer pull-based operations (bridge calls Notion API) over exposing your local server to incoming webhooks.

---

## Where to extend (quick pointers)

* Persist the FlexSearch index to disk or use a lightweight DB (SQLite) for persistence across restarts.
* Replace FlexSearch with a local vector store (e.g., SQLite + embeddings) for semantic search.
* Add a simple frontend or CLI tool for sending queries interactively.
* Implement optional automatic writes back to Notion (append answers as callout blocks).

---

## License

MIT
