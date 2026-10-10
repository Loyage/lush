import { test, expect } from 'bun:test';
import { installDom, deepText, findByText, answerDialog } from '../dom-stub.js';
import { until } from '../helpers.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { openGlobalInbox } from '../../src/ui/web/assets/global-inbox.js';
import { startGlobalNoticeObserver, refreshGlobalNotices } from '../../src/ui/web/assets/global-notice-notifications.js';
import { questionnairePanel } from '../../src/ui/web/assets/render-questionnaire.js';
import { inboxIdentity, sourceWorkerLinks, validateInboxItem, validateInboxPage } from '../../src/ui/web/assets/global-inbox-model.js';

const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb';
const SYNC_A = '1'.repeat(32), SYNC_B = '2'.repeat(32), EPOCH = 'e'.repeat(32);
const sync = (identity = SYNC_A, revision = 1) => ({ sync_identity: identity, sync_revision: revision, sync_epoch: EPOCH });
const json = value => ({ ok: true, json: async () => structuredClone(value) });
const question = (id = 7, extra = {}) => ({ id, task_id: 21, task_worker_number: 'W162-1', kind: 'question', status: 'open',
  title: '选择执行方式', body: '请查看 W162-1，然后决定。', created_at: '2026-10-09T10:00:00.000Z', ...extra });
const item = (projectId = A, notice = question(), online = true) => ({ project_id: projectId, project_name: `项目 ${projectId[0]}`,
  project: `/tmp/${projectId}`, online, checked_at: '2026-10-09T11:00:00.000Z', notice });
const source = (id = A, extra = {}) => ({ id, name: `项目 ${id[0]}`, online: true, complete: true, checked_at: '2026-10-09T11:00:00.000Z', error: null, ...extra });
const page = (items = [], extra = {}) => ({ version: 1, items, cursor: null, has_more: false, complete: true,
  projects: [source(A), source(B)], ...extra });
const form = JSON.stringify({ version: 1, body: '请决定 W162-1 的方案', questions: [{ header: '方案', question: '如何执行？', options: [
  { label: '参考 W162-1', description: '查看 Worker 后决定', previewHtml: '<p>静态效果</p>' }, { label: '方案 B', description: '第二种方式' },
] }] });
const button = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
const input = (node, text) => { node.value = text; for (const listener of node.listeners.input || []) listener(); };

function withSessionStorage() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), values = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } });
  return { values, restore() { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else delete globalThis.sessionStorage; } };
}

test('global list uses Host API, separates same integer IDs, and links exact source records in independent project tabs', async () => {
  const requests = [], rows = [item(A), item(B)];
  const dom = installDom({ fetch: async url => { requests.push(url); return json(url.includes('/notice?') ? rows.find(row => url.includes(row.project_id)) : page(rows)); } });
  resetUiState(); dom.location.pathname = `/p/${B}/`; ui.lastSnapshot = { status: { project: '/tmp/wrong-current-project' } };
  try {
    await openGlobalInbox();
    expect(requests).toEqual(['/api/host/inbox?status=all&limit=30']);
    expect(ui.view.id).toBe('global-inbox');
    const root = dom.node('detail');
    expect(root.querySelectorAll('.global-inbox-row')).toHaveLength(2);
    expect(new Set(root.querySelectorAll('.global-inbox-row').map(row => row.dataset.noticeIdentity)).size).toBe(2);
    for (const [index, id] of [A, B].entries()) {
      const link = root.querySelectorAll('.global-inbox-row')[index];
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('href')).toBe(`/p/${id}/#notices-7`);
      expect(link.getAttribute('target')).toBe('_blank'); expect(link.getAttribute('rel')).toBe('noopener');
      expect(link.onclick).toBeFalsy();
    }
    expect(root.querySelector('textarea')).toBeNull();
    expect(requests).toHaveLength(1);
    // Old global detail bookmarks remain readable for compatibility.
    await openGlobalInbox({ projectId: A, noticeId: 7 });
    const focus = dom.node('detail');
    const worker = focus.querySelector('.global-inbox-worker');
    expect(worker.getAttribute('href')).toBe(`/p/${A}/#worker-21`);
    expect(worker.getAttribute('target')).toBe('_blank'); expect(worker.getAttribute('rel')).toBe('noopener');
    expect(focus.querySelector('.worker-link').getAttribute('href')).toBe(`/p/${A}/#worker-number-W162-1`);
    expect(dom.location.hash).toBe(`#inbox-notice-${A}-7`);
    expect(requests.every(url => url.startsWith('/api/host/'))).toBe(true);
    expect(button(focus, '已知')).toBeUndefined();
  } finally { dom.restore(); resetUiState(); }
});

