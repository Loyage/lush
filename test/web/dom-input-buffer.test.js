import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, dialogButton, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { editorEvent, editorInput } from './text-editor-events.js';

const json = data => ({ ok: true, json: async () => data });
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const calls = []; let intercept = null, opened = null, parentGate = null;
const parents = [{ id: 1, branch: 'main', goal: 'main' }, { id: 800, worker_number: 'W88', branch: 'feature/old-parent', goal: '完整列表中的旧父 Worker' }];
const dom = installDom({ fetch: async (url, options = {}) => {
  if (String(url).endsWith('/api/input-parents')) return parentGate?.promise ?? json({ items: parents });
  if (String(url).includes('/api/workers?')) return json({ tasks: [{ id: 700, worker_number: 'W123', goal: '重构面板', status: 'running' }], has_more: false });
  if (String(url).endsWith('/api/action')) {
    const body = JSON.parse(options.body); calls.push(body);
    return intercept?.(body) ?? json(body.method === 'draft.add' ? { id: 9 } : body.method === 'management.submit'
      ? { management: true, task: { id: 901, role: 'manager', task_kind: 'management' } }
      : { emitted: true, draft_id: 9, dispatch: { state: body.params.conditions?.length ? 'waiting_conditions' : 'queued' } });
  }
  throw new Error(`Unexpected ${url}`);
} });
const { initComposer, buffer, syncComposer, loadComposerParents, appendToWorker, resetComposerMode, conditionallyEmit, toggleComposerDetails } = await import('../../src/ui/web/assets/composer.js');
const { setComposerReferences, composerReferences } = await import('../../src/ui/web/assets/context-references.js');
const { resetUiState, ui } = await import('../../src/ui/web/assets/state.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const restoreNav = registerNavigation({ refresh: async () => {}, detail: async id => { opened = id; } });
const input = () => dom.node('input');
const type = value => { input().value = value; input().oninput(); };
const enter = async (options = {}) => { let prevented = false; await input().onkeydown({ key: 'Enter', preventDefault() { prevented = true; }, ...options }); return prevented; };
const ref = label => ({ version: 1, kind: 'text', target: {}, label, quote: '引用快照', location: {}, captured_at: '2026-10-01T00:00:00Z' });
const append = () => { const task = { id: 126, worker_number: 'W15', status: 'running', task_kind: 'order', branch: 'lush/126', workspace: '/tmp/126' }; ui.view = { id: 'task' }; ui.selected = task.id; appendToWorker(task); return task; };
const btn = label => dom.node('modal').querySelectorAll('button').find(node => node.textContent === label);
const management = () => dom.node('composer-shell').querySelector('.composer-management').onclick();
beforeEach(async () => {
  resetUiState(); calls.length = 0; intercept = null; opened = null; parentGate = null;
  input().value = ''; dom.node('input-parent').value = ''; delete dom.node('input-parent').dataset.signature;
  await initComposer();
});
afterAll(() => { restoreNav(); dom.restore(); });

test('新建与追加统一 Enter 暂存、Ctrl/Meta Enter 发射；Shift/IME/触屏回车换行', async () => {
  for (const appendMode of [false, true]) {
    if (appendMode) append();
    for (const options of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { altKey: true }]) {
      type('中文输入'); expect(await enter(options)).toBe(false); expect(calls).toHaveLength(0);
    }
    type('中文输入'); input().oncompositionstart(); expect(await enter()).toBe(false); input().oncompositionend();
    expect(await enter({ repeat: true })).toBe(true); expect(calls).toHaveLength(0);
    await enter(); expect(calls.at(-1).method).toBe('draft.add');
    if (appendMode) expect(calls.at(-1).params).toMatchObject({ mode: 'append', target_id: 126 });
    calls.length = 0; if (appendMode) append();
    type('明确发射'); await enter({ metaKey: true }); expect(calls[0].method).toBe('input.emit');
    expect(calls[0].params).not.toHaveProperty('start'); expect(calls[0].params.client_request_id).toBeTruthy();
    if (appendMode) expect(calls[0].params).toMatchObject({ mode: 'append', target_id: 126 });
    expect(ui.composerAppendTarget).toBeNull(); expect(input().value).toBe(''); calls.length = 0;
  }
});

