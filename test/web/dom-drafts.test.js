import { test, expect, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { installDom } from '../dom-stub.js';
import { until } from '../helpers.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 待提交意图（底部 composer 面板）勾选部分提交、就地编辑、轮询不打断编辑。
// 每个 DOM 测试文件都自给自足：bun test 在文件之间共享模块注册表，只有本进程里第一个 dom 文件会走到
// app.js 顶部那次 boot()，其余文件 import 到的是缓存模块。所以这里自己建 world、装 stub，再显式装配
// 一次当前 DOM。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
// app.js 被加载时会自己 await boot() 一次：只有本进程里第一个 dom 文件会命中那次调用，而且它是对着
// 本文件的 stub 跑的。boot() 里 initSidebar() 是「追加」导航项（其余区块都是 replaceChildren，重复
// 装配无残留），所以再 boot() 一次之前先把左栏清空，保证每个文件都恰好装配一次。
dom.node('side-nav').replaceChildren();
await boot();

afterAll(() => dom.restore());

test('待提交意图可勾选部分提交，也可以就地编辑，轮询不打断编辑', async () => {
  world.state.drafts = [
    { id: 11, content: '第一条', created_at: iso(NOW - 5000) },
    { id: 12, content: '第二条', created_at: iso(NOW - 4000) },
  ];
  await dom.intervalFor(1500)();
  // 面板默认折叠在输入区，带条数开关；展开后才看到列表
  const toggle = dom.node('draft-toggle');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(dom.node('draft-panel').classList.contains('open')).toBe(false);
  expect(dom.node('draft-count').textContent).toBe('2 条');
  await toggle.onclick();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(dom.node('draft-panel').classList.contains('open')).toBe(true);

  const drafts = dom.node('drafts');
  expect(drafts.querySelectorAll('.draft')).toHaveLength(2);
  const boxes = drafts.querySelectorAll('.pick');
  expect(boxes).toHaveLength(2);
  expect(boxes.every(box => box.checked)).toBe(true);

  // 取消勾选 #12：提交按钮仍可用（#11 还选着），提交只带 #11
  boxes[1].checked = false; boxes[1].onchange();
  dom.node('input-branch').value = 'release/next';
  expect(dom.node('draft-commit').disabled).toBe(false);
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(world.state.commits.at(-1)).toEqual([11]);
  expect(world.state.actions.findLast(row => row.method === 'draft.commit')).toEqual({
    method: 'draft.commit', params: { ids: [11], branch: 'release/next' },
  });
  expect(dom.node('error').textContent).toContain('已提交 1 条输入');

  // 剩下的一条可以点正文就地编辑；轮询刷新不重建正在编辑的那条
  await dom.intervalFor(1500)();
  drafts.querySelector('.goal').onclick();
  const box = drafts.querySelector('textarea.draft-edit');
  expect(box).toBeTruthy();
  expect(box.value).toBe('第二条');
  // 点正文进入编辑后焦点真的落在文本框上（手机端光标可落进文本）。
  expect(dom.document.activeElement).toBe(box);
  await dom.intervalFor(1500)();
  expect(drafts.querySelector('textarea.draft-edit')).toBe(box);

  // Enter 保存：draft.update 发出后正文变成新内容
  box.value = '第二条（改过）';
  await box.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
  await until(() => world.state.drafts[0]?.content === '第二条（改过）');
  await until(() => dom.node('drafts').querySelector('.goal')?.textContent === '第二条（改过）');
});

test('点「编辑」也获得焦点；窄屏字号与最小高度是稳定接缝', async () => {
  world.state.drafts = [{ id: 21, content: '移动端编辑', created_at: iso(NOW) }];
  await dom.intervalFor(1500)();
  if (!dom.node('draft-panel').classList.contains('open')) await dom.node('draft-toggle').onclick();
  const edit = dom.node('drafts').querySelector('button.edit');
  await edit.onclick();
  const box = dom.node('drafts').querySelector('textarea.draft-edit');
  expect(box).toBeTruthy();
  expect(dom.document.activeElement).toBe(box);
  expect(box.value).toBe('移动端编辑');
  // Esc 取消，不留编辑态。
  await box.listeners.keydown[0]({ key: 'Escape', preventDefault() {} });
  // 窄屏下字号 ≥16px（防 iOS 自动放大），并有随内容增长前的最小高度。
  const css = readFileSync(new URL('../../src/ui/web/assets/styles.css', import.meta.url), 'utf8');
  expect(css).toMatch(/\.draft-edit\{[^}]*min-height:\d+px/);
  expect(css).toMatch(/@media\(max-width:760px\)\{[\s\S]*?\.draft-edit\{font-size:16px;min-height:\d+px/);
});
