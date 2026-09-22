import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, dialogText, answerDialog } from '../dom-stub.js';
import { makeWorld, iso, NOW } from './dom-world.js';

// 分支图视图：#graph hash、分支谱系嵌套、任务节点、缺失标注、点节点进详情、幂等刷新、轮询不覆盖、
// 最长陈旧时间自动重拉。每个 DOM 测试文件自给自足：自己建 world、装 stub，再显式装配一次当前 DOM。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { openGraph } = await import('../../src/ui/web/assets/render-graph.js');
dom.node('side-nav').replaceChildren();
await boot();

afterAll(() => dom.restore());

test('分支图：入口走 #graph，画出分支谱系与任务，点节点进详情，刷新幂等，轮询不覆盖', async () => {
  // 顶部入口把地址栏切到 #graph。
  expect(dom.node('graph-open')).toBeTruthy();
  dom.node('graph-open').onclick();
  expect(dom.location.hash).toBe('#graph');
  await openGraph();

  const detail = dom.node('detail');
  expect(detail.querySelector('div.graph-view')).toBeTruthy();
  const text = deepText(detail);
  expect(text).toContain('分支图');
  expect(text).toContain('当前检出 main');
  // 分支是节点：不再给每条分支单开一个「目标分支 X」车道。
  expect(text).not.toContain('目标分支');
  // 所有本地分支都在图上：记录、有 ref 但未登记的新分支、只有 parent 提到的占位分支。
  for (const name of ['main', 'release', 'lush/demo/input-1-anchor', 'lush/demo/1-one', 'lush/demo/3-three', 'feature/scratch', 'feature/gone']) {
    expect(text).toContain(name);
  }
  expect(text).toContain('未登记');
  // 占位父分支只被谱系提及；记录还在但 ref 已消失的分支明说不存在。
  expect(text).toContain('⚠ 仅谱系提及');
  expect(text).toContain('⚠ 分支不存在');
  // 三个任务节点，带领先 / 落后与缺失标注。
  const nodes = () => detail.querySelectorAll('button.graph-node');
  expect(nodes().length).toBe(3);
  // running task 的计划是一整条横向进度：显示当前步骤与完成数，并挂显著动效 class。
  const taskProgress = detail.querySelector('.graph-task-progress');
  expect(taskProgress).toBeTruthy();
  expect(taskProgress.classList.contains('is-running')).toBe(true);
  expect(deepText(taskProgress)).toContain('实现功能');
  expect(deepText(taskProgress)).toContain('1/3');
  expect(deepText(taskProgress)).toContain('已执行 1 分');
  expect(taskProgress.querySelector('.is-running-duration')).toBeTruthy();
  expect(taskProgress.querySelector('progress').value).toBe(1);
  expect(text).toContain('领先 1');
  expect(text).toContain('⚠ 缺失 worktree');
  expect(text).toContain('⚠ 缺失分支');
  // fork 连线直接表达可 FF / 分歧，并提供相应动作。
  expect(text).toContain('可 fast-forward');
  expect(text).toContain('父子已分歧');
  expect(text).toContain('子分支 +1 / -2');
  const mergeButton = detail.querySelectorAll('button').find(node => node.textContent === '合入父分支');
  const syncButton = detail.querySelectorAll('button').find(node => node.textContent === '在子分支解决分歧');
  expect(mergeButton).toBeTruthy(); expect(syncButton).toBeTruthy();
  await mergeButton.onclick();
  await syncButton.onclick();
  expect(world.state.actions).toContainEqual({ method: 'branch.merge', params: { branch: 'lush/demo/1-one' } });
  expect(world.state.actions).toContainEqual({ method: 'branch.sync', params: { branch: 'lush/demo/2-two' } });

  // 父子嵌套：无任务的锚点分支与 worker 分支挂在 main 的子树里，2-two 挂在 1-one 下，不在 release 下。
  const header = name => detail.querySelectorAll('span.graph-branch-name').find(node => node.textContent.includes(name));
  const blockOf = name => header(name).parentNode.parentNode;
  expect(deepText(blockOf('main'))).toContain('lush/demo/input-1-anchor');
  expect(deepText(blockOf('main'))).toContain('lush/demo/1-one');
  expect(deepText(blockOf('lush/demo/1-one'))).toContain('lush/demo/2-two');
  expect(deepText(blockOf('release'))).not.toContain('lush/demo/input-1-anchor');
  // 子分支放在缩进子树容器里（复用 .graph-lane 的左边框 + 内缩）。
  expect(blockOf('main').querySelector('div.graph-children')).toBeTruthy();

  // 幂等：重复渲染同一份图，节点与分支块都不翻倍。
  const branchBlocks = () => detail.querySelectorAll('div.graph-group').length;
  const before = branchBlocks();
  await openGraph();
  await openGraph();
  expect(nodes().length).toBe(3);
  expect(branchBlocks()).toBe(before);

  // 打开期间的 1.5s 轮询不用概览覆盖它。
  await dom.intervalFor(1500)();
  expect(detail.querySelector('div.graph-view')).toBeTruthy();
  expect(deepText(detail)).not.toContain('项目概览');

  // 点任务节点它进任务详情。
  const second = nodes().find(node => node.textContent.includes('合并我'));
  expect(second).toBeTruthy();
  await second.onclick();
  expect(dom.location.hash).toBe('#task-2');
  expect(detail.querySelector('div.graph-view')).toBeNull();
});

test('分支图：同一层级的条目新的在前——兄弟分支按创建时间降序，当前检出仍第一', async () => {
  await openGraph();
  const view = dom.node('detail').querySelector('div.graph-view');
  const label = node => node.textContent.replace('⎇ ', '');
  const rootNames = () => view.children
    .filter(node => node.classList.contains('graph-group'))
    .map(node => label(node.querySelector('span.graph-branch-name')));
  // 根层：当前检出 main 第一；release 有创建时间；feature/gone 是占位分支、没有创建时间，排在最后。
  expect(rootNames()).toEqual(['main', 'release', 'feature/gone']);
  const headerOf = name => view.querySelectorAll('span.graph-branch-name').find(node => label(node) === name);
  const childNames = name => headerOf(name).parentNode.parentNode.querySelector('div.graph-children').children
    .map(node => label(node.querySelector('span.graph-branch-name')));
  // main 的直接子分支按 created_at 从新到旧：behind-only(最新) → 1-one → input-1-anchor(最老)。
  expect(childNames('main')).toEqual(['lush/demo/behind-only', 'lush/demo/1-one', 'lush/demo/input-1-anchor']);
  expect(childNames('release')).toEqual(['lush/demo/3-three']);
});

