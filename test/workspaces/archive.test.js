import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
import { setup, change } from './harness.js';

/** 一个停在调用里的 provider：任务保持 running，这样它的 token 才是活着的 agent 身份。 */
function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once: true });
    return done.promise;
  } };
}

/** 写一条最小的 pi 会话记录，让归档后的 transcript 真的读得到步骤。 */
function writeSession(f, taskId) {
  const dir = path.join(f.config.home, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2024-01-01T00-00-00-000Z_lush-task-${taskId}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', id: `s${taskId}` }),
    JSON.stringify({ type: 'message', timestamp: Date.now(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'archived work' }] } }),
  ].join('\n') + '\n');
  return file;
}

for (const condition of ['locked', 'prunable', 'submodule']) {
  test(`archive preflights ${condition} descendants before removing any parent, even with discard`, async () => {
    const f = await setup();
    try {
      const child = await f.project.spawn(f.task.id, 'descendant');
      const parentCwd = await change(f, f.task);
      const childCwd = await change(f, child, 'child', 'child.txt');
      const parentBranch = f.store.task(f.task.id).branch;
      if (condition === 'locked') await git(f.root, 'worktree', 'lock', '--reason', 'keep this\ncheckout', childCwd);
      if (condition === 'prunable') fs.rmSync(childCwd, { recursive: true });
      if (condition === 'submodule') {
        const source = path.join(f.config.home, 'submodule-source'); fs.mkdirSync(source);
        await repo(source);
        await git(childCwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'module');
        await git(childCwd, 'commit', '-am', 'add submodule');
      }
      await expect(f.project.archiveBranch(parentBranch, { discard_worktree: true })).rejects.toThrow(
        condition === 'submodule' ? 'initialized submodules' : condition);
      expect(fs.existsSync(parentCwd)).toBe(true);
      expect(await git(f.root, 'rev-parse', parentBranch)).toBe(f.store.task(f.task.id).head_commit);
      expect(await git(f.root, 'rev-parse', child.branch)).toBeTruthy();
      expect(f.store.branch(parentBranch).status).toBe('active');
      expect(f.store.branch(child.branch).status).toBe('active');
      expect(f.store.task(f.task.id).workspace).toBe(parentCwd);
      expect(f.store.all("SELECT * FROM events WHERE type='branch.archived'")).toEqual([]);
    } finally { await f.close(); }
  });
}

test('archiving removes the worktree and ref but keeps the task row, branch field and transcript', async () => {
  const f = await setup();
  try {
    const cwd = await change(f, f.task);
    const branch = f.store.task(f.task.id).branch;
    const session = writeSession(f, f.task.id);
    const tip = await git(f.root, 'rev-parse', branch);

    const result = await f.project.archiveBranch(branch);
    expect(result.branch).toBe(branch);
    expect(result.archived).toBe(true);
    expect(result.worktree).toBe('removed');
    expect(result.ref).toBe('deleted');
    expect(result.tip).toBe(tip);
    expect(result.tasks).toEqual([{ id: f.task.id, status: 'completed' }]);
    expect(result.sessions).toEqual([session]);

    // 磁盘上确实没有了，库里却还在——这正是「归档」与「删除」的分界。
    expect(fs.existsSync(cwd)).toBe(false);
    expect(await git(f.root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).not.toContain(branch);
    expect(f.store.branch(branch).status).toBe('archived');
    expect(f.store.branch(branch).deleted_at).toBeTruthy();
    const task = f.store.task(f.task.id);
    expect(task.branch).toBe(branch);
    expect(task.workspace).toBe(null);

    // 任务行与会话文件都在，所以执行过程仍读得回来。
    const transcript = f.project.transcript(f.task.id);
    expect(transcript.files).toHaveLength(1);
    expect(transcript.steps.some(step => step.body === 'archived work')).toBe(true);

    // 会话位置写进了归档事件，将来 clear 掉 tasks 行也查得回文件。
    const archivedEvents = f.store.all("SELECT * FROM events WHERE type='branch.archived' ORDER BY id").map(row => JSON.parse(row.data));
    expect(archivedEvents.some(data => Array.isArray(data.sessions) && data.sessions.includes(session))).toBe(true);
  } finally { await f.close(); }
});

test('a dirty worktree is refused by default and discarded only with discard_worktree', async () => {
  const f = await setup();
  try {
    const cwd = await change(f, f.task);
    const branch = f.store.task(f.task.id).branch;
    fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'uncommitted\n');

    await expect(f.project.archiveBranch(branch)).rejects.toThrow(/discard_worktree/);
    // 拒绝必须无副作用：目录、ref、记录一个都没动。
    expect(fs.existsSync(cwd)).toBe(true);
    expect(await git(f.root, 'branch', '--list', branch)).toContain(branch);
    expect(f.store.branch(branch).status).toBe('active');

    const result = await f.project.archiveBranch(branch, { discard_worktree: true });
    expect(result.worktree).toBe('removed');
    expect(result.discarded).toBe(true);
    expect(fs.existsSync(cwd)).toBe(false);
    expect(f.store.branch(branch).status).toBe('archived');
  } finally { await f.close(); }
});