test('all filters retain the shell route and do not push when the shell owns navigation', async () => {
  const requests = [];
  const dom = installDom({ fetch: async url => { requests.push(url); return json(page([])); } }); resetUiState();
  try {
    await openGlobalInbox(); expect(dom.location.hash).toBe('#notices'); expect(requests.at(-1)).toContain('status=all');
    const labels = { open: '需要我决定', unread: '未读告知', failed: '异常与受阻', automatic: '自动选择', all: '全部记录' };
    for (const [status, label] of Object.entries(labels)) {
      await button(dom.node('detail'), label).onclick();
      expect(dom.location.hash).toBe(status === 'all' ? '#notices' : `#notices-${status}`);
      expect(requests.at(-1)).toContain(`status=${status}`);
    }
    dom.location.hash = '#notices-automatic'; const historyLength = dom.pushed();
    await openGlobalInbox({ status: 'automatic', push: false });
    expect(dom.location.hash).toBe('#notices-automatic'); expect(dom.pushed()).toBe(historyLength);
    expect(ui.globalInboxPage.current()).toBe(true);
  } finally { dom.restore(); resetUiState(); }
});

test('opaque history paging retains all loaded rows and removed source caches are filtered immediately', async () => {
  let call = 0; const requests = [];
  const dom = installDom({ fetch: async url => {
    requests.push(url); call++;
    if (call === 1) return json(page([item(A)], { has_more: true, cursor: 'opaque&cursor=older' }));
    return json(page([item(B, question(6))], { projects: [source(B)] }));
  } }); resetUiState();
  try {
    await openGlobalInbox({ status: 'all' });
    await button(dom.node('detail'), '加载更早记录').onclick();
    expect(requests[1]).toContain('before=opaque%26cursor%3Dolder');
    expect(dom.node('detail').querySelectorAll('.global-inbox-row')).toHaveLength(1);
    expect(deepText(dom.node('detail'))).not.toContain('项目 a');
    expect(deepText(dom.node('detail'))).toContain('项目 b');
  } finally { dom.restore(); resetUiState(); }
});

test('text answers target the original source, preserve drafts on failure, and apply ACK without refreshing the answer path', async () => {
  const writes = []; let attempts = 0;
  const original = item(B);
  const dom = installDom({ fetch: async (url, options = {}) => {
    if (!options.body) return json(url.includes('/notice?') ? original : page([original]));
    writes.push([url, JSON.parse(options.body)]); attempts++;
    if (attempts === 1) return { ok: false, json: async () => ({ error: '暂时不可达' }) };
    return json(item(B, question(7, { status: 'answered', answer_source: 'user', answer: '使用方案 B' })));
  } }); resetUiState(); const storage = withSessionStorage();
  try {
    await openGlobalInbox({ projectId: B, noticeId: 7 });
    const root = dom.node('detail'); input(root.querySelector('textarea'), '使用方案 B');
    await button(root, '提交决定并继续 Worker').onclick();
    expect(deepText(root)).toContain('输入已保留'); expect(root.querySelector('textarea').value).toBe('使用方案 B');
    const submit = button(root, '提交决定并继续 Worker'); expect(submit.classList.contains('agent-call')).toBe(true); expect(submit.dataset.help).toContain('token');
    await submit.onclick();
    expect(writes).toEqual(Array.from({ length: 2 }, () => ['/api/host/inbox/action', { project_id: B, id: 7, method: 'notice.answer', answer: '使用方案 B' }]));
    expect(root.querySelector('textarea')).toBeNull(); expect(deepText(root)).toContain('用户答复'); expect(deepText(root)).toContain('答复已提交');
    expect(storage.values.size).toBe(0);
    // An old cached Host response cannot resurrect the acknowledged open record.
    await button(root, '刷新记录').onclick();
    expect(root.querySelector('textarea')).toBeNull(); expect(deepText(root)).toContain('使用方案 B');
  } finally { storage.restore(); dom.restore(); resetUiState(); }
});

