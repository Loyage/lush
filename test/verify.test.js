import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { fixture, repo, git, until, temp, gate } from './helpers.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { createSignal } from '../src/signal.js';
import { Store } from '../src/persistence/store.js';

/** 一个已完成的 worker：有 worktree、有提交、integration=pending。 */
async function completed(f, name = 'implement-feature') {
  const parent = f.project.submit('build').task;
  const worker = f.project.spawn(parent.id, 'implement', 'worker', [], name);
  const cwd = await f.project.workspaces.ensure(worker);
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'changed\n');
  await git(cwd, 'add', 'file.txt');
  await git(cwd, 'commit', '-m', 'implementation');
  await f.project.workspaces.finish(f.store.task(worker.id));
  f.store.update(worker.id, { status: 'completed' });
  return { parent, worker, cwd };
}
function writeReport(reportPath, title) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `<!doctype html><title>${title}</title>`);
}

test('a verification runs in the change worktree, checks out the target branch and publishes a report', async () => {
  const seen = [];
  const f = fixture({ async run(ctx) {
    if (ctx.task.role !== 'verifier') return 'noop';
    const verification = ctx.context.verification;
    // 基线在 invocation 结束后就被回收，所以在它还活着的时候取证。
    seen.push({ verification,
      baseline_file: fs.readFileSync(path.join(verification.baseline_workspace, 'file.txt'), 'utf8'),
      baseline_head: await git(verification.baseline_workspace, 'rev-parse', 'HEAD'),
      change_file: fs.readFileSync(path.join(verification.workspace, 'file.txt'), 'utf8') });
    writeReport(verification.report_path, '对照报告');
    return '改动后 file.txt=changed；基线 file.txt=base。';
  } });
  try {
    await repo(f.root);
    const { worker, cwd } = await completed(f);
    const verification = f.project.verify(worker.id);
    expect(verification.role).toBe('verifier');
    expect(verification.verifies_task_id).toBe(worker.id);
    expect(verification.name).toBe(`verify-${worker.id}`);
    expect(verification.parent_id).toBeNull();
    await until(() => f.store.task(verification.id).status === 'completed');

    const { verification: context, baseline_file, baseline_head, change_file } = seen[0];
    // 演示发生在被测 worktree 里；对照是目标分支当前的独立检出。
    expect(context.verified_task.id).toBe(worker.id);
    expect(context.workspace).toBe(cwd);
    expect(context.target_branch).toBe('main');
    expect(context.branch).toBe(f.store.task(worker.id).branch);
    expect(context.head_commit).toBe(f.store.task(worker.id).head_commit);
    expect(context.baseline_workspace).toStartWith(path.join(f.config.home, 'worktrees'));
    expect(context.report_path).toBe(path.join(f.config.home, 'verify', String(verification.id), 'report.html'));
    expect(baseline_head).toBe(await git(f.root, 'rev-parse', 'main'));
    expect(baseline_file).toBe('base\n');
    expect(change_file).toBe('changed\n');

    // 结算后对照基线被回收（派生状态），报告留在磁盘上。
    await until(() => f.store.task(verification.id).baseline_workspace === null);
    expect(fs.existsSync(context.baseline_workspace)).toBe(false);
    expect(fs.existsSync(context.report_path)).toBe(true);

    const inspect = f.project.inspect(worker.id);
    expect(inspect.verifications).toHaveLength(1);
    expect(inspect.verifications[0]).toMatchObject({ id: verification.id, status: 'completed', has_report: true, baseline_commit: context.baseline_commit });
    expect(f.project.inspect(verification.id).report).toBe(context.report_path);
    // 界面树上 verifier 挂在被检验任务下，而不是另起一棵根任务。
    expect(f.project.tree(worker.id).children.map(child => child.id)).toEqual([verification.id]);
    // 被检验任务本身没有被改动，仍待用户批准合并。
    expect(f.store.task(worker.id).integration).toBe('pending');
    expect(f.store.task(worker.id).head_commit).toBe(context.head_commit);
  } finally { await f.close(); }
});

