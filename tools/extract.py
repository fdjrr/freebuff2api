#!/usr/bin/env python3
"""Freebuff authToken extraction script (authorization code polling flow, interactive mode aligned with cline_oauth.py).

Usage:
  python3 extract.py login           # Start login (auth link via TG + poll for token)
  python3 extract.py tgsend          # Test Telegram connectivity (send a test message)
  python3 extract.py show            # Show all accounts (email + full token + status + one-per-line summary)
  python3 extract.py session         # Test session creation (POST)
  python3 extract.py chat [message]   # Send a test message to the model API
  python3 extract.py quota           # Check usage via /api/v1/usage
  python3 extract.py export          # Export all account tokens, one per line (copy into CF Workers variables)

Flow (aligned with official CLI):
  1. Generate device fingerprint fingerprintId
  2. POST https://www.codebuff.com/api/auth/cli/code → get Google login URL + fingerprintHash
  3. Auth link printed + pushed to TG, user opens in browser and logs in (script auto-polls)
  4. Poll /api/auth/cli/status → on success, get user (with authToken)
  5. authToken saved locally / pushed to TG, then used directly as Bearer token for model API

Security behavior in GitHub Actions (important):
  * When TG_BOT_TOKEN / TG_CHAT_ID are configured, the auth link and authToken are always pushed to Telegram,
    **authToken is NEVER printed to stdout/logs** (even if accidentally printed, it will be ::add-mask:: masked).
  * When TG is not configured (local manual run), print as-is for easy viewing.
  * On TG push failure, exit with error — never log the token.

Environment variables:
  TG_BOT_TOKEN         Telegram Bot Token (optional; only used with TG_CHAT_ID)
  TG_CHAT_ID           Telegram chat_id to receive messages (optional)
  FREEBUFF_TOKEN       Manually specify authToken (skips credentials file)

Dependencies: Python 3 standard library only, no pip install needed.
"""
import argparse
import base64
import json
import os
import secrets
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE_URL = "https://www.codebuff.com"
CRED_FILE = Path(__file__).resolve().parent / "freebuff_credentials.json"
POLL_INTERVAL = 5          # seconds, official CLI uses 5s
POLL_TIMEOUT = 5 * 60      # seconds, official 5 minutes
REQUEST_TIMEOUT = 30

MODEL_DEFAULT = "deepseek/deepseek-v4-flash"


# ---------------------------------------------------------------------------
# CI / Telegram helpers (aligned with cline_oauth.py interaction style)
# ---------------------------------------------------------------------------

def in_ci():
    return os.environ.get("GITHUB_ACTIONS") == "true"


def tg_configured():
    return bool(os.environ.get("TG_BOT_TOKEN") and os.environ.get("TG_CHAT_ID"))


def send_tg(text):
    """Send text to Telegram. Returns False on failure (error description printed to stderr for debugging)."""
    token = os.environ.get("TG_BOT_TOKEN")
    chat = os.environ.get("TG_CHAT_ID")
    if not token or not chat:
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    body = json.dumps({"chat_id": chat, "text": text}).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode() or "{}")
            if not data.get("ok", True):
                print(f"   ⚠️ TG API error: {data.get('description', data)}")
                return False
            return True
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode() or "{}")
            desc = err.get("description", str(e))
        except Exception:
            desc = str(e)
        print(f"   ⚠️ TG send failed: {desc}")
        return False
    except Exception as e:
        print(f"   ⚠️ TG send failed: {e}")
        return False


def mask_value(value):
    """Mask sensitive values in GitHub Actions logs (prevents exposure even if accidentally printed)."""
    if in_ci() and value:
        print(f"::add-mask::{value}")


# ---------------------------------------------------------------------------
# HTTP helpers (standard library urllib, no third-party dependencies)
# ---------------------------------------------------------------------------

