# freebuff2api

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-%230db7ed.svg?logo=docker&logoColor=white)](Dockerfile)
[![Node.js](https://img.shields.io/badge/node.js-6DA55F?logo=node.js&logoColor=white)](package.json)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?logo=cloudflare&logoColor=white)](worker.js)

A high-performance reverse proxy that exposes Freebuff / Codebuff free models as OpenAI-compatible and Anthropic Messages-compatible APIs.

Designed with zero external npm dependencies, the project runs across Docker containers, standalone Node.js servers, or serverless Cloudflare Workers.

---

## Key Features

- **Unified API Interfaces**:
  - **OpenAI Chat Completions** (`/v1/chat/completions`) — Streaming (SSE) and non-streaming support.
  - **OpenAI Responses API** (`/v1/responses`) — Full event translation and format conversion.
  - **Anthropic Messages API** (`/v1/messages`, `/v1/messages/count_tokens`) — Native tools, system prompts, thinking effort, and Anthropic SSE streaming.
- **Advanced Multi-Account Management**:
  - Pool multiple accounts using comma/newline-separated tokens or directory mounting (`credentials/*.json`, `credentials/*.jsonl`).
  - Automatic cooldown and transparent in-request failover on 429 (rate limit) or stale sessions.
  - Configurable account selection strategies: `sticky`, `round_robin_active`, and `pure_round_robin`.
- **Anti-Ban and Upstream Lifecycle Emulation**:
  - Faithfully emulates Freebuff's agentic orchestrator lifecycle: Session Creation -> Run Chain Initialization -> Streaming Completion.
  - Auto-injects required system prompt signatures (`Buffy`) and synthetic tool markers.
  - Clamps reasoning effort per model to match official upstream constraints.
- **Zero-Dependency Egress Proxying**:
  - Built-in native support for HTTP CONNECT, SOCKS5 (RFC 1928 / RFC 1929 with auth), and raw `host:port[:user:pass]` proxy rotations directly in Node.js.
  - Optional Cloudflare Relay (`RELAY_URL`) support to mask egress traffic.
- **Observability and Health Checks**:
  - `GET /health` — Public endpoint returning status, version, active routing strategy, and aggregated account health metrics.
  - `GET /v1/accounts` — Authenticated inspection of account pool status, tiers, and quotas.

---

## Architecture Overview

```
                      ┌──────────────────────────────────────────────┐
                      │ Clients (OpenAI SDK, Anthropic SDK, Web UIs) │
                      └───────────────────────┬──────────────────────┘
                                              │
                    ┌─────────────────────────┴─────────────────────────┐
                    ▼                                                   ▼
        [Docker / Node.js Server]                             [Cloudflare Workers]
                server.js                                           worker.js
       (Zero-dependency HTTP Server)                             (Serverless Edge)
       (SOCKS5 / HTTP Proxy Manager)                                    │
                    │                                                   │
                    └─────────────────────────┬─────────────────────────┘
                                              ▼
                                          worker.js
                           ┌──────────────────────────────┐
                           │   Router & Protocol Adapters │
                           │  /v1/chat/completions        │
                           │  /v1/responses               │
                           │  /v1/messages                │
                           └──────────────┬───────────────┘
                                          ▼
                                     executeChat()
                           ┌──────────────────────────────┐
                           │  1. Strategy Token Selector  │
                           │  2. Session Cache (~1 hr)    │
                           │  3. Agent Run Chain (START)  │
                           │  4. Serial Queue (300ms gap) │
                           │  5. Upstream Stream Pipeline │
                           └──────────────┬───────────────┘
                                          ▼
                              Upstream (Codebuff / Relay)
```

---

## Quick Start

### Option 1: Docker (Recommended)

Docker deployment provides the highest stability, full egress proxy support (SOCKS5/HTTP), and credential directory mounting.

1. **Clone the repository:**
   ```bash
   git clone https://github.com/fdjrr/freebuff2api.git
   cd freebuff2api
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set your preferred settings:
   ```ini
   API_KEY=your-custom-api-key
   FREEBUFF_TOKEN=token1,token2
   ACCOUNT_SELECTION_STRATEGY=sticky
   ```

   *(Optional)* You can also mount credential files directly into `credentials/` as `.json` or `.jsonl` (e.g. `credentials/accounts.jsonl` containing `{"authToken": "...", "email": "..."}`).

3. **Start container:**
   ```bash
   docker compose up -d --build
   ```
   The service will listen on `http://localhost:8787` (or your configured `PORT`).

---

### Option 2: Local Node.js

Requires Node.js >= 20 (no `npm install` needed, pure standard library):

```bash
# Set environment variables
export API_KEY="your-custom-api-key"
export FREEBUFF_TOKEN="your_token_here"
export PORT=8787

# Start server
node server.js
```

---

### Option 3: Cloudflare Workers

Deploy the single-file worker directly to Cloudflare's serverless edge:

1. In Cloudflare Dashboard, go to **Workers & Pages** -> **Create Worker**.
2. Copy the entire contents of [`worker.js`](worker.js) into the code editor.
3. Configure the following environment variables / secrets (**Settings** -> **Variables and Secrets**):
   - `FREEBUFF_TOKEN`: Your comma-separated Freebuff tokens.
   - `API_KEY`: Custom client authentication key (default: `freebuff-default-key`).
   - `ACCOUNT_SELECTION_STRATEGY`: `sticky` *(default)*, `round_robin_active`, or `pure_round_robin`.
4. Deploy the worker.

---

## Configuration Reference

| Environment Variable | Default | Description |
|---|---|---|
| `API_KEY` | `freebuff-default-key` | Secret key required by clients (`Authorization: Bearer <key>` or `x-api-key`). |
| `FREEBUFF_TOKEN` | *(empty)* | Upstream authentication tokens (comma-separated or newline-separated). |
| `ACCOUNT_SELECTION_STRATEGY` | `sticky` | Account routing strategy: `sticky`, `round_robin_active`, or `pure_round_robin`. |
| `PORT` | `8787` | HTTP port for the Node.js server / Docker container. |
| `HOST` | `0.0.0.0` | Bind host address. |
| `FREEBUFF_DEBUG` | `false` | Enable detailed console logging for requests and upstream events. |
| `CODEBUFF_API` | `https://www.codebuff.com` | Override upstream endpoint URL. |
| `RELAY_URL` | *(empty)* | URL of a relay worker (e.g. `cloudflare-relay.js`) to route requests through. |
| `PROXIES_FILE` | `proxies.txt` | Path to rotating proxy list file. |
| `PROXY_URL` | *(empty)* | Upstream egress proxy URL (`http://`, `socks5://`, or raw `host:port:user:pass`). |

---

## Account Selection Strategies

Freebuff enforces session-based quota allocation (sessions last ~1 hour, and daily quotas are consumed on session creation). To accommodate different operational patterns, `freebuff2api` supports three selection strategies:

| Strategy | Description | Best For |
|---|---|---|
| **`sticky`** *(default)* | Keeps using an account with an active session until it expires or hits a rate limit, then moves to the next. | **Maximizing daily session quota** (recommended for low-to-medium multi-account pools). |
| **`round_robin_active`** | Round-robins requests across all accounts that already have an active session cached. Falls back to round-robin among idle accounts when no session exists. | **Load balancing traffic** across multiple accounts without prematurely consuming new daily session slots. |
| **`pure_round_robin`** | Strict round-robin across all available accounts on every incoming request, completely bypassing the session cache. | High concurrency scenarios where session churn is acceptable. |

---

## Available Models

The model catalog is dynamically synchronized against official Freebuff sources and categorized into quota pools:

### 1. Standard Models (High Capacity)
- `deepseek/deepseek-v4-flash` *(Recommended default)*
- `mimo/mimo-v2.5`

### 2. Premium Models (Shared Quota Pool)
- `deepseek/deepseek-v4-pro`
- `minimax/minimax-m3`
- `openai/gpt-5.6-luna`
- `poolside/laguna-s-2.1`
- `openrouter/poolside/laguna-s-2.1`
- `meta/muse-spark-1.2-contributor`
- `crof/greg-2-ultra`
- `crof/greg-2-super`

### 3. Independent & Special Models
- `z-ai/glm-5.2` (Referral / unlocked quota)
- `anthropic/claude-fable-5` (Capacity-limited trial)

> Note: Check `/v1/models` on your deployed instance to view the live, dynamically resolved model catalog.

---

## API Usage Examples

### 1. Health Check
```bash
curl http://localhost:8787/health
```
```json
{
  "status": "ok",
  "version": "1.8.9",
  "strategy": "sticky",
  "accounts": 3,
  "alive_accounts": 3,
  "time": "2026-09-04T10:00:00.000Z"
}
```

### 2. OpenAI Chat Completions (`/v1/chat/completions`)

**Streaming:**
```bash
curl -N http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer freebuff-default-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [
      {"role": "user", "content": "Explain quantum entanglement in simple terms."}
    ],
    "stream": true
  }'
```

**Non-Streaming:**
```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer freebuff-default-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

---

### 3. Anthropic Messages API (`/v1/messages`)

```bash
curl http://localhost:8787/v1/messages \
  -H "x-api-key: freebuff-default-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Write a quicksort function in JavaScript."}
    ]
  }'
```

---

### 4. OpenAI Responses API (`/v1/responses`)

```bash
curl http://localhost:8787/v1/responses \
  -H "Authorization: Bearer freebuff-default-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "input": "Summarize the benefits of clean architecture.",
    "stream": false
  }'
```

---

## Security & Best Practices

- **Token Security**: Never commit `credentials/`, `.env`, or raw tokens into version control. Ensure proper file permissions (`chmod 600 .env credentials/*`).
- **Network Egress**: Freebuff models typically require US egress IP addresses. If hosting outside the US, utilize the built-in `PROXY_URL` (SOCKS5/HTTP) or deploy the lightweight `cloudflare-relay.js` to route outbound calls cleanly.
- **Single-Account Concurrency**: Each Freebuff account allows one active session at a time. The proxy queues requests per account with an intentional serial delay to prevent concurrent collisions and session evictions.

---

## License

This project is open-source software licensed under the [MIT License](LICENSE).
