import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fixture, repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';

// Preserve management safety for historical choice creation receipts after feature retirement.
async function setup(receiptStatus, targetStatus, action) {
  let f, target, result;
  f = fixture({ async run({ task, api, token }) {
    if (task.role !== 'manager') throw new Error('target must not start during choice creation');
    const rpc = new Dispatcher(api);
    for (const method of ['notice.snapshot','notice.rechoose'])
      await expect(rpc.dispatch(method, { id: f.notice.id, _token: token })).rejects.toThrow('unknown method');
    await expect(rpc.dispatch('notice.post', { title: 'no management questionnaire', _token: token })).rejects.toThrow('management agents');
    result = api.requestManagementAction(task.id, action, target.id);
    return 'management request recorded';
  } });
  f.project.kick = () => {};
  await repo(f.root);
  target = (await f.project.order('new choice route', 'main', [], null, false)).task;
  const notice = f.project.notice(target.id, 'source choice'); f.notice = notice;
  f.store.run(`INSERT INTO choice_rechoices(request_id,notice_id,revision,answer,status,task_id)
    VALUES (?,?,?,'{}',?,?)`, randomUUID(), notice.id, 'test-revision', receiptStatus, target.id);
  f.store.update(target.id, { status: targetStatus });
  f.project.scheduledHookOptions = { now: () => Date.parse('2030-01-01T00:00:00Z'), setTimeout: () => 1, clearTimeout() {} };
  const signal = f.project.saveHookSignal({ name: 'start time', schedule: {
    kind: 'once', at: '2030-01-01T00:01:00Z', timezone: 'UTC' } }, f.project.hookSignals().revision).signals.items[0];
  const manager = f.project.createManagementWorker({ name: 'manager', instruction: action, signal_id: signal.id });
  f.project.submitManagementSignal(manager.id, { id: 100, signal_id: signal.id, name: signal.name, due_at: signal.schedule.at });
  f.project.pump();
  await Promise.all([...f.project.running.values()].map(run => run.promise));
  return { ...f, target, manager, result };
}

test('management start waits for choice creation instead of invalidating the restore transaction', async () => {
  const f = await setup('creating', 'paused', 'start');
  try {
    expect(f.result.status).toBe('waiting');
    expect(f.result.reason).toContain('重选路线正在创建');
    expect(f.store.task(f.target.id).status).toBe('paused');
    expect(f.store.task(f.target.id).calls).toBe(0);
    f.store.run("UPDATE choice_rechoices SET status='created' WHERE task_id=?", f.target.id);
    f.project.drainManagementActions();
    expect(f.store.task(f.target.id).status).toBe('queued');
    expect(f.project.managementView(f.manager.id).last_execution.actions[0].status).toBe('succeeded');
  } finally { await f.close(); }
});

test('management retry does not replay an unknown choice fork', async () => {
  const f = await setup('unknown', 'failed', 'retry');
  try {
    expect(f.result.status).toBe('skipped');
    expect(f.result.reason).toContain('副作用未知');
    expect(f.store.task(f.target.id).status).toBe('failed');
    expect(f.store.task(f.target.id).calls).toBe(0);
    expect(f.project.managementView(f.manager.id).last_execution.actions[0].status).toBe('skipped');
  } finally { await f.close(); }
});
