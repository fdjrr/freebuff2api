#!/usr/bin/env node
// ==============================================================================
// sync-9router.mjs — Synchronize deployed Freebuff workers into 9router
//
// Reads all configurations directly from .env.
// Authenticates with 9router using ROUTER_PASSWORD, registers provider nodes,
// configures API keys, and imports/activates model catalogs.
//
// Usage:
//   node scripts/sync-9router.mjs --worker-index 1 --worker-name freebuff2api1
//   node scripts/sync-9router.mjs --total-workers 15
//   node scripts/sync-9router.mjs --total-workers 15 --dry-run
// ==============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

// Load .env if present
const envPath = resolve(rootDir, '.env');
if (existsSync(envPath)) {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
function getArg(flag, fallback = '') {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}
const hasFlag = (flag) => args.includes(flag);

const DRY_RUN = hasFlag('--dry-run') || hasFlag('-d');
const ROUTER_URL = (process.env.ROUTER_URL || '').replace(/\/+$/, '');
const ROUTER_PASSWORD = process.env.ROUTER_PASSWORD || '';
const WORKERS_DOMAIN = process.env.WORKERS_DOMAIN || '';
const API_KEY = process.env.API_KEY || '';
const WORKER_PREFIX = process.env.WORKER_PREFIX || 'freebuff2api';

const workerIndexArg = getArg('--worker-index');
const workerNameArg = getArg('--worker-name');
const totalWorkersArg = getArg('--total-workers');

let cachedAuthToken = '';
let headers = {
  'Accept': '*/*',
  'Content-Type': 'application/json'
};

export function validateRequiredConfig() {
  const missing = [];
  if (!API_KEY) missing.push('API_KEY');
  if (!ROUTER_URL) missing.push('ROUTER_URL');
  if (!ROUTER_PASSWORD) missing.push('ROUTER_PASSWORD');
  if (!WORKERS_DOMAIN) missing.push('WORKERS_DOMAIN');

  if (missing.length > 0) {
    console.error('\x1b[31mError: Missing required configuration in .env:\x1b[0m');
    for (const item of missing) {
      console.error(`  - ${item}`);
    }
    console.error('\nPlease define them in your .env file (refer to .env.example).');
    process.exit(1);
  }
}

export async function ensureRouterAuth() {
  if (cachedAuthToken) return cachedAuthToken;

  console.log(`    + Authenticating with 9router at ${ROUTER_URL}...`);
  const res = await fetch(`${ROUTER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ROUTER_PASSWORD })
  });

  if (!res.ok) {
    throw new Error(`9router login failed with status HTTP ${res.status}`);
  }

  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/auth_token=([^;]+)/);
  if (!match) {
    throw new Error('9router login succeeded but did not return an auth_token cookie.');
  }

  cachedAuthToken = match[1];
  headers['Cookie'] = `auth_token=${cachedAuthToken}`;
  console.log(`    ✓ 9router authenticated successfully.`);
  return cachedAuthToken;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

export async function syncWorkerToRouter(index, workerName, options = {}) {
  const isDryRun = options.dryRun ?? DRY_RUN;
  validateRequiredConfig();

  const nodeName = `Freebuff${index}`;
  const prefix = `fb${index}`;
  const baseUrl = `https://${workerName}.${WORKERS_DOMAIN}/v1`;

  console.log(`\n  [9router] Processing ${nodeName} (${prefix}) -> ${baseUrl}`);

  if (isDryRun) {
    console.log(`    [Dry-run] Would authenticate with 9router using password`);
    console.log(`    [Dry-run] Would create/verify provider node: ${nodeName}`);
    console.log(`    [Dry-run] Would register API key connection with prefix '${prefix}'`);
    console.log(`    [Dry-run] Would fetch available models via /models`);
    console.log(`    [Dry-run] Would add all discovered models to 9router via /api/models/custom`);
    return { ok: true, dryRun: true };
  }

  // Ensure authentication
  try {
    await ensureRouterAuth();
  } catch (err) {
    console.error(`    ✗ 9router authentication failed:`, err.message);
    return { ok: false, error: err.message };
  }

  // Step 1: Check existing provider nodes
  const nodesRes = await fetchJson(`${ROUTER_URL}/api/provider-nodes`);
  if (!nodesRes.ok) {
    console.error(`    ✗ Failed to query 9router provider nodes (HTTP ${nodesRes.status})`);
    return { ok: false, error: 'Failed to fetch provider nodes' };
  }

  const nodes = nodesRes.data?.nodes || [];
  let node = nodes.find(n => n.prefix === prefix || n.name === nodeName || n.baseUrl === baseUrl);

  if (!node) {
    console.log(`    + Creating provider node '${nodeName}' in 9router...`);
    const createRes = await fetchJson(`${ROUTER_URL}/api/provider-nodes`, {
      method: 'POST',
      body: JSON.stringify({
        name: nodeName,
        prefix,
        apiType: 'chat',
        baseUrl,
        type: 'openai-compatible'
      })
    });

    if (!createRes.ok || !createRes.data) {
      console.error(`    ✗ Failed to create provider node (HTTP ${createRes.status}):`, createRes.data);
      return { ok: false, error: createRes.data?.error || 'Create node failed' };
    }
    node = createRes.data.node || createRes.data;
    console.log(`    ✓ Provider node created (ID: ${node.id})`);
  } else {
    console.log(`    ✓ Provider node already exists (ID: ${node.id})`);
  }

  // Step 2: Validate and add API Key connection
  const provRes = await fetchJson(`${ROUTER_URL}/api/providers`);
  if (!provRes.ok) {
    console.error(`    ✗ Failed to fetch providers list (HTTP ${provRes.status})`);
    return { ok: false, error: 'Failed to fetch providers' };
  }

  const connections = provRes.data?.connections || [];
  let connection = connections.find(c => c.provider === node.id);

  if (!connection) {
    console.log(`    + Validating API key against ${nodeName}...`);
    const valRes = await fetchJson(`${ROUTER_URL}/api/providers/validate`, {
      method: 'POST',
      body: JSON.stringify({
        provider: node.id,
        apiKey: API_KEY
      })
    });

    if (!valRes.ok || !valRes.data?.valid) {
      console.warn(`    ⚠️ Key validation warning:`, valRes.data?.error || 'Worker may still be propagating');
    }

    console.log(`    + Registering connection key for ${nodeName}...`);
    const addConnRes = await fetchJson(`${ROUTER_URL}/api/providers`, {
      method: 'POST',
      body: JSON.stringify({
        provider: node.id,
        apiKey: API_KEY,
        name: 'Key 1',
        priority: 1,
        testStatus: 'active'
      })
    });

    if (!addConnRes.ok) {
      console.error(`    ✗ Failed to register connection (HTTP ${addConnRes.status}):`, addConnRes.data);
      return { ok: false, error: addConnRes.data?.error || 'Connection registration failed' };
    }

    // Refresh connections list to get the new connection ID
    const refProvRes = await fetchJson(`${ROUTER_URL}/api/providers`);
    connection = (refProvRes.data?.connections || []).find(c => c.provider === node.id);
    console.log(`    ✓ Connection registered (ID: ${connection?.id || 'created'})`);
  } else {
    console.log(`    ✓ Connection already exists (ID: ${connection.id})`);
  }

  // Step 3: Fetch available models from provider
  let availableModels = [];
  if (connection?.id) {
    console.log(`    + Fetching models from ${nodeName}...`);
    const modelsRes = await fetchJson(`${ROUTER_URL}/api/providers/${connection.id}/models`);
    if (modelsRes.ok && Array.isArray(modelsRes.data?.models)) {
      availableModels = modelsRes.data.models;
      console.log(`    ✓ Discovered ${availableModels.length} models from upstream`);
    } else {
      console.warn(`    ⚠️ Model fetch returned no models or error:`, modelsRes.data?.error || modelsRes.status);
    }
  }

  // Step 4: Add models to 9router (/api/models/custom)
  if (availableModels.length > 0) {
    console.log(`    + Registering models to 9router under '${prefix}'...`);
    const customRes = await fetchJson(`${ROUTER_URL}/api/models/custom`);
    const existingModels = new Set(
      (customRes.data?.models || [])
        .filter(m => m.providerAlias === node.id)
        .map(m => m.id)
    );

    let addedCount = 0;
    for (const model of availableModels) {
      if (!existingModels.has(model.id)) {
        const addRes = await fetchJson(`${ROUTER_URL}/api/models/custom`, {
          method: 'POST',
          body: JSON.stringify({
            providerAlias: node.id,
            id: model.id,
            type: 'llm'
          })
        });
        if (addRes.ok) addedCount++;
      }
    }
    const totalActive = existingModels.size + addedCount;
    console.log(`    ✓ Registered ${totalActive} active models in 9router (${addedCount} newly added)`);
  }

  return { ok: true, nodeId: node.id, connectionId: connection?.id };
}

// Run CLI if invoked directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    if (hasFlag('--help') || hasFlag('-h')) {
      console.log(`
Usage: node scripts/sync-9router.mjs [options]

Reads all configurations directly from .env:
  API_KEY, ROUTER_URL, ROUTER_PASSWORD, WORKERS_DOMAIN, WORKER_PREFIX

Targeting Options:
  --total-workers <num>        Sync all workers 1 through N (e.g. 15)
  --worker-index <num>         Specific worker index (e.g. 1)
  --worker-name <name>         Specific worker name (e.g. freebuff2api1)

General Options:
  --dry-run, -d                Simulate synchronization without sending mutations
  --help, -h                   Show this help message
      `.trim());
      process.exit(0);
    }

    validateRequiredConfig();

    console.log(`=== 9router Synchronization ===`);
    console.log(`Router URL    : ${ROUTER_URL}`);
    console.log(`Workers Domain: ${WORKERS_DOMAIN}`);
    console.log(`Dry Run       : ${DRY_RUN}`);

    if (totalWorkersArg) {
      const count = parseInt(totalWorkersArg, 10);
      let success = 0;
      for (let i = 1; i <= count; i++) {
        const wName = `${WORKER_PREFIX}${i}`;
        const res = await syncWorkerToRouter(i, wName);
        if (res.ok) success++;
      }
      console.log(`\n========================================================`);
      console.log(`9router sync complete: ${success}/${count} workers configured.`);
    } else if (workerIndexArg) {
      const idx = parseInt(workerIndexArg, 10);
      const wName = workerNameArg || `${WORKER_PREFIX}${idx}`;
      const res = await syncWorkerToRouter(idx, wName);
      process.exit(res.ok ? 0 : 1);
    } else {
      console.error('Please specify either --total-workers <num> or --worker-index <num>.');
      process.exit(1);
    }
  })().catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
}
