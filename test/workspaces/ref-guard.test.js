import { test, expect, setDefaultTimeout } from 'bun:test';
import { fixture, repo, git, gate } from '../helpers.js';
setDefaultTimeout(15000);

async function setup() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  return { ...f, workspaces: f.project.workspaces };
}

const commit = cwd => git(cwd, 'commit', '--allow-empty', '-m', 'guard sample');

test('不同时间的观测窗口各自只接受连接自身基线的同 ref 转移', async () => {
  const f = await setup();
  try {
    const first = await f.workspaces.watchBranch('main');
    await f.workspaces.git(f.root, 'commit', '--allow-empty', '-m', 'first authorized');
    const second = await f.workspaces.watchBranch('main');
    await f.workspaces.git(f.root, 'commit', '--allow-empty', '-m', 'second authorized');
    expect(first.baseline).not.toBe(second.baseline);
    expect((await f.workspaces.checkWatchedBranch(first)).explained).toBe(true);
    expect((await f.workspaces.checkWatchedBranch(second)).explained).toBe(true);
    await commit(f.root); // Earlier authorized transitions cannot cover this final movement.
    expect((await f.workspaces.checkWatchedBranch(first)).explained).toBe(false);
    expect((await f.workspaces.checkWatchedBranch(second)).explained).toBe(false);
    f.workspaces.unwatchBranch(first); f.workspaces.unwatchBranch(second);
    expect(f.workspaces.refWatches.size).toBe(0);
  } finally { await f.close(); }
});

test('ref 已写但精确收据尚未收口时，检测等待该 ref 的在途写入', async () => {
  const f = await setup(), written = gate(), finish = gate();
  let operation, checking;
  try {
    const watch = await f.workspaces.watchBranch('main');
    operation = f.workspaces.trackRefWrite(watch.ref, async () => {
      await commit(f.root); written.resolve(); await finish.promise;
    });
    await written.promise;
    let checked = false;
    checking = f.workspaces.checkWatchedBranch(watch).then(value => { checked = true; return value; });
    await Promise.resolve();
    expect(checked).toBe(false); expect(f.workspaces.refWrites.get(watch.ref).size).toBe(1);
    finish.resolve(); await operation;
    expect((await checking).explained).toBe(true);
    expect(f.workspaces.refWrites.size).toBe(0);
    f.workspaces.unwatchBranch(watch);
  } finally { finish.resolve(); await Promise.allSettled([operation, checking].filter(Boolean)); await f.close(); }
});

test('daemon 命令先启动、调用观测后注册时仍取得成功转移证据', async () => {
  const f = await setup(), started = gate(), allowWrite = gate();
  let writing;
  try {
    const track = f.workspaces.trackRefWrite.bind(f.workspaces);
    f.workspaces.trackRefWrite = (ref, action, expected) => track(ref, async () => {
      started.resolve(); await allowWrite.promise; return action();
    }, expected);
    writing = f.workspaces.git(f.root, '-c', 'user.name=Guard Test', 'commit', '--allow-empty', '-m', 'in flight before watch');
    await started.promise;
    expect(f.workspaces.refWatches.size).toBe(0);
    const watch = await f.workspaces.watchBranch('main');
    allowWrite.resolve(); await writing;
    expect((await f.workspaces.checkWatchedBranch(watch)).explained).toBe(true);
    expect(watch.transitions).toHaveLength(1);
    f.workspaces.unwatchBranch(watch);
  } finally { allowWrite.resolve(); await Promise.allSettled([writing].filter(Boolean)); await f.close(); }
});

test('具名 update-ref 的 CAS 成功才记录准确目标，不混淆当前 checkout', async () => {
  const f = await setup();
  try {
    const watch = await f.workspaces.watchBranch('main');
    const tree = await git(f.root, 'rev-parse', 'HEAD^{tree}');
    const commit = await git(f.root, 'commit-tree', tree, '-p', watch.baseline, '-m', 'CAS landing');
    await f.workspaces.git(f.root, 'update-ref', '-m', 'Lush landing', watch.ref, commit, watch.baseline);
    expect(await f.workspaces.checkWatchedBranch(watch)).toMatchObject({ explained: true, after: commit });
    await expect(f.workspaces.git(f.root, 'update-ref', watch.ref, watch.baseline, watch.baseline)).rejects.toThrow();
    expect(watch.transitions).toEqual([{ before: watch.baseline, after: commit, source: { kind: 'daemon' } }]);
    expect(f.workspaces.refWrites.size).toBe(0);
    f.workspaces.unwatchBranch(watch);
  } finally { await f.close(); }
});

test('失败的写入即使留下副作用也没有成功收据，并释放在途状态', async () => {
  const f = await setup();
  try {
    const watch = await f.workspaces.watchBranch('main');
    await expect(f.workspaces.trackRefWrite(watch.ref, async () => {
      await commit(f.root); throw new Error('write outcome not confirmed');
    })).rejects.toThrow('not confirmed');
    expect(watch.transitions).toEqual([]);
    expect((await f.workspaces.checkWatchedBranch(watch)).explained).toBe(false);
    expect(f.workspaces.refWrites.size).toBe(0);
    f.workspaces.unwatchBranch(watch);
  } finally { await f.close(); }
});

test('证据数量有界，溢出不得退化成任意移动豁免', async () => {
  const f = await setup();
  try {
    const watch = await f.workspaces.watchBranch('main');
    await commit(f.root); const after = await git(f.root, 'rev-parse', 'HEAD');
    for (let i = 0; i < 4100; i++) f.workspaces.noteRefTransition(watch.ref, watch.baseline, after, { kind: 'daemon' });
    expect(watch.transitions.length).toBe(4096);
    expect(await f.workspaces.checkWatchedBranch(watch)).toMatchObject({ explained: false, overflow: true });
    f.workspaces.unwatchBranch(watch);
  } finally { await f.close(); }
});

test('调用中途丢失 worktree 分支身份时，不能把移动认作所属 Worker 观测', async () => {
  const f = await setup();
  try {
    const task = (await f.project.order('owner')).task;
    const owner = await f.workspaces.observeOwnedBranch(task, task.workspace, 123);
    const watch = await f.workspaces.watchBranch(task.branch);
    await commit(task.workspace);
    await git(task.workspace, 'checkout', '--detach');
    await f.workspaces.closeOwnedBranch(owner);
    expect(watch.transitions).toEqual([]);
    expect((await f.workspaces.checkWatchedBranch(watch)).explained).toBe(false);
    expect(f.workspaces.refOwners.size).toBe(0);
    f.workspaces.unwatchBranch(watch);
  } finally { await f.close(); }
});
