// clean-banned.mjs — probe every credential/*.json and credential/*.jsonl token against
// the upstream session endpoint and clean accounts that are permanently dead (banned / invalid token).
// Read-only for healthy accounts: it never deletes a file/entry unless the upstream itself
// returned a permanent-failure status for that token.
//
// Usage:
//   node scripts/clean-banned.mjs            # probe + report only
//   node scripts/clean-banned.mjs --delete   # probe + remove permanently-dead entries/files
//
// After cleanup: docker compose restart (server.js reloads credentials/ at startup).

import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { Readable } from 'node:stream';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const credDir = resolve(__dirname, '..', 'credentials');
const proxyFile = resolve(__dirname, '..', process.env.PROXIES_FILE || 'proxies.txt');
const DELETE = process.argv.includes('--delete');
const API = process.env.CODEBUFF_API || 'https://www.codebuff.com';

// === Setup Proxy Rotation ===
let proxyList = [];
if (existsSync(proxyFile)) {
  try {
    const raw = readFileSync(proxyFile, 'utf-8');
    proxyList = raw.split(/[\r\n]+/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch {}
}
if (process.env.PROXY_URL) {
  for (const p of process.env.PROXY_URL.split(/[\n,]/)) {
    const pt = p.trim();
    if (pt && !proxyList.includes(pt)) proxyList.push(pt);
  }
}

let proxyIdx = 0;
function getNextProxy() {
  if (proxyList.length === 0) return null;
  const p = proxyList[proxyIdx % proxyList.length];
  proxyIdx = (proxyIdx + 1) % proxyList.length;
  return p;
}

if (proxyList.length > 0) {
  console.log(`[clean-banned] loaded ${proxyList.length} proxies for probing`);
  const originalFetch = globalThis.fetch;

  function proxyFetch(proxyUrlStr, targetUrlStr, options = {}) {
    return new Promise((resolve, reject) => {
      const pUrl = new URL(proxyUrlStr);
      const targetUrl = new URL(targetUrlStr);
      const isTargetHttps = targetUrl.protocol === 'https:';
      const targetPort = targetUrl.port || (isTargetHttps ? 443 : 80);

      const authHeader = pUrl.username
        ? 'Basic ' + Buffer.from(decodeURIComponent(pUrl.username) + ':' + decodeURIComponent(pUrl.password)).toString('base64')
        : null;

      const connReq = httpRequest({
        host: pUrl.hostname,
        port: parseInt(pUrl.port, 10) || 80,
        method: 'CONNECT',
        path: `${targetUrl.hostname}:${targetPort}`,
        headers: {
          'Host': `${targetUrl.hostname}:${targetPort}`,
          ...(authHeader ? { 'Proxy-Authorization': authHeader } : {}),
        },
      });

      if (options.signal) {
        options.signal.addEventListener('abort', () => connReq.destroy(options.signal.reason), { once: true });
      }

      connReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return reject(new Error(`Proxy CONNECT failed: status ${res.statusCode}`));
        }

        let secureSocket = socket;
        if (isTargetHttps) {
          secureSocket = tlsConnect({
            socket,
            servername: targetUrl.hostname,
          });
        }

        const outHeaders = options.headers
          ? (options.headers instanceof Headers ? Object.fromEntries(options.headers.entries()) : { ...options.headers })
          : {};
        if (!outHeaders['Host'] && !outHeaders['host']) {
          outHeaders['Host'] = targetUrl.host;
        }

        const clientReq = (isTargetHttps ? httpsRequest : httpRequest)({
          createConnection: () => secureSocket,
          method: options.method || 'GET',
          path: targetUrl.pathname + targetUrl.search,
          headers: outHeaders,
        }, (clientRes) => {
          const webHeaders = new Headers();
          for (const [k, v] of Object.entries(clientRes.headers)) {
            if (Array.isArray(v)) {
              for (const item of v) webHeaders.append(k, item);
            } else if (v !== undefined) {
              webHeaders.set(k, v);
            }
          }
          const bodyStream = Readable.toWeb(clientRes);
          resolve(new Response(bodyStream, {
            status: clientRes.statusCode,
            statusText: clientRes.statusMessage,
            headers: webHeaders,
          }));
        });

        if (options.signal) {
          options.signal.addEventListener('abort', () => {
            clientReq.destroy(options.signal.reason);
          }, { once: true });
        }

        clientReq.on('error', reject);

        if (options.body) {
          if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) {
            clientReq.write(options.body);
            clientReq.end();
          } else if (options.body instanceof Uint8Array) {
            clientReq.write(Buffer.from(options.body));
            clientReq.end();
          } else {
            clientReq.end();
          }
        } else {
          clientReq.end();
        }
      });

      connReq.on('error', reject);
      connReq.end();
    });
  }

  globalThis.fetch = function customGlobalFetch(input, init) {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
    const selectedProxy = getNextProxy();
    if (selectedProxy && (url.startsWith('http://') || url.startsWith('https://'))) {
      return proxyFetch(selectedProxy, url, init);
    }
    return originalFetch(input, init);
  };
}

