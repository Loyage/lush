import { test, expect, beforeEach, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { installDom, deepText, dialogButton } from './project-dom.js';
import { until } from '../helpers.js';
import { makeWorld } from './dom-world.js';
import { editorInput, editorEvent, editorSelection } from './text-editor-events.js';

const json = data => ({ ok: true, json: async () => structuredClone(data) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reference = { version: 1, kind: 'text', target: {}, label: '原始引用', quote: '当时所见', location: {}, captured_at: '2026-10-01T00:00:00Z' };
const fixture = (kind = 'draft', id = 1, extra = {}) => ({ kind, id, mode: kind === 'message' ? 'append' : kind === 'management' ? 'management' : 'order', content: kind === 'draft' ? '尚未执行的想法' : '已经发送的原始输入', content_truncated: false,
  created_at: '2026-10-01T00:00:00Z', task_id: kind === 'input' ? 20 : null, parent_id: 1, branch: 'main',
  status: kind === 'draft' ? 'draft' : 'awaiting_acceptance', integration: kind === 'draft' ? 'none' : 'merged',
  merge_status: kind === 'draft' ? 'none' : 'merged', revision: kind === 'draft' ? 3 : null, references: [reference], ...extra });
const parents = [{ id: 1, branch: 'main', goal: '主干' }, { id: 900, branch: 'feature/old', goal: '不在 overview 的旧父 Task' }];
let rows, intercept, pageCursor;
const calls = [], reads = [], world = makeWorld();
const dom = installDom({ fetch: async (url, options = {}) => {
  const route = new URL(String(url), 'http://localhost'), path = route.pathname.replace(/^\/p\/[^/]+/, '');
  const body = options.body ? JSON.parse(options.body) : null;
  if (body && ['draft.update', 'draft.remove', 'input.emit', 'input.emission_cancel', 'input.exclusive_release'].includes(body.method)) {
    calls.push(body); const intercepted = intercept?.(path, body, route); if (intercepted) return intercepted;
    const { method, params } = body, old = rows.find(row => row.kind === 'draft' && row.id === (params.id ?? params.draft_id));
    if (params.expected_revision !== old?.revision) return { ok: false, json: async () => ({ error: 'revision conflict' }) };
    if (method === 'draft.update') {
      Object.assign(old, params, { revision: old.revision + 1 });
      if (params.branch) old.parent_id = parents.find(parent => parent.branch === params.branch)?.id;
      return json(old);
    }
    if (method === 'input.emit') { old.dispatch = { state: 'queued' }; return json({ emitted: true, draft_id: old.id, dispatch: old.dispatch }); }
    if (method === 'input.emission_cancel') { old.dispatch = { state: 'cancelled' }; return json(old); }
    if (method === 'input.exclusive_release') { old.dispatch.exclusive_active = false; old.dispatch.can_release_exclusive = false; return json(old); }
    rows = rows.filter(row => row !== old); return json({ id: old.id });
  }
  if (path === '/api/input-parents' || path === '/api/inputs' || path.startsWith('/api/input/')) {
    reads.push(String(url)); const intercepted = intercept?.(path, null, route); if (intercepted) return intercepted;
    if (path === '/api/input-parents') return json({ items: parents });
    if (path === '/api/inputs') {
      const q = route.searchParams.get('q') ?? '', status = route.searchParams.get('status'), merge = route.searchParams.get('integration');
      const modes = JSON.parse(route.searchParams.get('modes') ?? '["order","append","management"]');
      const drafts = route.searchParams.get('view') === 'drafts';
      const selected = rows.filter(row => drafts ? row.kind === 'draft' && !row.input_id && row.dispatch?.state !== 'succeeded' : row.kind !== 'draft');
      return json({ items: selected.filter(row => modes.includes(row.mode) && row.content.includes(q) && (!status || row.status === status) && (!merge || row.merge_status === merge)), next_cursor: modes.length ? pageCursor : null });
    }
    const [, kind, id] = /\/api\/input\/(draft|input|message|management)\/(\d+)/.exec(path);
    return json(rows.find(row => row.kind === kind && row.id === Number(id)));
  }
  if (path === '/api/workers') { reads.push(String(url)); return intercept?.(path, body, route) || json({ tasks: [{ id: 901, worker_number: 'W777', goal: '面板重构' }], has_more: false }); }
  if (/\/api\/worker\/\d+\/relations$/.test(path)) { reads.push(String(url)); return intercept?.(path, body, route) || json({ children: { items: [], has_more: false } }); }
  if (path === '/api/worker-lookup') return json({ id: 901, worker_number: 'W777' });
  if (path === '/api/agent/config') return json(world.state.agentConfig);
  if (/\/api\/worker\/\d+\/hooks$/.test(path)) return intercept?.(path, body, route) || json({ version: 1, revision: 'hooks-v1', mounts: [] });
  if (body?.method === 'worker.hook_remove') { calls.push(body); return intercept?.(path, body, route) || json({ version: 1, revision: 'hooks-v2', mounts: [] }); }
  return world.fetchImpl(url, options);
} });
const { openInputs: openHistory } = await import('../../src/ui/web/assets/render-inputs.js');
// Draft editor regressions exercise the real drafts route, never mixed history fixtures.
const openInputs = options => openHistory({ ...(!options?.item ? { section: 'drafts' } : {}), ...options });
const { createEmissionConditions } = await import('../../src/ui/web/assets/emission-form.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { boot } = await import('../../src/ui/web/assets/app.js');
await boot();
const root = () => dom.node('detail');
const text = () => deepText(root());
const panel = () => root().querySelector('.input-detail');
const btn = (label, parent = root()) => [...parent.querySelectorAll('button'), ...parent.querySelectorAll('a')].find(node => node.textContent === label || (label === '← 返回历史输入' && node.textContent === '← 返回草稿') || node.getAttribute('aria-label')?.endsWith(`：${label}`));
const openDraft = async () => {
  if (ui.view.id !== 'drafts') await openInputs();
  const draft = rows.find(row => row.kind === 'draft');
  if (draft?.mode === 'append' && form().querySelector('[data-mode="append"]').getAttribute('aria-pressed') !== 'true') await form().querySelector('[data-mode="append"]').onclick();
  const entry = btn('查看草稿与提交状态');
  return entry ? entry.onclick() : openInputs({ item: { kind: 'draft', id: draft.id } });
};
// Module loading may need an event-loop turn before the confirmation appears.
// Wait for the explicit UI condition, not an arbitrary sleep or an unresolved navigation promise.
const readyDialogButton = async label => {
  for (let turn = 0; turn < 100; turn++) {
    const button = dialogButton(dom, label);
    if (button) return button;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Dialog button did not become ready: ${label}`);
};
const form = () => root().querySelector('.inputs-filters');
const selectStatus = value => {
  const select = form().querySelector('select'); select.value = value; return select.onchange();
};
const editor = () => panel().querySelector('textarea');
const parentSelect = () => panel().querySelector('select');
beforeEach(() => {
  rows = [fixture(), fixture('input', 2)]; intercept = null; pageCursor = null; calls.length = 0; reads.length = 0;
  activateDetailView({ view: 'overview' }); dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
});
afterAll(() => dom.restore());

test('已发射却缺少dispatch或版本的草稿保守只读，不提供重复发射/编辑', async () => {
  for (const change of [{ status: 'emitted' }, { revision: undefined }, { mode: 'management' }]) {
    rows = [fixture('draft', 1, change)]; await openInputs(); await selectStatus(''); await openDraft();
    expect(panel().querySelector('textarea')).toBeNull(); expect(deepText(panel())).toContain('只读待核验');
    expect(btn('提交指令', panel())).toBeUndefined(); expect(calls).toHaveLength(0);
  }
});

test('草稿仅筛选未发送授权状态，成功追加不留草稿选项', async () => {
  const statuses = { waiting_conditions: '已提交 · 等待条件', emitted: '已提交 · 等待准入', emission_failed: '提交后投递失败', unknown_dispatch: '投递结果待核验' };
  rows = Object.keys(statuses).map((status, index) => fixture('draft', index + 1, { status, content: `输入${index}` }));
  await openInputs();
  for (const [status, label] of Object.entries(statuses)) {
    const option = form().querySelector('select').children.find(node => node.value === status); expect(option.textContent).toBe(label);
    await selectStatus(status); expect(root().querySelectorAll('.input-record')).toHaveLength(1);
    expect(new URL(reads.at(-1), 'http://localhost').searchParams.get('status')).toBe(status);
    expect(form().querySelector('select').children.some(node => node.value === 'sent')).toBe(false);
    expect(new URL(reads.at(-1), 'http://localhost').searchParams.get('view')).toBe('drafts');
  }
});

test('未提交关键词不因即时筛选、刷新或分页生效，IME 不提交；清空保留状态', async () => {
  pageCursor = 'next'; await openInputs();
  const input = form().querySelector('input'); input.value = '未提交'; input.listeners.input[0]();
  await selectStatus(''); await btn('刷新列表').onclick(); await btn('加载更多').onclick();
  expect(reads.every(url => !new URL(url, 'http://localhost').searchParams.get('q'))).toBe(true);
  input.listeners.keydown[0]({ key: 'Enter', isComposing: true, preventDefault() {} });
  expect(new URL(reads.at(-1), 'http://localhost').searchParams.get('q')).toBe('');
  input.value = '想法'; await form().onsubmit({ preventDefault() {} });
  expect(new URL(reads.at(-1), 'http://localhost').searchParams.get('q')).toBe('想法');
  input.value = '新草稿词'; await selectStatus('draft');
  expect(new URL(reads.at(-1), 'http://localhost').searchParams.get('q')).toBe('想法');
  await btn('清空').onclick();
  expect(new URL(reads.at(-1), 'http://localhost').searchParams.get('status')).toBe('draft');
  expect(new URL(reads.at(-1), 'http://localhost').searchParams.get('q')).toBe('');
});

test('独立历史与草稿导航、输入区入口、只读原文，轮询不覆盖草稿编辑', async () => {
  await dom.node('inputs-open').onclick();
  expect(dom.location.hash).toBe('#inputs'); expect(dom.node('inputs-open').getAttribute('aria-current')).toBe('page');
  expect(dom.node('view-context').textContent).toBe('工作');
  expect(form().querySelector('select').value).toBe('');
  expect(root().querySelectorAll('.input-record').map(card => card.dataset.input)).toEqual(['input:2']);
  expect(root().querySelector('.input-advanced-filters').open).not.toBe(true);
  await selectStatus('');
  expect(root().querySelector('[aria-label="Worker 状态：待验收"]')).toBeTruthy(); expect(root().querySelector('[aria-label="合并状态：已合并"]')).toBeTruthy();
  await btn('查看原文').onclick(); expect(panel().querySelector('textarea')).toBe(null); expect(deepText(panel())).toContain('已发送原文只读');
  await openDraft(); const node = editor(); node.value = '还没保存'; const before = reads.length;
  await dom.intervalFor(1500)(); await dom.intervalFor(3000)();
  expect(editor()).toBe(node); expect(node.value).toBe('还没保存'); expect(reads.length).toBe(before);
  await btn('刷新列表').onclick(); expect(editor()).toBe(node); expect(node.value).toBe('还没保存');
  const leaving = dom.node('input-history').onclick();
  await (await readyDialogButton('取消')).onclick(); await leaving;
  expect(editor()).toBe(node); expect(editor().value).toBe('还没保存'); expect(dom.location.hash).toBe('#input-draft-1');
  const accepted = dom.node('input-history').onclick(); await (await readyDialogButton('放弃编辑')).onclick(); await accepted;
  expect(dom.location.hash).toBe('#inputs'); expect(dom.node('inputs-open').getAttribute('aria-current')).toBe('page');
  expect(root().querySelectorAll('.input-record').map(card => card.dataset.input)).toEqual(['input:2']);
  await dom.node('input-drafts').onclick(); expect(dom.location.hash).toBe('#drafts');
  expect(dom.node('drafts-open').getAttribute('aria-current')).toBe('page');
  expect(root().querySelectorAll('.input-record').map(card => card.dataset.input)).toEqual(['draft:1']);
});

test('历史默认全部状态用于搜索、刷新和分页，主动切换后保留筛选，重新进页恢复全部', async () => {
  pageCursor = 'next'; await openHistory();
  expect(new URL(reads[0], 'http://localhost').searchParams.has('status')).toBe(false);
  await btn('刷新列表').onclick(); await btn('加载更多').onclick();
  form().querySelector('input').value = '想法'; await form().onsubmit({ preventDefault() {} });
  expect(reads.every(url => !new URL(url, 'http://localhost').searchParams.has('status'))).toBe(true);
  form().querySelector('input').value = '';
  await form().querySelector('input').listeners.input[0]();
  await selectStatus('awaiting_acceptance');
  expect(root().querySelectorAll('.input-record').map(card => card.dataset.input)).toEqual(['input:2']);
  await btn('查看原文').onclick(); await btn('← 返回历史输入').onclick(); await openHistory();
  expect(form().querySelector('select').value).toBe('awaiting_acceptance');
  await selectStatus('');
  expect(new URL(reads.at(-1), 'http://localhost').searchParams.has('status')).toBe(false);
  expect(root().querySelectorAll('.input-record')).toHaveLength(1);
  activateDetailView({ view: 'overview' }); rows = [fixture('input', 2)];
  await openHistory();
  expect(form().querySelector('select').value).toBe('');
  expect(root().querySelectorAll('.input-record')).toHaveLength(1);
  expect(form().querySelector('select').children.some(option => option.value === 'draft')).toBe(false);
});

test('三种色块独立多选、全不选为空；搜索刷新分页保留模式，未提交关键词不应用', async () => {
  rows.push(fixture('draft', 3, { mode: 'append' }), fixture('message', 4, { append_number: 'A2-1' }), fixture('management', 5));
  pageCursor = 'next'; await openHistory();
  const mode = value => form().querySelector(`[data-mode="${value}"]`);
  expect(root().querySelectorAll('.input-record')).toHaveLength(3);
  for (const value of ['order', 'append', 'management']) {
    expect(mode(value).getAttribute('aria-pressed')).toBe('true');
    expect(mode(value).getAttribute('data-help')).toContain('不修改');
  }
  form().querySelector('input').value = '未提交';
  await mode('order').onclick();
  expect(root().querySelectorAll('.input-record').map(card => card.dataset.input)).toEqual(['message:4', 'management:5']);
  expect(mode('order').classList.contains('is-off')).toBe(true);
  await mode('management').onclick();
  await btn('刷新列表').onclick(); await btn('加载更多').onclick();
  let query = new URL(reads.at(-1), 'http://localhost').searchParams;
  expect(JSON.parse(query.get('modes'))).toEqual(['append']); expect(query.get('q')).toBe('');
  await mode('append').onclick();
  expect(root().querySelectorAll('.input-record')).toHaveLength(0); expect(text()).toContain('未勾选输入模式');
  query = new URL(reads.at(-1), 'http://localhost').searchParams; expect(JSON.parse(query.get('modes'))).toEqual([]); expect(query.has('cursor')).toBe(false);
  await mode('management').onclick(); expect(root().querySelectorAll('.input-record').map(card => card.dataset.input)).toEqual(['management:5']);
  form().querySelector('input').value = ''; await form().onsubmit({ preventDefault() {} });
  await btn('查看原文').onclick(); await btn('← 返回历史输入').onclick();
  expect(mode('management').getAttribute('aria-pressed')).toBe('true'); expect(mode('append').getAttribute('aria-pressed')).toBe('false');
  activateDetailView({ view: 'overview' }); await openHistory();
  expect(root().querySelectorAll('.input-record')).toHaveLength(3);
});

test('追加与管理使用真实编号、只读安全正文和来源跳转；新深链接由 app 路由打开', async () => {
  rows = [fixture('message', 4, { append_number: 'A2-1', task_id: 20, task_worker_number: 'W2', content: '<img src=x>用户追加' }),
    fixture('management', 5, { task_id: 5, task_worker_number: 'V3', content: '管理原文' }), fixture('message', 6, { task_id: 20, append_number: null })];
  await openHistory();
  expect(text()).toContain('追加指令 A2-1'); expect(text()).toContain('管理指令 V3'); expect(text()).toContain('消息 #6');
  expect(form().querySelector('[data-mode="order"]').textContent).toContain('新建工作');
  for (const [key, content] of [['message:4', '追加指令'], ['management:5', '管理指令']]) {
    const card = root().querySelector(`[data-input="${key}"]`);
    expect(card.querySelector('.input-mode-badge').textContent).toBe(content);
    expect(card.querySelector('.input-row').getAttribute('aria-label')).toContain(content);
    expect(deepText(card)).not.toContain('工作指令');
  }
  expect(text()).not.toContain('O4'); expect(text()).not.toContain('O5');
  const routes = [], restore = registerNavigation({ detail: id => routes.push(id) });
  try {
    for (const [kind, id, label, worker] of [['message', 4, '追加指令 A2-1', 'W2'], ['management', 5, '管理指令 V3', 'V3']]) {
      const row = root().querySelector(`[data-input="${kind}:${id}"]`).querySelector('a');
      expect(row.getAttribute('href')).toBe(`#input-${kind}-${id}`);
      row.onclick({ ctrlKey: true, preventDefault() { throw Error('new tab prevented'); } });
      dom.location.hash = row.getAttribute('href'); await dom.fire('hashchange');
      expect(deepText(panel())).toContain(label); expect(editor()).toBeNull(); expect(panel().querySelector('img')).toBeNull();
      expect(deepText(panel())).not.toContain('工作指令 O');
      expect(panel().querySelector('.input-metadata').querySelector('.input-mode-badge').textContent).toBe(kind === 'message' ? '追加指令' : '管理指令');
      expect(deepText(panel())).toContain(kind === 'message' ? '不创建 O 编号' : '不创建开发 Worker 或 O 编号');
      expect(btn('保存', panel())).toBeUndefined(); await btn(`查看来源 ${worker}`, panel()).onclick();
      await btn('← 返回历史输入').onclick();
    }
    expect(routes).toEqual([20, 5]); expect(calls).toHaveLength(0);
  } finally { restore(); }
});

test('模式变化作废旧分页与旧模式响应，离页读取不能回写', async () => {
  pageCursor = 'next'; rows.push(fixture('management', 5)); await openHistory();
  const stale = deferred(); intercept = (path, _body, route) => path === '/api/inputs' && route.searchParams.has('cursor') ? stale.promise : null;
  const more = btn('加载更多').onclick(); await form().querySelector('[data-mode="order"]').onclick();
  stale.resolve(json({ items: [fixture('input', 99, { content: '过时新建' })], next_cursor: 'old' })); await more;
  expect(root().querySelectorAll('.input-record').map(card => card.dataset.input)).toEqual(['management:5']); expect(text()).not.toContain('过时新建');
  const late = deferred(); intercept = path => path === '/api/inputs' ? late.promise : null;
  const pending = form().querySelector('[data-mode="append"]').onclick(); activateDetailView({ view: 'overview' }); root().replaceChildren(document.createTextNode('已离开'));
  late.resolve(json({ items: rows, next_cursor: null })); await pending; expect(text()).toBe('已离开');
});

test('紧凑条目只有一个详情入口，等高摘要不内嵌操作或引用，沿用资源页样式', async () => {
  rows = [fixture('input', 1, { content: '短句' }), fixture('input', 2, { content: '\n\n' + '长段落\n'.repeat(200), content_truncated: true }),
    fixture('input', 3, { content: '', status: 'missing', merge_status: 'missing' })];
  await openHistory(); await selectStatus('');
  expect(root().querySelector('.resource-hero')).toBeTruthy(); expect(root().querySelector('.resource-tools')).toBeTruthy();
  const cards = root().querySelectorAll('.input-record');
  expect(cards.map(card => card.querySelectorAll('.input-row').length)).toEqual([1, 1, 1]);
  expect(cards.every(card => card.querySelector('.input-preview').tagName === 'SPAN')).toBe(true);
  expect(cards[1].querySelector('.input-preview').textContent).not.toContain('\n');
  expect(deepText(cards[1])).toContain('摘要已截断'); expect(deepText(cards[2])).toContain('状态未知');
  expect(root().querySelectorAll('.input-reference')).toHaveLength(0);
  expect(btn('查看 Worker #20')).toBeUndefined();
  const css = readFileSync('src/ui/web/assets/styles-inputs.css', 'utf8');
  expect(css).toContain('height:123px'); expect(css).toContain('-webkit-line-clamp:2');
});

test('独立详情与返回保留筛选、分页、滚动和未保存编辑，键盘焦点回到条目', async () => {
  pageCursor = 'next'; await openInputs();
  const search = form().querySelector('input'); search.value = '想法'; await form().onsubmit({ preventDefault() {} });
  const record = root().querySelector('.input-record'); root().scrollTop = 240;
  await record.querySelector('button').onclick();
  expect(dom.location.hash).toBe('#input-draft-1'); expect(dom.node('view-title').textContent).toBe('草稿 #1');
  expect(root().querySelector('.inputs-browse').hidden).toBe(true); expect(root().querySelector('.input-detail-view').hidden).toBe(false);
  expect(document.activeElement).toBe(panel());
  editor().value = '未保存的本地编辑'; const node = editor(), before = reads.length;
  await btn('← 返回历史输入').onclick();
  expect(dom.location.hash).toBe('#drafts'); expect(root().querySelector('.inputs-browse').hidden).toBe(false);
  expect(root().querySelector('.input-detail-view').hidden).toBe(true); expect(panel().hidden).toBe(true);
  expect(form().querySelector('input')).toBe(search); expect(search.value).toBe('想法'); expect(reads.length).toBe(before);
  expect(root().scrollTop).toBe(240); expect(document.activeElement).toBe(record.querySelector('button')); expect(btn('加载更多').hidden).toBe(false);
  await openDraft(); expect(editor()).toBe(node); expect(editor().value).toBe('未保存的本地编辑'); expect(reads.length).toBe(before);
  await openInputs(); expect(panel().hidden).toBe(true);
});

test('详情深链接、浏览器后退与迟到读取，切换草稿取消时恢复原路由和编辑', async () => {
  dom.location.hash = '#input-input-2'; await dom.fire('hashchange');
  expect(deepText(panel())).toContain('原始指令 O2'); expect(panel().hidden).toBe(false);
  dom.location.hash = '#inputs'; await dom.fire('hashchange'); expect(panel().hidden).toBe(true);
  const late = deferred(); intercept = path => path === '/api/input/draft/1' ? late.promise : null;
  await openInputs();
  const opening = openDraft(); await until(() => dom.location.hash === '#input-draft-1'); await btn('← 返回历史输入').onclick();
  late.resolve(json(fixture())); await opening; expect(panel().hidden).toBe(true); expect(dom.location.hash).toBe('#drafts');
  intercept = null; await openDraft(); editor().value = '不丢弃';
  dom.location.hash = '#input-input-2'; const switching = dom.fire('hashchange');
  await (await readyDialogButton('取消')).onclick(); await switching;
  expect(dom.location.hash).toBe('#input-draft-1'); expect(editor().value).toBe('不丢弃'); expect(dom.node('view-title').textContent).toBe('草稿 #1');
  dom.location.hash = '#input-input-2'; const confirmed = dom.fire('hashchange');
  await (await readyDialogButton('放弃编辑')).onclick(); await confirmed;
  expect(dom.location.hash).toBe('#input-input-2'); expect(editor()).toBe(null); expect(deepText(panel())).toContain('原始指令 O2');
});

test('正文全库搜索与状态/合并筛选发到服务端，游标分页与失败重试', async () => {
  pageCursor = 'cursor +/opaque'; await openHistory(); await selectStatus('');
  const next = deferred(); let count = 0;
  intercept = (path, _body, route) => {
    if (path !== '/api/inputs') return;
    count++;
    if (route.searchParams.has('cursor')) return next.promise;
  };
  const a = btn('加载更多').onclick(), b = btn('加载更多').onclick(); expect(count).toBe(1);
  expect(new URL(reads.at(-1), 'http://localhost').searchParams.get('cursor')).toBe(pageCursor);
  next.resolve(json({ items: [fixture('input', 9, { content: '更早的记录' })], next_cursor: null })); await Promise.all([a, b]);
  expect(root().querySelectorAll('.input-record')).toHaveLength(2);
  intercept = null; pageCursor = null;
  form().querySelector('input').value = '原始输入'; const selects = form().querySelectorAll('select');
  selects[0].value = 'awaiting_acceptance'; selects[1].value = 'merged'; await form().onsubmit({ preventDefault() {} });
  const query = new URL(reads.at(-1), 'http://localhost').searchParams;
  expect(query.get('q')).toBe('原始输入'); expect(query.get('status')).toBe('awaiting_acceptance'); expect(query.get('integration')).toBe('merged'); expect(query.has('cursor')).toBe(false);
  expect(root().querySelectorAll('.input-record')).toHaveLength(1);
  intercept = path => path === '/api/inputs' ? Promise.reject(new Error('连接断开')) : null;
  await btn('刷新列表').onclick(); expect(text()).toContain('读取失败：连接断开'); expect(text()).toContain('已经发送的原始输入');
  intercept = null; form().querySelector('input').value = '不存在的输入'; await form().onsubmit({ preventDefault() {} }); expect(text()).toContain('没有符合条件');
});

test('完整详情修订用于编辑保存，父 Task 来自完整列表，保留/移除引用可恢复', async () => {
  rows[0].content_truncated = true; await openInputs(); expect(text()).toContain('已截断');
  await openDraft(); expect(reads).toContain('/api/input-parents'); expect(parentSelect().children.some(option => option.value === '900')).toBe(true);
  editor().value = '修改后的正文\n保留换行'; parentSelect().value = '900'; parentSelect().onchange();
  await btn('移除引用', panel()).onclick(); expect(deepText(panel())).toContain('引用快照（0）');
  await btn('恢复已保存引用', panel()).onclick(); expect(deepText(panel())).toContain('当时所见');
  await btn('移除引用', panel()).onclick(); await btn('保存', panel()).onclick();
  expect(calls).toEqual([{ method: 'draft.update', params: { id: 1, expected_revision: 3, content: '修改后的正文\n保留换行', references: [], branch: 'feature/old', conditions: [], exclusive: false } }]);
  expect(editor().value).toBe('修改后的正文\n保留换行'); expect(deepText(panel())).toContain('已保存');
  await btn('提交指令', panel()).onclick();
  expect(calls.at(-1)).toMatchObject({ method: 'input.emit', params: { draft_id: 1, expected_revision: 4 } });
  expect(calls.at(-1).params.client_request_id).toBeTruthy();
  expect(editor()).toBeNull(); expect(dom.location.hash).toBe('#input-draft-1');
  expect(deepText(panel())).toContain('修改后的正文'); expect(deepText(panel())).toContain('等待准入');
  await btn('← 返回历史输入').onclick(); await selectStatus('');
  expect(root().querySelectorAll('.input-record').some(card => card.dataset.input === 'draft:1')).toBe(true);
});

test('发射先保存再以新版本挂载，ACK 不冒充已创建，实际成功刷新后可查看 Worker', async () => {
  await openInputs(); await openDraft(); editor().value = '新正文'; await btn('提交指令', panel()).onclick();
  expect(calls.map(call => call.method)).toEqual(['draft.update', 'input.emit']); expect(calls[0].params).not.toHaveProperty('branch');
  expect(calls[1].params).toMatchObject({ draft_id: 1, expected_revision: 4 }); expect(calls[1].params).not.toHaveProperty('start');
  expect(dom.location.hash).toBe('#input-draft-1'); expect(editor()).toBeNull(); expect(deepText(panel())).toContain('新正文');
  expect(deepText(panel())).toContain('当时所见'); expect(deepText(panel())).toContain('不代表 Worker 已创建');
  rows[0].dispatch = { state: 'succeeded', input_id: 3, worker_id: 33, worker_number: 'W33' };
  rows.unshift(fixture('input', 3, { content: '新正文', task_id: 33, task_worker_number: 'W33', status: 'queued', source_draft_id: 1 }));
  await btn('刷新提交状态').onclick(); expect(deepText(panel())).toContain('已投递');
  await btn('刷新提交状态').onclick();
  expect(dom.location.hash).toBe('#input-input-3'); expect(text()).toContain('原始指令 O3');
  let opened; const restore = registerNavigation({ detail: async id => { opened = id; } });
  try { await btn('查看 Worker W33', panel()).onclick(); expect(opened).toBe(33); } finally { restore(); }
  expect(calls).toHaveLength(2);
});

test('旧草稿或失效父 Task 不回退默认；必须显式重选保存', async () => {
  for (const identity of [{ parent_id: null, branch: null }, { parent_id: 555, branch: 'gone' }]) {
    rows[0] = fixture('draft', 1, { ...identity, revision: null }); activateDetailView({ view: 'overview' }); await openInputs(); await openDraft();
    expect(deepText(panel())).toContain('必须重新选择');
    if (identity.parent_id) expect(parentSelect().value).toBe('missing:555');
    calls.length = 0; await btn('提交指令', panel()).onclick(); expect(calls).toHaveLength(0);
    parentSelect().value = '1'; await btn('保存', panel()).onclick();
    expect(calls[0].params.branch).toBe('main'); expect(calls[0].params.expected_revision).toBe(null);
  }
});

test('编辑/发射单飞，保存失败保留全部本地编辑并且不发射', async () => {
  await openInputs(); await openDraft(); editor().value = '不能丢的编辑'; parentSelect().value = '900'; await btn('移除引用', panel()).onclick();
  const delayed = deferred(); intercept = (_path, body) => body?.method === 'draft.update' ? delayed.promise : null;
  const first = btn('提交指令', panel()).onclick();
  await btn('提交指令', panel()).onclick(); await btn('保存', panel()).onclick(); await btn('删除草稿', panel()).onclick();
  expect(calls).toHaveLength(1); expect(editor().disabled).toBe(true);
  delayed.resolve({ ok: false, json: async () => ({ error: 'revision conflict' }) }); await first;
  expect(editor().value).toBe('不能丢的编辑'); expect(parentSelect().value).toBe('900'); expect(deepText(panel())).toContain('引用快照（0）');
  expect(deepText(panel())).toContain('revision conflict'); expect(editor().disabled).toBe(false);
  intercept = null; await btn('保存', panel()).onclick(); expect(calls.at(-1).params.expected_revision).toBe(3);
});

test('保存 500、离线或远端删除后，轮询与刷新仍保留文字/父身份/引用，允许重试', async () => {
  for (const failure of [() => ({ ok: false, status: 500, json: async () => ({ error: '保存失败' }) }),
    () => Promise.reject(new Error('离线')), () => ({ ok: false, status: 404, json: async () => ({ error: '远端已删除' }) })]) {
    activateDetailView({ view: 'overview' }); rows = [fixture(), fixture('input', 2)];
    intercept = null; await openInputs(); await openDraft();
    const node = editor(); node.value = '保留本地修改'; parentSelect().value = '900';
    const delayed = deferred(); intercept = (_path, body) => body?.method === 'draft.update' ? delayed.promise : null;
    const saving = btn('保存', panel()).onclick();
    await dom.intervalFor(1500)(); await btn('刷新列表').onclick();
    delayed.resolve(failure());
    await saving;
    expect(editor()).toBe(node); expect(node.value).toBe('保留本地修改'); expect(node.disabled).toBe(false);
    expect(parentSelect().value).toBe('900'); expect(deepText(panel())).toContain('当时所见');
    intercept = null; await btn('保存', panel()).onclick(); expect(deepText(panel())).toContain('已保存');
  }
});

test('保存成功但发射失败保留更新修订，重试不会重复保存旧内容', async () => {
  await openInputs(); await openDraft(); editor().value = '已经保存的编辑';
  intercept = (_path, body) => body?.method === 'input.emit' ? Promise.reject(new Error('父分支暂时被冻结')) : null;
  await btn('提交指令', panel()).onclick();
  expect(editor().value).toBe('已经保存的编辑'); expect(calls.map(call => call.method)).toEqual(['draft.update', 'input.emit']);
  const requestId = calls.at(-1).params.client_request_id;
  intercept = null; await btn('提交指令', panel()).onclick();
  expect(calls.map(call => call.method)).toEqual(['draft.update', 'input.emit', 'input.emit']); expect(calls.at(-1).params.expected_revision).toBe(4);
  expect(calls.at(-1).params.client_request_id).toBe(requestId);
});

test('删除草稿走应用内确认，取消无动作、确认单飞且使用详情版本', async () => {
  await openInputs(); await openDraft();
  const cancelled = btn('删除草稿', panel()).onclick(); expect(deepText(dom.node('modal'))).toContain('无法恢复');
  await dialogButton(dom, '取消').onclick(); await cancelled; expect(calls).toHaveLength(0);
  const removed = btn('删除草稿', panel()).onclick(); await btn('删除草稿', panel()).onclick();
  await dialogButton(dom, '删除草稿').onclick(); await removed;
  expect(calls).toEqual([{ method: 'draft.remove', params: { id: 1, expected_revision: 3 } }]);
  expect(text()).toContain('草稿已删除'); expect(root().querySelectorAll('.input-record')).toHaveLength(0);
});

test('列表查询/详情迟到响应与离页返回身份保护；切换期间新编辑不覆盖', async () => {
  const pending = deferred(); intercept = path => path === '/api/inputs' ? pending.promise : null;
  const old = openInputs(); activateDetailView({ view: 'settings' }); root().replaceChildren(document.createTextNode('设置页')); pending.resolve(json({ items: rows, next_cursor: null })); await old;
  expect(text()).toBe('设置页');
  intercept = null; await openInputs(); await selectStatus('');
  rows.push(fixture('draft', 9, { content: '第二条未发送想法' })); await btn('刷新列表').onclick();
  const second = () => root().querySelector('[data-input="draft:9"]').querySelector('button');
  const late = deferred(); intercept = path => path === '/api/input/draft/1' ? late.promise : null;
  const opening = openDraft(); await second().onclick(); late.resolve(json(fixture())); await opening;
  expect(editor().value).toBe('第二条未发送想法');
  intercept = null; await openDraft();
  const pendingSwitch = deferred(); intercept = path => path === '/api/input/draft/9' ? pendingSwitch.promise : null;
  const loading = second().onclick(); editor().value = '请求期间的新编辑';
  pendingSwitch.resolve(json(rows.find(row => row.id === 9))); await loading;
  expect(editor().value).toBe('请求期间的新编辑'); expect(deepText(panel())).toContain('未覆盖当前编辑');
});

test('新搜索作废旧分页，项目路由前缀不丢；详情父列表失败不冒充空列表', async () => {
  dom.location.pathname = '/p/0123456789abcdef/'; pageCursor = 'next'; await openInputs(); await selectStatus('');
  expect(dom.requests.filter(row => row.path.includes('/api/inputs')).at(-1).path).toContain('/p/0123456789abcdef/api/inputs');
  const stale = deferred(); intercept = (path, _body, route) => path === '/api/inputs' && route.searchParams.has('cursor') ? stale.promise : null;
  const more = btn('加载更多').onclick(); form().querySelector('input').value = '想法'; await form().onsubmit({ preventDefault() {} });
  stale.resolve(json({ items: [fixture('input', 88, { content: '过时分页' })], next_cursor: null })); await more;
  expect(text()).not.toContain('过时分页'); expect(root().querySelectorAll('.input-record')).toHaveLength(1);
  form().querySelector('input').value = ''; await form().onsubmit({ preventDefault() {} });
  intercept = path => path === '/api/input-parents' ? Promise.reject(new Error('无法读取父任务')) : null;
  await openDraft(); expect(editor()).toBe(null); expect(deepText(panel())).toContain('无法读取父任务');
});

test('文本安全、Agent 标识和帮助宿主，静态导航与快捷键提示一致', async () => {
  const attack = '<img src=x onerror=alert(1)>';
  rows[0].content = attack; rows[0].references = [{ ...reference, label: attack, quote: attack }];
  await openInputs(); await openDraft(); expect(editor().value).toBe(attack); expect(deepText(panel())).toContain(attack);
  expect(root().querySelectorAll('img')).toHaveLength(0);
  const settings = btn('执行条件设置', panel()); expect(settings.classList.contains('agent-call')).toBe(false);
  expect(settings.getAttribute('data-help')).toContain('不调用 Agent');
  expect(settings.parentNode.classList.contains('help-host')).toBe(true);
  expect(btn('提交指令', panel()).classList.contains('agent-call')).toBe(true);
  for (const label of ['提交指令', '删除草稿', '移除引用']) expect(btn(label, panel()).getAttribute('data-help')).toBeTruthy();
  const html = readFileSync('src/ui/web/assets/index.html', 'utf8');
  expect(html.indexOf('id="inputs-open"')).toBeLessThan(html.indexOf('<span>设备设置与帮助</span>'));
  expect(html).toContain('<kbd>Enter</kbd> 暂存'); expect(html).toContain('<kbd>Shift+Enter</kbd> 换行'); expect(html).toContain('/styles-inputs.css');
});

test('冻结父 Worker 的草稿发射挂载一次性 Hook，保留修订与引用且不读取不存在的 task', async () => {
  parents[0].freeze = { reason: '父队列执行中' };
  try {
    await openInputs(); await openDraft();
    expect(btn('提交指令').classList.contains('agent-call')).toBe(true);
    expect(btn('提交指令').getAttribute('data-help')).toContain('安全准入');
    await btn('提交指令').onclick();
    expect(calls.at(-1)).toMatchObject({ method: 'input.emit', params: { draft_id: 1, expected_revision: 3 } });
    expect(calls.at(-1).params).not.toHaveProperty('defer'); expect(deepText(panel())).toContain('不代表 Worker 已创建');
    expect(rows[0].references).toEqual([reference]); expect(rows[0].revision).toBe(3);
  } finally { delete parents[0].freeze; }
});

test('草稿可以显式选择完整运行设置，只在 input.emit 传入配置覆盖，普通保存不写私有参数', async () => {
  await openInputs(); await openDraft();
  const configuring = btn('运行设置：提交时固定默认').onclick();
  try { await until(() => dialogButton(dom, '使用这份设置')); }
  catch (error) { throw new Error(`${error.message}; toast=${dom.node('error').textContent}; modal=${deepText(dom.node('modal'))}`); }
  const mode = dom.node('modal').querySelector('[data-retry-field="config_mode"]'); mode.value = 'pi'; mode.onchange();
  await dialogButton(dom, '使用这份设置').onclick(); await configuring;
  expect(btn('运行设置：Pi 默认配置')).toBeTruthy(); expect(calls).toHaveLength(0);
  expect(btn('保存').disabled).toBe(true);
  await btn('保存').onclick(); expect(calls).toHaveLength(0); expect(deepText(panel())).toContain('提交时才写入');
  await btn('提交指令').onclick();
  expect(calls.at(-1)).toMatchObject({ method: 'input.emit', params: { draft_id: 1, expected_revision: 3, profile: { agent: 'pi', config_mode: 'pi' } } });
  expect(calls.at(-1).params).not.toHaveProperty('defer');
});

test('已挂载草稿只读且禁止重复发射，取消等待挂载采用最新 Hook 修订并恢复编辑', async () => {
  rows[0].hook_mount = { parent_id: 1, hook_id: 'draft-mount', state: 'waiting' };
  intercept = (path, body) => {
    if (path.endsWith('/hooks')) return json({ version: 1, revision: 'hooks-live', mounts: [{ id: 'draft-mount', state: 'waiting', editable: true, locked: false }] });
    if (body?.method === 'worker.hook_remove') { rows[0].hook_mount = null; return json({ version: 1, revision: 'hooks-removed', mounts: [] }); }
    return null;
  };
  await openInputs(); await openDraft(); await until(() => !btn('取消预约挂载').disabled);
  expect(editor()).toBeNull(); expect(btn('提交指令')).toBeUndefined(); expect(btn('删除草稿')).toBeUndefined();
  expect(deepText(panel())).toContain('不可编辑、删除或重复提交');
  const removing = btn('取消预约挂载').onclick(); await until(() => dialogButton(dom, '取消预约'));
  expect(calls).toHaveLength(0); await dialogButton(dom, '取消预约').onclick(); await removing;
  expect(calls.at(-1)).toEqual({ method: 'worker.hook_remove', params: { id: 1, hook_id: 'draft-mount', expected_revision: 'hooks-live' } });
  expect(editor().value).toBe('尚未执行的想法'); expect(btn('提交指令')).toBeTruthy();
});

test('O 编号原生链接保留新标签手势，直接深链接不受暂存筛选限制且不执行写动作', async () => {
  await openHistory(); await selectStatus('');
  const link = btn('查看原文'); expect(link.tagName).toBe('A'); expect(link.getAttribute('href')).toBe('#input-input-2');
  let prevented = 0; const before = reads.length;
  for (const gesture of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }])
    link.onclick({ ...gesture, preventDefault: () => prevented++ });
  expect(prevented).toBe(0); expect(reads.length).toBe(before);
  await link.onclick({ button: 0, preventDefault: () => prevented++ });
  expect(prevented).toBe(1); expect(panel().querySelector('.record-link').getAttribute('href')).toBe('#input-input-2');
  activateDetailView({ view: 'overview' }); dom.location.hash = '#input-input-2'; await dom.fire('hashchange');
  expect(deepText(panel())).toContain('原始指令 O2'); expect(calls).toHaveLength(0);
});

