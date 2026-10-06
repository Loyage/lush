import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { temp, env } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { install } from '../project/agent-connection-fixture.js';

const config = { version: 1, connection_id: null, model: '', prompt: '说明含义', default_prompt: '说明含义', ready: false, reason: '请选择来源' };
const row = { id: 7, status: 'completed', quote: '选中文字', location: { view: 'docs' }, result: '解释结果', error: null,
  model: 'demo', source: null, prompt: '说明含义', created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' };
const history = { explanations: [{ id: 7, status: 'completed', quote: row.quote }], has_more: false, next: 7 };
const methods = Object.keys(PARAMS).filter(method => method.startsWith('quick_explain.'));
function mocks(project) {
  const calls = [];
  for (const [target, result] of [['quickExplanationConfig',config],['configureQuickExplanation',config],
    ['startQuickExplanation',row],['quickExplanation',row],['quickExplanations',history]]) {
    project[target] = (...args) => { calls.push({ target, args }); return result; };
  }
  return calls;
}
const post = (url, method, params, headers = {}) => fetch(url + '/api/action', { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method, params }) });

test('quick explanation RPC is narrow, user-only and rejects historical aliases', async () => {
  expect(methods).toHaveLength(5);
  for (const method of methods) {
    expect(USER_ONLY.has(method)).toBe(true);
    expect(() => assertAllowed(method, {}, 42)).toThrow('requires user approval');
    expect(() => assertAllowed(method, { extra: true }, null)).toThrow('unknown parameter');
  }
  for (const method of ['intro.start','intro.config','intro.configure','intro.get','intro.list','explanation.start'])
    expect(() => assertAllowed(method, {}, null)).toThrow('unknown method');
  const p = { actor: () => null }; const calls = mocks(p), dispatcher = new Dispatcher(p);
  for (const params of [{ limit: 0 }, { limit: 51 }, { limit: '30' }, { limit: 1.5 }, { before: 0 }, { before: -1 }, { before: '7' }])
    await expect(dispatcher.dispatch('quick_explain.list', params)).rejects.toThrow();
  expect(calls).toEqual([]);
  expect(await dispatcher.dispatch('quick_explain.list')).toEqual(history);
  expect(calls).toEqual([{ target: 'quickExplanations', args: [null,30] }]);
});

test('quick explanation HTTP forwards exact inputs, provides no-store reads and excludes legacy routes', async () => {
  const f = await setup(), calls = mocks(f.project);
  try {
    for (const [route, expected] of [['/api/quick-explain/config',config],['/api/quick-explain/history?before=9&limit=2',history],['/api/quick-explain/7',row]]) {
      const response = await fetch(f.url + route);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual(expected);
    }
    const patch = { connection_id: 'source-id', model: 'vendor/model', prompt: '新 prompt' }, location = { view: 'docs', path: 'readme' };
    expect((await post(f.url,'quick_explain.configure',{ config: patch })).status).toBe(200);
    expect((await post(f.url,'quick_explain.start',{ quote: row.quote, location })).status).toBe(200);
    expect(calls).toEqual([
      { target: 'quickExplanationConfig', args: [] }, { target: 'quickExplanations', args: [9,2] },
      { target: 'quickExplanation', args: [7] }, { target: 'configureQuickExplanation', args: [patch] },
      { target: 'startQuickExplanation', args: [row.quote,location] },
    ]);
    for (const route of ['/api/intro/config','/api/intro/7','/api/explanation/7','/api/quick-explain/0','/api/quick-explain/start'])
      expect((await fetch(f.url + route)).status).toBe(404);
    for (const route of ['/api/quick-explain/config?_token=x','/api/quick-explain/7?id=8',
      '/api/quick-explain/history?before=','/api/quick-explain/history?limit=51','/api/quick-explain/history?limit=2&limit=3',
      '/api/quick-explain/history?extra=true','/api/quick-explain/history?_token=x'])
      expect((await fetch(f.url + route)).status).toBe(400);
    for (const method of ['quick_explain.get','quick_explain.list','quick_explain.config','intro.start','explanation.start'])
      expect((await post(f.url,method,{})).status).toBe(400);
    expect(calls).toHaveLength(5);
  } finally { await f.close(); }
});