test('分支图：分支节点显示一句话摘要，完整摘要进悬停提示', async () => {
  const anchor = world.state.graph.nodes.find(node => node.id === 'branch:lush/demo/input-1-anchor');
  const before = { title: anchor.title, summary: anchor.summary };
  // 读模型已经保证 title 优先取摘要；这里只验证渲染层把摘要当标题显示，并把全文放进 title 提示。
  anchor.title = '一句话摘要：把标题从输入原文换成人写的简述';
  anchor.summary = '一句话摘要：把标题从输入原文换成人写的简述';
  try {
    await openGraph();
    const titles = [...dom.node('detail').querySelectorAll('span.graph-branch-title')];
    const node = titles.find(candidate => candidate.textContent === anchor.summary);
    expect(node).toBeTruthy();
    expect(node.title).toBe(anchor.summary);
    // 摘要本身就是显示出来的标题，输入 / goal 的原文首行不再出现在标题位。
    expect(deepText(dom.node('detail'))).toContain(anchor.summary);
  } finally {
    anchor.title = before.title; anchor.summary = before.summary;
    await openGraph();
  }
});

test('分支图：结构指纹没变时，1.5s 轮询不在 3 秒内重复打 git', async () => {
  await openGraph();
  const ui = (await import('../../src/ui/web/assets/state.js')).ui;
  expect(dom.location.hash).toBe('#graph');
  expect(ui.graphFingerprint).toBeTruthy();
  const fetchedAt = ui.graphFetchedAt;
  await dom.intervalFor(1500)();
  expect(ui.graphFetchedAt).toBe(fetchedAt);
});

