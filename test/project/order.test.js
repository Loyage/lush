import { test, expect, setDefaultTimeout } from 'bun:test';
setDefaultTimeout(15000);
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { assertAllowed } from '../../src/rpc/registry.js';
import { handlers as noticeHandlers } from '../../src/rpc/handlers/notice.js';

test('new order creates one Input and one Task in its own worktree, without planner or fast routing', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const response = await f.project.order('开发 做一个页面');
    const root = f.store.task(response.task.parent_id);
    expect(root).toMatchObject({ role: 'agent', task_kind: 'main', status: 'waiting', branch: 'main', input_id: null });
    expect(response.task).toMatchObject({ task_kind: 'order', role: 'agent', parent_id: root.id,
      input_id: response.id, workspace: response.anchor.workspace, branch: response.anchor.branch,
      target_branch: 'main' });
    expect(f.store.get('SELECT task_id FROM inputs WHERE id=?', response.id).task_id).toBe(response.task.id);
    expect(f.store.branch(response.anchor.branch).task_id).toBe(response.task.id);
    // 概览与输入区父 Task 选择共用 activity 读模型：分支所有者必须带上 branch。
    const activity = new Map(f.project.activity(50, 'work').tasks.map(task => [task.id, task]));
    expect(activity.get(response.task.id).branch).toBe(response.anchor.branch);
    expect(activity.get(root.id).branch).toBe('main');
    expect(await git(response.task.workspace, 'symbolic-ref', '--short', 'HEAD')).toBe(response.task.branch);
    expect(await f.project.workspaces.ensure(response.task)).toBe(response.task.workspace);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='planner'").n).toBe(0);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='input.route'").n).toBe(0);
    expect((await f.project.ensureMainTask()).id).toBe(root.id);
    expect(() => f.project.message(root.id, 'run in main')).toThrow('not an unrestricted Agent inbox');
    expect(() => f.project.spawn(root.id, 'write main')).toThrow('not unrestricted spawned work');
    expect(() => f.project.cancel(root.id)).toThrow('permanent root');
    await expect(f.project.order('another', 'feature/missing')).rejects.toThrow('explicitly bound Worker');
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
  } finally { await f.close(); }
});

test('create-only direct and buffered orders emit one persistent start-pending notice without invoking Agent', async () => {
  let calls = 0;
  const f = fixture({ async run() { calls++; return 'unexpected'; } }); await repo(f.root);
  try {
    for (const buffered of [false, true]) {
      const draft = buffered ? await f.project.addBufferedDraft('暂存后仅创建', [], 'main') : null;
      const sent = await f.project.order(draft ? undefined : '直接仅创建', 'main', [], draft?.id ?? null,
        false, draft?.revision);
      expect(sent.task).toMatchObject({ status: 'paused', calls: 0, agent_wakes: 0 });
      const [notice] = noticeHandlers['notice.list'](f.project, {}).filter(row => row.task_id === sent.task.id);
      expect(notice).toMatchObject({ kind: 'info', status: 'sent', read_at: null, lifecycle_type: 'created' });
      expect(notice.title).toContain(`Worker ${sent.task.worker_number} 待开始`);
      expect(notice.body).toContain('尚未调用 Agent'); expect(notice.body).toContain('手动开始');
      expect(f.store.get('SELECT type FROM events WHERE id=?', notice.source_event_id).type).toBe('task.start_pending');
      expect(f.project.notifyTaskLifecycle(sent.task.id, notice.source_event_id).id).toBe(notice.id);
      expect(noticeHandlers['notice.page'](f.project, { status: 'unread' }).notices.some(row => row.id === notice.id)).toBe(true);
      f.project.readNotice(notice.id);
      expect(f.store.task(sent.task.id).status).toBe('paused');
      expect(f.project.running.has(sent.task.id)).toBe(false);
      expect(f.store.all('SELECT * FROM notices WHERE task_id=?', sent.task.id)).toHaveLength(1);
    }
    expect(calls).toBe(0);
    f.project.stopping = true;
    const started = await f.project.order('立即开始不发待开始告知');
    expect(f.store.all('SELECT * FROM notices WHERE task_id=?', started.task.id)).toHaveLength(0);
    f.project.interrupt(started.task.id);
    expect(f.store.all('SELECT * FROM notices WHERE task_id=?', started.task.id)).toHaveLength(0);
  } finally { await f.close(); }
});

