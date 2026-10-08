import { test, expect, setDefaultTimeout } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { workerLabel } from '../../src/core/worker-number.js';
import { assertTaskAncestorsOpen } from '../../src/core/project/iteration.js';

setDefaultTimeout(30000);
function numberedOrder(f) {
  // Deliberately separate Input numbers from the integer Worker sequence.
  for (let i = 0; i < 3; i++) f.store.create({ role: 'agent', goal: 'historical', task_kind: 'analysis' });
  const inputId = f.store.nextInputId();
  f.store.run('INSERT INTO inputs(id,content) VALUES (?,?)', inputId, 'numbered');
  return f.store.create({ role: 'agent', task_kind: 'order', input_id: inputId, goal: 'numbered' });
}
const child = (f, parent) => f.store.create({ role: 'agent', task_kind: 'child', parent_id: parent.id,
  input_id: parent.input_id, goal: 'nested' });
const noticeFor = (f, task) => f.store.get('SELECT * FROM notices WHERE task_id=? ORDER BY id DESC LIMIT 1', task.id);

test('lifecycle failure and idle notices use the persistent number in title and body, preserving stored history', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const task = numberedOrder(f);
    expect(task.id).not.toBe(task.input_id);
    const historical = f.project.notify(task.id, `Worker #${task.id} old title`, `old body #${task.id}`);
    f.store.update(task.id, { status: 'waiting' });
    const event = f.store.event(task.id, 'task.idle', {});
    const idle = f.project.notifyTaskLifecycle(task.id, event);
    expect(idle.title).toStartWith(`Worker ${task.worker_number} 本轮已结束`);
    expect(idle.body).toContain(`打开 Worker ${task.worker_number} 查看详情`);
    expect(idle.body).not.toContain(`Worker #${task.id}`);
    expect(idle.task_id).toBe(task.id);
    expect(idle.task_worker_number).toBe(task.worker_number);
    expect(f.project.notifyTaskLifecycle(task.id, event).id).toBe(idle.id);
    f.project.finish(task.id, 'failed', null, 'synthetic timeout');
    const failed = noticeFor(f, task);
    expect(failed.title).toStartWith(`Worker ${task.worker_number} 异常停止`);
    expect(failed.body).toContain('synthetic timeout');
    expect(failed.body).toContain(`打开 Worker ${task.worker_number} 查看详情`);
    expect(f.store.get('SELECT title,body FROM notices WHERE id=?', historical.id))
      .toEqual({ title: historical.title, body: historical.body });
    expect(f.store.get('SELECT type FROM events WHERE id=?', event).type).toBe('task.idle');
  } finally { await f.close(); }
});

test('deep child settlement reports use W suffixes while parent signals retain integer identity and keys', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const root = numberedOrder(f), one = child(f, root), two = child(f, one), deep = child(f, two);
    expect(deep.worker_number).toBe(`${root.worker_number}-1-1-1`);
    f.store.update(deep.id, { status: 'waiting', branch: `lush/test/${deep.id}`, target_branch: 'parent' });
    f.project.finish(deep.id, 'failed', null, 'boom');
    const notice = noticeFor(f, deep);
    expect(notice.title).toContain(`Worker ${deep.worker_number} 失败`);
    expect(notice.body).toContain(`Worker ${deep.worker_number}（agent`);
    expect(notice.body).not.toContain(`Worker #${deep.id}`);
    expect(notice.task_id).toBe(deep.id);
    const signal = f.store.get('SELECT * FROM messages WHERE task_id=? AND sender_id=?', two.id, deep.id);
    const body = JSON.parse(signal.body);
    expect(body).toMatchObject({ source_task_id: deep.id, target_task_id: two.id, signal: 'child.failed' });
    expect(body.key).toStartWith(`child:${deep.id}:settlement:`);
    expect(body.key).not.toContain(deep.worker_number);
  } finally { await f.close(); }
});

