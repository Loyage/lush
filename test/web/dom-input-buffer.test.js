import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { until } from '../helpers.js';

const json = data => ({ ok: true, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const calls = []; let intercept = null, opened = null, parentGate = null, parentReads = 0;
const parents = [{ id: 1, branch: 'main', goal: 'main' }, { id: 800, branch: 'feature/old-parent', goal: '完整列表中的旧父任务' }];
const dom = installDom({ fetch: async (url, options = {}) => {
  if (String(url).endsWith('/api/input-parents')) { parentReads++; return parentGate?.promise ?? json({ items: parents }); }
  if (String(url).endsWith('/api/action')) {
    const body = JSON.parse(options.body); calls.push(body);
    return intercept?.(body) ?? json({ id: 9, task: { id: 90 } });
  }
  throw new Error(`Unexpected ${url}`);
} });
const { initComposer, buffer, syncComposer, loadComposerParents } = await import('../../src/ui/web/assets/composer.js');
const { setComposerReferences, composerReferences } = await import('../../src/ui/web/assets/context-references.js');
const { resetUiState, ui } = await import('../../src/ui/web/assets/state.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { activateDetailView, openResource } = await import('../../src/ui/web/assets/sidebar-ui.js');
const restoreNav = registerNavigation({ refresh: async () => {}, detail: async id => { opened = id; } });
const input = () => dom.node('input');
const type = value => { input().value = value; input().oninput(); };
const enter = async (options = {}) => {
  let prevented = false;
  await input().onkeydown({ key: 'Enter', preventDefault() { prevented = true; }, ...options });
  return prevented;
};
const ref = label => ({ version: 1, kind: 'text', target: {}, label, quote: '引用快照', location: {}, captured_at: '2026-10-01T00:00:00Z' });
beforeEach(async () => {
  resetUiState(); calls.length = 0; intercept = null; opened = null; parentGate = null; parentReads = 0;
  input().value = ''; dom.node('input-parent').value = ''; delete dom.node('input-parent').dataset.signature;
  await initComposer();
});
afterAll(() => { restoreNav(); dom.restore(); });

test('Enter 暂存/Shift 换行/Ctrl 与 Meta 创建/开始的完整键盘矩阵', async () => {
  for (const [keys, method, start, handled] of [
    [{}, 'draft.add', undefined, true], [{ shiftKey: true }, null, undefined, false],
    [{ ctrlKey: true }, 'order.submit', false, true], [{ metaKey: true }, 'order.submit', false, true],
    [{ ctrlKey: true, shiftKey: true }, 'order.submit', true, true], [{ metaKey: true, shiftKey: true }, 'order.submit', true, true],
    [{ altKey: true }, null, undefined, false],
  ]) {
    calls.length = 0; type('想法\n第二行'); expect(await enter(keys)).toBe(handled);
    expect(calls.length).toBe(method ? 1 : 0);
    if (method) { expect(calls[0].method).toBe(method); expect(calls[0].params.start).toBe(start); }
  }
  type('按钮发送'); await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(calls.at(-1)).toMatchObject({ method: 'order.submit', params: { start: false } });
  type('按钮暂存'); await dom.node('input-buffer').onclick(); expect(calls.at(-1).method).toBe('draft.add');
});

test('IME 确认和长按重复不暂存，不拦截换行', async () => {
  type('中文');
  expect(await enter({ isComposing: true })).toBe(false);
  expect(await enter({ keyCode: 229 })).toBe(false);
  input().oncompositionstart(); expect(await enter()).toBe(false); input().oncompositionend();
  expect(await enter({ repeat: true })).toBe(true); expect(calls).toHaveLength(0);
  expect(await enter()).toBe(true); expect(calls).toHaveLength(1);
});

test('暂存仅发 draft.add，保存父分支和引用；候选不依赖 overview', async () => {
  ui.lastSnapshot = { tasks: [] }; syncComposer();
  expect(dom.node('input-parent').children.some(node => node.value === 'feature/old-parent')).toBe(true);
  dom.node('input-parent').value = 'feature/old-parent'; type('稍后再做'); setComposerReferences([ref('来源')]);
  await buffer(); expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: 'draft.add', params: { content: '稍后再做', branch: 'feature/old-parent', references: [ref('来源')] } });
  expect(opened).toBe(null); expect(input().value).toBe(''); expect(composerReferences()).toEqual([]);
  dom.node('input-parent').value = ''; type('main 默认'); await buffer();
  expect(calls.at(-1).params.branch).toBe('main');
});

test('缓冲与发送共用单飞；失败保留正文、引用、父选择并允许重试', async () => {
  const pending = deferred(); intercept = () => pending.promise;
  type('保留想法'); setComposerReferences([ref('来源')]); dom.node('input-parent').value = 'main';
  const first = buffer(); await until(() => calls.length === 1);
  await buffer(); await enter({ ctrlKey: true, shiftKey: true }); await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(calls).toHaveLength(1); expect(dom.node('input-buffer').disabled).toBe(true); expect(dom.node('draft-commit').disabled).toBe(true);
  pending.resolve({ ok: false, json: async () => ({ error: '保存失败' }) }); await first;
  expect(input().value).toBe('保留想法'); expect(composerReferences()).toEqual([ref('来源')]);
  expect(dom.node('input-parent').value).toBe('main'); expect(ui.composerSubmitting).toBe(false);
  expect(dom.node('error').textContent).toContain('保存失败');
  intercept = null; await buffer(); expect(calls).toHaveLength(2); expect(input().value).toBe('');
});

test('网络期间新输入、新引用以及修改后恢复原文均不误清', async () => {
  for (const change of [
    () => type('下一条新想法'),
    () => setComposerReferences([ref('来源'), ref('新引用')]),
    () => { type('修改'); type('原文'); },
    () => { setComposerReferences([]); setComposerReferences([ref('来源')]); },
  ]) {
    const pending = deferred(); intercept = () => pending.promise;
    type('原文'); setComposerReferences([ref('来源')]); const first = buffer();
    change(); const text = input().value, refs = composerReferences();
    pending.resolve(json({ id: 10 })); await first;
    expect(input().value).toBe(text); expect(composerReferences()).toEqual(refs);
  }
});

test('失效父身份不能悄悄回退，迟到结果不污染重新初始化的 composer 或抢回导航', async () => {
  type('不能错投'); dom.node('input-parent').value = 'missing'; ui.composerParents = []; syncComposer();
  await buffer(); expect(calls).toHaveLength(0); expect(input().value).toBe('不能错投');
  ui.composerParents = parents; dom.node('input-parent').value = ''; type('旧请求');
  const pending = deferred(); intercept = () => pending.promise; const first = buffer();
  resetUiState(); await initComposer(); type('新会话输入');
  pending.resolve(json({ id: 11 })); await first; expect(input().value).toBe('新会话输入');
  const late = deferred(); intercept = () => late.promise; ui.view = { id: 'overview' }; type('发送');
  const send = enter({ ctrlKey: true }); ui.view = { id: 'inputs' };
  late.resolve(json({ task: { id: 91 } })); await send; expect(opened).toBe(null);
});

test('父候选查询单飞，迟到旧初始化结果不可覆盖新候选', async () => {
  parentGate = deferred(); const before = parentReads;
  const first = loadComposerParents(), second = loadComposerParents();
  expect(parentReads).toBe(before + 1); expect(first).toBe(second);
  const old = parentGate; parentGate = null;
  resetUiState(); await initComposer();
  old.resolve(json({ items: [{ id: 99, branch: 'wrong', goal: '旧响应' }] })); await first;
  expect(ui.composerParents).toEqual(parents);
});

function openWorker(overrides = {}) {
  ui.selected = 126;
  activateDetailView({ view: 'task', key: 'task-126' });
  ui.composerTask = { id: 126, task_kind: 'order', status: 'running', branch: 'lush/126', ...overrides };
  syncComposer();
}

test('当前 Worker 追加键盘/按钮矩阵，隐藏暂存与父选择；返回列表恢复 main', async () => {
  openWorker();
  expect(input().placeholder).toContain('追加给 Worker #126');
  expect(dom.node('input-buffer').hidden).toBe(true);
  expect(dom.node('composer-expand').hidden).toBe(true);
  for (const keys of [{}, { ctrlKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }]) {
    type('追加要求'); await enter(keys);
    expect(calls.at(-1)).toEqual({ method: 'worker.message', params: { id: 126, body: '追加要求' } });
    expect(opened).toBe(126);
  }
  const count = calls.length; type('换行'); expect(await enter({ shiftKey: true })).toBe(false);
  expect(await enter({ isComposing: true })).toBe(false);
  expect(await enter({ repeat: true })).toBe(true);
  await buffer(); expect(calls).toHaveLength(count);
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(calls.at(-1).method).toBe('worker.message');
  type('保留未发送'); openResource('tasks');
  expect(input().value).toBe('保留未发送'); expect(input().disabled).toBe(false);
  expect(input().placeholder).toContain('在 main 下创建子 Worker');
  expect(dom.node('input-buffer').hidden).toBe(false);
  await enter({ ctrlKey: true }); expect(calls.at(-1).params.branch).toBe('main');
});

test('读取中/终态/只读/归档/冻结不改投 main；main 与 owner 创建自己的子 Worker', async () => {
  for (const overrides of [
    { status: 'completed' }, { status: 'failed' }, { status: 'cancelled' },
    { archived: true }, { task_kind: 'analysis' }, { freeze: {} }, { workspace_state: 'missing' },
  ]) {
    openWorker(overrides); type('不能错投'); await enter();
    expect(input().disabled).toBe(true); expect(input().placeholder).toContain('#126'); expect(calls).toHaveLength(0);
  }
  ui.composerTask = null; syncComposer(); expect(input().disabled).toBe(true);
  expect(input().placeholder).toContain('正在读取'); await enter(); expect(calls).toHaveLength(0);
  ui.composerError = 'Worker 读取失败；请重新打开详情。'; syncComposer();
  expect(input().placeholder).toContain('读取失败'); await enter(); expect(calls).toHaveLength(0);
  ui.composerError = null;
  for (const [task_kind, branch] of [['main', 'main'], ['owner', 'release']]) {
    openWorker({ task_kind, branch, status: 'waiting' }); type('新的独立工作'); await enter({ ctrlKey: true });
    expect(calls.at(-1)).toMatchObject({ method: 'order.submit', params: { branch, start: false } });
  }
  openWorker({ status: 'paused' }); expect(input().placeholder).toContain('需开始 / 继续');
  type('暂停追加'); await enter(); expect(calls.at(-1).method).toBe('worker.message');
});

test('追加单飞、失败重试、迟到导航和引用均保住正文，不静默丢附件', async () => {
  openWorker(); type('追加原文');
  const pending = deferred(); intercept = () => pending.promise;
  const first = enter(); await enter(); expect(calls).toHaveLength(1);
  pending.resolve({ ok: false, json: async () => ({ error: '追加失败' }) }); await first;
  expect(input().value).toBe('追加原文'); expect(dom.node('error').textContent).toContain('追加失败');
  intercept = null; setComposerReferences([ref('来源')]); await enter();
  expect(calls).toHaveLength(1); expect(composerReferences()).toHaveLength(1);
  expect(dom.node('error').textContent).toContain('暂不支持引用附件');
  setComposerReferences([]);
  const late = deferred(); intercept = () => late.promise; const send = enter();
  openResource('tasks'); type('新页面的文字'); opened = null;
  late.resolve(json({ id: 126 })); await send;
  expect(input().value).toBe('新页面的文字'); expect(opened).toBe(null);
  expect(input().placeholder).toContain('main');
});

test('暂存不标 Agent，发送保留标识与禁用宿主帮助', async () => {
  expect(dom.node('input-buffer').classList.contains('agent-call')).toBe(false);
  expect(dom.node('input-send-help').getAttribute('data-help')).toContain('token');
});