test('暂存保存父分支与引用，父候选来自独立读面而非 overview', async () => {
  ui.lastSnapshot = { tasks: [] }; syncComposer();
  expect(dom.node('input-parent').children.some(node => node.value === 'feature/old-parent')).toBe(true);
  dom.node('input-parent').value = 'feature/old-parent'; type('稍后再做'); setComposerReferences([ref('来源')]); await buffer();
  expect(calls[0]).toMatchObject({ method: 'draft.add', params: { content: '稍后再做', branch: 'feature/old-parent', references: [ref('来源')] } });
  expect(input().value).toBe(''); expect(composerReferences()).toEqual([]); expect(opened).toBeNull();
});

test('冻结主分支仍能可靠发射；ACK 不宣称已创建、不跳转', async () => {
  activateDetailView({ view: 'overview' }); const view = ui.view; input().focus();
  ui.composerParents = [{ ...parents[0], freeze: { reason: '固定交付中' } }]; type('冻结期间的需求');
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(calls[0].method).toBe('input.emit'); expect(calls[0].params).not.toHaveProperty('defer');
  expect(dom.node('error').textContent).toContain('已可靠挂载'); expect(dom.node('error').textContent).toContain('尚不代表 Worker 已创建');
  expect(ui.view).toBe(view); expect(opened).toBeNull(); expect(document.activeElement).toBe(input());
});

test('追加也显示暂存与条件入口，冻结等待原因保留，确认后回到新建', async () => {
  const task = append(); ui.composerTask = { ...task, reservation: { status: 'resolving' }, input_queue: { buffered: 2, reason: '等待修复' } }; type('追加要求');
  expect(dom.node('input-buffer').hidden).toBe(false); expect(dom.node('input-start').hidden).toBe(false);
  expect(dom.node('composer-mode-behavior').textContent).toContain('已暂存 2 条');
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(calls[0]).toMatchObject({ method: 'input.emit', params: { mode: 'append', target_id: 126, content: '追加要求' } });
  expect(dom.node('error').textContent).toContain('尚不代表 Agent 已收到'); expect(ui.composerAppendTarget).toBeNull();
});

test('终态或缺失追加目标禁用而不改投 main；失效父身份保留并拒绝发射', async () => {
  const task = append(); ui.composerTask = { ...task, status: 'cancelled' }; type('不能改投');
  await dom.node('input-form').onsubmit({ preventDefault() {} }); expect(calls).toHaveLength(0); expect(input().value).toBe('不能改投');
  expect(ui.composerAppendTarget.id).toBe(126); expect(dom.node('draft-commit').disabled).toBe(true);
  resetComposerMode(); dom.node('input-parent').value = 'gone'; syncComposer();
  await dom.node('input-form').onsubmit({ preventDefault() {} }); expect(calls).toHaveLength(0); expect(input().value).toBe('不能改投');
});

test('暂存/发射共享单飞，失败保留全部内容；同定义重试使用原去重身份', async () => {
  type('不能丢'); setComposerReferences([ref('引用')]); const pending = deferred(); intercept = () => pending.promise;
  const sending = dom.node('input-form').onsubmit({ preventDefault() {} }); await until(() => calls.length === 1);
  await buffer(); await enter({ ctrlKey: true }); expect(calls).toHaveLength(1); expect(dom.node('input-buffer').disabled).toBe(true);
  const requestId = calls[0].params.client_request_id;
  pending.resolve({ ok: false, json: async () => ({ error: '断连' }) }); await sending;
  expect(input().value).toBe('不能丢'); expect(composerReferences()).toEqual([ref('引用')]);
  intercept = null; await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(calls[1].params.client_request_id).toBe(requestId); expect(input().value).toBe('');
  type('同样的下一条'); await enter({ ctrlKey: true }); expect(calls[2].params.client_request_id).not.toBe(requestId);
});

test('在途编辑、引用改变和目标切换不被旧确认清空或退出追加模式', async () => {
  for (const change of ['body','reference','target']) {
    append(); type('旧输入'); const pending = deferred(); intercept = () => pending.promise;
    const sending = dom.node('input-form').onsubmit({ preventDefault() {} });
    if (change === 'body') type('新文字');
    if (change === 'reference') setComposerReferences([ref('新引用')]);
    if (change === 'target') resetComposerMode();
    pending.resolve(json({ emitted: true, draft_id: 9, dispatch: { state: 'queued' } })); await sending;
    expect(input().value).toBe(change === 'body' ? '新文字' : '旧输入');
    if (change !== 'target') expect(ui.composerAppendTarget).toEqual({ id: 126 });
    if (change === 'reference') expect(composerReferences()).toEqual([ref('新引用')]);
    setComposerReferences([]); intercept = null;
  }
});

