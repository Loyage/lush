import { test, expect, afterAll } from 'bun:test';
import { installDom } from './project-dom.js';
import { until } from '../helpers.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 输入区折叠 / 展开：默认只留一行输入 + 一行操作，父 Task 与快捷键说明点开才出现；
// 折叠态仍能看到展开控件，以及已选父 Task 的痕迹。
const world = makeWorld();
let intercept = null;
const dom = installDom({ fetch: (url, options) => intercept?.(String(url), options) ?? world.fetchImpl(url, options) });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { setComposerReferences } = await import('../../src/ui/web/assets/context-references.js');
const { renderParentOptions } = await import('../../src/ui/web/assets/composer.js');
const { overview } = await import('../../src/ui/web/assets/navigate.js');
const { buffer } = await import('../../src/ui/web/assets/composer.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
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
  expect(expand.getAttribute('data-help')).toContain('父 Worker');
  expect(expand.getAttribute('data-help')).toContain('快捷键');
  // 折叠态仍能看见展开控件与已选父 Task 的痕迹。
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
  // 完整父候选读面独立于有界 overview。
  world.state.inputParents = ui.composerParents = [{ id: 1, branch: 'main', goal: '管理 main 分支及子任务合并请求' }];
  renderParentOptions();
  dom.node('input-parent').value = 'main';
  dom.node('input-parent').onchange({});
  expect(expand.textContent).toContain('#1');
  expect(expand.getAttribute('data-help')).toContain('#1');
});

test('引用卡片始终可见，1.5s 轮询不改变输入区折叠态', async () => {
  const details = dom.node('composer-details'), expand = dom.node('composer-expand');
  expect(details.hidden).toBe(true);  // 上一条测试结束时已收起
  setComposerReferences([{ version: 1, kind: 'text', target: {}, label: '任务 #1', quote: '正在改点什么', location: {}, captured_at: iso(NOW) }]);
  expect(dom.node('composer-references').hidden).toBe(false);
  await dom.intervalFor(1500)();
  // 轮询重画后：引用卡片与折叠态都不受轮询影响。
  expect(dom.node('composer-references').hidden).toBe(false);
  expect(details.hidden).toBe(true);
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  setComposerReferences([]);
});

test('⌘/Ctrl+Enter 创建待开始，⌘/Ctrl+Shift+Enter 直接运行', async () => {
  const lastSend = () => [...world.state.actions].reverse().find(row => row.method === 'order.submit');
  const fire = async (shift, content) => {
    await overview();
    dom.node('input').value = content;
    dom.node('input').oninput({});
    await dom.node('input').onkeydown({ key: 'Enter', metaKey: true, shiftKey: shift, isComposing: false, preventDefault() {} });
    await until(() => lastSend()?.params.content === content && !ui.composerSubmitting);
  };
  await fire(false, '先暂存的目标');
  expect(lastSend().params.start).toBe(false);
  await fire(true, '立即运行的目标');
  expect(lastSend().params.start).toBe(true);
});

test('真实 refresh 慢 overview：确认立即清空解锁，继续暂存与输入不被旧创建导航抢走', async () => {
  await until(() => !ui.busy); await overview();
  let release, reads = 0, acknowledged = false;
  const gate = new Promise(done => { release = done; });
  intercept = url => {
    if (url.startsWith('/api/overview')) { reads++; return gate.then(() => world.fetchImpl('/api/snapshot')); }
  };
  try {
    dom.node('input').value = '创建确认不等 overview'; dom.node('input').oninput(); dom.node('input').focus();
    setComposerReferences([{ version: 1, kind: 'text', target: {}, label: '本条引用', quote: '原文', location: {}, captured_at: iso(NOW) }]);
    const send = dom.node('input-form').onsubmit({ preventDefault() {} }).then(() => { acknowledged = true; });
    await until(() => reads === 1);
    expect(acknowledged).toBe(true); expect(ui.busy).toBe(true); expect(ui.composerSubmitting).toBe(false);
    expect(dom.node('input').value).toBe(''); expect(dom.node('composer-references').hidden).toBe(true);
    dom.node('input').value = 'overview 在途时的第二条'; dom.node('input').oninput();
    expect(dom.node('input-buffer').disabled).toBe(false);
    await buffer();
    expect(world.state.actions.at(-1)).toMatchObject({ method: 'draft.add', params: { content: 'overview 在途时的第二条' } });
    dom.node('input').value = '第三条继续编辑'; dom.node('input').oninput(); const view = ui.view;
    release(); await send; await until(() => reads === 2 && !ui.busy); await Promise.resolve();
    // The second ACK queues one fresh read behind the slow first overview, rather than being swallowed.
    expect(ui.view).toBe(view); expect(ui.selected).toBeNull(); expect(reads).toBe(2);
    expect(dom.node('input').value).toBe('第三条继续编辑'); expect(document.activeElement).toBe(dom.node('input'));
  } finally { release(); await until(() => !ui.busy); intercept = null; }
});

