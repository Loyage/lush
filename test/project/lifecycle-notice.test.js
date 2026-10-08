import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, until, gate, temp, repo } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { AgentPreempted } from '../../src/agent/provider.js';
import { handlers } from '../../src/rpc/handlers/notice.js';
import { assertAllowed } from '../../src/rpc/registry.js';
import { run } from '../../src/cli/commands/notice.js';

function userTask(f, kind = 'order', patch = {}) {
  const row = f.store.create({ input_id: null, role: 'agent', task_kind: kind, goal: '用户的目标' });
  f.store.update(row.id, { status: 'waiting', ...(kind === 'order' ? { branch: `lush/test/${row.id}`, workspace: f.root } : {}), ...patch });
  return f.store.task(row.id);
}
const rows = (f, taskId) => f.store.all('SELECT * FROM notices WHERE task_id=? ORDER BY id', taskId);
function stubGit(f) {
  f.project.workspaces.ensure = async () => f.root;
  // These tests isolate notification policy without a repository or real branch ownership.
  f.project.workspaces.observeOwnedBranch = async () => null;
  f.project.workspaces.finish = async task => f.store.update(task.id, { head_commit: 'a'.repeat(40) });
  f.project.noteBranchAdvance = async () => {};
}
async function invoke(f, task) {
  f.project.wake(task.id);
  await until(() => f.store.task(task.id).calls > 0 && !f.project.running.has(task.id));
}
function idle(f, task) {
  return f.store.transaction(() => {
    const eventId = f.store.event(task.id, 'task.idle', {});
    return f.project.notifyTaskLifecycle(task.id, eventId);
  });
}

test('new lifecycle notices use Worker terminology without rewriting historical text or event names', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const task = userTask(f);
    const historical = f.project.notify(task.id, '任务已结束', '历史 Task 详情');
    const notice = idle(f, task);
    expect(notice.title).toStartWith(`Worker #${task.id} 本轮已结束`);
    expect(notice.body).toContain(`打开 Worker #${task.id} 查看详情`);
    expect(notice.body).not.toContain('任务');
    expect(notice.body).not.toContain('Task');
    expect(f.store.get('SELECT title,body FROM notices WHERE id=?', historical.id))
      .toEqual({ title: '任务已结束', body: '历史 Task 详情' });
    expect(f.store.get('SELECT type FROM events WHERE id=?', notice.source_event_id).type).toBe('task.idle');
  } finally { await f.close(); }
});

test('successful user order invocation emits one unread info, another completed round emits another', async () => {
  const f = fixture({ async run() { return '结果'; } });
  try {
    stubGit(f);
    const task = userTask(f);
    await invoke(f, task);
    expect(f.store.task(task.id).status).toBe('waiting');
    const [notice] = rows(f, task.id);
    expect(notice).toMatchObject({ kind: 'info', status: 'sent', read_at: null });
    expect(notice.source_event_id).toBeGreaterThan(0);
    expect(notice.title).toContain('本轮已结束');
    expect(notice.body).toContain('结果');
    expect(notice.body).toContain('不代表 Worker 已验收完成');
    expect(f.project.notifyTaskLifecycle(task.id, notice.source_event_id).id).toBe(notice.id);
    expect(rows(f, task.id)).toHaveLength(1);
    f.store.message(task.id, '继续'); f.project.wake(task.id);
    await until(() => f.store.task(task.id).calls === 2 && !f.project.running.has(task.id));
    expect(rows(f, task.id)).toHaveLength(2);
    expect(f.project.status().notices).toBe(0);
  } finally { await f.close(); }
});

