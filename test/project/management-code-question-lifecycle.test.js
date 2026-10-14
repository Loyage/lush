import { test, expect } from 'bun:test';
import { fixture, repo, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { Project } from '../../src/core/project.js';

async function setup(after = async () => {}) {
  let f;
  f = fixture({ async run({ task, token }) {
    await f.rpc.dispatch('manager.call', { method: 'notice.post', params: { title: 'decision', body: 'own decision', questions: [
      { header: '方案', question: 'Choose a workflow?', options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }] }, _token: token });
    await after(task);
    return 'ignored after intentional park';
  } });
  f.project.kick = () => {}; await repo(f.root);
  f.rpc = new Dispatcher(f.project, { isRequested: () => false }, {});
  f.manager = f.project.submitManagementInstruction({ instruction: 'ask and continue' }).task;
  f.state = () => JSON.parse(f.store.task(f.manager.id).management);
  f.run = async () => { f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise)); };
  return f;
}

for (const mode of ['disable','cancel']) test(`own management question ${mode} closes the question and releases its lane without replay`, async () => {
  const f = await setup();
  try {
    await f.run();
    const notice = f.state().pending_signal.question_notice_id;
    if (mode === 'disable') f.project.updateManagementBinding(f.manager.id, false, f.project.managementView(f.manager.id).revision);
    else f.project.cancel(f.manager.id, 'user stopped own question');
    expect(f.state().pending_signal).toBeNull();
    expect(f.store.get('SELECT status FROM notices WHERE id=?', notice).status).toBe('dismissed');
    expect(f.project.managementOccupant()).toBeNull();
    expect(f.project.resumeManagementQuestion(f.manager.id, notice)).toBe(false);
    expect(f.store.task(f.manager.id).status).toBe(mode === 'disable' ? 'completed' : 'cancelled');
  } finally { await f.close(); }
});

test('durable own decision survives restart as awaiting, and its answer resumes the same occurrence once', async () => {
  const f = await setup(); let restarted, checked = false;
  try {
    await f.run();
    const state = f.state(), occurrence = state.pending_signal.id, notice = state.pending_signal.question_notice_id;
    await f.project.shutdown();
    restarted = new Project(f.config, f.store, { async run({ task, context }) {
      expect(context.management.signal.id).toBe(occurrence);
      expect(context.management.decisions[0]).toMatchObject({ notice_id: notice, answer_source: 'user', status: 'answered' });
      expect(task.id).toBe(f.manager.id); checked = true; return 'resumed once';
    } });
    restarted.kick = () => {}; restarted.recover();
    expect(f.store.task(f.manager.id)).toMatchObject({ status: 'awaiting', error: null });
    expect(restarted.managementOccupant().id).toBe(f.manager.id);
    expect(restarted.managementReady(f.store.task(f.manager.id))).toBe(false);
    restarted.answer(notice, { answers: [{ selected: [0], custom: '' }] });
    expect(restarted.managementReady(f.store.task(f.manager.id))).toBe(true);
    restarted.pump(); await Promise.all([...restarted.running.values()].map(run => run.promise));
    expect(checked).toBe(true);
    expect(f.store.task(f.manager.id)).toMatchObject({ status: 'completed', error: null });
    expect(f.state().last_execution.id).toBe(occurrence);
    expect(f.state().last_execution.control_calls).toHaveLength(1);
  } finally { await restarted?.shutdown(); await f.close(); }
});

for (const unknown of [false, true]) test(`restart of an already answered own decision ${unknown ? 'does not replay an unknown effect' : 'retains its durable continuation'}`, async () => {
  const f = await setup(); let restarted;
  try {
    await f.run();
    const state = f.state(), notice = state.pending_signal.question_notice_id;
    // Simulate the crash window after the answer transaction, before the resume hook.
    f.store.run("UPDATE notices SET status='answered',answer_source='user',answer=? WHERE id=?", JSON.stringify({ answers: [{ selected: [0], custom: '' }] }), notice);
    if (unknown) {
      state.control_calls[0].status = 'running';
      f.store.update(f.manager.id, { management: JSON.stringify(state) });
      f.store.run("DELETE FROM events WHERE task_id=? AND type='management.capability_completed'", f.manager.id);
    }
    await f.project.shutdown();
    restarted = new Project(f.config, f.store, { run() { throw new Error('recovery must not run a Provider itself'); } });
    restarted.kick = () => {}; restarted.recover();
    expect(f.store.task(f.manager.id).status).toBe(unknown ? 'failed' : 'queued');
    expect(f.state().pending_signal.phase).toBe(unknown ? 'question' : 'pending');
    expect(f.state().enabled).toBe(!unknown);
    expect(restarted.managementReady(f.store.task(f.manager.id))).toBe(!unknown);
  } finally { await restarted?.shutdown(); await f.close(); }
});

test('answer arriving before parked Provider exit is retained, cannot overlap old invocation, and remains ready after cleanup', async () => {
  const entered = gate(), exited = gate();
  const f = await setup(async () => { entered.resolve(); await exited.promise; });
  try {
    f.project.pump(); const old = f.project.running.get(f.manager.id);
    await entered.promise;
    const notice = f.state().pending_signal.question_notice_id;
    f.project.answer(notice, { answers: [{ selected: [0], custom: '' }] });
    expect(f.store.task(f.manager.id).status).toBe('queued');
    f.project.pump(); expect(f.project.running.get(f.manager.id)).toBe(old);
    exited.resolve(); await old.promise;
    expect(f.project.running.has(f.manager.id)).toBe(false);
    expect(f.project.managementReady(f.store.task(f.manager.id))).toBe(true);
    expect(f.store.task(f.manager.id).agent_token_hash).toBeNull();
  } finally { exited.resolve(); await f.close(); }
});
