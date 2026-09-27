import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 输入区折叠 / 展开：默认只留一行输入 + 一行操作，父 Task 与快捷键说明点开才出现；
// 折叠态仍能看到待提交意图数量、展开控件，以及已选父 Task 的痕迹。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { setComposerReferences } = await import('../../src/ui/web/assets/context-references.js');
const { renderParentOptions } = await import('../../src/ui/web/assets/composer.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
dom.node('side-nav').replaceChildren();
await boot();

afterAll(() => dom.restore());

test('输入区默认折叠，展开后才出现父 Task 与快捷键，折叠态留下父 Task 痕迹', async () => {
  const details = dom.node('composer-details');
  const shortcuts = dom.node('composer-shortcuts');
  const expand = dom.node('composer-expand');
  // 默认折叠：不依赖用户任何操作，父 Task 与快捷键都不可见。
  expect(details.hidden).toBe(true);
  expect(shortcuts.hidden).toBe(true);
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  expect(expand.title).toContain('父 Task');
  expect(expand.title).toContain('快捷键');
  // 折叠态仍能看见展开控件（草稿面板是已下线的遗留入口，不再计入）。
  expect(expand.textContent).toContain('更多');

  // 点开：父 Task 字段与快捷键说明出现；再点收起。
  await expand.onclick();
  expect(expand.getAttribute('aria-expanded')).toBe('true');
  expect(details.hidden).toBe(false);
  expect(shortcuts.hidden).toBe(false);
  expect(expand.textContent).toContain('收起');
  await expand.onclick();
  expect(details.hidden).toBe(true);
  expect(shortcuts.hidden).toBe(true);

  // 选中父 Task 后，折叠态在展开控件上留下可见痕迹（避免不知情地提交到别的分支）。
  // 候选来自输入框读的同一份快照；这里注入一个 main Task，再选它。
  ui.lastSnapshot.tasks = [{ id: 1, task_kind: 'main', branch: 'main', status: 'waiting', goal: '管理 main 分支及子任务合并请求' }];
  renderParentOptions();
  dom.node('input-parent').value = 'main';
  dom.node('input-parent').listeners.change[0]({});
  expect(expand.textContent).toContain('#1');
  expect(expand.title).toContain('#1');
});

test('引用卡片始终可见，1.5s 轮询不改变输入区折叠态', async () => {
  const details = dom.node('composer-details'), expand = dom.node('composer-expand');
  expect(details.hidden).toBe(true);  // 上一条测试结束时已收起
  setComposerReferences([{ version: 1, kind: 'text', target: {}, label: '任务 #1', quote: '正在改点什么', location: {}, captured_at: iso(NOW) }]);
  expect(dom.node('composer-references').hidden).toBe(false);
  world.state.drafts = [{ id: 21, content: '带引用的草稿', created_at: iso(NOW - 1000) }];
  await dom.intervalFor(1500)();
  // 轮询重画后：引用卡片与折叠态都不受轮询影响。
  expect(dom.node('composer-references').hidden).toBe(false);
  expect(details.hidden).toBe(true);
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  setComposerReferences([]);
});
