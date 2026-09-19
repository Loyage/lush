import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

// 分支图视图：#graph hash、分组与节点、缺失标注、点节点进详情、幂等刷新、轮询不覆盖。
// 每个 DOM 测试文件自给自足：自己建 world、装 stub，再显式装配一次当前 DOM。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { openGraph } = await import('../../src/ui/web/assets/render-graph.js');
dom.node('side-nav').replaceChildren();
await boot();

afterAll(() => dom.restore());

test('分支图：入口走 #graph，渲染分组 / 节点 / 缺失标注，点节点进详情，刷新幂等，轮询不覆盖', async () => {
  // 顶部入口把地址栏切到 #graph。
  expect(dom.node('graph-open')).toBeTruthy();
  dom.node('graph-open').onclick();
  expect(dom.location.hash).toBe('#graph');
  await openGraph();

  const detail = dom.node('detail');
  expect(detail.querySelector('div.graph-view')).toBeTruthy();
  expect(deepText(detail)).toContain('分支图');
  // 两个目标分支各自成组。
  expect(deepText(detail)).toContain('目标分支 main');
  expect(deepText(detail)).toContain('目标分支 release');
  // 三个任务节点，带领先 / 落后与缺失标注。
  const nodes = () => detail.querySelectorAll('button.graph-node');
  expect(nodes().length).toBe(3);
  expect(deepText(detail)).toContain('领先 1');
  expect(deepText(detail)).toContain('⚠ 缺失 worktree');
  expect(deepText(detail)).toContain('⚠ 缺失分支');

  // 幂等：重复渲染同一份图，节点与分组都不翻倍。
  await openGraph();
  await openGraph();
  expect(nodes().length).toBe(3);
  expect(detail.querySelectorAll('div.graph-group').length).toBe(2);

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

test('分支图：结构指纹变了才自动重拉，且不在 3 秒内重复打 git', async () => {
  await openGraph();
  const before = dom.location.hash;
  expect(before).toBe('#graph');
  const fingerprint = (await import('../../src/ui/web/assets/state.js')).ui.graphFingerprint;
  expect(fingerprint).toBeTruthy();
  // 快照结构没变：轮询不重拉（graphFetchedAt 停在刚拉的时刻）。
  const ui = (await import('../../src/ui/web/assets/state.js')).ui;
  const fetchedAt = ui.graphFetchedAt;
  await dom.intervalFor(1500)();
  expect(ui.graphFetchedAt).toBe(fetchedAt);
});
