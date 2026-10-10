import { $, badge, button, el, syncChildren } from './dom.js';
import { api } from './api.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { absolute } from './format.js';
import { renderMarkdown } from './markdown.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { workerLabel } from './worker-label.js';
import { questionnairePanel } from './render-questionnaire.js';
import { notificationControl } from './notice-notifications.js';
import { unreadNotice } from './notice-kind.js';
import { refreshGlobalNotices } from './global-notice-notifications.js';
import { INBOX_STATUSES, inboxHash, inboxIdentity, inboxMatches, pendingNotice, sourceWorkerLinks,
  noticeSyncIdentity, sameInboxRecord, validProjectId, validateInboxItem, validateInboxPage } from './global-inbox-model.js';

const LABELS = { all: '全部记录', open: '需要我决定', unread: '未读告知', automatic: '自动选择', failed: '异常与受阻' };
const STATUS = { open: '待决定', answered: '已回答', dismissed: '已忽略', sent: '告知' };
let cache;
function currentCache() {
  if (cache?.boot !== ui.workerNumbers) cache = { boot: ui.workerNumbers, acknowledged: new Map(), pending: new Map(), replies: new Map() };
  return cache;
}
const offlineReason = '来源项目离线，显示最后确认的记录；不能提交答案或标记已读。不会自动启动后台。';
const noticeSource = notice => notice.answer_source === 'lush' ? 'Lush 自动选择'
  : notice.answer_source === 'user' ? '用户答复' : '答复来源未记录';
function helpHost(control, reason) {
  if (!reason) return control;
  const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', reason); host.setAttribute('tabindex', '0');
  host.setAttribute('role', 'group'); host.setAttribute('aria-label', reason);
  control.disabled = true; host.append(control); return host;
}
function workerLink(item) {
  const link = el('a', `打开 Worker ${workerLabel(item.notice.task_id, item.notice.task_worker_number)}`, 'ghost global-inbox-worker');
  link.setAttribute('href', `/p/${item.project_id}/#worker-${item.notice.task_id}`);
  link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener');
  link.setAttribute('data-help', '在独立项目标签查看来源 Worker，保留当前页面；仅打开视图，不提交答案或启动 Agent。');
  return link;
}
function overlay(item, state) {
  const acknowledged = state.cache.acknowledged.get(inboxIdentity(item));
  return acknowledged ? { ...item, notice: acknowledged.notice } : item;
}
function replyDraft(item, state) {
  const key = `lush.global-reply:${inboxIdentity(item)}`;
  let draft = state.cache.replies.get(key);
  if (!draft) { try { draft = JSON.parse(sessionStorage.getItem(key)); } catch { /* unavailable */ } }
  if (draft?.body !== item.notice.body || typeof draft.text !== 'string' || draft.text.length > 4000) draft = { body: item.notice.body, text: '' };
  state.cache.replies.set(key, draft);
  return { draft, save() { ui.detailDirty = true; try { sessionStorage.setItem(key, JSON.stringify(draft)); } catch { /* memory fallback */ } },
    clear() { state.cache.replies.delete(key); try { sessionStorage.removeItem(key); } catch { /* unavailable */ } } };
}

/** All writes keep the originating identity. The successful ACK, not a subsequent refresh, settles the UI. */
async function mutate(state, item, method, answer) {
  if (!item.online) throw new Error(offlineReason);
  if (!state.current()) throw new Error('页面已切换，未提交此事项');
  const key = inboxIdentity(item);
  if (state.cache.pending.has(key)) throw new Error('此事项正在提交，请等待确认');
  const promise = api('/api/host/inbox/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: item.project_id, id: item.notice.id, method,
      ...(noticeSyncIdentity(item.notice) ? { expected_identity: item.notice.sync_identity } : {}),
      ...(answer === undefined ? {} : { answer }) }) });
  state.cache.pending.set(key, promise);
  try {
    const result = validateInboxItem(await promise);
    if (!sameInboxRecord(item, result) || result.project !== item.project
      || (method === 'notice.answer' && result.notice.status !== 'answered')
      || (method === 'notice.dismiss' && result.notice.status !== 'dismissed')
      || (method === 'notice.read' && !result.notice.read_at)) throw new Error('事项确认与原来源不一致，请重新核验；输入已保留');
    state.cache.acknowledged.set(key, result);
    state.cache.acknowledged.set(inboxIdentity(result), result);
    if (state.current()) {
      state.rows = state.rows.map(row => inboxIdentity(row) === key ? result : row);
      if (state.selected && inboxIdentity(state.selected) === key) state.selected = result;
      ui.detailDirty = false;
      paintRows(state); paintSelected(state);
      state.message.textContent = method === 'notice.read' ? '告知已读。' : '答复已提交。';
    }
    // Refresh failures are deliberately outside the submit failure path.
    void refreshGlobalNotices().catch(error => {
      if (state.current()) state.message.textContent = `事项已处理，但汇总刷新失败：${error.message}；可稍后刷新。`;
    });
    return result;
  } finally { if (state.cache.pending.get(key) === promise) state.cache.pending.delete(key); }
}

