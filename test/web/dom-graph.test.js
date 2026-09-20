import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

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

test('分支图：空图沿用原来的提示文案', async () => {
  const saved = world.state.graph;
  world.state.graph = { generated_at: new Date().toISOString(), current_branch: 'main', truncated: false, git: true, error: null, nodes: [], edges: [] };
  try {
    await openGraph();
    expect(deepText(dom.node('detail'))).toContain('还没有任何任务分支或 worktree。');
  } finally { world.state.graph = saved; }
});