def _http(method: str, path: str, body=None, headers=None, query=None, timeout=REQUEST_TIMEOUT):
    url = BASE_URL + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = None
    hdrs = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        "Accept": "application/json",
    }
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else None, resp.headers
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            parsed = json.loads(raw) if raw else None
        except Exception:
            parsed = raw.decode(errors="replace")[:500]
        return e.code, parsed, e.headers
    except Exception as e:
        return None, {"error": str(e)}, None


def get_token():
    tok = os.environ.get("FREEBUFF_TOKEN")
    if tok:
        return tok
    if CRED_FILE.exists():
        cred = json.loads(CRED_FILE.read_text())
        # Backward-compatible: old format {"default": {...}}
        tok = cred.get("authToken")
        if not tok:
            tok = cred.get("default", {}).get("authToken")
        if not tok:
            # New format {"accounts": {"<key>": {...}}}: take the first account
            accts = cred.get("accounts") or {}
            for u in accts.values():
                tok = u.get("authToken")
                if tok:
                    break
        return tok
    return None


def _account_key(user: dict) -> str:
    """Account unique key: prefer id, then email, then authToken prefix as fallback."""
    uid = user.get("id") or ""
    email = user.get("email") or ""
    if uid:
        return str(uid)
    if email:
        return str(email)
    tok = user.get("authToken") or ""
    return f"token-{tok[:12]}" if tok else "unknown"


def save_credentials(user: dict, append: bool = True):
    """Save credentials. When append=True, save per-account key (does not overwrite other accounts);
    append=False writes as default (backward-compatible, for CI use)."""
    existing = {}
    if CRED_FILE.exists():
        try:
            existing = json.loads(CRED_FILE.read_text())
        except Exception:
            pass
    if append:
        # New format: accounts with separate keys, preserve existing accounts
        accts = existing.get("accounts")
        if not isinstance(accts, dict):
            accts = {}
            # Migrate old format default → accounts
            if isinstance(existing.get("default"), dict):
                accts[_account_key(existing["default"])] = existing["default"]
            existing = {"accounts": accts}
        key = _account_key(user)
        accts[key] = user
        existing["accounts"] = accts
    else:
        # Old format: directly overwrite default (CI single-account scenario)
        existing["default"] = user
    CRED_FILE.write_text(json.dumps(existing, indent=2, ensure_ascii=False))
    accts = existing.get("accounts")
    acct_count = len(accts) if isinstance(accts, dict) else (1 if existing.get("default") else 0)
    print(f"💾 Credentials saved → {CRED_FILE} ({acct_count} accounts)")


# ---------------------------------------------------------------------------
# Command functions
# ---------------------------------------------------------------------------

def gen_fingerprint():
    """Official legacy fallback format: codebuff-cli-<8-char-random>"""
    rand = base64.urlsafe_b64encode(secrets.token_bytes(6)).decode().rstrip("=")[:8]
    return f"codebuff-cli-{rand}"


def cmd_tgsend(args):
    """Test Telegram connectivity: send a test message."""
    if not tg_configured():
        print("❌ TG_BOT_TOKEN / TG_CHAT_ID not set")
        sys.exit(1)
    ok = send_tg("✅ TG connectivity test successful!\nFreebuff extraction workflow can send you messages.")
    if ok:
        print("✅ Test message sent to TG, please check.")
    else:
        print("❌ TG send failed, check TG_BOT_TOKEN / TG_CHAT_ID.")
        sys.exit(1)


