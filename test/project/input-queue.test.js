import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { saveInputRule } from '../../src/core/task-input-rule.js';
setDefaultTimeout(20000);

async function setup(provider) {
  const f = fixture(provider); f.project.stopping = true; await repo(f.root); return f;
}
async function commit(task, name) {
  fs.writeFileSync(path.join(task.workspace, `${name}.txt`), name);
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', name);
}
function fixed(f, task, status, extra = {}) {
  f.store.update(task.id, { status: 'waiting', reservation: JSON.stringify({ version: 2, kind: 'merge', queue_protocol: 1,
    status, parent_id: task.parent_id, commit: task.head_commit, ...extra }) });
}

for (const status of ['requested','executing','resolving','blocked']) test(`${status}: user and direct Agent messages remain outside Agent without changing delivery`, async () => {
  const f = await setup({ async run() { throw new Error('must not invoke'); } });
  try {
    const parent = (await f.project.order('parent')).task;
    f.store.update(parent.id, { status: 'waiting' });
    const child = await f.project.spawn(parent.id, 'source');
    fixed(f, child, status, { attempt_id: 123, baseline: child.base_commit });
    const before = f.store.task(child.id), preempt = [];
    f.project.requestPreempt = (...args) => preempt.push(args);
    for (const [index, sender] of [null, parent.id].entries()) {
      const response = f.project.message(child.id, `input ${index}`, sender);
      expect(response.input_queue).toMatchObject({ buffered: index + 1, reason: expect.any(String) });
      expect(f.store.task(child.id).reservation).toBe(before.reservation);
      expect(f.store.task(child.id).status).toBe('waiting');
    }
    expect(preempt).toHaveLength(0);
    expect(f.project.releaseTaskInputs(child.id)).toBe(false);
    expect(f.project.hasActionableMessages(child.id)).toBe(false);
    expect(f.project.reservationWaitReason(f.store.task(child.id))).toBeNull();
    expect(f.store.unread(child.id).map(row => row.body)).toEqual(['input 0','input 1']);
    expect(f.store.unreadPage(child.id)).toMatchObject({ messages: [], pending: 0, has_more: false });
    expect(f.project.inspect(child.id).input_queue.buffered).toBe(2);
    expect((await f.project.taskGraph({ details: false })).nodes.find(row => row.id === child.id).input_queue)
      .toEqual(f.project.inspect(child.id).input_queue);
    const history = f.store.history(child.id);
    expect(history.filter(row => row.type === 'task.input_buffered')).toHaveLength(2);
    expect(history.some(row => ['task.input_routed','merge.attempt_suspended','merge.attempt_resumed'].includes(row.type))).toBe(false);
    const unrelated = f.store.create({ role: 'agent', task_kind: 'child', goal: 'unrelated' });
    const count = f.store.unread(child.id).length;
    expect(() => f.project.message(child.id, 'no privilege expansion', unrelated.id)).toThrow('direct');
    expect(f.store.unread(child.id)).toHaveLength(count);
    expect(() => f.project.message(parent.parent_id, 'not an owner inbox', parent.id)).toThrow('branch owner');
    f.store.update(child.id, { status: 'failed' });
    expect(() => f.project.message(child.id, 'do not revive')).toThrow('ended');
    expect(f.project.releaseTaskInputs(child.id)).toBe(false);
  } finally { await f.close(); }
});

