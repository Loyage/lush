import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { PARAMS } from '../../src/rpc/registry.js';
import { settleNoticeAnswer } from '../../src/core/project/messages.js';
import { Project } from '../../src/core/project.js';
import { Store } from '../../src/persistence/store.js';
setDefaultTimeout(20000);

async function prepared(invoke = async () => {}) {
  let f;
  f = fixture({ async run(args) { if (args.task.role === 'manager') await invoke({ ...args, rpc: f.rpc }); return 'mock management result'; } });
  f.project.kick = () => {};
  await repo(f.root);
  f.rpc = new Dispatcher(f.project, { isRequested: () => false, request() {} }, {});
  f.target = (await f.project.order('ordinary target', 'main', [], null, false)).task;
  f.submit = options => f.project.submitManagementInstruction({ instruction: '管理当前项目的输入和运行诊断', ...options });
  f.run = async () => { f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise)); };
  f.state = manager => JSON.parse(f.store.task(manager.task?.id ?? manager.id).management);
  f.confirm = async noticeId => {
    expect(f.project.resolveManagementConfirmation(noticeId)).toBe(true);
    await Promise.all([...(f.project.managementControlJobs ?? [])]);
  };
  return f;
}
const approve = { answers: [{ selected: [1], custom: '' }] };
const reject = { answers: [{ selected: [0], custom: '' }] };
function controlViews(f, manager, phase) {
  const taskId = manager.task.id;
  return [f.project.managementView(taskId), f.project.inspect(taskId).management,
    f.project.hooksList().management_workers.find(row => row.id === taskId).management]
    .map(view => view[phase].control_calls);
}
function expectSafeControlNotice(f, manager, phase, noticeId, kind) {
  for (const calls of controlViews(f, manager, phase)) {
    expect(calls[0]).toMatchObject({ notice_id: noticeId, notice_kind: kind });
    for (const field of ['params','fingerprint','preflight_fingerprint','target_snapshot','request_id','result'])
      expect(calls[0]).not.toHaveProperty(field);
  }
}

test('immediate management input persists a unique authorized occurrence without signal, Git or development Input; replay uses original definition', async () => {
  let calls = 0;
  const f = await prepared(async ({ task }) => { calls++; expect(task.task_kind).toBe('management'); });
  try {
    const options = { instruction: '优化流程诊断', client_request_id: 'immediate-request' };
    const first = await f.rpc.dispatch('management.submit', { ...options, _token: null });
    expect(first).toMatchObject({ management: true, task: { status: 'queued', task_kind: 'management', input_id: null, branch: null } });
    expect(f.state(first).origin).toBe('input');
    expect(f.project.hookSignals().items).toEqual([]);
    expect(f.submit(options).task.id).toBe(first.task.id);
    expect(() => f.submit({ ...options, instruction: '不同目标' })).toThrow('different management definition');
    const inputs = f.store.get('SELECT count(*) AS n FROM inputs').n;
    await f.run();
    expect(calls).toBe(1); expect(f.store.task(first.task.id).status).toBe('completed');
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(inputs);
    expect(f.submit(options).task.id).toBe(first.task.id);
    expect(JSON.stringify(first)).not.toContain('creation_fingerprint');
  } finally { await f.close(); }
});

test('management catalogue discovers every registered function with real access levels and bounded history omits private provider material', async () => {
  let catalog, history, denied = [];
  const f = await prepared(async ({ token, rpc }) => {
    catalog = await rpc.dispatch('manager.catalog', { _token: token });
    history = await rpc.dispatch('manager.history', { limit: 1, _token: token });
    for (const request of [
      { method: 'agent.environment', params: { target: 'agent', scope: 'device' } },
      { method: 'worker.transcript', params: { id: f.target.id } },
      { method: 'system.summary', params: { _token: '' } },
      { method: 'worker.message', params: { id: f.target.id, body: 'x', profile: {} } },
      { method: 'agent.connections.remove', params: { id: 'account', scope: 'device' } },
    ]) {
      try { await rpc.dispatch('manager.call', { ...request, _token: token }); } catch { denied.push(request.method); }
    }
    await expect(rpc.dispatch('draft.add', { content: 'bypass', _token: token })).rejects.toThrow('requires user approval');
    await expect(rpc.dispatch('worker.inspect', { id: f.target.id, _token: token })).rejects.toThrow('dedicated');
  });
  try {
    const secretRun = f.store.startRun({ id: f.target.id, calls: 1, role: 'agent' }, { agent: 'mock' });
    f.store.finishRun(secretRun.id, 'completed', { result: 'PRIVATE_PROVIDER_OUTPUT', error: 'PRIVATE_PROVIDER_ERROR' });
    f.submit(); await f.run();
    expect(catalog.methods.length).toBe(Object.keys(PARAMS).length);
    expect(catalog.methods.find(item => item.method === 'draft.add').access).toBe('automatic');
    expect(catalog.methods.find(item => item.method === 'worker.cancel').access).toBe('confirmation');
    expect(catalog.methods.find(item => item.method === 'agent.environment').access).toBe('unavailable');
    expect(history.items).toHaveLength(1); expect(history.next_cursor).toBeNumber();
    expect(JSON.stringify(history)).not.toContain('PRIVATE_PROVIDER');
    expect(denied).toHaveLength(5);
    await expect(f.rpc.dispatch('manager.catalog')).rejects.toThrow('agent only');
  } finally { await f.close(); }
});

