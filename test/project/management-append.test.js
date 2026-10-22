import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { managementState, saveManagement, MANAGEMENT_LIMITS, managementLastExecution, managementReceiptRoom } from '../../src/core/project/management-data.js';
import { fixture, repo, git } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { createSignal } from '../../src/signal.js';
import { capabilityDiagnostic } from '../../src/core/project/management-diagnostic.js';
import { Store } from '../../src/persistence/store.js';
import { Project } from '../../src/core/project.js';
import { managementReceipt } from '../../src/core/project/management-receipt.js';

test('user RPC appends a fresh occurrence to the same settled Valet while preserving original input and history', async () => {
  const invocations = [];
  const f = fixture({ async run(options) { invocations.push(options); return '正常结束'; } });
  try {
    f.project.kick = () => {};
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    const definition = { instruction: '最初管理指令', client_request_id: 'original-management-input' };
    await expect(f.project.submitManagementInstruction(definition)).rejects.toThrow('refs/heads/main');
    expect(f.store.tasks()).toHaveLength(0);
    const draft = await dispatcher.dispatch('draft.add', { content: '管理草稿', mode: 'management' });
    const draftDefinition = { draft_id: draft.id, expected_revision: 1, client_request_id: 'management-draft-main' };
    await expect(dispatcher.dispatch('management.submit', draftDefinition)).rejects.toThrow('refs/heads/main');
    expect(f.project.inputGet('draft', draft.id).dispatch).toBeNull();
    f.project.saveHookSignal({ name: 'future', enabled: true,
      schedule: { kind: 'once', at: new Date(Date.now() + 3600000).toISOString(), timezone: 'UTC' } }, f.project.hookSignals().revision);
    const signalDefinition = { name: 'future Valet', instruction: '未来事项', signal_id: f.project.hookSignals().items[0].id, client_request_id: 'signal-management-main' };
    await expect(dispatcher.dispatch('management.create', signalDefinition)).rejects.toThrow('refs/heads/main');
    // Bind the real main through normal intake; no hard-coded internal ID or fake Git root.
    f.store.create({ role: 'agent', goal: 'legacy record' });
    await repo(f.root);
    const original = (await dispatcher.dispatch('management.submit', definition)).task;
    const main = f.store.get("SELECT * FROM tasks WHERE task_kind='main' AND branch='main'");
    expect(main.id).not.toBe(1);
    expect(original).toMatchObject({ parent_id: main.id, role: 'manager', task_kind: 'management',
      input_id: null, branch: null, target_branch: null, base_commit: null });
    expect(original.worker_number).toMatch(/^V[1-9]\d*$/);
    const pump = async () => { f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise)); };
    await pump();
    expect(f.project.inspect(original.id).management.can_append).toBe(true);
    const queued = await dispatcher.dispatch('worker.message', { id: original.id, body: '本轮新增需求' });
    expect(queued).toMatchObject({ id: original.id, status: 'queued', goal: original.goal });
    expect(f.project.managementOccupant().id).toBe(original.id);
    await pump();
    expect(f.store.task(original.id)).toMatchObject({ id: original.id, goal: original.goal, calls: 2, status: 'completed', branch: null });
    expect(invocations.map(call => call.context.management.instruction)).toEqual(['最初管理指令', '本轮新增需求']);
    expect(invocations.every(call => call.context.parent === undefined && call.context.children === undefined && call.context.referenced_context === undefined)).toBe(true);
    await expect(dispatcher.dispatch('worker.spawn', { parent: original.id, goal: 'cannot develop' })).rejects.toThrow();
    await expect(dispatcher.dispatch('worker.reserve', { id: original.id, kind: 'merge' })).rejects.toThrow();
    expect(f.store.unread(original.id)).toEqual([]);
    expect(f.store.all('SELECT * FROM agent_runs WHERE task_id=?', original.id)).toHaveLength(2);
    expect(f.project.managementOccupant()).toBeNull();
    expect(f.project.inputHistory({ modes: ['management'] }).items.filter(item => item.kind === 'message')).toMatchObject([{ kind: 'message', content: '本轮新增需求', task_id: original.id }]);
    const signal = (await dispatcher.dispatch('management.create', signalDefinition)).task;
    const submittedDraft = await dispatcher.dispatch('management.submit', draftDefinition);
    expect(signal.parent_id).toBe(main.id); expect(submittedDraft.task.parent_id).toBe(main.id);
    await pump();
    // A removed local main rejects only fresh creations, never replays old requests or rewrites history.
    await git(f.root, 'update-ref', '-d', 'refs/heads/main');
    const before = f.store.tasks().length;
    expect((await dispatcher.dispatch('management.submit', definition)).task.id).toBe(original.id);
    expect((await dispatcher.dispatch('management.create', signalDefinition)).task.id).toBe(signal.id);
    expect((await dispatcher.dispatch('management.submit', draftDefinition)).task.id).toBe(submittedDraft.task.id);
    await expect(f.project.submitManagementInstruction({ instruction: 'must not create' })).rejects.toThrow('refs/heads/main');
    expect(f.store.tasks()).toHaveLength(before);
    // The same reusable identity can be explicitly accepted, not inferred from completed.
    const settled = f.store.task(original.id), workspace = settled.workspace;
    expect(f.project.inspect(original.id).management).toMatchObject({ accepted: false, archived: false, can_accept: true });
    await expect(f.project.acceptTask(original.id, original.id)).rejects.toThrow('only the user');
    await expect(f.project.acceptTask(original.id, null, { completion: {} })).rejects.toThrow('only the user');
    await expect(dispatcher.dispatch('worker.accept_force', { id: original.id, revision: 'a'.repeat(64), confirm: true })).rejects.toThrow('force acceptance');
    const state = managementState(settled);
    for (const status of ['queued','failed','cancelled']) {
      f.store.update(original.id, { status });
      await expect(dispatcher.dispatch('worker.accept', { id: original.id })).rejects.toThrow('不能验收');
    }
    f.store.update(original.id, { status: settled.status });
    for (const patch of [{ pending_signal: { id: 999, phase: 'pending' } },
      { control_calls: [{ receipt_id: 999, status: 'unknown' }] }, { receipts: [{ receipt_id: 999, status: 'waiting' }] }]) {
      saveManagement(f.project, original.id, { ...state, ...patch });
      await expect(dispatcher.dispatch('worker.accept', { id: original.id })).rejects.toThrow('不能借验收撤销');
    }
    saveManagement(f.project, original.id, state);
    f.project.managementControlOwners = new Map([[original.id, 1]]);
    await expect(dispatcher.dispatch('worker.accept', { id: original.id })).rejects.toThrow('不能借验收撤销');
    f.project.managementControlOwners.clear();
    const message = f.store.appendMessage(original.id, '尚未处理');
    await expect(dispatcher.dispatch('worker.accept', { id: original.id })).rejects.toThrow('未处理');
    f.store.run('UPDATE messages SET consumed=1 WHERE id=?', message);
    fs.writeFileSync(path.join(workspace, 'unknown-file'), 'preserve');
    await expect(dispatcher.dispatch('worker.accept', { id: original.id })).rejects.toThrow('contains files');
    fs.unlinkSync(path.join(workspace, 'unknown-file'));
    // Known pre-effect failure leaves a fixed receipt and blocks any new development authorization.
    const resourceMethod = f.project.workspaces.managementAcceptanceResource;
    f.project.workspaces.managementAcceptanceResource = function(task, expected, remove) {
      if (remove) throw new Error('controlled reclamation failure');
      return resourceMethod.call(this, task, expected, remove);
    };
    await expect(dispatcher.dispatch('worker.accept', { id: original.id })).rejects.toThrow('controlled reclamation failure');
    expect(f.project.inspect(original.id).management).toMatchObject({ accepted: false, acceptance_recovery: true, can_append: false, can_enable: false });
    f.project.workspaces.managementAcceptanceResource = resourceMethod;
    const history = f.store.all('SELECT * FROM agent_runs WHERE task_id=?', original.id);
    const sessions = path.join(f.config.home, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
    const session = path.join(sessions, `lush-manager-${original.id}-history.jsonl`);
    fs.writeFileSync(session, 'preserved session history\n');
    const historicalEvents = f.store.all('SELECT * FROM events WHERE task_id=?', original.id);
    const accepted = await dispatcher.dispatch('worker.accept', { id: original.id });
    expect(accepted).toMatchObject({ id: original.id, status: 'completed', workspace: null, accepted: true, archived: true,
      management: { accepted: true, archived: true, can_append: false, can_enable: false } });
    expect(fs.existsSync(workspace)).toBe(false);
    expect(f.store.all('SELECT * FROM agent_runs WHERE task_id=?', original.id)).toEqual(history);
    expect(f.store.task(original.id).result).toBe(settled.result);
    expect(fs.readFileSync(session, 'utf8')).toBe('preserved session history\n');
    expect(f.store.all('SELECT * FROM events WHERE task_id=? ORDER BY id LIMIT ?', original.id, historicalEvents.length)).toEqual(historicalEvents);
    expect(f.store.all('SELECT body FROM messages WHERE task_id=? ORDER BY id', original.id)).toEqual([{ body: '本轮新增需求' }, { body: '尚未处理' }]);
    await expect(dispatcher.dispatch('worker.message', { id: original.id, body: '不应复活' })).rejects.toThrow('已验收归档');
    await expect(dispatcher.dispatch('management.binding_update', { id: original.id, enabled: true,
      expected_revision: accepted.management.revision })).rejects.toThrow('read-only');
    expect((await dispatcher.dispatch('management.submit', definition)).task.management).toMatchObject({ accepted: true, archived: true });
  } finally { await f.close(); }
});