test('已确认发射立即解锁，不等慢页面刷新；迟到刷新不能抢下一条输入', async () => {
  const pending = deferred(); let reads = 0;
  const restore = registerNavigation({ refresh: () => { reads++; return pending.promise; } });
  try {
    type('第一条'); await dom.node('input-form').onsubmit({ preventDefault() {} });
    expect(ui.composerSubmitting).toBe(false); expect(input().value).toBe(''); expect(reads).toBe(1);
    type('第二条'); await buffer(); type('第三条'); const view = ui.view; pending.resolve(); await Promise.resolve();
    expect(input().value).toBe('第三条'); expect(ui.view).toBe(view); expect(opened).toBeNull();
  } finally { restore(); pending.resolve(); }
});

test('追加引用暂不支持时明确拒绝，不消费正文附件或改变去向', async () => {
  append(); type('带引用追加'); setComposerReferences([ref('附件')]); await buffer();
  expect(calls).toHaveLength(0); expect(input().value).toBe('带引用追加'); expect(composerReferences()).toEqual([ref('附件')]);
  expect(ui.composerAppendTarget).toEqual({ id: 126 }); expect(dom.node('error').textContent).toContain('暂不支持引用');
});

test('条件发射允许多个 Worker/静息/独占，全部条件才发射且有费用标识', async () => {
  type('等面板重构'); const sending = conditionallyEmit(); const root = dom.node('modal');
  await btn('加载 Worker').onclick(); const select = root.querySelector('[aria-label="条件 Worker"]'); select.value = '700';
  await btn('添加 Worker 条件').onclick();
  const kind = root.querySelector('[aria-label="等待事件"]'); kind.value = 'worker_settled'; await btn('添加 Worker 条件').onclick();
  root.querySelector('[aria-label="等待目标树彻底静息后发射"]').checked = true;
  root.querySelector('[aria-label="独占开发：静息后开始，直到本轮交付收口"]').checked = true;
  expect(deepText(root)).toContain('W123'); expect(dialogButton(dom, '条件发射').classList.contains('agent-call')).toBe(true);
  expect(dialogButton(dom, '条件发射').getAttribute('data-help')).toContain('token');
  await dialogButton(dom, '条件发射').onclick(); await sending;
  expect(calls[0].params.conditions).toEqual([{ kind: 'worker_merged', worker_id: 700 }, { kind: 'worker_settled', worker_id: 700 }, { kind: 'parent_quiet' }]);
  expect(calls[0].params.exclusive).toBe(true); expect(dom.node('error').textContent).toContain('等待全部条件');
});

test('追加条件对话框没有独占；取消与离页迟到确认不发射', async () => {
  append(); type('追加等待'); const cancelled = conditionallyEmit();
  expect(dom.node('modal').querySelector('[aria-label="独占开发：静息后开始，直到本轮交付收口"]')).toBeNull();
  await dialogButton(dom, '取消').onclick(); await cancelled; expect(calls).toHaveLength(0); expect(input().value).toBe('追加等待');
  const stale = conditionallyEmit(); ui.view = { id: 'overview' };
  await dialogButton(dom, '条件发射').onclick(); await stale; expect(calls).toHaveLength(0);
});

test('管理是独立输入模式：不创建开发 Worker，危险操作确认，不丢失切换正文', async () => {
  type('诊断开发流程'); await management(); expect(input().value).toBe('诊断开发流程');
  expect(dom.node('input-form').dataset.mode).toBe('management'); expect(dom.node('input-buffer').hidden).toBe(true);
  expect(dom.node('composer-mode-behavior').textContent).toContain('危险操作先确认');
  expect(await enter()).toBe(false); await enter({ ctrlKey: true });
  expect(calls[0]).toMatchObject({ method: 'management.submit', params: { instruction: '诊断开发流程' } });
  expect(calls[0].params).not.toHaveProperty('profile'); expect(calls[0].params).not.toHaveProperty('references');
  expect(dom.node('error').textContent).toContain('未创建开发 Worker');
  await dom.node('composer-shell').querySelector('.composer-management-result').onclick(); expect(opened).toBe(901);
});

