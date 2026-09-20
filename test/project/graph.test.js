import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, git } from '../helpers.js';
import { setup, change } from '../workspaces/harness.js';

// 分支图读模型：节点 / 边 / ahead-behind / merged / 缺失容错 / 只读 / 上限。
// 每个用例自给自足：setup() 造一个真 git 仓库 + 一个可派活的 coordinator 父任务。

test('graph reports code stacking, ahead/behind and merge state', async () => {
  const f = await setup();
  try {
    const task = f.task;
    await change(f, task, 'A\n');
    const child = f.project.spawn(task.parent_id, 'continue on top', 'worker', [{ id: task.id, kind: 'code' }], 'stacked');
    await change(f, child, 'B\n');

    const graph = await f.project.graph();
    expect(graph.git).toBe(true);
    expect(graph.error).toBeNull();
    expect(graph.current_branch).toBe('main');
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const upstream = nodes.get(task.id);
    const downstream = nodes.get(child.id);
    expect(upstream.kind).toBe('task');
    expect(upstream.branch_state).toBe('present');
    expect(upstream.workspace_state).toBe('present');
    expect(upstream.ahead).toBe(1); expect(upstream.behind).toBe(0); expect(upstream.merged).toBe(false);
    expect(downstream.target_branch).toBe('main');
    expect(downstream.ahead).toBe(2); expect(downstream.merged).toBe(false);
    expect(downstream.current).toBe(false);

    const mainBranch = graph.nodes.find(node => node.kind === 'branch' && node.name === 'main');
    expect(mainBranch.id).toBe('branch:main');
    expect(mainBranch.current).toBe(true);

    expect(graph.edges).toContainEqual({ kind: 'code', from: task.id, to: child.id });
    expect(graph.edges).toContainEqual({ kind: 'target', from: task.id, to: `branch:${f.store.task(task.id).target_branch}` });
    expect(graph.edges).toContainEqual({ kind: 'target', from: child.id, to: `branch:${f.store.task(child.id).target_branch}` });

    // 上游落地后：merged=true，ahead 归零；下游仍领先一条自己的提交。
    await f.project.workspaces.merge(task.id);
    const after = await f.project.graph();
    const byId = new Map(after.nodes.map(node => [node.id, node]));
    expect(byId.get(task.id).merged).toBe(true);
    expect(byId.get(task.id).ahead).toBe(0); expect(byId.get(task.id).behind).toBe(0);
    expect(byId.get(child.id).merged).toBe(false);
    expect(byId.get(child.id).ahead).toBe(1);
  } finally { await f.close(); }
});

test('graph carries resolve and verify edges and tolerates missing worktree/branch', async () => {
  const f = await setup();
  try {
    await change(f, f.task, 'A\n');
    const merger = f.store.create({ input_id: null, role: 'merger', goal: 'resolve x', name: 'resolve-x', resolves_task_id: f.task.id });
    f.store.update(merger.id, { branch: 'lush/test/resolve-x', workspace: path.join(f.config.home, 'worktrees', 'gone-merger') });
    const verifier = f.store.create({ input_id: null, role: 'verifier', goal: 'verify x', name: 'verify-x', verifies_task_id: f.task.id });
    f.store.update(verifier.id, { baseline_workspace: path.join(f.config.home, 'worktrees', 'gone-baseline') });

    const graph = await f.project.graph();
    expect(graph.edges).toContainEqual({ kind: 'resolve', from: merger.id, to: f.task.id });
    expect(graph.edges).toContainEqual({ kind: 'verify', from: verifier.id, to: f.task.id });
    const mergerNode = graph.nodes.find(node => node.id === merger.id);
    expect(mergerNode.workspace_state).toBe('missing');
    expect(mergerNode.branch_state).toBe('missing');
    const verifierNode = graph.nodes.find(node => node.id === verifier.id);
    expect(verifierNode).toBeTruthy();
    expect(verifierNode.workspace_state).toBe('missing');

    // 目录是在跑图之后才被删的：下一次取值报 missing，而且不抛。
    const worker = f.store.task(f.task.id);
    fs.rmSync(worker.workspace, { recursive: true, force: true });
    const again = await f.project.graph();
    expect(again.nodes.find(node => node.id === f.task.id).workspace_state).toBe('missing');
  } finally { await f.close(); }
});

