import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fetch, setup } from './harness.js';
import { assertAllowed } from '../../src/rpc/registry.js';

test('usage API is project-bound, read-only, authenticated and validates query parameters', async () => {
  const f = await setup({ auth: { username: 'usage-test', password: 'test-statistics-password' } });
  try {
    const dir = path.join(f.config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'historical_lush-task-9999.jsonl');
    const source = JSON.stringify({ type: 'message', timestamp: '2026-01-02T00:00:00Z', message: {
      role: 'assistant', provider: 'test', model: 'model', usage: { input: 20, output: 10, cost: { total: 0.125 } },
    } }) + '\n';
    fs.writeFileSync(file, source);
    expect((await fetch(f.url + '/api/usage')).status).toBe(401);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=usage-test&password=test-statistics-password' });
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
    const response = await fetch(f.url + '/api/usage?start=2026-01-01T00:00:00Z&end=2026-01-03T00:00:00Z&interval=day', { headers });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBe(f.root); expect(data.totals).toMatchObject({ tokens: 30, cost: 0.125 });
    expect(data.buckets.length).toBe(2); expect(data.estimated).toBe(true);
    expect((await fetch(f.url + '/api/usage?start=invalid', { headers })).status).toBe(400);
    expect((await fetch(f.url + '/api/usage?interval=year', { headers })).status).toBe(400);
    expect((await fetch(f.url + '/api/usage', { method: 'POST', headers })).status).toBe(404);
    const page = await (await fetch(f.url + '/', { headers })).text();
    expect(page).toContain('id="statistics-open"');
    expect((await fetch(f.url + '/render-statistics.js', { headers })).status).toBe(200);
    expect((await fetch(f.url + '/styles-statistics.css', { headers })).status).toBe(200);
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
    expect(() => assertAllowed('system.usage', {}, { id: 1 })).toThrow('requires user approval');
    expect(() => assertAllowed('system.usage', { project: '/another' }, null)).toThrow('unknown parameter');
  } finally { await f.close(); }
});
