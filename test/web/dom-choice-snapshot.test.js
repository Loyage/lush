import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { choiceSnapshotPanel, settledDecision } from '../../src/ui/web/assets/choice-snapshot.js';
import { questionnairePanel } from '../../src/ui/web/assets/render-questionnaire.js';
import { noticePanel } from '../../src/ui/web/assets/render-notices.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';

function notice() {
  return { id: 7, task_id: 22, task_worker_number: 'W2', title: '布局选择', kind: 'questionnaire', status: 'answered',
    created_at: '2026-01-01T00:00:00Z', answer_source: 'lush',
    body: JSON.stringify({ version: 1, body: '选择开发方向', questions: [
      { header: '布局', question: '使用哪种布局？', options: [
        { label: '侧栏', description: '分类明确', previewHtml: '<nav>目录</nav>' }, { label: '标签', description: '内容更宽' }] },
      { header: '功能', question: '需要哪些功能？', multiSelect: true, options: [
        { label: '搜索', description: '全文查找' }, { label: '快捷键', description: '键盘操作' }] },
    ] }),
    answer: JSON.stringify({ answers: [{ selected: [0], labels: ['侧栏'], custom: '' }, { selected: [0], labels: ['搜索'], custom: '' }] }) };
}
const ready = () => ({ notice_id: 7, status: 'ready', revision: 'snapshot-v1', reason: null,
  source_task_id: 22, source_worker_number: 'W2', commit: 'a'.repeat(40), created_at: '2026-01-01T00:00:00Z',
  context_mode: 'pi', can_rechoose: true, blockers: [], limitations: ['不恢复进程或外部服务。'] });
const buttonOf = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const click = async (root, label) => {
  const node = buttonOf(root, label); expect(node).toBeTruthy(); expect(node.disabled).toBe(false); await node.onclick();
};
const option = (root, label) => root.querySelectorAll('.decision-option').find(node => deepText(node).includes(label));
async function fill(root) {
  await option(root, '标签').onclick();
  await option(root, '搜索').onclick(); await option(root, '快捷键').onclick();
  await click(root, '查看全部选择');
}
async function open(root) { await click(root, '查看快照与重选'); await click(root, '重新选择'); }
function storage() {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), values = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
  } });
  return { values, restore: () => saved ? Object.defineProperty(globalThis, 'sessionStorage', saved) : delete globalThis.sessionStorage };
}

test('history and Worker detail share opt-in read-only snapshot controls; original answers remain unchanged', async () => {
  const requests = [], record = notice(), original = structuredClone(record);
  const dom = installDom({ fetch: async url => { requests.push(url); return Response.json(ready()); } });
  resetUiState();
  try {
    const panel = noticePanel(record);
    expect(deepText(panel)).toContain('Lush 自动选择'); expect(deepText(panel)).toContain('已选：侧栏');
    expect(requests).toHaveLength(0);
    await click(panel, '查看快照与重选');
    expect(requests).toEqual(['/api/notice/7/snapshot']);
    expect(deepText(panel)).toContain('选择快照已保存'); expect(deepText(panel)).toContain('不恢复进程或外部服务');
    expect(deepText(panel)).toContain('原路线不会自动暂停'); expect(deepText(panel)).toContain('不会回滚 main');
    expect(buttonOf(panel, '重新选择').classList.contains('agent-call')).toBe(false);
    expect(record).toEqual(original);
    const task = { id: 22, role: 'agent', task_kind: 'order', goal: '布局开发', status: 'completed', integration: 'merged',
      deps: [], dependents: [], children: [], messages: [], notices: [record], reservation: null };
    renderDetail(task, null, null, null);
    const fold = dom.node('detail').querySelector('.decision-record'); fold.open = true;
    await click(fold, '查看快照与重选'); await click(fold, '重新选择');
    await option(fold.querySelector('.choice-snapshot'), '标签').onclick();
    renderDetail(task, null, null, null);
    expect(dom.node('detail').querySelector('.decision-record')).toBe(fold);
    expect(fold.open).toBe(true); expect(deepText(fold)).toContain('需要哪些功能？');
    expect(record).toEqual(original);
  } finally { dom.restore(); }
});

