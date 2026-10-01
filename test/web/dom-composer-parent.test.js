import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

// 输入区的父 Task 选择：候选来自与输入框同一份快照，选项值仍是分支名——
// 所以界面选择的是 Task，`say.submit` 的语义（按分支创建 Task）不变。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { parentTasks, renderParentOptions, syncComposer } = await import('../../src/ui/web/assets/composer.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

const parents = [
  { id: 5, task_kind: 'say', branch: 'lush/a/5-five', status: 'waiting', goal: '五号任务' },
  { id: 1, task_kind: 'main', branch: 'main', status: 'waiting', goal: '管理 main' },
  { id: 7, task_kind: 'owner', branch: 'release', status: 'awaiting', goal: '管理 release' },
  // 已发合并请求的 say、已结束的 say、子 Task 与没有分支的 Task 都不是父候选。
  { id: 8, task_kind: 'say', branch: 'lush/a/8-eight', status: 'running', goal: '八号任务', reservation: { kind: 'merge', status: 'requested' } },
  { id: 12, task_kind: 'say', branch: 'legacy', status: 'waiting', reservation: { kind: 'showcase', status: 'started' } },
  { id: 9, task_kind: 'say', branch: 'lush/a/9-nine', status: 'completed', goal: '九号已完成' },
  { id: 10, task_kind: 'child', branch: 'lush/a/10-child', status: 'waiting', goal: '子任务' },
  { id: 11, task_kind: 'say', branch: null, status: 'waiting', goal: '没有分支' },
];

test('父 Task 候选只含仍活动的分支所有者，按 id 升序', () => {
  expect(parentTasks(parents).map(task => task.id)).toEqual([1, 5, 7]);
});

test('下拉框按快照重建、保留仍有效的选择，并在折叠态留下父 Task 痕迹', async () => {
  ui.lastSnapshot = { ...(ui.lastSnapshot ?? {}), tasks: parents };
  renderParentOptions();
  const select = dom.node('input-parent');
  expect(select.children.map(option => option.value)).toEqual(['', 'main', 'lush/a/5-five', 'release']);
  expect(select.children[1].textContent).toContain('#1');

  // 选中 say Task：值仍是它的分支，提交语义不变；折叠态显示 Task 身份。
  select.value = 'lush/a/5-five';
  select.listeners.change[0]({});
  const expand = dom.node('composer-expand');
  expect(expand.textContent).toContain('#5');
  expect(expand.title).toContain('#5');

  // 列表没变时不重建选项节点，避免每次轮询把打开的下拉框关掉。
  const placeholder = select.children[0];
  syncComposer();
  expect(select.children[0]).toBe(placeholder);

  // 候选消失后，失效的选择清回默认，折叠痕迹也一并消失。
  ui.lastSnapshot = { ...ui.lastSnapshot, tasks: [] };
  syncComposer();
  expect(select.value).toBe('');
  expect(expand.textContent).not.toContain('#5');
});
