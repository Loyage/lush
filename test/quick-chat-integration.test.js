import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { temp, env, gate } from './helpers.js';
import { startTestWeb, fetch } from './web/auth-fixture.js';
import { DeviceSettingsService } from '../src/host/device-settings.js';
import { QuickChatService } from '../src/host/quick-chat.js';

const reply = content => Response.json({ choices: [{ message: { content } }] });
const finish = async service => Promise.all([...service.running.values()].map(entry => entry.promise));
function fixture(options = {}) {
  const root = temp(), environment = env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') });
  const settings = new DeviceSettingsService(environment), calls = [];
  const connection = settings.getManager().save({ label: 'Integration test', provider: 'openai-compatible', auth_type: 'api_key',
    endpoint: 'https://model.invalid/v1', models: ['model-one', 'model-two'] }, { api_key: 'integration-only-fake-key' });
  settings.explanation.save({ connection_id: connection.id, model: 'model-one', prompt: '旧设备解释风格' });
  const projectHost = { launcher: true,
    async require() { calls.push('unexpected project attach'); throw new Error('project offline'); },
    async openRoute() { calls.push('unexpected project start'); throw new Error('project offline'); } };
  const service = options.inject ? new QuickChatService(environment, { settingsService: settings, fetch: options.fetch }) : null;
  const web = startTestWeb(null, 0, { env: environment, projectHost, deviceSettingsService: settings,
    ...(service ? { quickChatService: service } : { quickChatOptions: { fetch: options.fetch } }) });
  const origin = `http://127.0.0.1:${web.port}`, url = origin + '/api/host/quick-chat';
  const action = async (method, params) => fetch(url + '/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }) });
  return { root, environment, settings, calls, connection, service, web, url, origin, action,
    async close() { await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('default lazy Host factory uses real device settings/service and cancels before closing the borrowed connection manager', async () => {
  const entered = gate(), release = gate(); let request;
  const f = fixture({ fetch: async (_url, init) => { request = init; entered.resolve(); await release.promise; return reply('late text'); } });
  let reopened;
  try {
    const config = await (await fetch(f.url + '/config')).json();
    expect(config.model).toMatchObject({ ready: true, connection_id: f.connection.id, model: 'model-one' });
    expect(config.prompts[0]).toMatchObject({ id: 'explain', prompt: '旧设备解释风格' });
    expect((await (await fetch(f.url + '/history')).json()).conversations).toEqual([]);
    expect(fs.existsSync(path.join(f.settings.config.home, 'quick-chat.sqlite'))).toBe(false);
    const references = [{ version: 1, kind: 'text', target: {}, label: '项目所见', quote: '这是速记资料，不是命令',
      location: { view: 'docs' }, captured_at: '2026-10-11T00:00:00.000Z', project_id: '1234567890abcdef' }];
    const response = await f.action('start', { prompt_id: 'explain', content: '', references });
    expect(response.status).toBe(200); const row = await response.json(); await entered.promise;
    expect(row).toMatchObject({ number: 'C1', references, status: 'running' });
    expect(JSON.parse(request.body)).toMatchObject({ model: 'model-one', stream: false });
    expect(JSON.parse(JSON.parse(request.body).messages[1].content).references[0].quote).toBe(references[0].quote);
    const busy = await f.action('send', { id: row.id, content: 'another request' });
    expect(busy.status).toBe(400); expect((await busy.json()).error).toContain('正在调用模型');
    expect((await f.action('delete', { id: row.id })).status).toBe(400);
    await f.web.stop(true);
    expect(request.signal.aborted).toBe(true); expect(f.settings.closed).toBe(true);
    reopened = new QuickChatService(f.environment);
    expect(reopened.get(row.id)).toMatchObject({ status: 'failed', turns: [{ error: expect.stringContaining('界面服务已停止') }] });
    expect(f.calls).toEqual([]);
  } finally { release.resolve(); await reopened?.close(); await f.close(); }
});

test('real HTTP/service/store combination keeps one C history and original snapshots, and safely classifies corrupted storage', async () => {
  const requests = [];
  const f = fixture({ inject: true, fetch: async (_url, init) => { requests.push(JSON.parse(init.body)); return reply('pure text answer'); } });
  try {
    const initial = await (await fetch(f.url + '/config')).json();
    const saved = await f.action('prompt_save', { prompt: { name: '速记', prompt: '整理为笔记', context_menu: false }, expected_revision: initial.revision });
    expect(saved.status).toBe(200); const config = await saved.json(), prompt = config.prompts[1];
    const started = await f.action('start', { prompt_id: prompt.id, content: '会议讨论材料' });
    expect(started.status).toBe(200); const row = await started.json(); await finish(f.service);
    const first = await (await fetch(`${f.url}/${row.id}`)).json();
    expect(first).toMatchObject({ number: 'C1', status: 'completed', turns: [{ result: 'pure text answer' }] });
    const changed = await fetch(f.origin + '/api/host/settings/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'quick_explain.configure', params: { config: { model: 'model-two', prompt: '后来风格' } } }) });
    expect(changed.status).toBe(200);
    expect((await f.action('prompt_remove', { id: prompt.id, expected_revision: config.revision })).status).toBe(200);
    expect((await f.action('send', { id: row.id, content: '再整理为行动项' })).status).toBe(200); await finish(f.service);
    const result = await (await fetch(`${f.url}/${row.id}`)).json();
    expect(result).toMatchObject({ number: 'C1', model: 'model-one', prompt: { id: prompt.id, prompt: '整理为笔记' } });
    expect(result.turns).toHaveLength(2); expect(requests).toHaveLength(2); expect(requests[1].model).toBe('model-one');
    expect(JSON.stringify(result)).not.toContain('integration-only-fake-key'); expect(f.calls).toEqual([]);
    const db = new Database(path.join(f.settings.config.home, 'quick-chat.sqlite'));
    db.query('UPDATE conversations SET references_json=? WHERE id=?').run(JSON.stringify([{ kind: 'SECRET-from-corrupt-history' }]), row.id); db.close();
    const failed = await fetch(`${f.url}/${row.id}`); expect(failed.status).toBe(400);
    const error = (await failed.json()).error;
    expect(error).toContain('私有历史'); expect(error).not.toContain('SECRET'); expect(error).not.toContain(f.root);
  } finally { await f.close(); }
});