test('pending, unavailable historical snapshots and blocked ready state do not expose a creation path', async () => {
  for (const value of [
    { status: 'pending', reason: '正在等待原调用退出' },
    { status: 'unavailable', reason: '旧记录没有选择快照' },
    { status: 'ready', reason: null, blockers: ['父 Worker 已归档'] },
  ]) {
    let requests = 0;
    const dom = installDom({ fetch: async () => { requests++; return Response.json({ ...ready(), ...value, can_rechoose: false }); } });
    resetUiState();
    try {
      const root = choiceSnapshotPanel({ ...notice(), status: 'dismissed', answer: null });
      await click(root, '查看快照与重选');
      expect(buttonOf(root, '重新选择').disabled).toBe(true);
      expect(buttonOf(root, '重新选择').parentNode.classList.contains('help-host')).toBe(true);
      expect(buttonOf(root, '重新选择').parentNode.getAttribute('data-help')).toContain(value.reason || value.blockers[0]);
      expect(root.querySelector('textarea')).toBeNull(); expect(requests).toBe(1);
    } finally { dom.restore(); }
  }
});

test('read failures or incompatible old servers remain retryable and never pretend snapshots are ready', async () => {
  let count = 0;
  const dom = installDom({ fetch: async () => {
    count++; if (count === 1) return Response.json({ error: 'not found' }, { status: 404 });
    if (count === 2) return Response.json({}); return Response.json(ready());
  } }); resetUiState();
  try {
    const root = choiceSnapshotPanel(notice());
    await click(root, '查看快照与重选'); expect(deepText(root)).toContain('读取失败');
    expect(buttonOf(root, '重新选择')).toBeUndefined();
    await click(root, '重试读取快照'); expect(deepText(root)).toContain('不兼容');
    await click(root, '重试读取快照'); expect(buttonOf(root, '重新选择').disabled).toBe(false);
  } finally { dom.restore(); }
});

test('rechoose uses independent draft, previews, multi-selection and final Agent-marked confirmation', async () => {
  const calls = [], navigated = [], record = notice(), original = structuredClone(record);
  const dom = installDom({ fetch: async (url, opts) => {
    if (!opts) return Response.json(ready());
    calls.push(JSON.parse(opts.body)); return Response.json({ notice_id: 7, task: { id: 101, worker_number: 'W8' }, reused: false });
  } }); resetUiState(); const saved = storage();
  const restore = registerNavigation({ detail: async id => navigated.push(id) });
  try {
    const old = questionnairePanel({ ...record, status: 'open' }, {});
    await option(old, '侧栏').onclick(); // old answer draft must not preload into the rechoose form
    const root = choiceSnapshotPanel(record); await open(root);
    expect(root.querySelector('iframe').getAttribute('src')).toBe('/api/worker/22/notice/7/preview/0/0');
    expect(root.querySelector('iframe').getAttribute('sandbox')).toBe('');
    expect(root.querySelectorAll('.selected')).toHaveLength(0);
    await click(root, '汇总确认');
    const invalid = buttonOf(root, '确认新选择并创建 Worker'); expect(invalid.disabled).toBe(true);
    expect(invalid.classList.contains('agent-call')).toBe(true);
    expect(invalid.parentNode.getAttribute('data-help')).toContain('消耗 token');
    await click(root, '修改'); await fill(root);
    expect(deepText(root)).toContain('搜索、快捷键'); expect(calls).toHaveLength(0);
    expect(buttonOf(root, '忽略问卷')).toBeUndefined();
    expect(deepText(root)).not.toContain('原 Worker 将继续');
    await click(root, '确认新选择并创建 Worker');
    expect(calls).toHaveLength(1); const { method, params } = calls[0];
    expect(method).toBe('notice.rechoose'); expect(params.id).toBe(7); expect(params.revision).toBe('snapshot-v1');
    expect(params.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(params.answer).toEqual({ answers: [{ selected: [1], custom: '' }, { selected: [0, 1], custom: '' }] });
    expect(navigated).toEqual([101]); expect(deepText(root)).toContain('Worker W8');
    expect(record).toEqual(original); expect(saved.values.size).toBe(2); // old draft and successful request receipt
    const originalDraft = questionnairePanel({ ...record, status: 'open' });
    expect(deepText(originalDraft)).toContain('需要哪些功能？');
    expect(ui.detailDirty).toBe(false);
  } finally { restore(); saved.restore(); dom.restore(); }
});

test('custom choice survives failed submission and page reload; identical retry reuses the original UUID', async () => {
  const calls = [], nav = []; let fail = true;
  const dom = installDom({ fetch: async (url, opts) => {
    if (!opts) return Response.json(ready()); calls.push(JSON.parse(opts.body));
    if (fail) throw new Error('response lost');
    return Response.json({ notice_id: 7, task: { id: 110, worker_number: 'W10' }, reused: true });
  } }); const saved = storage(); resetUiState();
  const restore = registerNavigation({ detail: async id => nav.push(id) });
  try {
    let root = choiceSnapshotPanel(notice()); await open(root);
    let input = root.querySelector('textarea'); input.value = '抽屉导航'; input.listeners.input[0]();
    await click(root, '下一题'); await option(root, '搜索').onclick(); await click(root, '查看全部选择');
    await click(root, '确认新选择并创建 Worker');
    expect(deepText(root)).toContain('选择和请求标识已保留'); expect(nav).toHaveLength(0);
    ui.questionDrafts.clear(); ui.choiceRechooseRequests.clear();
    root = choiceSnapshotPanel(notice()); await open(root);
    expect(deepText(root)).toContain('抽屉导航');
    fail = false; await click(root, '确认新选择并创建 Worker');
    expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]); expect(nav).toEqual([110]);
    expect(calls[0].params.answer.answers[0]).toEqual({ selected: [], custom: '抽屉导航' });
    root = choiceSnapshotPanel(notice()); await open(root);
    expect(deepText(root)).toContain('已创建新路线 Worker W10'); expect(root.querySelector('textarea')).toBeNull();
    expect(calls).toHaveLength(2);
    await click(root, '再次从此处重选'); await fill(root); await click(root, '确认新选择并创建 Worker');
    expect(calls[2].params.request_id).not.toBe(calls[1].params.request_id);
  } finally { restore(); saved.restore(); dom.restore(); }
});