test('historical unnumbered orders and children fall back to #ID without deriving W from input or parent', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const old = f.store.create({ role: 'agent', task_kind: 'order', goal: 'legacy', input_id: null });
    f.store.update(old.id, { status: 'waiting' });
    const event = f.store.event(old.id, 'task.idle', {});
    const idle = f.project.notifyTaskLifecycle(old.id, event);
    expect(idle.title).toStartWith(`Worker #${old.id} 本轮已结束`);
    expect(idle.body).toContain(`打开 Worker #${old.id} 查看详情`);
    const nested = child(f, child(f, old));
    expect(nested.worker_number).toBeNull();
    f.store.update(nested.id, { status: 'waiting', branch: 'legacy-child' });
    f.project.finish(nested.id, 'failed', null, 'legacy failure');
    expect(noticeFor(f, nested).body).toContain(`Worker #${nested.id}`);
    expect(workerLabel({ id: 999, input_id: 5 })).toBe('#999');
  } finally { await f.close(); }
});

test('freeze and readiness reports resolve associated Worker numbers but retain integer freeze ownership', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const root = numberedOrder(f), direct = child(f, root), nested = child(f, direct);
    f.store.update(root.id, { status: 'waiting', branch: 'root' });
    f.store.update(direct.id, { status: 'waiting', branch: 'direct', target_branch: 'root' });
    f.store.update(nested.id, { status: 'waiting', branch: 'nested', target_branch: 'direct',
      reservation: JSON.stringify({ version: 2, kind: 'merge', queue_protocol: 1, status: 'executing', parent_id: direct.id }) });
    f.store.recordBranch({ branch: 'root', task_id: root.id });
    f.store.recordBranch({ branch: 'direct', parent: 'root', task_id: direct.id });
    f.store.recordBranch({ branch: 'nested', parent: 'direct', task_id: nested.id });
    const freeze = f.project.branchFreeze('direct');
    expect(freeze).toMatchObject({ task_id: nested.id, task_worker_number: nested.worker_number, kind: 'delivery' });
    expect(freeze.reason).toContain(`Worker ${nested.worker_number} 的交付`);
    expect(f.project.reservationWaitReason(f.store.task(direct.id))).toBe(`等待子Worker ${nested.worker_number} 的父分支执行位释放`);
    f.store.update(nested.id, { reservation: null });
    expect(f.project.reservationWaitReason(f.store.task(root.id))).toBe(`等待子Worker ${direct.worker_number} 结算`);
    f.store.update(root.id, { status: 'completed' });
    expect(() => assertTaskAncestorsOpen(f.project, nested)).toThrow(`ancestor Worker ${root.worker_number}`);
  } finally { await f.close(); }
});

test('cleanup and delete blockers identify deep associated Workers by W, with historical fallback', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const root = numberedOrder(f), direct = child(f, root), deep = child(f, direct);
    f.store.update(root.id, { status: 'completed' });
    f.store.update(direct.id, { status: 'completed' });
    await expect(f.project.workspaces.cleanup(root.id)).rejects.toThrow(`descendant Worker ${deep.worker_number}`);
    const preview = await f.project.deleteTaskPreview(root.id);
    expect(preview.can_delete).toBe(false);
    expect(preview.blockers).toContain(`${deep.worker_number}: Worker is queued; cancel it or finish/accept it before deletion`);
    expect(preview.workers.find(row => row.id === deep.id).worker_number).toBe(deep.worker_number);
    const old = f.store.create({ role: 'agent', task_kind: 'order', goal: 'old', input_id: null });
    const oldPreview = await f.project.deleteTaskPreview(old.id);
    expect(oldPreview.blockers).toContain(`#${old.id}: Worker is queued; cancel it or finish/accept it before deletion`);
  } finally { await f.close(); }
});

test('fork errors report the allocated child number while worktree/branch identities remain integers', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const root = (await f.project.order('parent', null, [], null, false)).task;
    expect(root.id).not.toBe(root.input_id);
    const direct = await f.project.spawn(root.id, 'child');
    const nested = await f.project.spawn(direct.id, 'grandchild');
    const expected = `${nested.worker_number}-1`;
    f.project.workspaces.forkTaskUnsafe = async () => { throw new Error('synthetic failure'); };
    await expect(f.project.spawn(nested.id, 'fails')).rejects.toThrow(`worker ${expected} fork failed`);
    const failed = f.store.children(nested.id)[0];
    expect(failed.worker_number).toBe(expected);
    expect(failed.status).toBe('failed');
    const event = f.store.get("SELECT data FROM events WHERE task_id=? AND type='task.fork_failed'", failed.id);
    expect(JSON.parse(event.data).parent_id).toBe(nested.id);
    expect(nested.branch).toContain(String(nested.id));
    expect(nested.branch).not.toContain(nested.worker_number);
  } finally { await f.close(); }
});
