import { test, expect } from 'bun:test';
import path from 'node:path';
import { fixture, gate } from '../helpers.js';
import { install, connection } from './agent-connection-fixture.js';
import { saveNetworkConfiguration } from '../../src/agent/network.js';
import { Store } from '../../src/persistence/store.js';
import { Database } from 'bun:sqlite';
import { Dispatcher } from '../../src/rpc/dispatcher.js';

function setup(fetcher = async () => Response.json({ choices: [{ message: { content: '解释结果' } }] })) {
  const f = fixture(); const { manager } = install(f);
  f.project.quickExplanationOptions = { fetch: fetcher };
  f.project.configureQuickExplanation({ connection_id: 'conn-one', model: 'physical-model' });
  return { ...f, manager };
}
const finish = async f => { await Promise.all([...f.project.introRunning.values()].map(entry => entry.promise)); };

test('config validates sources and models without networking or altering Agent defaults', async () => {
  const f = fixture(); const { manager } = install(f);
  try {
    expect(f.project.quickExplanationConfig().ready).toBe(false);
    const original = f.project.agentSettings.readStored();
    manager.connections[0].models = ['vendor/model'];
    for (const patch of [{ connection_id: 'missing' }, { connection_id: 'conn-one', model: 'wrong' }])
      expect(() => f.project.configureQuickExplanation(patch)).toThrow();
    f.project.configureQuickExplanation({ connection_id: 'conn-one', model: 'vendor/model', prompt: 'test prompt' });
    expect(f.project.quickExplanationConfig()).toMatchObject({ ready: true, model: 'vendor/model', prompt: 'test prompt' });
    expect(f.project.agentSettings.readStored()).toEqual(original);
    expect(manager.calls).toBe(0);
    manager.connections[0].enabled = false;
    expect(f.project.quickExplanationConfig().reason).toContain('禁用');
    expect(() => f.project.startQuickExplanation('text')).toThrow('禁用');
    manager.connections[0] = connection({ provider: 'openai-codex', auth_type: 'oauth' });
    expect(() => f.project.configureQuickExplanation({ connection_id: 'conn-one' })).toThrow('OAuth');
    manager.connections[0] = connection({ provider: 'kimi-coding' });
    expect(() => f.project.configureQuickExplanation({ connection_id: 'conn-one' })).toThrow('协议');
    expect(f.project.configureQuickExplanation({ connection_id: null, model: null, prompt: null }).ready).toBe(false);
  } finally { await f.close(); }
});

test('public quick_explain RPC reaches the real backend with safe snapshots and bounded history', async () => {
  const f = setup();
  try {
    const dispatcher = new Dispatcher(f.project);
    expect(await dispatcher.dispatch('quick_explain.config')).toMatchObject({ ready: true, model: 'physical-model' });
    expect(await dispatcher.dispatch('quick_explain.configure', { config: { prompt: '解释含义' } })).toMatchObject({ prompt: '解释含义' });
    const row = await dispatcher.dispatch('quick_explain.start', { quote: '公开接口选区', location: { view: 'docs' } });
    await finish(f);
    const result = await dispatcher.dispatch('quick_explain.get', { id: row.id });
    expect(result).toMatchObject({ status: 'completed', quote: '公开接口选区', result: '解释结果', prompt: '解释含义', source: { connection_id: 'conn-one' } });
    expect(JSON.stringify(result)).not.toContain('test-secret');
    expect(await dispatcher.dispatch('quick_explain.list', { limit: 1 })).toMatchObject({ explanations: [{ id: row.id }], has_more: false });
    await expect(dispatcher.dispatch('quick_explain.list', { limit: 51 })).rejects.toThrow('limit');
    await expect(dispatcher.dispatch('intro.start', { quote: '资料' })).rejects.toThrow('unknown method');
  } finally { await f.close(); }
});

test('write gates and missing credentials reject before creating records', async () => {
  const f = setup();
  try {
    f.project.clearing = true;
    expect(() => f.project.configureQuickExplanation({ prompt: 'new' })).toThrow('clear');
    expect(() => f.project.startQuickExplanation('text')).toThrow('clear');
    f.project.clearing = false; f.project.workerDeleteIds = new Set([1]);
    expect(() => f.project.startQuickExplanation('text')).toThrow('deletion');
    f.project.workerDeleteIds.clear();
    f.manager.connections[0].credential.status = 'unconfigured';
    expect(f.project.quickExplanationConfig().ready).toBe(false);
    expect(() => f.project.startQuickExplanation('text')).toThrow('API Key');
    f.project.stopping = true;
    expect(() => f.project.configureQuickExplanation({ prompt: 'new' })).toThrow('stopping');
    expect(() => f.project.startQuickExplanation('text')).toThrow('stopping');
    expect(f.store.all('SELECT * FROM introductions')).toHaveLength(0);
  } finally { f.project.stopping = false; await f.close(); }
});

