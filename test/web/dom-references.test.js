import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, findByText } from './project-dom.js';
import { until } from '../helpers.js';
import { makeWorld } from './dom-world.js';
import { addComposerReference, locatable, locateReference } from '../../src/ui/web/assets/context-references.js';
import { closeExplanationPanel } from '../../src/ui/web/assets/explanations.js';

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

const menuButton = text => findByText(dom.node('context-menu'), text);

test('任务、任务子树与任意选中文字可以经右键加入输入引用，并随草稿持久化', async () => {
  const task = dom.node('tasks').querySelector('[data-id="1"]');
  expect(task).toBeTruthy();
  let prevented = false;
  await dom.fire('contextmenu', { target: task, clientX: 10, clientY: 20, preventDefault() { prevented = true; } });
  const menu = dom.node('context-menu');
  expect(prevented).toBe(true);
  expect(menu.hidden).toBe(false);
  expect(deepText(menu)).toContain('引用：Worker #1');
  expect(deepText(menu)).toContain('引用：Worker 子树 #1');
  await menuButton('引用：Worker #1').onclick();
  expect(dom.node('composer-references').children).toHaveLength(1);
  expect(deepText(dom.node('composer-references'))).toContain('Worker #1');

  dom.setSelection('用户刚刚选中的一段结果');
  await dom.fire('contextmenu', { target: task, clientX: 12, clientY: 22, preventDefault() {} });
  expect(deepText(menu)).toContain('所选文字');
  await menuButton('引用：所选文字').onclick();
  expect(dom.node('composer-references').children).toHaveLength(2);

  const input = dom.node('input'); input.value = '针对这些内容提出修改建议';
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  // 引用随这条指令一起提交；草稿缓存已下线，不再单独写 draft。
  await until(() => world.state.actions.some(action => action.method === 'order.submit'));
  const sent = world.state.actions.find(action => action.method === 'order.submit');
  expect(sent.params.references.map(row => row.kind)).toEqual(['task', 'text']);
  expect(sent.params.references[0]).toMatchObject({ kind: 'task', target: { task_id: 1 },
    label: 'Worker #1', location: { view: 'task-tree', task_id: 1 } });
  expect(dom.node('composer-references').children).toHaveLength(0);
});

test('引用卡片标签点击后导航并闪烁定位，普通文本引用不定位', async () => {
  addComposerReference({ version: 1, kind: 'task', target: { task_id: 1 }, label: '任务 #1', quote: '正在改点什么' });
  const taskChip = dom.node('composer-references').children.find(chip => chip.children[0].tagName === 'BUTTON');
  expect(taskChip).toBeTruthy();
  expect(deepText(taskChip)).toContain('任务 #1'); // 保存过的快照标签不迁移。
  await taskChip.children[0].onclick();
  expect(dom.node('detail').dataset.taskId).toBe('1');
  expect(dom.node('detail').classList.contains('locate-flash')).toBe(true);

  addComposerReference({ version: 1, kind: 'text', target: {}, label: '所选文字 · 5 字', quote: '一段文字' });
  const textChip = dom.node('composer-references').children.find(chip => deepText(chip).includes('所选文字'));
  expect(textChip.children[0].tagName).toBe('SPAN');
  expect(locatable({ kind: 'text', target: {} })).toBe(false);
});

test('检验引用用 location.task_id 导航到任务并定位到卡片', async () => {
  addComposerReference({ version: 1, kind: 'verification', target: { verification_id: 2 }, label: '检验 #2',
    quote: '检验通过', location: { view: 'task-detail', task_id: 1, section: 'verification' } });
  const chip = dom.node('composer-references').children.find(node => deepText(node).includes('检验 #2'));
  expect(chip.children[0].tagName).toBe('BUTTON');
  await chip.children[0].onclick();
  expect(dom.node('detail').dataset.taskId).toBe('1');
  expect(dom.node('detail').querySelector('.verify').classList.contains('locate-flash')).toBe(true);
});

test('旧分支引用保留快照，但不再导航到旧视图并明确说明入口已移除', async () => {
  const beforeHash = dom.location.hash;
  const beforePanel = dom.node('detail').dataset.view;
  const reference = { version: 1, kind: 'delivery_branch', target: { target_branch: 'feature', section: 'graph' },
    label: '分支 feature', quote: '当时的快照', location: { view: 'branch-graph' } };
  expect(await locateReference(reference)).toBe(false);
  expect(dom.node('error').textContent).toContain('Web 定位入口已移除');
  expect(reference.quote).toBe('当时的快照');
  expect(dom.location.hash).toBe(beforeHash);
  expect(dom.node('detail').dataset.view).toBe(beforePanel);
});

test('引用目标找不到时给出顶部提示而不是静默失败', async () => {
  addComposerReference({ version: 1, kind: 'notice', target: { notice_id: 987654 }, label: '事项记录 #987654', quote: '早已不存在的记录' });
  const chip = dom.node('composer-references').children.find(node => deepText(node).includes('#987654'));
  expect(chip.children[0].tagName).toBe('BUTTON');
  await chip.children[0].onclick();
  expect(dom.node('error').textContent).toContain('找不到这条引用的目标');
});
