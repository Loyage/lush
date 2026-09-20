import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
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

test('分支图：可归档分支才有归档按钮，确认后发 branch.archive 并显示已归档', async () => {
  await openGraph();
  const saved = JSON.parse(JSON.stringify(world.state.graph));
  try {
    const detail = dom.node('detail');
    // 分支表头的那一行：嵌套子分支在别的 graph-group 里，不能用 block 去查，否则会看到子分支的按钮。
    const branchRow = name => detail.querySelectorAll('span.graph-branch-name')
      .find(node => node.textContent.includes(name)).parentNode;
    const archiveButton = name => branchRow(name).querySelectorAll('button').find(node => node.textContent === '归档');
    // 只有 archivable 才给动作：当前检出（main）、未登记（release / feature）、ref 与 worktree 都没了（3-three）都不给。
    expect(archiveButton('lush/demo/1-one')).toBeTruthy();
    expect(archiveButton('lush/demo/2-two')).toBeTruthy();
    expect(archiveButton('lush/demo/input-1-anchor')).toBeTruthy();
    expect(archiveButton('main')).toBeFalsy();
    expect(archiveButton('release')).toBeFalsy();
    expect(archiveButton('feature/scratch')).toBeFalsy();
    expect(archiveButton('lush/demo/3-three')).toBeFalsy();
    const button = archiveButton('lush/demo/1-one');

    await button.onclick();
    // 删除不可撤销，所以先确认，并把代价写清楚。
    expect(dom.confirms.at(-1)).toContain('会删除分支与 worktree，保留任务与会话，未提交改动会被丢弃');
    expect(world.state.actions).toContainEqual({ method: 'branch.archive', params: { branch: 'lush/demo/1-one', discard: true } });
    // 成功后重新拉图：这条分支变成已归档、不再有归档按钮，结果写在 #error。
    expect(deepText(branchRow('lush/demo/1-one'))).toContain('已归档');
    expect(archiveButton('lush/demo/1-one')).toBeFalsy();
    expect(dom.node('error').textContent).toContain('lush/demo/1-one');
    expect(dom.node('error').textContent).toContain('已归档');
  } finally { world.state.graph = saved; await openGraph(); }
});

test('分支图：归档分支下的任务显示已归档而不是缺失分支', async () => {
  const saved = world.state.graph;
  world.state.graph = {
    generated_at: new Date().toISOString(), current_branch: 'main', truncated: false, git: true, error: null,
    nodes: [
      { kind: 'branch', id: 'branch:main', name: 'main', head_commit: 'aaa', current: true, tracked: false, placeholder: false },
      { kind: 'branch', id: 'branch:lush/demo/7-old', name: 'lush/demo/7-old', head_commit: null, current: false, tracked: true,
        placeholder: false, archived: true, archived_at: iso(NOW), status: 'archived', worktree_state: 'missing' },
      { kind: 'task', id: 7, role: 'worker', name: 'seven', goal: '归档掉的分支工作', status: 'completed', integration: 'none',
        branch: 'lush/demo/7-old', workspace: null, workspace_state: 'none', branch_state: 'missing', archived: true,
        base_commit: 'aaa', head_commit: 'bbb', target_branch: 'main', ahead: 1, behind: 0, merged: false, current: false },
    ],
    edges: [],
  };
  try {
    await openGraph();
    const detail = dom.node('detail');
    const text = deepText(detail);
    expect(text).toContain('归档掉的分支工作');
    expect(text).toContain('已归档');
    // 归档是预期状态，不该再报「缺失分支」；已归档的分支也不再提供归档动作。
    expect(text).not.toContain('⚠ 缺失分支');
    expect(detail.querySelectorAll('button').some(node => node.textContent === '归档')).toBe(false);
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
    expect(merge.title).toContain('未收拢的子分支：lush/demo/2-two');
    expect(deepText(blockOf('lush/demo/1-one'))).toContain('先收拢子分支：lush/demo/2-two');
  } finally {
    edge.blockers = saved.blockers; edge.can_merge = saved.can_merge;
  }
});

test('分支图：分支子树可折叠，状态写进 localStorage，重画后仍收起', async () => {
  await openGraph();
  const detail = dom.node('detail');
  const header = name => detail.querySelectorAll('span.graph-branch-name').find(node => node.textContent.includes(name));
  const caretOf = name => header(name).parentNode.querySelector('button.graph-caret');
  const blockOf = name => header(name).parentNode.parentNode;

  // 默认全展开：箭头朝下、aria-expanded=true，不静默藏东西。
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

  // 重画（轮询拿到新数据 / 手动刷新）不会把收起状态丢掉：新节点上仍然是收起的。
  await openGraph();
  expect(blockOf('lush/demo/1-one').classList.contains('collapsed')).toBe(true);
  expect(caretOf('lush/demo/1-one').getAttribute('aria-expanded')).toBe('false');
  // 收起只藏子孙（靠 .collapsed 的 CSS），谱系本身不动：父分支照旧包着它。
  expect(deepText(blockOf('main'))).toContain('lush/demo/1-one');

  // 再点一次展开，并把偏好清干净（后面的测试不该继承这次折叠）。
  caretOf('lush/demo/1-one').onclick();
  expect(blockOf('lush/demo/1-one').classList.contains('collapsed')).toBe(false);
  expect(caretOf('lush/demo/1-one').getAttribute('aria-expanded')).toBe('true');
  expect(JSON.parse(localStorage.getItem('lush.graphCollapsed'))).toEqual([]);
});