def cmd_login(args):
    # Interaction mode: TG configured → push to TG; CI environment forces TG (workflow step 1 also blocks)
    if in_ci() and not tg_configured():
        print("::error::Actions environment requires TG mode, please configure TG_BOT_TOKEN and TG_CHAT_ID first")
        sys.exit(1)
    use_tg = tg_configured()

    fingerprint_id = args.fingerprint or gen_fingerprint()
    print(f"🚀 Starting Freebuff login flow (fingerprintId: {fingerprint_id})...\n")

    status, data, _ = _http("POST", "/api/auth/cli/code", {"fingerprintId": fingerprint_id})
    if status != 200 or not data:
        msg = f"❌ Login URL request failed: HTTP {status} {data}"
        print(msg)
        if use_tg:
            send_tg("⚠️ Freebuff extraction failed:\n" + msg)
        sys.exit(1)

    login_url = data["loginUrl"]
    fingerprint_hash = data["fingerprintHash"]
    expires_at = data["expiresAt"]
    # loginUrl contains a one-time auth_code, mask it in CI to avoid exposing it in logs
    mask_value(login_url)

    # Optional poll timeout override (aligned with cline_oauth.py: workflow poll_timeout passed in)
    poll_timeout = POLL_TIMEOUT
    env_timeout = os.environ.get("OAUTH_POLL_TIMEOUT")
    if env_timeout:
        try:
            poll_timeout = int(env_timeout)
        except ValueError:
            pass

    # Push the auth link to TG for easy authorization on mobile
    if use_tg:
        tg_msg = (
            "🔑 *Freebuff Authorization Request*\n\n"
            "Open the link below in a browser and complete login:\n"
            f"{login_url}\n\n"
            f"The script will auto-poll, waiting up to {poll_timeout} seconds."
        )
        ok = send_tg(tg_msg)
        if not ok:
            print("❌ Auth link push to TG failed (check TG_BOT_TOKEN / TG_CHAT_ID)")
            sys.exit(1)
        print("📨 Auth link pushed to Telegram (URL not printed to log).")
    else:
        # Non-TG (local manual run): print the URL
        print("=" * 60)
        print("1️⃣  Open the following link in your browser:")
        print(f"    {login_url}")
        print("2️⃣  Log in with your Google account")
        print(f"3️⃣  Script auto-polls, waiting up to {poll_timeout} seconds")
        print("=" * 60)

    print(f"\n🔄 Waiting for authorization (auto-polling, up to {poll_timeout} seconds)...")
    start = time.time()
    attempts = 0
    while time.time() - start < poll_timeout:
        attempts += 1
        status, data, _ = _http(
            "GET", "/api/auth/cli/status",
            query={
                "fingerprintId": fingerprint_id,
                "fingerprintHash": fingerprint_hash,
                "expiresAt": expires_at,
            },
        )
        if status == 200 and data and data.get("user"):
            user = data["user"]
            if not user.get("authToken"):
                print(f"⚠️ Returned user but no authToken: {json.dumps(user)[:300]}")
                sys.exit(1)
            print(f"✅ Login successful! (poll #{attempts}, {int(time.time()-start)}s)")

            email = user.get("email", "unknown")
            # Email / id also treated as sensitive: mask to avoid entering Actions logs
            mask_value(email)
            mask_value(str(user.get("id", "")))
            print(f"✅ Login successful! Account: {email}")

            # Local run: append per-account (don't overwrite existing); CI run: overwrite default
            save_credentials(user, append=not in_ci())

            # Critical security point: CI + TG configured, authToken only goes to TG, never printed to logs
            auth_token = user["authToken"]
            if use_tg:
                mask_value(auth_token)  # Last resort: even if accidentally printed, Actions will mask it
                ok = send_tg(
                    "🔑 *Freebuff authToken Obtained*\n\n"
                    f"Account:`{email}`\n"
                    f"id：`{user.get('id')}`\n"
                    f"credits：`{user.get('credits')}`\n\n"
                    "Copy the line below into the Cloudflare Worker secret variable `FREEBUFF_TOKEN`"
                    "(append on a new line for multiple accounts):\n"
                    f"`{auth_token}`"
                )
                if not ok:
                    print("❌ authToken push to TG failed! Token not printed to log, check TG config and retry.")
                    sys.exit(1)
                print("🔑 authToken sent privately via Telegram (not written to log).")
            else:
                mask_value(auth_token)
                print("\n🔑 Copy the line below into the Cloudflare Worker secret variable FREEBUFF_TOKEN:")
                print("    " + auth_token)
            return user
        elif status == 401:
            print(f"   [{int(time.time()-start)}s] Not logged in yet (401), continuing to wait...")
        elif status == 400:
            print(f"❌ Login request expired: {data}")
            sys.exit(1)
        else:
            print(f"   [{int(time.time()-start)}s] Status {status}: {str(data)[:120]}")
        time.sleep(POLL_INTERVAL)

    print("⏰ Login wait timed out, please try again.")
    sys.exit(1)


