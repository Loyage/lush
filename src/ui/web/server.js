import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UIClient } from '../client.js';
import { check } from '../../core/types.js';
const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url));
const MUTATIONS = new Set(['input.submit','input.flow','draft.add','draft.remove','draft.commit','task.message','task.cancel','task.retry','task.merge','task.cleanup','task.verify','task.clear','notice.answer','notice.dismiss']);
/** 检验报告是 agent 写的自包含 HTML：只允许内联样式/脚本与 data: 图片，禁止任何外部加载与表单提交。
 *  主页面 CSP 不会作用于这个独立文档，所以这里必须自己收紧。 */
const REPORT_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";
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
          const report = /^\/api\/task\/(\d+)\/report$/.exec(url.pathname);
          if (report) {
            const task = await client.request('task.inspect', { id: Number(report[1]) });
            check(task.role === 'verifier', `task #${task.id} is not a verification`);
            const file = path.join(config.home, 'verify', String(task.id), 'report.html');
            if (!fs.existsSync(file)) return json({ error: `verification #${task.id} has no report yet` }, 404);
            // 独立顶层文档（新标签打开）：不受主页面 CSP 约束，但仍显式收紧到一个自包含页面。
            return new Response(Bun.file(file), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': REPORT_CSP } });
          }
          const read = /^\/api\/task\/(\d+)(\/(history|diff|transcript|usage))?$/.exec(url.pathname);
          if (read) {
            const taskId = Number(read[1]);
            if (read[3] === 'history') return json(await client.request('task.history', { id: taskId, after: Number(url.searchParams.get('after') ?? 0) }));
            if (read[3] === 'diff') return json(await client.request('task.diff', { id: taskId }));
            if (read[3] === 'usage') return json(await client.request('task.usage', { id: taskId }));
            if (read[3] === 'transcript') return json(await client.request('task.transcript', { id: taskId, after: Number(url.searchParams.get('after') ?? 0) }));
            return json(await client.request('task.inspect', { id: taskId }));
          }
          if (url.pathname === '/favicon.ico') return new Response(null, { status: 204, headers });
          const files = { '/': 'index.html', '/app.js': 'app.js', '/markdown.js': 'markdown.js', '/tree-order.js': 'tree-order.js', '/styles.css': 'styles.css' };
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
