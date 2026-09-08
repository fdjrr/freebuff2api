#!/usr/bin/env bash
# ==============================================================================
# deploy-workers.sh — Multi-account Cloudflare Workers Deployment for freebuff2api
#
# Reads all configurations directly from .env:
#   TOTAL_WORKERS, ACCOUNTS_PER_WORKER, WORKER_PREFIX, WORKERS_DOMAIN,
#   API_KEY, SYNC_9ROUTER, ROUTER_URL, ROUTER_PASSWORD
#
# Usage:
#   ./scripts/deploy-workers.sh             # Live deployment & 9router sync
#   ./scripts/deploy-workers.sh --dry-run   # Simulate deployment without uploading
#   ./scripts/deploy-workers.sh --sync-only # Sync existing deployed workers to 9router
#   ./scripts/deploy-workers.sh --help      # Show help message
# ==============================================================================

set -euo pipefail

# Safe directory resolution (supports symlinks and arbitrary working directories)
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"
ROOT_DIR="$( cd -P "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd )"

# Load .env file if present in project root
if [[ -f "${ROOT_DIR}/.env" ]]; then
  while IFS='=' read -r key val || [[ -n "${key:-}" ]]; do
    key=$(echo "${key:-}" | tr -d ' \r\t')
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    val=$(echo "${val:-}" | tr -d '\r')
    val="${val#\"}"
    val="${val%\"}"
    val="${val#\'}"
    val="${val%\'}"
    if [[ -z "${!key:-}" ]]; then
      export "$key"="$val"
    fi
  done < "${ROOT_DIR}/.env"
fi

# Configuration variables from .env
TOTAL_WORKERS="${TOTAL_WORKERS:-15}"
ACCOUNTS_PER_WORKER="${ACCOUNTS_PER_WORKER:-auto}"
WORKER_PREFIX="${WORKER_PREFIX:-freebuff2api}"
API_KEY="${API_KEY:-}"

# 9router integration configuration from .env
SYNC_9ROUTER="${SYNC_9ROUTER:-true}"
ROUTER_URL="${ROUTER_URL:-}"
ROUTER_PASSWORD="${ROUTER_PASSWORD:-}"
WORKERS_DOMAIN="${WORKERS_DOMAIN:-}"

# Runtime options
DRY_RUN=false
SYNC_ONLY=false

# ANSI colors
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Parse CLI arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sync-only)
      SYNC_ONLY=true
      shift
      ;;
    --no-sync-9router|--skip-router)
      SYNC_9ROUTER=false
      shift
      ;;
    -d|--dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      echo -e "${BOLD}Usage:${NC} $0 [options]"
      echo ""
      echo "All configurations are defined in .env (refer to .env.example):"
      echo "  API_KEY, TOTAL_WORKERS, ACCOUNTS_PER_WORKER, WORKER_PREFIX,"
      echo "  WORKERS_DOMAIN, SYNC_9ROUTER, ROUTER_URL, ROUTER_PASSWORD"
      echo ""
      echo "Options:"
      echo "  -d, --dry-run               Simulate deployment checks without uploading to Cloudflare"
      echo "  --sync-only                 Sync existing deployed workers to 9router without deploying"
      echo "  --no-sync-9router           Deploy to Cloudflare only (skip 9router sync)"
      echo "  -h, --help                  Show this help message"
      echo ""
      echo "Examples:"
      echo "  $0                          # Deploy workers and sync to 9router"
      echo "  $0 --dry-run                # Preview deployment and 9router synchronization"
      echo "  $0 --sync-only              # Refresh/register existing workers in 9router"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Run with --help to see available options."
      exit 1
      ;;
  esac
done

cd "${ROOT_DIR}"

# Pre-flight parameter validation against .env
if [[ -z "${API_KEY}" ]]; then
  echo -e "${RED}Error: API_KEY is not defined in .env!${NC}"
  echo "Please set API_KEY in your .env file."
  exit 1
fi

