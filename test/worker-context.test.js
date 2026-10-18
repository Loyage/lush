import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, gate } from './helpers.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { RPCServer } from '../src/rpc/server.js';
import { createSignal } from '../src/signal.js';
import { tokenHash } from '../src/core/project/internal.js';
import { CONTEXT_PARAMETERS } from '../src/core/worker-context.js';

function active(f, task, token = `context-token-${task.id}`) {
  f.store.update(task.id, { status: 'running' }); f.store.armAgent(task.id, tokenHash(token));
  f.project.running.set(task.id, { token, controller: new AbortController() });
  return token;
}
function hierarchy(f) {
  const create = (goal, parent, kind = parent ? 'child' : 'order') => f.store.create({ role: 'agent', task_kind: kind, goal,
    ...(parent ? { parent_id: parent.id } : {}) });
  const parent = create('parent'), self = create('self', parent), sibling = create('SIBLING_SECRET', parent);
  const child = create('child', self), grandchild = create('GRANDCHILD_SECRET', child), unrelated = create('UNRELATED_SECRET');
  return { create, parent, self, sibling, child, grandchild, unrelated };
}

test('raw RPC scope rejects project enumeration and unrelated/sibling/grandchild targets; user reads unchanged', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const h = hierarchy(f), token = active(f, h.self), rpc = new Dispatcher(f.project);
    const call = (method, params = {}) => rpc.dispatch(method, { ...params, _token: token });
    for (const method of ['system.status','system.summary','worker.list','worker.tree','worker.graph','worker.activity',
      'worker.page','graph.get','branch.tree','branch.show','notice.list','notice.page','worker.relations','worker.reading_page',
      'worker.runs_page','worker.artifacts_page','worker.artifact']) {
      await expect(call(method, method === 'branch.show' ? { branch: 'main' } : {})).rejects.toThrow('user approval');
    }
    for (const target of [h.unrelated, h.sibling, h.grandchild]) {
      for (const method of ['worker.inspect','worker.diff','worker.history','worker.history_page','worker.transcript',
        'worker.usage','worker.progress_history']) {
        await expect(call(method, { id: target.id })).rejects.toThrow('only self, parent and direct children');
      }
      for (const method of ['context.inspect','context.history','context.transcript']) {
        await expect(call(method, { relation: 'child', child: target.id })).rejects.toThrow('direct children');
      }
      await expect(call('context.message', { relation: 'child', child: target.id, body: 'no' })).rejects.toThrow('direct children');
      await expect(call('context.accept', { child: target.id })).rejects.toThrow('direct children');
      expect(f.store.unread(target.id)).toEqual([]);
    }
    for (const task of [h.self, h.parent, h.child]) {
      expect((await call('worker.inspect', { id: task.id })).id).toBe(task.id);
    }
    expect((await rpc.dispatch('worker.inspect', { id: h.parent.id })).children.map(row => row.id)).toContain(h.sibling.id);
    expect((await rpc.dispatch('worker.list')).map(row => row.id)).toContain(h.unrelated.id);
    // Server-side number lookup is subject to exactly the same relation check.
    f.store.run('UPDATE tasks SET worker_number=? WHERE id=?', 'W900-1', h.sibling.id);
    f.store.run('UPDATE tasks SET worker_number=? WHERE id=?', 'W900-2', h.child.id);
    await expect(call('worker.lookup', { number: 'W900-1' })).rejects.toThrow('only self, parent and direct children');
    await expect(call('context.inspect', { relation: 'child', child: 'W900-1' })).rejects.toThrow('direct children');
    expect(await call('worker.lookup', { number: 'W900-2' })).toMatchObject({ id: h.child.id });
    expect((await call('context.inspect', { relation: 'child', child: 'W900-2' })).id).toBe(h.child.id);
  } finally { f.project.running.clear(); await f.close(); }
});