test('new order Task can spawn independent agent child and its settlement sends a typed parent signal', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const order = await f.project.order('develop');
    const child = await f.project.spawn(order.task.id, 'review changes', 'agent', [], 'review');
    expect(child).toMatchObject({ role: 'agent', task_kind: 'child', parent_id: order.task.id });
    const workspace = await f.project.workspaces.ensure(child);
    const stored = f.store.task(child.id);
    expect(stored.target_branch).toBe(order.task.branch);
    expect(f.store.branch(stored.branch).parent).toBe(order.task.branch);
    expect(workspace).not.toBe(order.task.workspace);
    f.project.finish(child.id, 'completed', 'child done');
    expect(f.store.task(order.task.id).status).toBe('queued');
    const unread = f.store.unread(order.task.id);
    expect(unread).toHaveLength(1);
    expect(unread[0].signal_type).toBe('child.completed');
    expect(JSON.parse(unread[0].body).payload.result).toBe('child done');
    f.project.finish(child.id, 'completed', 'duplicate');
    expect(f.store.unread(order.task.id)).toHaveLength(1);
    await expect(f.project.approveMerge(child.id)).rejects.toThrow('parent confirmation');
    await expect(f.project.approveBranchMerge(stored.branch)).rejects.toThrow('legacy branch.merge');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(order.anchor.commit);
  } finally { await f.close(); }
});

test('order.submit is user-only and the legacy input.submit path remains closed', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const dispatcher = new Dispatcher(f.project);
    // Buffered draft submission cannot override the saved body or ownership.
    await expect(dispatcher.dispatch('order.submit', { content: 'x', draft_id: 1 })).rejects.toThrow('cannot be combined');
    await expect(dispatcher.dispatch('input.submit', { content: 'legacy request' })).rejects.toThrow('unknown method');
    const mounted = await dispatcher.dispatch('order.submit', { content: 'new request' });
    expect(mounted).toMatchObject({ emitted: true, mode: 'order', dispatch: { state: 'queued' } });
    expect(mounted.task).toBeUndefined();
    expect(f.project.inputGet('draft', mounted.draft_id).content).toBe('new request');
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    await expect(dispatcher.dispatch('order.submit', { content: 'bad', _token: 'fake' })).rejects.toThrow();
  } finally { await f.close(); }
});

test('order Agent becomes idle after a call, can wake again, and can own another order child without waking main', async () => {
  const f = fixture(); await repo(f.root);
  try {
    const sent = await f.project.order('simple answer');
    await until(() => f.store.task(sent.task.id).status === 'waiting' && f.store.task(sent.task.id).calls === 1);
    expect(f.store.task(sent.task.id).head_commit).toBe(sent.anchor.commit);
    expect(f.store.task(sent.task.id).integration).toBe('none');
    expect(f.store.task(sent.task.parent_id)).toMatchObject({ status: 'waiting', calls: 0 });
    expect(f.store.unread(sent.task.parent_id)).toEqual([]);
    f.project.message(sent.task.id, 'please continue');
    await until(() => f.store.task(sent.task.id).status === 'waiting' && f.store.task(sent.task.id).calls === 2);
    const next = await f.project.order('follow-up on this branch', sent.task.branch);
    expect(next.task.parent_id).toBe(sent.task.id);
    expect(next.task.workspace).not.toBe(sent.task.workspace);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='planner'").n).toBe(0);
  } finally { await f.close(); }
});