def cmd_show(_args):
    """Show all accounts: email + token (full display, local tool no need to mask) + status (zero-cost GET /session), one-per-line summary at the end."""
    pairs = _all_tokens()
    if not pairs:
        print("❌ authToken not found (run login first or set FREEBUFF_TOKEN)")
        sys.exit(1)
    print(f"📋 Saved credentials ({len(pairs)} accounts):")
    print("-" * 60)
    for _key, at, email in pairs:
        verdict, detail = _check_one(at)
        print(f"  [{email}] {verdict}")
        print(f"      {at}")
        print(f"      {detail}")
    print("-" * 60)
    print("\n📋 Summary (one per line, copy into CF Worker variable FREEBUFF_TOKEN):")
    for _key, at, _email in pairs:
        print(f"   {at}")
    return 0


def cmd_session(args):
    tok = get_token()
    if not tok:
        print("❌ authToken not found")
        sys.exit(1)
    headers = {"Authorization": f"Bearer {tok}"}
    model = args.model or MODEL_DEFAULT
    if args.post:
        headers["x-freebuff-model"] = model
        status, data, _ = _http("POST", "/api/v1/freebuff/session", headers=headers)
    else:
        status, data, _ = _http("GET", "/api/v1/freebuff/session", headers=headers)
    print(f"📡 HTTP {status}")
    print(json.dumps(data, indent=2, ensure_ascii=False) if data else "(empty response)")
    return data


# Official free-mode marker: system prompt must start with canonical Buffy (byte-level position 0)
# Old `[System Override...]` prefix bypass has been patched by upstream (403 free_mode_cli_required)
CANONICAL_BUFFY = "You are Buffy, the strategic coding assistant."

# Model → upstream agentId (aligned with worker.js MODELS table; free mode validates agent+model combination)
MODEL_AGENTS = {
    "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
    "deepseek/deepseek-v4-pro": "base2-free-deepseek",
    "moonshotai/kimi-k2.6": "base2-free-kimi",
    "minimax/minimax-m2.7": "base2-free",
    "minimax/minimax-m3": "base2-free-minimax-m3",
    "mimo/mimo-v2.5": "base2-free-mimo",
    "mimo/mimo-v2.5-pro": "base2-free-mimo-pro",
}


def agent_for_model(model):
    return MODEL_AGENTS.get(model, "base2-free-deepseek-flash")