test('a branch whose task has not finished is refused without side effects', async () => {
  const f = await setup();
  try {
    // 不走 change()：worktree 建好但任务还停在 queued，属于「活没干完」。
    const cwd = await f.project.workspaces.ensure(f.task);
    const branch = f.store.task(f.task.id).branch;
    await expect(f.project.archiveBranch(branch)).rejects.toThrow(`unfinished workers: ${f.task.worker_number}`);
    expect(fs.existsSync(cwd)).toBe(true);
    expect(await git(f.root, 'branch', '--list', branch)).toContain(branch);
    expect(f.store.branch(branch).status).toBe('active');
  } finally { await f.close(); }
});

test('re-archiving and unregistered branches are refused', async () => {
  const f = await setup();
  try {
    const cwd = await change(f, f.task);
    const branch = f.store.task(f.task.id).branch;
    await f.project.archiveBranch(branch);
    await expect(f.project.archiveBranch(branch)).rejects.toThrow(/already archived/);

    await git(f.root, 'branch', 'scratch');
    await expect(f.project.archiveBranch('scratch')).rejects.toThrow(/not a registered branch/);
    // 未登记的分支一个字节都不动。
    expect(await git(f.root, 'branch', '--list', 'scratch')).toContain('scratch');
    expect(fs.existsSync(cwd)).toBe(false);
  } finally { await f.close(); }
});

test('a branch whose ref is already gone can still be archived', async () => {
  const f = await setup();
  try {
    const cwd = await change(f, f.task);
    const branch = f.store.task(f.task.id).branch;
    // 模拟用户自己删掉了 ref（或上一次崩溃后 ref 已经不在了）。
    await git(f.root, 'worktree', 'remove', cwd);
    await git(f.root, 'update-ref', '-d', `refs/heads/${branch}`);

    const result = await f.project.archiveBranch(branch);
    expect(result.ref).toBe('absent');
    expect(result.tip).toBe(null);
    expect(result.worktree).toBe('absent');
    expect(f.store.branch(branch).status).toBe('archived');
    expect(f.store.task(f.task.id).branch).toBe(branch);
  } finally { await f.close(); }
});

test('archiving a descendant stops it from blocking its parent branch status', async () => {
  const f = await setup();
  try {
    const base = await git(f.root, 'rev-parse', 'main');
    await git(f.root, 'branch', 'feat-a', base);
    const tree = await git(f.root, 'rev-parse', 'main^{tree}');
    const ahead = await git(f.root, 'commit-tree', tree, '-p', base, '-m', 'child work');
    await git(f.root, 'branch', 'feat-b', ahead);
    f.store.recordBranch({ branch: 'feat-a', parent: 'main', created_from_commit: base });
    f.store.recordBranch({ branch: 'feat-b', parent: 'feat-a', created_from_commit: ahead });

    const before = await f.project.workspaces.branchState('feat-a');
    expect(before.blockers).toContain('feat-b');

    await f.project.archiveBranch('feat-b');
    const after = await f.project.workspaces.branchState('feat-a');
    expect(after.blockers).not.toContain('feat-b');
    expect(f.store.branch('feat-b').status).toBe('archived');
  } finally { await f.close(); }
});