test('offline detail disables mutation in keyboard-focusable help hosts but preserves text drafts', async () => {
  let writes = 0; const cached = item(A, question(), false);
  const dom = installDom({ fetch: async (url, options = {}) => { if (options.body) writes++; return json(url.includes('/notice?') ? cached : page([cached], { complete: false, projects: [source(A, { online: false })] })); } });
  resetUiState();
  try {
    await openGlobalInbox({ projectId: A, noticeId: 7 });
    const root = dom.node('detail'), submit = button(root, '提交决定并继续 Worker');
    expect(submit.disabled).toBe(true); expect(submit.parentNode.classList.contains('help-host')).toBe(true);
    expect(submit.parentNode.getAttribute('tabindex')).toBe('0'); expect(submit.parentNode.dataset.help).toContain('离线');
    expect(button(root, '忽略问题').disabled).toBe(true); expect(deepText(root)).toContain('最后确认');
    input(root.querySelector('textarea'), '离线暂存'); await submit.onclick(); expect(writes).toBe(0);
    expect(root.querySelector('textarea').value).toBe('离线暂存');
  } finally { dom.restore(); resetUiState(); }
});

test('only lifecycle info gets 已知, it commits notice.read once and never answers or calls Agent', async () => {
  let resolve; const ack = new Promise(yes => { resolve = yes; }); const writes = [];
  const unread = item(A, question(8, { kind: 'info', status: 'sent', source_event_id: 40, read_at: null, lifecycle_type: 'failed' }));
  const dom = installDom({ fetch: async (url, options = {}) => {
    if (options.body) { writes.push(JSON.parse(options.body)); return ack; }
    return json(url.includes('/notice?') ? unread : page([unread]));
  } }); resetUiState();
  try {
    await openGlobalInbox({ projectId: A, noticeId: 8, status: 'unread' });
    const known = button(dom.node('detail'), '已知'); expect(known.classList.contains('agent-call')).toBe(false);
    const pending = known.onclick(); await until(() => writes.length === 1);
    resolve(json(item(A, { ...unread.notice, read_at: '2026-10-09T12:00:00Z' }))); await pending;
    expect(writes).toEqual([{ project_id: A, id: 8, method: 'notice.read' }]);
    expect(button(dom.node('detail'), '已知')).toBeUndefined(); expect(deepText(dom.node('detail'))).toContain('告知已读');
    await button(dom.node('detail'), '刷新记录').onclick();
    expect(button(dom.node('detail'), '已知')).toBeUndefined(); expect(writes).toHaveLength(1);
  } finally { dom.restore(); resetUiState(); }
});

test('questionnaire drafts and static previews use complete source identity, not the current project', async () => {
  const dom = installDom(); resetUiState(); const storage = withSessionStorage();
  const questionNotice = question(7, { kind: 'questionnaire', body: form });
  try {
    let panel = questionnairePanel(questionNotice, { sourceProjectId: A, draftScope: `global:${A}:${questionNotice.created_at}`, settle: async () => {} });
    expect(panel.querySelector('iframe').getAttribute('src')).toBe(`/p/${A}/api/worker/21/notice/7/preview/0/0`);
    expect(panel.querySelector('.worker-link').getAttribute('href')).toBe(`/p/${A}/#worker-number-W162-1`);
    input(panel.querySelector('textarea'), '为 A 选择');
    ui.lastSnapshot = { status: { project: '/different-project' } };
    panel = questionnairePanel(questionNotice, { sourceProjectId: A, draftScope: `global:${A}:${questionNotice.created_at}` });
    expect(panel.querySelector('textarea').value).toBe('为 A 选择');
    panel = questionnairePanel(questionNotice, { sourceProjectId: B, draftScope: `global:${B}:${questionNotice.created_at}` });
    expect(panel.querySelector('textarea').value).toBe('');
    const offline = questionnairePanel(questionNotice, { sourceProjectId: A, draftScope: `global:${A}:${questionNotice.created_at}`, readOnly: true, previewOnline: false });
    expect(offline.querySelector('iframe')).toBeNull(); expect(deepText(offline)).toContain('静态预览暂不可读取');
    await button(offline, '汇总确认').onclick(); const submit = button(offline, '确认全部选择并继续 Worker');
    expect(submit.disabled).toBe(true); expect(submit.parentNode.getAttribute('tabindex')).toBe('0');
  } finally { storage.restore(); dom.restore(); resetUiState(); }
});