test('管理失败及在途切回开发不会消费编辑；重试身份保持，不传开发 profile', async () => {
  type('管理需求'); ui.composerProfile = { env: { SECRET: 'secret' } }; await management();
  const pending = deferred(); intercept = () => pending.promise;
  const sending = dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(calls[0].params).not.toHaveProperty('profile'); await management();
  pending.resolve(json({ management: true, task: { id: 901 } })); await sending; expect(input().value).toBe('管理需求');
  expect(dom.node('input-form').dataset.mode).toBe('create');
});

test('新发射和条件入口都有 Agent 标识及禁用外宿主，暂存/模式切换不调用 Agent', async () => {
  syncComposer();
  for (const [id, host] of [['draft-commit','input-send-help'], ['input-start','input-start-help']]) {
    expect(dom.node(id).classList.contains('agent-call')).toBe(true); expect(dom.node(id).getAttribute('data-help')).toContain('token');
    expect(dom.node(host).getAttribute('data-help')).toContain('token'); expect(dom.node(id).disabled).toBe(true);
  }
  expect(dom.node('input-buffer').classList.contains('agent-call')).toBe(false);
  expect(dom.node('composer-shell').querySelector('.composer-management').classList.contains('agent-call')).toBe(false);
});

test('共享正文撤销历史跨展开/收起与失败保留，成功消费后重置', async () => {
  editorInput(input(), '可撤销的输入'); editorEvent(input(), 'keydown', { key: 'z', ctrlKey: true }); expect(input().value).toBe('');
  editorEvent(input(), 'keydown', { key: 'z', ctrlKey: true, shiftKey: true }); expect(input().value).toBe('可撤销的输入');
  await toggleComposerDetails(); await toggleComposerDetails();
  intercept = () => Promise.reject(new Error('发射失败')); await enter({ ctrlKey: true });
  editorEvent(input(), 'keydown', { key: 'z', ctrlKey: true }); expect(input().value).toBe('');
  editorEvent(input(), 'keydown', { key: 'z', ctrlKey: true, shiftKey: true }); intercept = null; await enter({ ctrlKey: true });
  editorEvent(input(), 'keydown', { key: 'z', ctrlKey: true }); expect(input().value).toBe('');
});

test('触屏普通回车在新建与追加均换行，可见发射继续共用准入通道', async () => {
  const previous = window.matchMedia; window.matchMedia = query => ({ matches: query === '(pointer: coarse)' });
  try {
    for (const appendMode of [false, true]) {
      if (appendMode) append(); type('触屏正文'); expect(await enter()).toBe(false);
      expect(calls).toHaveLength(appendMode ? 1 : 0);
      await dom.node('input-form').onsubmit({ preventDefault() {} }); expect(calls.at(-1).method).toBe('input.emit');
    }
  } finally { window.matchMedia = previous; }
});

test('编辑后撤销到同一正文也算在途编辑，旧ACK不能消费这一条', async () => {
  editorInput(input(), '第一条'); const pending = deferred(); intercept = () => pending.promise;
  const sending = dom.node('input-form').onsubmit({ preventDefault() {} });
  editorInput(input(), '第二条'); editorEvent(input(), 'keydown', { key: 'z', ctrlKey: true }); expect(input().value).toBe('第一条');
  pending.resolve(json({ emitted: true, draft_id: 9, dispatch: { state: 'queued' } })); await sending;
  expect(input().value).toBe('第一条');
});

test('缺少可靠发射收据时保留原文，不凭旧task响应声称成功', async () => {
  type('版本不兼容的需求'); intercept = () => json({ task: { id: 90 } });
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(input().value).toBe('版本不兼容的需求'); expect(dom.node('error').textContent).toContain('缺少可靠挂载收据');
  expect(ui.composerSubmitting).toBe(false); expect(calls).toHaveLength(1);
});

test('新建/暂存在途切页确认清空未编辑正文，但不抢回导航或焦点', async () => {
  for (const mode of ['emit','buffer']) {
    type('跨页已发送'); setComposerReferences([ref('引用')]); const pending = deferred(); intercept = () => pending.promise;
    const sending = mode === 'buffer' ? buffer() : dom.node('input-form').onsubmit({ preventDefault() {} });
    const view = activateDetailView({ view: 'versions' });
    pending.resolve(json(mode === 'buffer' ? { id: 9 } : { emitted: true, draft_id: 9, dispatch: { state: 'queued' } })); await sending;
    expect(input().value).toBe(''); expect(composerReferences()).toEqual([]); expect(ui.view).toBe(view); expect(opened).toBeNull();
  }
});