test('release waits for actual invocation exit, pause, question, sync and the last freeze; FIFO survives bounded pages', async () => {
  const f = await setup();
  try {
    const parent = (await f.project.order('parent')).task;
    f.store.update(parent.id, { status: 'waiting' });
    const child = await f.project.spawn(parent.id, 'source');
    fixed(f, child, 'requested');
    for (let i = 0; i < 55; i++) f.project.message(child.id, `input-${i}`, i % 2 ? parent.id : null);
    f.store.update(child.id, { status: 'awaiting_acceptance', reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'integrated' }) });
    f.project.running.set(child.id, { parked: true });
    expect(f.project.releaseTaskInputs(child.id)).toBe(false);
    f.project.running.delete(child.id);
    f.store.update(child.id, { status: 'paused' });
    expect(f.project.releaseTaskInputs(child.id)).toBe(false);
    f.store.update(child.id, { status: 'awaiting_acceptance' });
    const question = f.project.notice(child.id, 'answer first', '', 'question', [{ question: 'Which?', header: 'Choice', options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }] }]);
    expect(f.project.releaseTaskInputs(child.id)).toBe(false);
    f.project.answer(question.id, { answers: [{ selected: [0] }] });
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=? AND delivery_hold IS NULL', child.id);
    (f.project.taskSyncBusy ??= new Set()).add(child.id);
    expect(f.project.releaseTaskInputs(child.id)).toBe(false);
    f.project.taskSyncBusy.delete(child.id);
    const ownFreeze = f.project.branchFreeze.bind(f.project);
    f.project.branchFreeze = name => name === child.branch ? { reason: 'another freeze', kind: 'delivery' } : ownFreeze(name);
    expect(f.project.releaseTaskInputs(child.id)).toBe(false);
    f.project.branchFreeze = ownFreeze;
    expect(f.project.releaseTaskInputs(child.id)).toBe(true);
    expect(f.project.inspect(child.id).input_queue.buffered).toBe(5);
    const first = f.store.unreadPage(child.id, { limit: 3, bytes: 100 });
    expect(first.messages.map(row => row.body)).toEqual(['input-0','input-1','input-2']);
    expect(first.reordered).toBe(false);
    f.store.run('UPDATE messages SET consumed=1 WHERE id IN (?,?,?)', ...first.messages.map(row => row.id));
    expect(f.project.releaseTaskInputs(child.id)).toBe(true);
    expect(f.store.unreadPage(child.id).messages.slice(0, 4).map(row => row.body)).toEqual(['input-3','input-4','input-5','input-6']);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='task.iteration_started'", child.id).n).toBe(1);
    expect(f.project.inspect(child.id).input_queue.buffered).toBe(0);
  } finally { await f.close(); }
});

test('running source repair is not preempted or suspended; source and parent buffered inputs arrive only after the fixed landing', async () => {
  const repairStarted = gate(), repairReturn = gate(), followupStarted = gate(), followupReturn = gate();
  const calls = [];
  const f = await setup({ resolve() { return { agent: 'mock' }; }, async run(ctx) {
    calls.push({ id: ctx.task.id, messages: ctx.messages.map(row => row.body), reservation: ctx.task.reservation });
    const repair = ctx.messages.find(row => row.signal_type === 'merge.repair');
    if (repair) {
      const payload = JSON.parse(repair.body).payload;
      await git(ctx.cwd, 'merge', '--no-edit', payload.parent_commit);
      repairStarted.resolve(); await repairReturn.promise; return 'repaired fixed baseline';
    }
    if (ctx.task.task_kind === 'child') { followupStarted.resolve(); await followupReturn.promise; }
    return 'followup handled';
  } });
  try {
    const parent = (await f.project.order('parent')).task; f.store.update(parent.id, { status: 'waiting' });
    const child = await f.project.spawn(parent.id, 'source');
    await commit(child, 'source'); await f.project.workspaces.finish(f.store.task(child.id));
    await commit(parent, 'parent'); await f.project.workspaces.finish(f.store.task(parent.id));
    f.store.update(child.id, { status: 'waiting', result: 'source ready' });
    await f.project.reserveTask(child.id, 'merge');
    expect(f.project.message(child.id, 'requested-stage requirement').input_queue.buffered).toBe(1);
    f.project.stopping = false; f.project.scheduleTaskMerge(parent.id);
    await repairStarted.promise;
    const booking = f.store.task(child.id).reservation, sourceCalls = f.store.task(child.id).calls;
    expect(JSON.parse(booking).status).toBe('resolving');
    const sourceOne = f.project.message(child.id, 'new user requirement');
    const sourceTwo = f.project.message(child.id, 'parent followup', parent.id);
    const parentInput = f.project.message(parent.id, 'parent urgent requirement');
    expect(sourceOne.input_queue.buffered).toBe(2); expect(sourceTwo.input_queue.buffered).toBe(3);
    expect(parentInput.input_queue.buffered).toBe(1);
    expect(f.store.task(child.id).reservation).toBe(booking);
    expect(f.store.task(child.id).calls).toBe(sourceCalls);
    expect(f.project.running.get(child.id).controller.signal.aborted).toBe(false);
    expect(f.store.history(child.id).some(row => row.type === 'merge.attempt_suspended')).toBe(false);
    repairReturn.resolve(); await followupStarted.promise;
    const integrated = f.store.history(child.id).find(row => row.type === 'task.merge_integrated');
    expect(integrated).toBeDefined();
    expect(await git(parent.workspace, 'show', 'HEAD:source.txt')).toBe('source');
    expect(calls.filter(row => row.id === child.id)).toHaveLength(2);
    expect(calls.filter(row => row.id === child.id)[0].messages).not.toContain('requested-stage requirement');
    expect(calls.filter(row => row.id === child.id)[0].messages).not.toContain('new user requirement');
    expect(calls.filter(row => row.id === child.id)[1].messages).toEqual(['requested-stage requirement','new user requirement','parent followup']);
    await until(() => calls.some(row => row.id === parent.id && row.messages.includes('parent urgent requirement')));
    expect(f.store.history(child.id).find(row => row.type === 'task.input_released').id).toBeGreaterThan(integrated.id);
    followupReturn.resolve();
    await until(() => !f.project.running.size && f.store.unread(child.id).length === 0 && f.store.unread(parent.id).length === 0);
    expect(f.store.history(child.id).some(row => row.type === 'invocation.target_branch_moved')).toBe(false);
  } finally { repairReturn.resolve(); followupReturn.resolve(); await f.close(); }
});