test('request snapshots selection, source, model, Prompt and network; no Worker or extra context', async () => {
  const pending = gate(), called = gate(); let request, target;
  const f = setup(async (url, init) => { target = url; request = init; called.resolve(); await pending.promise;
    return Response.json({ choices: [{ message: { content: [{ text: '结果' }] } }] }); });
  try {
    saveNetworkConfiguration(f.config, { version: 1, mode: 'proxy', proxy_url: 'http://proxy.test:8080', no_proxy: [] });
    f.project.configureQuickExplanation({ prompt: 'my prompt' });
    const tasks = f.store.all('SELECT * FROM tasks').length;
    const row = f.project.startQuickExplanation('rm -rf anything；这是资料', { view: 'docs', path: 'docs/design.md' });
    expect(row.status).toBe('running'); await called.promise;
    f.project.configureQuickExplanation({ model: 'another-model', prompt: 'changed' });
    saveNetworkConfiguration(f.config, { version: 1, mode: 'direct', no_proxy: [] });
    f.manager.keys.set('conn-one', 'changed-key');
    f.manager.connections[0].endpoint = 'https://changed.invalid/v1';
    const body = JSON.parse(request.body);
    expect(body.model).toBe('physical-model'); expect(body.stream).toBe(false); expect(body.tools).toBeUndefined();
    expect(body.messages[0].content).toContain('my prompt'); expect(body.messages[0].content).toContain('不可信资料');
    expect(JSON.parse(body.messages[1].content)).toEqual({ selected_text: row.quote, page_location: { view: 'docs', path: 'docs/design.md' } });
    expect(request.headers.Authorization).toBe('Bearer test-secret'); expect(request.proxy).toBe('http://proxy.test:8080/');
    expect(request.redirect).toBe('error'); expect(target).toBe('https://api.deepseek.com/v1/chat/completions');
    pending.resolve(); await finish(f);
    const result = f.project.quickExplanation(row.id);
    expect(result).toMatchObject({ status: 'completed', result: '结果', prompt: 'my prompt', model: 'physical-model', source: { endpoint: 'https://api.deepseek.com/v1' } });
    expect(JSON.stringify(result)).not.toContain('test-secret'); expect(JSON.stringify(result)).not.toContain('changed-key');
    expect(f.store.all('SELECT * FROM tasks').length).toBe(tasks);
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
  } finally { pending.resolve(); await f.close(); }
});

test('four in-flight calls maximum; malformed selection and location never create rows', async () => {
  const pending = gate(); const f = setup(async () => { await pending.promise; return Response.json({ choices: [{ message: { content: 'done' } }] }); });
  try {
    for (const quote of ['', '   ', 'x'.repeat(8193), {}]) expect(() => f.project.startQuickExplanation(quote)).toThrow();
    expect(() => f.project.startQuickExplanation('text', { unknown: 'field' })).toThrow();
    expect(f.store.all('SELECT * FROM introductions')).toHaveLength(0);
    for (let i = 0; i < 4; i++) f.project.startQuickExplanation(`q${i}`);
    expect(() => f.project.startQuickExplanation('fifth')).toThrow('4');
    expect(f.project.introRunning.size).toBe(4);
    expect(() => f.project.clear()).toThrow('request');
    pending.resolve(); await finish(f);
    expect(f.project.introRunning.size).toBe(0);
  } finally { pending.resolve(); await f.close(); }
});

test('a provider default endpoint without a path is not mistaken for a changed source', async () => {
  const f = setup();
  try {
    // The connection manager stores `https://api.deepseek.com` while the public read model
    // renders `https://api.deepseek.com/`; that textual difference must not fail a call.
    f.manager.connections[0].endpoint = 'https://api.deepseek.com';
    const row = f.project.startQuickExplanation('text'); await finish(f);
    const result = f.project.quickExplanation(row.id);
    expect(result.status).toBe('completed'); expect(result.result).toBe('解释结果');
    expect(result.source.endpoint).toBe('https://api.deepseek.com');
  } finally { await f.close(); }
});