test('automatic questionnaire history replays sources and previews read-only without sending writes', async () => {
  let writes = 0;
  const row = item(B, question(7, { kind: 'questionnaire', status: 'answered', body: form, answer_source: 'lush',
    answer: JSON.stringify({ answers: [{ question: '如何执行？', selected: [0], labels: ['参考 W162-1'], custom: '' }] }) }));
  const dom = installDom({ fetch: async (url, options = {}) => { if (options.body) writes++; return json(url.includes('/notice?') ? row : page([row])); } }); resetUiState();
  try {
    await openGlobalInbox({ projectId: B, noticeId: 7, status: 'automatic' });
    const root = dom.node('detail'); expect(deepText(root)).toContain('Lush 自动选择'); expect(deepText(root)).toContain('不是用户亲自作出的决定');
    expect(root.querySelector('textarea')).toBeNull(); expect(root.querySelector('iframe').getAttribute('src')).toContain(`/p/${B}/api/worker/21/notice/7/preview/`);
    expect(root.querySelectorAll('button').some(node => node.classList.contains('agent-call'))).toBe(false);
    expect(writes).toBe(0);
  } finally { dom.restore(); resetUiState(); }
});

test('a late list read cannot override an ACK or newer detail input', async () => {
  let release; const oldList = new Promise(yes => { release = yes; });
  const row = item(A), writes = [];
  const dom = installDom({ fetch: async (url, options = {}) => {
    if (options.body) { writes.push(JSON.parse(options.body)); return json(item(A, question(7, { status: 'answered', answer: '已确认', answer_source: 'user' }))); }
    return url.includes('/notice?') ? json(row) : oldList;
  } }); resetUiState();
  try {
    const opening = openGlobalInbox({ projectId: A, noticeId: 7 });
    await until(() => dom.node('detail').querySelector('textarea'));
    input(dom.node('detail').querySelector('textarea'), '已确认'); await button(dom.node('detail'), '提交决定并继续 Worker').onclick();
    release(json(page([row]))); await opening;
    expect(writes).toHaveLength(1); expect(dom.node('detail').querySelector('textarea')).toBeNull(); expect(deepText(dom.node('detail'))).toContain('已确认');
  } finally { dom.restore(); resetUiState(); }
});

test('late reads and late mutation completion cannot steal a newer navigation', async () => {
  let release; const delayed = new Promise(yes => { release = yes; });
  const dom = installDom({ fetch: async () => delayed }); resetUiState();
  try {
    const pending = openGlobalInbox({ projectId: A, noticeId: 7 });
    activateDetailView({ view: 'docs', hash: '#docs' }); dom.node('detail').textContent = '新的帮助页';
    release(json(page([item(A)]))); await pending;
    expect(ui.view.id).toBe('docs'); expect(dom.node('detail').textContent).toBe('新的帮助页');
  } finally { dom.restore(); resetUiState(); }
});

test('a replacement document invalidates late reads and old controls even when URL and UI identity are unchanged', async () => {
  let release; const delayed = new Promise(resolve => { release = resolve; }); let writes = 0;
  const first = installDom({ fetch: async (url, options = {}) => {
    if (options.body) writes++; await delayed;
    return json(url.includes('/notice?') ? item(A) : page([item(A)]));
  } }); resetUiState();
  let replacement;
  try {
    const pending = openGlobalInbox({ projectId: A, noticeId: 7 }); const original = ui.globalInboxPage;
    const oldRefresh = button(first.node('detail'), '刷新记录'); let replacementReads = 0;
    replacement = installDom({ fetch: async () => { replacementReads++; return json(item(A)); } }); replacement.location.hash = first.location.hash;
    replacement.node('detail').textContent = '新文档的页面';
    release(); await pending; await oldRefresh.onclick();
    expect(ui.globalInboxPage).toBe(original); expect(original.current()).toBe(false);
    expect(original.rows).toHaveLength(0); expect(replacement.node('detail').textContent).toBe('新文档的页面');
    expect(writes).toBe(0); expect(replacementReads).toBe(0);
  } finally { replacement?.restore(); first.restore(); resetUiState(); }
});