test('only settled questionnaires offer rechoose; dismissed source remains explicitly unselected', () => {
  const dom = installDom(); resetUiState();
  try {
    for (const record of [{ ...notice(), kind: 'question' }, { ...notice(), status: 'open' }]) {
      expect(choiceSnapshotPanel(record).querySelector('button')).toBeNull();
    }
    const root = settledDecision({ ...notice(), status: 'dismissed', answer: null });
    expect(deepText(root)).toContain('已忽略 · 未选择任何选项');
    expect(root.querySelectorAll('.selected')).toHaveLength(0); expect(buttonOf(root, '查看快照与重选')).toBeTruthy();
    expect(settledDecision(notice(), { rechoose: false }).querySelector('.choice-snapshot')).toBeNull();
  } finally { dom.restore(); }
});

test('late snapshot reads and creation acknowledgements cannot steal a different page or project', async () => {
  let resolveRead, resolvePost; const nav = [];
  const dom = installDom({ fetch: (_url, opts) => new Promise(resolve => { if (opts) resolvePost = resolve; else resolveRead = resolve; }) });
  resetUiState(); const restore = registerNavigation({ detail: async id => nav.push(id) });
  try {
    ui.view = { id: 'first' }; const root = choiceSnapshotPanel(notice());
    const read = click(root, '查看快照与重选'); ui.view = { id: 'second' }; resolveRead(Response.json(ready())); await read;
    expect(buttonOf(root, '重新选择')).toBeUndefined();
    const secondRead = click(root, '查看快照与重选'); resolveRead(Response.json(ready())); await secondRead;
    await click(root, '重新选择'); await fill(root);
    const submit = click(root, '确认新选择并创建 Worker');
    ui.view = { id: 'third' }; resolvePost(Response.json({ notice_id: 7, task: { id: 120 }, reused: false })); await submit;
    expect(nav).toHaveLength(0);
    const reopened = choiceSnapshotPanel(notice()); const thirdRead = click(reopened, '查看快照与重选');
    resolveRead(Response.json(ready())); await thirdRead; await click(reopened, '重新选择');
    expect(deepText(reopened)).toContain('已创建新路线 Worker #120');
    dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/';
    const before = resolveRead; await click(reopened, '查看快照与重选'); expect(resolveRead).toBe(before);
  } finally { restore(); dom.restore(); }
});

test('pending final submission disables input and is single-flight across click handlers', async () => {
  let resolvePost, posts = 0;
  const dom = installDom({ fetch: (_url, opts) => {
    if (!opts) return Promise.resolve(Response.json(ready()));
    posts++; return new Promise(resolve => { resolvePost = resolve; });
  } }); resetUiState(); const restore = registerNavigation({ detail: async () => {} });
  try {
    const root = choiceSnapshotPanel(notice()); await open(root); await fill(root);
    const submit = buttonOf(root, '确认新选择并创建 Worker');
    const first = submit.onclick(); const second = submit.onclick();
    expect(posts).toBe(1);
    expect(root.querySelector('.questionnaire').querySelectorAll('button').every(node => node.disabled)).toBe(true);
    resolvePost(Response.json({ notice_id: 7, task: { id: 121 }, reused: false })); await Promise.all([first, second]);
    expect(posts).toBe(1);
  } finally { restore(); dom.restore(); }
});