test('正文撤销只改本页文本，不回退已保存版本、父 Worker 或引用，再保存使用新版本', async () => {
  await openInputs(); await openDraft(); const node = editor(); editorSelection(node, 0, 2, 'backward');
  editorInput(node, '已保存的新正文'); parentSelect().value = '900'; parentSelect().onchange();
  await btn('移除引用', panel()).onclick(); await btn('保存', panel()).onclick();
  expect(calls.at(-1).params.expected_revision).toBe(3); expect(rows[0].revision).toBe(4);
  const undo = btn('撤销'), redo = btn('重做');
  expect(undo.disabled).toBe(false); expect(undo.type).toBe('button'); expect(undo.classList.contains('agent-call')).toBe(false);
  expect(undo.parentNode.className).toBe('help-host');
  await undo.onclick();
  expect(node.value).toBe('尚未执行的想法'); expect([node.selectionStart, node.selectionEnd, node.selectionDirection]).toEqual([0, 2, 'backward']);
  expect(parentSelect().value).toBe('900'); expect(deepText(panel())).toContain('引用快照（0）');
  expect(rows[0].content).toBe('已保存的新正文'); expect(rows[0].revision).toBe(4); expect(calls).toHaveLength(1);
  await btn('保存').onclick();
  expect(calls.at(-1)).toEqual({ method: 'draft.update', params: { id: 1, expected_revision: 4, content: '尚未执行的想法', references: [], conditions: [], exclusive: false } });
  expect(rows[0].revision).toBe(5); await redo.onclick(); expect(node.value).toBe('已保存的新正文');
  await btn('提交指令').onclick();
  expect(calls.slice(-2).map(call => call.method)).toEqual(['draft.update', 'input.emit']);
  expect(calls.at(-1).params).toMatchObject({ draft_id: 1, expected_revision: 6 });
  expect(panel().querySelector('.text-editor-controls')).toBeNull();
  // A detached controller cannot revive consumed text or change the new detail.
  await undo.onclick(); expect(node.value).toBe('已保存的新正文');
});

