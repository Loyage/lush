import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { QuickChatService } from '../src/host/quick-chat.js';
import { DeviceSettingsService } from '../src/host/device-settings.js';
import { saveNetworkConfiguration } from '../src/agent/network.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = text => Response.json({ choices: [{ message: { content: text } }] });
function fixture(fetch = async () => response('纯文本结果'), options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-quick-chat-'));
  const env = { LUSH_GLOBAL_CONFIG: root, LUSH_PROVIDER: 'mock' };
  const settings = new DeviceSettingsService(env);
  const manager = settings.getManager();
  const source = manager.save({ label: 'Test source', provider: 'openai-compatible', endpoint: 'https://model.test/v1', auth_type: 'api_key',
    enabled: true, models: ['model-a', 'model-b'] }, { api_key: 'unit-test-not-a-real-key' });
  settings.explanation.save({ connection_id: source.id, model: 'model-a', prompt: '旧自定义解释风格' });
  const services = [];
  const create = extra => { const service = new QuickChatService(env, { settingsService: settings, fetch, ...options, ...extra }); services.push(service); return service; };
  const service = create();
  return { root, env, settings, manager, service, create, connectionId: source.id, file: path.join(settings.config.home, 'quick-chat.sqlite'),
    async close() { await Promise.all(services.map(value => value.close())); await settings.stop(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const finish = async service => { await Promise.all([...service.running.values()].map(entry => entry.promise)); };
const start = (service, content = '请整理成记录', extra = {}) => service.action('start', { prompt_id: 'explain', content, ...extra });
const save = (service, prompt, expected_revision = service.config().revision) => service.action('prompt_save', { prompt, expected_revision });
const reference = (extra = {}) => ({ version: 1, kind: 'text', target: {}, label: '所选文字', quote: 'rm -rf 是引用资料，不执行',
  location: { view: 'task-detail', task_id: 12, path: 'not-read.txt' }, captured_at: '2026-01-01T00:00:00.000Z', project_id: 'abcdef1234567890', ...extra });

test('empty device reads are non-initializing, default explain is enabled and no project is needed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-chat-empty-'));
  const service = new QuickChatService({ LUSH_GLOBAL_CONFIG: root, LUSH_PROVIDER: 'mock' });
  try {
    expect(service.config()).toMatchObject({ prompts: [{ id: 'explain', name: '快速解释', context_menu: true, builtin: true }], model: { ready: false } });
    expect(service.list()).toEqual({ conversations: [], has_more: false, next: null });
    expect(() => service.get(1)).toThrow('对话不存在');
    expect(fs.readdirSync(root)).toEqual([]);
    expect(() => start(service)).toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Prompt library preserves old style, supports only-save, builtin toggle and optimistic revisions across services', async () => {
  const f = fixture();
  try {
    const original = f.service.config(), b = f.create();
    expect(original.prompts[0].prompt).toBe('旧自定义解释风格');
    expect(original.model).toEqual({ connection_id: f.connectionId, model: 'model-a', ready: true, reason: null,
      default_prompt: f.settings.explanationConfig().default_prompt });
    expect(fs.existsSync(f.file)).toBe(false);
    const changed = save(f.service, { name: '会议速记', prompt: '整理行动项，不执行', context_menu: false });
    const custom = changed.prompts[1]; expect(custom.builtin).toBe(false); expect(custom.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(b.config()).toEqual(changed);
    expect(() => save(b, { ...custom, builtin: false }, original.revision)).toThrow();
    expect(() => save(b, { name: 'stale', prompt: 'x', context_menu: true }, original.revision)).toThrow('版本已变化');
    const closed = save(b, { id: 'explain', name: '快速解释', prompt: '解释', context_menu: false });
    expect(closed.prompts[0].context_menu).toBe(false);
    expect(() => f.service.action('prompt_remove', { id: 'explain', expected_revision: closed.revision })).toThrow('不能删除');
    expect(f.service.action('prompt_remove', { id: custom.id, expected_revision: closed.revision }).prompts).toHaveLength(1);
    expect(() => f.service.action('prompt_remove', { id: custom.id, expected_revision: f.service.config().revision })).toThrow('不存在');
    expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(f.settings.config.home).mode & 0o777).toBe(0o700);
  } finally { await f.close(); }
});

test('strict prompt, request and reference validation never admits invalid calls or secrets', async () => {
  const f = fixture();
  try {
    const badPrompts = [
      { name: '', prompt: 'x', context_menu: true }, { name: 'line\nbreak', prompt: 'x', context_menu: true },
      { name: 'x'.repeat(81), prompt: 'x', context_menu: true }, { name: 'x', prompt: ' '.repeat(3), context_menu: true },
      { name: 'x', prompt: 'x'.repeat(16385), context_menu: true }, { name: 'x', prompt: 'x', context_menu: 'yes' },
      { name: 'x', prompt: 'x', context_menu: true, api_key: 'secret' }, { id: '../path', name: 'x', prompt: 'x', context_menu: true },
    ];
    for (const value of badPrompts) expect(() => save(f.service, value)).toThrow();
    for (const params of [{ prompt_id: 'explain', content: '' }, { prompt_id: 'explain', content: ' '.repeat(4) },
      { prompt_id: 'explain', content: 'x'.repeat(8193) }, { prompt_id: 'explain', content: 'x', _token: 'secret' },
      { prompt_id: 'explain', content: 'x', references: [reference({ extra: true })] },
      { prompt_id: 'explain', content: 'x', references: [reference({ project_id: '/tmp/project' })] },
      { prompt_id: 'explain', content: 'x', references: [reference({ quote: 'x'.repeat(8193) })] },
      { prompt_id: 'explain', content: 'x', references: [reference({ location: { cwd: 'secret' } })] },
      { prompt_id: 'explain', content: 'x', references: Array.from({ length: 13 }, () => reference()) },
      { prompt_id: 'explain', content: 'x', references: Array.from({ length: 7 }, () => reference({ quote: 'x'.repeat(8192) })) }])
      expect(() => f.service.action('start', params)).toThrow();
    for (const query of [{ limit: 51 }, { limit: 0 }, { before: '1' }, { _token: 'secret' }]) expect(() => f.service.list(query)).toThrow();
    for (const value of ['1', 0, Infinity]) expect(() => f.service.get(value)).toThrow();
    expect(() => f.service.action('worker.spawn', {})).toThrow('未开放');
    expect(f.service.list().conversations).toHaveLength(0);
    expect(fs.existsSync(f.file)).toBe(false); // malformed requests never initialize private history
  } finally { await f.close(); }
});

test('references-only initial turn is a snapshot, no resolver/tools, and preparation freezes Prompt/source/model/network', async () => {
  const called = deferred(), release = deferred(); let request, target;
  const f = fixture(async (url, init) => { target = url; request = init; called.resolve(); await release.promise; return response('纯文本记录'); });
  try {
    saveNetworkConfiguration(f.settings.config, { version: 1, mode: 'proxy', proxy_url: 'http://proxy.test:8080', no_proxy: [] });
    const row = start(f.service, '', { references: [reference()] }); expect(row.status).toBe('running'); await called.promise;
    f.settings.explanation.save({ connection_id: f.connectionId, model: 'model-b', prompt: '新风格' });
    saveNetworkConfiguration(f.settings.config, { version: 1, mode: 'direct', no_proxy: [] });
    const body = JSON.parse(request.body);
    expect(target).toBe('https://model.test/v1/chat/completions'); expect(request.redirect).toBe('error');
    expect(request.proxy).toBe('http://proxy.test:8080/'); expect(body.model).toBe('model-a'); expect(body.tools).toBeUndefined();
    expect(body.messages[0].content).toContain('旧自定义解释风格'); expect(body.messages[0].content).toContain('不可信资料');
    const input = JSON.parse(body.messages[1].content);
    expect(input.content).toBe(''); expect(input.references[0]).toMatchObject({ quote: reference().quote, location: reference().location });
    expect(input.references[0].target).toBeUndefined();
    release.resolve(); await finish(f.service);
    const result = f.service.get(row.id);
    expect(result).toMatchObject({ number: 'C1', model: 'model-a', status: 'completed', references: [reference()], turns: [{ result: '纯文本记录' }] });
    expect(result.prompt.prompt).toBe('旧自定义解释风格');
    expect(JSON.stringify(result)).not.toContain('unit-test-not-a-real-key'); expect(JSON.stringify(result)).not.toContain('account_key');
  } finally { release.resolve(); await f.close(); }
});

test('C numbering persists across handles and processes; deletion cascades turns but does not reuse either identity', async () => {
  const f = fixture();
  try {
    const a = start(f.service, 'a'); await finish(f.service);
    f.service.action('send', { id: a.id, content: 'second' }); await finish(f.service);
    const lastTurn = f.service.get(a.id).turns.at(-1).id;
    f.service.action('delete', { id: a.id }); expect(() => f.service.get(a.id)).toThrow('不存在');
    const b = f.create(); const next = start(b, 'b'); await finish(b);
    expect(next.number).toBe('C2'); expect(next.turns[0].id).toBeGreaterThan(lastTurn);
    const script = `import { QuickChatService } from ${JSON.stringify(path.resolve('src/host/quick-chat.js'))};
      const s = new QuickChatService({LUSH_GLOBAL_CONFIG:process.argv[1],LUSH_PROVIDER:'mock'}, {fetch:async()=>Response.json({choices:[{message:{content:'done'}}]})});
      const r=s.action('start',{prompt_id:'explain',content:'subprocess'}); await Promise.all([...s.running.values()].map(x=>x.promise));
      console.log(r.number); await s.close();`;
    const child = Bun.spawn(['bun', '-e', script, f.root], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(child.stdout).text(), stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0); expect(stderr).toBe(''); expect(output.trim()).toBe('C3');
    const page = b.list({ limit: 1 }); expect(page).toMatchObject({ conversations: [{ number: 'C3' }], has_more: true, next: 3 });
    expect(b.list({ before: page.next, limit: 1 })).toMatchObject({ conversations: [{ number: 'C2' }], has_more: false });
    const db = new Database(f.file, { readonly: true });
    expect(db.query('SELECT count(*) AS n FROM turns WHERE conversation_id=?').get(a.id).n).toBe(0); db.close();
  } finally { await f.close(); }
});

test('four persistent in-flight claims are shared across services, and same-thread concurrent send/delete is rejected', async () => {
  const release = deferred(); const f = fixture(async () => { await release.promise; return response('done'); });
  try {
    const b = f.create(); const rows = [start(f.service, 'a'), start(b, 'b'), start(f.service, 'c'), start(b, 'd')];
    expect(b.get(rows[0].id).status).toBe('running'); // reading must not recover a sibling
    expect(() => start(b, 'fifth')).toThrow('4');
    expect(() => b.action('send', { id: rows[0].id, content: 'collision' })).toThrow('正在');
    expect(() => b.action('delete', { id: rows[0].id })).toThrow('正在');
    expect(b.list().conversations).toHaveLength(4);
    release.resolve(); await finish(f.service); await finish(b);
    b.action('send', { id: rows[0].id, content: 'now allowed' }); await finish(b);
    expect(b.get(rows[0].id).turns).toHaveLength(2);
  } finally { release.resolve(); await f.close(); }
});

test('multi-turn context uses original snapshots even after Prompt edit/delete; newer completed turns are retained', async () => {
  const requests = []; const f = fixture(async (_url, init) => { requests.push(JSON.parse(init.body)); return response(`answer-${requests.length}`); });
  try {
    const library = save(f.service, { name: '摘要', prompt: '整理而非解释', context_menu: false }), prompt = library.prompts[1];
    const row = start(f.service, 'first', { prompt_id: prompt.id }); await finish(f.service);
    f.service.action('prompt_remove', { id: prompt.id, expected_revision: library.revision });
    f.settings.explanation.save({ connection_id: f.connectionId, model: 'model-b', prompt: 'changed' });
    f.service.action('send', { id: row.id, content: 'follow-up' }); await finish(f.service);
    f.service.action('send', { id: row.id, content: 'third' }); await finish(f.service);
    expect(requests[2].model).toBe('model-a'); expect(requests[2].messages[0].content).toContain('整理而非解释');
    expect(requests[2].messages.slice(2)).toEqual([{ role: 'assistant', content: 'answer-1' }, { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: 'answer-2' }, { role: 'user', content: 'third' }]);
    expect(f.service.get(row.id).number).toBe('C1'); expect(f.service.get(row.id).turns).toHaveLength(3);
  } finally { await f.close(); }
});

test('source changes or deletion never redirect followups to another model/account or create a failed phantom turn', async () => {
  const f = fixture();
  try {
    const row = start(f.service); await finish(f.service);
    const old = f.manager.config().connections[0], { credential, storage_scope, ...config } = old;
    f.manager.save(config, { api_key: 'different-test-account' });
    expect(() => f.service.action('send', { id: row.id, content: 'next' })).toThrow('来源已变化');
    expect(f.service.get(row.id).turns).toHaveLength(1);
    f.manager.remove(f.connectionId);
    expect(() => f.service.action('send', { id: row.id, content: 'next' })).toThrow('不存在');
    expect(f.service.get(row.id).source.endpoint).toBe('https://model.test/v1');
    expect(f.service.get(row.id).turns).toHaveLength(1);
  } finally { await f.close(); }
});

test('changing a source during runtime preparation is rejected before transmitting credentials', async () => {
  const ready = deferred(), hold = deferred(); let calls = 0; const f = fixture(async () => { calls++; return response('should not happen'); });
  try {
    const prepare = f.manager.prepareRuntime.bind(f.manager);
    f.manager.prepareRuntime = async id => { ready.resolve(); await hold.promise; return prepare(id); };
    const row = start(f.service); await ready.promise;
    const { credential, storage_scope, ...source } = f.manager.config().connections[0];
    f.manager.save(source, { api_key: 'new-unit-test-key' }); hold.resolve(); await finish(f.service);
    expect(calls).toBe(0); expect(f.service.get(row.id)).toMatchObject({ status: 'failed', turns: [{ error: expect.stringContaining('准备期间') }] });
    expect(JSON.stringify(f.service.get(row.id))).not.toContain('new-unit-test-key');
  } finally { hold.resolve(); await f.close(); }
});

test('transport failures are bounded, non-leaking and explicit; failed turns may be followed by a new user message', async () => {
  const cases = [
    [() => new Response('SECRET from provider', { status: 401 }), 'HTTP 401'],
    [() => new Response('SECRET from provider', { status: 429 }), 'HTTP 429'],
    [() => new Response('', { status: 302 }), '重定向'],
    [() => new Response('SECRET malformed'), '格式无效'],
    [() => response({ SECRET: true }), '没有返回'],
    [() => new Response('x', { headers: { 'content-length': String(256 * 1024 + 1) } }), '大小上限'],
    [() => new Response('x'.repeat(256 * 1024 + 1)), '大小上限'],
    [() => { throw new Error('SECRET credential raw exception'); }, '调用失败'],
    [() => { throw Object.assign(new Error('SECRET spoofed-safe upstream exception'), { quickChatSafe: true }); }, '调用失败'],
  ];
  for (const [produce, message] of cases) {
    let count = 0; const requests = []; const f = fixture(async (_url, init) => { requests.push(JSON.parse(init.body)); return count++ ? response('recovered') : produce(); });
    try {
      const row = start(f.service); await finish(f.service);
      const result = f.service.get(row.id); expect(result.status).toBe('failed'); expect(result.turns[0].error).toContain(message);
      expect(JSON.stringify(result)).not.toContain('SECRET');
      f.service.action('send', { id: row.id, content: 'explicit next request' }); await finish(f.service);
      expect(f.service.get(row.id)).toMatchObject({ status: 'completed', turns: [{ status: 'failed' }, { result: 'recovered' }] });
      expect(requests[1].messages.map(row => row.role)).toEqual(['system', 'user', 'user']);
    } finally { await f.close(); }
  }
});

test('128KiB total context budget drops older completed turns and reports truncation without shortening root references', async () => {
  const requests = []; const f = fixture(async (_url, init) => { requests.push(JSON.parse(init.body)); return response('R'.repeat(60000)); });
  try {
    const row = start(f.service, 'original', { references: [reference()] }); await finish(f.service);
    for (const content of ['second', 'third', 'fourth']) { f.service.action('send', { id: row.id, content }); await finish(f.service); }
    const result = f.service.get(row.id);
    expect(result.turns.at(-1).truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(requests.at(-1).messages))).toBeLessThanOrEqual(128 * 1024);
    expect(requests.at(-1).messages.some(row => row.content === 'second')).toBe(true);
    expect(requests.at(-1).messages[1].content).toContain(reference().quote);
    const updated = save(f.service, { name: 'large', prompt: '汉'.repeat(16384), context_menu: false });
    const bigRefs = [reference({ quote: '汉'.repeat(8000) }), reference({ quote: '汉'.repeat(8000) })];
    const large = start(f.service, '汉'.repeat(8192), { prompt_id: updated.prompts[1].id, references: bigRefs }); await finish(f.service);
    expect(() => f.service.action('send', { id: large.id, content: '汉'.repeat(8192) })).toThrow('预算');
    expect(f.service.get(large.id).turns).toHaveLength(1);
    expect(f.service.list().conversations).toHaveLength(2);
  } finally { await f.close(); }
});

test('timeout covers preparation and a stalled response body; close aborts owned calls without stopping injected settings/sibling', async () => {
  const forever = new Promise(() => {}); const f = fixture(async () => new Response(new ReadableStream({ start() {} })), { timeoutMs: 15 });
  try {
    const first = start(f.service); await finish(f.service); expect(f.service.get(first.id).turns[0].error).toContain('超时');
    f.manager.prepareRuntime = () => forever;
    const second = start(f.service); await finish(f.service); expect(f.service.get(second.id).turns[0].error).toContain('超时');
    const b = f.create({ timeoutMs: 10000 }); const row = start(b);
    const c = f.create({ timeoutMs: 10000 }); const sibling = start(c);
    await b.close(); expect(() => b.list()).toThrow('停止');
    expect(c.get(row.id).turns[0].error).toContain('界面服务已停止'); expect(c.get(sibling.id).status).toBe('running');
    expect(f.settings.closed).toBe(false); expect(await b.close()).toBeUndefined();
    await c.close();
  } finally { await f.close(); }
});

test('abruptly exited process requests are failed on reopening, never replayed; still-live foreign requests are not recovered', async () => {
  const f = fixture();
  try {
    const script = `import { QuickChatService } from ${JSON.stringify(path.resolve('src/host/quick-chat.js'))};
      const s = new QuickChatService({LUSH_GLOBAL_CONFIG:process.argv[1],LUSH_PROVIDER:'mock'}, {fetch:()=>new Promise(()=>{})});
      console.log(s.action('start',{prompt_id:'explain',content:'interrupted'}).id); process.exit(0);`;
    const child = Bun.spawn(['bun', '-e', script, f.root], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(child.stdout).text(), stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0); expect(stderr).toBe(''); const id = Number(output.trim());
    expect(f.service.get(id)).toMatchObject({ status: 'failed', turns: [{ error: expect.stringContaining('未自动重试') }] });
    f.service.action('send', { id, content: 'explicitly continue' }); await finish(f.service); expect(f.service.get(id).status).toBe('completed');
    const db = new Database(f.file);
    db.query("UPDATE turns SET status='running',result=NULL,error=NULL,owner_pid=?,owner_id='foreign-live' WHERE id=?")
      .run(process.ppid, f.service.get(id).turns.at(-1).id); db.close();
    expect(f.service.get(id).status).toBe('running');
    expect(() => f.service.action('delete', { id })).toThrow('正在');
  } finally { await f.close(); }
});

test('simultaneous live Host processes share the persistent four-call limit without recovering each other', async () => {
  const f = fixture(); const children = [];
  try {
    const script = `import { QuickChatService } from ${JSON.stringify(path.resolve('src/host/quick-chat.js'))};
      const s=new QuickChatService({LUSH_GLOBAL_CONFIG:process.argv[1],LUSH_PROVIDER:'mock'}, {fetch:()=>new Promise(()=>{})});
      const ids=[s.action('start',{prompt_id:'explain',content:'one'}).id,s.action('start',{prompt_id:'explain',content:'two'}).id];
      console.log(JSON.stringify(ids)); await new Response(Bun.stdin.stream()).text(); await s.close();`;
    for (let i = 0; i < 2; i++) children.push(Bun.spawn(['bun', '-e', script, f.root], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
    const ids = (await Promise.all(children.map(async child => {
      const reader = child.stdout.getReader(); const chunk = await reader.read(); reader.releaseLock();
      return JSON.parse(new TextDecoder().decode(chunk.value).trim());
    }))).flat();
    expect(new Set(ids).size).toBe(4); expect(f.service.list().conversations).toHaveLength(4);
    for (const id of ids) expect(f.service.get(id).status).toBe('running');
    expect(() => start(f.service, 'fifth')).toThrow('4');
    for (const child of children) child.stdin.end();
    for (const child of children) {
      expect(await child.exited).toBe(0); expect(await new Response(child.stderr).text()).toBe('');
    }
    for (const id of ids) expect(f.service.get(id).status).toBe('failed');
  } finally {
    for (const child of children) { child.stdin.end(); if (child.exitCode === null) child.kill(); await child.exited; }
    await f.close();
  }
});

test('private SQLite rollback recovery preserves committed history after a writer crashes, without replaying any model call', async () => {
  const f = fixture();
  try {
    const row = start(f.service, 'committed content'); await finish(f.service);
    const script = `import { Database } from 'bun:sqlite'; const db=new Database(process.argv[1]);
      db.exec('PRAGMA cache_size=1; BEGIN IMMEDIATE');
      db.query('UPDATE conversations SET content=? WHERE id=?').run('uncommitted'.repeat(5000),process.argv[2]);
      process.kill(process.pid,'SIGKILL');`;
    const child = Bun.spawn(['bun', '-e', script, f.file, String(row.id)], { stdout: 'pipe', stderr: 'pipe' });
    await child.exited;
    expect(await new Response(child.stderr).text()).toBe('');
    expect(f.service.get(row.id)).toMatchObject({ content: 'committed content', status: 'completed', turns: [{ result: '纯文本结果' }] });
    expect(f.service.running.size).toBe(0);
  } finally { await f.close(); }
});

test('Prompt cap and stored corruption fail safely without rewriting configuration or history', async () => {
  const f = fixture();
  try {
    let current = f.service.config();
    for (let i = 1; i < 50; i++) current = save(f.service, { name: `P${i}`, prompt: 'text', context_menu: false }, current.revision);
    expect(current.prompts).toHaveLength(50);
    expect(() => save(f.service, { name: 'overflow', prompt: 'text', context_menu: true }, current.revision)).toThrow('50');
    expect(f.service.config().revision).toBe(current.revision);
    const row = start(f.service); await finish(f.service);
    const db = new Database(f.file);
    db.query('UPDATE conversations SET source_json=? WHERE id=?').run(JSON.stringify({ connection_id: 'source', api_key: 'SECRET' }), row.id);
    db.close();
    let caught; try { f.service.get(row.id); } catch (error) { caught = error; }
    expect(caught?.quickChatSafe).toBe(true); expect(caught.message).toContain('私有历史');
    expect(caught.message).not.toContain('SECRET'); expect(caught.message).not.toContain(f.root);
  } finally { await f.close(); }
});

test('an unconfirmed result persistence failure disables further calls and never exposes raw errors or claims completion', async () => {
  const f = fixture();
  try {
    const original = f.service.store.finish.bind(f.service.store);
    f.service.store.finish = () => { throw new Error('SECRET private path and raw OS failure'); };
    const row = start(f.service); await finish(f.service);
    expect(f.service.persistenceError).toBe(true);
    expect(() => f.service.get(row.id)).toThrow('结果未能保存');
    expect(() => start(f.service)).toThrow('未能保存');
    let message; try { f.service.list(); } catch (error) { message = error.message; }
    expect(message).not.toContain('SECRET');
    f.service.store.finish = original; await f.service.close();
    const other = f.create();
    expect(other.get(row.id)).toMatchObject({ status: 'failed', turns: [{ result: null, error: expect.stringContaining('未自动重试') }] });
    expect(other.list().conversations).toHaveLength(1);
  } finally { await f.close(); }
});

test('private history rejects symlinks/hardlinks/permissions/corruption and unsafe sidecars without altering outside data', async () => {
  for (const kind of ['symlink', 'hardlink', 'mode', 'corrupt', 'journal', 'wal', 'root']) {
    const f = fixture();
    try {
      const outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, 'do-not-touch', { mode: 0o600 });
      if (kind === 'symlink') fs.symlinkSync(outside, f.file);
      if (kind === 'hardlink') fs.linkSync(outside, f.file);
      if (kind === 'mode') fs.writeFileSync(f.file, '', { mode: 0o644 });
      if (kind === 'corrupt') fs.writeFileSync(f.file, 'not sqlite', { mode: 0o600 });
      if (['journal', 'wal', 'root'].includes(kind)) {
        const row = start(f.service); await finish(f.service);
        if (kind === 'journal') fs.symlinkSync(outside, `${f.file}-journal`);
        if (kind === 'wal') fs.writeFileSync(`${f.file}-wal`, '', { mode: 0o600 });
        if (kind === 'root') fs.chmodSync(f.settings.config.home, 0o755);
        expect(() => f.service.get(row.id)).toThrow();
      }
      expect(() => f.service.list()).toThrow(); expect(() => start(f.service)).toThrow();
      expect(fs.readFileSync(outside, 'utf8')).toBe('do-not-touch');
    } finally { await f.close(); }
  }
});