function buildDetail(state, item) {
  const notice = item.notice, root = el('section', undefined, 'notice focus global-inbox-detail');
  root.dataset.noticeIdentity = inboxIdentity(item);
  const head = el('div', undefined, 'notice-head');
  head.append(badge(STATUS[notice.status] || notice.status, pendingNotice(notice) ? 'b-awaiting' : 'b-neutral'),
    el('strong', item.project_name), el('span', workerLabel(notice.task_id, notice.task_worker_number), 'tid'),
    el('span', absolute(notice.created_at), 'when'));
  if (['answered', 'dismissed'].includes(notice.status) && ['question', 'questionnaire'].includes(notice.kind)) head.append(badge(noticeSource(notice), 'b-neutral'));
  root.append(head, el('h2', notice.title), workerLink(item));
  if (!item.online) root.append(el('p', `${offlineReason} 最后确认：${item.checked_at ? absolute(item.checked_at) : '未知'}`, 'hint'));
  if (notice.kind === 'questionnaire') {
    root.append(questionnairePanel(notice, {
      sourceProjectId: item.project_id, draftScope: `global:${item.project_id}:${notice.created_at}`,
      readOnly: !item.online, previewOnline: item.online, disabledReason: offlineReason, dismissAgent: true,
      settle: answer => mutate(state, item, 'notice.answer', answer),
      dismiss: () => mutate(state, item, 'notice.dismiss'),
    }));
  } else {
    root.append(renderMarkdown(notice.body || '（没有补充说明）'));
    if (pendingNotice(notice)) {
      const reply = replyDraft(item, state), input = el('textarea');
      input.rows = 3; input.maxLength = 4000; input.value = reply.draft.text;
      input.placeholder = '你的决定；⌘/Ctrl+回车提交'; input.setAttribute('aria-label', `${item.project_name}：${notice.title}的答复`);
      input.addEventListener('input', () => { reply.draft.text = input.value; reply.save(); });
      let busy = false;
      const actions = el('div', undefined, 'actions'), error = el('p', '', 'error'); error.setAttribute('role', 'alert');
      const send = async dismiss => {
        if (busy || !item.online || !state.current()) return;
        if (!dismiss && !input.value.trim()) { error.textContent = '请填写你的决定。'; return; }
        if (dismiss && !await confirmDialog({ title: '忽略这个问题？', message: '这不代表批准任何方案，Worker 会收到未做决定的消息。', confirmLabel: '忽略问题', danger: true })) return;
        if (!state.current()) return;
        busy = true; error.textContent = '';
        actions.querySelectorAll('button').forEach(node => { node.disabled = true; });
        try { await mutate(state, item, dismiss ? 'notice.dismiss' : 'notice.answer', dismiss ? undefined : input.value.trim()); reply.clear(); }
        catch (failure) {
          if (state.current()) { error.textContent = `未提交成功：${failure.message}。输入已保留，可重试。`; actions.querySelectorAll('button').forEach(node => { node.disabled = !item.online; }); }
        } finally { busy = false; }
      };
      actions.append(helpHost(button('提交决定并继续 Worker', () => send(false), undefined,
        { agent: true, help: agentHelp('把决定发送给来源项目 Worker，使其继续执行。') }), item.online ? '' : offlineReason),
      helpHost(button('忽略问题', () => send(true), 'ghost', { agent: true, help: agentHelp('把未做决定的消息送给来源 Worker，不代表批准任何方案。') }), item.online ? '' : offlineReason));
      input.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(false); } });
      root.append(input, actions, error);
    } else if (notice.status === 'answered' || notice.status === 'dismissed') {
      if (notice.answer_source === 'lush') root.append(el('p', '这是 Lush 自动答复，不是用户亲自作出的决定。', 'hint'));
      root.append(el('p', notice.answer || (notice.status === 'dismissed' ? '已忽略 · 不代表批准' : '未记录答复'), 'notice-body'));
    } else if (notice.kind === 'plan' && notice.status === 'open') root.append(el('p', '历史计划事项请在来源项目查看；此处不提供已停用的计划审批入口。', 'hint'));
  }
  if (unreadNotice(notice)) {
    const error = el('p', '', 'error'); error.setAttribute('role', 'alert');
    const known = button('已知', async () => {
      if (!item.online || !state.current()) return;
      try { await mutate(state, item, 'notice.read'); }
      catch (failure) { if (state.current()) error.textContent = `已读未确认：${failure.message}；原告知保留，可重试。`; }
    }, 'ghost', { help: '只把这一条来源项目告知标为已读，不提交答案、不批准合并或调用 Agent。' });
    root.append(helpHost(known, item.online ? '' : offlineReason), error);
  } else if (notice.kind === 'info' && notice.read_at) root.append(el('p', `已读 · ${absolute(notice.read_at)}`, 'hint'));
  return sourceWorkerLinks(root, item.project_id);
}
function paintSelected(state) {
  if (!state.current() || !state.selected) return;
  const signature = JSON.stringify(state.selected);
  if (signature === state.selectedSignature) return;
  state.selectedSignature = signature;
  state.focus.replaceChildren(buildDetail(state, state.selected));
}
function paintRows(state) {
  if (!state.current()) return;
  const rows = state.rows.filter(item => (!state.projectId || state.projectId === item.project_id) && inboxMatches(item, state.status));
  const known = new Map([...state.list.children].map(node => [node.dataset.noticeIdentity, node]));
  syncChildren(state.list, rows.map(item => {
    const key = inboxIdentity(item), signature = JSON.stringify(item);
    const node = known.get(key) || button('', () => openGlobalInbox({ projectId: item.project_id, noticeId: item.notice.id, status: state.status }), 'notice-brief global-inbox-row');
    node.dataset.noticeIdentity = key;
    node.classList.toggle('selected', state.selected && inboxIdentity(state.selected) === key);
    if (node.dataset.signature !== signature) {
      node.dataset.signature = signature;
      const line = el('span', undefined, 'row');
      line.append(badge(item.project_name, 'b-neutral'), el('span', workerLabel(item.notice.task_id, item.notice.task_worker_number), 'tid'),
        el('span', unreadNotice(item.notice) ? '未读告知' : STATUS[item.notice.status] || item.notice.status));
      if (!item.online) line.append(badge('离线缓存', 'b-neutral'));
      if (item.notice.answer_source === 'lush') line.append(badge('Lush 自动选择', 'b-neutral'));
      node.replaceChildren(line, el('span', item.notice.title, 'goal'));
    }
    node.setAttribute('data-help', '就地查看来源事项与答复，不自动标已读、不启动 Agent。');
    return node;
  }));
  state.footer.replaceChildren(el('p', rows.length ? `已显示 ${rows.length} 条记录` : state.page?.has_more ? '本页没有符合筛选的记录；仍可加载更早记录。' : state.page?.complete ? '没有符合筛选的记录' : '当前已同步范围内，没有符合筛选的记录。', 'hint'));
  if (state.page?.has_more) state.footer.append(button('加载更早记录', () => loadRows(state, true), 'ghost'));
}
function paintSources(state, projects, complete) {
  if (!state.current()) return;
  const confirmed = complete && projects.every(source => source.online && source.complete);
  state.sources.replaceChildren(el('p', confirmed ? '已同步当前可访问项目。' : '部分项目离线或尚未同步完整；下面是已确认／缓存的记录，不代表所有项目的实时全量。', 'hint'));
  for (const source of projects.filter(row => !row.online || !row.complete)) state.sources.append(el('p',
    `${source.name}：${!source.online ? '离线' : '正在补齐'} · 最后确认 ${source.checked_at ? absolute(source.checked_at) : '未知'}${source.error ? ` · ${source.error}` : ''}`, 'hint'));
}
async function loadRows(state, more = false) {
  if (!state.current() || state.listBusy) return;
  const request = ++state.listRequest; state.listBusy = true;
  const before = more && state.page?.has_more ? `&before=${encodeURIComponent(state.page.cursor)}` : '';
  try {
    const page = validateInboxPage(await api(`/api/host/inbox?status=${state.status}&limit=30${before}`, { signal: state.controller.signal }));
    if (!state.current() || request !== state.listRequest) return;
    const rows = page.items.map(item => overlay(item, state));
    const allowed = new Set(page.projects.map(source => source.id));
    state.rows = [...new Map([...(more ? state.rows : []), ...rows].filter(item => allowed.has(item.project_id))
      .map(item => [inboxIdentity(item), item])).values()];
    state.page = page;
    if (state.selected) {
      const source = page.projects.find(source => source.id === state.selected.project_id);
      if (!source) { state.selected = null; state.selectedSignature = null; state.focus.replaceChildren(); }
      else state.selected = overlay({ ...state.selected, online: source.online }, state);
      // A list response is not a newer detail read: never replace its body/answer or editing DOM.
    }
    paintSources(state, page.projects, page.complete); paintRows(state); paintSelected(state);
  } catch (error) {
    if (state.current() && error.name !== 'AbortError') {
      state.message.textContent = `记录加载失败：${error.message}；已有内容和输入已保留。`;
      state.footer.append(button('重试加载', () => loadRows(state, more), 'ghost'));
    }
  } finally { if (request === state.listRequest) state.listBusy = false; }
}
async function loadSelected(state, noticeId) {
  if (!state.current()) return;
  const request = ++state.focusRequest;
  try {
    const item = overlay(validateInboxItem(await api(`/api/host/inbox/notice?project_id=${state.projectId}&id=${noticeId}`, { signal: state.controller.signal })), state);
    if (!state.current() || request !== state.focusRequest) return;
    if (item.project_id !== state.projectId || item.notice.id !== noticeId
      || (state.page && !state.page.projects.some(source => source.id === item.project_id))) throw new Error('事项来源不匹配或已移除');
    state.selected = item; paintSelected(state); paintRows(state);
  } catch (error) {
    if (state.current() && error.name !== 'AbortError') state.focus.replaceChildren(el('p', `事项读取失败：${error.message}`, 'error'), button('重试读取', () => loadSelected(state, noticeId), 'ghost'));
  }
}