test('connection changed while preparing credentials fails safely instead of sending changed credentials', async () => {
  let calls = 0; const pending = gate(); const f = setup(async () => { calls++; return Response.json({}); });
  try {
    f.manager.prepareRuntime = async id => { await pending.promise; return { connection: f.manager.connections[0], credential: { type: 'api_key', key: 'new-secret' }, ...f.manager.identity(id) }; };
    const row = f.project.startQuickExplanation('text');
    f.manager.keys.set('conn-one', 'new-secret'); pending.resolve(); await finish(f);
    expect(calls).toBe(0); expect(f.project.quickExplanation(row.id).status).toBe('failed');
    expect(JSON.stringify(f.project.quickExplanation(row.id))).not.toContain('new-secret');
  } finally { pending.resolve(); await f.close(); }
});

test('safe HTTP errors, redirects, malformed content and streamed response limits', async () => {
  const cases = [
    [() => new Response('secret-server-detail', { status: 401 }), 'HTTP 401'],
    [() => new Response('secret-server-detail', { status: 429 }), 'HTTP 429'],
    [() => new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }), '重定向'],
    [() => new Response('not-json-secret'), '格式无效'],
    [() => Response.json({ choices: [{ message: { content: { secret: 'do-not-display' } } }] }), '没有返回'],
    [() => new Response('x', { headers: { 'content-length': String(256 * 1024 + 1) } }), '大小上限'],
    [() => new Response('x'.repeat(256 * 1024 + 1)), '大小上限'],
    [() => { throw new Error('Bearer test-secret proxy-secret'); }, '模型调用失败'],
  ];
  for (const [response, expected] of cases) {
    const f = setup(async () => response());
    try {
      const row = f.project.startQuickExplanation('quote'); await finish(f);
      const result = f.project.quickExplanation(row.id);
      expect(result.status).toBe('failed'); expect(result.error).toContain(expected);
      expect(JSON.stringify(result)).not.toContain('secret'); expect(result.result).toBeNull();
    } finally { await f.close(); }
  }
});

test('deadline covers a hung response body and shutdown cancels without replay', async () => {
  let signal, cancellations = 0;
  const f = setup(async (_, init) => { signal = init.signal; return new Response(new ReadableStream({ start() {}, cancel() { cancellations++; } })); });
  try {
    f.project.quickExplanationOptions.timeoutMs = 15;
    const row = f.project.startQuickExplanation('timeout'); await finish(f);
    expect(f.project.quickExplanation(row.id)).toMatchObject({ status: 'failed' });
    expect(f.project.quickExplanation(row.id).error).toContain('超时'); expect(signal.aborted).toBe(true); expect(cancellations).toBe(1);
    f.project.quickExplanationOptions.timeoutMs = 120000;
    const second = f.project.startQuickExplanation('shutdown');
    await f.project.shutdown();
    expect(f.project.quickExplanation(second.id).error).toContain('停止'); expect(f.project.introRunning.size).toBe(0);
  } finally { await f.close(); }
});

test('explanation history can be deleted; running calls and write gates are protected', async () => {
  const pending = gate();
  const f = setup(async () => { await pending.promise; return Response.json({ choices: [{ message: { content: 'done' } }] }); });
  try {
    const row = f.project.startQuickExplanation('history text');
    expect(() => f.project.deleteExplanation(row.id)).toThrow('进行');
    expect(f.store.intro(row.id)).toBeTruthy();
    pending.resolve(); await finish(f);
    expect(f.project.deleteExplanation(row.id)).toEqual({ removed: row.id });
    expect(f.store.intro(row.id)).toBeNull();
    expect(() => f.project.deleteExplanation(row.id)).toThrow('not found');
    // The page lists legacy quick intros too; they share the same history and are removable.
    const legacy = f.store.introCreate({ quote: 'legacy', location: { view: 'worker' } });
    expect(f.project.deleteExplanation(legacy.id)).toEqual({ removed: legacy.id });
    const other = f.store.introCreate({ quote: 'kept', location: { view: 'worker' } });
    f.project.clearing = true;
    expect(() => f.project.deleteExplanation(other.id)).toThrow('clear');
    expect(f.store.intro(other.id)).toBeTruthy();
  } finally { f.project.clearing = false; pending.resolve(); await f.close(); }
});