test('hook suppresses children, branch owners, pending decisions, messages and active descendants', async () => {
  const f = fixture({ async run() { return 'ok'; } });
  try {
    f.project.stopping = true;
    for (const kind of ['child','main','owner','merge']) expect(idle(f, userTask(f, kind))).toBeNull();
    const task = userTask(f);
    const question = f.project.notice(task.id, '决定');
    expect(idle(f, task)).toBeNull();
    f.store.run("UPDATE notices SET status='dismissed' WHERE id=?", question.id);
    f.store.message(task.id, '新输入');
    expect(idle(f, task)).toBeNull();
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', task.id);
    const child = f.store.create({ input_id: null, parent_id: task.id, role: 'agent', task_kind: 'child', goal: '子任务' });
    expect(idle(f, task)).toBeNull();
    f.store.update(child.id, { status: 'awaiting_acceptance', integration: 'none' });
    expect(idle(f, task)?.kind).toBe('info');
  } finally { await f.close(); }
});

test('invocation waiting for question or child does not emit completion notice', async () => {
  for (const waitFor of ['question','child']) {
    const f = fixture({ async run({ task, api }) {
      if (waitFor === 'question') api.notice(task.id, '待决');
      else f.store.create({ parent_id: task.id, input_id: null, role: 'worker', goal: '未完成子任务' });
      return '还没完成';
    } });
    try {
      stubGit(f);
      const task = userTask(f);
      await invoke(f, task);
      expect(rows(f, task.id).filter(row => row.kind === 'info')).toEqual([]);
      expect(f.store.task(task.id).status).toBe(waitFor === 'question' ? 'awaiting' : 'waiting');
    } finally { await f.close(); }
  }
});

test('late decisions or children during Git finalization do not produce a false idle notice', async () => {
  for (const late of ['question','child']) {
    const f = fixture({ async run() { return 'done'; } });
    try {
      stubGit(f);
      f.project.noteBranchAdvance = async taskId => {
        if (late === 'question') f.project.notice(taskId, '后到问题');
        else f.store.create({ input_id: null, parent_id: taskId, role: 'worker', goal: '后到子任务' });
      };
      const task = userTask(f); await invoke(f, task);
      expect(rows(f, task.id).filter(row => row.kind === 'info')).toEqual([]);
      expect(f.store.task(task.id).status).toBe(late === 'question' ? 'awaiting' : 'waiting');
    } finally { await f.close(); }
  }
});

test('sync-resolution completion emits an idle notice while preserving awaiting acceptance', async () => {
  const f = fixture({ async run() { return '同步修复'; } });
  try {
    stubGit(f);
    f.project.settleTaskSyncResolution = async taskId => {
      f.store.update(taskId, { head_commit: 'a'.repeat(40), integration: 'merged' }); return true;
    };
    const task = userTask(f); await invoke(f, task);
    expect(f.store.task(task.id).status).toBe('awaiting_acceptance');
    expect(rows(f, task.id)).toHaveLength(1);
    expect(rows(f, task.id)[0].body).toContain('已合入父分支');
  } finally { await f.close(); }
});

test('failure/timeout produces one lifecycle info with exact reason; retry is a fresh event', async () => {
  for (const timeout of [false, true]) {
    const f = fixture({ run({ signal }) {
      if (!timeout) throw new Error('模型调用失败');
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    } });
    try {
      stubGit(f); if (timeout) f.config.configureRuntime({ call_timeout: 1 });
      const task = userTask(f);
      await invoke(f, task);
      expect(f.store.task(task.id).status).toBe('failed');
      expect(rows(f, task.id)).toHaveLength(1);
      const [notice] = rows(f, task.id);
      expect(notice.title).toContain('异常停止');
      expect(notice.body).toContain(timeout ? 'timed out after 1 second' : '模型调用失败');
      f.project.finish(task.id, 'failed', null, 'again');
      expect(rows(f, task.id)).toHaveLength(1);
      f.project.stopping = true;
      f.project.retry(task.id);
      f.project.finish(task.id, 'failed', null, '第二次失败');
      expect(rows(f, task.id)).toHaveLength(2);
    } finally { await f.close(); }
  }
});