test('parent runtime diagnostics is a safe project-scoped manager read and retired manual command capabilities cannot reappear', async () => {
  let diagnostics;
  const f = await prepared(async ({ task, token, rpc }) => {
    const catalog = await rpc.dispatch('manager.catalog', { _token: token });
    expect(catalog.methods.find(item => item.method === 'system.diagnostics').access).toBe('read');
    for (const method of ['hooks.command_start','hooks.command_run']) {
      expect(catalog.methods.some(item => item.method === method)).toBe(false);
      await expect(rpc.dispatch('manager.call', { method, params: {}, _token: token })).rejects.toThrow('unknown management capability');
    }
    const run = f.store.get('SELECT id FROM agent_runs WHERE task_id=? ORDER BY id DESC LIMIT 1', task.id);
    const sessions = path.join(f.config.home, 'sessions'); fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(sessions, `fixture_lush-manager-${task.id}.jsonl`), JSON.stringify({ type: 'message',
      timestamp: new Date().toISOString(), lush: { task_id: task.id, run_id: run.id }, message: { role: 'assistant',
        content: [{ type: 'text', text: 'PRIVATE_SESSION_SECRET' }], usage: { input: 20, cacheRead: 10, cacheWrite: 7,
          output: 17, cost: { total: 0.0123 } } } }) + '\n', { mode: 0o600 });
    await expect(rpc.dispatch('system.diagnostics', { _token: token })).rejects.toThrow('requires user approval');
    diagnostics = await rpc.dispatch('manager.call', { method: 'system.diagnostics', params: {}, _token: token });
    expect(diagnostics).toMatchObject({ status: 'succeeded', result: { version: 1, currency: 'USD', estimated: true } });
    expect(diagnostics.result.windows[0]).toMatchObject({ input: 37, output: 17, cost: 0.0123, requests: 1 });
    expect(diagnostics.result.buckets).toHaveLength(60);
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_SESSION_SECRET');
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE task_id=? AND status='open'", task.id).n).toBe(0);
  });
  try {
    const manager = f.submit(); await f.run();
    expect(diagnostics.status).toBe('succeeded'); expect(f.store.task(manager.task.id).status).toBe('completed');
    expect(f.state(manager).control_calls ?? []).toHaveLength(0);
  } finally { await f.close(); }
});

test('reviewed automatic draft and append operations use original engines, preserve invocation identity, and deduplicate exact request keys', async () => {
  let replies;
  const f = await prepared(async ({ token, rpc }) => {
    const params = { content: '面板开发想法', branch: 'main' };
    const first = await rpc.dispatch('manager.call', { method: 'draft.add', params, request_id: 'save-idea', _token: token });
    const second = await rpc.dispatch('manager.call', { method: 'draft.add', params, request_id: 'save-idea', _token: token });
    expect(second).toEqual(first);
    await expect(rpc.dispatch('manager.call', { method: 'draft.add', params: { ...params, content: 'changed' }, request_id: 'save-idea', _token: token })).rejects.toThrow('different');
    const append = await rpc.dispatch('manager.call', { method: 'worker.message', params: { id: f.target.id, body: '追加要求' }, _token: token });
    replies = [first, append];
    await expect(rpc.dispatch('manager.call', { method: 'worker.configure', params: { id: f.target.id, profile: { env: { API_KEY: 'PRIVATE' } } }, _token: token })).rejects.toThrow('private');
  });
  try {
    const manager = f.submit(); await f.run();
    expect(replies.map(reply => reply.status)).toEqual(['succeeded','succeeded']);
    expect(f.store.draftCount()).toBe(1);
    expect(f.store.get('SELECT body FROM messages WHERE task_id=? ORDER BY id DESC LIMIT 1', f.target.id).body).toBe('追加要求');
    expect(f.store.task(manager.task.id).status).toBe('completed');
    expect(JSON.stringify(f.project.inspect(manager.task.id))).not.toContain('save-idea');
  } finally { await f.close(); }
});