test('分支图：最长陈旧时间到期自动重拉，UI 外新建的分支无需手点就出现', async () => {
  await openGraph();
  const ui = (await import('../../src/ui/web/assets/state.js')).ui;
  // UI 外新建一条分支：快照指纹不会因此改变，所以轮询先不会重拉。
  world.state.graph.nodes.push({ kind: 'branch', id: 'branch:lush/demo/2-fresh', name: 'lush/demo/2-fresh',
    head_commit: 'fff', current: false, tracked: true, placeholder: false });
  world.state.graph.edges.push({ kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/2-fresh' });
  const fetchedAt = ui.graphFetchedAt;
  await dom.intervalFor(1500)();
  expect(ui.graphFetchedAt).toBe(fetchedAt);
  expect(deepText(dom.node('detail'))).not.toContain('lush/demo/2-fresh');
  // 最长陈旧时间到期：无条件重拉一次，新分支出现在视图里。
  ui.graphFetchedAt = Date.now() - 10001;
  await dom.intervalFor(1500)();
  expect(deepText(dom.node('detail'))).toContain('lush/demo/2-fresh');
});

test('分支图：可归档分支才有归档按钮，确认后整棵子树一起归档并从分支树上消失', async () => {
  await openGraph();
  const saved = JSON.parse(JSON.stringify(world.state.graph));
  try {
    const detail = dom.node('detail');
    // 分支表头的那一行：嵌套子分支在别的 graph-group 里，不能用 block 去查，否则会看到子分支的按钮。
    const branchRow = name => detail.querySelectorAll('span.graph-branch-name')
      .find(node => node.textContent.includes(name))?.parentNode ?? null;
    const archiveButton = name => branchRow(name)?.querySelectorAll('button').find(node => node.textContent === '归档');
    // 只有 archivable 才给动作：当前检出（main）、未登记（release / feature）、ref 与 worktree 都没了（3-three）都不给。
    expect(archiveButton('lush/demo/1-one')).toBeTruthy();
    expect(archiveButton('lush/demo/2-two')).toBeTruthy();
    expect(archiveButton('lush/demo/input-1-anchor')).toBeTruthy();
    expect(archiveButton('main')).toBeFalsy();
    expect(archiveButton('release')).toBeFalsy();
    expect(archiveButton('feature/scratch')).toBeFalsy();
    expect(archiveButton('lush/demo/3-three')).toBeFalsy();
    const button = archiveButton('lush/demo/1-one');

    // 归档走应用内弹窗：删除不可撤销，所以先把代价说清楚（包括它下面有几条后代分支）；没点确认之前不能发请求。
    const pending = button.onclick();
    expect(dialogText(dom)).toContain('会删除这条分支与它下面 1 条后代分支的 worktree 与本地 ref');
    expect(dialogText(dom)).toContain('保留任务、会话与分支记录');
    expect(world.state.actions.some(entry => entry.method === 'branch.archive')).toBe(false);
    await answerDialog(dom, '归档');
    await pending;
    expect(world.state.actions).toContainEqual({ method: 'branch.archive', params: { branch: 'lush/demo/1-one', discard: true } });
    // 子树根与后代都归档了，结果写在 #error。
    expect(dom.node('error').textContent).toContain('已归档 lush/demo/1-one 及它下面 1 条后代分支');
    // 归档的分支不再占分支树：它自己与它的后代分支、以及它们名下的任务都不画了。
    expect(branchRow('lush/demo/1-one')).toBeFalsy();
    expect(branchRow('lush/demo/2-two')).toBeFalsy();
    expect(deepText(detail)).not.toContain('正在改点什么');
    // 没被归档的邻居照旧在图上。
    expect(deepText(detail)).toContain('lush/demo/input-1-anchor');
  } finally { world.state.graph = saved; await openGraph(); }
});

test('分支图：归档的分支不再占分支树，它还在的后代接到最近的可见祖先上', async () => {
  const saved = world.state.graph;
  world.state.graph = {
    generated_at: new Date().toISOString(), current_branch: 'main', truncated: false, git: true, error: null,
    nodes: [
      { kind: 'branch', id: 'branch:main', name: 'main', head_commit: 'aaa', current: true, tracked: false, placeholder: false },
      // 归档：ref 与 worktree 都按预期删掉了，只剩记录。
      { kind: 'branch', id: 'branch:lush/demo/7-old', name: 'lush/demo/7-old', head_commit: null, current: false, tracked: true,
        placeholder: false, archived: true, archived_at: iso(NOW), status: 'archived', worktree_state: 'missing' },
      // 它的子分支还活着（历史遗留：归档是后来才变成整棵子树的）：不能因为父分支被藏起来就跟着消失。
      { kind: 'branch', id: 'branch:lush/demo/8-child', name: 'lush/demo/8-child', head_commit: 'ccc', current: false, tracked: true,
        placeholder: false, created_at: iso(NOW - 1000) },
      { kind: 'task', id: 7, role: 'worker', name: 'seven', goal: '归档掉的分支工作', status: 'completed', integration: 'none',
        branch: 'lush/demo/7-old', workspace: null, workspace_state: 'none', branch_state: 'missing', archived: true,
        base_commit: 'aaa', head_commit: 'bbb', target_branch: 'main', ahead: 1, behind: 0, merged: false, current: false },
    ],
    edges: [
      // 真实形状：归档后 ref 没了，两条 fork 边在 git 里都算不出来（daemon 报 missing）。
      { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/7-old', status: 'missing', ahead: null, behind: null },
      { kind: 'fork', from: 'branch:lush/demo/7-old', to: 'branch:lush/demo/8-child', status: 'missing', ahead: null, behind: null },
    ],
  };
  try {
    await openGraph();
    const detail = dom.node('detail');
    const text = deepText(detail);
    const branchRow = name => detail.querySelectorAll('span.graph-branch-name')
      .find(node => node.textContent.includes(name))?.parentNode ?? null;
    // 归档的分支与它名下的任务都不画在分支树上（记录在任务列表与详情里看）。
    expect(branchRow('lush/demo/7-old')).toBeFalsy();
    expect(text).not.toContain('归档掉的分支工作');
    expect(text).not.toContain('⚠ 分支不存在');
    expect(text).not.toContain('⚠ 缺失分支');
    // 活着的子分支升到最近的非归档祖先（main）下，并说明它的父分支已经归档，而不是报「分支缺失」。
    expect(branchRow('lush/demo/8-child')).toBeTruthy();
    expect(deepText(branchRow('lush/demo/8-child'))).toContain('父分支已归档');
    expect(text).not.toContain('分支缺失');
    expect(detail.querySelectorAll('button').some(node => node.textContent === '归档')).toBe(true);
  } finally { world.state.graph = saved; await openGraph(); }
});

test('分支图：空图沿用原来的提示文案', async () => {
  const saved = world.state.graph;
  world.state.graph = { generated_at: new Date().toISOString(), current_branch: 'main', truncated: false, git: true, error: null, nodes: [], edges: [] };
  try {
    await openGraph();
    expect(deepText(dom.node('detail'))).toContain('还没有任何任务分支或 worktree。');
  } finally { world.state.graph = saved; }
});

test('分支图：关系色按领先 / 相等 / 落后 / 分歧 / 缺失分，动作与禁用原因都画在表头上', async () => {
  await openGraph();
  const detail = dom.node('detail');
  const header = name => detail.querySelectorAll('span.graph-branch-name').find(node => node.textContent.includes(name));
  const blockOf = name => header(name).parentNode.parentNode;
  const buttonIn = (name, text) => blockOf(name).querySelectorAll('button').find(node => node.textContent === text);

  // 关系 key 驱动 CSS 的 --rel-ink / --rel-tint（面板底色、左边条、连接线与拐角）。
  expect(blockOf('lush/demo/1-one').dataset.relation).toBe('ahead');
  expect(blockOf('lush/demo/behind-only').dataset.relation).toBe('behind');
  expect(blockOf('lush/demo/2-two').dataset.relation).toBe('diverged');
  expect(blockOf('lush/demo/input-1-anchor').dataset.relation).toBe('equal');
  expect(blockOf('lush/demo/3-three').dataset.relation).toBe('missing');
  expect(blockOf('feature/scratch').dataset.relation).toBe('unknown');
  // 根分支没有来边：不贴关系色，保持默认强调色。
  expect(blockOf('main').dataset.relation).toBeUndefined();
  const text = deepText(detail);
  for (const label of ['可 fast-forward', '与父分支一致', '落后父分支 3', '父子已分歧', '关系未知']) expect(text).toContain(label);

  // 领先：只有合入父分支。
  expect(buttonIn('lush/demo/1-one', '合入父分支').disabled).toBe(false);
  // 落后：只有「让子分支跟上父分支」，走新的 branch.catchup。
  expect(buttonIn('lush/demo/behind-only', '让子分支跟上父分支').disabled).toBe(false);
  expect(buttonIn('lush/demo/behind-only', '合入父分支')).toBeUndefined();
  await buttonIn('lush/demo/behind-only', '让子分支跟上父分支').onclick();
  expect(world.state.actions).toContainEqual({ method: 'branch.catchup', params: { branch: 'lush/demo/behind-only' } });
  // 分歧：解决分歧可用，合入父分支同时摆出来但禁用（并在 title 里说清楚为什么）。
  expect(buttonIn('lush/demo/2-two', '在子分支解决分歧').disabled).toBe(false);
  expect(buttonIn('lush/demo/2-two', '合入父分支').disabled).toBe(true);
  expect(buttonIn('lush/demo/2-two', '合入父分支').title).toContain('先在子分支解决分歧');
  // 相等 / 缺失 / 未登记的关系没有可做的事，不摆按钮。
  for (const name of ['lush/demo/input-1-anchor', 'lush/demo/3-three', 'feature/scratch']) {
    expect(blockOf(name).querySelectorAll('button.graph-branch-action').length).toBe(0);
  }

  // 未收拢的直接子分支：运行时两边都会拒绝，所以按钮禁用并列出 blocker。
  const edge = world.state.graph.edges.find(row => row.to === 'branch:lush/demo/1-one');
  const saved = { blockers: edge.blockers, can_merge: edge.can_merge };
  edge.blockers = ['lush/demo/2-two']; edge.can_merge = false;
  try {
    await openGraph();
    const merge = buttonIn('lush/demo/1-one', '合入父分支');
    expect(merge.disabled).toBe(true);
    expect(merge.title).toContain('先收拢子分支：lush/demo/2-two');
    expect(deepText(blockOf('lush/demo/1-one'))).toContain('先收拢子分支：lush/demo/2-two');
  } finally {
    edge.blockers = saved.blockers; edge.can_merge = saved.can_merge;
  }
});

test('分支图：未合进父分支 / 在跑的分支默认展开且带强调，已合进父分支的默认收起，页面不出现「已合并」', async () => {
  const saved = world.state.graph;
  const graph = {
    generated_at: iso(NOW), current_branch: 'main', truncated: false, git: true, error: null,
    nodes: [
      { kind: 'branch', id: 'branch:main', name: 'main', head_commit: 'aaa', current: true, tracked: false, placeholder: false,
        status: 'active', tasks: { total: 2, active: 1, failed: 0, completed: 1 }, created_at: iso(NOW - 5000) },
      // 已合进父分支、任务都结束：不强调，默认收起。
      { kind: 'branch', id: 'branch:lush/demo/done', name: 'lush/demo/done', head_commit: 'bbb', current: false, tracked: true, placeholder: false,
        status: 'merged', tasks: { total: 1, active: 0, failed: 0, completed: 1 }, created_at: iso(NOW - 4000) },
      // 没合进父分支：强调 + 默认展开。
      { kind: 'branch', id: 'branch:lush/demo/ahead', name: 'lush/demo/ahead', head_commit: 'ccc', current: false, tracked: true, placeholder: false,
        status: 'ready', tasks: { total: 1, active: 0, failed: 0, completed: 1 }, created_at: iso(NOW - 3000) },
      // 已合进父分支但还有在跑的任务：工作态强调 + 默认展开。
      { kind: 'branch', id: 'branch:lush/demo/busy', name: 'lush/demo/busy', head_commit: 'ddd', current: false, tracked: true, placeholder: false,
        status: 'active', tasks: { total: 1, active: 1, failed: 0, completed: 0 }, created_at: iso(NOW - 2000) },
      { kind: 'task', id: 1, role: 'worker', name: 'one', goal: '已经合完的活', status: 'completed', integration: 'merged',
        branch: 'lush/demo/done', workspace: '/tmp/wt/1', workspace_state: 'present', branch_state: 'present',
        target_branch: 'main', ahead: 0, behind: 0, merged: true, current: false },
      { kind: 'task', id: 2, role: 'worker', name: 'two', goal: '还没合进去的活', status: 'completed', integration: 'pending',
        branch: 'lush/demo/ahead', workspace: '/tmp/wt/2', workspace_state: 'present', branch_state: 'present',
        target_branch: 'main', ahead: 1, behind: 0, merged: false, current: false },
      { kind: 'task', id: 3, role: 'worker', name: 'three', goal: '在跑的活', status: 'running', integration: 'none',
        branch: 'lush/demo/busy', workspace: '/tmp/wt/3', workspace_state: 'present', branch_state: 'present',
        target_branch: 'main', ahead: 1, behind: 0, merged: false, current: false },
    ],
    edges: [
      { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/done', status: 'integrated', ahead: 0, behind: 0, blockers: [], can_merge: false, can_sync: false },
      { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/ahead', status: 'fast_forward', ahead: 1, behind: 0, blockers: [], can_merge: true, can_sync: false },
      { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/busy', status: 'integrated', ahead: 0, behind: 0, blockers: [], can_merge: false, can_sync: false },
    ],
  };
  world.state.graph = graph;
  const ui = (await import('../../src/ui/web/assets/state.js')).ui;
  try {
    await openGraph();
    const detail = dom.node('detail');
    const header = name => detail.querySelectorAll('span.graph-branch-name').find(node => node.textContent.includes(name));
    const blockOf = name => header(name).parentNode.parentNode;
    const rowOf = name => header(name).parentNode;
    const caretOf = name => rowOf(name).querySelector('button.graph-caret');

    // ① 不再有「已合并」：任务上的 merged:true 与分支的汇总 merged 都不再出这四个字；未合并标记保留。
    const text = deepText(detail);
    expect(text).not.toContain('已合并');
    expect(text).toContain('未合并');
    // 已合进父分支、任务都结束：默认收起，箭头朝右。
    expect(blockOf('lush/demo/done').classList.contains('collapsed')).toBe(true);
    expect(caretOf('lush/demo/done').textContent).toBe('▶');
    expect(caretOf('lush/demo/done').getAttribute('aria-expanded')).toBe('false');
    // 没合进父分支 / 在跑的：默认展开。
    expect(blockOf('lush/demo/ahead').classList.contains('collapsed')).toBe(false);
    expect(blockOf('lush/demo/busy').classList.contains('collapsed')).toBe(false);
    expect(caretOf('lush/demo/ahead').textContent).toBe('▼');
    // 父分支因为子树里有未合并 / 在跑的分支，默认也不收起（不把子树藏掉）。
    expect(blockOf('main').classList.contains('collapsed')).toBe(false);

    // ② 强调 class：未合进父分支为 graph-emphasis-unmerged，在跑的为 graph-emphasis-working。
    expect(rowOf('lush/demo/done').classList.contains('graph-emphasis-unmerged')).toBe(false);
    expect(rowOf('lush/demo/done').classList.contains('graph-emphasis-working')).toBe(false);
    expect(rowOf('lush/demo/ahead').classList.contains('graph-emphasis-unmerged')).toBe(true);
    expect(rowOf('lush/demo/ahead').classList.contains('graph-emphasis-working')).toBe(false);
    expect(rowOf('lush/demo/busy').classList.contains('graph-emphasis-working')).toBe(true);
    expect(rowOf('lush/demo/busy').classList.contains('graph-emphasis-unmerged')).toBe(false);
    // ③ 在跑的任务行也带同一个工作态 class；已结束的任务行不带。
    const taskRow = goal => detail.querySelectorAll('div.graph-node').find(row => deepText(row).includes(goal));
    expect(taskRow('在跑的活').classList.contains('graph-emphasis-working')).toBe(true);
    expect(taskRow('已经合完的活').classList.contains('graph-emphasis-working')).toBe(false);

    // ④ 点箭头可以展开一个默认收起的分支，并把「显式展开」持久化；重画后仍然展开。
    caretOf('lush/demo/done').onclick();
    expect(blockOf('lush/demo/done').classList.contains('collapsed')).toBe(false);
    expect(JSON.parse(localStorage.getItem('lush.graphExpanded'))).toEqual(['lush/demo/done']);
    await openGraph();
    expect(blockOf('lush/demo/done').classList.contains('collapsed')).toBe(false);
  } finally {
    world.state.graph = saved;
    localStorage.removeItem('lush.graphCollapsed');
    localStorage.removeItem('lush.graphExpanded');
    ui.graphCollapsed.clear(); ui.graphExpanded.clear();
    await openGraph();
  }
});

test('分支图：分支子树可折叠，状态写进 localStorage，重画后仍收起', async () => {
  await openGraph();
  const detail = dom.node('detail');
  const header = name => detail.querySelectorAll('span.graph-branch-name').find(node => node.textContent.includes(name));
  const caretOf = name => header(name).parentNode.querySelector('button.graph-caret');
  const blockOf = name => header(name).parentNode.parentNode;

  // 默认按「未合进父分支 / 在跑」展开：1-one 是 fast_forward 且自己就有在跑的任务，所以默认展开。
  expect(caretOf('lush/demo/1-one').textContent).toBe('▼');
  expect(caretOf('lush/demo/1-one').getAttribute('aria-expanded')).toBe('true');
  expect(blockOf('lush/demo/1-one').classList.contains('collapsed')).toBe(false);
  // 自己没任务、也没有子分支的分支不给箭头：收起它没意义。
  expect(caretOf('feature/scratch')).toBeNull();

  // 收起：整棵子树（任务 #1 + 子分支 2-two 里的 #2）一起进表头，说清楚藏了多少。
  caretOf('lush/demo/1-one').onclick();
  expect(blockOf('lush/demo/1-one').classList.contains('collapsed')).toBe(true);
  expect(caretOf('lush/demo/1-one').textContent).toBe('▶');
  expect(caretOf('lush/demo/1-one').getAttribute('aria-expanded')).toBe('false');
  expect(deepText(blockOf('lush/demo/1-one'))).toContain('已收起 1 分支 / 2 任务');
  expect(JSON.parse(localStorage.getItem('lush.graphCollapsed'))).toEqual(['lush/demo/1-one']);
  expect(JSON.parse(localStorage.getItem('lush.graphExpanded'))).toEqual([]);

  // 重画（轮询拿到新数据 / 手动刷新）不会把收起状态丢掉：新节点上仍然是收起的。
  await openGraph();
  expect(blockOf('lush/demo/1-one').classList.contains('collapsed')).toBe(true);
  expect(caretOf('lush/demo/1-one').getAttribute('aria-expanded')).toBe('false');
  // 收起只藏子孙（靠 .collapsed 的 CSS），谱系本身不动：父分支照旧包着它。
  expect(deepText(blockOf('main'))).toContain('lush/demo/1-one');

  // 再点一次展开：显式展开与显式收起分两个 key 记（展开进 graphExpanded、graphCollapsed 清空）。
  caretOf('lush/demo/1-one').onclick();
  expect(blockOf('lush/demo/1-one').classList.contains('collapsed')).toBe(false);
  expect(caretOf('lush/demo/1-one').getAttribute('aria-expanded')).toBe('true');
  expect(JSON.parse(localStorage.getItem('lush.graphCollapsed'))).toEqual([]);
  expect(JSON.parse(localStorage.getItem('lush.graphExpanded'))).toEqual(['lush/demo/1-one']);
  // 清掉两个 key，后面的测试不该继承这次切换。
  localStorage.removeItem('lush.graphCollapsed');
  localStorage.removeItem('lush.graphExpanded');
  const ui = (await import('../../src/ui/web/assets/state.js')).ui;
  ui.graphCollapsed.clear(); ui.graphExpanded.clear();
});

test('分支图：工作中的分支有明确工作态标识，停下来的分支没有且整体降噪', async () => {
  const saved = world.state.graph;
  world.state.graph = {
    generated_at: iso(NOW), current_branch: 'main', truncated: false, git: true, error: null,
    nodes: [
      // 根：自己没有任务，子树里有活 → 子树工作中。
      { kind: 'branch', id: 'branch:main', name: 'main', head_commit: 'aaa', current: true, tracked: false, placeholder: false,
        status: 'active', tasks: { total: 4, active: 3, failed: 0, completed: 1 }, created_at: iso(NOW - 6000) },
      // 未合进父分支 + 自己就在跑：两条强调通道都要看得见。
      { kind: 'branch', id: 'branch:lush/demo/hot', name: 'lush/demo/hot', head_commit: 'bbb', current: false, tracked: true, placeholder: false,
        status: 'active', tasks: { total: 1, active: 1, failed: 0, completed: 0 }, created_at: iso(NOW - 5000) },
      // 自己在等。
      { kind: 'branch', id: 'branch:lush/demo/waiting', name: 'lush/demo/waiting', head_commit: 'ccc', current: false, tracked: true, placeholder: false,
        status: 'active', tasks: { total: 1, active: 1, failed: 0, completed: 0 }, created_at: iso(NOW - 4000) },
      // 自己结束了，只有子树在跑。
      { kind: 'branch', id: 'branch:lush/demo/parent', name: 'lush/demo/parent', head_commit: 'ddd', current: false, tracked: true, placeholder: false,
        status: 'ready', tasks: { total: 2, active: 1, failed: 0, completed: 1 }, created_at: iso(NOW - 3000) },
      { kind: 'branch', id: 'branch:lush/demo/parent/sub', name: 'lush/demo/parent/sub', head_commit: 'eee', current: false, tracked: true, placeholder: false,
        status: 'active', tasks: { total: 1, active: 1, failed: 0, completed: 0 }, created_at: iso(NOW - 2000) },
      // 停下来了：已合进父分支、任务也结束。
      { kind: 'branch', id: 'branch:lush/demo/idle', name: 'lush/demo/idle', head_commit: 'fff', current: false, tracked: true, placeholder: false,
        status: 'merged', tasks: { total: 1, active: 0, failed: 0, completed: 1 }, created_at: iso(NOW - 1000) },
      { kind: 'task', id: 11, role: 'worker', name: 'hot', goal: '在跑的活', status: 'running', integration: 'none',
        branch: 'lush/demo/hot', workspace: '/tmp/wt/11', workspace_state: 'present', branch_state: 'present',
        target_branch: 'main', ahead: 1, behind: 0, merged: false, current: false },
      { kind: 'task', id: 12, role: 'worker', name: 'waiting', goal: '等你决定的活', status: 'awaiting', integration: 'none',
        branch: 'lush/demo/waiting', workspace: '/tmp/wt/12', workspace_state: 'present', branch_state: 'present',
        target_branch: 'main', ahead: 1, behind: 0, merged: false, current: false },
      { kind: 'task', id: 13, role: 'worker', name: 'sub', goal: '子树里的活', status: 'running', integration: 'none',
        branch: 'lush/demo/parent/sub', workspace: '/tmp/wt/13', workspace_state: 'present', branch_state: 'present',
        target_branch: 'lush/demo/parent', ahead: 1, behind: 0, merged: false, current: false },
      { kind: 'task', id: 14, role: 'worker', name: 'p', goal: '已经结束的活', status: 'completed', integration: 'merged',
        branch: 'lush/demo/parent', workspace: '/tmp/wt/14', workspace_state: 'present', branch_state: 'present',
        target_branch: 'main', ahead: 1, behind: 0, merged: true, current: false },
      { kind: 'task', id: 15, role: 'worker', name: 'idle', goal: '停下来了的活', status: 'completed', integration: 'merged',
        branch: 'lush/demo/idle', workspace: '/tmp/wt/15', workspace_state: 'present', branch_state: 'present',
        target_branch: 'main', ahead: 1, behind: 0, merged: true, current: false },
    ],
    edges: [
      { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/hot', status: 'fast_forward', ahead: 1, behind: 0, blockers: [], can_merge: true, can_sync: false },
      { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/waiting', status: 'integrated', ahead: 0, behind: 0, blockers: [], can_merge: false, can_sync: false },
      { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/parent', status: 'integrated', ahead: 0, behind: 0, blockers: [], can_merge: false, can_sync: false },
      { kind: 'fork', from: 'branch:lush/demo/parent', to: 'branch:lush/demo/parent/sub', status: 'integrated', ahead: 0, behind: 0, blockers: [], can_merge: false, can_sync: false },
      { kind: 'fork', from: 'branch:main', to: 'branch:lush/demo/idle', status: 'integrated', ahead: 0, behind: 0, blockers: [], can_merge: false, can_sync: false },
    ],
  };
  try {
    await openGraph();
    const detail = dom.node('detail');
    const header = name => detail.querySelectorAll('span.graph-branch-name').find(node => node.textContent.includes(name));
    const rowOf = name => header(name).parentNode;
    const workOf = name => rowOf(name).querySelectorAll('.graph-work');

    // ② 工作态标识：running 是「● 工作中」chip，pending 是「等你决定」chip，subtree 是更弱的一行话。
    const hot = workOf('lush/demo/hot');
    expect(hot.length).toBe(1);
    expect(hot[0].classList.contains('chip')).toBe(true);
    expect(hot[0].classList.contains('run')).toBe(true);
    expect(hot[0].querySelector('.graph-work-dot')).toBeTruthy();
    expect(deepText(hot[0])).toContain('工作中');
    const waiting = workOf('lush/demo/waiting');
    expect(waiting.length).toBe(1);
    expect(waiting[0].classList.contains('pending')).toBe(true);
    expect(deepText(waiting[0])).toBe('等你决定');
    const parent = workOf('lush/demo/parent');
    expect(parent.length).toBe(1);
    expect(parent[0].classList.contains('subtree')).toBe(true);
    expect(deepText(parent[0])).toBe('子树工作中 · 1');
    // 位置：分支名之后、关系 chip 之前。
    const row = rowOf('lush/demo/hot');
    expect([...row.children].indexOf(header('lush/demo/hot'))).toBeLessThan([...row.children].indexOf(hot[0]));
    expect([...row.children].indexOf(hot[0])).toBeLessThan([...row.children].indexOf(row.querySelector('.graph-relation')));

    // ③ 停下来的分支：没有工作态标识，并且带 graph-idle 降噪；工作中的分支不带。
    expect(workOf('lush/demo/idle').length).toBe(0);
    expect(rowOf('lush/demo/idle').classList.contains('graph-idle')).toBe(true);
    expect(rowOf('lush/demo/hot').classList.contains('graph-idle')).toBe(false);

    // ③-b 动效 class（.graph-running）只属于「真的有任务在本分支上跑」的行：在等 / 子树 / 停下来 / 根分支都不带。
    expect(rowOf('lush/demo/hot').classList.contains('graph-running')).toBe(true);
    // 子树里在跑的分支自己也带：.graph-running 认的是「本分支自己的任务在跑」，不是 subtree。
    expect(rowOf('lush/demo/parent/sub').classList.contains('graph-running')).toBe(true);
    expect(rowOf('lush/demo/parent').classList.contains('graph-running')).toBe(false);
    for (const still of ['lush/demo/waiting', 'lush/demo/idle', 'main']) {
      expect(rowOf(still).classList.contains('graph-running')).toBe(false);
    }

    // ② 未合进父分支 + 工作中：两个强调 class 同时命中，工作态标识不被盖掉。
    expect(rowOf('lush/demo/hot').classList.contains('graph-emphasis-unmerged')).toBe(true);
    expect(rowOf('lush/demo/hot').classList.contains('graph-emphasis-working')).toBe(true);

    // ④ 在跑的任务行有脉冲点，结束的任务行没有。
    const taskRow = goal => detail.querySelectorAll('div.graph-node').find(node => deepText(node).includes(goal));
    expect(taskRow('在跑的活').querySelector('.graph-work-dot')).toBeTruthy();
    expect(taskRow('停下来了的活').querySelector('.graph-work-dot')).toBeNull();

    // ⑤ 收起表头后工作态标识仍在：收起的是任务与子分支，不是这条分支的状态。
    rowOf('lush/demo/parent').querySelector('button.graph-caret').onclick();
    expect(rowOf('lush/demo/parent').parentNode.classList.contains('collapsed')).toBe(true);
    expect(deepText(workOf('lush/demo/parent')[0])).toBe('子树工作中 · 1');

    // ⑤ 幂等：重复重画同一份数据，工作态标识不翻倍；既有语义不回归（页面仍不出现「已合并」）。
    const workCount = () => detail.querySelectorAll('.graph-work').length;
    const before = workCount();
    await openGraph(); await openGraph();
    expect(workCount()).toBe(before);
    expect(deepText(detail)).not.toContain('已合并');
  } finally {
    world.state.graph = saved;
    localStorage.removeItem('lush.graphCollapsed');
    localStorage.removeItem('lush.graphExpanded');
    const ui = (await import('../../src/ui/web/assets/state.js')).ui;
    ui.graphCollapsed.clear(); ui.graphExpanded.clear();
    await openGraph();
  }
});

// 待你决断的 notice 直接画在分支图的任务行里并就地处理：不用先去左侧「待定事项」或意图面板。
// 数据来自 graph.get 的 notice / notice_count（spec #21），这里只验证渲染层与动作确实接上了 RPC。
test('分支图：带待决 notice 的任务行显示正文与徽标，能原地答复 / 忽略，无 notice 的行不出现决策区', async () => {
  const saved = JSON.parse(JSON.stringify(world.state.graph));
  try {
    const one = world.state.graph.nodes.find(node => node.kind === 'task' && node.id === 1);
    one.notice = { id: 5, kind: 'question', title: '这条要不要动公共面', body: '第一行：先问清楚\n第二行：请给出你的决定', created_at: iso(NOW) };
    one.notice_count = 2;
    await openGraph();
    const detail = dom.node('detail');
    const rowOf = goal => detail.querySelectorAll('div.graph-node').find(node => deepText(node).includes(goal));

    // ① 只有带 notice 的那一行有决策区：徽标 + 标题 + 完整正文（不是只有标题）+ 还有多少条待决。
    const decisions = detail.querySelectorAll('div.graph-decision');
    expect(decisions.length).toBe(1);
    const row = rowOf('#1');
    expect(row.querySelector('div.graph-decision')).toBe(decisions[0]);
    const text = deepText(decisions[0]);
    expect(text).toContain('◔ 等你决定');
    expect(text).toContain('这条要不要动公共面');
    expect(text).toContain('第一行：先问清楚');
    expect(text).toContain('第二行：请给出你的决定');
    expect(text).toContain('另有 1 条待决');
    // 任务行带「在等你」强调，与既有的工作态强调同时存在。
    expect(row.classList.contains('graph-emphasis-awaiting')).toBe(true);
    expect(rowOf('#2').classList.contains('graph-emphasis-awaiting')).toBe(false);
    expect(rowOf('#2').querySelector('div.graph-decision')).toBeNull();
    // 分支行（不是任务行）也不该出现决策区。
    expect(detail.querySelectorAll('div.graph-branch div.graph-decision').length).toBe(0);

    // ② 输入框占位与详情面板一致；⌘/Ctrl+回车就是提交。
    const input = decisions[0].querySelector('textarea.graph-decision-input');
    expect(input).toBeTruthy();
    expect(input.placeholder).toBe('你的决定；⌘/Ctrl+回车提交');
    input.value = '先加个开关，不动公共面';
    await input.listeners.keydown[0]({ key: 'Enter', metaKey: true, preventDefault() {} });
    expect(world.state.actions).toContainEqual({ method: 'notice.answer', params: { id: 5, answer: '先加个开关，不动公共面' } });
    expect(dom.node('error').textContent).toContain('已把答复发给任务 #1');
    // 重拉后这条 notice 已经结算：决策区收回去，输入框也不再留着已提交的内容。
    expect(detail.querySelectorAll('div.graph-decision').length).toBe(0);
    expect(rowOf('#1').classList.contains('graph-emphasis-awaiting')).toBe(false);

    // ③ 忽略：同一处还有一个「忽略」按钮，走 notice.dismiss。
    one.notice = { id: 5, kind: 'question', title: '这条要不要动公共面', body: '正文', created_at: iso(NOW) };
    one.notice_count = 1;
    await openGraph();
    const ignore = dom.node('detail').querySelectorAll('div.graph-decision')[0]
      .querySelectorAll('button').find(node => node.textContent === '忽略');
    expect(ignore).toBeTruthy();
    await ignore.onclick();
    expect(world.state.actions).toContainEqual({ method: 'notice.dismiss', params: { id: 5 } });
    expect(dom.node('error').textContent).toContain('已忽略任务 #1 的这条待决事项');
  } finally {
    world.state.graph = saved;
    await openGraph();
  }
});

test('分支图：计划待批的任务行能原地批准 / 驳回，驳回与意图面板同文案、空理由不发', async () => {
  const saved = JSON.parse(JSON.stringify(world.state.graph));
  try {
    // planner 任务按现有读模型挂在输入锚点分支下；两条计划各自等你拍板。
    const planTask = (id, noticeId) => ({
      kind: 'task', id, role: 'planner', name: `plan-${id}`, goal: `拆解需求 ${id}`, status: 'awaiting', integration: 'none',
      branch: 'lush/demo/input-1-anchor', workspace: null, workspace_state: 'none', base_commit: null, head_commit: null,
      target_branch: null, ahead: null, behind: null, merged: null, current: false, archived: false,
      notice: { id: noticeId, kind: 'plan', title: `这轮拆解想先请你拍板 ${id}`, body: '计划正文', created_at: iso(NOW) },
      notice_count: 1,
    });
    world.state.graph.nodes.push(planTask(21, 7), planTask(22, 8));
    await openGraph();
    const decisionOf = id => dom.node('detail').querySelectorAll('div.graph-decision')
      .find(node => deepText(node).includes(`这轮拆解想先请你拍板 ${id}`));
    const buttonOf = (id, label) => decisionOf(id).querySelectorAll('button').find(node => node.textContent === label);

    // 徽标与 question 不同：这里是「计划待批」，且没有回复输入框（计划是批 / 驳，不是答话）。
    expect(deepText(decisionOf(21))).toContain('计划待批');
    expect(decisionOf(21).querySelector('textarea')).toBeNull();

    // 批准：id 用 planner 任务 id（与意图面板的 plan.approve 同源）。
    await buttonOf(21, '批准并开发').onclick();
    expect(world.state.actions).toContainEqual({ method: 'plan.approve', params: { id: 21 } });
    expect(dom.node('error').textContent).toContain('已批准 #21 的拆解');
    expect(decisionOf(21)).toBeUndefined();   // 批准后这条计划已结算，决策区消失

    // 驳回：先弹应用内输入框取理由，与 render-intents.js 的 planActions 同文案 / 同校验。
    const pending = buttonOf(22, '驳回').onclick();
    expect(dialogText(dom)).toContain('驳回 #22 的拆解？');
    expect(dialogText(dom)).toContain('理由会送给 planner');
    expect(dialogText(dom)).toContain('驳回并重拆');
    // 空理由不发：弹窗收起，什么都不提交。
    await answerDialog(dom, '驳回并重拆', '');
    await pending;
    expect(world.state.actions.some(entry => entry.method === 'plan.reject')).toBe(false);
    expect(deepText(decisionOf(22))).toContain('计划待批');

    // 有理由才发，理由去掉首尾空白后随请求一起走。
    const rejected = buttonOf(22, '驳回').onclick();
    await answerDialog(dom, '驳回并重拆', '  别动架构，先加个开关  ');
    await rejected;
    expect(world.state.actions).toContainEqual({ method: 'plan.reject', params: { id: 22, reason: '别动架构，先加个开关' } });
    expect(dom.node('error').textContent).toContain('已驳回 #22 的拆解：别动架构，先加个开关');
  } finally {
    world.state.graph = saved;
    await openGraph();
  }
});

test('分支图：决策输入不被轮询冲掉——有内容或聚焦时跳过重画，提交后按新数据正常重画', async () => {
  const saved = JSON.parse(JSON.stringify(world.state.graph));
  try {
    const one = world.state.graph.nodes.find(node => node.kind === 'task' && node.id === 1);
    one.notice = { id: 5, kind: 'question', title: '要不要动公共面', body: '正文', created_at: iso(NOW) };
    one.notice_count = 1;
    await openGraph();
    const input = () => dom.node('detail').querySelector('textarea.graph-decision-input');
    input().value = '打了一半的决定';
    input().focus();
    expect(dom.document.activeElement).toBe(input());

    // UI 外新建一条分支：最长陈旧时间到期会无条件重拉图，但用户正在决策区里打字，这次不该重画。
    world.state.graph.nodes.push({ kind: 'branch', id: 'branch:lush/demo/9-late', name: 'lush/demo/9-late',
      head_commit: 'f00', current: false, tracked: true, placeholder: false, created_at: iso(NOW) });
    const ui = (await import('../../src/ui/web/assets/state.js')).ui;
    ui.graphFetchedAt = Date.now() - 10001;
    await dom.intervalFor(1500)();
    // 输入与焦点都还在，图也没有被新数据冲掉（ui.lastGraph 照常更新，只是没画）。
    expect(input()).toBeTruthy();
    expect(input().value).toBe('打了一半的决定');
    expect(dom.document.activeElement).toBe(input());
    expect(deepText(dom.node('detail'))).not.toContain('lush/demo/9-late');
    expect(ui.lastGraph.nodes.some(node => node.name === 'lush/demo/9-late')).toBe(true);

    // 提交之后走正常重画：输入被松开，新分支与答复后的图都画出来。
    const reply = dom.node('detail').querySelectorAll('div.graph-decision')[0]
      .querySelectorAll('button').find(node => node.textContent === '回复并继续任务');
    await reply.onclick();
    expect(deepText(dom.node('detail'))).toContain('lush/demo/9-late');
    expect(dom.node('detail').querySelectorAll('div.graph-decision').length).toBe(0);
  } finally {
    world.state.graph = saved;
    await openGraph();
  }
});

test('分支图：兜底分组里的任务带「删除」，确认后走 task.delete 并从图上收起来', async () => {
  const saved = JSON.parse(JSON.stringify(world.state.graph));
  try {
    // 既没有自己的分支节点、目标分支也不在图上、又没有归档的任务：graphLayout 把它放进兜底分组。
    world.state.graph.nodes.push({ kind: 'task', id: 41, role: 'planner', name: null, goal: '给 Web 加个设置页',
      status: 'completed', integration: 'none', branch: null, target_branch: 'ghost', workspace: null,
      workspace_state: 'none', branch_state: 'none', archived: false });
    await openGraph();
    const block = () => dom.node('detail').querySelector('div.graph-unplaced');
    expect(deepText(block())).toContain('未归属分支的任务');
    expect(deepText(block())).toContain('给 Web 加个设置页');
    const remove = () => block().querySelectorAll('button').find(node => node.textContent === '删除');

    // 确认文案必须把代价写清楚（丢任务历史、不可撤销、收不回来就拒绝）；取消＝什么都不发。
    const cancelled = remove().onclick();
    expect(dialogText(dom)).toContain('删除任务 #41？');
    expect(dialogText(dom)).toContain('无法撤销');
    await answerDialog(dom, '保留');
    await cancelled;
    expect(world.state.actions.some(entry => entry.method === 'task.delete')).toBe(false);
    expect(deepText(block())).toContain('给 Web 加个设置页');

    // 确认后走 task.delete（与 CLI 的 lush task delete 同源），重拉后这条不再出现在兜底分组里。
    const confirmed = remove().onclick();
    await answerDialog(dom, '删除');
    await confirmed;
    expect(world.state.actions).toContainEqual({ method: 'task.delete', params: { id: 41 } });
    expect(dom.node('error').textContent).toContain('已删除任务 #41');
    expect(deepText(dom.node('detail')).includes('给 Web 加个设置页')).toBe(false);
  } finally {
    world.state.graph = saved;
    await openGraph();
  }
});