test('历史正文撤销在保存忙碌时禁用，失败保留栈和修订；发射失败也可撤销后重新保存', async () => {
  await openInputs(); await openDraft(); editorInput(editor(), '失败不能丢');
  const delayed = deferred(); intercept = (_path, body) => body?.method === 'draft.update' ? delayed.promise : null;
  const saving = btn('保存').onclick();
  expect(btn('撤销').disabled).toBe(true); expect(btn('重做').disabled).toBe(true);
  expect(btn('撤销').parentNode.getAttribute('data-help')).toContain('不可编辑');
  await btn('撤销').onclick(); editorEvent(editor(), 'keydown', { key: 'z', ctrlKey: true });
  expect(editor().value).toBe('失败不能丢'); expect(calls).toHaveLength(1);
  delayed.resolve({ ok: false, json: async () => ({ error: '版本冲突' }) }); await saving;
  expect(btn('撤销').disabled).toBe(false); await btn('撤销').onclick(); expect(editor().value).toBe('尚未执行的想法');
  await btn('重做').onclick(); expect(editor().value).toBe('失败不能丢');
  intercept = (_path, body) => body?.method === 'input.emit' ? Promise.reject(new Error('发射失败')) : null;
  await btn('提交指令').onclick(); expect(calls.map(call => call.method)).toEqual(['draft.update', 'draft.update', 'input.emit']);
  expect(calls.at(-1).params.expected_revision).toBe(4); expect(btn('撤销').disabled).toBe(false);
  await btn('撤销').onclick(); intercept = null; await btn('提交指令').onclick();
  expect(calls.at(-2).params.expected_revision).toBe(4); expect(calls.at(-1).params.expected_revision).toBe(5);
  expect(text()).toContain('等待准入'); expect(editor()).toBeNull();
});