for (const outcome of ['approve','reject','dismiss','lush','custom','stale']) test(`dangerous management cancellation requires exact current user confirmation: ${outcome}`, async () => {
  let receipt;
  const f = await prepared(async ({ token, rpc }) => {
    receipt = await rpc.dispatch('manager.call', { method: 'worker.cancel', params: { id: f.target.id }, request_id: 'cancel-fixed', _token: token });
    expect(receipt.status).toBe('pending_confirmation');
    expect(f.store.task(f.target.id).status).toBe('paused');
  });
  try {
    const manager = f.submit(); await f.run();
    expect(f.store.task(manager.task.id).status).toBe('awaiting');
    expect(f.state(manager).pending_signal.phase).toBe('returned');
    const notice = f.store.get('SELECT * FROM notices WHERE id=?', receipt.notice_id);
    expect(notice.title).toBe('Valet V1 操作确认：worker.cancel');
    expect(JSON.parse(notice.body).body).toContain('Valet V1 请求执行 worker.cancel');
    expect(JSON.parse(notice.body).body).toContain(JSON.stringify({ id: f.target.id }, null, 2));
    expectSafeControlNotice(f, manager, 'pending_signal', notice.id, 'questionnaire');
    let modelWakes = 0;
    const wake = f.project.wake.bind(f.project);
    f.project.wake = targetId => { if (targetId === manager.task.id) modelWakes++; return wake(targetId); };
    if (outcome === 'stale') f.store.update(f.target.id, { status: 'failed' });
    if (outcome === 'dismiss') f.project.answer(notice.id, '', true);
    else if (outcome === 'lush') settleNoticeAnswer(f.project, notice.id, approve, false, 'lush');
    else f.project.answer(notice.id, outcome === 'reject' ? reject : outcome === 'custom' ? { answers: [{ selected: [], custom: '同意' }] } : approve);
    await f.confirm(notice.id);
    expect(f.state(manager).control_calls[0].status).toBe(outcome === 'approve' ? 'succeeded' : outcome === 'stale' ? 'failed' : 'rejected');
    expectSafeControlNotice(f, manager, 'last_execution', notice.id, 'questionnaire');
    expect(f.store.task(f.target.id).status).toBe(outcome === 'approve' ? 'cancelled' : outcome === 'stale' ? 'failed' : 'paused');
    expect(modelWakes).toBe(0);
    expect(f.store.get(`SELECT consumed FROM messages WHERE task_id=?
      AND CASE WHEN json_valid(body) THEN json_extract(body,'$.notice_id') END=?`, manager.task.id, notice.id).consumed).toBe(1);
    const events = f.store.get("SELECT count(*) AS n FROM events WHERE type='management.capability_started'").n;
    await f.confirm(notice.id);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='management.capability_started'").n).toBe(events);
  } finally { await f.close(); }
});

test('control notice kinds come only from same-identity Notice facts and missing or unknown kinds stay null', async () => {
  let receipt;
  const f = await prepared(async ({ token, rpc }) => {
    receipt = await rpc.dispatch('manager.call', { method: 'worker.cancel', params: { id: f.target.id }, _token: token });
  });
  try {
    const manager = f.submit(); await f.run();
    const state = f.state(manager);
    state.control_calls[0].notice_kind = 'info'; // A stale private cache is not a Notice fact.
    f.store.update(manager.task.id, { management: JSON.stringify(state) });
    const before = f.store.task(manager.task.id);
    for (const kind of ['questionnaire','question','plan','info','unknown']) {
      f.store.run('UPDATE notices SET kind=? WHERE id=?', kind, receipt.notice_id);
      expectSafeControlNotice(f, manager, 'pending_signal', receipt.notice_id, kind === 'unknown' ? null : kind);
    }
    f.store.run('UPDATE notices SET kind=?,task_id=? WHERE id=?', 'questionnaire', f.target.id, receipt.notice_id);
    expectSafeControlNotice(f, manager, 'pending_signal', receipt.notice_id, null);
    f.store.run('UPDATE notices SET task_id=? WHERE id=?', manager.task.id, receipt.notice_id);
    expectSafeControlNotice(f, manager, 'pending_signal', receipt.notice_id, 'questionnaire');
    f.store.run('DELETE FROM notices WHERE id=?', receipt.notice_id);
    expectSafeControlNotice(f, manager, 'pending_signal', receipt.notice_id, null);
    expect(f.store.task(manager.task.id)).toEqual(before); // Projection never rewrites private receipts.
  } finally { await f.close(); }
});