def cmd_chat(args):
    tok = get_token()
    if not tok:
        print("❌ authToken not found")
        sys.exit(1)

    # 1) Ensure an active session first (official gate: no session → 428 waiting_room_required)
    model = args.model or MODEL_DEFAULT
    # Official SDK UA (free mode recognition depends on this; browser UA gets rejected)
    sdk_ua = "ai-sdk/openai-compatible/0.0.141/codebuff"
    headers = {"Authorization": f"Bearer {tok}", "User-Agent": sdk_ua}
    status, sess, _ = _http("POST", "/api/v1/freebuff/session",
                            headers={**headers, "x-freebuff-model": model})
    print(f"📡 POST /session → HTTP {status}")
    instance_id = None
    if isinstance(sess, dict) and sess.get("status") == "active":
        instance_id = sess.get("instanceId")
        print(f"   ✅ session active, instanceId={instance_id}, "
              f"model={sess.get('model')}, expires_at={sess.get('expires_at')}")
    else:
        print(f"   ⚠️ {str(sess)[:300]}")
        if not args.force:
            print("   (use --force to still attempt direct chat and see the error)")
            sys.exit(1)

    # 1.5) START a run first to get a real runId (chat validates run_id existence; agent mapped by model)
    run_id = args.run_id
    agent_id = args.agent or agent_for_model(model)
    if not run_id:
        s, sr, _ = _http("POST", "/api/v1/agent-runs",
                         {"action": "START", "agentId": agent_id,
                          "ancestorRunIds": []}, headers)
        if isinstance(sr, dict) and sr.get("runId"):
            run_id = sr["runId"]
            print(f"   📡 START run → HTTP {s} runId={run_id} (agent={agent_id})")
        else:
            print(f"   ⚠️ START run failed HTTP {s}: {str(sr)[:200]}")
            if not args.force:
                sys.exit(1)

    # 2) Call chat/completions: canonical Buffy opening + SDK UA + acting-user-id + data_collection deny
    chat_headers = {
        "Authorization": f"Bearer {tok}",
        "Content-Type": "application/json",
        "User-Agent": sdk_ua,
    }
    if instance_id:
        chat_headers["x-freebuff-instance-id"] = instance_id
    # Include acting-user-id when credential id is available (official SDK does this)
    uid = None
    if CRED_FILE.exists():
        try:
            uid = json.loads(CRED_FILE.read_text()).get("default", {}).get("id")
        except Exception:
            pass
    if uid:
        chat_headers["x-freebuff-acting-user-id"] = uid

    body = {
        "model": model,
        "messages": [
            {"role": "system",
             "content": CANONICAL_BUFFY + "\n\nYou are the AI agent behind Freebuff. Keep it brief."},
            {"role": "user", "content": args.message or "Say hi in one short sentence."},
        ],
        "stream": False,
        "max_tokens": 200,
        "codebuff_metadata": {
            "run_id": run_id or f"run-{secrets.token_hex(6)}",
            "client_id": f"cli-{secrets.token_hex(6)}",
            "cost_mode": "free",
            **({"freebuff_instance_id": instance_id} if instance_id else {}),
        },
        "provider": {"data_collection": "deny"},
    }
    print(f"📡 POST /api/v1/chat/completions (model={model}, stream=False, run_id={run_id})…")
    status, data, _ = _http("POST", "/api/v1/chat/completions", body, chat_headers)
    print(f"→ HTTP {status}")
    if status == 200 and isinstance(data, dict):
        msg = data.get("choices", [{}])[0].get("message", {})
        print(f"✅ Reply: {msg.get('content', '')[:500]}")
        if msg.get("reasoning_content"):
            print(f"🧠 reasoning: {msg['reasoning_content'][:200]}")
        print(f"   usage: {data.get('usage')}")
        # Cleanup run
        _http("POST", "/api/v1/agent-runs", {"action": "FINISH", "runId": run_id}, headers)
    else:
        print(json.dumps(data, indent=2, ensure_ascii=False)[:1500] if data else "(empty response)")
        # Cleanup run
        if run_id:
            _http("POST", "/api/v1/agent-runs", {"action": "CANCEL", "runId": run_id}, headers)


def cmd_quota(_args):
    tok = get_token()
    if not tok:
        print("❌ authToken not found")
        sys.exit(1)
    status, data, _ = _http("POST", "/api/v1/usage", {"fingerprintId": "cli-usage"},
                            headers={"Authorization": f"Bearer {tok}"})
    print(f"📡 HTTP {status}")
    print(json.dumps(data, indent=2, ensure_ascii=False) if data else "(empty response)")