test('post-ACK global refresh failure is reported separately and never turns a durable answer into failure', async () => {
  let failSummary = false;
  const dom = installDom({ fetch: async (url, options = {}) => options.body
    ? json(item(A, question(7, { status: 'answered', answer: '确认完成', answer_source: 'user' })))
    : json(url.includes('/notice?') ? item(A) : page([item(A)])) }); resetUiState();
  const dispose = startGlobalNoticeObserver({ read: async () => {
    if (failSummary) throw new Error('汇总接口断线'); return page([]);
  }, setTimeout: () => 1, clearTimeout: () => {} });
  try {
    await refreshGlobalNotices(); await openGlobalInbox({ projectId: A, noticeId: 7 });
    input(dom.node('detail').querySelector('textarea'), '确认完成'); failSummary = true;
    await button(dom.node('detail'), '提交决定并继续 Worker').onclick();
    await until(() => deepText(dom.node('detail')).includes('汇总刷新失败'));
    expect(dom.node('detail').querySelector('textarea')).toBeNull(); expect(deepText(dom.node('detail'))).toContain('事项已处理');
    expect(deepText(dom.node('detail'))).not.toContain('未提交成功');
  } finally { dispose(); dom.restore(); resetUiState(); }
});

test('a late mutation ACK preserves a newer page and is retained when its source is explicitly reopened', async () => {
  let release; const ack = new Promise(yes => { release = yes; }); let calls = 0;
  const dom = installDom({ fetch: async (url, options = {}) => {
    if (options.body) { calls++; return ack; }
    return json(url.includes('/notice?') ? item(A) : page([item(A)]));
  } }); resetUiState();
  try {
    await openGlobalInbox({ projectId: A, noticeId: 7 }); input(dom.node('detail').querySelector('textarea'), '延后确认');
    const submitting = button(dom.node('detail'), '提交决定并继续 Worker').onclick(); await until(() => calls === 1);
    activateDetailView({ view: 'docs', hash: '#docs' }); dom.node('detail').textContent = '新的帮助页';
    release(json(item(A, question(7, { status: 'answered', answer: '延后确认', answer_source: 'user' })))); await submitting;
    expect(ui.view.id).toBe('docs'); expect(dom.node('detail').textContent).toBe('新的帮助页');
    await openGlobalInbox({ projectId: A, noticeId: 7 }); expect(dom.node('detail').querySelector('textarea')).toBeNull();
    expect(deepText(dom.node('detail'))).toContain('延后确认');
  } finally { dom.restore(); resetUiState(); }
});

test('incorrect action ACK is rejected and drafts remain rather than falsely reporting success', async () => {
  const dom = installDom({ fetch: async (url, options = {}) => options.body ? json(item(B, question(7, { status: 'answered' }))) : json(url.includes('/notice?') ? item(A) : page([item(A)])) }); resetUiState();
  try {
    await openGlobalInbox({ projectId: A, noticeId: 7 }); input(dom.node('detail').querySelector('textarea'), '保留输入');
    await button(dom.node('detail'), '提交决定并继续 Worker').onclick();
    expect(deepText(dom.node('detail'))).toContain('未提交成功'); expect(dom.node('detail').querySelector('textarea').value).toBe('保留输入');
  } finally { dom.restore(); resetUiState(); }
});

test('dismissal is explicit and never silently treats ignoring as approving a choice', async () => {
  const writes = [];
  const dom = installDom({ fetch: async (url, options = {}) => {
    if (options.body) { writes.push(JSON.parse(options.body)); return json(item(A, question(7, { status: 'dismissed', answer_source: 'user', answer: '' }))); }
    return json(url.includes('/notice?') ? item(A) : page([item(A)]));
  } }); resetUiState();
  try {
    await openGlobalInbox({ projectId: A, noticeId: 7 });
    const ignoring = button(dom.node('detail'), '忽略问题').onclick();
    expect(writes).toHaveLength(0); expect(deepText(dom.node('modal'))).toContain('不代表批准');
    await answerDialog(dom, '忽略问题'); await ignoring;
    expect(writes).toEqual([{ project_id: A, id: 7, method: 'notice.dismiss' }]); expect(deepText(dom.node('detail'))).toContain('已忽略 · 不代表批准');
  } finally { dom.restore(); resetUiState(); }
});