test('跨页的新正文或新引用不因旧确认清空，重新初始化也不能接收旧结果', async () => {
  type('旧正文'); const pending = deferred(); intercept = () => pending.promise;
  const sending = dom.node('input-form').onsubmit({ preventDefault() {} }); activateDetailView({ view: 'versions' });
  type('新正文'); setComposerReferences([ref('新引用')]); pending.resolve(json({ emitted: true, draft_id: 9 })); await sending;
  expect(input().value).toBe('新正文'); expect(composerReferences()).toEqual([ref('新引用')]);
  const next = deferred(); intercept = () => next.promise; setComposerReferences([]); type('又一条');
  const oldSend = dom.node('input-form').onsubmit({ preventDefault() {} }); resetUiState(); input().value = '重新装配的正文'; await initComposer();
  next.resolve(json({ emitted: true, draft_id: 9 })); await oldSend; expect(input().value).toBe('重新装配的正文'); expect(ui.composerSubmitting).toBe(false);
});

test('显式选择同一或不同追加目标也使旧确认失效，不恢复旧去向', async () => {
  for (const id of [126, 127]) {
    append(); type('旧追加'); const pending = deferred(); intercept = () => pending.promise;
    const sending = dom.node('input-form').onsubmit({ preventDefault() {} }); ui.selected = id;
    appendToWorker({ id, worker_number: 'W16', task_kind: 'order', status: 'waiting', branch: `lush/${id}` });
    pending.resolve(json({ emitted: true, draft_id: 9 })); await sending;
    expect(input().value).toBe('旧追加'); expect(ui.composerAppendTarget.id).toBe(id);
  }
});

test('追加ACK不改变显式父选择或下一条运行设置，随后Enter只暂存', async () => {
  dom.node('input-parent').value = 'feature/old-parent'; ui.composerProfile = { agent: 'pi', config_mode: 'pi' };
  append(); type('这一条追加'); await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(ui.composerAppendTarget).toBeNull(); expect(dom.node('input-parent').value).toBe('feature/old-parent');
  expect(ui.composerProfile).toEqual({ agent: 'pi', config_mode: 'pi' });
  type('下一条新建'); await enter(); expect(calls.at(-1)).toMatchObject({ method: 'draft.add', params: { branch: 'feature/old-parent' } });
});

test('默认新建不继承详情终态/只读/失败阻塞；main和owner不能追加', async () => {
  for (const task_kind of ['main','owner','analysis','management','order']) for (const status of ['failed','cancelled','completed']) {
    resetComposerMode(); ui.view = { id: 'task' }; ui.selected = 126;
    ui.composerTask = { id: 126, task_kind, status, branch: 'gone', archived: true }; ui.composerError = '详情读取失败'; syncComposer();
    expect(input().disabled).toBe(false); expect(dom.node('input-form').dataset.mode).toBe('create');
  }
  for (const task_kind of ['main','owner','analysis','management']) {
    appendToWorker({ id: 126, task_kind, status: 'waiting', branch: 'main' }); type('不能追加');
    await dom.node('input-form').onsubmit({ preventDefault() {} }); expect(calls).toHaveLength(0); expect(ui.composerAppendTarget.id).toBe(126);
  }
});

test('Esc仅在空白且无引用时退出追加，IME/重复/非空不改变去向', async () => {
  append(); type('不空白'); await input().onkeydown({ key: 'Escape', preventDefault() {} }); expect(ui.composerAppendTarget).toBeTruthy();
  type(''); setComposerReferences([ref('引用')]); await input().onkeydown({ key: 'Escape', preventDefault() {} }); expect(ui.composerAppendTarget).toBeTruthy();
  setComposerReferences([]);
  for (const props of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }]) {
    await input().onkeydown({ key: 'Escape', ...props, preventDefault() {} }); expect(ui.composerAppendTarget).toBeTruthy();
  }
  await input().onkeydown({ key: 'Escape', preventDefault() {} }); expect(ui.composerAppendTarget).toBeNull(); expect(calls).toHaveLength(0);
});