test('user cancellation and paused successful invocation stay silent', async () => {
  const barrier = gate();
  const f = fixture({ async run() { await barrier.promise; return '安全收尾'; } });
  try {
    stubGit(f);
    const cancelled = userTask(f);
    f.project.cancel(cancelled.id);
    expect(rows(f, cancelled.id)).toEqual([]);
    const task = userTask(f);
    f.project.wake(task.id);
    await until(() => f.store.task(task.id).status === 'running');
    f.store.update(task.id, { status: 'paused' });
    barrier.resolve();
    await until(() => !f.project.running.has(task.id));
    expect(rows(f, task.id)).toEqual([]);
    expect(f.store.task(task.id).status).toBe('paused');
  } finally { barrier.resolve(); await f.close(); }
});

test('safe preemption preserves work without a false completion or failure notice', async () => {
  const f = fixture({ async run() { throw new AgentPreempted({ safe_point: 'turn_end', reason: 'user message' }); } });
  try {
    stubGit(f);
    const task = userTask(f); await invoke(f, task);
    expect(f.store.task(task.id).status).toBe('waiting');
    expect(rows(f, task.id)).toEqual([]);
    expect(f.store.history(task.id).some(event => event.type === 'invocation.preempted')).toBe(true);
  } finally { await f.close(); }
});

test('recovery marks running user Tasks and queued divergence repair failed exactly once', async () => {
  const f = fixture({ async run() { return 'unused'; } });
  try {
    f.project.stopping = true;
    const order = userTask(f, 'order', { status: 'running' });
    const analysis = userTask(f, 'analysis', { status: 'running' });
    const repair = userTask(f, 'order', { status: 'queued', reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'resolving' }) });
    f.project.recover(); f.project.recover();
    for (const task of [order, analysis, repair]) {
      expect(f.store.task(task.id).status).toBe('failed');
      expect(rows(f, task.id)).toHaveLength(1);
      expect(rows(f, task.id)[0].body).toContain('daemon interrupted');
    }
  } finally { await f.close(); }
});

test('analysis completion and checkout failure use lifecycle info without a duplicate legacy notice', async () => {
  const f = fixture({ async run() { return 'unused'; } });
  try {
    f.project.stopping = true;
    const task = userTask(f, 'analysis');
    f.project.finish(task.id, 'completed', '只读结论');
    expect(rows(f, task.id)).toHaveLength(1);
    expect(rows(f, task.id)[0].body).toContain('结论：只读结论');
    await repo(f.root); const parent = await f.project.ensureMainTask();
    const git = f.project.workspaces.git.bind(f.project.workspaces);
    f.project.workspaces.git = async (cwd, ...args) => {
      if (args[0] === 'worktree' && args[1] === 'add') throw new Error('磁盘不足');
      return git(cwd, ...args);
    };
    await expect(f.project.analyze(parent.id, '分析')).rejects.toThrow('磁盘不足');
    const failed = f.store.get("SELECT * FROM tasks WHERE task_kind='analysis' AND status='failed'");
    expect(rows(f, failed.id)).toHaveLength(1);
    expect(rows(f, failed.id)[0].body).toContain('analysis fork failed: 磁盘不足');
  } finally { await f.close(); }
});

test('state, source Event and Notice roll back together if hook insertion fails', async () => {
  const f = fixture({ async run() { return 'unused'; } });
  try {
    const task = userTask(f);
    f.store.run("CREATE TRIGGER fail_lifecycle_notice BEFORE INSERT ON notices WHEN NEW.source_event_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'notice unavailable'); END");
    expect(() => f.project.finish(task.id, 'failed', null, 'boom')).toThrow('notice unavailable');
    expect(f.store.task(task.id).status).toBe('waiting');
    expect(f.store.get("SELECT id FROM events WHERE task_id=? AND type='failed'", task.id)).toBeNull();
    expect(rows(f, task.id)).toEqual([]);
  } finally { await f.close(); }
});