test('all three mutations forward the exact source sync token and accept revision-only ACK changes', async () => {
  for (const method of ['notice.answer', 'notice.dismiss', 'notice.read']) {
    const n = question(7, { ...sync(), ...(method === 'notice.read' ? { kind: 'info', status: 'sent', source_event_id: 40 } : {}) });
    const original = item(A, n), writes = [];
    const dom = installDom({ fetch: async (url, options = {}) => {
      if (!options.body) return json(url.includes('/notice?') ? original : page([original]));
      writes.push(JSON.parse(options.body));
      return json(item(A, { ...n, ...sync(SYNC_A, 2), ...(method === 'notice.read' ? { read_at: '2026-10-09T12:00:00Z' }
        : { status: method === 'notice.answer' ? 'answered' : 'dismissed', answer_source: 'user', answer: '确认执行' }) }));
    } }); resetUiState();
    try {
      await openGlobalInbox({ projectId: A, noticeId: 7 });
      if (method === 'notice.answer') { input(dom.node('detail').querySelector('textarea'), '确认执行'); await button(dom.node('detail'), '提交决定并继续 Worker').onclick(); }
      else if (method === 'notice.dismiss') { const pending = button(dom.node('detail'), '忽略问题').onclick(); await answerDialog(dom, '忽略问题'); await pending; }
      else await button(dom.node('detail'), '已知').onclick();
      expect(writes).toEqual([{ project_id: A, id: 7, method, expected_identity: SYNC_A, ...(method === 'notice.answer' ? { answer: '确认执行' } : {}) }]);
      expect(deepText(dom.node('detail'))).not.toContain('未提交成功'); expect(deepText(dom.node('detail'))).not.toContain('已读未确认');
    } finally { dom.restore(); resetUiState(); }
  }
});

test('a legacy read can receive newly supplied real identity in its ACK without inventing an expected token', async () => {
  const writes = [];
  const dom = installDom({ fetch: async (url, options = {}) => {
    if (options.body) { writes.push(JSON.parse(options.body)); return json(item(A, question(7, { ...sync(), status: 'answered', answer: '确认', answer_source: 'user' }))); }
    return json(url.includes('/notice?') ? item(A) : page([item(A)]));
  } }); resetUiState();
  try {
    await openGlobalInbox({ projectId: A, noticeId: 7 }); input(dom.node('detail').querySelector('textarea'), '确认');
    await button(dom.node('detail'), '提交决定并继续 Worker').onclick();
    expect(writes).toEqual([{ project_id: A, id: 7, method: 'notice.answer', answer: '确认' }]);
    expect(dom.node('detail').querySelector('textarea')).toBeNull(); expect(deepText(dom.node('detail'))).toContain('答复已提交');
    await button(dom.node('detail'), '刷新记录').onclick(); expect(dom.node('detail').querySelector('textarea')).toBeNull();
  } finally { dom.restore(); resetUiState(); }
});

test('reused integer/date cannot receive an old answer or old text draft; source conflict preserves the original draft', async () => {
  let current = item(A, question(7, sync())); const writes = [];
  const dom = installDom({ fetch: async (url, options = {}) => {
    if (options.body) {
      writes.push(JSON.parse(options.body)); current = item(A, question(7, sync(SYNC_B, 3)));
      return { ok: false, status: 409, json: async () => ({ error: '这条事项已变化或被删除，请重新读取再处理' }) };
    }
    return json(url.includes('/notice?') ? current : page([current]));
  } }); resetUiState(); const storage = withSessionStorage();
  try {
    await openGlobalInbox({ projectId: A, noticeId: 7 }); input(dom.node('detail').querySelector('textarea'), '旧记录的决定');
    await button(dom.node('detail'), '提交决定并继续 Worker').onclick();
    expect(writes[0].expected_identity).toBe(SYNC_A); expect(current.notice.status).toBe('open');
    expect(deepText(dom.node('detail'))).toContain('未提交成功'); expect(dom.node('detail').querySelector('textarea').value).toBe('旧记录的决定');
    await button(dom.node('detail'), '刷新记录').onclick(); expect(dom.node('detail').querySelector('textarea').value).toBe('');
    expect([...storage.values.values()].some(value => value.includes('旧记录的决定'))).toBe(true);
    input(dom.node('detail').querySelector('textarea'), '新记录的决定'); current = item(A, question(7, sync(SYNC_B, 4)));
    await button(dom.node('detail'), '刷新记录').onclick(); expect(dom.node('detail').querySelector('textarea').value).toBe('新记录的决定');
  } finally { storage.restore(); dom.restore(); resetUiState(); }
});