test('relation inspect/history do not return nested siblings/descendants; child and Notice pagination is complete', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const h = hierarchy(f), token = active(f, h.self), rpc = new Dispatcher(f.project);
    const call = (method, params = {}) => rpc.dispatch(method, { ...params, _token: token });
    f.store.event(h.parent.id, 'fixture.nested', { children: [h.sibling] });
    f.store.event(h.child.id, 'fixture.nested', { descendants: [h.grandchild] });
    for (const [relation, task] of [['parent', h.parent], ['child', h.child]]) {
      const params = { relation, ...(relation === 'child' ? { child: task.id } : {}) };
      const detail = await call('context.inspect', params);
      expect(detail).toMatchObject({ id: task.id, coverage: 'worker_context' });
      expect(detail).not.toHaveProperty('children'); expect(detail).not.toHaveProperty('deps');
      expect(JSON.stringify(detail)).not.toMatch(/SIBLING_SECRET|GRANDCHILD_SECRET/);
      for (const method of ['context.history','worker.history','worker.history_page']) {
        const value = await call(method, method === 'context.history' ? params : { id: task.id });
        expect(JSON.stringify(value)).not.toMatch(/SIBLING_SECRET|GRANDCHILD_SECRET/);
      }
    }
    for (let i = 0; i < 212; i++) h.create(`page-child-${i}`, h.self);
    const expected = f.store.children(h.self.id).map(row => row.id), received = [];
    let after = 0;
    for (;;) {
      const page = await call('context.children', { after, limit: 17 });
      expect(page.total).toBe(expected.length); expect(page.items.length).toBeLessThanOrEqual(17);
      expect(page.items.every(row => row.parent_id === h.self.id)).toBe(true);
      received.push(...page.items.map(row => row.id));
      if (!page.has_more) break;
      expect(page.cursor).toBeGreaterThan(after); after = page.cursor;
    }
    expect(received).toEqual(expected); expect(new Set(received).size).toBe(expected.length);
    for (let i = 0; i < 113; i++) f.project.notice(h.self.id, `own-${i}`, '', 'info');
    f.project.notice(h.sibling.id, 'OTHER_NOTICE_SECRET', '', 'info');
    const ids = [], own = f.store.all('SELECT id FROM notices WHERE task_id=? ORDER BY id DESC', h.self.id).map(row => row.id);
    let before;
    for (;;) {
      const page = await call('context.notices', { ...(before === undefined ? {} : { before }), limit: 13 });
      expect(page.notices.every(row => row.task_id === h.self.id)).toBe(true);
      ids.push(...page.notices.map(row => row.id));
      expect(JSON.stringify(page)).not.toContain('OTHER_NOTICE_SECRET');
      if (!page.has_more) break;
      expect(before === undefined || page.cursor < before).toBe(true); before = page.cursor;
    }
    expect(ids).toEqual(own);
    for (let i = 0; i < 105; i++) f.store.event(h.self.id, 'fixture.history', { nested: h.sibling });
    const events = []; after = 0;
    for (;;) {
      const page = await call('context.history', { after });
      expect(JSON.stringify(page)).not.toContain('SIBLING_SECRET');
      events.push(...page.events.map(row => row.id));
      if (!page.has_more) break;
      expect(page.next).toBeGreaterThan(after); after = page.next;
    }
    expect(events).toEqual(f.store.all('SELECT id FROM events WHERE task_id=? ORDER BY id', h.self.id).map(row => row.id));
  } finally { f.project.running.clear(); await f.close(); }
});