test('返回列表和刷新保留同一正文历史，离页重开或切换原始输入销毁旧正文栈', async () => {
  await openInputs(); await openDraft(); const node = editor(), undo = btn('撤销'); editorInput(node, '本地修改');
  const before = reads.length; await btn('← 返回历史输入').onclick(); await btn('刷新列表').onclick(); await openDraft();
  expect(editor()).toBe(node); expect(btn('撤销')).toBe(undo); expect(reads.length).toBe(before + 1);
  await undo.onclick(); expect(node.value).toBe('尚未执行的想法'); await btn('重做').onclick(); expect(node.value).toBe('本地修改');
  await undo.onclick(); rows[0].content = '服务端新正文'; rows[0].revision = 9;
  expect(btn('重新读取详情')).toBeUndefined();
  activateDetailView({ view: 'overview' }); await openInputs({ item: { kind: 'draft', id: 1 } });
  expect(editor()).not.toBe(node); expect(editor().value).toBe('服务端新正文');
  expect(btn('撤销').disabled).toBe(true); expect(btn('重做').disabled).toBe(true);
  await undo.onclick(); expect(node.value).toBe('尚未执行的想法'); expect(editor().value).toBe('服务端新正文');
  await openHistory({ item: { kind: 'input', id: 2 } }); expect(panel().querySelector('.text-editor-controls')).toBeNull();
});