// Existing append/CLI chains have small receipts and never exercise the state
// limit or a fresh startup after a failed recovery save. Keep one capacity flow.
test('full occurrences close without duplicating receipts and recovery preserves an unsavable identity', async () => {
  const f = fixture();
  let resumed, store;
  try {
    await repo(f.root); await f.project.ensureMainTask(); f.project.kick = () => {};
    const largeState = task => {
      const state = managementState(f.store.task(task.id));
      state.pending_signal.phase = 'returned'; state.pending_signal.started_at = new Date().toISOString();
      state.state = 'waiting_actions';
      state.control_calls = Array.from({ length: 32 }, (_, index) => {
        const receipt_id = f.store.event(task.id, 'management.capability_requested', { method: 'worker.page', occurrence_id: state.pending_signal.id });
        const call = { receipt_id, method: 'worker.page', operation: 'project.call', occurrence_id: state.pending_signal.id,
          params: { method: 'worker.page', params: { limit: index + 1 } }, authorization_mode: 'project_administrator',
          source_event_id: state.pending_signal.id, grant_id: 'capacity-grant', notice_id: null,
          status: 'failed', effect: 'not_started', reason: '只读失败，不自动重放。',
          result: { original_failure: { name: 'LushError', message: 'read failure' }, payload: '界'.repeat(550) } };
        capabilityDiagnostic(f.project, task.id, call, 'request_failed', 'execution', 'not_started', 'read_only');
        return call;
      });
      expect(Buffer.byteLength(JSON.stringify(state))).toBeGreaterThan(MANAGEMENT_LIMITS.bytes / 2);
      return state;
    };
    f.project.saveHookSignal({ name: 'future capacity', enabled: true,
      schedule: { kind: 'once', at: new Date(Date.now() + 3600000).toISOString(), timezone: 'UTC' } }, f.project.hookSignals().revision);
    const signal_id = f.project.hookSignals().items[0].id;
    for (const close of ['settle','fail','disable','cancel']) {
      const task = close === 'settle' ? await f.project.createManagementWorker({ name: 'persistent capacity', instruction: 'capacity settle', signal_id, mode: 'persistent' })
        : (await f.project.submitManagementInstruction({ instruction: `capacity ${close}` })).task;
      if (close === 'settle') f.project.submitManagementSignal(task.id, { id: f.store.event(task.id, 'test.signal', {}), signal_id,
        name: 'capacity signal', due_at: new Date().toISOString() });
      const state = largeState(task);
      if (['disable','cancel'].includes(close)) state.pending_signal.phase = 'pending';
      saveManagement(f.project, task.id, state);
      const original = structuredClone(state.control_calls);
      if (close === 'settle') f.project.settleManagementOccurrence(task.id);
      else if (close === 'fail') f.project.failManagementOccurrence(task.id, 'failed');
      else if (close === 'disable') f.project.updateManagementBinding(task.id, false, f.project.managementView(task.id).revision);
      else f.project.cancelManagementWorker(task.id, '用户停止');
      const saved = f.store.task(task.id), closed = managementState(saved);
      expect(Buffer.byteLength(saved.management)).toBeLessThanOrEqual(MANAGEMENT_LIMITS.bytes);
      expect(closed.last_execution.receipts_in_current).toBe(true);
      expect(closed.last_execution.control_calls).toBeUndefined();
      expect(managementLastExecution(closed).control_calls).toEqual(original);
      expect(f.project.managementView(task.id)).toMatchObject({ first_failure: { receipt_id: original[0].receipt_id, detail: 'LushError: read failure' } });
      expect(f.project.managementView(task.id).last_execution.control_calls).toHaveLength(32);
      expect(managementReceipt(f.project, { receipt_id: original[0].receipt_id }).diagnostic.effect).toBe('not_started');
      if (close === 'settle') {
        expect(f.project.managementView(task.id)).toMatchObject({ enabled: true, can_append: true, last_execution: { status: 'skipped' } });
        // New intake moves the old arrays exactly once, preserving history.
        f.project.appendManagementInstruction(task.id, '新一轮');
        const next = managementState(f.store.task(task.id));
        expect(next.control_calls).toEqual([]); expect(next.last_execution.control_calls).toEqual(original);
        f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', task.id);
        f.project.cancelManagementWorker(task.id, '结束容量验证');
      }
    }
    // A legacy legal state need not have the new admission reserve. Recover in
    // a fresh runtime through the same entry used by daemon startup, not a mock.
    const binding = await f.project.createManagementWorker({ name: 'other identity', instruction: '未开始的其他事项', signal_id });
    const broken = (await f.project.submitManagementInstruction({ instruction: 'legacy near-limit state' })).task;
    const state = largeState(broken);
    for (const call of state.control_calls) { call.status = 'running'; delete call.reason;
      capabilityDiagnostic(f.project, broken.id, call, 'in_progress', 'execution', 'unknown', 'dispatch_entered'); }
    state.padding = '';
    state.padding = 'x'.repeat(MANAGEMENT_LIMITS.bytes - Buffer.byteLength(JSON.stringify(state)) - 8);
    expect(managementReceiptRoom(state)).toBeLessThan(0);
    saveManagement(f.project, broken.id, state);
    const original = f.store.task(broken.id).management;
    f.project.submitManagementSignal(binding.id, { id: f.store.event(binding.id, 'test.signal', {}), signal_id,
      name: 'other queued signal', due_at: new Date().toISOString() });
    const recoverable = largeState(binding);
    for (const call of recoverable.control_calls) { call.status = 'running'; call.effect = 'not_applicable'; delete call.reason;
      capabilityDiagnostic(f.project, binding.id, call, 'in_progress', 'execution', 'not_applicable', 'read_only'); }
    saveManagement(f.project, binding.id, recoverable);
    await f.project.shutdown();
    store = new Store(path.join(f.config.home, 'project.db'), f.root); resumed = new Project(f.config, store);
    resumed.kick = () => {};
    expect(() => resumed.recover()).not.toThrow();
    expect(store.task(broken.id).management).toBe(original);
    expect(store.task(broken.id)).toMatchObject({ status: 'failed' });
    expect(store.task(broken.id).error).toContain('原始状态与收据已保留');
    expect(store.get("SELECT id FROM events WHERE task_id=? AND type='management.recovery_failed'", broken.id)).toBeTruthy();
    expect(store.task(binding.id).status).toBe('completed');
    expect(resumed.managementView(binding.id)).toMatchObject({ can_append: false, last_execution: { status: 'skipped' } });
    expect(resumed.managementView(binding.id).append_reason).toContain('已有管家');
    expect(managementState(store.task(binding.id)).control_calls.every(call => call.status === 'failed' && call.effect === 'not_started')).toBe(true);
    expect(Buffer.byteLength(store.task(binding.id).management)).toBeLessThanOrEqual(MANAGEMENT_LIMITS.bytes);
    expect(resumed.managementReady(store.task(broken.id))).toBe(false);
    resumed.drainManagementActions();
    expect(store.task(broken.id).management).toBe(original);
    expect(store.all("SELECT id FROM events WHERE task_id=? AND type='management.capability_completed'", broken.id)).toHaveLength(0);
  } finally { if (resumed) await resumed.shutdown(); store?.close(); await f.close(); }
});
