import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { LUSHC_METHODS } from '../../src/cli/catalog.js';
import { PARAMS } from '../../src/rpc/registry.js';
import { cliCatalog } from '../../src/rpc/cli-catalog.js';
import { managementPolicy, effectiveManagementPolicy } from '../../src/rpc/management-policy.js';
import { managementSafeResult } from '../../src/core/project/management-control.js';
import { settleNoticeAnswer } from '../../src/core/project/messages.js';

const approval = { answers: [{ selected: [1], custom: '' }] };
async function prepared(invoke = async () => {}) {
  let f;
  f = fixture({ async run(args) {
    if (args.task.task_kind === 'management') await invoke({ ...args, rpc: f.rpc });
    return 'model-free result';
  } });
  f.project.kick = () => {};
  await repo(f.root);
  f.rpc = new Dispatcher(f.project, { isRequested: () => false }, {});
  f.parent = (await f.project.order('development parent', 'main', [], null, false)).task;
  f.other = (await f.project.order('unrelated development target', 'main', [], null, false)).task;
  f.state = task => JSON.parse(f.store.task(task.id).management);
  f.run = async () => { f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise)); };
  f.confirm = async (notice, answer = approval, source = 'user') => {
    settleNoticeAnswer(f.project, notice, answer, false, source);
    await Promise.all([...(f.project.managementControlJobs ?? [])]);
  };
  return f;
}

const request = (rpc, token, method, params, request_id) => rpc.dispatch('manager.call', { method, params, _token: token,
  ...(request_id ? { request_id } : {}) });

test('every catalogue-derived lushc RPC is reviewed for new Valets; old missing/denied snapshot entries fail closed', async () => {
  const f = await prepared();
  try {
    const permissions = f.project.managementPermissions();
    const development = cliCatalog().commands.filter(entry => entry.executable === 'lushc' && !entry.directory);
    expect(development.length).toBeGreaterThan(0);
    expect([...new Set(development.flatMap(entry => entry.rpc.map(rpc => rpc.method)))].sort()).toEqual([...LUSHC_METHODS].sort());
    for (const entry of development) {
      expect(entry.path).toBe(`lushc ${entry.command_path}`);
      for (const rpc of entry.rpc) expect(rpc.base_access).toBe(permissions.permissions[rpc.method]);
    }
    for (const method of LUSHC_METHODS) {
      expect(Object.hasOwn(PARAMS, method)).toBe(true);
      expect(['read','automatic','confirmation']).toContain(managementPolicy(method).access);
      expect(permissions.permissions[method]).toBe(managementPolicy(method).access);
      expect(effectiveManagementPolicy(method, { permissions: {} }).access).toBe('unavailable');
      expect(effectiveManagementPolicy(method, { permissions: { [method]: 'unavailable' } }).access).toBe('unavailable');
    }
    expect(permissions.permissions['worker.accept']).toBe('confirmation');
    for (const method of ['worker.spawn', 'worker.auto_title', 'notice.post', 'progress.plan']) {
      expect(permissions.permissions[method]).toBe('automatic');
      expect(effectiveManagementPolicy(method).access).toBe('unavailable');
    }
    const old = f.project.submitManagementInstruction({ instruction: 'old frozen manager' }).task;
    const state = f.state(old);
    for (const method of ['worker.spawn', 'progress.plan', 'worker.auto_title', 'notice.post']) state.permissions_snapshot.permissions[method] = 'unavailable';
    f.store.update(old.id, { management: JSON.stringify(state) });
    const original = f.store.task(old.id).management;
    f.project.managementPermissions();
    expect(f.store.task(old.id).management).toBe(original);
  } finally { await f.close(); }
});