def _all_tokens():
    """Returns [(key, token, email)]: prefers all accounts from credentials.json; falls back to env var."""
    tok = os.environ.get("FREEBUFF_TOKEN")
    if tok:
        return [("env", tok, "environment variable")]
    if CRED_FILE.exists():
        try:
            cred = json.loads(CRED_FILE.read_text())
        except Exception:
            cred = {}
        accts = cred.get("accounts")
        if isinstance(accts, dict) and accts:
            return [(k, u.get("authToken", ""), u.get("email", "?")) for k, u in accts.items() if u.get("authToken")]
        if isinstance(cred.get("default"), dict) and cred["default"].get("authToken"):
            return [("default", cred["default"]["authToken"], cred["default"].get("email", "?"))]
        if cred.get("authToken"):
            return [("default", cred["authToken"], cred.get("email", "?"))]
    return []


def _format_quota(rate_limits):
    """Format the read-only GET /session quota snapshot.

    Prefer models with explicit limits (Premium/Luna, etc.); if upstream only returns one model,
    display it anyway. Does not POST, so no session created, no quota consumed.
    """
    if not isinstance(rate_limits, dict) or not rate_limits:
        return "quota unknown (upstream did not return rateLimitsByModel)"
    rows = []
    for model, info in rate_limits.items():
        if not isinstance(info, dict):
            continue
        rc = info.get("recentCount")
        lim = info.get("limit")
        if rc is None or lim is None:
            continue
        reset = info.get("resetAt") or info.get("reset_at")
        text = f"{model}={rc}/{lim}"
        if reset:
            text += f"，reset={reset}"
        rows.append(text)
    return "quota " + ";".join(rows) if rows else "quota unknown (snapshot fields incomplete)"


def _check_one(tok):
    """Health check. GET /api/v1/freebuff/session is zero-cost probing (no session created),
    single call simultaneously determines: token invalid / banned / region-restricted / quota exhausted / alive.
    Official source freebuff-session-api.ts logic:
    - Normal account: 200 (has session) or 404 (no session)
    - Banned account: 403 + {"status":"banned"} (Terminal, irreversible)
    - Invalid token: 401
    - Quota exhausted: 429 or status=rate_limited
    Returns (verdict, detail)."""
    headers = {
        "Authorization": f"Bearer {tok}",
        # Official read-only quota snapshot hint: does not create session, does not consume quota.
        "x-freebuff-include-unused-rate-limits": "1",
    }
    status, data, _ = _http("GET", "/api/v1/freebuff/session", headers=headers,
                            timeout=REQUEST_TIMEOUT)
    if status is None:
        return "network error", f"Request failed: {data.get('error') if isinstance(data, dict) else data}"
    if status == 401:
        return "token expired ❌", "HTTP 401 (authToken invalid or revoked, not a ban)"
    if status == 403:
        # 403 + banned = banned; 403 + country_blocked = region restricted; other 403s are also flagged
        if isinstance(data, dict):
            st = data.get("status")
            if st == "banned":
                return "banned ❌", "HTTP 403 + status=banned (official: Terminal, account irreversible, appeal via support@codebuff.com)"
            if st == "country_blocked":
                return "region restricted ⚠️", "HTTP 403 + status=country_blocked (current egress IP is not US)"
        return "access denied ⚠️", f"HTTP 403: {str(data)[:200]}"
    if status == 429:
        quota_str = _format_quota(data.get("rateLimitsByModel")) if isinstance(data, dict) else "quota unknown (429 did not return quota snapshot)"
        return "quota exhausted ⚠️", f"HTTP 429 (daily session quota used up, wait for reset),{quota_str}"
    if status == 404:
        # 404 only means no active session. Some upstream versions include quota snapshot
        # in the error response JSON — if present, display it as usual.
        quota_str = _format_quota(data.get("rateLimitsByModel")) if isinstance(data, dict) else "quota unknown (404 did not return quota snapshot)"
        return "alive (no active session)✅", f"HTTP 404 (no session, account usable),{quota_str}"
    if not isinstance(data, dict):
        return "unknown", f"HTTP {status}: {str(data)[:200]}"
    st = data.get("status")
    if st == "banned":
        return "banned ❌", "Official: Terminal, account irreversible (appeal via support@codebuff.com)"
    # Health check: parse alive status + quota
    if st == "active":
        model = data.get("model", "?")
        tier = data.get("accessTier", "?")
        quota_str = _format_quota(data.get("rateLimitsByModel"))
        if quota_str:
            quota_str = "，" + quota_str
        return "alive ✅", f"session active, model={model}, tier={tier}{quota_str}"
    if st in ("none", "ended"):
        quota_str = _format_quota(data.get("rateLimitsByModel"))
        if st == "ended":
            detail = "Current session ended, account still usable"
            verdict = "alive (session ended)✅"
        else:
            detail = "Zero-cost probe OK, account usable"
            verdict = "alive (no active session)✅"
        if quota_str:
            detail += f"，{quota_str}"
        return verdict, detail
    if st == "country_blocked":
        return "region restricted ⚠️", "Current egress IP is not US (freebuff free models are US-only)"
    if st == "model_locked":
        quota_str = _format_quota(data.get("rateLimitsByModel"))
        return "alive (session locked)⚠️", f"Another model session is active, will auto-release,{quota_str}"
    if st == "rate_limited":
        quota_str = _format_quota(data.get("rateLimitsByModel"))
        return "quota exhausted ⚠️", f"Daily session quota used up, wait for reset,{quota_str}"
    if st == "ip_capped":
        return "alive (IP concurrency cap)⚠️", "Too many active users on current egress IP, retry later"
    return "alive ✅", f"HTTP {status}, status={st}"


