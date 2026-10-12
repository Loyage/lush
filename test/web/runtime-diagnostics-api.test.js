import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, env, fixture } from '../helpers.js';
import { RPCServer } from '../../src/rpc/server.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { createSignal } from '../../src/signal.js';
import { writeLauncherState } from '../../src/host/registry.js';
import { startTestWeb, fetch, rawFetch } from './auth-fixture.js';
import { emptyDiagnostics } from '../../src/core/runtime-diagnostics.js';

test('real dual-project socket RPC/Host/HTTP aggregates Pi and Codex without starting an offline registered project', async () => {
  const a = fixture(), b = fixture(), root = temp(), offline = temp();
  const environment = env({ LUSH_GLOBAL_CONFIG: root });
  for (const f of [a, b]) writeLauncherState(f.config.project, environment);
  writeLauncherState(offline, environment);
  const stamp = new Date().toISOString();
  for (const [f, input, cost] of [[a, 60, { total: 0.6 }], [b, 40, undefined]]) {
    fs.mkdirSync(path.join(f.config.home, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(f.config.home, 'sessions', 'x_lush-task-2.jsonl'), JSON.stringify({ type: 'message', timestamp: stamp,
      message: { role: 'assistant', provider: cost ? 'pi' : 'codex', usage: { input, output: 10, cost } } }) + '\n');
  }
  const servers = [a, b].map(f => new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})));
  let web;
  try {
    await Promise.all(servers.map(server => server.start()));
    web = startTestWeb(null, 0, { env: environment,
      openProject: async () => { throw new Error('must not start'); }, attachProject: async () => { throw new Error('must not attach'); } });
    const response = await fetch(`http://127.0.0.1:${web.port}/api/host/diagnostics`);
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.coverage).toEqual({ projects_total: 3, projects_online: 2, projects_reporting: 2, complete: false });
    expect(body.windows[0]).toMatchObject({ input: 100, output: 20, cost: 0.6, requests: 2, unknown_tokens: 1, unknown_cost: 2, complete: false });
    expect(fs.existsSync(path.join(offline, '.lush'))).toBe(false);
  } finally {
    if (web) await web.stop(true);
    await Promise.all(servers.map(server => server.close()));
    for (const f of [a, b]) { fs.rmSync(f.config.socket, { force: true }); await f.close(); }
    for (const p of [root, offline]) fs.rmSync(p, { recursive: true, force: true });
  }
});

test('Host diagnostics HTTP is login/origin protected, root-only, no-store and rejects all query/token/path parameters', async () => {
  const root = temp(); let calls = 0;
  const projectHost = { launcher: true, diagnostics: async () => { calls++; return emptyDiagnostics(Date.now()); }, hasRoute: () => true,
    openRoute: async () => { throw new Error('must not attach'); }, status: async () => ({ projects: [] }), projects: async () => [] };
  const web = startTestWeb(null, 0, { env: env({ LUSH_GLOBAL_CONFIG: root }), projectHost });
  const url = `http://127.0.0.1:${web.port}/api/host/diagnostics`;
  try {
    expect((await rawFetch(url)).status).toBe(401); expect(calls).toBe(0);
    const response = await fetch(url); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).version).toBe(1); expect(calls).toBe(1);
    for (const suffix of ['?_token=x','?token=x','?project=/tmp','?seconds=60','?path=/tmp']) expect((await fetch(url + suffix)).status).toBe(400);
    expect((await fetch(url, { headers: { Origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await fetch(url, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect((await fetch(url, { method: 'POST' })).status).toBe(404);
    const prefixed = await fetch(url.replace('/api/', `/p/${'a'.repeat(16)}/api/`)); expect(prefixed.status).toBe(404);
    expect(calls).toBe(1);
  } finally { await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});