test('verify only accepts a completed worker that still has its worktree and commit', async () => {
  const f = fixture();
  try {
    await repo(f.root);
    const parent = f.project.submit('build').task;
    expect(() => f.project.verify(parent.id)).toThrow('only a worker task');
    const worker = f.project.spawn(parent.id, 'implement', 'worker', [], 'implement-feature');
    expect(() => f.project.verify(worker.id)).toThrow('only a completed task');
    f.store.update(worker.id, { status: 'completed' });
    expect(() => f.project.verify(worker.id)).toThrow('no worktree or commit');
  } finally { await f.close(); }
});

test('one verification at a time, and agent credentials cannot start one', async () => {
  const pending = gate();
  let token = null;
  const f = fixture({ async run(ctx) {
    if (ctx.task.role !== 'verifier') return 'noop';
    token = ctx.token;
    await pending.promise;
    return 'done';
  } });
  try {
    await repo(f.root);
    const { worker } = await completed(f);
    const first = f.project.verify(worker.id);
    await until(() => f.store.task(first.id).status === 'running');
    // 等这次 invocation 真的拿到凭证（ensure 完成后 provider 才被调用）。
    await until(() => token !== null);
    expect(() => f.project.verify(worker.id)).toThrow(`verification #${first.id} is still running`);
    // task.verify 是用户专属：agent token 解析成功也必须被拒。
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    await expect(dispatcher.dispatch('task.verify', { id: worker.id, _token: token })).rejects.toThrow('user approval');
    pending.resolve();
    await until(() => f.store.task(first.id).status === 'completed');
    const second = f.project.verify(worker.id);
    expect(second.id).toBeGreaterThan(first.id);
    await until(() => f.store.task(second.id).status === 'completed');
    expect(f.project.inspect(worker.id).verifications.map(item => item.id)).toEqual([second.id, first.id]);
  } finally { await f.close(); }
});

test('a failed verification keeps its error and still reclaims the baseline', async () => {
  const f = fixture({ async run(ctx) {
    if (ctx.task.role !== 'verifier') return 'noop';
    throw new Error('演示脚本跑不起来');
  } });
  try {
    await repo(f.root);
    const { worker } = await completed(f);
    const verification = f.project.verify(worker.id);
    await until(() => f.store.task(verification.id).status === 'failed');
    expect(f.store.task(verification.id).error).toBe('演示脚本跑不起来');
    await until(() => f.store.task(verification.id).baseline_workspace === null);
    const [record] = f.project.inspect(worker.id).verifications;
    expect(record).toMatchObject({ id: verification.id, status: 'failed', has_report: false });
  } finally { await f.close(); }
});

test('recover reclaims the baseline of a verification interrupted by a restart', async () => {
  const f = fixture({ async run(ctx) { return ctx.task.role === 'verifier' ? 'done' : 'noop'; } });
  try {
    await repo(f.root);
    const { worker } = await completed(f);
    const verification = f.project.verify(worker.id);
    await until(() => f.store.task(verification.id).status === 'completed');
    // 再造一个真实基线，模拟「创建完就崩溃」的现场。
    const cwd = await f.project.workspaces.ensure(f.store.task(verification.id));
    expect(cwd).toBe(f.store.task(worker.id).workspace);
    const dir = f.store.task(verification.id).baseline_workspace;
    expect(fs.existsSync(dir)).toBe(true);
    f.store.update(verification.id, { status: 'running' });
    f.project.recover();
    expect(f.store.task(verification.id).status).toBe('failed');
    await until(() => f.store.task(verification.id).baseline_workspace === null);
    expect(fs.existsSync(dir)).toBe(false);
  } finally { await f.close(); }
});

test('an existing project.db gains the verification columns in place', () => {
  const root = temp();
  try {
    const file = path.join(root, 'project.db');
    const legacy = new Database(file, { create: true });
    legacy.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, parent_id INTEGER, input_id INTEGER,
        role TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', result TEXT, error TEXT,
        calls INTEGER NOT NULL DEFAULT 0, workspace TEXT, branch TEXT, base_commit TEXT, head_commit TEXT,
        integration TEXT NOT NULL DEFAULT 'none', target_branch TEXT, integration_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`);
    legacy.close();
    const store = new Store(file, root);
    const columns = new Set(store.all('PRAGMA table_info(tasks)').map(row => row.name));
    expect(columns.has('verifies_task_id')).toBe(true);
    expect(columns.has('baseline_workspace')).toBe(true);
    expect(columns.has('baseline_commit')).toBe(true);
    expect(columns.has('resolves_task_id')).toBe(true);
    store.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