if (!existsSync(credDir)) {
  console.error(`[clean-banned] credentials directory not found: ${credDir}`);
  process.exit(1);
}

const allFiles = readdirSync(credDir).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl')).sort();
console.log(`[clean-banned] found ${allFiles.length} credential file(s) in ${credDir}${DELETE ? ' (delete mode)' : ''}`);

async function probeToken(authToken) {
  try {
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
      return { ok: false, dead: true, reason: 'banned' };
    } else if (res.status === 401) {
      return { ok: false, dead: true, reason: 'token_invalid' };
    } else if (res.status === 403) {
      return { ok: false, dead: true, reason: 'blocked', detail: `HTTP 403 ${state || text.slice(0, 80)}` };
    } else if (res.status >= 200 && res.status < 300) {
      return { ok: true, dead: false };
    } else {
      return { ok: false, dead: false, transient: true, detail: `HTTP ${res.status} ${text.slice(0, 80)}` };
    }
  } catch (err) {
    return { ok: false, dead: false, error: err.message };
  }
}

let totalOk = 0;
let totalDead = 0;
let totalUnknown = 0;

for (const file of allFiles) {
  const fullPath = resolve(credDir, file);

  if (file.endsWith('.jsonl')) {
    let raw = '';
    try {
      raw = readFileSync(fullPath, 'utf-8');
    } catch (err) {
      console.log(`? [unreadable] ${file}: ${err.message}`);
      totalUnknown++;
      continue;
    }

    const lines = raw.split('\n');
    const survivingLines = [];
    let fileDeadCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      let obj = null;
      try {
        obj = JSON.parse(line);
      } catch (err) {
        console.log(`? [bad-json]  ${file}:${i + 1} (${err.message})`);
        survivingLines.push(line);
        totalUnknown++;
        continue;
      }

      const authToken = (obj.authToken || obj.token || '').trim();
      const identifier = obj.email || obj.user?.email || obj.user?.name || `line_${i + 1}`;

      if (!authToken) {
        console.log(`? [no-token]  ${file}:${i + 1} (${identifier})`);
        survivingLines.push(line);
        totalUnknown++;
        continue;
      }

      const result = await probeToken(authToken);
      if (result.ok) {
        console.log(`✓ [ok]        ${file}:${i + 1} (${identifier})`);
        survivingLines.push(line);
        totalOk++;
      } else if (result.dead) {
        console.log(`✗ [${result.reason}] ${file}:${i + 1} (${identifier}) ${result.detail || ''}`);
        fileDeadCount++;
        totalDead++;
      } else {
        console.log(`? [transient] ${file}:${i + 1} (${identifier}) ${result.detail || result.error || ''}`);
        survivingLines.push(line);
        totalUnknown++;
      }
    }

    if (fileDeadCount > 0 && DELETE) {
      if (survivingLines.length === 0) {
        unlinkSync(fullPath);
        console.log(`[clean-banned] deleted empty ${file} (all accounts dead)`);
      } else {
        writeFileSync(fullPath, survivingLines.join('\n') + '\n', 'utf-8');
        console.log(`[clean-banned] updated ${file} (removed ${fileDeadCount} dead accounts, kept ${survivingLines.length})`);
      }
    }
  } else if (file.endsWith('.json')) {
    let authToken = null;
    let identifier = file;
    try {
      const obj = JSON.parse(readFileSync(fullPath, 'utf-8'));
      authToken = typeof obj.authToken === 'string' ? obj.authToken.trim() : (typeof obj.token === 'string' ? obj.token.trim() : null);
      identifier = obj.email || obj.name || file;
    } catch (err) {
      console.log(`? [unreadable] ${file}: ${err.message}`);
      totalUnknown++;
      continue;
    }

    if (!authToken) {
      console.log(`? [no-token]   ${file} (missing authToken field)`);
      totalUnknown++;
      continue;
    }

    const result = await probeToken(authToken);
    if (result.ok) {
      console.log(`✓ [ok]       ${file} (${identifier})`);
      totalOk++;
    } else if (result.dead) {
      console.log(`✗ [${result.reason}] ${file} (${identifier}) ${result.detail || ''}`);
      totalDead++;
      if (DELETE) {
        unlinkSync(fullPath);
        console.log(`[clean-banned] deleted ${file} (${result.reason})`);
      }
    } else {
      console.log(`? [transient] ${file} (${identifier}) ${result.detail || result.error || ''}`);
      totalUnknown++;
    }
  }
}

console.log(`\n[clean-banned] ok=${totalOk} permanently-dead=${totalDead} unknown/transient=${totalUnknown}`);
if (totalDead > 0) {
  if (DELETE) {
    console.log(`[clean-banned] Cleanup complete. Restart the container: docker compose restart`);
  } else {
    console.log('[clean-banned] re-run with --delete to remove the dead accounts/files.');
  }
}