test('read is user-only, idempotent, retains status and history and never wakes Tasks', async () => {
  const f = fixture({ async run() { throw new Error('must not run'); } });
  try {
    const task = userTask(f); const notice = idle(f, task);
    assertAllowed('notice.read', { id: notice.id }, null);
    expect(() => assertAllowed('notice.read', { id: notice.id }, task.id)).toThrow('requires user approval');
    const before = f.store.task(task.id);
    const first = handlers['notice.read'](f.project, { id: notice.id });
    expect(first.read_at).not.toBeNull(); expect(first.status).toBe('sent');
    expect(handlers['notice.read'](f.project, { id: notice.id }).read_at).toBe(first.read_at);
    expect(f.store.task(task.id)).toEqual(before);
    expect(f.project.running.size).toBe(0);
    expect(f.store.history(task.id).filter(event => event.type === 'notice.read')).toHaveLength(1);
    const question = f.project.notice(task.id, '问题');
    expect(() => f.project.readNotice(question.id)).toThrow('only sent info');
    expect(() => f.project.readNotice(99999)).toThrow('only sent info');
    const calls = [];
    await run('notice', ['read', String(notice.id)], { client: { async request(...args) { calls.push(args); return first; } } });
    expect(calls).toEqual([['notice.read', { id: notice.id }]]);
    await expect(run('notice', ['read', String(notice.id), 'extra'], { client: {} })).rejects.toThrow();
  } finally { await f.close(); }
});

test('unread pagination excludes history/read infos; list keeps older unread before newer historical notices', async () => {
  const f = fixture({ async run() { return 'unused'; } });
  try {
    const task = userTask(f), older = idle(f, task), newer = idle(f, task);
    f.store.transaction(() => {
      for (let i = 0; i < 210; i++) f.project.notify(task.id, `历史 ${i}`);
    });
    const question = f.project.notice(task.id, '待决');
    const list = handlers['notice.list'](f.project, {});
    expect(list.slice(0, 3).map(row => row.id)).toEqual([question.id, newer.id, older.id]);
    expect(handlers['notice.page'](f.project, { status: 'unread', limit: 1 })).toMatchObject({ cursor: newer.id, has_more: true });
    expect(handlers['notice.page'](f.project, { status: 'unread', before: newer.id }).notices.map(row => row.id)).toEqual([older.id]);
    f.project.readNotice(newer.id);
    expect(handlers['notice.page'](f.project, { status: 'unread' }).notices.map(row => row.id)).toEqual([older.id]);
    expect(() => f.store.run("INSERT INTO notices(task_id,title,body,kind,status,source_event_id) VALUES (?,?,'','info','sent',?)", task.id, 'duplicate', older.source_event_id)).toThrow('UNIQUE');
  } finally { await f.close(); }
});

test('opening old schema adds nullable lifecycle fields without rewriting old info records', () => {
  const root = temp(), file = path.join(root, 'old.db');
  let store;
  try {
    const db = new Database(file);
    db.exec("CREATE TABLE notices (id INTEGER PRIMARY KEY,task_id INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',answer TEXT,kind TEXT NOT NULL DEFAULT 'question',created_at TEXT NOT NULL DEFAULT 'old'); INSERT INTO notices(task_id,title,body,status,kind) VALUES (1,'历史','正文','sent','info')");
    db.close(); store = new Store(file, root);
    expect(store.get('SELECT * FROM notices WHERE id=1')).toMatchObject({ title: '历史', body: '正文', created_at: 'old', source_event_id: null, read_at: null });
    expect(store.all("SELECT * FROM notices WHERE source_event_id IS NOT NULL AND read_at IS NULL")).toEqual([]);
    store.close(); store = new Store(file, root);
    expect(store.get('SELECT title FROM notices WHERE id=1').title).toBe('历史');
  } finally { store?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
