import { test, expect, beforeEach, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';
import { makeWorld } from './dom-world.js';

const json = data => ({ ok: true, json: async () => structuredClone(data) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reference = { version: 1, kind: 'text', target: {}, label: '原始引用', quote: '当时所见', location: {}, captured_at: '2026-10-01T00:00:00Z' };
const fixture = (kind = 'draft', id = 1, extra = {}) => ({ kind, id, content: kind === 'draft' ? '尚未执行的想法' : '已经发送的原始输入', content_truncated: false,
  created_at: '2026-10-01T00:00:00Z', task_id: kind === 'input' ? 20 : null, parent_id: 1, branch: 'main',
  status: kind === 'draft' ? 'draft' : 'awaiting_acceptance', integration: kind === 'draft' ? 'none' : 'merged',
  merge_status: kind === 'draft' ? 'none' : 'merged', revision: kind === 'draft' ? 3 : null, references: [reference], ...extra });
const parents = [{ id: 1, branch: 'main', goal: '主干' }, { id: 900, branch: 'feature/old', goal: '不在 overview 的旧父 Task' }];
let rows, intercept, pageCursor;
const calls = [], reads = [], world = makeWorld();
const dom = installDom({ fetch: async (url, options = {}) => {
  const route = new URL(String(url), 'http://localhost'), path = route.pathname.replace(/^\/p\/[^/]+/, '');
  const body = options.body ? JSON.parse(options.body) : null;
  if (body && ['draft.update', 'draft.remove', 'say.submit'].includes(body.method)) {
    calls.push(body); const intercepted = intercept?.(path, body, route); if (intercepted) return intercepted;
    const { method, params } = body, old = rows.find(row => row.kind === 'draft' && row.id === (params.id ?? params.draft_id));
    if (params.expected_revision !== old?.revision) return { ok: false, json: async () => ({ error: 'revision conflict' }) };
    if (method === 'draft.update') {
      Object.assign(old, params, { revision: old.revision + 1 });
      if (params.branch) old.parent_id = parents.find(parent => parent.branch === params.branch)?.id;
      return json(old);
    }
    rows = rows.filter(row => row !== old);
    if (method === 'say.submit') { rows.unshift(fixture('input', 3, { content: old.content, task_id: 33, status: params.start ? 'queued' : 'created', merge_status: 'none', integration: 'none' })); return json({ id: 3, task: { id: 33 } }); }
    return json({ id: old.id });
  }
  if (path === '/api/input-parents' || path === '/api/inputs' || path.startsWith('/api/input/')) {
    reads.push(String(url)); const intercepted = intercept?.(path, null, route); if (intercepted) return intercepted;
    if (path === '/api/input-parents') return json({ items: parents });
    if (path === '/api/inputs') {
      const q = route.searchParams.get('q') ?? '', status = route.searchParams.get('status'), merge = route.searchParams.get('integration');
      return json({ items: rows.filter(row => row.content.includes(q) && (!status || row.status === status) && (!merge || row.merge_status === merge)), next_cursor: pageCursor });
    }
    const [, kind, id] = /\/api\/input\/(draft|input)\/(\d+)/.exec(path);
    return json(rows.find(row => row.kind === kind && row.id === Number(id)));
  }
  return world.fetchImpl(url, options);
} });
const { openInputs } = await import('../../src/ui/web/assets/render-inputs.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { boot } = await import('../../src/ui/web/assets/app.js');
await boot();
const root = () => dom.node('detail');
const text = () => deepText(root());
const panel = () => root().querySelector('.input-detail');
const btn = (label, parent = root()) => parent.querySelectorAll('button').find(node => node.textContent === label || node.getAttribute('aria-label')?.endsWith(`：${label}`));
const openDraft = () => btn('编辑与发射').onclick();
const form = () => root().querySelector('.inputs-filters');
const editor = () => panel().querySelector('textarea');
const parentSelect = () => panel().querySelector('select');
beforeEach(() => {
  rows = [fixture(), fixture('input', 2)]; intercept = null; pageCursor = null; calls.length = 0; reads.length = 0;
  activateDetailView({ view: 'overview' }); dom.location.pathname = '/';
});
afterAll(() => dom.restore());

test('工作导航 #inputs、输入区入口、独立状态与只读原文，轮询不覆盖编辑', async () => {
  await dom.node('inputs-open').onclick();
  expect(dom.location.hash).toBe('#inputs'); expect(dom.node('inputs-open').getAttribute('aria-current')).toBe('page');
  expect(dom.node('view-context').textContent).toBe('工作');
  expect(root().querySelector('[aria-label="Worker 状态：待验收"]')).toBeTruthy(); expect(root().querySelector('[aria-label="合并状态：已合并"]')).toBeTruthy();
  await btn('查看原文').onclick(); expect(panel().querySelector('textarea')).toBe(null); expect(deepText(panel())).toContain('已发送原文只读');
  await openDraft(); const node = editor(); node.value = '还没保存'; const before = reads.length;
  await dom.intervalFor(1500)(); await dom.intervalFor(3000)();
  expect(editor()).toBe(node); expect(node.value).toBe('还没保存'); expect(reads.length).toBe(before);
  await btn('刷新列表').onclick(); expect(editor()).toBe(node); expect(node.value).toBe('还没保存');
  dom.location.hash = '#workers'; await dom.fire('hashchange');
  await dom.node('input-history').onclick(); expect(dom.location.hash).toBe('#inputs');
});

test('紧凑条目只有一个详情入口，等高摘要不内嵌操作或引用，沿用资源页样式', async () => {
  rows = [fixture('draft', 1, { content: '短句' }), fixture('input', 2, { content: '\n\n' + '长段落\n'.repeat(200), content_truncated: true }),
    fixture('input', 3, { content: '', status: 'missing', merge_status: 'missing' })];
  await openInputs();
  expect(root().querySelector('.resource-hero')).toBeTruthy(); expect(root().querySelector('.resource-tools')).toBeTruthy();
  const cards = root().querySelectorAll('.input-record');
  expect(cards.map(card => card.querySelectorAll('button').length)).toEqual([1, 1, 1]);
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
  expect(dom.location.hash).toBe('#input-draft-1'); expect(dom.node('view-title').textContent).toBe('暂存输入 #1');
  expect(root().querySelector('.inputs-browse').hidden).toBe(true); expect(root().querySelector('.input-detail-view').hidden).toBe(false);
  expect(document.activeElement).toBe(panel());
  editor().value = '未保存的本地编辑'; const node = editor(), before = reads.length;
  await btn('← 返回历史输入').onclick();
  expect(dom.location.hash).toBe('#inputs'); expect(root().querySelector('.inputs-browse').hidden).toBe(false);
  expect(root().querySelector('.input-detail-view').hidden).toBe(true); expect(panel().hidden).toBe(true);
  expect(form().querySelector('input')).toBe(search); expect(search.value).toBe('想法'); expect(reads.length).toBe(before);
  expect(root().scrollTop).toBe(240); expect(document.activeElement).toBe(record.querySelector('button')); expect(btn('加载更多').hidden).toBe(false);
  await openDraft(); expect(editor()).toBe(node); expect(editor().value).toBe('未保存的本地编辑'); expect(reads.length).toBe(before);
  await openInputs(); expect(panel().hidden).toBe(true);
});

test('详情深链接、浏览器后退与迟到读取，切换草稿取消时恢复原路由和编辑', async () => {
  dom.location.hash = '#input-input-2'; await dom.fire('hashchange');
  expect(deepText(panel())).toContain('原始输入 #2'); expect(panel().hidden).toBe(false);
  dom.location.hash = '#inputs'; await dom.fire('hashchange'); expect(panel().hidden).toBe(true);
  const late = deferred(); intercept = path => path === '/api/input/draft/1' ? late.promise : null;
  const opening = openDraft(); await btn('← 返回历史输入').onclick();
  late.resolve(json(fixture())); await opening; expect(panel().hidden).toBe(true); expect(dom.location.hash).toBe('#inputs');
  intercept = null; await openDraft(); editor().value = '不丢弃';
  dom.location.hash = '#input-input-2'; const switching = dom.fire('hashchange');
  await dialogButton(dom, '取消').onclick(); await switching;
  expect(dom.location.hash).toBe('#input-draft-1'); expect(editor().value).toBe('不丢弃'); expect(dom.node('view-title').textContent).toBe('暂存输入 #1');
  dom.location.hash = '#input-input-2'; const confirmed = dom.fire('hashchange');
  await dialogButton(dom, '放弃编辑').onclick(); await confirmed;
  expect(dom.location.hash).toBe('#input-input-2'); expect(editor()).toBe(null); expect(deepText(panel())).toContain('原始输入 #2');
});

test('正文全库搜索与状态/合并筛选发到服务端，游标分页与失败重试', async () => {
  pageCursor = 'cursor +/opaque'; await openInputs();
  const next = deferred(); let count = 0;
  intercept = (path, _body, route) => {
    if (path !== '/api/inputs') return;
    count++;
    if (route.searchParams.has('cursor')) return next.promise;
  };
  const a = btn('加载更多').onclick(), b = btn('加载更多').onclick(); expect(count).toBe(1);
  expect(new URL(reads.at(-1), 'http://localhost').searchParams.get('cursor')).toBe(pageCursor);
  next.resolve(json({ items: [fixture('input', 9, { content: '更早的记录' })], next_cursor: null })); await Promise.all([a, b]);
  expect(root().querySelectorAll('.input-record')).toHaveLength(3);
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
  expect(calls).toEqual([{ method: 'draft.update', params: { id: 1, expected_revision: 3, content: '修改后的正文\n保留换行', references: [], branch: 'feature/old' } }]);
  expect(editor().value).toBe('修改后的正文\n保留换行'); expect(deepText(panel())).toContain('已保存');
  await btn('发射并开始', panel()).onclick();
  expect(calls.at(-1)).toEqual({ method: 'say.submit', params: { draft_id: 1, expected_revision: 4, start: true } });
  expect(text()).toContain('已发射并开始'); expect(root().querySelectorAll('.input-record')).toHaveLength(2);
  expect(root().querySelectorAll('.input-record').some(card => card.dataset.input === 'draft:1')).toBe(false);
  expect(root().querySelectorAll('.input-record').filter(card => card.dataset.input === 'input:3')).toHaveLength(1);
});

test('仅创建先保存再以新版本发射，不带正文/branch；关联 Task 导航不调用 Agent', async () => {
  await openInputs(); await openDraft(); editor().value = '新正文';
  await btn('仅创建', panel()).onclick();
  expect(calls.map(call => call.method)).toEqual(['draft.update', 'say.submit']);
  expect(calls[0].params).not.toHaveProperty('branch');
  expect(calls[1].params).toEqual({ draft_id: 1, expected_revision: 4, start: false });
  let opened; const restore = registerNavigation({ detail: async id => { opened = id; } });
  try { await btn('查看 Worker #33', panel()).onclick(); expect(opened).toBe(33); } finally { restore(); }
  expect(calls).toHaveLength(2);
});

test('旧草稿或失效父 Task 不回退默认；必须显式重选保存', async () => {
  for (const identity of [{ parent_id: null, branch: null }, { parent_id: 555, branch: 'gone' }]) {
    rows[0] = fixture('draft', 1, { ...identity, revision: null }); activateDetailView({ view: 'overview' }); await openInputs(); await openDraft();
    expect(deepText(panel())).toContain('必须重新选择');
    if (identity.parent_id) expect(parentSelect().value).toBe('missing:555');
    calls.length = 0; await btn('发射并开始', panel()).onclick(); expect(calls).toHaveLength(0);
    parentSelect().value = '1'; await btn('保存', panel()).onclick();
    expect(calls[0].params.branch).toBe('main'); expect(calls[0].params.expected_revision).toBe(null);
  }
});

test('编辑/发射单飞，保存失败保留全部本地编辑并且不发射', async () => {
  await openInputs(); await openDraft(); editor().value = '不能丢的编辑'; parentSelect().value = '900'; await btn('移除引用', panel()).onclick();
  const delayed = deferred(); intercept = (_path, body) => body?.method === 'draft.update' ? delayed.promise : null;
  const first = btn('发射并开始', panel()).onclick();
  await btn('仅创建', panel()).onclick(); await btn('保存', panel()).onclick(); await btn('删除草稿', panel()).onclick();
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
  intercept = (_path, body) => body?.method === 'say.submit' ? Promise.reject(new Error('父分支暂时被冻结')) : null;
  await btn('发射并开始', panel()).onclick();
  expect(editor().value).toBe('已经保存的编辑'); expect(calls.map(call => call.method)).toEqual(['draft.update', 'say.submit']);
  intercept = null; await btn('发射并开始', panel()).onclick();
  expect(calls.map(call => call.method)).toEqual(['draft.update', 'say.submit', 'say.submit']); expect(calls.at(-1).params.expected_revision).toBe(4);
});

test('删除草稿走应用内确认，取消无动作、确认单飞且使用详情版本', async () => {
  await openInputs(); await openDraft();
  const cancelled = btn('删除草稿', panel()).onclick(); expect(deepText(dom.node('modal'))).toContain('无法恢复');
  await dialogButton(dom, '取消').onclick(); await cancelled; expect(calls).toHaveLength(0);
  const removed = btn('删除草稿', panel()).onclick(); await btn('删除草稿', panel()).onclick();
  await dialogButton(dom, '删除草稿').onclick(); await removed;
  expect(calls).toEqual([{ method: 'draft.remove', params: { id: 1, expected_revision: 3 } }]);
  expect(text()).toContain('草稿已删除'); expect(root().querySelectorAll('.input-record')).toHaveLength(1);
});

test('列表查询/详情迟到响应与离页返回身份保护；编辑期间详情迟到不覆盖', async () => {
  const pending = deferred(); intercept = path => path === '/api/inputs' ? pending.promise : null;
  const old = openInputs(); activateDetailView({ view: 'settings' }); root().replaceChildren(document.createTextNode('设置页')); pending.resolve(json({ items: rows, next_cursor: null })); await old;
  expect(text()).toBe('设置页');
  intercept = null; await openInputs();
  const late = deferred(); intercept = path => path === '/api/input/draft/1' ? late.promise : null;
  const opening = openDraft(); await btn('查看原文').onclick(); late.resolve(json(fixture())); await opening;
  expect(deepText(panel())).toContain('原始输入 #2'); expect(editor()).toBe(null);
  intercept = null; await openDraft();
  const reread = deferred(); intercept = path => path === '/api/input/draft/1' ? reread.promise : null;
  const loading = btn('重新读取详情', panel()).onclick(); editor().value = '请求期间的新编辑';
  reread.resolve(json(fixture('draft', 1, { content: '服务端更新' }))); await loading;
  expect(editor().value).toBe('请求期间的新编辑'); expect(deepText(panel())).toContain('未覆盖当前编辑');
});

test('新搜索作废旧分页，项目路由前缀不丢；详情父列表失败不冒充空列表', async () => {
  dom.location.pathname = '/p/0123456789abcdef/'; pageCursor = 'next'; await openInputs();
  expect(reads[0]).toContain('/p/0123456789abcdef/api/inputs');
  const stale = deferred(); intercept = (path, _body, route) => path === '/api/inputs' && route.searchParams.has('cursor') ? stale.promise : null;
  const more = btn('加载更多').onclick(); form().querySelector('input').value = '原始输入'; await form().onsubmit({ preventDefault() {} });
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
  const start = btn('发射并开始', panel()); expect(start.classList.contains('agent-call')).toBe(true); expect(start.getAttribute('data-help')).toContain('token');
  expect(start.parentNode.classList.contains('help-host')).toBe(true);
  expect(btn('仅创建', panel()).classList.contains('agent-call')).toBe(false);
  for (const label of ['仅创建', '删除草稿', '移除引用']) expect(btn(label, panel()).getAttribute('data-help')).toBeTruthy();
  const html = readFileSync('src/ui/web/assets/index.html', 'utf8');
  expect(html.indexOf('id="inputs-open"')).toBeLessThan(html.indexOf('<span>其他</span>'));
  expect(html).toContain('<kbd>Enter</kbd> 暂存'); expect(html).toContain('<kbd>Shift+Enter</kbd> 换行'); expect(html).toContain('/styles-inputs.css');
});
