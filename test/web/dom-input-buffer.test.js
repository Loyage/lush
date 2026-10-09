import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { until } from '../helpers.js';

const json = data => ({ ok: true, json: async () => data });
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
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
const { initComposer, buffer, syncComposer, loadComposerParents, appendToWorker, resetComposerMode } = await import('../../src/ui/web/assets/composer.js');
const { setComposerReferences, composerReferences } = await import('../../src/ui/web/assets/context-references.js');
const { resetUiState, ui } = await import('../../src/ui/web/assets/state.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { action } = await import('../../src/ui/web/assets/api.js');
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

test('创建、立即开始及预约发射都留在当前页面，不打开 Worker 或父 Worker', async () => {
  for (const mode of ['button', 'ctrl', 'meta', 'start', 'defer_create', 'defer_start']) {
    activateDetailView({ view: 'overview' }); input().focus(); opened = null;
    const view = ui.view, hash = dom.location.hash;
    ui.composerParents = mode.startsWith('defer')
      ? [{ id: 1, branch: 'main', freeze: { reason: '等待合并' } }] : parents;
    intercept = mode.startsWith('defer') ? () => json({ deferred: true, parent_id: 1 }) : null;
    type('发射但不跳转'); setComposerReferences([ref('来源')]);
    if (mode === 'button' || mode === 'defer_start') await dom.node('input-form').onsubmit({ preventDefault() {} });
    else await enter(mode === 'meta' ? { metaKey: true } : { ctrlKey: true, shiftKey: mode === 'start' });
    await Promise.resolve(); await Promise.resolve();
    expect(opened).toBeNull(); expect(ui.view).toBe(view); expect(dom.location.hash).toBe(hash);
    expect(input().value).toBe(''); expect(composerReferences()).toEqual([]);
    expect(document.activeElement).toBe(input()); expect(ui.composerSubmitting).toBe(false);
  }
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

test('创建/立即开始/暂存途中切页，成功清空未编辑正文和引用，但不抢回导航', async () => {
  for (const keys of [{ ctrlKey: true }, { ctrlKey: true, shiftKey: true }, { metaKey: true, shiftKey: true }, {}]) {
    activateDetailView({ view: 'overview' });
    type('已发送的原文'); setComposerReferences([ref('来源')]);
    const pending = deferred(); intercept = () => pending.promise;
    const send = enter(keys);
    openResource('tasks'); const view = ui.view;
    expect(input().value).toBe('已发送的原文');
    pending.resolve(json({ id: 9, task: { id: 90 } })); await send;
    expect(input().value).toBe(''); expect(composerReferences()).toEqual([]);
    expect(ui.view).toBe(view); expect(opened).toBeNull();
    expect(ui.composerSubmitting).toBe(false);
    expect(dom.node('draft-commit').disabled).toBe(true);
  }
});

test('创建成功后的状态刷新切页，不阻止清空已提交内容', async () => {
  activateDetailView({ view: 'overview' });
  const restore = registerNavigation({ refresh: async () => { openResource('tasks'); }, detail: async id => { opened = id; } });
  try {
    type('立即开始'); setComposerReferences([ref('来源')]);
    await enter({ ctrlKey: true, shiftKey: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'order.submit', params: { start: true } });
    expect(input().value).toBe(''); expect(composerReferences()).toEqual([]);
    expect(ui.view.id).toBe('tasks'); expect(opened).toBeNull();
  } finally { restore(); }
});

test('创建途中切页后新输入或修改再恢复的正文、引用仍保留', async () => {
  for (const change of [
    () => type('下一条新想法'),
    () => { type('修改'); type('原文'); },
    () => setComposerReferences([ref('来源'), ref('新引用')]),
  ]) {
    activateDetailView({ view: 'overview' });
    type('原文'); setComposerReferences([ref('来源')]);
    const pending = deferred(); intercept = () => pending.promise;
    const send = enter({ ctrlKey: true, shiftKey: true });
    openResource('tasks'); change();
    const text = input().value, refs = composerReferences();
    pending.resolve(json({ task: { id: 90 } })); await send;
    expect(input().value).toBe(text); expect(composerReferences()).toEqual(refs);
    expect(opened).toBeNull(); expect(ui.composerSubmitting).toBe(false);
  }
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

function openWorker(overrides = {}, append = true) {
  ui.selected = 126;
  activateDetailView({ view: 'task', key: 'task-126' });
  ui.composerTask = { id: 126, task_kind: 'order', status: 'running', branch: 'lush/126', ...overrides };
  if (append) appendToWorker(ui.composerTask);
  else { resetComposerMode(); syncComposer(); }
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

test('显式追加读取中/终态/只读/归档不改投 main；main 与 owner 详情默认新建独立 Worker', async () => {
  for (const overrides of [
    { status: 'completed' }, { status: 'failed' }, { status: 'cancelled' },
    { archived: true }, { task_kind: 'analysis' }, { task_kind: 'main' }, { task_kind: 'owner' }, { workspace_state: 'missing' },
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
    openWorker({ task_kind, branch, status: 'waiting' }, false); type('新的独立工作'); await enter({ ctrlKey: true });
    expect(calls.at(-1)).toMatchObject({ method: 'order.submit', params: { branch: 'main', start: false } });
  }
  openWorker({ status: 'paused' }); expect(input().placeholder).toContain('需开始 / 继续');
  type('暂停追加'); await enter(); expect(calls.at(-1).method).toBe('worker.message');
});

test('冻结期间允许追加，常驻模式条、影子文字、帮助与成功提示区分保存和投递', async () => {
  for (const status of ['requested', 'executing', 'resolving', 'blocked']) {
    openWorker({ worker_number: 'W153', status: 'waiting', reservation: { status }, input_queue: { buffered: 2, reason: '等待固定交付结束' } });
    type(`新需求 ${status}`);
    expect(input().disabled).toBe(false);
    expect(dom.node('draft-commit').disabled).toBe(false);
    expect(input().placeholder).toContain('Enter 保存，等待投递');
    expect(dom.node('composer-mode-behavior').textContent).toContain('已暂存 2 条');
    expect(dom.node('draft-commit').getAttribute('data-help')).toContain('不打断在途交付或源侧修复');
    expect(dom.node('draft-commit').classList.contains('agent-call')).toBe(true);
    intercept = () => json({ id: 126, input_queue: { buffered: 3, reason: '等待固定交付结束' } });
    await enter();
    expect(calls.at(-1)).toMatchObject({ method: 'worker.message', params: { id: 126, body: `新需求 ${status}` } });
    expect(dom.node('error').textContent).toContain('已保存给 Worker W153，等待投递');
    expect(input().value).toBe('');
    expect(dom.node('composer-mode-behavior').textContent).toContain('已暂存 3 条');
    expect(dom.node('input-form').dataset.mode).toBe('append');
  }
  openWorker({ freeze: { reason: '兄弟 Worker 合并占用父分支' } }); type('普通分支冻结');
  expect(input().disabled).toBe(false); expect(input().placeholder).toContain('兄弟 Worker 合并');
  intercept = () => json({ id: 126 }); await enter();
  expect(dom.node('error').textContent).toContain('投递状态暂不可用');
  expect(dom.node('error').textContent).not.toContain('已投递');
  ui.composerTask = { ...ui.composerTask, freeze: null, input_queue: { buffered: 0, reason: null } }; syncComposer();
  expect(dom.node('input-form').dataset.mode).toBe('append'); expect(input().placeholder).toContain('Enter 发送');
});

test('冻结追加的慢确认保留新正文、修改再恢复的正文和新引用，拒收不清空输入', async () => {
  for (const change of [() => type('下一条需求'), () => { type('修改'); type('冻结需求'); }, () => setComposerReferences([ref('新引用')])]) {
    setComposerReferences([]); openWorker({ reservation: { status: 'resolving' } }); type('冻结需求');
    const pending = deferred(); intercept = () => pending.promise; const send = enter();
    change(); const value = input().value, refs = composerReferences();
    pending.resolve(json({ id: 126, input_queue: { buffered: 1, reason: '等待修复结束' } })); await send;
    expect(input().value).toBe(value); expect(composerReferences()).toEqual(refs);
  }
  setComposerReferences([]); openWorker({ freeze: {} }); type('不要丢');
  intercept = () => ({ ok: false, json: async () => ({ error: '祖先 Worker 已结束' }) }); await enter();
  expect(input().value).toBe('不要丢'); expect(dom.node('input-form').dataset.mode).toBe('append');
  expect(dom.node('error').textContent).toContain('祖先 Worker 已结束');
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

test('常驻模式条在打字、导航、父选择及阻塞状态下准确区分新建与追加', () => {
  const form = dom.node('input-form'), title = dom.node('composer-mode-title');
  const target = dom.node('composer-mode-target'), behavior = dom.node('composer-mode-behavior');
  expect(form.dataset.mode).toBe('create');
  expect(title.textContent).toBe('新建独立 Worker');
  expect(target.textContent).toBe('父 Worker：main');
  expect(behavior.textContent).toContain('Enter 暂存');
  expect(behavior.textContent).toContain('待开始');
  expect(dom.node('draft-commit').textContent).toBe('创建 Worker');
  dom.node('input-parent').value = 'feature/old-parent'; type('有文字也要看得见');
  expect(target.textContent).toContain('#800');
  expect(title.hidden).toBe(false);

  openWorker({ goal: '修复当前问题' });
  expect(form.dataset.mode).toBe('append');
  expect(dom.node('composer-mode-icon').textContent).toBe('↳');
  expect(title.textContent).toBe('继续当前 Worker');
  expect(target.textContent).toContain('Worker #126');
  expect(target.textContent).toContain('修复当前问题');
  expect(behavior.textContent).toBe('不创建新 Worker · Enter 追加 · 空白时 Esc 返回');
  expect(dom.node('draft-commit').textContent).toBe('追加输入');
  type('追加文字'); expect(target.textContent).toContain('#126');
  openWorker({ status: 'paused' }); expect(behavior.textContent).toContain('需开始 / 继续');
  openWorker({ status: 'completed' });
  expect(form.dataset.blocked).toBe('true');
  expect(behavior.textContent).toContain('已完成');
  expect(target.textContent).toContain('#126');
  expect(input().value).toBe('追加文字');
  ui.composerTask = null; syncComposer(); expect(behavior.textContent).toContain('正在读取');

  openWorker({ task_kind: 'owner', branch: 'release', status: 'waiting' }, false);
  expect(form.dataset.mode).toBe('create');
  expect(target.textContent).toContain('#800');
  expect(behavior.textContent).toContain('Enter 暂存');
  openResource('tasks');
  expect(form.dataset.mode).toBe('create');
  expect(form.dataset.blocked).toBe('false');
  expect(title.textContent).toBe('新建独立 Worker');
  expect(dom.node('composer-mode-icon').textContent).toBe('＋');
  // Returning to new-work mode retains the explicitly chosen parent, not the inbox/owner target.
  expect(target.textContent).toContain('#800');
});

test('打开详情仍默认新建；显式追加与返回按钮保留文字、引用及所选父 Worker', async () => {
  dom.node('input-parent').value = 'feature/old-parent';
  type('已有草稿'); setComposerReferences([ref('来源')]);
  openWorker({ worker_number: 'W123' }, false);
  expect(dom.node('input-form').dataset.mode).toBe('create');
  expect(dom.node('input-buffer').hidden).toBe(false);
  expect(dom.node('composer-expand').hidden).toBe(false);
  appendToWorker(ui.composerTask);
  expect(dom.node('composer-mode-target').textContent).toContain('W123');
  expect(dom.node('composer-reset').hidden).toBe(false);
  expect(input().value).toBe('已有草稿'); expect(composerReferences()).toHaveLength(1);
  dom.node('composer-reset').onclick();
  expect(dom.node('input-form').dataset.mode).toBe('create');
  expect(dom.node('composer-reset').hidden).toBe(true);
  expect(dom.node('input-parent').value).toBe('feature/old-parent');
  expect(input().value).toBe('已有草稿'); expect(composerReferences()).toHaveLength(1);
  await enter({ ctrlKey: true });
  expect(calls.at(-1)).toMatchObject({ method: 'order.submit', params: { branch: 'feature/old-parent' } });
});

test('Esc 仅在追加模式空白且没有引用时返回；IME 确认、不空白与重复按键不切换', async () => {
  const escape = options => input().onkeydown({ key: 'Escape', preventDefault() {}, ...options });
  openWorker(); type('草稿'); escape(); expect(dom.node('input-form').dataset.mode).toBe('append');
  type('  \n '); setComposerReferences([ref('来源')]); escape(); expect(dom.node('input-form').dataset.mode).toBe('append');
  setComposerReferences([]);
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
    escape(options); expect(dom.node('input-form').dataset.mode).toBe('append');
  }
  input().oncompositionstart(); escape(); expect(dom.node('input-form').dataset.mode).toBe('append'); input().oncompositionend();
  escape(); expect(dom.node('input-form').dataset.mode).toBe('create');
  expect(calls).toHaveLength(0);
});

test('同页在发送途中退出追加模式，迟到成功不清空草稿或重新打开追加目标', async () => {
  openWorker(); type('原文'); const pending = deferred(); intercept = () => pending.promise;
  const send = enter(); resetComposerMode();
  pending.resolve(json({ id: 126 })); await send;
  expect(input().value).toBe('原文'); expect(opened).toBeNull();
  expect(dom.node('input-form').dataset.mode).toBe('create');
});

test('默认模式不受详情加载、失败、终态、只读或归档阻塞；追加刷新仍保留模式', () => {
  for (const overrides of [{ status: 'completed' }, { task_kind: 'analysis' }, { archived: true }, { freeze: {} }]) {
    openWorker(overrides, false); expect(input().disabled).toBe(false);
  }
  ui.composerTask = null; ui.composerError = '读取失败'; syncComposer(); expect(input().disabled).toBe(false);
  openWorker(); syncComposer(); expect(dom.node('input-form').dataset.mode).toBe('append');
  openResource('tasks'); openWorker({}, false); expect(dom.node('input-form').dataset.mode).toBe('create');
});

test('action 默认仍等待刷新，内部 refresh:false 仅等待服务端确认', async () => {
  const gate = deferred(); let refreshes = 0, settled = false;
  const restore = registerNavigation({ refresh: () => { refreshes++; return gate.promise; }, detail: async () => {} });
  try {
    const pending = action('draft.add', { content: '兼容默认' }).then(() => { settled = true; });
    await until(() => refreshes === 1);
    expect(settled).toBe(false);
    await action('draft.add', { content: '仅确认' }, { refresh: false });
    expect(refreshes).toBe(1); expect(settled).toBe(false);
    gate.resolve(); await pending; expect(settled).toBe(true);
    expect(calls[1]).toEqual({ method: 'draft.add', params: { content: '仅确认' } });
  } finally { gate.resolve(); restore(); }
});

test('慢 overview 不阻塞创建、开始、暂存、追加或预约的确认和下一条提交；每条只刷一次', async () => {
  for (const mode of ['create', 'start', 'buffer', 'append', 'defer']) {
    const gate = deferred(); let refreshes = 0;
    const restore = registerNavigation({ refresh: () => { refreshes++; return gate.promise; }, detail: async id => { opened = id; } });
    try {
      activateDetailView({ view: 'overview' }); opened = null;
      const profile = { agent: 'pi', config_mode: 'pi' }; ui.composerProfile = profile;
      if (mode === 'append') openWorker();
      if (mode === 'defer') {
        ui.composerParents = [{ id: 1, branch: 'main', freeze: { reason: '等待合并' } }];
        intercept = () => json({ deferred: true, parent_id: 1 });
      } else intercept = null;
      type('第一条'); if (mode !== 'append') setComposerReferences([ref('第一条来源')]);
      input().focus();
      const send = () => mode === 'buffer' ? buffer() : mode === 'start' ? enter({ ctrlKey: true, shiftKey: true }) : dom.node('input-form').onsubmit({ preventDefault() {} });
      let acknowledged = false; const first = send().then(() => { acknowledged = true; });
      await until(() => refreshes === 1);
      expect(acknowledged).toBe(true); expect(ui.composerSubmitting).toBe(false);
      expect(input().value).toBe(''); expect(composerReferences()).toEqual([]);
      expect(ui.composerProfile).toBe(['buffer', 'append'].includes(mode) ? profile : null);
      type('第二条'); expect(dom.node('draft-commit').disabled).toBe(false);
      await send(); expect(calls.at(-1).params.content ?? calls.at(-1).params.body).toBe('第二条');
      expect(refreshes).toBe(2); expect(ui.composerSubmitting).toBe(false);
      type('第三条正在写'); if (mode !== 'append') setComposerReferences([ref('第三条来源')]);
      const view = ui.view;
      gate.resolve(); await first; await Promise.resolve(); await Promise.resolve();
      expect(opened).toBeNull(); expect(ui.view).toBe(view);
      expect(input().value).toBe('第三条正在写'); expect(document.activeElement).toBe(input());
      expect(composerReferences()).toEqual(mode === 'append' ? [] : [ref('第三条来源')]);
    } finally {
      gate.resolve(); await Promise.resolve(); restore();
      setComposerReferences([]); resetComposerMode(); ui.composerParents = parents; intercept = null;
    }
  }
});

test('追加后的慢详情不占用提交锁，切回新建后下一条仍可暂存且迟到完成不触碰焦点', async () => {
  const gate = deferred(); let detailReads = 0, detailFinished = false;
  const restore = registerNavigation({ refresh: async () => {}, detail: async id => {
    opened = id; detailReads++; await gate.promise; detailFinished = true;
  } });
  try {
    openWorker(); type('先追加'); input().focus();
    await enter(); await until(() => detailReads === 1);
    expect(detailFinished).toBe(false); expect(ui.composerSubmitting).toBe(false); expect(input().value).toBe('');
    resetComposerMode(); type('详情读取中下一条'); setComposerReferences([ref('新来源')]);
    expect(dom.node('input-buffer').disabled).toBe(false);
    await buffer(); expect(calls).toHaveLength(2); expect(input().value).toBe('');
    type('继续编辑'); setComposerReferences([ref('继续来源')]);
    gate.resolve(); await until(() => detailFinished);
    expect(input().value).toBe('继续编辑'); expect(composerReferences()).toEqual([ref('继续来源')]);
    expect(document.activeElement).toBe(input()); expect(detailReads).toBe(1);
  } finally { gate.resolve(); restore(); }
});

test('后台页面更新失败独立提示提交已成功，不恢复已消费输入、引用或配置', async () => {
  for (const failAt of ['overview', 'detail', 'offline']) {
    const restore = registerNavigation({ refresh: async () => {
      if (failAt === 'overview') throw new Error('overview 不可用');
      if (failAt === 'offline') ui.offline = true;
    }, detail: async () => { throw new Error('detail 不可用'); } });
    try {
      ui.offline = false; activateDetailView({ view: 'overview' });
      if (failAt === 'detail') { openWorker(); type('已确认'); await enter(); }
      else {
        type('已确认'); setComposerReferences([ref('来源')]); ui.composerProfile = { config_mode: 'pi' };
        await enter({ ctrlKey: true });
      }
      await until(() => dom.node('error').textContent.includes('页面更新失败'));
      expect(dom.node('error').textContent).toContain('提交已成功');
      expect(dom.node('error').textContent).toContain('不要重复提交');
      expect(input().value).toBe(''); expect(composerReferences()).toEqual([]); expect(ui.composerProfile).toBeNull();
      expect(ui.composerSubmitting).toBe(false); expect(calls.at(-1).method).toBe(failAt === 'detail' ? 'worker.message' : 'order.submit');
    } finally { ui.offline = false; restore(); }
  }
});

test('旧后台更新失败不覆盖第二条成功，切页或修改再撤销不触发旧导航', async () => {
  for (const change of [() => { type('修改'); type(''); }, () => openResource('tasks'), () => setComposerReferences([ref('下一条引用')])]) {
    const gate = deferred(); let refreshes = 0;
    const restore = registerNavigation({ refresh: () => { refreshes++; return refreshes === 1 ? gate.promise : Promise.resolve(); }, detail: async id => { opened = id; } });
    try {
      activateDetailView({ view: 'overview' }); type('第一条'); opened = null;
      await enter({ ctrlKey: true }); change(); const view = ui.view;
      gate.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(opened).toBeNull(); expect(ui.view).toBe(view);
    } finally { gate.resolve(); setComposerReferences([]); restore(); }
  }
  const gate = deferred(); let refreshes = 0;
  const restore = registerNavigation({ refresh: () => ++refreshes === 1 ? gate.promise : Promise.resolve(), detail: async () => {} });
  try {
    activateDetailView({ view: 'overview' }); type('第一条'); await enter({ ctrlKey: true });
    type('第二条'); await buffer(); const message = dom.node('error').textContent;
    gate.reject(new Error('第一条迟到错误')); await Promise.resolve(); await Promise.resolve();
    expect(dom.node('error').textContent).toBe(message); expect(message).toContain('已暂存');
  } finally { restore(); }
});

test('刷新已更新同一个 Worker 详情时不重复读取，提交失败不启动后台更新', async () => {
  let refreshes = 0, details = 0;
  const restore = registerNavigation({ refresh: async () => {
    refreshes++; ui.detailTask = 126; ui.composerTask = { ...ui.composerTask };
  }, detail: async () => { details++; } });
  try {
    openWorker(); type('追加'); await enter(); await Promise.resolve();
    expect(refreshes).toBe(1); expect(details).toBe(0);
    resetComposerMode(); ui.composerProfile = { config_mode: 'pi' }; type('失败原文'); setComposerReferences([ref('来源')]);
    intercept = () => ({ ok: false, json: async () => ({ error: '服务端拒绝提交' }) });
    await enter({ ctrlKey: true });
    expect(refreshes).toBe(1); expect(details).toBe(0);
    expect(dom.node('error').textContent).toBe('服务端拒绝提交'); expect(input().value).toBe('失败原文');
    expect(composerReferences()).toEqual([ref('来源')]); expect(ui.composerProfile).toEqual({ config_mode: 'pi' });
    expect(ui.composerSubmitting).toBe(false); expect(dom.node('draft-commit').disabled).toBe(false);
  } finally { restore(); }
});

test('创建确认仅消费提交时配置，提交中重新选择的配置和编辑中的下一条保留', async () => {
  const gate = deferred(); intercept = () => gate.promise;
  const submitted = { config_mode: 'pi' }, next = { config_mode: 'lush', model: 'next/model' };
  ui.composerProfile = submitted; type('第一条'); setComposerReferences([ref('第一条')]);
  const send = enter({ ctrlKey: true });
  type('第二条'); setComposerReferences([ref('第二条')]); ui.composerProfile = next;
  gate.resolve(json({ task: { id: 90 } })); await send;
  expect(calls[0].params.profile).toEqual(submitted); expect(ui.composerProfile).toBe(next);
  expect(input().value).toBe('第二条'); expect(composerReferences()).toEqual([ref('第二条')]); expect(opened).toBeNull();
});

test('暂存不标 Agent，发送保留标识与禁用宿主帮助', async () => {
  expect(dom.node('input-buffer').classList.contains('agent-call')).toBe(false);
  expect(dom.node('input-send-help').getAttribute('data-help')).toContain('token');
});