test('real Valet actor delegates under an explicit development parent and sends cross-tree Agent messages without user append identity', async () => {
  let child, first, again, actor;
  const f = await prepared(async ({ task, token, rpc }) => {
    actor = task.id;
    child = await request(rpc, token, 'worker.spawn', { parent: f.parent.id, goal: 'delegated goal', name: 'managed-child' });
    const params = { id: f.other.id, body: 'follow-up from Valet' };
    first = await request(rpc, token, 'worker.message', params, 'same-message');
    again = await request(rpc, token, 'worker.message', params, 'same-message');
    await expect(request(rpc, token, 'worker.message', { ...params, _token: 'spoof' })).rejects.toThrow('unknown');
    await expect(request(rpc, token, 'worker.spawn', { goal: 'no parent' })).rejects.toThrow('explicit development parent');
  });
  try {
    const manager = f.project.submitManagementInstruction({ instruction: 'delegate and coordinate current project' }).task;
    await f.run();
    expect(child.status).toBe('succeeded');
    expect(f.store.task(child.result.id)).toMatchObject({ parent_id: f.parent.id, task_kind: 'child', role: 'agent' });
    expect(f.store.children(manager.id)).toHaveLength(0);
    expect(first.status).toBe('succeeded'); expect(again).toEqual(first);
    expect(f.store.all('SELECT sender_id,body,append_number FROM messages WHERE task_id=?', f.other.id))
      .toEqual([{ sender_id: actor, body: 'follow-up from Valet', append_number: null }]);
    expect(() => f.project.message(f.other.id, 'direct forged bypass', manager.id)).toThrow('direct parent or child');
    expect(() => f.project.message(f.other.id, 'forged receipt', manager.id, false, child.receipt_id)).toThrow('authorization');
  } finally { await f.close(); }
});

test('legacy delivery RPCs cannot turn a Valet tool or internal callback into an unreviewed user/parent actor', async () => {
  let checked = false;
  const f = await prepared(async ({ task, token, rpc }) => {
    for (const method of ['worker.integrate', 'worker.resolve_child_divergence']) {
      const params = { id: f.other.id, ...(method === 'worker.integrate' ? { commit: 'a'.repeat(40) } : {}) };
      expect(LUSHC_METHODS.has(method)).toBe(false);
      expect(managementPolicy(method).access).toBe('unavailable');
      await expect(request(rpc, token, method, params)).rejects.toThrow('专用身份');
      await expect(rpc.dispatch(method, { ...params, _token: token })).rejects.toThrow('dedicated reviewed management tools');
      await expect(f.project.managementDispatch(method, params, task.id)).rejects.toThrow('agent only');
      const state = f.state(task);
      state.permissions_snapshot.permissions[method] = 'confirmation';
      f.store.update(task.id, { management: JSON.stringify(state) });
      await expect(request(rpc, token, method, params)).rejects.toThrow('未授权');
    }
    expect(LUSHC_METHODS.has('worker.resolve')).toBe(false);
    expect(managementPolicy('worker.resolve').access).toBe('confirmation');
    await expect(rpc.dispatch('worker.resolve', { id: f.other.id, _token: token })).rejects.toThrow('requires user approval');
    await expect(f.project.managementDispatch('worker.resolve', { id: f.other.id }, task.id)).rejects.toThrow('durable capability receipt');
    const forged = f.state(task);
    forged.permissions_snapshot.permissions['worker.resolve'] = 'automatic';
    f.store.update(task.id, { management: JSON.stringify(forged) });
    await expect(request(rpc, token, 'worker.resolve', { id: f.other.id })).rejects.toThrow('未授权');
    forged.permissions_snapshot.permissions['worker.resolve'] = 'confirmation';
    f.store.update(task.id, { management: JSON.stringify(forged) });
    const receipt = await request(rpc, token, 'worker.resolve', { id: f.other.id });
    await expect(f.project.managementDispatch('worker.resolve', { id: f.other.id }, task.id, receipt.receipt_id)).rejects.toThrow('running fixed capability receipt');
    const state = f.state(task), call = state.control_calls.find(item => item.receipt_id === receipt.receipt_id);
    call.status = 'running'; f.store.update(task.id, { management: JSON.stringify(state) });
    await expect(f.project.managementDispatch('worker.resolve', { id: f.parent.id }, task.id, call.receipt_id)).rejects.toThrow('running fixed capability receipt');
    await expect(f.project.managementDispatch('worker.resolve', call.params, task.id, call.receipt_id)).rejects.toThrow('exact user confirmation');
    call.status = 'pending_confirmation'; f.store.update(task.id, { management: JSON.stringify(state) });
    expect(fs.existsSync(f.other.workspace)).toBe(true);
    checked = true;
  });
  try {
    const manager = f.project.submitManagementInstruction({ instruction: 'review legacy entry guards' }).task;
    await f.run(); expect(checked).toBe(true);
    const calls = f.state(manager).control_calls;
    expect(calls).toHaveLength(1); expect(calls[0].status).toBe('pending_confirmation');
    expect(f.store.get("SELECT id FROM events WHERE task_id=? AND type='task.accepted'", f.other.id)).toBeNull();
  } finally { await f.close(); }
});

