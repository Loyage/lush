import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from './helpers.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { createSignal } from '../src/signal.js';

/**
 * 合并冲突的完整链路：冲突 → 待决问题 → 解冲突任务 → --ff-only 落地。
 * 这些用例走的是 runtime 的真实路径（Project.approveMerge / answer / finish），
 * provider 只扮演「那个解冲突的 agent」：在自己的 worktree 里真的 git merge 并把冲突改掉。
 */

/** 冲突是预期结果，所以这里不能像 test/helpers.js 的 git() 那样抛错。 */
async function gitAttempt(cwd, ...args) {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, err: err.trim() };
}
/**
 * 一个真的在 worktree 里干活的 agent：worker 改文件并提交，merger 把审阅过的提交并进来、解冲突、提交合并。
 * 刻意不让测试自己往 worktree 里跑 git：任务在跑的时候 worktree 归 runtime 和它的 agent 所有，
 * 测试直接插手会和 finish 的干净检查抳 index.lock（这个 flake 真的出现过）。
 */
function gitWorker({ conflicting = 'worker\n', other = 'clean\n', resolved = 'resolved\n' } = {}) {
  return { async run(ctx) {
    if (ctx.task.role === 'worker') {
      const edits = ctx.task.name === 'conflicting' ? { 'file.txt': conflicting } : { 'other.txt': other };
      for (const [file, content] of Object.entries(edits)) fs.writeFileSync(path.join(ctx.cwd, file), content);
      await git(ctx.cwd, 'add', '-A');
      await git(ctx.cwd, 'commit', '-m', `${ctx.task.name} change`);
      return '已完成改动';
    }
    if (ctx.task.role === 'merger') {
      // 真的并进来、解冲突、提交这次 merge：git 以冲突退出是预期的。
      await gitAttempt(ctx.cwd, 'merge', ctx.context.merge_conflict.commit);
      fs.writeFileSync(path.join(ctx.cwd, 'file.txt'), resolved);
      await git(ctx.cwd, 'add', '-A');
      await git(ctx.cwd, 'commit', '-m', 'resolve merge conflict');
      return `已解冲突：file.txt=${resolved.trim()}`;
    }
    return 'noop';
  } };
}
/** 一个已完成、和 main 冲突的 worker，加一个独立的、干净可合的 worker。 */
async function colliding(f) {
  const input = f.project.submit('build').task;
  // 两个子任务先同步 spawn 完：planner 一旦拿到槽就可能结束，终态任务不能再派活。
  const conflicting = f.project.spawn(input.id, 'conflicting', 'worker', [], 'conflicting');
  const clean = f.project.spawn(input.id, 'independent', 'worker', [], 'independent');
  await until(() => f.store.task(conflicting.id).status === 'completed');
  await until(() => f.store.task(clean.id).status === 'completed');
  // 两个 worktree 都拉出来之后主树才前进：同一个文件两边都改，于是合并必然内容冲突。
  fs.writeFileSync(path.join(f.root, 'file.txt'), 'main\n');
  await git(f.root, 'add', '-A');
  await git(f.root, 'commit', '-m', 'main moves on');
  const snapshot = taskId => ({ ...f.store.task(taskId), cwd: f.store.task(taskId).workspace });
  return { input, colliding: snapshot(conflicting.id), clean: snapshot(clean.id) };
}

test('task.merge answers with a conflict payload instead of an error, and the notice drives the next round', async () => {
  const f = fixture(gitWorker());
  try {
    await repo(f.root);
    const { colliding: target } = await colliding(f);
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    // 临界：按钮调的就是这一条。冲突是正常返值，不是 Rpc 异常（否则界面只能看到一句 git 报错）。
    const result = await dispatcher.dispatch('task.merge', { id: target.id });
    expect(result.merge.status).toBe('conflict');
    expect(result.merge.files).toEqual(['file.txt']);
    expect(result.merge.notice_id).toBeGreaterThan(0);
    expect(f.project.status().merge_freeze).toEqual([{ task_id: target.id, resolves_task_id: result.merge.resolution_task_id, target_branch: 'main' }]);
    // 答复走过的也是用户通道；答复后解冲突任务开工。
    await dispatcher.dispatch('notice.answer', { id: result.merge.notice_id, answer: '批准' });
    await until(() => f.store.task(result.merge.resolution_task_id).status === 'completed');
    const landed = await dispatcher.dispatch('task.merge', { id: result.merge.resolution_task_id });
    expect(landed.merge).toEqual({ status: 'resolved', resolved_task_id: target.id });
    expect(f.project.status().merge_freeze).toEqual([]);
  } finally { await f.close(); }
});

