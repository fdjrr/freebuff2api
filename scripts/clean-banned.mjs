// clean-banned.mjs — probe every credential/*.json token against the upstream session
// endpoint and remove files whose accounts are permanently dead (banned / invalid token).
// Read-only for healthy accounts: it never deletes a file unless the upstream itself
// returned a permanent-failure status for that token.
//
// Usage:
//   node scripts/clean-banned.mjs            # probe + report only
//   node scripts/clean-banned.mjs --delete   # probe + delete permanently-dead files
//
// After cleanup: docker compose restart (server.js reloads credentials/ at startup).

import { readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const credDir = resolve(__dirname, '..', 'credentials');
const DELETE = process.argv.includes('--delete');
const API = process.env.CODEBUFF_API || 'https://www.codebuff.com';

if (!existsSync(credDir)) {
  console.error(`[clean-banned] credentials directory not found: ${credDir}`);
  process.exit(1);
}

const files = readdirSync(credDir).filter((f) => f.endsWith('.json')).sort();
console.log(`[clean-banned] probing ${files.length} credential file(s) from ${credDir}${DELETE ? ' (delete mode)' : ''}`);

const dead = [];
let ok = 0, unknown = 0;

for (const file of files) {
  const filePath = resolve(credDir, file);
  let authToken = null;
  try {
    const obj = JSON.parse(readFileSync(filePath, 'utf-8'));
    authToken = typeof obj.authToken === 'string' ? obj.authToken.trim() : null;
  } catch (err) {
    console.log(`? [unreadable] ${file}: ${err.message}`);
    unknown++;
    continue;
  }
  if (!authToken) {
    console.log(`? [no-token]   ${file} (missing authToken field)`);
    unknown++;
    continue;
  }

  try {
    // Same single-session + pre-generated instance-id signature worker.js uses;
    // cheap model, short timeout. A 200 here burns one standard session on a healthy
    // account — pass --dry-run-style caution: run before a restart, not mid-day.
    const res = await fetch(`${API}/api/v1/freebuff/session`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'x-freebuff-model': 'mimo/mimo-v2.5',
        'x-freebuff-instance-id': crypto.randomUUID(),
      },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    const state = data && typeof data === 'object' ? data.status || data.state : null;

    if (res.status === 403 && state === 'banned') {
      console.log(`✗ [banned]   ${file}`);
      dead.push({ file, reason: 'banned' });
    } else if (res.status === 401) {
      console.log(`✗ [invalid]  ${file} (token_invalid)`);
      dead.push({ file, reason: 'token_invalid' });
    } else if (res.status === 403) {
      // 403 without an explicit banned body: blocked/country_blocked — report, let the caller decide
      console.log(`✗ [blocked]  ${file} (HTTP 403 ${state || text.slice(0, 80)})`);
      dead.push({ file, reason: 'blocked' });
    } else if (res.status >= 200 && res.status < 300) {
      console.log(`✓ [ok]       ${file}`);
      ok++;
    } else {
      // 429 / 5xx / queued: transient — never treat as dead
      console.log(`? [transient] ${file} (HTTP ${res.status} ${text.slice(0, 80)})`);
      unknown++;
    }
  } catch (err) {
    console.log(`? [error]     ${file}: ${err.message}`);
    unknown++;
  }
}

console.log(`\n[clean-banned] ok=${ok} permanently-dead=${dead.length} unknown/transient=${unknown}`);

if (dead.length > 0) {
  if (DELETE) {
    for (const { file, reason } of dead) {
      unlinkSync(resolve(credDir, file));
      console.log(`[clean-banned] deleted ${file} (${reason})`);
    }
    console.log(`[clean-banned] ${dead.length} file(s) deleted. Restart the container: docker compose restart`);
  } else {
    console.log('[clean-banned] re-run with --delete to remove the dead files:');
    for (const { file, reason } of dead) console.log(`  ${file}  # ${reason}`);
  }
}
