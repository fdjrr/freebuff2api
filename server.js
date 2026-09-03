import http, { createServer } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// === Proxy Support & Rotation (HTTP / HTTPS / SOCKS5 / Raw formats) ===

/**
 * Normalizes and parses proxy configuration supporting:
 * - http://host:port
 * - http://user:pass@host:port
 * - socks5://host:port (and socks5://user:pass@host:port)
 * - host:port (raw, becomes http://host:port)
 * - host:port:user:pass (Webshare-style raw, becomes http://user:pass@host:port)
 *
 * @param {string} raw - Raw proxy string
 * @returns {object|null} Parsed proxy metadata
 */
export function parseProxy(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let str = raw.trim();
  if (!str) return null;

  // Webshare-style raw (host:port:user:pass) or plain raw (host:port)
  if (!str.includes('://')) {
    const parts = str.split(':');
    if (parts.length === 4) {
      const [host, port, user, pass] = parts;
      const portNum = parseInt(port, 10);
      if (isNaN(portNum)) return null;
      return {
        protocol: 'http:',
        host,
        port: portNum,
        username: user,
        password: pass,
        href: `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${portNum}`,
        displayUrl: `http://***:***@${host}:${portNum}`
      };
    }
    if (parts.length === 2) {
      const [host, port] = parts;
      const portNum = parseInt(port, 10);
      if (isNaN(portNum)) return null;
      return {
        protocol: 'http:',
        host,
        port: portNum,
        username: '',
        password: '',
        href: `http://${host}:${portNum}`,
        displayUrl: `http://${host}:${portNum}`
      };
    }
    str = 'http://' + str;
  }

  try {
    const u = new URL(str);
    const protocol = u.protocol.toLowerCase();
    const isSocks = protocol.startsWith('socks');
    const defaultPort = isSocks ? 1080 : 80;
    const portNum = parseInt(u.port, 10) || defaultPort;
    const username = decodeURIComponent(u.username || '');
    const password = decodeURIComponent(u.password || '');
    const hasAuth = Boolean(username || password);
    const authDisplay = hasAuth ? '***:***@' : '';

    return {
      protocol,
      host: u.hostname,
      port: portNum,
      username,
      password,
      href: u.href,
      displayUrl: `${protocol}//${authDisplay}${u.hostname}:${portNum}`
    };
  } catch {
    return null;
  }
}

/**
 * Creates a TCP socket connected to targetHost:targetPort via SOCKS5 (RFC 1928 / 1929).
 */
function connectSocks5(proxy, targetHost, targetPort, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let resolved = false;

    socket.setTimeout(timeout, () => {
      socket.destroy();
      reject(new Error(`SOCKS5 proxy connection timed out to ${proxy.host}:${proxy.port}`));
    });

    socket.once('error', (err) => {
      if (!resolved) reject(new Error(`SOCKS5 proxy error (${proxy.host}:${proxy.port}): ${err.message}`));
    });

    socket.once('connect', () => {
      const hasAuth = Boolean(proxy.username && proxy.password);
      const greeting = hasAuth
        ? Buffer.from([0x05, 0x02, 0x00, 0x02]) // SOCKS5 + NO_AUTH + USER_PASS
        : Buffer.from([0x05, 0x01, 0x00]);      // SOCKS5 + NO_AUTH
      socket.write(greeting);

      socket.once('data', (greetingResp) => {
        if (greetingResp[0] !== 0x05) {
          socket.destroy();
          return reject(new Error('Invalid SOCKS5 greeting response from proxy'));
        }
        const method = greetingResp[1];
        if (method === 0xFF) {
          socket.destroy();
          return reject(new Error('SOCKS5 authentication method negotiation failed'));
        }

        const sendConnect = () => {
          const hostBuf = Buffer.from(targetHost);
          const req = Buffer.alloc(4 + 1 + hostBuf.length + 2);
          req[0] = 0x05; // SOCKS5 version
          req[1] = 0x01; // CMD: CONNECT
          req[2] = 0x00; // Reserved
          req[3] = 0x03; // ATYP: DOMAINNAME
          req[4] = hostBuf.length;
          hostBuf.copy(req, 5);
          req.writeUInt16BE(targetPort, 5 + hostBuf.length);
          socket.write(req);

          socket.once('data', (connectResp) => {
            if (connectResp[0] !== 0x05 || connectResp[1] !== 0x00) {
              socket.destroy();
              const codes = {
                0x01: 'general failure',
                0x02: 'connection not allowed',
                0x03: 'network unreachable',
                0x04: 'host unreachable',
                0x05: 'connection refused',
                0x06: 'TTL expired',
                0x07: 'command not supported',
                0x08: 'address type not supported',
              };
              return reject(new Error(`SOCKS5 connect failed: ${codes[connectResp[1]] || `status code ${connectResp[1]}`}`));
            }
            resolved = true;
            socket.setTimeout(0);
            socket.removeAllListeners('error');
            resolve(socket);
          });
        };

        if (method === 0x02) {
          // RFC 1929 Username/Password Auth
          const uBuf = Buffer.from(proxy.username);
          const pBuf = Buffer.from(proxy.password);
          const authBuf = Buffer.alloc(1 + 1 + uBuf.length + 1 + pBuf.length);
          authBuf[0] = 0x01; // Sub-negotiation version 1
          authBuf[1] = uBuf.length;
          uBuf.copy(authBuf, 2);
          authBuf[2 + uBuf.length] = pBuf.length;
          pBuf.copy(authBuf, 3 + uBuf.length);
          socket.write(authBuf);

          socket.once('data', (authResp) => {
            if (authResp[0] !== 0x01 || authResp[1] !== 0x00) {
              socket.destroy();
              return reject(new Error('SOCKS5 username/password authentication failed'));
            }
            sendConnect();
          });
        } else {
          sendConnect();
        }
      });
    });
  });
}