test('normal developer invocation still cannot delegate or message across trees', async () => {
  let rpc, other, checks = 0;
  const f = fixture({ async run({ token }) {
    await expect(rpc.dispatch('worker.spawn', { parent: other.id, goal: 'forbidden', _token: token })).rejects.toThrow('own worker');
    await expect(rpc.dispatch('worker.message', { id: other.id, body: 'forbidden', _token: token })).rejects.toThrow('direct parent or child');
    await expect(rpc.dispatch('manager.call', { method: 'worker.message', params: { id: other.id, body: 'forbidden' }, _token: token })).rejects.toThrow('management Worker');
    checks += 3; return 'done';
  } });
  f.project.kick = () => {};
  try {
    await repo(f.root); rpc = new Dispatcher(f.project, { isRequested: () => false }, {});
    other = (await f.project.order('other', 'main', [], null, false)).task;
    await f.project.order('actor', 'main', [], null, true);
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(checks).toBe(3);
    expect(f.store.get('SELECT count(*) AS n FROM messages WHERE task_id=?', other.id).n).toBe(0);
  } finally { await f.close(); }
});

test('Valet owns progress and one-shot title, cannot select a different Notice owner or bypass the reviewed transport', async () => {
  let replies;
  const f = await prepared(async ({ task, token, rpc }) => {
    replies = [await request(rpc, token, 'progress.plan', { steps: [{ key: 'inspect', label: '检查' }] }),
      await request(rpc, token, 'progress.complete', { step: 'inspect' }),
      await request(rpc, token, 'worker.auto_title', { title: '受控管理协作' }),
      await request(rpc, token, 'worker.auto_title', { title: '不覆盖首次标题' })];
    await expect(rpc.dispatch('progress.plan', { steps: [], _token: token })).rejects.toThrow('dedicated');
    await expect(request(rpc, token, 'notice.post', { task: f.other.id, title: 'wrong owner' })).rejects.toThrow('only for itself');
    expect(f.store.get('SELECT count(*) AS n FROM notices WHERE task_id=?', f.other.id).n).toBe(0);
    expect(replies[2].result.id).toBe(task.id);
  });
  try {
    const manager = f.project.submitManagementInstruction({ instruction: 'own metadata' }).task;
    await f.run();
    expect(replies.map(reply => reply.status)).toEqual(['succeeded','succeeded','succeeded','succeeded']);
    expect(JSON.parse(f.store.task(manager.id).progress_plan).items[0].status).toBe('completed');
    expect(f.store.task(manager.id).auto_title).toBe('受控管理协作');
    expect(replies[3].result).toMatchObject({ auto_title: '受控管理协作', changed: false });
  } finally { await f.close(); }
});