test('HTTP to RPC to real backend persists source, Prompt and result without creating a Worker', async () => {
  const f = await setup(); install(f);
  const requests = [];
  f.project.quickExplanationOptions = { fetch: async (target, request) => {
    requests.push({ target, body: JSON.parse(request.body) });
    return Response.json({ choices: [{ message: { content: '只读解释结果' } }] });
  } };
  try {
    const counts = () => [f.store.get('SELECT COUNT(*) AS n FROM tasks').n, f.store.get('SELECT COUNT(*) AS n FROM inputs').n];
    const before = counts();
    const configured = await post(f.url,'quick_explain.configure',{ config:{ connection_id:'conn-one',model:'physical-model',prompt:'解释目的与含义' } });
    expect(configured.status).toBe(200); expect((await configured.json()).ready).toBe(true);
    expect(requests).toHaveLength(0);
    const started = await post(f.url,'quick_explain.start',{ quote:'消息原文',location:{ view:'docs',path:'readme' } });
    expect(started.status).toBe(200); const created = await started.json();
    await Promise.all([...f.project.introRunning.values()].map(entry => entry.promise));
    const result = await (await fetch(f.url + `/api/quick-explain/${created.id}`)).json();
    expect(result).toMatchObject({ quote:'消息原文',status:'completed',result:'只读解释结果',prompt:'解释目的与含义',model:'physical-model',source:{ connection_id:'conn-one' } });
    expect(JSON.stringify(result)).not.toContain('test-secret');
    const page = await (await fetch(f.url + '/api/quick-explain/history?limit=1')).json();
    expect(page.explanations).toHaveLength(1); expect(page.explanations[0].result).toBeUndefined();
    expect(requests).toHaveLength(1); expect(requests[0].target).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(JSON.parse(requests[0].body.messages[1].content)).toEqual({ selected_text:'消息原文',page_location:{ view:'docs',path:'readme' } });
    expect(counts()).toEqual(before);
  } finally { await f.close(); }
});

test('quick explanation HTTP requires login, same origin, JSON and rejects tokens before any call', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'explanation-password' } }), calls = mocks(f.project);
  try {
    for (const route of ['/api/quick-explain/config','/api/quick-explain/history','/api/quick-explain/7'])
      expect((await fetch(f.url + route)).status).toBe(401);
    expect((await post(f.url,'quick_explain.start',{ quote: 'text' })).status).toBe(401);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=explanation-password' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    for (const method of ['quick_explain.start','quick_explain.configure']) {
      expect((await post(f.url,method,{ _token: 'agent' },{ Cookie })).status).toBe(400);
      expect((await post(f.url,method,{ extra: true },{ Cookie })).status).toBe(400);
      expect((await post(f.url,method,{}, { Cookie, Origin: 'https://evil.invalid' })).status).toBe(403);
    }
    expect((await fetch(f.url + '/api/action',{ method:'POST', headers:{ Cookie }, body:JSON.stringify({ method:'quick_explain.start',params:{ quote:'text' } }) })).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await fetch(f.url + '/api/quick-explain/history',{ headers:{ Cookie } })).status).toBe(200);
    expect((await post(f.url,'quick_explain.start',{ quote:'text' },{ Cookie,Origin:f.url })).status).toBe(200);
    expect(calls).toHaveLength(2);
  } finally { await f.close(); }
});

test('global quick explanation reads and writes use explicit project identity', async () => {
  const a = temp(), b = temp(), home = temp(), calls = [];
  const web = startWeb(null,0,{ env:env({ LUSH_GLOBAL_CONFIG:home }), async openProject(project) {
    return { config:{ project,home:path.join(project,'.lush') }, client:{ async request(method,params={}) {
      calls.push({ project,method,params }); return { project };
    } } };
  } });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    for (const project of [a,b]) expect((await fetch(url + '/api/host/select',{ method:'POST',headers:{ 'Content-Type':'application/json' },body:JSON.stringify({ project }) })).status).toBe(200);
    calls.length = 0;
    const pa = url + `/p/${projectRouteId(a)}`, pb = url + `/p/${projectRouteId(b)}`;
    expect((await fetch(pa + '/api/quick-explain/config')).status).toBe(200);
    expect((await fetch(pb + '/api/quick-explain/7')).status).toBe(200);
    expect((await fetch(pa + '/api/quick-explain/history?limit=1')).status).toBe(200);
    expect((await post(pb,'quick_explain.start',{ quote:'text',location:{ view:'docs' } })).status).toBe(200);
    expect(calls).toEqual([
      { project:a,method:'quick_explain.config',params:{} }, { project:b,method:'quick_explain.get',params:{ id:7 } },
      { project:a,method:'quick_explain.list',params:{ limit:1 } }, { project:b,method:'quick_explain.start',params:{ quote:'text',location:{ view:'docs' } } },
    ]);
    expect((await fetch(url + '/api/quick-explain/history')).status).toBe(400);
    expect((await post(url,'quick_explain.start',{ quote:'text' })).status).toBe(400);
    expect((await fetch(url + `/p/${'0'.repeat(16)}/api/quick-explain/7`)).status).toBe(400);
    expect(calls).toHaveLength(4);
  } finally { web.stop(true); for (const dir of [a,b,home]) fs.rmSync(dir,{ recursive:true,force:true }); }
});