test('a conflict becomes an awaiting resolution task with a notice, and lands with --ff-only', async () => {
  const f = fixture(gitWorker());
  try {
    await repo(f.root);
    const { colliding: target, clean } = await colliding(f);
    const baseHead = await git(f.root, 'rev-parse', 'HEAD');

    // 1) 批准合并 → 冲突不抛异常，而是给出冲突文件、把任务挂起、开一个解冲突任务并提问。
    const result = await f.project.approveMerge(target.id);
    expect(result.integration).toBe('conflict');
    expect(result.merge.status).toBe('conflict');
    expect(result.merge.files).toEqual(['file.txt']);
    const resolution = f.store.task(result.merge.resolution_task_id);
    expect(resolution).toMatchObject({ role: 'merger', status: 'awaiting', parent_id: null,
      resolves_task_id: target.id, target_branch: 'main', name: `resolve-${target.id}` });
    // 主树回到合并前的干净状态，也没有为「还没答应的任务」提前建 worktree。
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(baseHead);
    expect(await git(f.root, 'status', '--porcelain')).toBe('');
    expect(resolution.workspace).toBeNull();
    // notice 就是「请求开辟」的那次请示，挂在解冲突任务上（它是唯一还在等你决定的活任务）。
    const notice = f.store.get('SELECT * FROM notices WHERE id=?', result.merge.notice_id);
    expect(notice).toMatchObject({ status: 'open', task_id: resolution.id });
    expect(notice.title).toContain(`#${target.id}`);
    expect(notice.body).toContain('file.txt');
    // 树与读模型把解冲突任务挂在它服务的任务下面，但它不是子任务（终态任务不允许有活动后代）。
    expect(f.project.tree(target.id).children.map(child => child.id)).toEqual([resolution.id]);
    expect(f.project.inspect(target.id).resolutions.map(row => row.id)).toEqual([resolution.id]);

    // 2) 冲突未解决期间，同一目标分支上的其它合并被冻结。
    await expect(f.project.approveMerge(clean.id)).rejects.toThrow('frozen');

    // 3) 答复 notice → 解冲突任务开工 → 在目标分支基线上做出一个合并提交。
    f.project.answer(notice.id, '批准，开始解冲突');
    await until(() => f.store.task(resolution.id).status === 'completed');
    const resolved = f.store.task(resolution.id);
    expect(resolved.integration).toBe('pending');
    expect(resolved.base_commit).toBe(baseHead);
    expect(resolved.branch).toContain(`/${resolution.id}-resolve-${target.id}`);
    expect(await git(resolved.workspace, 'merge-base', '--is-ancestor', target.head_commit, resolved.head_commit)).toBe('');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseHead);            // 还没有落地

    // 4) 批准解冲突结果 → --ff-only 落地：main 的树就是它测过的那棵树，原任务一起收尾。
    const landed = await f.project.approveMerge(resolution.id);
    expect(landed.merge).toEqual({ status: 'resolved', resolved_task_id: target.id });
    expect(landed.integration).toBe('merged');
    expect(f.store.task(target.id).integration).toBe('merged');
    expect(f.store.task(target.id).integration_error).toBeNull();
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(resolved.head_commit);
    expect(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('resolved\n');
    expect(await git(f.root, 'status', '--porcelain')).toBe('');
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='merge.resolved'", target.id)).toHaveLength(1);
    // 冻结解除：另一个任务现在可以直接合并。
    expect((await f.project.approveMerge(clean.id)).integration).toBe('merged');
    expect(fs.readFileSync(path.join(f.root, 'other.txt'), 'utf8')).toBe('clean\n');
  } finally { await f.close(); }
});

test('dismissing the conflict notice revokes the resolution task and lifts the freeze', async () => {
  const f = fixture(gitWorker());
  try {
    await repo(f.root);
    const { colliding: target, clean } = await colliding(f);
    const result = await f.project.approveMerge(target.id);
    const resolutionId = result.merge.resolution_task_id;
    expect(f.project.answer(result.merge.notice_id, '', true).status).toBe('dismissed');
    // 从没被唤醒过的预置任务，请求被忽略就等于作废：不唤醒 agent 去做用户刚拒绝的事。
    expect(f.store.task(resolutionId).status).toBe('cancelled');
    expect(f.store.task(target.id).integration).toBe('pending');
    expect(f.store.task(target.id).integration_error).toContain('dismissed');
    expect(f.store.task(resolutionId).agent_wakes).toBe(0);
    // 冻结解除；再批准原任务会开新的一轮，而不是复用旧的。
    expect((await f.project.approveMerge(clean.id)).integration).toBe('merged');
    const again = await f.project.approveMerge(target.id);
    expect(again.merge.resolution_task_id).toBeGreaterThan(resolutionId);
    expect(f.store.task(target.id).integration).toBe('conflict');
  } finally { await f.close(); }
});

