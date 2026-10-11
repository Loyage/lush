import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { startTestWeb as startWeb, fetch } from './auth-fixture.js';
import { env, temp } from '../helpers.js';
import { LushError } from '../../src/core/types.js';

const post = (url, body, headers = {}) => fetch(url, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
function fixture({ bound = false, failing = false } = {}) {
  const root = temp(), calls = [];
  const environment = env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') });
  const row = { id: 1, number: 'C1', status: 'completed', content: '整理笔记', references: [],
    prompt: { id: 'explain', name: '快速解释', prompt: '解释资料' }, source: null, model: 'test', turns: [] };
  const service = {
    config() { calls.push(['config']); if (failing) throw new Error('PRIVATE-KEY-UPSTREAM'); return { version: 1, revision: 'r1', prompts: [], model: { ready: false } }; },
    list(query) { calls.push(['list', query]); return { conversations: [row], has_more: false, next: 1 }; },
    get(id) { calls.push(['get', id]); return row; },
    action(method, params) { calls.push(['action', method, params]); if (failing) throw new Error('PRIVATE-RAW-RESPONSE'); return row; },
    close() { calls.push(['close']); },
  };
  const projectHost = { launcher: !bound,
    async require() { calls.push(['unexpected.project']); throw new Error('project offline'); },
    async openRoute() { calls.push(['unexpected.attach']); throw new Error('project offline'); } };
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const config = bound ? { project, home: path.join(project, '.lush'), env: environment } : null;
  const web = startWeb(config, 0, { env: environment, projectHost, quickChatService: service });
  const url = `http://127.0.0.1:${web.port}/api/host/quick-chat`;
  return { calls, row, service, url, root, web,
    async close() { await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('quick chat root HTTP is global in launcher and bound Hosts, with exact inputs and no project attachment', async () => {
  for (const bound of [false, true]) {
    const f = fixture({ bound });
    try {
      const config = await fetch(f.url + '/config');
      expect(config.status).toBe(200); expect(config.headers.get('cache-control')).toBe('no-store');
      expect(config.headers.get('x-content-type-options')).toBe('nosniff');
      expect((await config.json()).revision).toBe('r1');
      expect((await fetch(f.url + '/history?before=5&limit=2')).status).toBe(200);
      expect((await (await fetch(f.url + '/1')).json()).number).toBe('C1');
      const reference = { version: 1, kind: 'text', target: {}, label: '引用文字', quote: '快照', location: { view: 'docs' }, captured_at: '2026-10-11T00:00:00Z' };
      const actions = [
        ['prompt_save', { prompt: { name: '总结', prompt: '总结所给文字', context_menu: false }, expected_revision: 'r1' }],
        ['prompt_remove', { id: 'custom-id', expected_revision: 'r2' }],
        ['start', { prompt_id: 'explain', content: '', references: [reference] }],
        ['send', { id: 1, content: '换成要点' }], ['delete', { id: 1 }],
      ];
      for (const [method, params] of actions) {
        const response = await post(f.url + '/action', { method, params });
        expect(response.status).toBe(200); expect(await response.json()).toEqual(f.row);
      }
      expect(f.calls).toEqual([['config'], ['list', { before: 5, limit: 2 }], ['get', 1], ...actions.map(([method, params]) => ['action', method, params])]);
      expect(fs.existsSync(path.join(f.root, 'device', 'shared'))).toBe(false);
    } finally { await f.close(); }
  }
});

test('quick chat rejects unknown, duplicate and malformed read parameters before lazy service initialization', async () => {
  const f = fixture();
  try {
    for (const suffix of ['config?scope=device', 'config?_token=secret', '1?id=2', 'history?limit=2&limit=3',
      'history?limit=0', 'history?limit=51', 'history?limit=1e1', 'history?before=', 'history?before=-1',
      'history?before=9007199254740993', 'history?project=/tmp', '9007199254740993']) {
      expect((await fetch(f.url + '/' + suffix)).status).toBe(400);
    }
    for (const suffix of ['0', 'C1', 'unknown', '1/turns']) expect((await fetch(f.url + '/' + suffix)).status).toBe(404);
    const origin = new URL(f.url).origin;
    for (const suffix of ['config', 'history', '1', 'action']) {
      const target = origin + '/p/ffffffffffffffff/api/host/quick-chat/' + suffix;
      expect((await fetch(target)).status).toBe(404);
      expect((await post(target, { method: 'start', params: { prompt_id: 'explain', content: 'text' } })).status).toBe(404);
    }
    expect(f.calls).toEqual([]);
    await f.web.stop(true); expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test('quick chat action envelope cannot forward arbitrary RPC, paths, tokens or wrong params', async () => {
  const f = fixture();
  try {
    for (const body of [null, [], {}, { method: 'worker.spawn', params: {} }, { method: 'quick_explain.start', params: {} },
      { method: 'start', params: null }, { method: 'start', params: [] }, { method: 'start', params: {}, _token: '' },
      { method: 'start', params: { _token: '' } }, { method: 'start', params: { project: '/tmp' } },
      { method: 'send', params: { id: 1, prompt_id: 'explain' } }, { method: 'delete', params: { id: 1, confirm: true } }]) {
      expect((await post(f.url + '/action', body)).status).toBe(400);
    }
    expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test('all quick chat APIs require login, same Origin and JSON without mutation queries', async () => {
  const f = fixture();
  try {
    const body = { method: 'start', params: { prompt_id: 'explain', content: 'text' } };
    for (const suffix of ['config', 'history', '1']) {
      expect((await fetch(f.url + '/' + suffix, { anonymous: true })).status).toBe(401);
      expect((await fetch(f.url + '/' + suffix, { headers: { Origin: 'https://evil.invalid' } })).status).toBe(403);
    }
    expect((await fetch(f.url + '/action', { method: 'POST', anonymous: true,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(401);
    expect((await post(f.url + '/action', body, { Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await post(f.url + '/action?scope=device', body)).status).toBe(400);
    expect((await fetch(f.url + '/action', { method: 'POST', body: JSON.stringify(body) })).status).toBe(400);
    expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test('quick chat masks unknown dependency errors, but preserves classified safe validation failures', async () => {
  const f = fixture({ failing: true });
  try {
    for (const response of [await fetch(f.url + '/config'), await post(f.url + '/action', { method: 'send', params: { id: 1, content: 'text' } })]) {
      expect(response.status).toBe(400); const body = await response.json();
      expect(body.error).not.toContain('PRIVATE'); expect(body.error).toContain('未确认'); expect(body.error).toContain('不要自动重试');
    }
    f.service.get = () => { throw new LushError('对话不存在'); };
    expect((await (await fetch(f.url + '/1')).json()).error).toBe('对话不存在');
  } finally { await f.close(); }
});

test('Host stop closes an instantiated conversation service before its borrowed settings manager', async () => {
  const f = fixture();
  try {
    await fetch(f.url + '/config');
    await f.web.stop(true);
    expect(f.calls).toEqual([['config'], ['close']]);
  } finally { await f.close(); }
});