test('归档子树：一条分支连同它的后代一起删掉，只留记录', async () => {
  const f = await setup();
  try {
    // 后一个任务从上一个 task 的分支长出来（branches.parent = stacked），
    // 于是 first -> second 是一条真正的父子分支链，两条各有自己的 worktree。
    const stacked = await f.project.spawn(f.task.id, 'stacked work', undefined, [], 'stacked-work');
    const firstCwd = await change(f, f.task);
    // 内容与文件名都要跟上游不同：stacked 分支的基线就是上游的顶端，写同一份内容会无东西可提交。
    const stackedCwd = await change(f, stacked, 'stacked\n', 'stacked.txt');
    const firstBranch = f.store.task(f.task.id).branch;
    const stackedBranch = f.store.task(stacked.id).branch;
    expect(f.store.branch(stackedBranch).parent).toBe(firstBranch);

    const result = await f.project.archiveBranch(firstBranch);
    expect(result.count).toBe(2);
    expect(result.branches.map(outcome => outcome.branch).sort()).toEqual([firstBranch, stackedBranch].sort());
    for (const outcome of result.branches) expect(outcome).toMatchObject({ worktree: 'removed', ref: 'deleted' });
    // 顶层字段描述的是子树根（调用方问的那一条），整棵子树看 branches。
    expect(result.worktree).toBe('removed');
    expect(result.tasks.map(task => task.id).sort()).toEqual([f.task.id, stacked.id].sort());

    // 磁盘与 ref 都没了——这才是「归档」；记录与任务行都留着。
    expect(fs.existsSync(firstCwd)).toBe(false);
    expect(fs.existsSync(stackedCwd)).toBe(false);
    const refs = await git(f.root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
    expect(refs).not.toContain(firstBranch);
    expect(refs).not.toContain(stackedBranch);
    expect(f.store.branch(firstBranch).status).toBe('archived');
    expect(f.store.branch(stackedBranch).status).toBe('archived');
    expect(f.store.task(stacked.id).branch).toBe(stackedBranch);
    expect(f.store.task(stacked.id).workspace).toBe(null);

    // 每条被归档的分支各留一条事件，后代不会被漏掉。
    const events = f.store.all("SELECT data FROM events WHERE type='branch.archived' ORDER BY id").map(row => JSON.parse(row.data));
    expect(new Set(events.map(data => data.branch))).toEqual(new Set([firstBranch, stackedBranch]));
  } finally { await f.close(); }
});

test('子树里有一条后代没干完，整棵子树都不归档、且无副作用', async () => {
  const f = await setup();
  try {
    const stacked = await f.project.spawn(f.task.id, 'stacked work', undefined, [], 'stacked-work');
    const firstCwd = await change(f, f.task);
    // 只建 worktree，下游任务还停在 queued：它的活没干完，整棵子树都不该被收起来。
    const stackedCwd = await f.project.workspaces.ensure(stacked);
    const firstBranch = f.store.task(f.task.id).branch;

    await expect(f.project.archiveBranch(firstBranch)).rejects.toThrow(`unfinished workers: ${stacked.worker_number}`);
    expect(fs.existsSync(firstCwd)).toBe(true);
    expect(fs.existsSync(stackedCwd)).toBe(true);
    expect(f.store.branch(firstBranch).status).toBe('active');
  } finally { await f.close(); }
});

test('子树第二条失败时保留已归档的第一条，库与磁盘一致，并可用 --continue 续办', async () => {
  const f = await setup();
  try {
    const stacked = await f.project.spawn(f.task.id, 'stacked work', undefined, [], 'stacked-work');
    const firstCwd = await change(f, f.task);
    const stackedCwd = await change(f, stacked, 'stacked\n', 'stacked.txt');
    const firstBranch = f.store.task(f.task.id).branch;
    const stackedBranch = f.store.task(stacked.id).branch;

    // 第一遍检查全部通过；第二遍在删第二条时注入未知失败。
    const original = f.project.workspaces.git.bind(f.project.workspaces);
    f.project.workspaces.git = async (cwd, ...args) => {
      if (cwd === f.root && args[0] === 'worktree' && args[1] === 'remove' && args.at(-1) === stackedCwd) {
        throw new Error('injected remove failure');
      }
      return original(cwd, ...args);
    };
    let result;
    try { result = await f.project.archiveBranch(firstBranch); } finally { f.project.workspaces.git = original; }

    expect(result.archived).toBe(true);
    expect(result.count).toBe(1);
    expect(result.branches.map(outcome => outcome.branch)).toEqual([firstBranch]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ branch: stackedBranch, ref: 'kept' });
    expect(result.failed[0].reason).toContain('injected remove failure');
    expect(result.remaining).toEqual([]);
    // 已删的那条：库里归档、workspace 清空；失败的那条：目录与记录原样保留。
    expect(fs.existsSync(firstCwd)).toBe(false);
    expect(f.store.branch(firstBranch).status).toBe('archived');
    expect(f.store.task(f.task.id).workspace).toBe(null);
    expect(fs.existsSync(stackedCwd)).toBe(true);
    expect(f.store.branch(stackedBranch).status).toBe('active');
    expect(f.store.task(stacked.id).workspace).toBe(stackedCwd);
    // 失败的那条没有被写成已归档；已归档的那条有事件。
    const archivedEvents = f.store.all("SELECT data FROM events WHERE type='branch.archived' ORDER BY id").map(row => JSON.parse(row.data));
    expect(archivedEvents.some(data => data.branch === firstBranch)).toBe(true);
    expect(archivedEvents.some(data => data.branch === stackedBranch)).toBe(false);
    const ledger = JSON.parse(f.store.get("SELECT data FROM events WHERE type='branch.archive' ORDER BY id DESC LIMIT 1").data);
    expect(ledger).toMatchObject({ branch: firstBranch, continued: false, completed: [firstBranch],
      failed: [{ branch: stackedBranch }], remaining: [] });

    // 根已归档：不续办仍按旧语义拒绝。
    await expect(f.project.archiveBranch(firstBranch)).rejects.toThrow(/already archived/);

    // 显式续办：只处理剩余后代，根不必重新归档。
    const continued = await f.project.archiveBranch(firstBranch, { continue: true });
    expect(continued.continued).toBe(true);
    expect(continued.count).toBe(1);
    expect(continued.branches.map(outcome => outcome.branch)).toEqual([stackedBranch]);
    expect(fs.existsSync(stackedCwd)).toBe(false);
    expect(f.store.branch(stackedBranch).status).toBe('archived');
    expect(f.store.task(stacked.id).workspace).toBe(null);

    // 幂等：没有剩余时明确返回 no_remainder，不报错也不重复删。
    const done = await f.project.archiveBranch(firstBranch, { continue: true });
    expect(done).toMatchObject({ continued: true, no_remainder: true, count: 0, branches: [] });
    expect(f.store.branch(stackedBranch).status).toBe('archived');
    // 根仍活动时 continue 没有意义：要求正常归档。
    expect(fs.existsSync(stackedCwd)).toBe(false);
  } finally { await f.close(); }
});

