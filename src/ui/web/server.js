import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LushError } from '../../core/types.js';
import { taskRequest } from '../client.js';

const ASSET_DIR = fileURLToPath(new URL('./assets/', import.meta.url));
const MAX_BODY_BYTES = 128 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function response(body, { status = 200, type = 'application/json; charset=utf-8', headers = {} } = {}) {
  return new Response(body, {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': type, ...headers },
  });
}

function json(value, status = 200) {
  return response(JSON.stringify(value), { status });
}

function errorStatus(err) {
  if (!(err instanceof LushError)) return 500;
  if (err.code === -32602) return 400;
  if (err.code === -32004 && err.message.startsWith('cannot connect to lushd')) return 503;
  if (err.code === -32601 || err.code === -32004) return 404;
  if (err.code === -32009 || err.code === -32010) return 409;
  if (err.code === -32021) return 504;
  if (err.code === -32020) return 502;
  return 500;
}

function apiError(err) {
  const status = errorStatus(err);
  const code = err instanceof LushError ? err.code : -32603;
  const message = err instanceof LushError ? err.message : 'internal error';
  return json({ error: { code, message } }, status);
}

function sameOrigin(request, url) {
  const origin = request.headers.get('origin');
  return origin === null || origin === url.origin;
}

async function requestJson(request) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new LushError('Content-Type must be application/json', -32602);
  }
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new LushError(`request body exceeds ${MAX_BODY_BYTES} bytes`, -32602);
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    throw new LushError(`request body exceeds ${MAX_BODY_BYTES} bytes`, -32602);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new LushError('request body must be valid JSON', -32602);
  }
}

/** Local HTTP adapter for the shared UI interaction model. */
export class WebUIServer {
  constructor(ui, { hostname = '127.0.0.1', port = 4318 } = {}) {
    if (ui === null || typeof ui !== 'object') throw new TypeError('WebUIServer requires a UI client');
    if (!LOOPBACK_HOSTS.has(hostname)) {
      throw new Error(`Web UI must listen on loopback (got ${hostname})`);
    }
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error(`invalid Web UI port: ${port}`);
    }
    this.ui = ui;
    this.hostname = hostname;
    this.port = port;
    this.server = null;
  }

  get url() {
    return this.server?.url ?? null;
  }

  async start() {
    if (this.server !== null) return this;
    this.server = Bun.serve({
      hostname: this.hostname,
      port: this.port,
      fetch: (request) => this.fetch(request),
      error: () => apiError(new Error('request handler failed')),
    });
    return this;
  }

  async stop() {
    if (this.server === null) return;
    const server = this.server;
    this.server = null;
    await server.stop(true);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') && !sameOrigin(request, url)) {
      return json({ error: { code: -32600, message: 'cross-origin requests are not allowed' } }, 403);
    }

    try {
      if (request.method === 'GET' && url.pathname === '/api/tree') {
        return json({ services: await this.ui.serviceTree() });
      }

      if (request.method === 'POST' && url.pathname === '/api/tasks') {
        const input = taskRequest(await requestJson(request));
        const task = await this.ui.createTask(input.sid, input.goal);
        return json({ task }, 202);
      }

      const resultMatch = /^\/api\/tasks\/(\d+)$/.exec(url.pathname);
      if (request.method === 'GET' && resultMatch !== null) {
        const taskId = Number(resultMatch[1]);
        return json({ task: await this.ui.taskResult(taskId) });
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        const asset = ASSETS.get(url.pathname);
        if (asset !== undefined) {
          const [name, type] = asset;
          const body = request.method === 'HEAD' ? null : Bun.file(path.join(ASSET_DIR, name));
          return response(body, { type });
        }
      }

      if (url.pathname.startsWith('/api/')) {
        return json({ error: { code: -32601, message: 'API route not found' } }, 404);
      }
      return response('Not found\n', { status: 404, type: 'text/plain; charset=utf-8' });
    } catch (err) {
      return apiError(err);
    }
  }
}