test('old acknowledged answer cannot overlay a new record with identical integer/date, and a mismatched ACK stays rejected', async () => {
  let current = item(A, question(7, sync())), wrongAck = false;
  const dom = installDom({ fetch: async (url, options = {}) => {
    if (options.body) return json(item(A, question(7, { ...sync(wrongAck ? SYNC_A : current.notice.sync_identity, 2), status: 'answered', answer: '旧答复', answer_source: 'user' })));
    return json(url.includes('/notice?') ? current : page([current]));
  } }); resetUiState();
  try {
    await openGlobalInbox({ projectId: A, noticeId: 7 }); input(dom.node('detail').querySelector('textarea'), '旧答复');
    await button(dom.node('detail'), '提交决定并继续 Worker').onclick(); expect(dom.node('detail').querySelector('textarea')).toBeNull();
    current = item(A, question(7, sync(SYNC_B, 3))); await button(dom.node('detail'), '刷新记录').onclick();
    expect(dom.node('detail').querySelector('textarea').value).toBe('');
    input(dom.node('detail').querySelector('textarea'), '仅属于新记录'); wrongAck = true;
    await button(dom.node('detail'), '提交决定并继续 Worker').onclick();
    expect(dom.node('detail').querySelector('textarea').value).toBe('仅属于新记录'); expect(deepText(dom.node('detail'))).toContain('未提交成功');
  } finally { dom.restore(); resetUiState(); }
});

test('questionnaire drafts follow real sync identity and epoch, but survive revision-only changes', () => {
  const dom = installDom(); resetUiState(); const storage = withSessionStorage();
  const n = question(7, { kind: 'questionnaire', body: form, ...sync() });
  const render = notice => questionnairePanel(notice, { sourceProjectId: A, draftScope: `global:${A}:${n.created_at}` });
  try {
    let panel = render(n); input(panel.querySelector('textarea'), '旧问卷草稿');
    panel = render({ ...n, sync_revision: 99 }); expect(panel.querySelector('textarea').value).toBe('旧问卷草稿');
    panel = render({ ...n, sync_identity: SYNC_B }); expect(panel.querySelector('textarea').value).toBe('');
    panel = render({ ...n, sync_epoch: 'f'.repeat(32) }); expect(panel.querySelector('textarea').value).toBe('');
    expect([...storage.values.keys()].some(key => key.endsWith(`:sync:${SYNC_A}:${EPOCH}`))).toBe(true);
  } finally { storage.restore(); dom.restore(); resetUiState(); }
});

test('invalid source identities and malformed pages never become routes or mutations', async () => {
  expect(() => validateInboxItem(item('../bad'))).toThrow('无效');
  expect(() => validateInboxPage(page([], { has_more: true, cursor: null }))).toThrow('不可用');
  expect(inboxIdentity(item(A))).not.toBe(inboxIdentity(item(B)));
  expect(() => validateInboxItem(item(A, question(7, { sync_identity: 'made-up' })))).toThrow('同步身份无效');
  expect(() => validateInboxItem(item(A, question(7, { ...sync(), sync_revision: -1 })))).toThrow('同步版本无效');
  expect(inboxIdentity(item(A, question(7, sync())))).not.toBe(inboxIdentity(item(A, question(7, sync(SYNC_B)))));
  expect(inboxIdentity(item(A, question(7, sync())))).toBe(inboxIdentity(item(A, question(7, sync(SYNC_A, 2)))));
  const dom = installDom(); resetUiState();
  try {
    await expect(openGlobalInbox({ projectId: '../bad', noticeId: 7 })).rejects.toThrow('无效');
    expect(() => sourceWorkerLinks(document.createElement('div'), '//evil.test')).toThrow('无效');
    expect(() => questionnairePanel(question(7, { kind: 'questionnaire', body: form }), { sourceProjectId: '//evil.test' })).toThrow('无效');
  } finally { dom.restore(); resetUiState(); }
});