test('graph covers recorded branches, untracked refs and placeholder parents with fork edges', async () => {
  const f = await setup();
  try {
    // 模拟提交输入时创建的锚点分支：有记录、没有任务、parent 是 main（不调用主树未提交的 anchor）。
    f.store.recordBranch({ branch: 'lush/test/input-1-anchor', parent: 'main', worktree: path.join(f.config.home, 'worktrees', 'anchor') });
    // 用户在 git 里新建、既没记录也没任务的本地分支。
    await git(f.root, 'branch', 'feature/scratch');
    // 记录里提到、却既无记录也无 ref 的父分支名：补占位节点，不让子分支从图上掉下去。
    f.store.recordBranch({ branch: 'lush/test/orphan-child', parent: 'lush/test/gone-parent' });

    const graph = await f.project.graph();
    expect(graph.git).toBe(true);
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));

    // branches 表的每条记录都有 branch 节点：没有 ref 的锚点也在，head_commit 现算成 null。
    const anchor = nodes.get('branch:lush/test/input-1-anchor');
    expect(anchor).toMatchObject({ kind: 'branch', current: false, tracked: true, placeholder: false, head_commit: null });
    expect(nodes.get('branch:lush/test/orphan-child')).toMatchObject({ kind: 'branch', tracked: true });

    // 有 ref 但没有记录的本地分支：tracked:false，head_commit 与 current 现算。
    const scratch = nodes.get('branch:feature/scratch');
    expect(scratch).toMatchObject({ kind: 'branch', tracked: false, placeholder: false, current: false });
    expect(scratch.head_commit).toBe(await git(f.root, 'rev-parse', 'refs/heads/feature/scratch'));
    expect(nodes.get('branch:main')).toMatchObject({ current: true, tracked: false });

    // 只被 parent 指针提到的名字：占位节点，不假装分支还在。
    const gone = nodes.get('branch:lush/test/gone-parent');
    expect(gone).toMatchObject({ kind: 'branch', tracked: false, placeholder: true, head_commit: null });

    // 谱系边：记录了 parent 的分支都给出 fork 边，两端都在节点集合里（含占位父）。
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: 'fork', from: 'branch:main', to: 'branch:lush/test/input-1-anchor', status: 'missing' }));
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: 'fork', from: 'branch:lush/test/gone-parent', to: 'branch:lush/test/orphan-child', status: 'missing' }));
  } finally { await f.close(); }
});

test('graph returns an empty, non-throwing result for a non-git project', async () => {
  const f = fixture();
  try {
    f.project.stopping = true;
    const graph = await f.project.graph();
    expect(graph.git).toBe(false);
    expect(graph.error).toBeTruthy();
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.truncated).toBe(false);
  } finally { await f.close(); }
});

test('graph is read-only: it never changes the main tree, its HEAD, or the event log', async () => {
  const f = await setup();
  try {
    await change(f, f.task, 'A\n');
    const beforeStatus = await git(f.root, 'status', '--porcelain');
    const beforeHead = await git(f.root, 'rev-parse', 'HEAD');
    const beforeEvents = f.store.get('SELECT count(*) AS c FROM events').c;
    await f.project.graph();
    expect(await git(f.root, 'status', '--porcelain')).toBe(beforeStatus);
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(beforeHead);
    expect(f.store.get('SELECT count(*) AS c FROM events').c).toBe(beforeEvents);
  } finally { await f.close(); }
});

test('graph caps nodes at 200 and marks the result truncated', async () => {
  const f = await setup();
  try {
    for (let index = 0; index < 205; index += 1) {
      const task = f.store.create({ input_id: null, role: 'worker', goal: `task ${index}` });
      f.store.update(task.id, { branch: `lush/test/${task.id}-node` });
    }
    const graph = await f.project.graph();
    expect(graph.truncated).toBe(true);
    expect(graph.nodes.length).toBe(200);
    // 当前检出分支一定在（给分支节点预留了额度）。
    expect(graph.nodes.some(node => node.kind === 'branch' && node.name === 'main')).toBe(true);
  } finally { await f.close(); }
});

test('graph caps edges at 2000 and marks the result truncated', async () => {
  const f = await setup();
  try {
    const created = [];
    for (let index = 0; index < 70; index += 1) {
      const task = f.store.create({ input_id: null, role: 'worker', goal: `task ${index}` });
      f.store.update(task.id, { branch: `lush/test/${task.id}-edge` });
      created.push(task.id);
    }
    f.store.transaction(() => {
      for (let i = 0; i < created.length; i += 1) {
        for (let j = i + 1; j < created.length; j += 1) f.store.addDep(created[j], created[i], 'order');
      }
    });
    const graph = await f.project.graph();
    expect(graph.truncated).toBe(true);
    expect(graph.edges.length).toBe(2000);
    expect(graph.edges.every(edge => edge.kind === 'order')).toBe(true);
  } finally { await f.close(); }
});

