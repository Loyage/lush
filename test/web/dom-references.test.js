import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
dom.node('side-nav').replaceChildren();
await boot();
afterAll(() => dom.restore());

test('任务、任务子树与任意选中文字可以经右键加入输入引用，并随草稿持久化', async () => {
  const task = dom.node('tasks').querySelector('[data-id="1"]');
  expect(task).toBeTruthy();
  let prevented = false;
  await dom.fire('contextmenu', { target: task, clientX: 10, clientY: 20, preventDefault() { prevented = true; } });
  const menu = dom.node('context-menu');
  expect(prevented).toBe(true);
  expect(menu.hidden).toBe(false);
  expect(deepText(menu)).toContain('引用：任务 #1');
  expect(deepText(menu)).toContain('引用：任务子树 #1');
  await menu.children[0].onclick();
  expect(dom.node('composer-references').children).toHaveLength(1);
  expect(deepText(dom.node('composer-references'))).toContain('任务 #1');

  dom.setSelection('用户刚刚选中的一段结果');
  await dom.fire('contextmenu', { target: task, clientX: 12, clientY: 22, preventDefault() {} });
  expect(deepText(menu)).toContain('所选文字');
  await menu.children[0].onclick();
  expect(dom.node('composer-references').children).toHaveLength(2);

  const input = dom.node('input'); input.value = '针对这些内容提出修改建议';
  const add = dom.node('draft-add');
  await add.onclick({ currentTarget: add });
  expect(world.state.drafts).toHaveLength(1);
  expect(world.state.drafts[0].references.map(row => row.kind)).toEqual(['task', 'text']);
  expect(dom.node('composer-references').children).toHaveLength(0);
});