/**
 * Creates a TCP socket connected to targetHost:targetPort via HTTP CONNECT tunneling.
 */
function connectHttpTunnel(proxy, targetHost, targetPort, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const isHttpsProxy = proxy.protocol === 'https:';
    const connector = isHttpsProxy ? tls.connect : net.connect;
    const socket = connector({ host: proxy.host, port: proxy.port });
    let resolved = false;

    socket.setTimeout(timeout, () => {
      socket.destroy();
      reject(new Error(`HTTP proxy connection timed out to ${proxy.host}:${proxy.port}`));
    });

    socket.once('error', (err) => {
      if (!resolved) reject(new Error(`HTTP proxy error (${proxy.host}:${proxy.port}): ${err.message}`));
    });

    socket.once('connect', () => {
      let reqStr = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
      if (proxy.username || proxy.password) {
        const creds = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
        reqStr += `Proxy-Authorization: Basic ${creds}\r\n`;
      }
      reqStr += 'Proxy-Connection: Keep-Alive\r\n\r\n';
      socket.write(reqStr);

      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('latin1');
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
          socket.removeListener('data', onData);
          const firstLine = buffer.slice(0, buffer.indexOf('\r\n'));
          const statusMatch = firstLine.match(/HTTP\/\d\.\d\s+(\d+)/i);
          const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;
          if (statusCode < 200 || statusCode >= 300) {
            socket.destroy();
            return reject(new Error(`HTTP proxy CONNECT failed: ${firstLine}`));
          }
          resolved = true;
          socket.setTimeout(0);
          socket.removeAllListeners('error');
          const leftover = Buffer.from(buffer.slice(headerEnd + 4), 'latin1');
          if (leftover.length > 0) socket.unshift(leftover);
          resolve(socket);
        }
      };
      socket.on('data', onData);
    });
  });
}

/**
 * Creates custom http/https agents that route outgoing connections through the proxy.
 */
function createProxyAgents(proxy) {
  const isSocks = proxy.protocol.startsWith('socks');

  const httpAgent = new http.Agent({ keepAlive: true });
  httpAgent.createConnection = function (options, callback) {
    const targetHost = options.host || options.hostname;
    const targetPort = options.port || 80;
    const connectFn = isSocks ? connectSocks5 : connectHttpTunnel;
    connectFn(proxy, targetHost, targetPort)
      .then((socket) => callback(null, socket))
      .catch((err) => callback(err));
  };

  const httpsAgent = new https.Agent({ keepAlive: true });
  httpsAgent.createConnection = function (options, callback) {
    const targetHost = options.host || options.hostname;
    const targetPort = options.port || 443;
    const connectFn = isSocks ? connectSocks5 : connectHttpTunnel;
    connectFn(proxy, targetHost, targetPort)
      .then((baseSocket) => {
        const tlsSocket = tls.connect({
          socket: baseSocket,
          servername: options.servername || targetHost,
          rejectUnauthorized: options.rejectUnauthorized !== false,
        });
        tlsSocket.once('error', (err) => callback(err));
        tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
      })
      .catch((err) => callback(err));
  };

  return { httpAgent, httpsAgent };
}

// Load proxy list from file or environment variables
const proxyFile = process.env.PROXIES_FILE ? resolve(__dirname, process.env.PROXIES_FILE) : resolve(__dirname, 'proxies.txt');
const rawProxies = [];