test('context requires actual invocation/token, rejects forged/unknown identities and preserves write restrictions', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const h = hierarchy(f), token = active(f, h.self), rpc = new Dispatcher(f.project);
    for (const method of Object.keys(CONTEXT_PARAMETERS)) {
      await expect(rpc.dispatch(method)).rejects.toThrow('agent only');
      await expect(rpc.dispatch(method, { _token: 'expired' })).rejects.toThrow('invalid or expired');
      await expect(rpc.dispatch(method, { _token: token, id: h.unrelated.id })).rejects.toThrow('unknown parameter');
    }
    const call = (method, params = {}) => rpc.dispatch(method, { ...params, _token: token });
    await expect(call('context.inspect', { relation: 'parent', child: h.sibling.id })).rejects.toThrow('child is required only');
    await expect(call('context.inspect', { relation: 'child' })).rejects.toThrow('child is required only');
    await expect(call('context.inspect', { relation: 'sibling' })).rejects.toThrow('invalid context relation');
    for (const params of [{ after: -1 }, { after: '0' }, { limit: 201 }, { limit: 0 }, { limit: 1.5 }])
      await expect(call('context.children', params)).rejects.toThrow('invalid context');
    await expect(call('context.notices', { limit: 101 })).rejects.toThrow('invalid context');
    await expect(call('context.transcript', { after: -1 })).rejects.toThrow('invalid context');
    await expect(call('context.message', { relation: 'self', body: 'no' })).rejects.toThrow('invalid context relation');
    await call('context.message', { relation: 'parent', body: 'real sender' });
    expect(f.store.unread(h.parent.id)).toMatchObject([{ sender_id: h.self.id, body: 'real sender' }]);
    await expect(call('context.accept', { child: h.child.id })).rejects.toThrow('delivered');
    // Historical analysis cannot turn a generic context entry into delegation.
    const analysis = h.create('analysis', h.parent, 'analysis'), analysisToken = active(f, analysis);
    await expect(rpc.dispatch('context.spawn', { goal: 'forbidden', _token: analysisToken })).rejects.toThrow('only order/child');
    const owner = h.create('owner', null, 'owner'), owned = h.create('owned order', owner, 'order'), ownedToken = active(f, owned);
    await expect(rpc.dispatch('context.message', { relation: 'parent', body: 'no owner inbox', _token: ownedToken })).rejects.toThrow();
    const run = f.project.running.get(h.self.id);
    run.token = 'different invocation';
    await expect(call('context.inspect')).rejects.toThrow('invalid or expired');
    run.token = token; run.invocationEnded = true;
    await expect(call('context.inspect')).rejects.toThrow('invalid or expired');
    run.invocationEnded = false; run.parked = true;
    await expect(call('context.inspect')).rejects.toThrow('no longer active');
    run.parked = false; run.controller.abort();
    await expect(call('context.inspect')).rejects.toThrow('no longer active');
  } finally { f.project.running.clear(); await f.close(); }
});

test('context child acceptance uses original delivered/unread/cleanliness safety gates without force or subtree result leakage', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    await repo(f.root);
    const parent = (await f.project.order('accept parent', 'main', [], null, false)).task;
    const child = await f.project.spawn(parent.id, 'delivered child');
    const token = active(f, parent), rpc = new Dispatcher(f.project);
    const accept = extra => rpc.dispatch('context.accept', { child: child.id, _token: token, ...extra });
    await expect(accept({ force: true })).rejects.toThrow('unknown parameter');
    f.store.update(child.id, { status: 'awaiting_acceptance', result: 'fixture delivered', reservation: null });
    fs.writeFileSync(path.join(child.workspace, 'dirty.txt'), 'uncommitted');
    await expect(accept()).rejects.toThrow();
    expect(fs.existsSync(child.workspace)).toBe(true);
    fs.unlinkSync(path.join(child.workspace, 'dirty.txt'));
    f.project.message(child.id, 'must process before acceptance', parent.id);
    f.store.update(child.id, { status: 'awaiting_acceptance', reservation: null });
    await expect(accept()).rejects.toThrow('unread input');
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', child.id);
    const result = await accept();
    expect(result).toMatchObject({ id: child.id, status: 'completed', coverage: 'worker_context' });
    expect(result).not.toHaveProperty('children'); expect(result).not.toHaveProperty('resources');
    expect(fs.existsSync(child.workspace)).toBe(false);
    expect(f.store.get("SELECT id FROM events WHERE task_id=? AND type='task.accepted'", child.id)).not.toBeNull();
  } finally { f.project.running.clear(); await f.close(); }
});