test('history is project-wide, bounded, newest first, summaries omit full content; legacy untouched on recovery', async () => {
  const f = setup();
  try {
    const legacy = f.store.introCreate({ quote: 'legacy', location: { view: 'worker' } });
    const row = f.project.startQuickExplanation('x'.repeat(8192), { view: 'settings' }); await finish(f);
    const unfinished = f.store.quickExplanationCreate({ quote: 'interrupted', location: { view: 'docs' }, model: 'm', source: row.source, prompt: 'p' });
    const page = f.project.quickExplanations(null, 2);
    expect(page.explanations.map(item => item.id)).toEqual([unfinished.id, row.id]); expect(page.has_more).toBe(true);
    expect(page.explanations[1].quote.length).toBe(180); expect(page.explanations[1].result).toBeUndefined(); expect(page.explanations[1].prompt).toBeUndefined();
    expect(f.project.quickExplanations(page.next, 2).explanations[0].id).toBe(legacy.id);
    for (const limit of [0, 51, 1.5]) expect(() => f.project.quickExplanations(null, limit)).toThrow();
    expect(() => f.project.quickExplanations('cursor')).toThrow();
    f.project.recover();
    expect(f.store.intro(unfinished.id).status).toBe('failed'); expect(f.store.intro(legacy.id).status).toBe('running');
    expect(f.project.quickExplanation(legacy.id).source).toBeNull(); expect(f.project.quickExplanation(legacy.id).prompt).toBeNull();
  } finally { await f.close(); }
});

test('follow-up reuses the original snapshot and sends selection, explanation and prior turns', async () => {
  const requests = [];
  const f = setup(async (url, init) => { requests.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: '追问回答' } }] }); });
  try {
    const root = f.project.startQuickExplanation('原始选区', { view: 'docs' }); await finish(f);
    // Changing the live config must not rewrite the thread or affect the pinned follow-up source.
    f.project.configureQuickExplanation({ model: 'another-model', prompt: 'changed' });
    f.project.followUpQuickExplanation(root.id, '这是什么意思？'); await finish(f);
    const detail = f.project.quickExplanation(root.id);
    expect(detail.followups).toHaveLength(1);
    expect(detail.followups[0]).toMatchObject({ question: '这是什么意思？', answer: '追问回答', status: 'completed', truncated: false });
    expect(detail.model).toBe('physical-model'); expect(detail.prompt).not.toBe('changed');
    expect(requests).toHaveLength(2);
    expect(requests[1].model).toBe('physical-model');
    expect(requests[1].messages[0]).toEqual(requests[0].messages[0]);
    expect(requests[1].messages[1]).toEqual(requests[0].messages[1]);
    // The fetch stub answers every call, so the root result is also the follow-up answer text.
    expect(requests[1].messages[2]).toEqual({ role: 'assistant', content: '追问回答' });
    expect(requests[1].messages.at(-1)).toEqual({ role: 'user', content: '这是什么意思？' });
    f.project.followUpQuickExplanation(root.id, '再展开一点'); await finish(f);
    const thread = requests.at(-1).messages;
    expect(thread[3]).toEqual({ role: 'user', content: '这是什么意思？' });
    expect(thread[4]).toEqual({ role: 'assistant', content: '追问回答' });
    expect(thread.at(-1)).toEqual({ role: 'user', content: '再展开一点' });
    const page = f.project.quickExplanations(null, 10);
    expect(page.explanations[0]).toMatchObject({ id: root.id, followup_count: 2 });
  } finally { await f.close(); }
});

test('follow-up keeps the newest turns and drops the oldest with a visible truncation mark', async () => {
  const requests = [];
  const f = setup(async (url, init) => { requests.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: 'ok' } }] }); });
  try {
    const root = f.project.startQuickExplanation('root'); await finish(f);
    const older = f.store.followupCreate({ introductionId: root.id, question: 'old question' });
    f.store.followupFinish(older.id, { status: 'completed', answer: 'a'.repeat(70000) });
    const newer = f.store.followupCreate({ introductionId: root.id, question: 'new question' });
    f.store.followupFinish(newer.id, { status: 'completed', answer: 'b'.repeat(70000) });
    const detail = f.project.followUpQuickExplanation(root.id, 'third'); await finish(f);
    const thread = requests.at(-1).messages;
    expect(thread).toHaveLength(6);
    expect(thread[3]).toEqual({ role: 'user', content: 'new question' });
    expect(thread[5]).toEqual({ role: 'user', content: 'third' });
    expect(JSON.stringify(thread)).not.toContain('old question');
    expect(detail.followups.at(-1)).toMatchObject({ question: 'third', truncated: true });
    expect(detail.followups[0]).toMatchObject({ question: 'old question', truncated: false });
  } finally { await f.close(); }
});

