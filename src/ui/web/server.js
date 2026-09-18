import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UIClient } from '../client.js';
import { check } from '../../core/types.js';
const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url));
const MUTATIONS = new Set(['input.submit','input.flow','draft.add','draft.remove','draft.commit','task.message','task.cancel','task.retry','task.merge','task.cleanup','notice.answer','notice.dismiss']);
export function startWeb(config, port = 4318) {
  check(Number.isInteger(port) && port >= 0 && port <= 65535, 'invalid web port');
  const client = new UIClient(config);
  return Bun.serve({
    hostname: '127.0.0.1', port, maxRequestBodySize: 128 * 1024,
    async fetch(request, server) {
      const url = new URL(request.url);
      const hosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
      if (!hosts.includes(request.headers.get('host'))) return new Response('Invalid host', { status: 403 });
      const origin = request.headers.get('origin');
      if (origin && !hosts.some(host => origin === `http://${host}`)) return new Response('Invalid origin', { status: 403 });
      if (request.headers.get('sec-fetch-site') === 'cross-site') return new Response('Cross-site access denied', { status: 403 });
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
      const json = (body, status = 200) => Response.json(body, { status, headers });
      try {
        if (request.method === 'GET') {
          if (url.pathname === '/api/snapshot') return json(await client.snapshot());
          const read = /^\/api\/task\/(\d+)(\/(history|diff))?$/.exec(url.pathname);
          if (read) {
            const taskId = Number(read[1]);
            if (read[3] === 'history') return json(await client.request('task.history', { id: taskId, after: Number(url.searchParams.get('after') ?? 0) }));
            if (read[3] === 'diff') return json(await client.request('task.diff', { id: taskId }));
            return json(await client.request('task.inspect', { id: taskId }));
          }
          if (url.pathname === '/favicon.ico') return new Response(null, { status: 204, headers });
          const files = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' };
          if (Object.hasOwn(files, url.pathname)) return new Response(Bun.file(path.join(ASSETS, files[url.pathname])), { headers });
        }
        if (request.method === 'POST' && url.pathname === '/api/action') {
          check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
          const { method, params } = await request.json();
          check(MUTATIONS.has(method), 'method not allowed from Web UI');
          check(!params?._token, 'agent tokens are not accepted by Web UI');
          return json(await client.request(method, params));
        }
        return json({ error: 'not found' }, 404);
      } catch (error) { return json({ error: error.message }, 400); }
    },
  });
}