for (const change of ['dirty','params']) test(`confirmation rejects changed resource or private fixed request: ${change}`, async () => {
  let receipt;
  const f = await prepared(async ({ token, rpc }) => {
    receipt = await rpc.dispatch('manager.call', { method: 'worker.cancel', params: { id: f.target.id }, _token: token });
  });
  try {
    const manager = f.submit(); await f.run();
    if (change === 'dirty') {
      const fs = await import('node:fs');
      fs.writeFileSync(path.join(f.store.task(f.target.id).workspace, 'file.txt'), 'uncommitted change');
    } else {
      const state = f.state(manager); state.control_calls[0].params = { id: manager.task.id };
      f.store.update(manager.task.id, { management: JSON.stringify(state) });
    }
    f.project.answer(receipt.notice_id, approve); await f.confirm(receipt.notice_id);
    expect(f.state(manager).control_calls[0].status).toBe('failed');
    expect(f.store.task(f.target.id).status).toBe('paused');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='management.capability_started'").n).toBe(0);
  } finally { await f.close(); }
});

test('shutdown begun during async preflight leaves an unstarted approval durable until a safe retry', async () => {
  const f = await prepared(async ({ token, rpc }) => {
    await rpc.dispatch('manager.call', { method: 'worker.cancel', params: { id: f.target.id }, _token: token });
  });
  try {
    const manager = f.submit(); await f.run();
    const notice = f.store.get("SELECT * FROM notices WHERE task_id=? AND status='open'", manager.task.id);
    f.project.answer(notice.id, approve);
    f.project.stopping = true; // Before the async resource preflight resumes.
    await Promise.all([...f.project.managementControlJobs]);
    let call = f.state(manager).control_calls[0];
    expect(call.status).toBe('approved'); expect(call.started_at).toBeUndefined();
    expect(f.store.task(f.target.id).status).toBe('paused');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='management.capability_started'", manager.task.id).n).toBe(0);
    f.project.stopping = false;
    await f.project.executeManagementCapability(manager.task.id, call.receipt_id);
    call = f.state(manager).control_calls[0];
    expect(call.status).toBe('succeeded'); expect(f.store.task(f.target.id).status).toBe('cancelled');
  } finally { await f.close(); }
});

test('side-effect exceptions become durable unknown with sanitized diagnostics and cannot re-dispatch under the same request identity', async () => {
  let receipt;
  const f = await prepared(async ({ token, rpc }) => {
    receipt = await rpc.dispatch('manager.call', { method: 'worker.cancel', params: { id: f.target.id }, _token: token });
  });
  try {
    const manager = f.submit(); await f.run(); let attempts = 0;
    f.project.managementDispatch = async () => { attempts++; throw new Error('PRIVATE_AUTH_RESPONSE'); };
    f.project.answer(receipt.notice_id, approve); await f.confirm(receipt.notice_id);
    expect(f.state(manager).control_calls[0].status).toBe('unknown');
    expect(f.state(manager).state).toBe('unknown');
    expect(JSON.stringify(f.project.inspect(manager.task.id))).not.toContain('PRIVATE_AUTH_RESPONSE');
    await f.project.executeManagementCapability(manager.task.id, receipt.receipt_id);
    expect(attempts).toBe(1); expect(f.project.managementControlJobs.size).toBe(0);
  } finally { await f.close(); }
});

test('deletion must carry exact resource preview before creating an authorization request', async () => {
  let submitted = false;
  const f = await prepared(async ({ token, rpc }) => {
    await expect(rpc.dispatch('manager.call', { method: 'worker.delete', params: { id: f.target.id, revision: 'old', confirm: true }, _token: token })).rejects.toThrow('current resource preview');
    submitted = true;
  });
  try {
    f.project.cancel(f.target.id);
    f.submit(); await f.run();
    expect(submitted).toBe(true);
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE kind='questionnaire'").n).toBe(0);
    expect(f.store.task(f.target.id).status).toBe('cancelled');
  } finally { await f.close(); }
});