test('follow-up refuses legacy, running, failed, invalid and over-limit calls without rows', async () => {
  const pending = gate();
  const f = setup(async () => { await pending.promise; return Response.json({ choices: [{ message: { content: 'done' } }] }); });
  try {
    const legacy = f.store.introCreate({ quote: 'legacy', location: { view: 'worker' } });
    expect(() => f.project.followUpQuickExplanation(legacy.id, 'q')).toThrow('来源快照');
    const running = f.project.startQuickExplanation('running');
    expect(() => f.project.followUpQuickExplanation(running.id, 'q')).toThrow('已完成');
    for (const bad of ['', '   ', 'x'.repeat(8193), 5]) expect(() => f.project.followUpQuickExplanation(running.id, bad)).toThrow('追问');
    pending.resolve(); await finish(f);
    const failed = f.store.quickExplanationCreate({ quote: 'f', location: { view: 'docs' }, model: 'm', source: running.source, prompt: 'p' });
    f.store.introFinish(failed.id, { status: 'failed', error: 'x' });
    expect(() => f.project.followUpQuickExplanation(failed.id, 'q')).toThrow('已完成');
    expect(f.store.all('SELECT * FROM explanation_followups')).toHaveLength(0);
  } finally { pending.resolve(); await f.close(); }
});

test('follow-up shares the in-flight cap and write gates with explanations', async () => {
  const pending = gate();
  const f = setup(async () => { await pending.promise; return Response.json({ choices: [{ message: { content: 'done' } }] }); });
  try {
    const root = f.project.startQuickExplanation('root'); pending.resolve(); await finish(f);
    for (let i = 0; i < 4; i++) f.project.startQuickExplanation(`q${i}`);
    expect(f.project.introRunning.size).toBe(4);
    expect(() => f.project.followUpQuickExplanation(root.id, 'q')).toThrow('4');
    f.project.clearing = true;
    expect(() => f.project.followUpQuickExplanation(root.id, 'q')).toThrow('clear');
    f.project.clearing = false; f.project.stopping = true;
    expect(() => f.project.followUpQuickExplanation(root.id, 'q')).toThrow('stopping');
  } finally { f.project.stopping = false; pending.resolve(); await f.close(); }
});

test('deleting an explanation removes its whole thread; a running follow-up blocks deletion', async () => {
  const pending = gate();
  const f = setup(async () => { await pending.promise; return Response.json({ choices: [{ message: { content: 'done' } }] }); });
  try {
    const root = f.project.startQuickExplanation('root'); pending.resolve(); await finish(f);
    const detail = f.project.followUpQuickExplanation(root.id, 'running follow-up');
    const turnId = detail.followups[0].id;
    expect(() => f.project.deleteExplanation(root.id)).toThrow('追问');
    await finish(f);
    expect(f.store.followup(turnId).status).toBe('completed');
    expect(f.project.deleteExplanation(root.id)).toEqual({ removed: root.id });
    expect(f.store.intro(root.id)).toBeNull(); expect(f.store.followup(turnId)).toBeNull();
  } finally { pending.resolve(); await f.close(); }
});

test('recovery marks interrupted follow-ups failed without replaying or losing the question', async () => {
  const f = setup();
  try {
    const root = f.project.startQuickExplanation('root'); await finish(f);
    const turn = f.store.followupCreate({ introductionId: root.id, question: '未完成的追问' });
    f.project.recover();
    expect(f.store.followup(turn.id)).toMatchObject({ status: 'failed', question: '未完成的追问', answer: null });
    expect(f.store.followup(turn.id).error).toContain('中断');
  } finally { await f.close(); }
});

test('existing databases gain nullable snapshot column without rewriting historical rows', async () => {
  const f = fixture(); let store;
  try {
    const file = path.join(f.config.home, 'old.db');
    const db = new Database(file);
    db.exec("CREATE TABLE introductions(id INTEGER PRIMARY KEY, task_id INTEGER, quote TEXT NOT NULL, location TEXT NOT NULL, status TEXT, result TEXT, error TEXT, base_url TEXT, model TEXT, created_at TEXT, updated_at TEXT)");
    db.query("INSERT INTO introductions VALUES(1,NULL,'old','{}','running',NULL,NULL,'https://old.invalid','m','then','then')").run(); db.close();
    store = new Store(file, f.root);
    expect(store.intro(1)).toMatchObject({ source_snapshot: null, quote: 'old', status: 'running', created_at: 'then', updated_at: 'then' });
  } finally { store?.close(); await f.close(); }
});
