import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, temp, env, gate } from './helpers.js';
import { GlobalInboxService } from '../src/host/global-inbox.js';
import { createProjectHost } from '../src/host/project-host.js';
import { projectRouteId, writeLauncherState } from '../src/host/registry.js';
import { handlers } from '../src/rpc/handlers/notice.js';
import { assertAllowed } from '../src/rpc/registry.js';

function add(source, title, options = {}) {
  return Number(source.store.run('INSERT INTO notices(task_id,title,body,kind,status,source_event_id,answer_source,answer,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    source.task.id, title, options.body ?? 'body', options.kind ?? 'question', options.status ?? 'open', options.event ?? null,
    options.answer_source ?? null, options.answer ?? null, options.created_at ?? '2026-10-01T12:00:00.000Z').lastInsertRowid);
}
function setup(options = {}) {
  const global = temp(), environment = env({ LUSH_GLOBAL_CONFIG: global });
  const fixtures = [fixture({ async run() { return 'ok'; } }), fixture({ async run() { return 'ok'; } })];
  const sources = fixtures.map(f => ({ ...f, task: f.store.create({ role: 'worker', goal: 'source', status: 'paused' }), online: true, calls: [], intercept: null }));
  const map = new Map(sources.map(source => [source.root, source]));
  for (const source of sources) writeLauncherState(source.root, environment);
  let starts = 0;
  const host = createProjectHost(null, { env: environment,
    openProject: async () => { starts++; throw new Error('must not start daemon'); },
    attachProject: async project => {
      const source = map.get(project);
      return { config: source.config, client: { async request(method, params = {}) {
        source.calls.push({ method, params });
        if (!source.online) throw new Error('SOURCE_SECRET_SHOULD_NOT_LEAK');
        if (source.intercept) {
          const result = await source.intercept(method, params);
          if (result !== undefined) return result;
        }
        if (method === 'system.summary') return { project, revision: '1' };
        assertAllowed(method, params, null);
        return handlers[method](source.project, params, null);
      } } };
    },
    stopProject: async config => { map.get(config.project).online = false; return { stopped: true }; },
    ...(options.host ?? {}),
  });
  const service = new GlobalInboxService(host, { env: environment, backoffMs: 0, ...options.service });
  return { global, environment, sources, host, service, starts: () => starts,
    async close() { service.close(); for (const f of fixtures) await f.close(); fs.rmSync(global, { recursive: true, force: true }); } };
}

async function all(service, status = 'all') {
  const items = []; let before = null, model, turns = 0;
  do {
    model = await service.list({ status, before, limit: 37 }); items.push(...model.items); before = model.cursor;
    if (++turns > 100) throw new Error('global pagination did not converge');
  } while (model.has_more);
  return { items, model };
}

test('global inbox separates projects sharing integer Notice IDs and pages more than 200 records', async () => {
  const f = setup();
  try {
    for (const [index, source] of f.sources.entries()) {
      source.store.transaction(() => { for (let i = 0; i < 245; i++) add(source, `project-${index}-${i}`); });
    }
    const { items, model } = await all(f.service);
    expect(items).toHaveLength(490); expect(model.complete).toBe(true);
    expect(new Set(items.map(item => `${item.project_id}:${item.notice.sync_identity}`)).size).toBe(490);
    expect(items.filter(item => item.notice.id === 1)).toHaveLength(2);
    expect(items.every(item => item.online && item.checked_at && item.notice.task_worker_number === null)).toBe(true);
    expect(f.starts()).toBe(0);
    expect((await f.service.get(projectRouteId(f.sources[1].root), 1)).notice.title).toBe('project-1-0');
    expect(f.sources.flatMap(source => source.calls).filter(call => call.method === 'notice.sync').length).toBeGreaterThan(4);
  } finally { await f.close(); }
});