for (const method of ['worker.accept', 'worker.resolve']) for (const outcome of ['approve','deny','dirty','freeze','params','lush','stopped']) test(`cross-tree ${method} uses fixed confirmation and original resource engine: ${outcome}`, async () => {
  let receipt;
  const f = await prepared(async ({ token, rpc }) => {
    receipt = await request(rpc, token, method, { id: f.other.id }, 'accept-fixed');
    expect(receipt.status).toBe('pending_confirmation');
    expect(fs.existsSync(f.other.workspace)).toBe(true);
  });
  try {
    await f.project.workspaces.finish(f.other);
    f.store.update(f.other.id, { status: 'awaiting_acceptance', reservation: null });
    const manager = f.project.submitManagementInstruction({ instruction: 'accept delivered current-project work' }).task;
    await f.run();
    expect(f.store.task(manager.id).status).toBe('awaiting');
    if (outcome === 'dirty') fs.writeFileSync(path.join(f.other.workspace, 'uncommitted.txt'), 'retain');
    if (outcome === 'freeze') f.project.branchFreeze = branch => branch === f.other.branch ? { task_id: f.other.id, kind: 'test_freeze' } : null;
    if (outcome === 'params') {
      const state = f.state(manager); state.control_calls[0].params.id = f.parent.id;
      f.store.update(manager.id, { management: JSON.stringify(state) });
    }
    if (outcome === 'stopped') f.project.updateManagementBinding(manager.id, false, f.project.managementView(manager.id).revision);
    else await f.confirm(receipt.notice_id, outcome === 'deny' ? { answers: [{ selected: [0], custom: '' }] } : approval,
      outcome === 'lush' ? 'lush' : 'user');
    const calls = (f.state(manager).last_execution ?? f.state(manager)).control_calls;
    expect(calls[0].status).toBe(outcome === 'approve' ? 'succeeded' : ['deny','lush','stopped'].includes(outcome) ? 'rejected' : 'failed');
    expect(fs.existsSync(f.other.workspace)).toBe(outcome !== 'approve');
    expect(f.store.task(f.other.id).status).toBe(outcome === 'approve' ? 'completed' : 'awaiting_acceptance');
    if (outcome === 'approve') {
      expect(f.store.get("SELECT id FROM events WHERE task_id=? AND type='task.accepted'", f.other.id)).toBeTruthy();
      expect(f.store.branch(f.other.branch).status).toBe('archived');
    }
  } finally { await f.close(); }
});