test('子树根失败时未处理的后代如实列为 remaining，且不谎报归档', async () => {
  const f = await setup();
  try {
    const stacked = await f.project.spawn(f.task.id, 'stacked work', undefined, [], 'stacked-work');
    const firstCwd = await change(f, f.task);
    const stackedCwd = await change(f, stacked, 'stacked\n', 'stacked.txt');
    const firstBranch = f.store.task(f.task.id).branch;
    const stackedBranch = f.store.task(stacked.id).branch;

    const original = f.project.workspaces.git.bind(f.project.workspaces);
    f.project.workspaces.git = async (cwd, ...args) => {
      if (cwd === f.root && args[0] === 'worktree' && args[1] === 'remove' && args.at(-1) === firstCwd) {
        throw new Error('injected root failure');
      }
      return original(cwd, ...args);
    };
    let result;
    try { result = await f.project.archiveBranch(firstBranch); } finally { f.project.workspaces.git = original; }

    expect(result.archived).toBe(false);
    expect(result.count).toBe(0);
    expect(result.branches).toEqual([]);
    expect(result.failed.map(entry => entry.branch)).toEqual([firstBranch]);
    expect(result.remaining).toEqual([stackedBranch]);
    // 一条都没删：两个目录、两条活动分支都还在。
    expect(fs.existsSync(firstCwd)).toBe(true);
    expect(fs.existsSync(stackedCwd)).toBe(true);
    expect(f.store.branch(firstBranch).status).toBe('active');
    expect(f.store.branch(stackedBranch).status).toBe('active');
    expect(f.store.task(f.task.id).workspace).toBe(firstCwd);
    // 根仍活动时 continue 无意义；直接重试正常归档即可（幂等，不重复删）。
    await expect(f.project.archiveBranch(firstBranch, { continue: true })).rejects.toThrow(/still active/);
    const retried = await f.project.archiveBranch(firstBranch);
    expect(retried.count).toBe(2);
    expect(fs.existsSync(firstCwd)).toBe(false);
    expect(fs.existsSync(stackedCwd)).toBe(false);
  } finally { await f.close(); }
});

