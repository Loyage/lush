import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { managementState, saveManagement } from '../../src/core/project/management-data.js';
import { fixture, repo, git } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { createSignal } from '../../src/signal.js';

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