test('历史编辑输入法确认分组且正文键盘撤销不发射请求', async () => {
  await openInputs(); await openDraft(); const node = editor();
  editorEvent(node, 'compositionstart'); editorInput(node, '尚未执行的想法n', { isComposing: true });
  editorInput(node, '尚未执行的想法ni', { isComposing: true }); expect(btn('撤销').disabled).toBe(true);
  editorEvent(node, 'compositionend'); editorInput(node, '尚未执行的想法你'); await Promise.resolve();
  const key = editorEvent(node, 'keydown', { key: 'z', metaKey: true });
  expect(key.defaultPrevented).toBe(true); expect(node.value).toBe('尚未执行的想法'); expect(calls).toHaveLength(0);
  editorEvent(node, 'keydown', { key: 'z', metaKey: true, shiftKey: true }); expect(node.value).toBe('尚未执行的想法你');
  await btn('保存').onclick(); expect(calls.at(-1).params.content).toBe('尚未执行的想法你');
});

test('保存状态比较正文、父 Worker 与引用；恢复原值或保存成功后禁用，撤销重做及时同步', async () => {
  await openInputs(); await openDraft(); const save = btn('保存'), node = editor();
  expect(save.disabled).toBe(true); expect(save.parentNode.className).toBe('help-host');
  expect(save.parentNode.getAttribute('data-help')).toContain('一致');
  expect(save.getAttribute('aria-keyshortcuts')).toBe('Control+s Meta+s');
  expect(deepText(panel())).toContain('Ctrl/⌘+S 保存');
  expect(btn('重新读取详情')).toBeUndefined(); expect(btn('仅创建')).toBeUndefined();
  editorInput(node, '编辑后'); expect(save.disabled).toBe(false); expect(save.parentNode.getAttribute('data-help')).toBe(null);
  await btn('撤销').onclick(); expect(save.disabled).toBe(true);
  await btn('重做').onclick(); expect(save.disabled).toBe(false);
  editorInput(node, rows[0].content); expect(save.disabled).toBe(true);
  parentSelect().value = '900'; parentSelect().onchange(); expect(save.disabled).toBe(false);
  parentSelect().value = '1'; parentSelect().onchange(); expect(save.disabled).toBe(true);
  await btn('移除引用').onclick(); expect(save.disabled).toBe(false);
  await btn('恢复已保存引用').onclick(); expect(save.disabled).toBe(true);
  editorInput(node, '保存后'); await save.onclick(); expect(save.disabled).toBe(true);
  await btn('撤销').onclick(); expect(save.disabled).toBe(false);
  await btn('重做').onclick(); expect(save.disabled).toBe(true);
  const before = calls.length; await save.onclick(); expect(calls).toHaveLength(before);
});

