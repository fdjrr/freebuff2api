import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { Readable } from 'node:stream';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// === Proxy Rotation Setup ===
const proxyFile = process.env.PROXIES_FILE ? resolve(__dirname, process.env.PROXIES_FILE) : resolve(__dirname, 'proxies.txt');
let proxyList = [];
if (existsSync(proxyFile)) {
  try {
    const raw = readFileSync(proxyFile, 'utf-8');
    proxyList = raw.split(/[\r\n]+/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch (err) {
    console.error(`[server] failed to read ${proxyFile}: ${err.message}`);
  }
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
  console.log(`[server] loaded ${proxyList.length} proxies for rotation`);
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

// Load worker module
const worker = await import('./worker.js');
const handler = worker.default;

// === Build env from config ===

// Read tokens from credentials/ directory
const credDir = resolve(__dirname, 'credentials');
let tokenLines = [];
if (existsSync(credDir)) {
  for (const f of readdirSync(credDir)) {
    const fullPath = resolve(credDir, f);
    if (f.endsWith('.jsonl')) {
      try {
        const raw = readFileSync(fullPath, 'utf-8');
        const lines = raw.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            const token = (obj.authToken || obj.token || '').trim();
            const uid = (obj.user?.id || obj.uid || '').trim();
            if (token) {
              const entry = uid ? `${token}:${uid}` : token;
              if (!tokenLines.includes(entry)) tokenLines.push(entry);
            }
          } catch (lineErr) {
            console.error(`[server] skip bad line in ${f}: ${lineErr.message}`);
          }
        }
      } catch (err) {
        console.error(`[server] skip bad credential file ${f}: ${err.message}`);
      }
    } else if (f.endsWith('.json')) {
      try {
        const raw = readFileSync(fullPath, 'utf-8');
        const obj = JSON.parse(raw);
        const token = (obj.authToken || obj.token || '').trim();
        const uid = (obj.user?.id || obj.uid || '').trim();
        if (token) {
          const entry = uid ? `${token}:${uid}` : token;
          if (!tokenLines.includes(entry)) tokenLines.push(entry);
        }
      } catch (err) {
        console.error(`[server] skip bad credential ${f}: ${err.message}`);
      }
    }
  }
}

// Also allow FREEBUFF_TOKEN env var for non-credential token sources
const envToken = process.env.FREEBUFF_TOKEN || '';
if (envToken) {
  for (const tok of envToken.split(/[\n,]/)) {
    const t = tok.trim();
    if (t && !tokenLines.includes(t)) tokenLines.push(t);
  }
}

const env = {
  FREEBUFF_TOKEN: tokenLines.join(','),
  FREEBUFF_API_KEY: process.env.FREEBUFF_API_KEY || 'freebuff-default-key',
  FREEBUFF_DEBUG: process.env.FREEBUFF_DEBUG || 'false',
  CODEBUFF_API: process.env.CODEBUFF_API || '',
  RELAY_URL: process.env.RELAY_URL || '',
};

console.log(`[server] start: ${tokenLines.length} tokens, apiKey=${env.FREEBUFF_API_KEY.slice(0,8)}..., debug=${env.FREEBUFF_DEBUG}`);
if (env.CODEBUFF_API) console.log(`[server] CODEBUFF_API=${env.CODEBUFF_API}`);
if (env.RELAY_URL) console.log(`[server] RELAY_URL=${env.RELAY_URL}`);

// === HTTP server ===
const port = parseInt(process.env.PORT || '8787', 10);
const host = process.env.HOST || '0.0.0.0';

const server = createServer(async (nodeReq, nodeRes) => {
  try {
    // Build array of raw bytes from Node request
    const chunks = [];
    for await (const chunk of nodeReq) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    // Build a CF-compatible Request
    const url = `http://${nodeReq.headers.host || 'localhost'}${nodeReq.url}`;
    const request = new Request(url, {
      method: nodeReq.method,
      headers: new Headers(nodeReq.headers),
      body: body.length > 0 ? body : null,
    });

    // Call the worker's fetch handler
    const response = await handler.fetch(request, env);

    // Write response back to Node socket
    nodeRes.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) nodeRes.write(Buffer.from(value));
        }
      } catch (err) {
        // Stream errors are expected on client disconnect
        if (!nodeRes.writableEnded) nodeRes.end();
        return;
      }
    }
    if (!nodeRes.writableEnded) nodeRes.end();
  } catch (err) {
    console.error('[server] request error:', err.message);
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(502, { 'content-type': 'application/json' });
      nodeRes.end(JSON.stringify({ error: { message: 'proxy error', type: 'proxy_error' } }));
    } else if (!nodeRes.writableEnded) {
      nodeRes.end();
    }
  }
});

server.listen(port, host, () => {
  console.log(`[server] listening on ${host}:${port}`);
});