test('后台刷新失败与发射成功分开，旧刷新失败不覆盖第二条成功', async () => {
  const pending = deferred(); let reads = 0;
  const restore = registerNavigation({ refresh: () => { reads++; return reads === 1 ? pending.promise : Promise.resolve(); } });
  try {
    type('第一条'); await dom.node('input-form').onsubmit({ preventDefault() {} });
    type('第二条'); await dom.node('input-form').onsubmit({ preventDefault() {} });
    const acknowledged = dom.node('error').textContent; pending.reject(new Error('旧刷新离线')); await Promise.resolve();
    expect(reads).toBe(2); expect(input().value).toBe(''); expect(dom.node('error').textContent).toBe(acknowledged);
  } finally { restore(); pending.resolve(); }
  const failingRefresh = registerNavigation({ refresh: () => Promise.reject(new Error('页面离线')) });
  try {
    type('提交成功再更新失败'); await dom.node('input-form').onsubmit({ preventDefault() {} }); await until(() => dom.node('error').textContent.includes('页面离线'));
    expect(input().value).toBe(''); expect(dom.node('error').textContent).toContain('提交已成功');
  } finally { failingRefresh(); }
});

test('同一详情已由refresh更新时不重复读详情，追加后慢详情不占下一条提交锁', async () => {
  append(); let details = 0;
  const restore = registerNavigation({ refresh: async () => { ui.detailTask = 126; ui.composerTask = { ...ui.composerTask }; ui.detailRenderedAt = 2; }, detail: async () => { details++; } });
  try { type('刷新即可'); await dom.node('input-form').onsubmit({ preventDefault() {} }); await Promise.resolve(); expect(details).toBe(0); }
  finally { restore(); }
  append(); ui.detailTask = null; const slow = deferred();
  const nextRestore = registerNavigation({ refresh: async () => {}, detail: () => { details++; return slow.promise; } });
  try {
    type('慢详情'); await dom.node('input-form').onsubmit({ preventDefault() {} }); await until(() => details === 1);
    expect(ui.composerSubmitting).toBe(false); type('下一条'); await buffer(); type('继续编辑'); slow.resolve(); await Promise.resolve();
    expect(input().value).toBe('继续编辑'); expect(ui.composerAppendTarget).toBeNull();
  } finally { nextRestore(); slow.resolve(); }
});

test('只消费提交时的profile，处理中重新选择的配置属于下一条', async () => {
  type('带配置发射'); const firstProfile = { agent: 'pi', config_mode: 'pi' }; ui.composerProfile = firstProfile;
  const pending = deferred(); intercept = () => pending.promise; const sending = dom.node('input-form').onsubmit({ preventDefault() {} });
  const nextProfile = { agent: 'pi', model: 'next/model' }; ui.composerProfile = nextProfile; type('下一条正文');
  pending.resolve(json({ emitted: true, draft_id: 9 })); await sending;
  expect(calls[0].params.profile).toEqual(firstProfile); expect(ui.composerProfile).toBe(nextProfile); expect(input().value).toBe('下一条正文');
});

test('父候选读取单飞；同页追加刷新不退出模式，失效目标不会改投', async () => {
  parentGate = deferred(); const first = loadComposerParents(), second = loadComposerParents(); expect(first).toBe(second);
  parentGate.resolve(json({ items: parents })); await first;
  append(); const selected = ui.composerAppendTarget; ui.composerTask = { ...ui.composerTask, goal: '新目标摘要' }; syncComposer();
  expect(ui.composerAppendTarget).toBe(selected); expect(dom.node('composer-mode-target').textContent).toContain('新目标摘要');
  ui.composerTask = null; ui.composerError = '读取失败'; syncComposer(); expect(input().disabled).toBe(true); expect(ui.composerAppendTarget).toBe(selected);
});

test('异步父候选不覆盖新会话，保留缺失身份而不回落 main', async () => {
  parentGate = deferred(); const pending = loadComposerParents(); const old = ui.composerIdentity;
  ui.composerIdentity = {}; ui.composerParents = [{ id: 999, branch: 'new-project' }]; parentGate.resolve(json({ items: parents })); await pending;
  expect(ui.composerIdentity).not.toBe(old); expect(ui.composerParents[0].id).toBe(999);
});