test('automatic archive waits for a buffered next round rather than accepting it during landing', async () => {
  const prepared = gate(), land = gate(), nextStarted = gate(), nextReturn = gate();
  const f = await setup({ resolve() { return { agent: 'mock' }; }, async run({ task, cwd, messages }) {
    if (task.calls === 1) {
      await commit({ workspace: cwd }, 'first'); return 'first delivery';
    }
    expect(messages.map(row => row.body)).toEqual(['another requirement']);
    nextStarted.resolve(); await nextReturn.promise; return 'second round answer';
  } });
  try {
    const task = (await f.project.order('automatic archive')).task;
    await f.project.setTaskCompletion(task.id, 'archive', f.project.taskHooks(task.id).revision);
    const prepare = f.project.workspaces.prepareTaskSquashUnsafe.bind(f.project.workspaces);
    f.project.workspaces.prepareTaskSquashUnsafe = async (...args) => { const result = await prepare(...args); prepared.resolve(); await land.promise; return result; };
    f.project.stopping = false; f.project.kick(); await prepared.promise;
    expect(f.project.message(task.id, 'another requirement').input_queue.buffered).toBe(1);
    const oldBooking = JSON.parse(f.store.task(task.id).reservation);
    expect(oldBooking.status).toBe('executing');
    land.resolve(); await nextStarted.promise;
    expect(f.store.history(task.id).some(row => row.type === 'task.merge_integrated')).toBe(true);
    expect(f.store.history(task.id).some(row => row.type === 'task.accepted')).toBe(false);
    expect(f.store.branch(task.branch).status).toBe('active');
    expect(fs.existsSync(task.workspace)).toBe(true);
    nextReturn.resolve();
    await until(() => f.store.branch(task.branch).status === 'archived', 12000);
    const events = f.store.history(task.id);
    expect(events.filter(row => row.type === 'task.merge_integrated')).toHaveLength(1);
    expect(events.find(row => row.type === 'task.accepted').id).toBeGreaterThan(events.find(row => row.type === 'task.input_released').id);
    expect(events.some(row => row.type === 'completion.execution_failed')).toBe(false);
  } finally { land.resolve(); nextReturn.resolve(); await f.close(); }
});

