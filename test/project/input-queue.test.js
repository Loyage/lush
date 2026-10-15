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

for (const status of ['resolving']) test(`${status}: user and direct Agent messages remain outside Agent without changing delivery`, async () => {
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