test('confirmation identification is pure, exact and synchronous while execution remains tracked asynchronous work', async () => {
  let receipt;
  const f = await prepared(async ({ token, rpc }) => {
    receipt = await rpc.dispatch('manager.call', { method: 'worker.cancel', params: { id: f.target.id }, _token: token });
  });
  try {
    const manager = f.submit(); await f.run();
    const revision = f.project.managementView(manager.task.id).revision;
    const events = f.store.get('SELECT count(*) AS n FROM events').n;
    expect(f.project.isManagementConfirmationNotice(receipt.notice_id)).toBe(true);
    expect(f.project.isManagementConfirmationNotice(-1)).toBe(false);
    const fake = f.store.run("INSERT INTO notices(task_id,title,body,kind) VALUES (?,'管理操作确认：worker.cancel','{}','questionnaire')", manager.task.id);
    expect(f.project.isManagementConfirmationNotice(Number(fake.lastInsertRowid))).toBe(false);
    expect(f.project.resolveManagementConfirmation(Number(fake.lastInsertRowid))).toBe(false);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(events);
    expect(f.project.managementView(manager.task.id).revision).toBe(revision);
    expect(f.project.resolveManagementConfirmation(receipt.notice_id)).toBe(true);
    await Promise.all([...(f.project.managementControlJobs ?? [])]);
    expect(f.state(manager).control_calls[0].status).toBe('pending_confirmation');
    f.project.answer(receipt.notice_id, approve); await f.confirm(receipt.notice_id);
    expect(f.state(manager).control_calls[0].status).toBe('succeeded');
  } finally { await f.close(); }
});

for (const method of ['hooks.auto_select']) test(`device-only legacy alias ${method} requires explicit scope and exact confirmation`, async () => {
  let receipt;
  const f = await prepared(async ({ token, rpc }) => {
    const params = method === 'hooks.auto_select'
      ? { enabled: false, expected_revision: f.project.daemonHooks().revision }
      : { enabled: false, level: 'merge', expected_revision: f.project.completionDefaults().revision };
    await expect(rpc.dispatch('manager.call', { method, params, _token: token })).rejects.toThrow('explicit scope');
    receipt = await rpc.dispatch('manager.call', { method, params: { ...params, scope: 'device' }, _token: token });
  });
  try {
    const manager = f.submit({ instruction: '管理设备全局自动化设置' }); await f.run();
    expect(f.state(manager).control_calls[0].params.scope).toBe('device');
    f.project.answer(receipt.notice_id, approve); await f.confirm(receipt.notice_id);
    expect(f.state(manager).control_calls[0].status).toBe('succeeded');
  } finally { await f.close(); }
});

test('non-secret device configuration is actually written only after user confirmation, and idle-only shutdown is honestly unavailable', async () => {
  let receipt, catalog;
  const f = await prepared(async ({ token, rpc }) => {
    catalog = await rpc.dispatch('manager.catalog', { _token: token });
    receipt = await rpc.dispatch('manager.call', { method: 'system.configure', params: { settings: { max_depth: 5 }, scope: 'device' }, _token: token });
    await expect(rpc.dispatch('manager.call', { method: 'system.stop_if_idle', params: {}, _token: token })).rejects.toThrow('自身占用');
  });
  try {
    const manager = f.submit({ instruction: '设备共享设置修改最大拆解深度' }); await f.run();
    expect(f.config.maxDepth).not.toBe(5);
    expect(catalog.methods.find(item => item.method === 'system.stop_if_idle').access).toBe('unavailable');
    expect(catalog.methods.find(item => item.method === 'system.stop').access).toBe('confirmation');
    expect(catalog.methods.find(item => item.method === 'agent.configure').access).toBe('confirmation');
    f.project.answer(receipt.notice_id, approve); await f.confirm(receipt.notice_id);
    expect(f.state(manager).control_calls[0].status).toBe('succeeded');
    expect(f.config.maxDepth).toBe(5);
  } finally { await f.close(); }
});