test('Host routes compose real inbox synchronization and exact-identity source actions without starting stopped projects', async () => {
  const f = setup(); let server;
  try {
    const [a, b] = f.sources;
    const first = add(a, 'A question'), second = add(b, 'B question');
    expect(first).toBe(second);
    const { startWeb } = await import('../src/ui/web/server.js');
    server = startWeb(null, 0, { env: f.environment, projectHost: f.host, authConfig: null,
      userServiceOptions: { inboxOptions: { backoffMs: 0 } } });
    const base = `http://127.0.0.1:${server.port}`;
    const post = body => fetch(`${base}/api/host/inbox/action`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
    const response = await fetch(`${base}/api/host/inbox`);
    expect(response.status).toBe(200);
    const model = await response.json();
    expect(model.complete).toBe(true); expect(model.items.length).toBe(2);
    const viewed = model.items.find(item => item.project === b.root);
    b.store.run('DELETE FROM notices WHERE id=?', second);
    add(b, 'B replacement');
    const action = { project_id: viewed.project_id, id: second, method: 'notice.answer',
      answer: 'answer B only', expected_identity: viewed.notice.sync_identity };
    expect((await post(action)).status).toBe(400);
    expect(b.calls.filter(call => call.method === 'notice.answer').length).toBe(0);
    const currentResponse = await fetch(`${base}/api/host/inbox/notice?project_id=${viewed.project_id}&id=${second}`);
    expect(currentResponse.status).toBe(200);
    const current = await currentResponse.json();
    expect(current.notice.sync_identity).not.toBe(viewed.notice.sync_identity);
    const ack = await post({ ...action, expected_identity: current.notice.sync_identity });
    expect(ack.status).toBe(200);
    expect((await ack.json()).notice).toMatchObject({ status: 'answered', answer_source: 'user', answer: action.answer });
    expect(a.store.get('SELECT status FROM notices WHERE id=?', first).status).toBe('open');
    a.online = false;
    const offline = await fetch(`${base}/api/host/inbox`);
    const cached = (await offline.json()).items.find(item => item.project === a.root);
    expect(cached.online).toBe(false);
    expect((await post({ ...action, project_id: cached.project_id, id: first,
      expected_identity: cached.notice.sync_identity })).status).toBe(400);
    expect(a.calls.filter(call => call.method === 'notice.answer').length).toBe(0);
    expect(f.starts()).toBe(0);
  } finally { await server?.stop(true); await f.close(); }
});

test('bounded initialization and byte-limited responses report incomplete state honestly', async () => {
  const f = setup({ service: { pagesPerRefresh: 1, pageSize: 7 } });
  try {
    f.sources[0].store.transaction(() => { for (let i = 0; i < 23; i++) add(f.sources[0], `record ${i}`); });
    let result = await f.service.list({ limit: 100 });
    expect(result.items).toHaveLength(7); expect(result.complete).toBe(false);
    for (let i = 0; i < 4; i++) result = await f.service.list({ limit: 100 });
    expect(result.items).toHaveLength(23); expect(result.complete).toBe(true);
    f.sources[1].store.transaction(() => { for (let i = 0; i < 30; i++) add(f.sources[1], `large ${i}`, { body: '中'.repeat(30000) }); });
    for (let i = 0; i < 5; i++) await f.service.refresh();
    result = await f.service.list({ limit: 100 });
    expect(result.items.length).toBeLessThan(53); expect(result.has_more).toBe(true);
    const { items } = await all(f.service);
    expect(items).toHaveLength(53);
  } finally { await f.close(); }
});

test('global answer/read actions update only the authoritative source and ACK cache, with history filtering', async () => {
  const f = setup();
  try {
    const [a, b] = f.sources;
    const aid = add(a, 'A question'), bid = add(b, 'B question');
    const event = b.store.event(b.task.id, 'failed', {});
    const info = add(b, 'B failed', { kind: 'info', status: 'sent', event });
    const automatic = add(b, 'automatic', { status: 'answered', answer_source: 'lush', answer: 'first' });
    const initial = await f.service.get(projectRouteId(b.root), bid);
    const result = await f.service.action({ project_id: projectRouteId(b.root), id: bid, method: 'notice.answer',
      expected_identity: initial.notice.sync_identity, answer: 'user answer' });
    expect(result.notice).toMatchObject({ answer: 'user answer', answer_source: 'user', status: 'answered' });
    expect(a.store.get('SELECT status,answer FROM notices WHERE id=?', aid)).toEqual({ status: 'open', answer: null });
    expect((await f.service.list({ status: 'open' })).items.map(item => item.notice.title)).toEqual(['A question']);
    expect((await f.service.list({ status: 'automatic' })).items.map(item => item.notice.id)).toEqual([automatic]);
    expect((await f.service.list({ status: 'failed' })).items[0].notice.id).toBe(info);
    expect((await f.service.list({ status: 'unread' })).items).toHaveLength(1);
    const read = await f.service.action({ project_id: projectRouteId(b.root), id: info, method: 'notice.read' });
    expect(read.notice.read_at).not.toBeNull();
    expect((await f.service.list({ status: 'unread' })).items).toEqual([]);
    expect((await f.service.get(projectRouteId(b.root), bid)).notice.answer).toBe('user answer');
  } finally { await f.close(); }
});

test('incremental deletion and exact same ID replacement cannot revive a cached record or answer the wrong question', async () => {
  const f = setup();
  try {
    const source = f.sources[0], nid = add(source, 'original'), pid = projectRouteId(source.root);
    const original = await f.service.get(pid, nid);
    source.store.run('DELETE FROM notices WHERE id=?', nid);
    expect((await f.service.list()).items).toEqual([]);
    await expect(f.service.get(pid, nid)).rejects.toThrow('删除');
    source.store.run('INSERT INTO notices(id,task_id,title,body,created_at) VALUES (?,?,?,?,?)', nid, source.task.id, 'original', 'body', original.notice.created_at);
    const current = await f.service.get(pid, nid);
    expect(current.notice.sync_identity).not.toBe(original.notice.sync_identity);
    await expect(f.service.action({ project_id: pid, id: nid, method: 'notice.answer', expected_identity: original.notice.sync_identity, answer: 'wrong' })).rejects.toThrow('变化');
    expect(source.store.get('SELECT status FROM notices WHERE id=?', nid).status).toBe('open');
    source.intercept = async method => {
      if (method !== 'notice.answer') return;
      source.store.run('DELETE FROM notices WHERE id=?', nid);
      source.store.run('INSERT INTO notices(id,task_id,title,body) VALUES (?,?,?,?)', nid, source.task.id, 'replaced between read and answer', 'body');
    };
    await expect(f.service.action({ project_id: pid, id: nid, method: 'notice.answer', answer: 'wrong' })).rejects.toThrow('未确认');
    expect(source.store.get('SELECT status FROM notices WHERE id=?', nid).status).toBe('open');
  } finally { await f.close(); }
});

test('offline Host restart reads private cache but cannot submit an action or start a stopped project', async () => {
  const f = setup(); let resumed;
  try {
    const source = f.sources[0], nid = add(source, 'offline record'), pid = projectRouteId(source.root);
    await f.service.list();
    const file = path.join(f.global, 'inbox', 'cache.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    f.service.close(); await f.host.stop(pid);
    resumed = new GlobalInboxService(f.host, { env: f.environment, backoffMs: 0 });
    const list = await resumed.list();
    expect(list.items[0]).toMatchObject({ online: false, notice: { title: 'offline record' } });
    expect(list.items[0].checked_at).not.toBeNull(); expect(list.complete).toBe(false);
    expect((await resumed.get(pid, nid)).online).toBe(false);
    await expect(resumed.action({ project_id: pid, id: nid, method: 'notice.answer', answer: 'no' })).rejects.toThrow();
    expect(source.calls.filter(call => call.method === 'notice.answer')).toEqual([]);
    expect(source.store.get('SELECT status FROM notices WHERE id=?', nid).status).toBe('open');
    expect(JSON.stringify(list)).not.toContain('SOURCE_SECRET'); expect(f.starts()).toBe(0);
  } finally { resumed?.close(); await f.close(); }
});

test('current registry, removal and public whitelist gate cached contents on every response', async () => {
  const f = setup(); let restricted;
  try {
    const [a, b] = f.sources;
    add(a, 'allowed'); add(b, 'restricted'); await f.service.list();
    const host = createProjectHost(null, { env: f.environment, allowedProjects: [a.root],
      attachProject: async project => ({ config: a.config, client: { async request(method, params) {
        if (!a.online) throw new Error('offline');
        return handlers[method](a.project, params);
      } } }),
    });
    a.online = false; b.online = false;
    restricted = new GlobalInboxService(host, { env: f.environment, backoffMs: 0 });
    expect((await restricted.list()).items.map(item => item.notice.title)).toEqual(['allowed']);
    await expect(restricted.get(projectRouteId(b.root), 1)).rejects.toThrow('无权');
    await expect(restricted.action({ project_id: projectRouteId(b.root), id: 1, method: 'notice.read' })).rejects.toThrow('无权');
    f.host.remove(projectRouteId(b.root));
    expect((await f.service.list()).items.map(item => item.notice.title)).toEqual(['allowed']);
    await expect(f.service.get(projectRouteId(b.root), 1)).rejects.toThrow('无权');
  } finally { restricted?.close(); await f.close(); }
});

test('late source reads are discarded if the project is removed while a refresh is in flight', async () => {
  const f = setup(), waiting = gate(), entered = gate();
  try {
    const source = f.sources[0]; add(source, 'must stay hidden');
    source.intercept = async method => { if (method === 'notice.sync') { entered.resolve(); await waiting.promise; } };
    const reading = f.service.list(); await entered.promise;
    f.host.remove(projectRouteId(source.root)); waiting.resolve();
    const result = await reading;
    expect(result.items).toEqual([]); expect(result.projects).toHaveLength(1);
    expect(fs.readFileSync(path.join(f.global, 'inbox', 'cache.json'), 'utf8')).not.toContain('must stay hidden');
  } finally { waiting.resolve(); await f.close(); }
});

test('independent timeout/backoff does not erase healthy results and refresh is single-flight', async () => {
  let now = 1_000_000;
  const f = setup({ service: { timeoutMs: 20, backoffMs: 1000, now: () => now } });
  try {
    const [a, b] = f.sources; add(a, 'healthy'); add(b, 'blocked');
    b.intercept = async method => { if (method === 'notice.sync') return new Promise(() => {}); };
    const [first, second] = await Promise.all([f.service.list(), f.service.list()]);
    expect(first.items.map(item => item.notice.title)).toEqual(['healthy']); expect(second.items).toEqual(first.items);
    expect(first.projects.find(row => row.id === projectRouteId(b.root))).toMatchObject({ online: false, complete: false });
    const attempts = b.calls.length; await f.service.list(); expect(b.calls.length).toBe(attempts);
    now += 1001; b.intercept = null;
    expect((await f.service.list()).items).toHaveLength(2);
    expect(a.calls.some(call => call.method === 'notice.sync')).toBe(true);
  } finally { await f.close(); }
});

test('unknown mutation effects are never retried, and source errors cannot expose secrets', async () => {
  const f = setup({ service: { timeoutMs: 20 } });
  try {
    const source = f.sources[0], nid = add(source, 'unknown'), pid = projectRouteId(source.root);
    await f.service.list();
    source.intercept = async (method, params) => {
      if (method !== 'notice.answer') return;
      handlers[method](source.project, params);
      return new Promise(() => {}); // database committed, response lost
    };
    await expect(f.service.action({ project_id: pid, id: nid, method: 'notice.answer', answer: 'committed' })).rejects.toThrow('不要重复提交');
    expect(source.calls.filter(call => call.method === 'notice.answer')).toHaveLength(1);
    source.intercept = null;
    expect((await f.service.get(pid, nid)).notice.answer).toBe('committed');
    expect(source.calls.filter(call => call.method === 'notice.answer')).toHaveLength(1);
    source.intercept = async method => { if (method === 'notice.page') throw new Error('RAW_PRIVATE_TOKEN'); };
    let error;
    try { await f.service.get(pid, nid); } catch (failure) { error = failure; }
    expect(error.message).not.toContain('RAW_PRIVATE_TOKEN');
  } finally { await f.close(); }
});

test('capacity bounds are explicit and offline/corrupt/unsafe caches do not fabricate a complete history', async () => {
  const f = setup({ service: { maxRecords: 5 } }); let restarted;
  try {
    const source = f.sources[0];
    source.store.transaction(() => { for (let i = 0; i < 12; i++) add(source, `record ${i}`); });
    let result = await f.service.list({ limit: 100 });
    expect(result.items).toHaveLength(5); expect(result.complete).toBe(false);
    expect(result.projects[0].error).toContain('容量');
    result = await f.service.list(); expect(result.projects[0].error).toContain('容量');
    source.online = false; f.service.close();
    restarted = new GlobalInboxService(f.host, { env: f.environment, maxRecords: 5, backoffMs: 0 });
    expect((await restarted.list()).items).toHaveLength(5); restarted.close();
    const file = path.join(f.global, 'inbox', 'cache.json');
    fs.chmodSync(file, 0o644);
    restarted = new GlobalInboxService(f.host, { env: f.environment, maxRecords: 5, backoffMs: 0 });
    expect((await restarted.list()).items).toEqual([]); restarted.close();
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, '{broken');
    restarted = new GlobalInboxService(f.host, { env: f.environment, maxRecords: 5, backoffMs: 0 });
    expect((await restarted.list()).complete).toBe(false);
    expect((await restarted.list()).items).toEqual([]);
  } finally { restarted?.close(); await f.close(); }
});

test('strict actions/cursors cannot forward arbitrary RPCs, paths, tokens or hidden fields', async () => {
  const f = setup();
  try {
    const pid = projectRouteId(f.sources[0].root), nid = add(f.sources[0], 'strict');
    for (const params of [
      { project_id: pid, id: nid, method: 'worker.cancel' },
      { project_id: f.sources[0].root, id: nid, method: 'notice.read' },
      { project_id: pid, id: nid, method: 'notice.read', _token: 'secret' },
      { project_id: pid, id: nid, method: 'notice.read', answer: 'not read' },
      { project_id: pid, id: nid, method: 'notice.answer' },
      { project_id: pid, id: nid, method: 'notice.answer', answer: 'x', expected_identity: 'invalid' },
    ]) await expect(f.service.action(params)).rejects.toThrow();
    for (const params of [{ status: 'bad' }, { limit: 0 }, { limit: 101 }, { before: 'broken' }, { before: 1 }]) await expect(f.service.list(params)).rejects.toThrow();
    const result = await f.service.list();
    await expect(f.service.list({ status: 'open', before: result.cursor })).rejects.toThrow('cursor');
    expect(f.sources.flatMap(source => source.calls).some(call => call.method === 'worker.cancel')).toBe(false);
  } finally { await f.close(); }
});

test('database epoch reset replaces the old cache and cannot mix records from a recreated source', async () => {
  const f = setup();
  try {
    const source = f.sources[0]; add(source, 'old database'); await f.service.list();
    source.store.transaction(() => {
      source.store.run('DELETE FROM notices');
      source.store.run("UPDATE meta SET value=lower(hex(randomblob(16))) WHERE key='notice_sync_epoch'");
      add(source, 'new database');
    });
    const result = await f.service.list();
    expect(result.items.map(item => item.notice.title)).toEqual(['new database']);
    expect(result.complete).toBe(true);
  } finally { await f.close(); }
});

test('late refreshes cannot overwrite a newer answer ACK, and polling does not repeatedly rewrite a clean cache', async () => {
  const f = setup(), entered = gate(), waiting = gate();
  try {
    const source = f.sources[0], nid = add(source, 'answer race'), pid = projectRouteId(source.root);
    await f.service.list();
    const file = path.join(f.global, 'inbox', 'cache.json');
    const initial = fs.readFileSync(file, 'utf8');
    await f.service.list(); expect(fs.readFileSync(file, 'utf8')).toBe(initial);
    source.store.run("UPDATE notices SET title='prepared before answer' WHERE id=?", nid);
    let first = true;
    source.intercept = async (method, params) => {
      if (method !== 'notice.sync' || !first) return;
      first = false;
      const snapshot = handlers[method](source.project, params);
      entered.resolve(); await waiting.promise; return snapshot;
    };
    const refreshing = f.service.list(); await entered.promise;
    await f.service.action({ project_id: pid, id: nid, method: 'notice.answer', answer: 'newest answer' });
    waiting.resolve();
    expect((await refreshing).items[0].notice.answer).toBe('newest answer');
    expect((await f.service.list()).items[0].notice.status).toBe('answered');
  } finally { waiting.resolve(); await f.close(); }
});

test('unsafe cache aliases and unknown writer locks are neither followed nor stolen', async () => {
  const f = setup(), elsewhere = temp(); let unsafe;
  try {
    add(f.sources[0], 'private'); await f.service.list();
    const root = path.join(f.global, 'inbox'), file = path.join(root, 'cache.json');
    const lock = path.join(root, '.write.lock'); fs.mkdirSync(lock, { mode: 0o700 });
    f.sources[0].store.run("UPDATE notices SET title='new' WHERE id=1");
    expect((await f.service.list()).cache_error).toContain('未保存');
    expect(fs.existsSync(lock)).toBe(true); expect(fs.readFileSync(file, 'utf8')).not.toContain('"title":"new"');
    fs.rmdirSync(lock); fs.unlinkSync(file);
    const target = path.join(elsewhere, 'target'); fs.writeFileSync(target, 'must not touch', { mode: 0o600 }); fs.symlinkSync(target, file);
    unsafe = new GlobalInboxService(f.host, { env: f.environment, backoffMs: 0 });
    const result = await unsafe.list();
    expect(result.cache_error).toContain('未保存'); expect(fs.readFileSync(target, 'utf8')).toBe('must not touch');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  } finally { unsafe?.close(); fs.rmSync(elsewhere, { recursive: true, force: true }); await f.close(); }
});

test('close cancels pending reads and never persists a late response', async () => {
  const f = setup({ service: { timeoutMs: 10000 } }), waiting = gate(), entered = gate();
  try {
    const source = f.sources[0]; add(source, 'late');
    source.intercept = async method => { if (method === 'notice.sync') { entered.resolve(); await waiting.promise; } };
    const read = f.service.list(); await entered.promise; f.service.close();
    await expect(read).rejects.toThrow('stopping');
    waiting.resolve();
    expect(fs.existsSync(path.join(f.global, 'inbox', 'cache.json'))).toBe(false);
    await expect(f.service.list()).rejects.toThrow('stopping');
  } finally { waiting.resolve(); await f.close(); }
});