def cmd_export(_args):
    """Summarize all account FREEBUFF_TOKEN values, one per line, for easy copying into CF Workers variables."""
    pairs = _all_tokens()
    if not pairs:
        print("❌ authToken not found (run login first or set FREEBUFF_TOKEN)")
        sys.exit(1)
    print("# freebuff2api CF Workers variable FREEBUFF_TOKEN (one account per line)")
    print("# %d accounts total. Copy the lines below to Cloudflare → Variables → FREEBUFF_TOKEN" % len(pairs))
    print("# Note: this output contains sensitive tokens, do not leak or commit to git")
    print("=" * 60)
    for _key, tok, _email in pairs:
        print(tok)
    print("=" * 60)
    return 0


# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description="Freebuff authToken extraction tool")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_login = sub.add_parser("login", help="Start login (generate URL + poll for token)")
    p_login.add_argument("--fingerprint", help="Specify fingerprintId (auto-generated by default)")

    sub.add_parser("tgsend", help="Test Telegram connectivity (send a test message)")

    sub.add_parser("show", help="Show saved credentials and verify")
    p_sess = sub.add_parser("session", help="Create/check session")
    p_sess.add_argument("--model", default=MODEL_DEFAULT)
    p_sess.add_argument("--post", action="store_true", help="POST to create session (default GET)")

    p_chat = sub.add_parser("chat", help="Send a test message to the model API")
    p_chat.add_argument("message", nargs="?", default=None)
    p_chat.add_argument("--model", default=MODEL_DEFAULT)
    p_chat.add_argument("--agent", default=None, help="agentId for START run (auto-mapped by model by default)")
    p_chat.add_argument("--run-id", default=None, help="Specify run_id (default: START a new one)")
    p_chat.add_argument("--force", action="store_true", help="Send chat even if session/run fails")

    sub.add_parser("quota", help="Check usage")

    sub.add_parser("export", help="Export all account tokens, one per line, copy into CF Workers variables")

    args = p.parse_args()
    {
        "login": cmd_login,
        "show": cmd_show,
        "session": cmd_session,
        "chat": cmd_chat,
        "quota": cmd_quota,
        "tgsend": cmd_tgsend,
        "export": cmd_export,
    }[args.cmd](args)


if __name__ == "__main__":
    main()
