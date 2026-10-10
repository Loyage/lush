import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { answerDialog, deepText, dialogText, installDom } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
const task = { id: 70, parent_id: 1, input_id: 57, task_kind: 'order', role: 'agent', status: 'cancelled',
  integration: 'none', title: '错误输入', goal: '错误输入', calls: 0, children: [], deps: [], dependents: [],
  branch: 'lush/example/70-typo', workspace: '/tmp/example/.lush/worktrees/70-typo', target_branch: 'main' };
const child = { ...task, id: 71, parent_id: 70, task_kind: 'child', title: '子 Worker', goal: '子 Worker' };
const freshPreview = () => ({ id: 70, revision: 'fixed-revision-1', can_delete: true, blockers: [],
  workers: [task, child].map(({ id, goal, status }) => ({ id, goal, status })), inputs: [{ id: 57 }],
  resources: { worktrees: ['/tmp/example/.lush/worktrees/70-typo', '/tmp/example/.lush/worktrees/71-child'],
    branches: ['lush/example/70-typo', 'lush/example/71-child'], files: ['/tmp/example/.lush/sessions/task-70-input.md'] },
  warnings: ['这条分支有未合并提交。'] });
let preview, failure, previewGate, deleteGate, readGate, transcriptGate, noticeAckGate, noticeReply;
let requests = [], paths = [], navigation = [], restoreNavigation;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const dom = installDom({ fetch: async (url, options) => {
  const pathname = new URL(String(url), 'http://local').pathname;
  paths.push(pathname);
  const path = pathname.replace(/^\/p\/[a-f0-9]{16}(?=\/)/, '');
  if (path === '/api/worker/70/delete-preview') {
    requests.push({ method: 'preview' });
    if (previewGate) await previewGate;
    return failure === 'preview' ? json({ error: '资源归属无法确认' }, 409) : json(preview);
  }
  if (path === '/api/action' && options?.body) {
    const request = JSON.parse(options.body);
    if (request.method === 'notice.read' && noticeReply) {
      requests.push(request);
      if (noticeAckGate) await noticeAckGate;
      return json(noticeReply);
    }
    if (request.method === 'worker.delete') {
      requests.push(request);
      if (deleteGate) await deleteGate;
      return failure === 'delete' ? json({ error: '资源发生变化，请重新预检确认' }, 409) : json({ deleted: { ids: [70, 71] } });
    }
  }
  if (path === '/api/worker-graph') {
    requests.push({ method: 'graph' });
    return json({ total: 2, nodes: [task, child], edges: [] }); // deliberately stale: tombstones must filter it
  }
  if (path === '/api/worker/70') { if (readGate) await readGate; return json(task); }
  if (path === '/api/worker/70/transcript-latest') {
    if (transcriptGate) await transcriptGate;
    return json({ files: ['old.jsonl'], steps: [{ seq: 1, body: 'old', kind: 'text' }], next: 1 });
  }
  return world.fetchImpl(url, options);
} });
const { workerDeleteControl, runWorkerDelete } = await import('../../src/ui/web/assets/worker-delete.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { renderTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
const { loadDetail } = await import('../../src/ui/web/assets/detail.js');
const { loadTranscript } = await import('../../src/ui/web/assets/render-transcript.js');
const { readNotice, renderNotices } = await import('../../src/ui/web/assets/render-notices.js');
const { renderNoticeBanner } = await import('../../src/ui/web/assets/notice-banner.js');
const { noticeIdentity } = await import('../../src/ui/web/assets/notice-kind.js');
const { activateDetailView, openResource } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const { resetUiState, ui, transcriptCache, transcriptOpen, mergeSelection } = await import('../../src/ui/web/assets/state.js');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const buttonOf = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const deletions = () => requests.filter(row => row.method === 'worker.delete');
function detailView() {
  activateDetailView({ view: 'task', key: 'task-70', hash: '#worker-70' });
  ui.selected = 70; ui.detailTask = 70;
  renderDetail(task, null, null, null);
  return buttonOf(dom.node('detail'), '删除');
}
beforeEach(() => {
  closeDialog(); dom.node('modal').hidden = true; resetUiState(); dom.location.pathname = '/'; dom.location.hash = '';
  preview = freshPreview(); failure = null; previewGate = null; deleteGate = null; readGate = null; transcriptGate = null;
  noticeAckGate = null; noticeReply = null;
  requests = []; paths = []; navigation = [];
  restoreNavigation = registerNavigation({
    refresh: async () => { navigation.push(['refresh', ui.selected]); },
    detail: async id => { navigation.push(['detail', id]); }, overview: async () => { navigation.push(['overview']); },
    resource: id => { navigation.push(['resource', id]); return openResource(id); },
  });
});
afterEach(() => { closeDialog(); restoreNavigation(); });
afterAll(() => dom.restore());

test('detail, full graph and minimal more menu share a non-Agent deletion with complete resource confirmation', async () => {
  for (const mode of ['detail', 'graph', 'minimal']) {
    let control;
    if (mode === 'detail') control = detailView();
    else {
      activateDetailView({ view: 'task-graph' }); ui.taskGraphMinimal = mode === 'minimal';
      renderTaskGraph({ total: 2, nodes: [task, child], edges: [] });
      const card = dom.node('detail').querySelector('[data-task-id="70"]');
      if (mode === 'minimal') card.querySelector('.task-graph-more-trigger').onclick();
      control = buttonOf(card, '删除');
    }
    expect(control).toBeTruthy(); expect(control.classList.contains('agent-call')).toBe(false);
    expect(control.getAttribute('data-help')).toContain('无法恢复');
    const pending = control.onclick(); await flush();
    const text = dialogText(dom);
    for (const part of ['#70', '#71', 'Input O57', '71-child', 'task-70-input.md', '未提交和未合并代码', '无法恢复', '不是验收或资源清理', '保留运行历史', 'Git 提交历史']) expect(text).toContain(part);
    expect(buttonOf(dom.node('modal'), '彻底删除').classList.contains('agent-call')).toBe(false);
    expect(dom.node('modal').querySelectorAll('input').length).toBe(0);
    await answerDialog(dom, '保留'); await pending;
  }
  expect(deletions()).toEqual([]);
});

test('main/owner cannot be deleted; active and stopping workers have focusable manual-cancel help', async () => {
  for (const task_kind of ['main', 'owner']) {
    expect(workerDeleteControl({ ...task, task_kind })).toBeNull();
    renderDetail({ ...task, task_kind }, null, null, null);
    expect(buttonOf(dom.node('detail'), '删除')).toBeUndefined();
  }
  for (const status of ['queued', 'running', 'waiting', 'awaiting', 'paused', 'awaiting_acceptance']) {
    const host = workerDeleteControl({ ...task, status });
    expect(host.classList.contains('help-host')).toBe(true); expect(host.tabIndex).toBe(0);
    expect(host.getAttribute('data-help')).toContain('手动取消');
    const control = buttonOf(host, '删除'); expect(control.disabled).toBe(true);
    await control.onclick();
  }
  expect(buttonOf(workerDeleteControl({ ...task, agent: { active: true } }), '删除').disabled).toBe(true);
  expect(requests).toEqual([]);
});

test('blocked, failed and incomplete previews never submit a mutation or remove the original view', async () => {
  for (const mode of ['blocked', 'failed', 'incomplete', 'truncated']) {
    preview = freshPreview(); failure = mode === 'failed' ? 'preview' : null;
    if (mode === 'blocked') { preview.can_delete = false; preview.blockers = ['外部 Worker #90 仍依赖它']; }
    if (mode === 'incomplete') delete preview.resources.files;
    if (mode === 'truncated') preview.truncated = true;
    const control = detailView(), panel = dom.node('detail').children;
    await control.onclick();
    expect(deletions()).toEqual([]); expect(dom.node('modal').hidden).toBe(true);
    expect(dom.node('detail').children).toEqual(panel); expect(control.disabled).toBe(false);
    expect(ui.deletedWorkerIds.size).toBe(0);
  }
});

test('one fixed revision is submitted once; success purges subtree caches before returning to Worker list', async () => {
  const control = detailView();
  const notice = { id: 8, task_id: 70, created_at: 'now', kind: 'questionnaire' };
  ui.lastSnapshot = { revision: 'old', status: { project: '/tmp/example' }, tasks: [task, child, { id: 90 }], notices: [notice], inputs: [{ id: 57 }, { id: 80 }] };
  ui.noticeIndex.set(8, notice); ui.noticeFocus = 8;
  ui.noticeRecords = { rows: [notice], task, selected: 8, signature: 'old' };
  ui.questionDrafts.set('lush.decision:/tmp/example:8:now', { answers: [] });
  ui.taskHistory = [task, child, { id: 90 }]; ui.taskHistoryPage = { cursor: 70 };
  for (const id of [70, 71, 90]) { transcriptCache.set(id, { steps: [] }); transcriptOpen.add(id); mergeSelection.add(id); ui.taskGraphIds.add(id); }
  ui.stepToggle.set('70:1', true); ui.stepToggle.set('90:1', true);
  const pending = control.onclick(); await flush();
  await control.onclick();
  expect(deletions()).toEqual([]);
  const waiting = gate(); deleteGate = waiting.promise;
  await answerDialog(dom, '彻底删除'); await flush();
  await control.onclick();
  expect(deletions()).toEqual([{ method: 'worker.delete', params: { id: 70, revision: 'fixed-revision-1', confirm: true } }]);
  waiting.release(); await pending;
  expect(navigation).toEqual([['resource', 'tasks'], ['refresh', null]]);
  expect(ui.view.id).toBe('tasks'); expect(ui.selected).toBeNull();
  expect([...ui.deletedWorkerIds]).toEqual([70, 71]); expect(control.disabled).toBe(true);
  expect(ui.taskHistory.map(row => row.id)).toEqual([90]); expect(ui.taskHistoryPage).toBeNull();
  expect([...transcriptCache.keys()]).toEqual([90]); expect([...transcriptOpen]).toEqual([90]); expect([...mergeSelection]).toEqual([90]);
  expect(ui.noticeIndex.has(8)).toBe(false); expect(ui.noticeRecords.rows).toEqual([]); expect(ui.noticeRecords.task).toBeNull();
  expect(ui.noticeFocus).toBeNull(); expect(ui.questionDrafts.size).toBe(0);
  expect([...ui.stepToggle.keys()]).toEqual(['90:1']); expect(ui.lastSnapshot.tasks.map(row => row.id)).toEqual([90]);
  expect(ui.lastSnapshot.inputs.map(row => row.id)).toEqual([80]); expect(ui.lastSnapshot.revision).toBeUndefined();
});

test('deletion evicts notice ACK history and a late acknowledgement or stale banner cannot restore it', async () => {
  const control = detailView();
  const notice = { id: 18, task_id: 70, source_event_id: 20, created_at: 'now', kind: 'info', status: 'sent', title: '本轮已结束' };
  const cached = { ...notice, id: 19, read_at: 'earlier' };
  const unrelated = { ...cached, id: 28, task_id: 90 };
  ui.lastSnapshot = { status: { project: '/tmp/example' }, tasks: [task, child], notices: [notice] };
  ui.noticeIndex.set(notice.id, notice);
  ui.noticeReadRows.set(noticeIdentity(cached), cached); ui.noticeReadRows.set(noticeIdentity(unrelated), unrelated);
  const ack = gate(); noticeAckGate = ack.promise; noticeReply = { ...notice, read_at: 'later' };
  const reading = readNotice(notice); await flush();
  const deleting = control.onclick(); await flush(); await answerDialog(dom, '彻底删除'); await deleting;
  expect([...ui.noticeReadRows.values()]).toEqual([unrelated]);
  const afterDeleteNavigation = [...navigation];
  ack.release(); await reading;
  expect([...ui.noticeReadRows.values()]).toEqual([unrelated]);
  expect(ui.noticeIndex.has(notice.id)).toBe(false); expect(navigation).toEqual(afterDeleteNavigation);
  const stale = { status: { project: '/tmp/example' }, notices: [notice] };
  renderNoticeBanner(stale); expect(dom.node('notice-banner').hidden).toBe(true);
  renderNotices(stale); expect(stale.notices).toEqual([]); expect(ui.noticeIndex.has(notice.id)).toBe(false);
});

test('mutation failure retains the original view/cache and retry obtains a new preview and confirmation', async () => {
  const control = detailView(), view = ui.view;
  transcriptCache.set(70, { steps: ['history'] });
  failure = 'delete';
  let pending = control.onclick(); await flush(); await answerDialog(dom, '彻底删除'); await pending;
  expect(dom.node('error').textContent).toContain('资源发生变化'); expect(control.disabled).toBe(false);
  expect(ui.view).toBe(view); expect(transcriptCache.has(70)).toBe(true); expect(ui.deletedWorkerIds.size).toBe(0);
  expect(navigation).toEqual([]);
  preview.revision = 'fixed-revision-2'; failure = null;
  pending = control.onclick(); await flush();
  expect(deletions().length).toBe(1);
  await answerDialog(dom, '彻底删除'); await pending;
  expect(requests.filter(row => row.method === 'preview').length).toBe(2);
  expect(deletions().at(-1).params.revision).toBe('fixed-revision-2');
});

test('a successful graph deletion refreshes the same graph and filters even a stale graph response', async () => {
  activateDetailView({ view: 'task-graph' });
  ui.taskGraphMinimal = false; // 此场景从详情模式的就地删除入口操作。
  renderTaskGraph({ total: 2, nodes: [task, child], edges: [] });
  const pending = buttonOf(dom.node('detail').querySelector('[data-task-id="70"]'), '删除').onclick(); await flush();
  await answerDialog(dom, '彻底删除'); await pending;
  expect(ui.view.id).toBe('task-graph'); expect(navigation).toEqual([['refresh', null]]);
  expect(requests.some(row => row.method === 'graph')).toBe(true);
  expect(dom.node('detail').querySelector('[data-task-id="70"]')).toBeNull();
  expect(dom.node('detail').querySelector('[data-task-id="71"]')).toBeNull();
});

test('navigation while preflight or final confirmation is pending prevents an unexpected dialog or mutation', async () => {
  let waiting = gate(); previewGate = waiting.promise;
  let control = detailView(), pending = control.onclick(); await flush();
  await control.onclick(); expect(requests.filter(row => row.method === 'preview').length).toBe(1);
  activateDetailView({ view: 'settings' }); waiting.release(); await pending;
  expect(dom.node('modal').hidden).toBe(true); expect(deletions()).toEqual([]);
  previewGate = null; control = detailView(); pending = control.onclick(); await flush();
  activateDetailView({ view: 'settings' }); await answerDialog(dom, '彻底删除'); await pending;
  expect(ui.view.id).toBe('settings'); expect(deletions()).toEqual([]);
});

test('navigation during the deletion request never jumps back; success still evicts the deleted cache', async () => {
  const waiting = gate(); deleteGate = waiting.promise;
  const control = detailView(), pending = control.onclick(); await flush();
  await answerDialog(dom, '彻底删除'); await flush();
  const view = activateDetailView({ view: 'settings' });
  transcriptCache.set(70, { steps: ['old'] });
  waiting.release(); await pending;
  expect(ui.view).toBe(view); expect(navigation).toEqual([]);
  expect(transcriptCache.has(70)).toBe(false); expect(ui.deletedWorkerIds.has(70)).toBe(true);
});

test('project-routed preflight and delete stay in the initiating project; unrelated input editor survives', async () => {
  dom.location.pathname = '/p/0123456789abcdef/';
  const waiting = gate(); deleteGate = waiting.promise;
  const control = detailView(), pending = control.onclick(); await flush();
  await answerDialog(dom, '彻底删除'); await flush();
  const view = activateDetailView({ view: 'inputs' });
  const editor = { view, items: new Map([['draft:90', { kind: 'draft', id: 90 }], ['input:57', { kind: 'input', id: 57 }]]), editor: { text: 'unsaved' } };
  ui.inputsPage = editor;
  waiting.release(); await pending;
  expect(paths).toContain('/p/0123456789abcdef/api/worker/70/delete-preview');
  expect(paths).toContain('/p/0123456789abcdef/api/action');
  expect(ui.view).toBe(view); expect(ui.inputsPage).toBe(editor); expect(editor.editor.text).toBe('unsaved');
  expect([...editor.items.keys()]).toEqual(['draft:90']); expect(navigation).toEqual([]);
});

test('refresh failure after successful deletion is reported separately and never resubmits the delete', async () => {
  restoreNavigation();
  restoreNavigation = registerNavigation({ refresh: async () => { throw new Error('离线'); }, detail: async () => {}, overview: async () => {}, resource: openResource });
  const control = detailView(), pending = control.onclick(); await flush();
  await answerDialog(dom, '彻底删除'); await pending;
  expect(dom.node('error').textContent).toContain('删除已完成，刷新失败');
  expect(control.disabled).toBe(true); await control.onclick();
  expect(deletions().length).toBe(1); expect(ui.deletedWorkerIds.has(70)).toBe(true);
});

test('late detail and transcript responses cannot restore a deleted identity or populate its cache', async () => {
  const reading = gate(), transcript = gate(); readGate = reading.promise; transcriptGate = transcript.promise;
  const detailPending = loadDetail(70); const transcriptPending = loadTranscript(70); await flush();
  const pending = runWorkerDelete(task); await flush(); await answerDialog(dom, '彻底删除'); await pending;
  const view = ui.view, text = deepText(dom.node('detail'));
  reading.release(); transcript.release(); await detailPending; await transcriptPending;
  expect(ui.view).toBe(view); expect(deepText(dom.node('detail'))).toBe(text);
  expect(transcriptCache.has(70)).toBe(false);
  expect(await loadDetail(70)).toBe(false);
});