if [[ "${SYNC_9ROUTER}" == "true" ]]; then
  MISSING_VARS=()
  [[ -z "${ROUTER_URL}" ]] && MISSING_VARS+=("ROUTER_URL")
  [[ -z "${ROUTER_PASSWORD}" ]] && MISSING_VARS+=("ROUTER_PASSWORD")
  [[ -z "${WORKERS_DOMAIN}" ]] && MISSING_VARS+=("WORKERS_DOMAIN")

  if (( ${#MISSING_VARS[@]} > 0 )); then
    echo -e "${RED}Error: Missing required 9router variables in .env:${NC}"
    for item in "${MISSING_VARS[@]}"; do
      echo -e "  - ${item}"
    done
    echo -e "\nPlease set them in your .env file or run with --no-sync-9router to deploy without 9router sync."
    exit 1
  fi
fi

echo -e "${BOLD}${CYAN}=== Freebuff2API Multi-Worker Deployment & 9router Sync ===${NC}"
echo "Target Workers : ${TOTAL_WORKERS}"
echo "Name Prefix    : ${WORKER_PREFIX}"
echo "Workers Domain : ${WORKERS_DOMAIN:-N/A (sync disabled)}"
echo "9router Sync   : ${SYNC_9ROUTER} (${ROUTER_URL:-disabled})"
echo "Dry Run        : ${DRY_RUN}"
echo "Sync Only      : ${SYNC_ONLY}"
echo "--------------------------------------------------------"

# 1. Extract tokens from credentials/*.jsonl, credentials/*.json, or wrangler.jsonc
echo -e "${YELLOW}>> Extracting account tokens...${NC}"

mapfile -t ALL_TOKENS < <(node -e '
const fs = require("fs");
const path = require("path");

function loadTokens() {
  const rootDir = process.cwd();
  const credDir = path.join(rootDir, "credentials");
  const tokens = [];

  // 1. Read from credentials/ folder (.jsonl and .json)
  if (fs.existsSync(credDir)) {
    const files = fs.readdirSync(credDir);
    for (const file of files) {
      const fullPath = path.join(credDir, file);
      if (file.endsWith(".jsonl")) {
        const lines = fs.readFileSync(fullPath, "utf-8").trim().split("\n");
        for (const line of lines) {
          try {
            const obj = JSON.parse(line.trim());
            const t = (obj.authToken || obj.token || "").trim();
            if (t && !tokens.includes(t)) tokens.push(t);
          } catch {}
        }
      } else if (file.endsWith(".json")) {
        try {
          const obj = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
          const t = (obj.authToken || obj.token || "").trim();
          if (t && !tokens.includes(t)) tokens.push(t);
        } catch {}
      }
    }
  }

  // 2. Fallback to wrangler.jsonc if credentials folder has no tokens
  if (tokens.length === 0) {
    const wranglerPath = path.join(rootDir, "wrangler.jsonc");
    if (fs.existsSync(wranglerPath)) {
      const raw = fs.readFileSync(wranglerPath, "utf-8");
      const match = raw.match(/"FREEBUFF_TOKEN":\s*"([^"]+)"/);
      if (match) {
        const parsed = match[1].split(",").map(s => s.trim()).filter(Boolean);
        for (const t of parsed) {
          if (!tokens.includes(t)) tokens.push(t);
        }
      }
    }
  }

  tokens.forEach(t => console.log(t));
}

loadTokens();
')

TOTAL_ACCOUNTS="${#ALL_TOKENS[@]}"
echo "Total active tokens found: ${TOTAL_ACCOUNTS}"

if (( TOTAL_ACCOUNTS == 0 )); then
  echo -e "${RED}Error: No account tokens found in credentials/ or wrangler.jsonc!${NC}"
  exit 1
fi

if (( TOTAL_ACCOUNTS < TOTAL_WORKERS )); then
  echo -e "${RED}Error: Total accounts (${TOTAL_ACCOUNTS}) is fewer than target workers (${TOTAL_WORKERS}).${NC}"
  echo -e "Each worker requires at least 1 account. Decrease TOTAL_WORKERS in .env or add accounts."
  exit 1
fi

# 2. Account Distribution Calculation (Balanced Remainder Allocation)
if [[ "${ACCOUNTS_PER_WORKER}" == "auto" ]]; then
  BASE_ACCOUNTS=$(( TOTAL_ACCOUNTS / TOTAL_WORKERS ))
  REMAINDER=$(( TOTAL_ACCOUNTS % TOTAL_WORKERS ))

  echo -e "${GREEN}✓ Balanced Remainder Allocation Mode:${NC}"
  echo "  - Base quota: ${BASE_ACCOUNTS} accounts / worker"
  if (( REMAINDER > 0 )); then
    echo "  - First ${REMAINDER} worker(s) will receive $(( BASE_ACCOUNTS + 1 )) accounts"
    echo "  - Remaining $(( TOTAL_WORKERS - REMAINDER )) worker(s) will receive ${BASE_ACCOUNTS} accounts"
  else
    echo "  - All ${TOTAL_WORKERS} workers will receive exactly ${BASE_ACCOUNTS} accounts each"
  fi
else
  # Manual / fixed count mode
  REQUIRED_ACCOUNTS=$(( TOTAL_WORKERS * ACCOUNTS_PER_WORKER ))
  if (( TOTAL_ACCOUNTS < REQUIRED_ACCOUNTS )); then
    echo -e "${RED}Error: Requires ${REQUIRED_ACCOUNTS} accounts (${TOTAL_WORKERS} workers x ${ACCOUNTS_PER_WORKER} accounts), but only ${TOTAL_ACCOUNTS} are available.${NC}"
    exit 1
  fi
  BASE_ACCOUNTS="${ACCOUNTS_PER_WORKER}"
  REMAINDER=0
  echo -e "${GREEN}✓ Fixed Allocation Mode: Each worker receives ${ACCOUNTS_PER_WORKER} accounts.${NC}"
fi

echo "--------------------------------------------------------"

# 3. Deployment execution function with retry & progressive backoff
deploy_worker() {
  local worker_name="$1"
  local worker_tokens="$2"
  local is_dry_run="$3"

  local cmd=(
    npx wrangler deploy
    --name "${worker_name}"
    --var "FREEBUFF_TOKEN:${worker_tokens}"
    --var "API_KEY:${API_KEY}"
  )
  if [[ "${is_dry_run}" == "true" ]]; then
    cmd+=(--dry-run)
  fi

  local max_retries=3
  local attempt=1
  while (( attempt <= max_retries )); do
    if "${cmd[@]}"; then
      return 0
    fi
    if (( attempt < max_retries )); then
      local wait_time=$(( attempt * 2 ))
      echo -e "    ${YELLOW}⚠️ Deployment failed (attempt ${attempt}/${max_retries}). Retrying in ${wait_time}s...${NC}"
      sleep "${wait_time}"
    fi
    attempt=$(( attempt + 1 ))
  done
  return 1
}

# 4. Worker deployment & 9router synchronization loop
DEPLOYED_WORKERS=()
FAILED_WORKERS=()
ROUTER_SYNCED_WORKERS=()

echo -e "\n${BOLD}${CYAN}>> Starting process for ${TOTAL_WORKERS} workers...${NC}\n"

current_idx=0
for ((i = 1; i <= TOTAL_WORKERS; i++)); do
  worker_name="${WORKER_PREFIX}${i}"

  # Determine account count for this worker
  if [[ "${ACCOUNTS_PER_WORKER}" == "auto" ]]; then
    if (( i <= REMAINDER )); then
      worker_count=$(( BASE_ACCOUNTS + 1 ))
    else
      worker_count=$(( BASE_ACCOUNTS ))
    fi
  else
    worker_count="${ACCOUNTS_PER_WORKER}"
  fi

  # Slice tokens array
  tokens_slice=("${ALL_TOKENS[@]:current_idx:worker_count}")
  worker_tokens_str=$(IFS=,; echo "${tokens_slice[*]}")

  start_num=$(( current_idx + 1 ))
  end_num=$(( current_idx + worker_count ))

  echo -e "${BOLD}[${i}/${TOTAL_WORKERS}] Processing ${worker_name}...${NC}"
  echo "    Assigned accounts: #${start_num} to #${end_num} (${worker_count} accounts)"
  echo "    Sample token: ${tokens_slice[0]:0:8}..."

  deploy_success=false
  if [[ "${SYNC_ONLY}" == "true" ]]; then
    deploy_success=true
  else
    if deploy_worker "${worker_name}" "${worker_tokens_str}" "${DRY_RUN}"; then
      echo -e "    ${GREEN}✓ ${worker_name} deployed successfully.${NC}"
      DEPLOYED_WORKERS+=("${worker_name}")
      deploy_success=true
    else
      echo -e "    ${RED}✗ ${worker_name} deployment failed.${NC}"
      FAILED_WORKERS+=("${worker_name}")
    fi
  fi

  # Synchronize to 9router if enabled and worker deployed
  if [[ "${deploy_success}" == "true" && "${SYNC_9ROUTER}" == "true" ]]; then
    sync_cmd=(
      node "${SCRIPT_DIR}/sync-9router.mjs"
      --worker-index "${i}"
      --worker-name "${worker_name}"
    )
    [[ "${DRY_RUN}" == "true" ]] && sync_cmd+=(--dry-run)

    if "${sync_cmd[@]}"; then
      ROUTER_SYNCED_WORKERS+=("${worker_name}")
    else
      echo -e "    ${YELLOW}⚠️ 9router sync encountered an issue for ${worker_name}.${NC}"
    fi
  fi

  echo ""
  current_idx=$(( current_idx + worker_count ))
done

# 5. Final summary report
echo "========================================================"
echo -e "${BOLD}Execution Summary:${NC}"
echo -e "  Target Workers     : ${TOTAL_WORKERS}"
echo -e "  Allocated Accounts : ${current_idx} of ${TOTAL_ACCOUNTS} accounts"
if [[ "${SYNC_ONLY}" != "true" ]]; then
  echo -e "  Cloudflare Deployed: ${GREEN}${#DEPLOYED_WORKERS[@]}${NC}"
  echo -e "  Cloudflare Failed  : ${RED}${#FAILED_WORKERS[@]}${NC}"
fi
if [[ "${SYNC_9ROUTER}" == "true" ]]; then
  echo -e "  9router Synced     : ${GREEN}${#ROUTER_SYNCED_WORKERS[@]}${NC}"
fi

if (( ${#FAILED_WORKERS[@]} > 0 )); then
  echo -e "\n${RED}The following workers failed deployment:${NC}"
  for w in "${FAILED_WORKERS[@]}"; do
    echo "  - ${w}"
  done
  exit 1
else
  echo -e "\n${GREEN}All operations completed successfully!${NC}"
  exit 0
fi
