import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';

for (const committed of [false, true]) test(`atomic install ${committed ? 'committed' : 'uncommitted'} effects have exact recovery proof, not a replay`, async () => {
  let f, request;
  f = fixture({ async run({ token }) {
    request = await f.rpc.dispatch('manager.call', { method: 'hooks.install', params: f.input, _token: token });
    return 'await exact confirmation';
  } });
  try {
    f.project.kick = () => {}; await repo(f.root); const main = await f.project.bootstrapMain();
    f.project.observeTaskHooks();
    f.rpc = new Dispatcher(f.project, { isRequested: () => false }, {});
    f.input = { id: main.id, command: { name: 'recovery command', command: 'true' },
      hook: { name: 'recovery rule', trigger: 'worker.merge_received', mode: 'persistent', enabled: true },
      expected_revisions: { commands: f.project.shortcutCommands().revision, worker_hooks: f.project.taskHooks(main.id).revision },
      client_request_id: 'atomic-recovery' };
    const manager = f.project.submitManagementInstruction({ instruction: 'install after merge' }).task;
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const dispatch = f.project.managementDispatch;
    f.project.managementDispatch = async (...args) => {
      if (committed) await dispatch(...args);
      throw new Error('controlled interruption at atomic boundary');
    };
    f.project.answer(request.notice_id, { answers: [{ selected: [1], custom: '' }] });
    await Promise.all([...(f.project.managementControlJobs ?? [])]);
    let state = JSON.parse(f.store.task(manager.id).management);
    const call = state.last_execution.control_calls[0];
    expect(call.status).toBe(committed ? 'succeeded' : 'failed');
    if (committed) expect(call.result).toMatchObject({ installed: true, worker_id: main.id });
    const commandCount = f.project.shortcutCommands().items.length, hookCount = f.project.taskHooks(main.id).mounts.length;
    // Simulate a stored running call after restart, with no management completion event.
    f.store.run("DELETE FROM events WHERE task_id=? AND type='management.capability_completed'", manager.id);
    call.status = 'running'; delete call.result;
    state.pending_signal = { ...state.last_execution, phase: 'returned' };
    state.last_execution = null; state.enabled = true; state.consumed = false; state.state = 'waiting_actions';
    state.control_calls = [call];
    f.store.update(manager.id, { status: 'waiting', management: JSON.stringify(state) });
    f.project.recoverManagementCapabilities(manager.id);
    state = JSON.parse(f.store.task(manager.id).management);
    expect(state.control_calls[0].status).toBe(committed ? 'succeeded' : 'failed');
    if (committed) expect(state.control_calls[0].result).toMatchObject({ installed: true, command_id: f.project.shortcutCommands().items.at(-1).id });
    expect(f.project.shortcutCommands().items).toHaveLength(commandCount);
    expect(f.project.taskHooks(main.id).mounts).toHaveLength(hookCount);
    f.project.settleManagementOccurrence(manager.id);
    expect(f.store.task(manager.id).status).toBe('completed');
    const permission = f.project.managementPermissions();
    expect(() => f.project.setManagementPermissions({ ...permission.permissions, 'hooks.install': 'automatic' }, permission.revision)).toThrow('elevated');
  } finally { await f.close(); }
});