const saveKey = (props = {}) => editorEvent(panel(), 'keydown', { target: editor(), key: 's', ctrlKey: true, ...props });
test('Ctrl/⌘+S 只保存可编辑详情，干净/忙碌时不请求，失败可重试且不发射', async () => {
  await openInputs(); await openDraft();
  expect(saveKey().defaultPrevented).toBe(true); expect(calls).toHaveLength(0);
  editorInput(editor(), '组合键保存');
  const delayed = deferred(); intercept = (_path, body) => body?.method === 'draft.update' ? delayed.promise : null;
  expect(saveKey({ key: 'S', ctrlKey: false, metaKey: true }).defaultPrevented).toBe(true);
  expect(btn('保存').disabled).toBe(true); expect(saveKey().defaultPrevented).toBe(true); expect(calls).toHaveLength(1);
  delayed.resolve({ ok: false, json: async () => ({ error: '版本冲突' }) });
  await until(() => !btn('保存').disabled);
  expect(editor().value).toBe('组合键保存'); expect(deepText(panel())).toContain('复制编辑内容，再刷新页面');
  intercept = null; saveKey(); await until(() => btn('保存').disabled && !editor().disabled);
  expect(calls.map(call => call.method)).toEqual(['draft.update', 'draft.update']);
  expect(calls.at(-1).params.expected_revision).toBe(3);
  await btn('← 返回历史输入').onclick(); expect(saveKey().defaultPrevented).toBe(false);
  await openDraft(); const oldPanel = panel(); activateDetailView({ view: 'overview' });
  expect(editorEvent(oldPanel, 'keydown', { key: 's', ctrlKey: true }).defaultPrevented).toBe(false);
  expect(calls).toHaveLength(2);
});

test('保存快捷键忽略输入法和其他组合，普通 Enter 与发射组合键不创建 Worker', async () => {
  await openInputs(); await openDraft(); editorInput(editor(), '快捷键编辑');
  for (const props of [{ isComposing: true }, { keyCode: 229 }]) expect(saveKey(props).defaultPrevented).toBe(true);
  for (const props of [{ altKey: true }, { shiftKey: true }, { ctrlKey: false }, { key: 'Enter' }, { key: 'Enter', shiftKey: true }])
    expect(saveKey(props).defaultPrevented).toBe(false);
  editorEvent(editor(), 'compositionstart'); expect(btn('保存').disabled).toBe(true);
  saveKey(); expect(calls).toHaveLength(0);
  editorEvent(editor(), 'compositionend'); expect(btn('保存').disabled).toBe(false);
  saveKey(); await until(() => !editor().disabled);
  expect(calls.map(call => call.method)).toEqual(['draft.update']);
  await openHistory({ item: { kind: 'input', id: 2 } }); expect(saveKey().defaultPrevented).toBe(false);
});

test('发射 ACK 后状态读取失败保持锁定原文与引用，不重提成功请求', async () => {
  await openInputs(); await openDraft(); editorInput(editor(), 'ACK 后原文'); await btn('提交指令').onclick();
  intercept = path => path === '/api/input/draft/1' ? Promise.reject(new Error('详情离线')) : null;
  await btn('刷新提交状态').onclick();
  expect(dom.location.hash).toBe('#input-draft-1'); expect(editor()).toBeNull();
  expect(deepText(panel())).toContain('ACK 后原文'); expect(deepText(panel())).toContain('当时所见');
  expect(deepText(panel())).toContain('读取失败：详情离线'); expect(deepText(panel())).not.toContain('操作失败');
  expect(btn('提交指令')).toBeUndefined(); expect(btn('保存')).toBeUndefined();
  expect(calls.map(call => call.method)).toEqual(['draft.update', 'input.emit']);
});

test('发射后迟到状态读取不能把返回列表或离页用户拉回来', async () => {
  await openInputs(); await openDraft(); await btn('提交指令').onclick(); const late = deferred();
  intercept = path => path === '/api/input/draft/1' ? late.promise : null;
  const loading = btn('刷新提交状态').onclick(); await until(() => reads.filter(path => path.endsWith('/api/input/draft/1')).length === 2);
  expect(editor()).toBeNull(); await btn('← 返回历史输入').onclick();
  late.resolve(json(rows[0])); await loading;
  expect(dom.location.hash).toBe('#drafts'); expect(panel().hidden).toBe(true); expect(calls.map(call => call.method)).toEqual(['input.emit']);
});

test('追加草稿保持真实目标、暂存版本和条件，不造 O 或静默改投父', async () => {
  rows[0] = fixture('draft', 1, { mode: 'append', target_id: 501, target_worker_number: 'W99', references: [] });
  await openInputs(); await openDraft(); expect(deepText(panel())).toContain('W99');
  expect(panel().querySelector('[aria-label="草稿父 Worker"]')).toBeNull();
  expect(panel().querySelector('[aria-label="独占开发：静息后开始，直到本轮交付收口"]')).toBeNull();
  editorInput(editor(), '追加正文'); await btn('保存').onclick();
  expect(calls.at(-1).params).toMatchObject({ mode: 'append', target_id: 501, expected_revision: 3 });
  await btn('提交追加').onclick(); expect(calls.at(-1).method).toBe('input.emit'); expect(editor()).toBeNull();
  expect(deepText(panel())).toContain('追加目标：W99'); expect(deepText(panel())).not.toContain('原始指令 O');
  rows[0].dispatch = { state: 'succeeded', message_id: 888, append_number: 'A99-2' }; await btn('刷新提交状态').onclick();
  expect(deepText(panel())).toContain('A99-2'); expect(dom.location.hash).toBe('#input-draft-1');
});

test('多个条件与独占保存同一版本，Worker 目录分页和编号使用真实身份', async () => {
  await openInputs(); await openDraft(); const conditions = panel().querySelector('.emission-conditions');
  expect(conditions.hidden).toBe(false);
  let pages = 0; intercept = (path, _body, route) => path === '/api/workers' ? (++pages === 1
    ? json({ tasks: [{ id: 903, worker_number: 'W230', goal: '第一份' }], has_more: true, cursor: 900 })
    : json({ tasks: [{ id: 203, worker_number: 'W17', goal: '更早重构' }], has_more: false })) : null;
  await btn('加载 Worker', conditions).onclick(); await btn('加载更早 Worker', conditions).onclick();
  expect(reads.at(-1)).toContain('before=900');
  const select = conditions.querySelector('[aria-label="条件 Worker"]'); select.value = '203';
  await btn('添加 Worker 条件', conditions).onclick();
  conditions.querySelector('[aria-label="等待事件"]').value = 'worker_settled'; await btn('添加 Worker 条件', conditions).onclick();
  conditions.querySelector('[aria-label="等待目标树彻底静息后执行"]').checked = true;
  const exclusive = conditions.querySelector('[aria-label="独占开发：静息后开始，直到本轮交付收口"]');
  exclusive.checked = true; exclusive.onchange();
  await btn('按条件提交').onclick();
  expect(calls[0].params).toMatchObject({ conditions: [{ kind: 'worker_merged', worker_id: 203 }, { kind: 'worker_settled', worker_id: 203 }, { kind: 'parent_quiet' }], exclusive: true });
  expect(calls[1].params.expected_revision).toBe(4); expect(calls[1].params).not.toHaveProperty('conditions');
  expect(editor()).toBeNull(); expect(deepText(panel())).toContain('W17');
});

test('草稿分类互斥、摘要常显，切换作废旧分页且不应用未提交关键词', async () => {
  rows.push(fixture('draft', 3, { mode: 'append', target_id: 777, target_worker_number: 'W27', conditions: [{ kind: 'worker_merged', worker_id: 41, worker_number: 'W19' }], dispatch: { state: 'waiting_conditions' } }));
  pageCursor = 'order-next'; await openInputs();
  const mode = value => form().querySelector(`[data-mode="${value}"]`);
  expect(mode('order').getAttribute('aria-pressed')).toBe('true'); expect(mode('append').getAttribute('aria-pressed')).toBe('false');
  expect(form().querySelector('[data-mode="management"]')).toBeNull(); expect(form().querySelectorAll('select')).toHaveLength(1);
  expect(text()).toContain('父 main · 条件：未设置');
  const stale = deferred(); intercept = (path, _body, url) => path === '/api/inputs' && url.searchParams.has('cursor') ? stale.promise : null;
  const more = btn('加载更多').onclick(); form().querySelector('input').value = '尚未提交的新关键词';
  await mode('append').onclick();
  expect(mode('order').getAttribute('aria-pressed')).toBe('false'); expect(mode('append').getAttribute('aria-pressed')).toBe('true');
  let query = new URL(reads.at(-1), 'http://localhost').searchParams;
  expect(query.get('view')).toBe('drafts'); expect(JSON.parse(query.get('modes'))).toEqual(['append']); expect(query.get('q')).toBe(''); expect(query.has('cursor')).toBe(false);
  stale.resolve(json({ items: [fixture('draft', 99, { content: '过时工作分类' })], next_cursor: 'stale' })); await more;
  expect(root().querySelectorAll('.input-record').map(card => card.dataset.input)).toEqual(['draft:3']);
  expect(text()).toContain('追加到 W27 · 条件：W19 本轮合入 main'); expect(text()).toContain('等待条件'); expect(text()).not.toContain('过时工作分类');
  const count = reads.length; await mode('append').onclick(); expect(reads).toHaveLength(count);
});

test('追加成功从草稿列表移除，真实消息和源草稿往返始终只读，不伪造 O 或已处理', async () => {
  rows[0] = fixture('draft', 1, { mode: 'append', target_id: 777, target_worker_number: 'W27', references: [] });
  await openInputs(); await openDraft(); await btn('提交追加').onclick();
  rows[0].dispatch = { state: 'succeeded', message_id: 8, append_number: 'A27-4', worker_id: 777 };
  rows.push(fixture('message', 8, { content: '真实已入箱正文', append_number: 'A27-4', task_id: 777, task_worker_number: 'W27', source_draft_id: 1 }));
  await btn('刷新提交状态').onclick(); expect(root().querySelectorAll('.input-record')).toHaveLength(0);
  await btn('查看已入箱追加原文').onclick();
  expect(ui.view.id).toBe('inputs'); expect(dom.location.hash).toBe('#input-message-8'); expect(editor()).toBeNull();
  expect(text()).toContain('真实已入箱正文'); expect(text()).toContain('不代表这条消息已处理'); expect(text()).not.toContain('O8');
  await btn('查看提交草稿 #1 · 条件与独占').onclick();
  expect(ui.view.id).toBe('drafts'); expect(dom.location.hash).toBe('#input-draft-1'); expect(editor()).toBeNull();
  expect(calls.map(call => call.method)).toEqual(['input.emit']);
});

