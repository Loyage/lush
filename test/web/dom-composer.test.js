import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 输入区折叠 / 展开：默认只留一行输入 + 一行操作，父分支与快捷键说明点开才出现；
// 折叠态仍能看到待提交意图数量、展开控件，以及非空父分支的痕迹。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { setComposerReferences } = await import('../../src/ui/web/assets/context-references.js');
dom.node('side-nav').replaceChildren();
await boot();

afterAll(() => dom.restore());

test('输入区默认折叠，展开后才出现父分支与快捷键，折叠态留下父分支痕迹', async () => {
  const details = dom.node('composer-details');
  const shortcuts = dom.node('composer-shortcuts');
  const expand = dom.node('composer-expand');
  // 默认折叠：不依赖用户任何操作，父分支与快捷键都不可见。
  expect(details.hidden).toBe(true);
  expect(shortcuts.hidden).toBe(true);
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  expect(expand.title).toContain('父分支');
  expect(expand.title).toContain('快捷键');
  // 折叠态仍能看见待提交意图数量与展开控件。
  expect(dom.node('draft-count').textContent).toBe('空');
  expect(expand.textContent).toContain('更多');

  // 点开：父分支字段与快捷键说明出现；再点收起。
  await expand.onclick();
  expect(expand.getAttribute('aria-expanded')).toBe('true');
  expect(details.hidden).toBe(false);
  expect(shortcuts.hidden).toBe(false);
  expect(expand.textContent).toContain('收起');
  await expand.onclick();
  expect(details.hidden).toBe(true);
  expect(shortcuts.hidden).toBe(true);

  // 父分支非空时，折叠态在展开控件上留下可见痕迹（避免不知情地提交到别的分支）。
  dom.node('input-branch').value = 'release/next';
  dom.node('input-branch').listeners.input[0]({});
  expect(expand.textContent).toContain('release/next');
  expect(expand.title).toContain('release/next');
});

test('引用卡片始终可见，1.5s 轮询不改变输入区折叠态', async () => {
  const details = dom.node('composer-details'), expand = dom.node('composer-expand');
  expect(details.hidden).toBe(true);  // 上一条测试结束时已收起
  setComposerReferences([{ version: 1, kind: 'text', target: {}, label: '任务 #1', quote: '正在改点什么', location: {}, captured_at: iso(NOW) }]);
  expect(dom.node('composer-references').hidden).toBe(false);
  world.state.drafts = [{ id: 21, content: '带引用的草稿', created_at: iso(NOW - 1000) }];
  await dom.intervalFor(1500)();
  // 轮询重画后：待提交数量更新，引用卡片与折叠态都不受轮询影响。
  expect(dom.node('draft-count').textContent).toBe('1 条');
  expect(dom.node('composer-references').hidden).toBe(false);
  expect(details.hidden).toBe(true);
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  setComposerReferences([]);
});

test('输入框高亮命中的路由前缀，未命中清空，前缀表变化后跟着更新', async () => {
  const input = dom.node('input'), highlight = dom.node('input-highlight');
  const type = value => { input.value = value; input.listeners.input[0]({}); };
  const text = () => highlight.children.map(child => child.textContent).join('');

  type('开发 做一个登录页');
  expect(highlight.hidden).toBe(false);
  const mark = highlight.querySelector('.input-prefix');
  expect(mark).toBeTruthy();
  expect(mark.tagName).toBe('MARK');
  expect(mark.textContent).toBe('开发');
  expect(highlight.querySelectorAll('.input-prefix')).toHaveLength(1);
  // 只覆盖前缀：overlay 的可见文本仍与输入完全一致。
  expect(text()).toBe('开发 做一个登录页');

  // 前导空白不算进高亮范围。
  type('   开发：做一个登录页');
  expect(highlight.querySelector('.input-prefix').textContent).toBe('开发');

  // 未命中：清空并隐藏。
  type('做一个登录页');
  expect(highlight.hidden).toBe(true);
  expect(highlight.querySelector('.input-prefix')).toBe(null);
  expect(text()).toBe('');

  // 设置里改过前缀表：下一次快照刷新后高亮跟着换规则。
  world.state.runtimeSettings.input_routes.value = [{ prefix: '调研', target: 'research' }];
  type('调研 调度器现状');
  await dom.intervalFor(1500)();
  expect(highlight.querySelector('.input-prefix').textContent).toBe('调研');
  world.state.runtimeSettings.input_routes.value = [{ prefix: '开发', target: 'worker' }, { prefix: '解释', target: 'research' }];
});

test('textarea 滚动时高亮 overlay 同步偏移', () => {
  const input = dom.node('input'), highlight = dom.node('input-highlight');
  input.value = '开发 一个较长的输入'; input.listeners.input[0]({});
  input.scrollTop = 24; input.scrollLeft = 3;
  input.listeners.scroll[0]({});
  expect(highlight.scrollTop).toBe(24);
  expect(highlight.scrollLeft).toBe(3);
});