test('integrated emission runtime persists reviewed manager conditions without creating a Worker or granting direct Agent RPC access', async () => {
  let receipt, stored;
  const f = await prepared(async ({ token, rpc }) => {
    const catalogue = await rpc.dispatch('manager.catalog', { _token: token });
    for (const method of ['input.emit','input.emission_cancel','input.exclusive_release'])
      expect(catalogue.methods.find(item => item.method === method).access).toBe('automatic');
    const definition = { content: 'after refactor', conditions: [{ kind: 'worker_merged', worker_id: f.target.id }], client_request_id: 'once-emission' };
    const inputs = f.store.get('SELECT count(*) AS n FROM inputs').n;
    const workers = f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind IN ('order','child')").n;
    receipt = await rpc.dispatch('manager.call', { method: 'input.emit', params: definition, _token: token });
    expect(await rpc.dispatch('manager.call', { method: 'input.emit', params: definition, _token: token })).toEqual(receipt);
    stored = await rpc.dispatch('manager.call', { method: 'input.get', params: { kind: 'draft', id: receipt.result.draft_id }, _token: token });
    expect(stored.result).toMatchObject({ content: definition.content, mode: 'order', conditions: definition.conditions,
      dispatch: { state: 'waiting_conditions', conditions: [{ kind: 'worker_merged', worker_id: f.target.id, satisfied: false }] } });
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(inputs);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind IN ('order','child')").n).toBe(workers);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='input.emitted'").n).toBe(1);
    await expect(rpc.dispatch('input.emit', { ...definition, _token: token })).rejects.toThrow('requires user approval');
  });
  try {
    f.submit(); await f.run();
    expect(receipt).toMatchObject({ status: 'succeeded', result: { emitted: true, draft_id: stored.result.id, submitted: true } });
    expect(f.project.inputEmissionResult(receipt.result.draft_id).dispatch.state).toBe('waiting_conditions');
  } finally { await f.close(); }
});

test('device operations require explicit user instruction and scope, approved side effects return only narrow receipts, and raw errors never escape', async () => {
  let receipt;
  const f = await prepared(async ({ token, rpc }) => {
    await expect(rpc.dispatch('manager.call', { method: 'system.configure', params: { settings: {} }, _token: token })).rejects.toThrow('explicit scope');
    receipt = await rpc.dispatch('manager.call', { method: 'system.configure', params: { settings: {}, scope: 'device' }, _token: token });
  });
  try {
    const manager = f.submit({ instruction: '设备共享设置管理' }); await f.run();
    f.project.managementDispatch = async () => ({ config: { token: 'PRIVATE_TOKEN' }, credential: 'PRIVATE_CREDENTIAL' });
    f.project.answer(receipt.notice_id, approve); await f.confirm(receipt.notice_id);
    expect(f.state(manager).control_calls[0].result).toEqual({ submitted: true });
    expect(JSON.stringify(f.project.inspect(manager.task.id))).not.toContain('PRIVATE');
  } finally { await f.close(); }
});

test('ordinary development actors cannot use manager-only history/call/catalog and ended manager tokens cannot regain authority', async () => {
  let token;
  const f = await prepared(async args => { token = args.token; });
  try {
    const manager = f.submit(); await f.run();
    await expect(f.rpc.dispatch('manager.catalog', { _token: token })).rejects.toThrow();
    for (const method of ['managementCapabilityCatalog','managementHistory']) expect(() => f.project[method](f.target.id)).toThrow('only a management');
    await expect(f.project.callManagementCapability(f.target.id, 'draft.add', { content: 'bad' })).rejects.toThrow('only a management');
    expect(() => f.project.managementHistory(manager.task.id)).toThrow('not active');
  } finally { await f.close(); }
});

test('interrupted started capability effects recover as unknown and never re-dispatch; unstarted immediate management occurrence survives recovery', async () => {
  const f = await prepared(); let other, store;
  try {
    const waiting = f.submit({ client_request_id: 'pending-management' });
    const broken = f.submit({ client_request_id: 'unknown-management' });
    const state = f.state(broken);
    state.pending_signal.phase = 'returned'; state.state = 'waiting_actions';
    state.control_calls = [{ receipt_id: 10000, method: 'worker.cancel', params: { id: f.target.id }, status: 'running', occurrence_id: state.pending_signal.id }];
    f.store.update(broken.task.id, { status: 'waiting', management: JSON.stringify(state) });
    await f.project.shutdown();
    store = new Store(path.join(f.config.home, 'project.db'), f.root);
    other = new Project(f.config, store, { run: () => 'mock' }); other.kick = () => {};
    other.recover();
    expect(store.task(waiting.task.id).status).toBe('queued');
    expect(JSON.parse(store.task(broken.task.id).management).state).toBe('unknown');
    expect(JSON.parse(store.task(broken.task.id).management).control_calls[0].status).toBe('unknown');
    expect(store.task(f.target.id).status).toBe('paused');
  } finally { await other?.shutdown(); store?.close(); await f.close(); }
});