test('branch.archive RPC 透传 continue 并拒绝未知参数', async () => {
  const f = await setup();
  try {
    const stacked = await f.project.spawn(f.task.id, 'stacked work', undefined, [], 'stacked-work');
    await change(f, f.task);
    await change(f, stacked, 'stacked\n', 'stacked.txt');
    const firstBranch = f.store.task(f.task.id).branch;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    await expect(rpc.dispatch('branch.archive', { branch: firstBranch, continue: true, nope: true })).rejects.toThrow('unknown parameter');
    await expect(rpc.dispatch('branch.archive', { branch: firstBranch, continue: true })).rejects.toThrow(/still active/);
    await rpc.dispatch('branch.archive', { branch: firstBranch });
    const done = await rpc.dispatch('branch.archive', { branch: firstBranch, continue: true });
    expect(done).toMatchObject({ branch: firstBranch, continued: true, no_remainder: true, count: 0, branches: [] });
  } finally { await f.close(); }
});

test('branch.archive is user-only: an agent token is rejected', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    await f.project.order('work');
    await until(() => provider.calls.length === 1);
    const rpc = new Dispatcher(f.project, createSignal(), {});
    // 归档会删 worktree 与本地 ref，是用户专属写操作，agent 不得调用。
    await expect(rpc.dispatch('branch.archive', { branch: 'anything', _token: provider.calls[0].token }))
      .rejects.toThrow('user approval');
    provider.calls[0].done.resolve('done');
    await until(() => f.project.running.size === 0);
  } finally { await f.close(); }
});

test('branch.archive RPC forwards branch and discard and returns archiveBranch result', async () => {
  const f = await setup();
  try {
    const cwd = await change(f, f.task);
    const branch = f.store.task(f.task.id).branch;
    fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'uncommitted\n');
    const rpc = new Dispatcher(f.project, createSignal(), {});
    await expect(rpc.dispatch('branch.archive', { branch, nope: true })).rejects.toThrow('unknown parameter');
    // discard 没给时按 false 透传：脏工作区被拒，提示显式 discard。
    await expect(rpc.dispatch('branch.archive', { branch })).rejects.toThrow(/discard_worktree/);
    const result = await rpc.dispatch('branch.archive', { branch, discard: true });
    expect(result).toMatchObject({ branch, archived: true, worktree: 'removed', ref: 'deleted', discarded: true });
    expect(result.tasks).toEqual([{ id: f.task.id, status: 'completed' }]);
    expect(fs.existsSync(cwd)).toBe(false);
  } finally { await f.close(); }
});


test('a terminal task whose invocation is still unwinding blocks archiving', async () => {
  const f = await setup();
  try {
    const cwd = await change(f, f.task);
    const branch = f.store.task(f.task.id).branch;
    f.project.running.set(f.task.id, {});
    await expect(f.project.archiveBranch(branch)).rejects.toThrow(`unfinished workers: ${f.task.worker_number}`);
    expect(fs.existsSync(cwd)).toBe(true);
    f.project.running.delete(f.task.id);
  } finally { await f.close(); }
});
