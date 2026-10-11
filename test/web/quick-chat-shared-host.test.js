import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { QuickChatService } from '../../src/host/quick-chat.js';
import { projectRouteId, writeLauncherState } from '../../src/host/registry.js';
import { temp, env } from '../helpers.js';
import { startTestWeb, fetch } from './auth-fixture.js';

const finish = service => Promise.all([...service.running.values()].map(entry => entry.promise));
const action = (url, method, params) => fetch(url + '/action', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });

test('Hosts share the same project history while another project has independent C numbers and Prompts, without attaching daemons', async () => {
  const root = temp(), environment = env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }), calls = [], requests = [];
  const projects = ['a', 'b'].map(name => { const p = path.join(root, name); fs.mkdirSync(p); writeLauncherState(p, environment); return p; });
  const homes = projects.map(p => path.join(p, '.lush', 'quick-chat'));
  const services = [homes[0], homes[0], homes[1]].map(home => new QuickChatService(environment, { home, fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body)); return Response.json({ choices: [{ message: { content: '项目笔记' } }] }); } }));
  const [a, b, c] = services, hosts = [];
  const attachProject = async () => { calls.push('attach'); throw new Error('offline'); };
  try {
    const source = a.settings.getManager().save({ label: 'Shared test source', provider: 'openai-compatible', auth_type: 'api_key',
      endpoint: 'https://model.invalid/v1', models: ['physical-model'] }, { api_key: 'isolated-shared-host-secret' });
    a.settings.explanation.save({ connection_id: source.id, model: 'physical-model', prompt: '整理文字为速记' });
    hosts.push(startTestWeb(null, 0, { env: environment, attachProject, quickChatService: a }));
    hosts.push(startTestWeb({ project: projects[0], home: path.join(projects[0], '.lush'), env: environment }, 0,
      { env: environment, attachProject, quickChatService: b }));
    hosts.push(startTestWeb(null, 0, { env: environment, attachProject, quickChatService: c }));
    const [ua, ub, uc] = hosts.map((host, i) => `http://127.0.0.1:${host.port}${i === 1 ? '' : `/p/${projectRouteId(projects[i === 2 ? 1 : 0])}`}/api/quick-chat`);
    const config = await (await fetch(ua + '/config')).json();
    const saved = await action(ua, 'prompt_save', { prompt: { name: '速记', prompt: '列出要点', context_menu: false }, expected_revision: config.revision });
    expect(saved.status).toBe(200); const library = await saved.json(), prompt = library.prompts[1];
    expect((await (await fetch(ub + '/config')).json()).prompts).toEqual(library.prompts);
    expect((await (await fetch(uc + '/config')).json()).prompts).toHaveLength(1);
    const first = await action(ub, 'start', { prompt_id: prompt.id, content: '第一段材料' });
    expect(first.status).toBe(200); const c1 = await first.json(); await finish(b);
    expect(c1.number).toBe('C1');
    expect((await (await fetch(ua + `/${c1.id}`)).json()).turns[0].result).toBe('项目笔记');
    expect((await fetch(uc + `/${c1.id}`)).status).toBe(400);
    expect((await action(ua, 'send', { id: c1.id, content: '精简成三条' })).status).toBe(200); await finish(a);
    expect((await (await fetch(ub + `/${c1.id}`)).json()).turns).toHaveLength(2);
    expect((await action(ub, 'delete', { id: c1.id })).status).toBe(200);
    const second = await action(ua, 'start', { prompt_id: 'explain', content: '新的材料' });
    expect(second.status).toBe(200); expect((await second.json()).number).toBe('C2'); await finish(a);
    const other = await action(uc, 'start', { prompt_id: 'explain', content: '另一项目材料' });
    expect(other.status).toBe(200); expect((await other.json()).number).toBe('C1'); await finish(c);
    const history = await (await fetch(ub + '/history?limit=1')).json();
    expect(history.conversations.map(row => row.number)).toEqual(['C2']);
    expect(calls).toEqual([]); expect(requests).toHaveLength(4);
    expect(requests.every(row => row.tools === undefined && row.model === 'physical-model')).toBe(true);
    expect(JSON.stringify(history)).not.toContain('isolated-shared-host-secret');
    expect(fs.existsSync(path.join(a.settings.config.home, 'quick-chat.sqlite'))).toBe(false);
    await hosts[0].stop(true);
    expect((await fetch(ub + '/config')).status).toBe(200);
  } finally {
    await Promise.allSettled(hosts.map(host => host.stop(true)));
    await Promise.allSettled(services.map(service => service.close())); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one real lazy Host isolates two offline projects, rejects removed identities and unsafe project storage', async () => {
  const root = temp(), environment = env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }), calls = [];
  const projects = ['a', 'b'].map(name => { const p = path.join(root, name); fs.mkdirSync(p); writeLauncherState(p, environment); return p; });
  const web = startTestWeb(null, 0, { env: environment, attachProject: async () => { calls.push('attach'); throw new Error('offline'); } });
  const origin = `http://127.0.0.1:${web.port}`, urls = projects.map(p => origin + `/p/${projectRouteId(p)}/api/quick-chat`);
  try {
    const ca = await (await fetch(urls[0] + '/config')).json();
    expect((await action(urls[0], 'prompt_save', { prompt: { name: '只属于 A', prompt: '总结', context_menu: true }, expected_revision: ca.revision })).status).toBe(200);
    expect((await (await fetch(urls[0] + '/config')).json()).prompts).toHaveLength(2);
    expect((await (await fetch(urls[1] + '/config')).json()).prompts).toHaveLength(1);
    expect((await fetch(origin + '/api/quick-chat/config')).status).toBe(400);
    expect((await fetch(origin + '/p/ffffffffffffffff/api/quick-chat/config')).status).toBe(400);
    expect((await fetch(origin + '/api/host/quick-chat/config')).status).toBe(404);
    const remove = await fetch(origin + '/api/host/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: projectRouteId(projects[0]) }) });
    expect(remove.status).toBe(200); expect((await fetch(urls[0] + '/config')).status).toBe(400);
    fs.mkdirSync(path.join(projects[1], '.lush'));
    fs.symlinkSync(path.join(projects[0], '.lush', 'quick-chat'), path.join(projects[1], '.lush', 'quick-chat'));
    expect((await fetch(urls[1] + '/config')).status).toBe(400);
    expect(calls).toEqual([]);
  } finally { await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});
