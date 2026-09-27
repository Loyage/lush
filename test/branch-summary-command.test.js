import { test, expect } from 'bun:test';
import { handlers } from '../src/rpc/handlers/branch.js';
import { PARAMS, USER_ONLY, AGENT_ONLY, assertAllowed } from '../src/rpc/registry.js';
import { run } from '../src/cli/commands/branch.js';
import { setup, change } from './workspaces/harness.js';

// 分支摘要的用户接口：RPC handler 的目标分支解析与越权校验、CLI 的两种调用形式，
// 以及 core 只落摘要 + 事件、拒绝非法内容的契约。（store / graph 那一半由 #114 的 branch-summary.test.js 覆盖。）

const summary = (f, params, actor) => handlers['branch.summary'](f.project, params, actor);

test('handler：省略 branch 时 worker / merger 写自己的分支', async () => {
  const f = await setup();
  try {
    await change(f, f.task, 'A\n');
    const worker = f.store.task(f.task.id);
    expect(worker.branch).toBeTruthy();

    const updated = await summary(f, { summary: '实现分支摘要' }, worker.id);
    expect(updated.branch).toBe(worker.branch);
    expect(f.store.branch(worker.branch).summary).toBe('实现分支摘要');
    // 事件挂在拥有这条分支的任务上（worker 分支的 task_id 就是 worker）。
    const event = f.store.history(worker.id).find(row => row.type === 'branch.summary');
    expect(event.data).toEqual({ branch: worker.branch, summary: '实现分支摘要' });

    // merger 没有输入锚点，也解析自己的 task.branch。
    const merger = f.store.create({ input_id: null, role: 'merger', goal: 'sync' });
    f.store.update(merger.id, { branch: 'lush/test/merger-branch' });
    f.store.recordBranch({ branch: 'lush/test/merger-branch', parent: 'main', task_id: merger.id });
    const merged = await summary(f, { summary: '吸收父分支' }, merger.id);
    expect(merged.branch).toBe('lush/test/merger-branch');
    expect(f.store.branch('lush/test/merger-branch').summary).toBe('吸收父分支');
  } finally { await f.close(); }
});

test('handler：省略 branch 时 planner 写自己输入的锚点分支', async () => {
  const f = await setup();
  try {
    const input = await f.project.submit('把分支标题写成摘要');
    const anchor = f.store.get('SELECT anchor_branch FROM inputs WHERE id=?', input.id).anchor_branch;
    expect(anchor).toBeTruthy();

    const updated = await summary(f, { summary: '让分支标题有摘要' }, input.task.id);
    expect(updated.branch).toBe(anchor);
    expect(f.store.branch(anchor).summary).toBe('让分支标题有摘要');
    // 锚点分支没有任务，事件挂在输入的规划任务上。
    const event = f.store.history(input.task.id).find(row => row.type === 'branch.summary');
    expect(event.data).toEqual({ branch: anchor, summary: '让分支标题有摘要' });
  } finally { await f.close(); }
});

test('handler：agent 写别人的分支被拒，且不留任何写入', async () => {
  const f = await setup();
  try {
    await change(f, f.task, 'A\n');
    const worker = f.store.task(f.task.id);
    f.store.recordBranch({ branch: 'lush/test/other', parent: 'main' });

    expect(() => summary(f, { branch: 'lush/test/other', summary: '越权' }, worker.id)).toThrow(/does not belong/);
    expect(f.store.branch('lush/test/other').summary).toBeNull();
    expect(f.store.history(worker.id).some(row => row.type === 'branch.summary')).toBe(false);
  } finally { await f.close(); }
});

test('handler：用户可写任意已登记分支，但必须显式点名；未登记分支报错', async () => {
  const f = await setup();
  try {
    f.store.recordBranch({ branch: 'lush/test/user', parent: 'main' });
    const updated = await summary(f, { branch: 'lush/test/user', summary: '用户写的标题' }, null);
    expect(updated.branch).toBe('lush/test/user');
    expect(f.store.branch('lush/test/user').summary).toBe('用户写的标题');

    expect(() => summary(f, { summary: '没点名' }, null)).toThrow(/name the branch/);
    expect(() => summary(f, { branch: 'lush/test/missing', summary: 'x' }, null)).toThrow(/not a registered branch/);
  } finally { await f.close(); }
});

test('core：非法摘要被拒，成功时只写 summary 这一列', async () => {
  const f = await setup();
  try {
    f.store.recordBranch({ branch: 'lush/test/keep', parent: 'main' });
    const before = f.store.branch('lush/test/keep');
    expect(() => summary(f, { branch: 'lush/test/keep', summary: '   ' }, null)).toThrow(/1\.\.120/);
    expect(() => summary(f, { branch: 'lush/test/keep', summary: 'x'.repeat(121) }, null)).toThrow(/1\.\.120/);
    expect(f.store.branch('lush/test/keep').summary).toBeNull();

    await summary(f, { branch: 'lush/test/keep', summary: '  只改标题  ' }, null);
    const after = f.store.branch('lush/test/keep');
    expect(after.summary).toBe('只改标题');
    expect(after.status).toBe(before.status);
    expect(after.parent).toBe(before.parent);
    expect(after.deleted_at).toBe(before.deleted_at);
  } finally { await f.close(); }
});

test('registry：branch.summary 是 agent 可写的元数据，不在 USER_ONLY / AGENT_ONLY', () => {
  expect(PARAMS['branch.summary']).toEqual(['branch', 'summary']);
  expect(USER_ONLY.has('branch.summary')).toBe(false);
  expect(AGENT_ONLY.has('branch.summary')).toBe(false);
  expect(assertAllowed('branch.summary', {}, null)).toBeNull();
  expect(assertAllowed('branch.summary', {}, 5)).toBe(5);
  expect(() => assertAllowed('branch.summary', { nope: 1 }, null)).toThrow();
});

/** 一个只记录请求的 client：CLI 的职责就是把参数翻译成 RPC 调用，不需要真 daemon。 */
function clientStub(result) {
  const calls = [];
  return { calls, async request(method, params) { calls.push({ method, params }); return result; } };
}

test('CLI：branch summary 支持「写自己分支」与「指定分支」两种形式', async () => {
  const result = { branch: 'lush/h/1-a', summary: '一句话' };
  const own = clientStub(result);
  expect(await run('branch', ['summary', '一句话'], { client: own, json: true })).toEqual(result);
  expect(own.calls).toEqual([{ method: 'branch.summary', params: { summary: '一句话' } }]);

  const explicit = clientStub(result);
  await run('branch', ['summary', 'lush/h/1-a', '一句话'], { client: explicit, json: true });
  expect(explicit.calls).toEqual([{ method: 'branch.summary', params: { branch: 'lush/h/1-a', summary: '一句话' } }]);

  // 0 个或 3 个位置参数不能悄悄当成别的命令。
  await expect(run('branch', ['summary'], { client: clientStub(result), json: true })).rejects.toThrow();
  await expect(run('branch', ['summary', 'a', 'b', 'c'], { client: clientStub(result), json: true })).rejects.toThrow();
});

test('CLI：非 JSON 输出打印分支名与摘要', async () => {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await run('branch', ['summary', 'lush/h/1-a', '一句话'], { client: clientStub({ branch: 'lush/h/1-a', summary: '一句话' }), json: false });
  } finally { console.log = original; }
  expect(logs.join('\n')).toContain('lush/h/1-a');
  expect(logs.join('\n')).toContain('一句话');
});
