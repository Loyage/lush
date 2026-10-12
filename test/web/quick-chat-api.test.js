import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { startTestWeb, fetch } from './auth-fixture.js';
import { temp, env } from '../helpers.js';

test('all chat, Prompt and model routes are unreachable, authenticated, and never attach a daemon', async () => {
  for (const bound of [false, true]) {
    const root = temp(), environment = env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') });
    const project = path.join(root, 'project'); fs.mkdirSync(project);
    let attaches = 0;
    const projectHost = { launcher: !bound, async require() { attaches++; throw new Error('must not attach'); },
      async openRoute() { attaches++; throw new Error('must not attach'); } };
    const web = startTestWeb(bound ? { project, home: path.join(project, '.lush'), env: environment } : null, 0, { env: environment, projectHost });
    const origin = `http://127.0.0.1:${web.port}`;
    // Bound authentication provisions web.json; requests must create no chat resources.
    const before = fs.existsSync(path.join(project, '.lush')) ? fs.readdirSync(path.join(project, '.lush')) : null;
    try {
      for (const prefix of ['', '/p/1111111111111111', '/p/ffffffffffffffff']) {
        for (const route of ['/api/quick-chat', '/api/quick-chat/config', '/api/quick-chat/history', '/api/quick-chat/1',
          '/api/quick-chat/action', '/api/host/quick-chat/config', '/api/host/settings/quick-explain/config', '/api/quick-explain/config']) {
          for (const method of ['GET', 'POST']) {
            const url = origin + prefix + route;
            const options = { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ method: 'start', params: { prompt_id: 'explain', content: 'must never call a model' } }) } : {}) };
            const response = await fetch(url, options);
            expect(response.status).toBe(404); expect(response.headers.get('cache-control')).toBe('no-store');
            expect((await fetch(url, { ...options, anonymous: true })).status).toBe(401);
            expect((await fetch(url, { ...options, headers: { ...options.headers, Origin: 'https://evil.invalid' } })).status).toBe(403);
          }
        }
      }
      expect(attaches).toBe(0);
      expect(fs.existsSync(path.join(project, '.lush')) ? fs.readdirSync(path.join(project, '.lush')) : null).toEqual(before);
      expect(fs.existsSync(path.join(root, 'device', 'shared'))).toBe(false);
    } finally { await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
  }
});