/** Root Host view; source actions never use the page's current project or integer-only notice cache. */
export async function openGlobalInbox({ projectId = null, noticeId = null, status = 'all', push = true } = {}) {
  if ((projectId !== null && !validProjectId(projectId)) || !INBOX_STATUSES.includes(status)
    || (noticeId !== null && (!Number.isSafeInteger(noticeId) || noticeId <= 0 || !projectId))) throw new Error('无效的全局收件箱地址');
  const hash = noticeId ? inboxHash(projectId, noticeId) : status === 'all' ? '#notices' : `#notices-${status}`;
  const view = activateDetailView({ view: 'global-inbox', key: `global-inbox:${status}:${projectId || ''}:${noticeId || ''}`,
    title: '全局收件箱', context: '用户工作台', hint: '所有可访问项目的待决、告知与自动选择记录', hash, push });
  ui.globalInboxPage?.controller.abort();
  const state = { view, status, projectId, cache: currentCache(), controller: new AbortController(),
    rows: [], selected: null, selectedSignature: null, page: null, listRequest: 0, focusRequest: 0, listBusy: false };
  ui.globalInboxPage = state;
  const owner = globalThis.document, pathname = location.pathname, routeHash = location.hash;
  state.current = () => owner === globalThis.document && ui.globalInboxPage === state && ui.view === view
    && location.pathname === pathname && location.hash === routeHash;
  ui.disposeDetailRequests = () => state.controller.abort();
  const root = el('div', undefined, 'workbench-view global-inbox');
  const head = el('header', undefined, 'global-inbox-head'); head.append(el('h1', '全局收件箱'), el('p', '各项目保存原记录；这里统一查看和处理，不会自动启动已停止的项目后台。', 'hint'));
  const filters = el('div', undefined, 'filters');
  for (const value of INBOX_STATUSES) {
    const filter = button(LABELS[value], () => openGlobalInbox({ status: value }), 'ghost');
    filter.setAttribute('aria-pressed', String(value === status)); filters.append(filter);
  }
  const refresh = button('刷新记录', () => Promise.all([loadRows(state), noticeId ? loadSelected(state, noticeId) : Promise.resolve()]), 'ghost');
  const tools = el('div', undefined, 'resource-tools'); tools.append(filters, refresh, notificationControl());
  state.sources = el('div', undefined, 'global-inbox-sources');
  state.message = el('p', '', 'hint'); state.message.setAttribute('role', 'status');
  state.list = el('div', undefined, 'global-inbox-list'); state.footer = el('div', undefined, 'global-inbox-footer');
  state.focus = el('div', undefined, 'global-inbox-focus');
  root.append(head, tools, state.sources, state.message, state.list, state.footer, state.focus);
  $('detail').replaceChildren(root);
  await Promise.all([loadRows(state), noticeId ? loadSelected(state, noticeId) : Promise.resolve()]);
}