for (const structured of [true, false]) test(`own ${structured ? 'questionnaire' : 'question'} parks and resumes the same Valet occurrence without replaying committed effects`, async () => {
  let calls = 0, oldToken, occurrence, receipt;
  const f = await prepared(async ({ task, token, rpc, signal, context }) => {
    calls++;
    if (calls === 1) {
      oldToken = token; occurrence = f.state(task).pending_signal.id;
      await request(rpc, token, 'draft.add', { content: 'do not replay' }, 'draft-once');
      receipt = await request(rpc, token, 'notice.post', { title: 'choose a workflow', body: 'own question',
        ...(structured ? { questions: [{ header: '方案', question: '选择哪个方案？', options: [
          { label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }] } : {}) });
      expect(signal.aborted).toBe(true);
      throw new Error('Provider abort after intentional question');
    }
    expect(f.state(task).pending_signal.id).toBe(occurrence);
    expect(token).not.toBe(oldToken);
    expect(context.management.decisions.some(notice => notice.answer_source === 'user')).toBe(true);
    await request(rpc, token, 'progress.plan', { steps: [{ key: 'resume', label: '继续' }] });
  });
  try {
    const manager = f.project.submitManagementInstruction({ instruction: 'ask a question then continue' }).task;
    await f.run();
    expect(receipt.status).toBe('succeeded');
    expect(f.store.task(manager.id)).toMatchObject({ status: 'awaiting', error: null });
    expect(f.state(manager).pending_signal).toMatchObject({ id: occurrence, phase: 'question' });
    expect(f.store.draftCount()).toBe(1);
    await expect(f.rpc.dispatch('manager.catalog', { _token: oldToken })).rejects.toThrow();
    f.project.answer(receipt.result.id, structured ? { answers: [{ selected: [0], custom: '' }] } : 'A');
    expect(f.store.task(manager.id).status).toBe('queued');
    await f.run();
    expect(calls).toBe(2); expect(f.store.task(manager.id)).toMatchObject({ status: 'completed', error: null });
    expect(f.state(manager).last_execution.id).toBe(occurrence);
    expect(f.store.draftCount()).toBe(1);
  } finally { await f.close(); }
});

test('management history/transcript provide bounded metadata and exact forward cursors without free-text secrets', async () => {
  let transcript, history, next, inspect;
  const f = await prepared(async ({ token, rpc }) => {
    inspect = await request(rpc, token, 'worker.inspect', { id: f.other.id });
    transcript = await request(rpc, token, 'worker.transcript', { id: f.other.id, limit: 1 });
    history = await request(rpc, token, 'worker.history', { id: f.other.id });
    next = await request(rpc, token, 'worker.history', { id: f.other.id, after: history.result.next });
  });
  try {
    const sessions = path.join(f.config.home, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, `fixture_lush-task-${f.other.id}.jsonl`), [
      { type: 'message', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'SECRET_CALL_ID', name: 'SECRET_TOOL_NAME', arguments: { env: 'SECRET_ENV', text: 'SECRET_PROMPT' } }] } },
      { type: 'message', timestamp: '2026-01-01T00:00:01Z', message: { role: 'toolResult', toolCallId: 'SECRET_CALL_ID',
        toolName: 'SECRET_TOOL_NAME', content: [{ type: 'text', text: 'SECRET_TOOL_OUTPUT' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const run = f.store.startRun({ ...f.other, calls: 1 }, { agent: 'mock' });
    f.store.finishRun(run.id, 'completed', { result: 'SECRET_PROVIDER_RESULT', error: 'SECRET_PROVIDER_ERROR' });
    f.store.update(f.other.id, { result: 'SECRET_WORKER_RESULT', error: 'SECRET_WORKER_ERROR' });
    f.store.message(f.other.id, 'SECRET_INBOX_BODY');
    f.store.addArtifact({ task_id: f.other.id, run_id: run.id, kind: 'fixture.private', payload: { content: 'SECRET_ARTIFACT' }, metadata: {} });
    for (let i = 0; i < 110; i++) f.store.event(f.other.id, 'test.event', { text: 'SECRET_EVENT_TEXT', management: { permissions_snapshot: 'SECRET_POLICY' }, credentials: 'SECRET_CREDENTIAL' });
    f.project.submitManagementInstruction({ instruction: 'safe record metadata' }); await f.run();
    expect(transcript.result).toMatchObject({ coverage: 'step_metadata_only', next: 1, has_more: true });
    expect(transcript.result.steps).toHaveLength(1);
    expect(history.result).toMatchObject({ coverage: 'event_metadata_only', has_more: true });
    expect(history.result.events.length).toBeLessThanOrEqual(100);
    expect(next.result.next).toBeGreaterThan(history.result.next);
    expect(next.result.has_more).toBe(false);
    expect(inspect.result).toMatchObject({ id: f.other.id, coverage: 'worker_metadata_only' });
    for (const value of [transcript, history, next, inspect]) expect(JSON.stringify(value)).not.toContain('SECRET_');
    expect(fs.readFileSync(path.join(sessions, `fixture_lush-task-${f.other.id}.jsonl`), 'utf8')).toContain('SECRET_TOOL_OUTPUT');
    const limits = {};
    expect(managementSafeResult({ items: Array(101).fill('x'), text: 'x'.repeat(4001), env: 'secret' }, limits)).not.toHaveProperty('env');
    expect(limits.truncated).toBe(true);
  } finally { await f.close(); }
});