test('graph marks archived branches and keeps their tasks on the graph', async () => {
  const f = await setup();
  try {
    await change(f, f.task, 'A\n');
    const branch = f.store.task(f.task.id).branch;
    // 归档：worktree 与 ref 都没了，workspace 被清成 null，但 branch 字段与任务行留着。
    await f.project.archiveBranch(branch);
    expect(f.store.branch(branch).status).toBe('archived');

    const graph = await f.project.graph();
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const branchNode = nodes.get(`branch:${branch}`);
    // 状态固定为 archived，不被「任务都已完成」的汇总口径改成 ready/merged。
    expect(branchNode).toMatchObject({ archived: true, status: 'archived', head_commit: null, tracked: true });
    expect(branchNode.archived_at).toBe(f.store.branch(branch).deleted_at);
    expect(branchNode.archived_at).toBeTruthy();
    // 分支仍然画在图上，任务也没有因为 workspace 被清空而掉下去。
    const taskNode = nodes.get(f.task.id);
    expect(taskNode).toMatchObject({ archived: true, branch, workspace: null, workspace_state: 'none', branch_state: 'missing' });
  } finally { await f.close(); }
});

test('graph labels each branch with origin, title and source', async () => {
  const f = await setup();
  try {
    // 输入锚点：有记录、没有任务，inputs.anchor_branch 指名了它。
    const inputId = f.store.nextInputId();
    f.store.run('INSERT INTO inputs(id,content,anchor_branch) VALUES (?,?,?)',
      inputId, '  修一下分支图：看不见刚创建的分支  \n第二行不该进标题', 'lush/test/input-1-anchor');
    f.store.recordBranch({ branch: 'lush/test/input-1-anchor', parent: 'main' });
    // 用户自己拉的本地分支：有 ref、没有记录。
    await git(f.root, 'branch', 'feature/scratch');
    // 登记过、没有任务也没有输入锚点：registered。
    f.store.recordBranch({ branch: 'lush/test/registered', parent: 'main' });
    // 只被 parent 提到、既无记录也无 ref：占位。
    f.store.recordBranch({ branch: 'lush/test/orphan', parent: 'lush/test/gone-parent' });
    // worker 的分支与记录是在第一次派活时才落地的（spawn 本身不建 ref）。
    await change(f, f.task, 'A\n');
    const worker = f.store.task(f.task.id);

    const graph = await f.project.graph();
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));

    // 输入锚点：origin 是 input，标题取输入第一行（压缩空白），source_id 是 input id，created_at 来自记录。
    expect(nodes.get('branch:lush/test/input-1-anchor')).toMatchObject({
      origin: 'input', title: '修一下分支图：看不见刚创建的分支', source_id: inputId, tracked: true, placeholder: false,
    });
    expect(nodes.get('branch:lush/test/input-1-anchor').created_at)
      .toBe(f.store.branch('lush/test/input-1-anchor').created_at);

    // worker 分支：origin 是 task，标题来自 goal，source_id 是任务 id。
    expect(nodes.get(`branch:${worker.branch}`)).toMatchObject({ origin: 'task', title: 'implement', source_id: worker.id });

    // 没有来源的分支不假装有标题。
    expect(nodes.get('branch:feature/scratch')).toMatchObject({ origin: 'local', title: null, source_id: null, created_at: null, tracked: false });
    expect(nodes.get('branch:lush/test/gone-parent')).toMatchObject({ origin: 'placeholder', title: null, source_id: null, placeholder: true, tracked: false });
    expect(nodes.get('branch:lush/test/registered')).toMatchObject({ origin: 'registered', title: null, source_id: null, tracked: true });
  } finally { await f.close(); }
});

