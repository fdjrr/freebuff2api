# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A reverse-engineered proxy that exposes **Freebuff/Codebuff's free models** as an OpenAI-compatible API. Single-file Cloudflare Worker (`worker.js`, ~2140 lines) with a Node.js wrapper (`server.js`) for Docker deployment. Supports OpenAI Chat Completions, OpenAI Responses API, and Anthropic Messages API.

## Run Commands

```bash
# Start Docker container (recommended deployment)
docker compose up -d --build

# Start Node.js server directly (for development)
node server.js

# Build model cache JSON from official Freebuff sources
node scripts/models.mjs

# Test API endpoints
curl http://localhost:8787/health
curl http://localhost:8787/v1/models -H "Authorization: Bearer <key>"
curl http://localhost:8787/v1/chat/completions -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"Hi"}]}'
```

## Architecture

### Core Files

- **`worker.js`** (~2140 lines) — Single-file Cloudflare Worker. All logic lives here: routing, upstream API lifecycle, multi-account management, model registry, streaming, and all API format adapters (OpenAI Chat, OpenAI Responses, Anthropic Messages). Exports a `fetch(request, env)` handler.

- **`server.js`** (~102 lines) — Node.js HTTP server that wraps `worker.js` for Docker deployment. Reads credentials from `credentials/*.json` directory, builds `FREEBUFF_TOKEN` env var, and translates Node.js HTTP ↔ Cloudflare `Request`/`Response`.

- **`scripts/models.mjs`** — Standalone parser that fetches Freebuff's official TypeScript source files from GitHub, extracts model→agent mappings and pool definitions, and produces `freebuff-models.json` + `MODELS.md`.

> Tokens are supplied directly (`FREEBUFF_TOKEN` env var, or `credentials/*.json` in Docker). The in-repo token extraction tooling and GitHub Actions workflows were removed — see `server.js` for how credentials are loaded.

### Request Flow

```
Client → worker.js (fetch handler)
  ├── /health → account health summary (no auth)
  ├── /v1/models → static model list (no upstream calls)
  ├── /v1/chat/completions → executeChat()
  ├── /v1/responses → responsesToChatParams() → executeChat()
  └── /v1/messages → anthropicToChat() → executeChat()
```

### Upstream Lifecycle (inside executeChat)

```
executeChat()
  ├── pickToken() — select account (round-robin, prefer active session cache)
  ├── createSession() — POST /api/v1/freebuff/session (or reuse cached)
  ├── startRunChain() — START root agent run + context-pruner sub-run
  ├── POST /api/v1/chat/completions (streaming forced upstream)
  │     ├── pipeUpstreamToClient() — SSE passthrough (OpenAI Chat format)
  │     └── pipeUpstreamToResponsesStream() — SSE translation (Responses format)
  └── Account failover on 429/428/409/410/empty stream
```

### Key Mechanisms

- **Serial upstream queue**: Free requests are pipelined through a Promise chain with a 300ms gap (`enqueue()`/`enqueueUp()`). Free tier concurrency >1 causes upstream errors.

- **Multi-account pool**: `FREEBUFF_TOKEN` supports comma-separated or newline-separated tokens. Each account gets a cooldown timer on failure. Account selection prefers cached active sessions, then round-robins.

- **Session cache**: Sessions last ~1 hour. Quota is consumed on session creation, not per message. Cache keyed by `token:sessionModel` — active sessions are reused across requests.

- **Dynamic model registry**: On startup and every 6 hours, `refreshDynamicModelsIfStale()` fetches Freebuff's official TypeScript source files from GitHub raw (3 sources: `free-agents.ts`, `freebuff-models.ts`, `freebuff-model-ids.ts`). Falls back to GitHub Releases JSON (`freebuff-models.json`), then hardcoded `MODELS` array.

- **Account health observation**: Passive — records upstream responses (`recordAccountObservation()`). No active probing. `/health` reports summary from cache.

- **Buffy system prompt injection**: Freebuff requires `"You are Buffy, the strategic coding assistant."` at byte-position 0 of system messages. Auto-injected in `normalizeMessages()`.

- **Reasoning effort clamping**: Per-model effort tables (`MODEL_EFFORTS`) — requested effort is clamped down to the nearest allowed tier.

- **Tool signature**: If `tools` array is present without `end_turn`, it's auto-injected as a Freebuff tool-collection signature marker.

### API Adapters

- **OpenAI Chat Completions** (`/v1/chat/completions`): Native upstream format. SSE passthrough in `pipeUpstreamToClient()` (unwraps nested `{data:...}` wrapper).

- **OpenAI Responses API** (`/v1/responses`): `responsesToChatParams()` translates Responses input → Chat params. `pipeUpstreamToResponsesStream()` translates Chat SSE → Responses SSE events.

- **Anthropic Messages API** (`/v1/messages`, `/v1/messages/count_tokens`): `anthropicToChat()` converts Anthropic format → Chat params. `anthropicStream()` translates Chat SSE → Anthropic SSE events. Tool calls, images, thinking budget → effort mapping all handled.

### Model Pools

Three upstream quota pools (from Freebuff's `freebuff-models.ts`):
- **Premium**: shared 6 sessions/day (m3, v4-pro, luna, laguna, muse-spark, greg-2)
- **Standard**: 6 sessions/day (flash, mimo-v2.5 — "unlimited" on CLI, but CLI is blocked)
- **GLM**: independent pool (referral-unlocked, glm-5.2)

### Configuration

| Env Var | Description |
|---|---|
| `FREEBUFF_TOKEN` | API tokens, comma/newline separated (Docker: `credentials/*.json`) |
| `FREEBUFF_API_KEY` | Custom API key for clients (default: `freebuff-default-key`) |
| `FREEBUFF_DEBUG` | `true` for per-request debug logging |
| `CODEBUFF_API` | Upstream URL override (default: `https://www.codebuff.com`) |
| `RELAY_URL` | Relay worker URL (e.g. `https://cloudflare-relay.freebuff.workers.dev/`) — routes all upstream traffic through relay |
| `PORT` / `HOST` | Listen port/address (default: `8787` / `0.0.0.0`) |

### Docker Deployment

Dockerfile bundles only `server.js` + `worker.js` (no npm dependencies). Credentials mounted as `credentials/:ro`. Docker Compose maps port 8787 → 8877, uses external `homelabs` network.

### GitHub Actions

No workflows are tracked in this repository — the model-cache and token-extraction workflows were removed. `scripts/models.mjs` remains runnable locally (`node scripts/models.mjs`) to refresh the model cache.