test('persisted holds survive restart; interrupted trusted rules fall back without replay, then wake exactly once', async () => {
  const seen = [], nextReturn = gate();
  const f = await setup(); let restored;
  try {
    const task = (await f.project.order('persisted input')).task;
    fixed(f, task, 'blocked');
    const countFile = path.join(f.config.home, 'rule-count');
    saveInputRule(f.config.home, task.id, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(countFile)}, 'x'); console.log(JSON.stringify({ delivery:'message' }));`);
    f.project.message(task.id, 'queued user input');
    expect(fs.existsSync(countFile)).toBe(false);
    const message = f.store.unread(task.id)[0];
    restored = new Project(f.config, f.store, { resolve() { return { agent: 'mock' }; }, async run(ctx) {
      seen.push(ctx.messages.map(row => row.body)); await nextReturn.promise; return 'done';
    } });
    restored.recover();
    expect(restored.inspect(task.id).input_queue.buffered).toBe(1);
    expect(restored.releaseTaskInputs(task.id)).toBe(false);
    expect(fs.existsSync(countFile)).toBe(false);
    f.store.update(task.id, { status: 'awaiting_acceptance', reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'integrated' }) });
    // The old daemon had claimed trusted code but its result is unknown.
    f.store.run("UPDATE messages SET delivery_hold='routing' WHERE id=?", message.id);
    restored.kick();
    await until(() => seen.length === 1);
    expect(seen).toEqual([['queued user input']]);
    expect(fs.existsSync(countFile)).toBe(false);
    const routed = f.store.history(task.id).find(row => row.type === 'task.input_routed');
    expect(routed.data.source).toBe('fallback'); expect(routed.data.error).toContain('not replayed');
    expect(restored.inspect(task.id).input_queue.buffered).toBe(0);
    nextReturn.resolve(); await until(() => !restored.running.size);
    expect(seen).toHaveLength(1);
  } finally { nextReturn.resolve(); await restored?.shutdown(); await f.close(); }
});

test('restart of an interrupted source repair retains buffered input and never replays before explicit retry', async () => {
  const received = gate(), done = gate();
  const f = await setup(); let restored;
  try {
    const task = (await f.project.order('interrupted source repair')).task;
    fixed(f, task, 'resolving', { attempt_id: 91, original_commit: task.base_commit, baseline: task.base_commit });
    f.project.message(task.id, 'held across interrupted repair');
    f.store.update(task.id, { status: 'running' });
    let calls = 0;
    restored = new Project(f.config, f.store, { resolve() { return { agent: 'mock' }; }, async run({ messages }) {
      calls++; expect(messages.map(row => row.body)).toEqual(['held across interrupted repair']);
      received.resolve(); await done.promise; return 'explicit retry handled input';
    } });
    restored.recover();
    expect(f.store.task(task.id).status).toBe('failed');
    expect(JSON.parse(f.store.task(task.id).reservation).status).toBe('suspended');
    expect(restored.releaseTaskInputs(task.id)).toBe(false);
    expect(restored.inspect(task.id).input_queue.buffered).toBe(1);
    expect(calls).toBe(0);
    restored.retry(task.id); await received.promise;
    expect(calls).toBe(1); expect(restored.inspect(task.id).input_queue.buffered).toBe(0);
    done.resolve(); await until(() => !restored.running.size);
    expect(f.store.unread(task.id)).toHaveLength(0);
  } finally { done.resolve(); await restored?.shutdown(); await f.close(); }
});

test('buffered rules run once only after release and held input blocks acceptance without consuming it', async () => {
  const f = await setup();
  try {
    const task = (await f.project.order('input safety')).task; fixed(f, task, 'requested');
    const countFile = path.join(f.config.home, 'rule-count');
    saveInputRule(f.config.home, task.id, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(countFile)}, 'x'); console.log(JSON.stringify({ delivery:'message' }));`);
    f.project.message(task.id, 'requirement');
    f.store.update(task.id, { status: 'awaiting_acceptance', reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'integrated' }) });
    await expect(f.project.acceptTask(task.id)).rejects.toThrow('unread');
    expect(f.store.unread(task.id)[0].delivery_hold).toBe('frozen');
    expect(fs.existsSync(countFile)).toBe(false);
    expect(f.project.releaseTaskInputs(task.id)).toBe(true);
    expect(fs.readFileSync(countFile, 'utf8')).toBe('x');
    expect(f.project.releaseTaskInputs(task.id)).toBe(false);
    expect(fs.readFileSync(countFile, 'utf8')).toBe('x');
    expect(f.store.history(task.id).filter(row => row.type === 'task.input_routed')).toHaveLength(1);
    await expect(f.project.archiveBranch(task.branch)).rejects.toThrow('unfinished');
  } finally { await f.close(); }
});