test('graph truncates long titles and falls back from an empty goal to the task name', async () => {
  const f = await setup();
  try {
    // 记录里的 task_id 优先：标题来自那个任务的 goal，第一行超 60 字就截断加省略号。
    const long = f.store.create({ input_id: null, role: 'worker', goal: `长${'标题'.repeat(40)}\n第二行不该进标题` });
    f.store.update(long.id, { branch: 'lush/test/long-title' });
    f.store.recordBranch({ branch: 'lush/test/long-title', parent: 'main', task_id: long.id });
    // 没有 task_id 时退到这条分支上最新的任务；goal 为空再退到 name。
    const named = f.store.create({ input_id: null, role: 'worker', goal: '  ', name: 'slug-fallback' });
    f.store.update(named.id, { branch: 'lush/test/slug' });
    f.store.recordBranch({ branch: 'lush/test/slug', parent: 'main' });

    const graph = await f.project.graph();
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const title = nodes.get('branch:lush/test/long-title').title;
    expect(title).toBe(`${`长${'标题'.repeat(40)}`.slice(0, 60)}…`);
    expect(title.endsWith('…')).toBe(true);
    expect(nodes.get('branch:lush/test/long-title').source_id).toBe(long.id);
    expect(nodes.get('branch:lush/test/slug')).toMatchObject({ origin: 'task', title: 'slug-fallback', source_id: named.id });
  } finally { await f.close(); }
});

test('graph aggregates branch status over its own tasks and every descendant branch', async () => {
  const f = await setup();
  try {
    // empty：只有记录，没有任务也没有后代。
    f.store.recordBranch({ branch: 'lush/test/empty', parent: 'main' });
    // active：任务还在等槽；父分支自己没有任务，状态却来自子分支。
    f.store.recordBranch({ branch: 'lush/test/active-parent', parent: 'main' });
    f.store.recordBranch({ branch: 'lush/test/active-child', parent: 'lush/test/active-parent' });
    const queued = f.store.create({ input_id: null, role: 'worker', goal: 'still queued' });
    f.store.update(queued.id, { branch: 'lush/test/active-child' });
    // failed：子树里没有活动任务，但有失败任务。
    f.store.recordBranch({ branch: 'lush/test/failed', parent: 'main' });
    const failed = f.store.create({ input_id: null, role: 'worker', goal: 'went wrong' });
    f.store.update(failed.id, { branch: 'lush/test/failed', status: 'failed' });
    // ready / merged：worker 自己的分支，交付完成但还没进父分支；合入 main 之后是 merged。
    await change(f, f.task, 'A\n');
    const workerBranch = f.store.task(f.task.id).branch;

    const graph = await f.project.graph();
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    expect(nodes.get('branch:lush/test/empty')).toMatchObject({ status: 'empty', tasks: { total: 0, active: 0, failed: 0, completed: 0 } });
    // 后代汇总：父分支自己没有任务，却因为子分支的 queued 任务呈 active。
    expect(nodes.get('branch:lush/test/active-parent')).toMatchObject({ status: 'active', tasks: { total: 1, active: 1, failed: 0, completed: 0 } });
    expect(nodes.get('branch:lush/test/active-child')).toMatchObject({ status: 'active' });
    expect(nodes.get('branch:lush/test/failed')).toMatchObject({ status: 'failed', tasks: { total: 1, active: 0, failed: 1, completed: 0 } });
    expect(nodes.get(`branch:${workerBranch}`)).toMatchObject({ status: 'ready', tasks: { total: 1, active: 0, failed: 0, completed: 1 } });

    await f.project.workspaces.merge(f.task.id);
    const after = new Map((await f.project.graph()).nodes.map(node => [node.id, node]));
    expect(after.get(`branch:${workerBranch}`).status).toBe('merged');
  } finally { await f.close(); }
});

test('graph counts tasks of descendants hiding behind a placeholder parent', async () => {
  const f = await setup();
  try {
    // 占位父（既无记录也无 ref）自己在链上，子树统计与 fork 边都要穿过它。
    f.store.recordBranch({ branch: 'lush/test/child-of-placeholder', parent: 'lush/test/missing-parent' });
    const task = f.store.create({ input_id: null, role: 'worker', goal: 'child work' });
    f.store.update(task.id, { branch: 'lush/test/child-of-placeholder', status: 'failed' });

    const graph = await f.project.graph();
    const gone = graph.nodes.find(node => node.id === 'branch:lush/test/missing-parent');
    expect(gone).toMatchObject({ placeholder: true, origin: 'placeholder', status: 'failed' });
    expect(gone.tasks).toEqual({ total: 1, active: 0, failed: 1, completed: 0 });
    expect(graph.edges).toContainEqual(expect.objectContaining({
      kind: 'fork', from: 'branch:lush/test/missing-parent', to: 'branch:lush/test/child-of-placeholder',
    }));
  } finally { await f.close(); }
});