const mainChild = (id, extra = {}) => ({ id, parent_id: 42, worker_number: `W${id + 500}`, task_kind: 'order', status: 'running', integration: 'none', ...extra });
const mainParents = () => json({ items: [{ id: 42, branch: 'main' }, { id: 900, branch: 'feature/old' }] });
const childPage = (items, has_more = false) => json({ children: { items, has_more, cursor: items.at(-1)?.id ?? 0 } });
const importButton = node => btn('等当前所有Worker开发完', node);

test('快捷导入完整 main 直接子项分页，不限运行状态，保留去重条件且不发射或授权合并', async () => {
  const initial = [{ kind: 'worker_settled', worker_id: 102 }, { kind: 'worker_merged', worker_id: 104 }, { kind: 'parent_quiet' }];
  rows[0].conditions = initial; rows[0].exclusive = true;
  await openInputs(); await openDraft(); const conditions = panel().querySelector('.emission-conditions');
  expect(conditions.hidden).toBe(false); expect(btn('执行条件设置 · 3 项 · 独占').getAttribute('aria-expanded')).toBe('true');
  intercept = (path, _body, route) => path === '/api/input-parents' ? mainParents()
    : path === '/api/worker/42/relations' ? (route.searchParams.get('after') === '0'
      ? childPage([mainChild(101, { status: 'awaiting_acceptance', integration: 'merged' }), mainChild(102, { status: 'paused' }), mainChild(103, { task_kind: 'management' }), mainChild(104)], true)
      : childPage(['queued', 'awaiting', 'waiting', 'awaiting_acceptance', 'failed', 'cancelled', 'completed'].map((status, index) => mainChild(105 + index, { status, integration: 'pending' })))) : null;
  const shortcut = importButton(conditions); expect(shortcut.classList.contains('agent-call')).toBe(false);
  expect(shortcut.getAttribute('data-help')).toContain('不授权或执行合并');
  await shortcut.onclick(); expect(calls).toHaveLength(0);
  expect(reads.at(-1)).toContain('/api/worker/42/relations?after=104&limit=100');
  expect(reads.some(path => path.includes('/api/workers'))).toBe(false);
  expect(deepText(conditions)).toContain('W602：本轮成果已合入 main');
  expect(deepText(conditions)).not.toContain('W601：'); expect(deepText(conditions)).not.toContain('W603：');
  expect(deepText(conditions)).toContain('已导入 8 个条件');
  expect(btn('保存').disabled).toBe(false); await shortcut.onclick(); expect(deepText(conditions)).toContain('已导入 0 个条件');
  await btn('保存').onclick(); expect(calls).toHaveLength(1);
  expect(calls[0].params).toMatchObject({ exclusive: true, conditions: [initial[0], initial[1], ...[102, 105, 106, 107, 108, 109, 110, 111].map(worker_id => ({ kind: 'worker_merged', worker_id })), initial[2]] });
  expect(btn('保存').disabled).toBe(true);
});

test('快捷导入排除已合并未验收和无代码已交付，仍保留待合并及新轮开发', async () => {
  const form = createEmissionConditions();
  intercept = path => path === '/api/input-parents' ? mainParents() : path === '/api/worker/42/relations' ? childPage([
    mainChild(101, { status: 'awaiting_acceptance', integration: 'merged' }),
    mainChild(102, { status: 'awaiting_acceptance' }),
    mainChild(103, { status: 'completed' }),
    mainChild(104, { status: 'awaiting_acceptance', integration: 'pending' }),
    mainChild(105, { status: 'running' }),
  ]) : null;
  await importButton(form.node).onclick();
  expect(form.collect().conditions).toEqual([104, 105].map(worker_id => ({ kind: 'worker_merged', worker_id })));
  expect(calls).toHaveLength(0);
});

test('快捷导入空集合保留条件，16项上限含独占隐含静息，拒绝整批不截断', async () => {
  const initial = Array.from({ length: 15 }, (_, i) => ({ kind: 'worker_merged', worker_id: 200 + i })); let changes = 0;
  const form = createEmissionConditions({ conditions: initial, exclusive: true, onChange: () => changes++ });
  intercept = path => path === '/api/input-parents' ? mainParents() : path === '/api/worker/42/relations' ? childPage([]) : null;
  await importButton(form.node).onclick(); expect(deepText(form.node)).toContain('当前没有尚未走完合并环节');
  expect(form.collect()).toEqual({ conditions: initial, exclusive: true }); expect(changes).toBe(0);
  intercept = path => path === '/api/input-parents' ? mainParents() : path === '/api/worker/42/relations' ? childPage([mainChild(100)]) : null;
  await importButton(form.node).onclick(); expect(deepText(form.node)).toContain('超过 16 项上限，未导入');
  expect(form.collect()).toEqual({ conditions: initial, exclusive: true }); expect(changes).toBe(0); expect(calls).toHaveLength(0);
  const append = createEmissionConditions({ conditions: initial, mode: 'append' });
  await importButton(append.node).onclick(); expect(append.collect().conditions).toHaveLength(16); expect(append.validate()).toBe('');
  expect(append.collect().exclusive).toBe(false);
});

test('快捷导入分页失败或不推进、身份不兼容时不保留半份结果且允许重试', async () => {
  const initial = [{ kind: 'worker_settled', worker_id: 201 }];
  const form = createEmissionConditions({ conditions: initial });
  for (const bad of [
    { ok: false, json: async () => ({ error: 'second page failed' }) },
    json({ children: { items: [mainChild(101)], has_more: true, cursor: 100 } }),
    childPage([mainChild(101, { parent_id: 100 })]),
    childPage([mainChild(101, { integration: null })]),
  ]) {
    intercept = (path, _body, route) => path === '/api/input-parents' ? mainParents() : path === '/api/worker/42/relations'
      ? route.searchParams.get('after') === '0' ? childPage([mainChild(100)], true) : bad : null;
    await importButton(form.node).onclick(); expect(deepText(form.node)).toContain('导入失败');
    expect(form.collect().conditions).toEqual(initial); expect(importButton(form.node).disabled).toBe(false);
  }
  intercept = path => path === '/api/input-parents' ? json({ items: [{ id: 900, branch: 'feature/old' }] }) : null;
  await importButton(form.node).onclick(); expect(deepText(form.node)).toContain('无法确认 main'); expect(form.collect().conditions).toEqual(initial);
  intercept = path => path === '/api/input-parents' ? mainParents() : path === '/api/worker/42/relations' ? childPage([mainChild(100)]) : null;
  await importButton(form.node).onclick(); expect(form.collect().conditions).toHaveLength(2);
});

test('快捷导入单飞并保护在途保存、离页和跨项目的迟到结果', async () => {
  for (const invalidate of ['save', 'leave', 'project']) {
    const late = deferred(); let active = true, changes = 0;
    const projectPath = dom.location.pathname;
    const form = createEmissionConditions({ ownsPage: () => active && dom.location.pathname === projectPath, onChange: () => changes++ });
    intercept = path => path === '/api/input-parents' ? mainParents() : path === '/api/worker/42/relations' ? late.promise : null;
    reads.length = 0; const shortcut = importButton(form.node), importing = shortcut.onclick();
    await until(() => reads.some(path => path.includes('/relations')));
    expect(shortcut.disabled).toBe(true); expect(shortcut.parentNode.getAttribute('data-help')).toContain('正在读取');
    await shortcut.onclick(); expect(reads.filter(path => path.includes('/relations'))).toHaveLength(1);
    expect(form.node.querySelector('[aria-label="等待事件"]').disabled).toBe(true);
    if (invalidate === 'save') { form.setBusy(true); form.setBusy(false); }
    if (invalidate === 'leave') active = false;
    if (invalidate === 'project') dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/';
    late.resolve(childPage([mainChild(100)])); await importing;
    expect(form.collect().conditions).toEqual([]); expect(changes).toBe(0); expect(calls).toHaveLength(0);
    if (invalidate === 'save') expect(deepText(form.node)).toContain('导入已取消');
    dom.location.pathname = projectPath;
  }
  const form = createEmissionConditions(); form.setBusy(true); reads.length = 0;
  await importButton(form.node).onclick(); expect(reads).toHaveLength(0);
  expect(importButton(form.node).parentNode.getAttribute('data-help')).toContain('输入已提交');
});

test('独立草稿条件默认展开，收起不发射且保留未保存选项并提示条件授权', async () => {
  await openInputs(); await openDraft();
  const conditions = panel().querySelector('.emission-conditions'), toggle = btn('执行条件设置');
  expect(conditions.hidden).toBe(false); expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.getAttribute('aria-controls')).toBe(conditions.id);
  expect(btn('保存').disabled).toBe(true);
  expect(panel().querySelector('.emission-advanced-body').hidden).toBe(true);
  expect(panel().querySelector('.input-runtime-settings').open).not.toBe(true);
  expect(calls).toHaveLength(0);
  const quiet = conditions.querySelector('[aria-label="等待目标树彻底静息后执行"]'); quiet.checked = true; quiet.onchange();
  expect(btn('保存').disabled).toBe(false); expect(toggle.textContent).toContain('1 项');
  const emit = btn('按条件提交'); expect(emit.classList.contains('agent-call')).toBe(true); expect(emit.getAttribute('data-help')).toContain('token');
  await toggle.onclick(); expect(conditions.hidden).toBe(true); expect(quiet.checked).toBe(true); expect(calls).toHaveLength(0);
  await btn('保存').onclick(); expect(calls[0].params.conditions).toEqual([{ kind: 'parent_quiet' }]);
  expect(conditions.hidden).toBe(true); expect(btn('保存').disabled).toBe(true);
  await toggle.onclick(); quiet.checked = false; quiet.onchange(); expect(btn('提交指令')).toBeTruthy();
});