test('a resolution the target has moved past is superseded by the next round', async () => {
  const f = fixture(gitWorker());
  try {
    await repo(f.root);
    const { colliding: target } = await colliding(f);
    const first = await f.project.approveMerge(target.id);
    f.project.answer(first.merge.notice_id, '开始');
    await until(() => f.store.task(first.merge.resolution_task_id).status === 'completed');
    const resolutionId = first.merge.resolution_task_id;
    const resolution = f.store.task(resolutionId);

    // 用户直接往 main 提交（锁管不到编辑器/外部 git）：解冲突结果不再是「目标分支 + 那次提交」。
    fs.writeFileSync(path.join(f.root, 'main.txt'), 'moved\n');
    await git(f.root, 'add', '-A');
    await git(f.root, 'commit', '-m', 'main moves by hand');
    const moved = await git(f.root, 'rev-parse', 'HEAD');
    await expect(f.project.approveMerge(resolutionId)).rejects.toThrow('fast-forward');
    // 快进失败没有中间态：main 没被动过，原任务仍挂起（冻结也还在），解冲突任务留着等重试。
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(moved);
    expect(f.store.task(resolutionId).integration).toBe('pending');
    expect(f.store.task(target.id).integration).toBe('conflict');

    // 重试原任务的合并 = 明确抛弃那一轮：新一轮基于最新的目标分支，旧的那轮标成 superseded 并保留分支。
    const second = await f.project.approveMerge(target.id);
    expect(second.merge.superseded_task_id).toBe(resolutionId);
    expect(f.store.task(resolutionId).integration).toBe('superseded');
    expect(f.store.task(second.merge.resolution_task_id).status).toBe('awaiting');
    expect(f.project.inspect(target.id).resolutions.map(row => row.id)).toEqual([second.merge.resolution_task_id, resolutionId]);
  } finally { await f.close(); }
});

test('a resolution that drops the reviewed commit cannot land', async () => {
  // 这个「agent」没解冲突，只在基线上另写了一个提交：产物不含被并进来的那次提交。
  const workers = gitWorker();
  const f = fixture({ async run(ctx) {
    if (ctx.task.role !== 'merger') return workers.run(ctx);
    fs.writeFileSync(path.join(ctx.cwd, 'file.txt'), 'sneaky\n');
    await git(ctx.cwd, 'add', '-A');
    await git(ctx.cwd, 'commit', '-m', 'drop the reviewed work');
    return 'done';
  } });
  try {
    await repo(f.root);
    const { colliding: target } = await colliding(f);
    const result = await f.project.approveMerge(target.id);
    f.project.answer(result.merge.notice_id, '开始');
    await until(() => f.store.task(result.merge.resolution_task_id).status === 'completed');
    await expect(f.project.approveMerge(result.merge.resolution_task_id)).rejects.toThrow('does not contain the reviewed commit');
    expect(f.store.task(target.id).integration).toBe('conflict');
  } finally { await f.close(); }
});

test('only the runtime opens resolution tasks, and a failure releases the freeze', async () => {
  const workers = gitWorker();
  const f = fixture({ async run(ctx) {
    if (ctx.task.role !== 'merger') return workers.run(ctx);
    throw new Error('解冲突跑不下去');
  } });
  try {
    await repo(f.root);
    const { colliding: target, clean } = await colliding(f);
    // agent 不能自己派一个 merger：合并与解冲突都只由 runtime 在用户批准下开。
    const fresh = f.project.submit('build').task;
    expect(() => f.project.spawn(fresh.id, 'solve it', 'merger')).toThrow('role must be worker');
    const result = await f.project.approveMerge(target.id);
    const resolutionId = result.merge.resolution_task_id;
    f.project.answer(result.merge.notice_id, '开始');
    await until(() => f.store.task(resolutionId).status === 'failed');
    expect(f.store.task(resolutionId).error).toBe('解冲突跑不下去');
    // 解冲突失败了：原任务回到待合并（冻结解除），错误留在解冲突任务上。
    expect(f.store.task(target.id).integration).toBe('pending');
    expect(f.store.task(target.id).integration_error).toContain(`#${resolutionId} failed`);
    expect((await f.project.approveMerge(clean.id)).integration).toBe('merged');
  } finally { await f.close(); }
});
