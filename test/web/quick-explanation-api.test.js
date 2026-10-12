import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PARAMS, assertAllowed } from '../../src/rpc/registry.js';
import { startTestWeb, fetch } from './auth-fixture.js';
import { temp, env } from '../helpers.js';

const retired = ['quick_explain.config', 'quick_explain.configure', 'quick_explain.start', 'quick_explain.followup', 'quick_explain.get', 'quick_explain.list', 'quick_explain.delete',
  'intro.start', 'intro.get', 'intro.list', 'explanation.start', 'explanation.get', 'explanation.list'];

test('all dedicated explanation RPC including model configuration is gone', () => {
  expect(Object.keys(PARAMS).filter(method => method.startsWith('quick_explain.'))).toEqual([]);
  for (const method of retired) for (const actor of [null, 42]) expect(() => assertAllowed(method, {}, actor)).toThrow('unknown method');
});

test('retired explanation HTTP cannot reach an old daemon in bound or launcher mode', async () => {
  for (const bound of [false, true]) {
    const root = temp(), environment = env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }), calls = [];
    const project = path.join(root, 'project'); fs.mkdirSync(project);
    const projectHost = { launcher: !bound,
      async require() { calls.push('require'); throw new Error('must not attach'); },
      async openRoute() { calls.push('openRoute'); throw new Error('must not attach'); } };
    const web = startTestWeb(bound ? { project, home: path.join(project, '.lush'), env: environment } : null, 0, { env: environment, projectHost });
    const origin = `http://127.0.0.1:${web.port}`, base = origin + (bound ? '' : '/p/1111111111111111');
    try {
      for (const suffix of ['config', 'config?scope=device', 'history', 'history?before=9&limit=2', '7', '0', 'start', 'followup', 'delete']) {
        const response = await fetch(base + '/api/quick-explain/' + suffix);
        expect(response.status).toBe(404); expect(response.headers.get('cache-control')).toBe('no-store');
        expect((await fetch(base + '/api/quick-explain/' + suffix, { anonymous: true })).status).toBe(401);
      }
      for (const method of retired) {
        const response = await fetch(base + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params: {} }) });
        expect(response.status).toBe(400);
      }
      // Mutations currently perform read-only attachment before allowlist validation, but never forward old calls.
      expect(calls.every(call => ['require', 'openRoute'].includes(call))).toBe(true);
    } finally { await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
  }
});