if (existsSync(proxyFile)) {
  try {
    const raw = readFileSync(proxyFile, 'utf-8');
    for (const line of raw.split(/[\r\n]+/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) rawProxies.push(trimmed);
    }
  } catch (err) {
    console.error(`[server] failed to read ${proxyFile}: ${err.message}`);
  }
}

const envProxyStr = process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '';
if (envProxyStr) {
  for (const p of envProxyStr.split(/[\n,]/)) {
    const trimmed = p.trim();
    if (trimmed && !rawProxies.includes(trimmed)) rawProxies.push(trimmed);
  }
}

const proxyList = rawProxies.map(parseProxy).filter(Boolean);
let proxyIdx = 0;

function getNextProxy() {
  if (proxyList.length === 0) return null;
  const p = proxyList[proxyIdx % proxyList.length];
  proxyIdx = (proxyIdx + 1) % proxyList.length;
  return p;
}

if (proxyList.length > 0) {
  console.log(`[server] loaded ${proxyList.length} outgoing proxies for rotation (HTTP/SOCKS5)`);
  const agentCache = new Map();

  function getAgentsForProxy(proxy) {
    const key = proxy.href;
    if (!agentCache.has(key)) {
      agentCache.set(key, createProxyAgents(proxy));
    }
    return agentCache.get(key);
  }

  globalThis.fetch = function customFetch(input, init = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        let url;
        let method = 'GET';
        const headers = new Headers();
        let body = null;
        let signal = null;

        if (input instanceof Request) {
          url = new URL(input.url);
          method = input.method;
          for (const [k, v] of input.headers.entries()) headers.set(k, v);
          signal = input.signal;
          if (input.body) body = input.body;
        } else {
          url = new URL(typeof input === 'string' ? input : input.toString());
        }

        if (init.method) method = init.method;
        if (init.headers) {
          const extraHeaders = new Headers(init.headers);
          for (const [k, v] of extraHeaders.entries()) headers.set(k, v);
        }
        if (init.body !== undefined && init.body !== null) body = init.body;
        if (init.signal) signal = init.signal;

        if (signal?.aborted) {
          return reject(signal.reason || new Error('Aborted'));
        }

        const selectedProxy = getNextProxy();
        const isHttps = url.protocol === 'https:';
        const client = isHttps ? https : http;

        let agent = undefined;
        if (selectedProxy) {
          const agents = getAgentsForProxy(selectedProxy);
          agent = isHttps ? agents.httpsAgent : agents.httpAgent;
        }

        const reqHeaders = Object.fromEntries(headers.entries());

        const reqOptions = {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: method.toUpperCase(),
          headers: reqHeaders,
          agent,
        };

        const nodeReq = client.request(reqOptions);

        let abortHandler = null;
        if (signal) {
          abortHandler = () => {
            nodeReq.destroy(signal.reason || new Error('Aborted'));
            reject(signal.reason || new Error('Aborted'));
          };
          signal.addEventListener('abort', abortHandler, { once: true });
        }

        nodeReq.once('error', (err) => {
          if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
          reject(err);
        });

        nodeReq.once('response', (nodeRes) => {
          if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);

          const resHeaders = new Headers();
          for (const [key, val] of Object.entries(nodeRes.headers)) {
            if (val === undefined) continue;
            if (Array.isArray(val)) {
              for (const v of val) resHeaders.append(key, v);
            } else {
              resHeaders.set(key, val);
            }
          }

          const webStream = new ReadableStream({
            start(controller) {
              nodeRes.on('data', (chunk) => {
                controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
              });
              nodeRes.on('end', () => {
                try { controller.close(); } catch {}
              });
              nodeRes.on('error', (err) => {
                try { controller.error(err); } catch {}
              });
            },
            cancel() {
              nodeRes.destroy();
            }
          });

          const response = new Response(webStream, {
            status: nodeRes.statusCode || 200,
            statusText: nodeRes.statusMessage || '',
            headers: resHeaders,
          });

          resolve(response);
        });

        if (body) {
          if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
            nodeReq.end(body);
          } else if (body instanceof ReadableStream) {
            const reader = body.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) nodeReq.write(Buffer.from(value));
              }
              nodeReq.end();
            } catch (err) {
              nodeReq.destroy(err);
              reject(err);
            }
          } else {
            nodeReq.end(body);
          }
        } else {
          nodeReq.end();
        }
      } catch (err) {
        reject(err);
      }
    });
  };
}

// Load worker module
const worker = await import('./worker.js');
const handler = worker.default;

// === Build env from config ===

// Read tokens from credentials/ directory (.json and .jsonl)
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
  PROXY_URL: proxyList.length > 0 ? proxyList[0].href : '',
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
