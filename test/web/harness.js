import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fixture } from '../helpers.js';
import { RPCServer } from '../../src/rpc/server.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
import { startWeb } from '../../src/ui/web/server.js';

// test/web 的公共准备：真起 RPCServer + Web server，用 node:http 打 HTTP，不依赖全局 fetch。
// node:http does not inherit machine-wide proxies for these loopback tests.
export const fetch = (url, options = {}) => new Promise((resolve, reject) => {
  const request = http.request(url, { method: options.method || 'GET', headers: options.headers }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
  });
  request.on('error', reject); request.end(options.body);
});
// 前端拆成模块图之后 /app.js 只是入口：断言「页面确实带上了 X」要顺着 import 把整张图读下来，
// 否则 X 搬进模块里就会误报。live.mjs 之类白名单外的路径仍必须 404（下面单独断言）。
export async function pageSource(url) {
  const seen = new Set(); const pending = ['/app.js']; const chunks = [];
  while (pending.length) {
    const file = pending.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await (await fetch(url + file)).text();
    chunks.push(text);
    for (const match of text.matchAll(/from\s+'(\.[^']+)'/g)) pending.push(new URL(match[1], `http://page${file}`).pathname);
  }
  return chunks.join('\n');
}

export async function setup(options = {}) {
  const f = fixture(), signal = createSignal();
  if (options.auth) fs.writeFileSync(path.join(f.config.home, 'web.json'), JSON.stringify({ version: 1, ...options.auth }, null, 2) + '\n', { mode: 0o600 });
  const rpc = new RPCServer(f.config.socket,new Dispatcher(f.project,signal,{})); await rpc.start();
  const web = startWeb(f.config,0);
  return { ...f, rpc, web, url:`http://127.0.0.1:${web.port}`, async close() {
    web.stop(true); await rpc.close(); await f.close(); fs.rmSync(f.config.socket,{force:true});
  } };
}