test('树页重型后台更新不占输入确认或概览锁，迟到树补齐不碰下一条输入', async () => {
  await until(() => !ui.busy); await overview();
  let release, reads = 0;
  const gate = new Promise(done => { release = done; });
  intercept = url => {
    if (url.startsWith('/api/worker-graph')) { reads++; return gate; }
  };
  const graph = { nodes: [{ id: 1, parent_id: null, task_kind: 'main', role: 'agent', status: 'waiting', title: '后台树补齐' }], edges: [], total: 1 };
  try {
    ui.taskGraphPage = null; ui.taskGraphFetchedAt = 0;
    const view = activateDetailView({ view: 'task-graph', hash: '#worker-graph' });
    dom.node('input').value = '树页暂存第一条'; dom.node('input').oninput(); dom.node('input').focus();
    await buffer(); await until(() => reads === 1 && !ui.busy);
    expect(ui.composerSubmitting).toBe(false); expect(dom.node('input').value).toBe('');
    expect(ui.taskGraphPage.fullPending).toBeTruthy();
    dom.node('input').value = '树后台在途暂存第二条'; dom.node('input').oninput();
    await buffer(); await until(() => !ui.busy);
    expect(world.state.actions.at(-1)).toMatchObject({ method: 'draft.add', params: { content: '树后台在途暂存第二条' } });
    dom.node('input').value = '第三条仍在编辑'; dom.node('input').oninput();
    release({ ok: true, json: async () => graph }); await until(() => !ui.taskGraphPage.fullPending);
    expect(reads).toBe(1); expect(ui.view).toBe(view);
    expect(dom.node('input').value).toBe('第三条仍在编辑'); expect(document.activeElement).toBe(dom.node('input'));
  } finally { release({ ok: true, json: async () => graph }); intercept = null; await overview(); }
});

test('真实 refresh：创建及立即开始不读取新 Worker 详情、不跳转，继续输入保住焦点', async () => {
  await until(() => !ui.busy); await overview(); let reads = 0;
  intercept = url => { if (url === '/api/worker/99') reads++; };
  try {
    const view = ui.view, hash = dom.location.hash;
    for (const shiftKey of [false, true]) {
      dom.node('input').value = '发射不打开 detail'; dom.node('input').oninput(); dom.node('input').focus();
      await dom.node('input').onkeydown({ key: 'Enter', ctrlKey: true, shiftKey, preventDefault() {} });
      await until(() => !ui.busy); await Promise.resolve();
      expect(ui.composerSubmitting).toBe(false); expect(dom.node('input').value).toBe('');
      expect(ui.view).toBe(view); expect(dom.location.hash).toBe(hash); expect(ui.selected).toBeNull();
      expect(reads).toBe(0); expect(document.activeElement).toBe(dom.node('input'));
    }
    dom.node('input').value = '发射后的第二条'; dom.node('input').oninput();
    await buffer(); expect(world.state.actions.at(-1).method).toBe('draft.add');
    dom.node('input').value = '下一条尚未发送'; dom.node('input').oninput();
    setComposerReferences([{ version: 1, kind: 'text', target: {}, label: '下一条引用', quote: '保留快照', location: {}, captured_at: iso(NOW) }]);
    await until(() => !ui.busy);
    expect(ui.view).toBe(view); expect(reads).toBe(0);
    expect(dom.node('input').value).toBe('下一条尚未发送'); expect(dom.node('composer-references').hidden).toBe(false);
    expect(document.activeElement).toBe(dom.node('input')); expect(ui.composerSubmitting).toBe(false);
  } finally { intercept = null; setComposerReferences([]); await overview(); }
});
