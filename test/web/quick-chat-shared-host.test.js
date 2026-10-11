import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { QuickChatService } from '../../src/host/quick-chat.js';
import { temp, env } from '../helpers.js';
import { startTestWeb, fetch } from './auth-fixture.js';

const finish = service => Promise.all([...service.running.values()].map(entry => entry.promise));
const action = (origin, method, params) => fetch(origin + '/api/host/quick-chat/action', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });

test('launcher and bound Hosts share global C history while independent project daemons stay offline', async () => {
  const root = temp(), environment = env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }), calls = [], requests = [];
  const a = new QuickChatService(environment, { fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body)); return Response.json({ choices: [{ message: { content: '全局笔记 A' } }] }); } });
  const b = new QuickChatService(environment, { fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body)); return Response.json({ choices: [{ message: { content: '全局笔记 B' } }] }); } });
  let hostA, hostB;
  try {
    const source = a.settings.getManager().save({ label: 'Shared test source', provider: 'openai-compatible', auth_type: 'api_key',
      endpoint: 'https://model.invalid/v1', models: ['physical-model'] }, { api_key: 'isolated-shared-host-secret' });
    a.settings.explanation.save({ connection_id: source.id, model: 'physical-model', prompt: '整理文字为速记' });
    const project = path.join(root, 'offline-project'); fs.mkdirSync(project);
    const projectHost = { launcher: true,
      async require() { calls.push('require'); throw new Error('offline'); },
      async openRoute() { calls.push('openRoute'); throw new Error('offline'); } };
    hostA = startTestWeb(null, 0, { env: environment, projectHost, quickChatService: a });
    hostB = startTestWeb({ project, home: path.join(project, '.lush'), env: environment }, 0,
      { env: environment, projectHost: { ...projectHost, launcher: false }, quickChatService: b });
    const ua = `http://127.0.0.1:${hostA.port}`, ub = `http://127.0.0.1:${hostB.port}`;
    const config = await (await fetch(ua + '/api/host/quick-chat/config')).json();
    const saved = await action(ua, 'prompt_save', { prompt: { name: '速记', prompt: '列出要点', context_menu: false }, expected_revision: config.revision });
    expect(saved.status).toBe(200); const library = await saved.json(), prompt = library.prompts[1];
    expect((await (await fetch(ub + '/api/host/quick-chat/config')).json()).prompts).toEqual(library.prompts);
    const first = await action(ub, 'start', { prompt_id: prompt.id, content: '第一段材料' });
    expect(first.status).toBe(200); const c1 = await first.json(); await finish(b);
    expect(c1.number).toBe('C1');
    const readA = await (await fetch(ua + `/api/host/quick-chat/${c1.id}`)).json();
    expect(readA.turns[0].result).toBe('全局笔记 B');
    expect((await action(ua, 'send', { id: c1.id, content: '精简成三条' })).status).toBe(200); await finish(a);
    expect((await (await fetch(ub + `/api/host/quick-chat/${c1.id}`)).json()).turns).toHaveLength(2);
    expect((await action(ub, 'delete', { id: c1.id })).status).toBe(200);
    const second = await action(ua, 'start', { prompt_id: 'explain', content: '新的材料' });
    expect(second.status).toBe(200); expect((await second.json()).number).toBe('C2'); await finish(a);
    const history = await (await fetch(ub + '/api/host/quick-chat/history?limit=1')).json();
    expect(history.conversations.map(row => row.number)).toEqual(['C2']);
    expect(calls).toEqual([]); expect(requests).toHaveLength(3);
    expect(requests.every(row => row.tools === undefined && row.model === 'physical-model')).toBe(true);
    expect(JSON.stringify(history)).not.toContain('isolated-shared-host-secret');
    expect(fs.readdirSync(path.join(project, '.lush'))).toEqual(['web.json']);
    await hostA.stop(true); hostA = null;
    expect((await fetch(ub + '/api/host/quick-chat/config')).status).toBe(200);
  } finally {
    await Promise.allSettled([hostA?.stop(true), hostB?.stop(true)]);
    await Promise.allSettled([a.close(), b.close()]); fs.rmSync(root, { recursive: true, force: true });
  }
});
