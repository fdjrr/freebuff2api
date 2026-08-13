# freebuff2api-workers

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 🎉 Welcome! For questions or ideas, feel free to open an Issue / PR.
> License: **[MIT](#-license)**

Exposes **freebuff/codebuff**'s free models as an **OpenAI-compatible API**. Single-file, zero external dependencies — **Docker container deployment recommended** (or self-hosted VPS). Compatible with any OpenAI SDK / client (QwenPaw, Hermes, ChatGPT-Next-Web, LobeChat, one-api, etc.).

> ⚠️ **Important Deployment Note**: Freebuff has been actively detecting Cloudflare Worker deployments (identifying `cf-worker` / `cf-ray` edge markers). **Deploying on CF significantly increases the risk of account suspension.** Therefore, this project **does NOT recommend Cloudflare deployment** — use **Docker containers** or a self-hosted VPS instead (see "[🐳 Docker Container Deployment](#-docker-container-deployment-recommended)" below).

## ✨ Features

- ⭐ **Full-Access Mode Models**: Cloudflare Workers default to US egress, typically granting Freebuff's full-access mode; DeepSeek V4 Flash and MiMo 2.5 are officially classified as non-Premium models
- 🔒 **Standard Model Base Quota**: Aside from the two special models above, regular models operate on a base quota of 6 sessions per day; not advertised as unlimited
- 🔁 **Multi-Account Auto-Failover**: Automatically cools down quota-exhausted accounts and switches to the next — just comma-separate your tokens
- 💡 **Active Session Reuse Priority**: A session lasts ~1 hour; quota is deducted only when a session is created. As long as the current model's session is still active, the Worker sticks to the same account, maximizing quota utilization
- 📢 **Ad & Streak Flow Compatibility**: Before creating a new session, the Worker requests ads (matching the official client flow) and calls `GET /api/v1/freebuff/streak` for check-in. Failures are silently skipped — they never block the chat
- 🧩 **OpenAI Compatible**: `/v1/models`, `/v1/chat/completions`, `/v1/responses` (streaming/non-streaming depending on interface support)
- 📨 **Anthropic Messages API**: Supports `/v1/messages`, `/messages`, and corresponding `count_tokens` routes — usable with Anthropic SDK / compatible clients
- ❤️ **Health Check**: `GET /healthz` (no auth required) — convenient for monitoring uptime
- 📦 **Single-File Deployment**: Zero dependencies, single `worker.js` — works across CF / Docker / VPS

## 📨 Anthropic Messages API Support

The codebase includes an Anthropic Messages API adapter, currently supporting:

- `POST /v1/messages`
- `POST /messages`
- `POST /v1/messages/count_tokens`
- `POST /messages/count_tokens`
- Conversion of Anthropic message format to the Worker's internal OpenAI-compatible request format
- Text messages, `tool_use` / `tool_result`, `tool_choice`
- Non-streaming responses and Anthropic SSE streaming
- Anthropic-style error responses

> ⚠️ **Testing Note**: The current maintainers lack a real Anthropic Messages API client environment, so end-to-end testing with actual Anthropic clients has not been completed. The core code and local stub/regression tests handle and verify the conversion logic, but not all Anthropic SDK, tool-call combinations, and client behaviors have been covered.
>
> If you have an actual use case for the Anthropic Messages API, testing is welcome as long as existing OpenAI API routes are not affected. Please report request format, streaming response, tool-call, or model compatibility issues you encounter, ideally with a sanitized request structure, response status code, and error message.
>
> The Anthropic API is a new protocol adaptation layer — it does not change the existing OpenAI `/v1/chat/completions`, `/v1/responses`, account rotation, session lifecycle, or Freebuff main call chain.

## ⭐ Special Models: DeepSeek V4 Flash & MiMo 2.5

When the Worker accesses Freebuff via Cloudflare Workers, the upstream typically identifies the request as originating from the US (full-access mode). In full-access mode, the official Desktop client classifies the following two models as **unlimited non-Premium** categories. Here, `unlimited` primarily refers to the model classification and concurrency category — **not an absolute guarantee of no limits across all accounts, regions, interfaces, or time periods**:

| Model | Full-Access Mode Notes |
|---|---|
| `deepseek/deepseek-v4-flash` | Official non-Premium model; primary recommendation; no daily base limit detected by the Worker |
| `mimo/mimo-v2.5` | Official non-Premium model; no daily base limit detected by the Worker |

> ⚠️ In restricted mode, Freebuff officially limits these two models to 6 one-hour sessions per day. The Worker defaults to US egress, which typically avoids this restricted mode. Actual availability and quotas depend on the Freebuff upstream response — official rules may also change.

Apart from these two special models, all regular models are understood to have a **base quota of 6 sessions per Pacific day** (resetting around 15:00 Beijing time). `referral`, `streak`, independent shared pools, and upstream temporary limits are additional conditions — they should not be used to advertise unlimited usage.

> 💡 **About Quota**: Quota is deducted when a **session is created** (not per conversation turn). A session lasts ~1 hour, during which multiple conversation rounds do not consume additional quota. So 4 accounts × 6 sessions/day ≈ full-day coverage.
>
> 📝 **Ad & Streak Notes**: Before creating a new session, the Worker requests ads (matching the official client flow) and calls `GET /api/v1/freebuff/streak` for check-in. Whether continuous usage grants extra quota, and how much, is determined by Freebuff's server — this flow is not a quota guarantee and does not change the session-based deduction rules.

## 🚀 Quick Start

1. Obtain a freebuff token (see "[Obtaining FREEBUFF_TOKEN](#-obtaining-freebuff_token)" below)
2. Deploy the service (see "[Deployment](#-deployment)" below — **Docker container deployment recommended**)
3. Configure environment variables:
   - `FREEBUFF_TOKEN` (required) = your token
   - `FREEBUFF_API_KEY` (optional) = custom API access key, defaults to `freebuff-default-key`
4. Connect with any OpenAI client:
   - **Base URL**: `http://localhost:8877/v1` (Docker) or `https://your-worker.your-subdomain.workers.dev/v1` (CF, not recommended)
   - **API Key**: `<your FREEBUFF_API_KEY value>`

> 🌐 **Custom Domain**: If `*.workers.dev` is inaccessible from your region (blocked/restricted), you can bind a custom domain to the Worker and use `https://your-domain/v1` as the Base URL. See "[Custom Domain](#-custom-domain)" below.

## ❤️ Health Check

After deployment, use (**no API key required**):

```bash
curl https://your-worker.workers.dev/healthz
# {"status":"ok","version":"1.4.0","time":"..."}
```

- The `version` field shows the current deployed version — **it changes with every deployment**, useful for verifying whether the latest update is live (CF edge cache has a delay; wait a few seconds or add a random parameter when checking)
- Suitable for UptimeRobot / self-hosted monitoring

## 🔑 Obtaining FREEBUFF_TOKEN

The freebuff auth token is obtained via the same **authorization code polling** mechanism used by the official CLI. The project includes an extraction tool at `freebuff_tools/extract_freebuff.py`, with an interactive flow identical to `cline_oauth.py`.

### Method A: GitHub Actions Workflow (Recommended, Remote Extraction)

The repository includes a workflow at `.github/workflows/extract-token.yml` that runs extraction in GitHub Actions. The authorization link and token are sent only to your Telegram — all logs are masked (`::add-mask::`), ensuring no sensitive information is leaked.

**Step 1: Configure Secrets** (repo Settings → Secrets and variables → Actions):

| Secret | Description |
|---|---|
| `TG_BOT_TOKEN` | Telegram bot token (create one via @BotFather, e.g. `123456:ABC-xxx`) |
| `TG_CHAT_ID` | Your Telegram numeric chat ID (message @userinfobot to get it) |

**Step 2: Run the Workflow**:

1. Repository page → **Actions** → **Get Freebuff authToken** → **Run workflow**
2. Optionally fill in `poll_timeout` (authorization wait time in seconds, default 300) and `fingerprint` (leave blank for auto-generation)
3. You'll receive a login link on Telegram — open it in a browser and log in with your Google account
4. Once the script polls the token, the full token is sent directly to your Telegram (the Actions logs only show `***`)
5. After completion, old run records are automatically cleaned up — only the latest 1 run is kept

> If `TG_BOT_TOKEN` / `TG_CHAT_ID` are not configured, the workflow will fail immediately on the first step without executing the extraction.

### Method B: Local Extraction

```bash
cd freebuff_tools
python3 extract_freebuff.py login   # Prints the authorization URL to the terminal — authorize in browser, then auto-poll
python3 extract_freebuff.py show    # Displays all accounts: email + token + status + summary, one per line
python3 extract_freebuff.py tgsend  # Test Telegram connectivity (when TG is configured)
```

When running `login` locally, each account is **appended with a separate key** to `freebuff_tools/freebuff_credentials.json` (does not overwrite existing accounts, supports Google / GitHub login, both auto-recorded). This file is covered by `.gitignore` and will not be committed to GitHub. See `freebuff_tools/freebuff_credentials.example.json` for the structure.

Other useful commands:

```bash
python3 extract_freebuff.py export           # Summarize all account tokens, one per line — ready to copy into CF Workers variables
python3 extract_freebuff.py quota            # Check usage
python3 extract_freebuff.py session          # Create / check sessions
python3 extract_freebuff.py chat "Hello"     # Send a test message to the model API
```

> 💡 `show` internally uses `GET /api/v1/freebuff/session` to probe each account (**no session created, zero cost**), displaying all statuses at once: active + quota / token expired / banned / region-restricted / quota exhausted. For banned accounts, the official API returns `status: banned` on all endpoints. With multiple accounts, `export` outputs each token on a separate line — paste them directly into the Cloudflare Worker variable `FREEBUFF_TOKEN` (newline-separated).

## 🛠️ Deployment

### 🐳 Docker Container Deployment (✅ Recommended)

> Suitable for local/NAS/VPS long-running operation: not subject to Cloudflare Workers limits, **does not expose CF edge markers** (`cf-worker` / `cf-ray`), significantly lower account suspension risk compared to CF deployment. The same codebase can also run on CF (not recommended).

**Quick Deploy:**

```bash
# 1. Prepare the directory — copy the following files: worker.js server.js package.json Dockerfile docker-compose.yml
mkdir freebuff2api && cd freebuff2api

# 2. Configure .env (API key + optional RELAY_KEY)
cat > .env <<'EOF'
FREEBUFF_API_KEY=your-api-key
RELAY_KEY=
EOF

# 3. Account credentials: place one JSON file per account under credentials/ (server.js reads the authToken field)
mkdir -p credentials
# credentials/<any-name>.json = {"email": "...", "authToken": "...", "name": "..."}

# 4. Start
chmod 600 .env credentials/*.json
docker compose up -d --build
```

After startup, the service listens on `0.0.0.0:8787` (compose maps to host port `8877`). Base URL: `http://localhost:8877/v1`.

**Environment Variables:**

| Variable | Description |
|---|---|
| `PORT` / `HOST` | Listen port/address, defaults to `8787` / `0.0.0.0` |
| `FREEBUFF_API_KEY` | API access key (defaults to `freebuff-default-key`) |
| `FREEBUFF_DEBUG` | Set to `true` to enable per-request debug logging |
| `CODEBUFF_API` | Upstream address; empty = direct to `https://www.codebuff.com`; set to a relay domain when using a self-hosted relay |
| `RELAY_KEY` | Relay key (required when `CODEBUFF_API` points to an authenticated relay) |

> ⚠️ Inside the container, `credentials/` is mounted as read-only. `server.js` reads and assembles `FREEBUFF_TOKEN` at startup (multiple accounts comma-separated).

### Cloudflare Worker Deployment (❌ Not Recommended)

> **Freebuff has been actively detecting Cloudflare Worker deployments** (identifying `cf-worker` / `cf-ray` edge markers — the source code explicitly names proxy patterns similar to this project). Deploying on CF significantly increases the risk of account suspension. **Not recommended as a primary deployment method.** The steps below are provided for users who understand the risks.

The worker is a **single file** (`worker.js`). If you still choose to deploy on CF:

### Method A: CF Dashboard Paste

The simplest and most controllable approach — no local environment needed, no GitHub integration:

1. Open [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Create Worker**
2. Choose any name (e.g., `freebuff2api`), click **Deploy**
3. Go to the Worker → **Edit code** → paste the **entire content** of [worker.js](worker.js), overwriting the default code → **Deploy**
4. Click **Settings → Variables and Secrets → Add**:

   | Type | Name | Value |
   |---|---|---|
   | Secret | `FREEBUFF_TOKEN` | Your freebuff token (comma-separated for multiple accounts) |
   | Secret | `FREEBUFF_API_KEY` | Custom API access key (optional, defaults to `freebuff-default-key`) |

5. Verify after deployment:

   ```bash
   curl https://your-worker.workers.dev/healthz          # Health check (no key required)
   curl https://your-worker.workers.dev/v1/models \
     -H "Authorization: Bearer ***"           # Model list
   ```

> Each time you modify the code, repeat step 3: edit code → paste new content → deploy. **Linking to GitHub for auto-deployment is not recommended** (see below).
> ⚠️ **Version Convention**: Before each deployment, bump the version number (in the healthz `version` field + `X-Freebuff2api-Version` response header) so you can confirm whether the update is live.

### GitHub Auto-Deployment (❌ Not Recommended)

While CF supports connecting a GitHub repository for auto-deployment, **it's not advised**:

- Every push triggers a deployment — locally unverified changes could hit production directly
- Additional configuration for build commands / root directory is needed; auxiliary files like `freebuff_tools/` in the repository are also pulled in
- Secrets and branch states can easily become inconsistent, making troubleshooting difficult
- This repository contains token extraction scripts — auto-syncing increases the exposure surface

**Recommended approach**: Modify code locally → deploy via Docker / self-hosted VPS, or (if you understand the risks) manually paste into the CF dashboard → deploy yourself — full control.

> Free models require US egress IPs. Cloudflare Workers default to US egress, so no additional configuration is needed.

### 🌐 Custom Domain

The default domain `https://your-worker.your-subdomain.workers.dev` may be inaccessible from some regions (e.g., blocked by GFW). If you experience `workers.dev` connection timeouts or unreachability, you can bind a custom domain to the Worker:

1. **Add Custom Domain**: CF Dashboard → Your Worker → **Settings → Domains & Routes** → **Add** → **Custom domain**
2. Enter your domain (e.g., `api.your-domain.com`). CF will automatically guide you to add a DNS record (CNAME pointing to `your-worker.your-subdomain.workers.dev`)
3. Wait for DNS to propagate (a few minutes). A free SSL certificate is issued automatically
4. Then use Base URL: `https://api.your-domain.com/v1`

> Requirement: The domain must be hosted on Cloudflare (or DNS transferred to CF). No configuration is needed for the `workers.dev` subdomain; binding a custom domain simply provides an alternative access path for regions where the default is blocked.

## 💬 Usage Examples

```bash
# Health check
curl https://your-worker.workers.dev/healthz

# Model list
curl https://your-worker.workers.dev/v1/models \
  -H "Authorization: Bearer <API_KEY>"

# Non-streaming
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"Hello"}]}'

# Streaming
curl -N https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## 📋 Model List

> Source mapping: Freebuff Desktop 0.0.51 (`orchestrator.js` official `FREEBUFF_ROOT_AGENT_ID_BY_MODEL`, synced as of 2026-08-07).
> The Worker accesses the upstream via Cloudflare Workers, defaulting to US egress under Freebuff's full-access mode. Aside from Flash and MiMo (the two official non-Premium models), the remaining models are understood to have a **base quota of 6 sessions per Pacific day** (resetting around 15:00 Beijing time). Quota is deducted when a **session is created**; one session lasts ~1 hour.

### ⭐ Full-Access Mode Special Models: Non-Premium

In full-access mode, the official Desktop client classifies these two models under the `unlimited` non-Premium category. Here, `unlimited` primarily refers to the official model classification and Desktop concurrency category — **not an absolute guarantee of unlimited usage across any account, interface, or time period**. The Worker's current probing also does not detect daily base limits for them in `rateLimitsByModel`.

| API Model Name | Session Model | Upstream agentId | Notes |
|---|---|---|---|
| `deepseek/deepseek-v4-flash` | Same | `base2-free-deepseek-flash` | Full-access mode special model; primary recommendation |
| `mimo/mimo-v2.5` | Same | `base2-free-mimo` | Full-access mode special model; balanced performance |

> ⚠️ In restricted mode, Freebuff officially limits these two models to 6 one-hour sessions per day. The Worker defaults to US egress, which typically avoids this restricted mode. Actual availability and quotas depend on the Freebuff upstream response.

### 🔒 Standard Models: 6 Base Sessions Per Day

The following models do not have "unlimited" claims — they are uniformly treated as having a base quota of 6 sessions per day. Actual quotas may vary by account, official `referral` / `streak`, channel status, or upstream rule changes.

| API Model Name | Session Model | Upstream agentId |
|---|---|---|
| `minimax/minimax-m3` | Same | `base2-free-minimax-m3` |
| `deepseek/deepseek-v4-pro` | Same | `base2-free-deepseek` |
| `openai/gpt-5.6-luna` | Same | `base2-free-luna` |
| `poolside/laguna-s-2.1` | Same | `base2-free-laguna-s-2-1` |
| `openrouter/poolside/laguna-s-2.1` | Same | `base2-free-laguna-s-2-1-openrouter` |
| `inclusionai/ling-3.0-flash:free` | Same | `base2-free-ling-3-flash` |
| `crof/greg-2-ultra` | Same | `base2-free-greg-2-ultra` |
| `crof/greg-2-super` | Same | `base2-free-greg-2-super` |
| `meta/muse-spark-1.2-contributor` | Same | `base2-free-muse-spark` |

### 🎁 Independent Eligibility or Capacity-Limited

The following models are not part of the standard open pool. Whether a session can be created depends on official eligibility, shared capacity, or upstream status. Even if eligible, this does not imply unlimited usage:

| API Model Name | Session Model | Upstream agentId | Limits |
|---|---|---|---|
| `z-ai/glm-5.2` | Same | `base2-free-glm` | Requires referral / streak or other official eligibility; uses independent quota pool |
| `anthropic/claude-fable-5` | Same | `base2-free-fable` | Official capacity-limited trial; may be available during certain periods |

> 📝 Empirical notes (2026-08-08): `ling-3.0-flash:free` may return 404 from the upstream with a suggestion to use the paid slug. `claude-fable-5` may reject session creation for free accounts (`session_model_mismatch`). These are upstream availability issues, not Worker mapping problems.

## 👥 Multi-Account

Separate multiple tokens with commas in `FREEBUFF_TOKEN` (`token1,token2`). When quota is exhausted (429 / empty response), the current account is automatically cooled down and the next one is used.

**Account Selection Strategy** (since v1.4.0):

1. Priority is given to accounts with **an active session cache** — a session lasts ~1 hour; quota is deducted only when created, not when reused
2. If no active cache exists, the next account is used in round-robin fashion

This way, 4 accounts × 6 sessions/day ≈ full-day coverage, maximizing quota utilization.

> Note: Cooldown state is stored in Worker memory and resets on cold start. It is not shared across concurrent instances. This has minimal impact on daily use.

## 🔍 Upstream Gating Details

Freebuff's free models are not simply "get a token and call chat" — they have a strict lifecycle:

```
session(create) → agent-runs(main + context-pruner sub-run) → chat/completions
```

- **session**: `POST /api/v1/freebuff/session` (with `x-freebuff-model`) returns `instanceId`; may queue (queued).
- **agent-runs**: `START` the main agent (e.g., `base2-free-deepseek-flash`) + `context-pruner` sub-run, then `record_step` / `finish_run`. The chat endpoint validates `run_id` existence — missing it returns 4xx.
- **chat**: `POST /api/v1/chat/completions` with `codebuff_metadata.run_id`, `x-freebuff-instance-id`, SDK UA, `stop:['"cb_easp"']`, `provider.data_collection=deny`. **Upstream forces streaming** — non-streaming requests are aggregated (timeout has been relaxed to 45s).

The Worker handles all of the above lifecycle automatically — no manual intervention needed. Additionally, system messages must start with `You are Buffy, the strategic coding assistant.` (byte-level upstream validation) — the Worker auto-injects this.

### ⚠️ Single-Account Single-Session Limit (Important)

One Freebuff account can only have **one client online at a time**. Therefore:

- ❌ Do NOT query the upstream `GET /api/v1/freebuff/session` in `/v1/models` to probe quota/status — this call would occupy a session and disrupt any ongoing chat (428 `waiting_room_required`).
- ✅ `/v1/models` returns a **static model list** (no additional upstream calls).
- Upstream requests are executed via a **serial queue with a 300ms interval** to avoid triggering upstream concurrency issues.

## 💡 Usage Experience

The following setups have been tested and work well:

1. **🌍 US IP Direct Connection**: Freebuff's free models require US egress IPs; non-US IPs may fail. Cloudflare Workers default to US egress, so direct connection works. Local clients should use a US proxy.

2. **🤖 Hermes Agent (US VPS)**: Deploy Hermes Agent on a US-based VPS.

3. **Local Browser + page-assist Plugin**: Works smoothly with the [page-assist](https://github.com/n4ze3m/page-assist) browser extension — feel free to try it out.

## 🙏 Acknowledgments

Special thanks to the following contributors for their support (in no particular order):

- [@yjzsg](https://github.com/yjzsg)
- [@zipei-a](https://github.com/zipei-a)
- [@hknerdr](https://github.com/hknerdr)

## ⚠️ Disclaimer

This project is intended for **technical exchange and learning/research purposes only**.

- This project operates by reverse-engineering the freebuff desktop app / API protocol — **it violates Freebuff's Terms of Service**.
- Use of this project carries a **risk of account suspension (banned)**, which is permanent and irreversible. Please be aware and assume all consequences.
- Do not use for commercial purposes or large-scale abuse. Respect Freebuff's service operations.
- Users must comply with all applicable local laws and Freebuff's official terms. The project authors are not responsible for any account loss or disputes.

## 📄 License

This project is licensed under the [MIT License](LICENSE). Feel free to use, modify, and share.