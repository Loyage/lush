import { test, expect, afterAll } from 'bun:test';
import { installDom } from './project-dom.js';
import { makeWorld } from './dom-world.js';

// 输入区父候选来自独立完整读面，选项值仍是分支名——
// 所以界面选择的是 Task，`order.submit` 的语义（按分支创建 Task）不变。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { parentTasks, renderParentOptions, syncComposer } = await import('../../src/ui/web/assets/composer.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

const parents = [
  { id: 5, task_kind: 'order', branch: 'lush/a/5-five', status: 'waiting', goal: '五号任务' },
  { id: 1, task_kind: 'main', branch: 'main', status: 'waiting', goal: '管理 main' },
  { id: 7, task_kind: 'owner', branch: 'release', status: 'awaiting', goal: '管理 release' },
  // 已发合并请求的指令、已结束的指令、子 Task 与没有分支的 Task 都不是父候选。
  { id: 8, task_kind: 'order', branch: 'lush/a/8-eight', status: 'running', goal: '八号任务', reservation: { kind: 'merge', status: 'requested' } },
  { id: 12, task_kind: 'order', branch: 'legacy', status: 'waiting', reservation: { kind: 'showcase', status: 'started' } },
  { id: 9, task_kind: 'order', branch: 'lush/a/9-nine', status: 'completed', goal: '九号已完成' },
  { id: 10, task_kind: 'child', branch: 'lush/a/10-child', status: 'waiting', goal: '子任务' },
  { id: 11, task_kind: 'order', branch: null, status: 'waiting', goal: '没有分支' },
];

test('父 Task 候选只含仍活动的分支所有者，按 id 升序', () => {
  expect(parentTasks(parents).map(task => task.id)).toEqual([1, 5, 7]);
});

test('下拉框按完整候选重建、保留选择与不可用父身份，不随 overview 回退默认', async () => {
  ui.composerParents = parentTasks(parents);
  renderParentOptions();
  const select = dom.node('input-parent');
  expect(select.children.map(option => option.value)).toEqual(['', 'main', 'lush/a/5-five', 'release']);
  expect(select.children[1].textContent).toContain('#1');

  // 选中指令 Task：值仍是它的分支，提交语义不变；折叠态显示 Task 身份。
  select.value = 'lush/a/5-five';
  select.onchange({});
  const expand = dom.node('composer-expand');
  expect(expand.textContent).toContain('#5');
  expect(expand.getAttribute('data-help')).toContain('#5');

  // 列表没变时不重建选项节点，避免每次轮询把打开的下拉框关掉。
  const placeholder = select.children[0];
  syncComposer();
  expect(select.children[0]).toBe(placeholder);

  // 候选消失后保留当前分支，必须显式重选；不能静默改成 canonical 默认。
  ui.composerParents = [];
  syncComposer();
  expect(select.value).toBe('lush/a/5-five');
  expect(expand.textContent).toContain('请重选');
});