test('runtime-issued invocation -> shipped bin -> RPC registration -> real spawn/message/Notice effects and expired-token rejection', async () => {
  const entered = gate(), finish = gate(); let runtimeToken, result, failure;
  const f = fixture({ async run({ task, token }) {
    runtimeToken = token;
    const cli = async (...args) => {
      const proc = Bun.spawn([path.resolve(import.meta.dir, '../bin/lushw'), '--json', ...args], { cwd: task.workspace,
        env: { ...f.config.env, LUSH_PROJECT: f.root, LUSH_HOME: f.config.home, LUSH_TASK_ID: '9007199254740991', LUSH_AGENT_TOKEN: token },
        stdout: 'pipe', stderr: 'pipe' });
      const [out, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code) throw Error(error); return JSON.parse(out);
    };
    try {
      const self = await cli('self','inspect');
      const child = await cli('children','spawn','runtime delegated child','--name','runtime-child');
      await cli('children','message', String(child.id), 'runtime message');
      const notice = await cli('self','notice','post','runtime notice','--kind','info');
      result = { self, child, notice };
    } catch (error) { failure = error; }
    entered.resolve(); await finish.promise; return 'runtime CLI verified';
  } });
  let rpc;
  try {
    f.project.kick = () => {}; await repo(f.root);
    rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await rpc.start();
    const task = (await f.project.order('runtime context', 'main', [], null, false)).task;
    f.store.update(task.id, { status: 'queued' }); f.project.pump();
    await entered.promise; if (failure) throw failure;
    expect(result.self.id).toBe(task.id);
    expect(f.store.task(result.child.id).parent_id).toBe(task.id);
    expect(f.store.unread(result.child.id)).toMatchObject([{ sender_id: task.id, body: 'runtime message' }]);
    expect(f.store.get('SELECT task_id,title FROM notices WHERE id=?', result.notice.id)).toEqual({ task_id: task.id, title: 'runtime notice' });
    const run = f.project.running.get(task.id); finish.resolve(); await run.promise;
    await expect(new Dispatcher(f.project).dispatch('context.inspect', { _token: runtimeToken })).rejects.toThrow('invalid or expired');
  } finally { finish.resolve(); await rpc?.close(); await f.close(); }
});

test('real fixed integration membership permits member reads only, never project enumeration, spawn or messages', async () => {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  try {
    await repo(f.root); await f.project.bootstrapMain();
    const source = (await f.project.order('fixed member', 'main', [], null, false)).task;
    fs.writeFileSync(path.join(source.workspace, 'member.txt'), 'fixed member\n');
    await git(source.workspace, 'add', '.'); await git(source.workspace, 'commit', '-m', 'member');
    await f.project.workspaces.finish(f.store.task(source.id));
    f.store.update(source.id, { status: 'waiting', result: 'member result', reservation: null });
    const unrelated = (await f.project.order('not in fixed membership', 'main', [], null, false)).task;
    const plan = await f.project.branchIntegratePlan('main');
    const started = await f.project.branchIntegrateStart('main', plan.revision);
    const helper = f.store.task(started.worker.id), token = active(f, helper), rpc = new Dispatcher(f.project);
    const call = (method, params = {}) => rpc.dispatch(method, { ...params, _token: token });
    expect((await call('worker.inspect', { id: source.id })).id).toBe(source.id);
    expect(await call('worker.lookup', { number: source.worker_number })).toMatchObject({ id: source.id });
    for (const method of ['worker.inspect','worker.history','worker.transcript'])
      await expect(call(method, { id: unrelated.id })).rejects.toThrow('fixed integration membership');
    for (const [method, params] of [['context.spawn', { goal: 'no' }], ['worker.spawn', { parent: helper.id, goal: 'no' }],
      ['context.message', { relation: 'parent', body: 'no' }], ['worker.message', { id: source.id, body: 'no' }],
      ['context.children', {}], ['context.accept', { child: source.id }]])
      await expect(call(method, params)).rejects.toThrow('integration agents can only');
    for (const method of ['system.summary','worker.list','worker.tree','worker.graph','branch.tree','notice.page'])
      await expect(call(method)).rejects.toThrow('user approval');
    f.store.run('UPDATE integration_members SET source_commit=? WHERE run_id=?', '0'.repeat(40), started.id);
    await expect(call('worker.inspect', { id: source.id })).rejects.toThrow('fixed attempt');
  } finally { f.project.running.clear(); await f.close(); }
});