test('navigation failure after acknowledgement does not turn successful creation into a retry', async () => {
  let posts = 0;
  const dom = installDom({ fetch: async (_url, opts) => {
    if (!opts) return Response.json(ready()); posts++;
    return Response.json({ notice_id: 7, task: { id: 122 }, reused: false });
  } }); resetUiState(); const restore = registerNavigation({ detail: async () => { throw new Error('offline'); } });
  try {
    const root = choiceSnapshotPanel(notice()); await open(root); await fill(root); await click(root, '确认新选择并创建 Worker');
    expect(deepText(root)).toContain('新 Worker 已创建'); expect(deepText(root)).not.toContain('未确认创建成功');
    expect(buttonOf(root, '打开新 Worker')).toBeTruthy(); expect(posts).toBe(1);
  } finally { restore(); dom.restore(); }
});

test('a lost acknowledgement can be retried after the parent becomes frozen without generating a new request', async () => {
  let blocked = false; const calls = [];
  const dom = installDom({ fetch: async (_url, opts) => {
    if (!opts) return Response.json({ ...ready(), can_rechoose: !blocked, blockers: blocked ? ['父分支已冻结'] : [] });
    calls.push(JSON.parse(opts.body));
    if (calls.length === 1) { blocked = true; throw new Error('response lost'); }
    return Response.json({ notice_id: 7, task: { id: 123 }, reused: true });
  } }); resetUiState(); const saved = storage(), restore = registerNavigation({ detail: async () => {} });
  try {
    let root = choiceSnapshotPanel(notice()); await open(root); await fill(root); await click(root, '确认新选择并创建 Worker');
    ui.questionDrafts.clear(); ui.choiceRechooseRequests.clear();
    root = choiceSnapshotPanel(notice()); await click(root, '查看快照与重选');
    expect(buttonOf(root, '重新选择').disabled).toBe(true);
    await click(root, '继续上次重选'); expect(deepText(root)).toContain('只能原样重试上次提交');
    await click(root, '确认新选择并创建 Worker'); expect(calls[1]).toEqual(calls[0]);
    expect(deepText(root)).toContain('已创建新路线 Worker #123');
    expect(buttonOf(root, '再次从此处重选').disabled).toBe(true);
  } finally { restore(); saved.restore(); dom.restore(); }
});

test('request identities and new choice drafts are isolated by project, even for identical Notice IDs', async () => {
  const calls = [], urls = [];
  const dom = installDom({ fetch: async (url, opts) => {
    urls.push(url); if (!opts) return Response.json(ready());
    calls.push(JSON.parse(opts.body)); throw new Error('offline');
  } }); resetUiState(); const saved = storage();
  try {
    dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
    let root = choiceSnapshotPanel(notice()); await open(root); await fill(root); await click(root, '确认新选择并创建 Worker');
    dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/';
    root = choiceSnapshotPanel(notice()); await open(root);
    expect(root.querySelectorAll('.selected')).toHaveLength(0); expect(root.querySelector('textarea').value).toBe('');
    await fill(root); await click(root, '确认新选择并创建 Worker');
    expect(calls[0].params.request_id).not.toBe(calls[1].params.request_id);
    expect(urls).toContain('/p/aaaaaaaaaaaaaaaa/api/notice/7/snapshot');
    expect(urls).toContain('/p/bbbbbbbbbbbbbbbb/api/notice/7/snapshot');
  } finally { saved.restore(); dom.restore(); }
});

test('HTTP browsers without randomUUID use getRandomValues; malformed creation receipts retain the retry identity', async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'), nativeCrypto = globalThis.crypto;
  const calls = [];
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: value => nativeCrypto.getRandomValues(value) } });
  const dom = installDom({ fetch: async (_url, opts) => {
    if (!opts) return Response.json(ready()); calls.push(JSON.parse(opts.body)); return Response.json({ notice_id: 8, task: { id: 125 } });
  } }); resetUiState();
  try {
    const root = choiceSnapshotPanel(notice()); await open(root); await fill(root);
    await click(root, '确认新选择并创建 Worker'); expect(deepText(root)).toContain('未收到有效的新 Worker 回执');
    await click(root, '确认新选择并创建 Worker'); expect(calls[1]).toEqual(calls[0]);
    expect(calls[0].params.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto;
    dom.restore();
  }
});