test('提交与条件入口相邻同组，次要草稿动作独立且不改变提交保护', async () => {
  await openInputs(); await openDraft();
  const group = panel().querySelector('.input-submit-actions');
  expect(btn('提交指令', group)).toBeTruthy(); expect(btn('执行条件设置', group)).toBeTruthy();
  expect(group.querySelectorAll('button')).toHaveLength(2);
  const secondary = panel().querySelector('.input-secondary-actions');
  expect(btn('保存', secondary)).toBeTruthy(); expect(btn('删除草稿', secondary)).toBeTruthy();
  expect(deepText(secondary)).toContain('运行设置');
});

test('已有条件卡片与高级设置保留独占隐含静息，收起、移除及单飞安全', async () => {
  let changes = 0;
  const form = createEmissionConditions({ conditions: [{ kind: 'worker_merged', worker_id: 201 }, { kind: 'parent_quiet' }], exclusive: true, onChange: () => changes++ });
  const settings = form.node.querySelector('.emission-settings'), configured = form.node.querySelector('.emission-configured');
  const advanced = settings.querySelector('.emission-advanced-body'), toggle = btn('展开高级设置：静息与独占', settings);
  expect(advanced.hidden).toBe(true); expect(toggle.getAttribute('aria-controls')).toBe(advanced.id);
  expect(configured.querySelectorAll('.emission-condition-row')).toHaveLength(3);
  expect(deepText(configured)).toContain('已设条件 · 2 项 · 独占');
  expect(settings.querySelector('.emission-advanced-summary').textContent).toContain('隐含静息');
  await toggle.onclick(); expect(advanced.hidden).toBe(false); expect(toggle.getAttribute('aria-expanded')).toBe('true');
  await toggle.onclick(); expect(advanced.hidden).toBe(true); expect(changes).toBe(0);
  await btn('移除静息条件', configured).onclick();
  expect(form.collect()).toEqual({ conditions: [{ kind: 'worker_merged', worker_id: 201 }], exclusive: true });
  expect(deepText(configured)).toContain('已设条件 · 2 项 · 独占');
  form.setBusy(true); const close = btn('关闭独占', configured); expect(close.disabled).toBe(true);
  expect(close.parentNode.getAttribute('data-help')).toContain('条件不能更改');
  await close.onclick(); expect(form.collect().exclusive).toBe(true);
  await toggle.onclick(); expect(advanced.hidden).toBe(true);
  form.setBusy(false); await close.onclick(); expect(form.collect().exclusive).toBe(false);
  await btn('移除条件', configured).onclick(); expect(deepText(configured)).toContain('尚未设置条件');
  expect(configured.querySelectorAll('.emission-condition-row')).toHaveLength(0); expect(changes).toBe(3);
  const append = createEmissionConditions({ mode: 'append', exclusive: true });
  expect(btn('展开高级设置：静息等待', append.node)).toBeTruthy();
  expect(append.node.querySelector('.emission-exclusive-card')).toBeNull();
  expect(append.collect().exclusive).toBe(false);
});

test('已有条件草稿默认展开，发射明确遵守已保存条件', async () => {
  rows[0].conditions = [{ kind: 'parent_quiet' }];
  await openInputs(); await openDraft();
  expect(panel().querySelector('.emission-conditions').hidden).toBe(false);
  expect(btn('执行条件设置 · 1 项').getAttribute('aria-expanded')).toBe('true');
  expect(btn('保存').disabled).toBe(true);
  await btn('按条件提交').onclick();
  expect(calls.map(call => call.method)).toEqual(['input.emit']);
  expect(rows[0].conditions).toEqual([{ kind: 'parent_quiet' }]);
});

test('条件数量包含独占隐含的静息，避免授权第17项，错误保留草稿', async () => {
  rows[0].conditions = Array.from({ length: 16 }, (_, i) => ({ kind: 'worker_merged', worker_id: 901 + i }));
  await openInputs(); await openDraft();
  const exclusive = panel().querySelector('[aria-label="独占开发：静息后开始，直到本轮交付收口"]');
  exclusive.checked = true; exclusive.onchange(); await btn('保存').onclick();
  expect(calls).toHaveLength(0); expect(text()).toContain('含独占隐含的静息条件'); expect(editor().value).toBe(rows[0].content);
  await btn('移除条件').onclick(); await btn('保存').onclick();
  expect(calls.at(-1).params.conditions).toHaveLength(15); expect(calls.at(-1).params.exclusive).toBe(true);
});

test('未满足条件可经确认撤销，未知/执行中保守禁用；撤销失败保留原挂载', async () => {
  rows[0].dispatch = { state: 'waiting_conditions', reason: '等待 W777 合入 main' };
  await openInputs(); await openDraft(); expect(editor()).toBeNull(); expect(deepText(panel())).toContain('等待 W777');
  const cancelling = btn('撤销提交').onclick(); await until(() => dialogButton(dom, '撤销提交'));
  await dialogButton(dom, '撤销提交').onclick(); await cancelling;
  expect(calls.at(-1)).toEqual({ method: 'input.emission_cancel', params: { draft_id: 1, expected_revision: 3 } });
  expect(editor().value).toBe(rows[0].content);
  for (const state of ['dispatching','unknown','succeeded']) {
    activateDetailView({ view: 'overview' }); rows[0].dispatch = { state }; await openInputs(); await openDraft();
    expect(btn('撤销提交').disabled).toBe(true); const before = calls.length;
    await btn('撤销提交').onclick(); expect(calls).toHaveLength(before); expect(editor()).toBeNull();
  }
});

test('发射收据没有最新revision时必须刷新，不用保存前版本猜测取消CAS', async () => {
  await openInputs(); await openDraft(); await btn('提交指令').onclick();
  expect(btn('撤销提交').disabled).toBe(true); expect(btn('撤销提交').parentNode.getAttribute('data-help')).toContain('不猜测版本');
  const before = calls.length; await btn('撤销提交').onclick(); expect(calls).toHaveLength(before);
  await btn('刷新提交状态').onclick(); expect(btn('撤销提交').disabled).toBe(false);
});

test('独占释放仅按安全投影启用；关联Input后仍保持草稿释放入口，不把未知读面当授权', async () => {
  rows[0].exclusive = true; rows[0].dispatch = { state: 'succeeded', input_id: 2 };
  await openInputs(); await openDraft(); expect(btn('释放独占').disabled).toBe(true);
  rows[0].dispatch.exclusive_active = true; rows[0].dispatch.can_release_exclusive = true;
  await btn('刷新提交状态').onclick(); expect(btn('释放独占').disabled).toBe(false);
  const releasing = btn('释放独占').onclick(); await until(() => dialogButton(dom, '释放独占'));
  await dialogButton(dom, '释放独占').onclick(); await releasing;
  expect(calls.at(-1)).toEqual({ method: 'input.exclusive_release', params: { draft_id: 1, expected_revision: 3 } });
  expect(btn('释放独占').disabled).toBe(true); expect(calls.some(row => row.method === 'worker.cancel')).toBe(false);
});

test('独占active不覆盖明确can_release=false，dispatching即使错误投影true仍不可释放', async () => {
  for (const dispatch of [{ state: 'succeeded', exclusive_active: true, can_release_exclusive: false },
    { state: 'dispatching', exclusive_active: true, can_release_exclusive: true }]) {
    rows[0].exclusive = true; rows[0].dispatch = dispatch;
    await openInputs({ item: { kind: 'draft', id: 1 } });
    await btn('刷新提交状态').onclick(); expect(btn('释放独占').disabled).toBe(true);
    await btn('释放独占').onclick(); expect(calls).toHaveLength(0);
  }
});

test('独占草稿读取实际Input后保留关联；返回草稿必须读新版本再释放', async () => {
  rows[0].exclusive = true; rows[0].dispatch = { state: 'succeeded', input_id: 2, exclusive_active: true };
  rows[1].source_draft_id = 1;
  await openInputs(); await openDraft(); await btn('查看已创建原文 O2').onclick();
  expect(editor()).toBeNull(); expect(deepText(panel())).toContain('此原文关联提交草稿 #1');
  expect(btn('释放独占')).toBeUndefined(); expect(btn('查看提交草稿 #1 · 条件与独占').classList.contains('agent-call')).toBe(false);
  rows[0].revision = 9;
  await btn('查看提交草稿 #1 · 条件与独占').onclick(); expect(btn('释放独占').disabled).toBe(false);
  const releasing = btn('释放独占').onclick(); await dialogButton(dom, '释放独占');
  await dialogButton(dom, '释放独占').onclick(); await releasing;
  expect(calls.at(-1)).toEqual({ method: 'input.exclusive_release', params: { draft_id: 1, expected_revision: 9 } });
});

test('只读Input没有关联或服务端明确关联歧义时，不猜草稿也不覆盖null', async () => {
  await openHistory(); ui.inputsPage.emissionSources.set(2, 1); rows[1].source_draft_id = null;
  await openInputs({ item: { kind: 'input', id: 2 } });
  expect(deepText(panel())).not.toContain('此原文关联');
  expect(panel().querySelectorAll('button').some(node => node.textContent.includes('提交草稿'))).toBe(false);
  expect(reads.some(url => /\/api\/input\/draft\//.test(url))).toBe(false); expect(calls).toHaveLength(0);
});

test('正在执行的草稿预约保持不可取消；失败核验也不回退为可编辑或自动重放', async () => {
  rows[0].hook_mount = { parent_id: 1, hook_id: 'started', state: 'running' };
  intercept = path => path.endsWith('/hooks') ? json({ version: 1, revision: 'hooks-live', mounts: [{ id: 'started', state: 'running', editable: false, locked: false, reason: '动作已经开始' }] }) : null;
  await openInputs(); await openDraft(); await until(() => deepText(panel()).includes('动作已经开始'));
  expect(btn('取消预约挂载').disabled).toBe(true); await btn('取消预约挂载').onclick(); expect(calls).toHaveLength(0); expect(editor()).toBeNull();
});
