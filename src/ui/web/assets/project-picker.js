import { api } from './api.js';
import { confirmDialog } from './dialog.js';
import { el } from './dom.js';
import { projectHref, projectRoute } from './route.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';

function node(id) { return globalThis.document?.getElementById?.(id) ?? null; }
let launcher = false;
let hostStatus = null;
let projectUsable = false;
let managerRequest = 0;

export function workbenchStatus() {
  return { launcher, host: hostStatus, projectUsable, project: projectRoute() };
}

function setError(message = '', target = node('project-error')) {
  if (target) { target.textContent = message; target.hidden = !message; }
}

function summaryText(row) {
  if (row.error) return row.error;
  if (row.running === false) return '后台未运行或不可达';
  const summary = row.summary;
  if (!summary) return row.running ? '运行中' : '未打开';
  const parts = ['运行中'];
  if (Number.isSafeInteger(summary.pid) && summary.pid > 0) parts.push(`PID ${summary.pid}`);
  if (summary.notices > 0) parts.push(`待决 ${summary.notices}`);
  if (summary.waiting_approval > 0) parts.push(`待批计划 ${summary.waiting_approval}`);
  if (summary.agents_total > 0) parts.push(`执行中 ${summary.agents_total}`);
  if (summary.pending_merges > 0) parts.push(`待合并 ${summary.pending_merges}`);
  if (!summary.agents_total) parts.push('空闲');
  return parts.join(' · ');
}

function controlCapability() {
  const value = hostStatus?.capabilities?.project_control ?? hostStatus?.project_control;
  return value === true || value?.supported === true;
}

async function projectControl(kind, row, status, repaint) {
  const copy = {
    start: ['启动项目后台？', `启动 ${row.name || row.project} 的项目 daemon。`, '启动'],
    stop: ['停止项目后台？', '仅在没有活动调用、Git 写入或其它繁忙工作时安全停止；不会取消 Worker。', '停止'],
    remove: ['移除项目入口？', '只从此 Host 的项目列表移除入口并断开 Web 连接，不停止项目后台，也不删除项目数据。', '移除'],
  }[kind];
  if (!copy) return;
  const confirmed = await confirmDialog({ title: copy[0], message: copy[1], detail: row.project || '', confirmLabel: copy[2], danger: kind !== 'start' });
  if (!confirmed) return;
  status.textContent = `${copy[2]}中…`;
  try {
    const endpoint = kind === 'remove' ? '/api/host/remove' : `/api/host/projects/${kind}`;
    await api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: row.id }) });
    await repaint();
  } catch (error) { status.textContent = error.message; status.classList.add('error'); }
}

function projectOrderSlot(row, list) {
  const slot = el('div', undefined, 'project-order');
  const owner = document, identity = ui.view;
  const ownsPage = () => owner === globalThis.document && identity === ui.view
    && node('detail')?.querySelector('.project-manager-list') === list && slot.parentNode?.parentNode === list;
  slot.row = row;
  const toggle = el('button', '新建 Worker…', 'ghost'); toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('data-help', '展开此项目的新指令输入；仅打开表单，不创建 Worker 或调用 Agent。');
  const message = el('p', undefined, 'error'); message.hidden = true;
  let loading = false;
  toggle.onclick = async () => {
    if (!ownsPage() || loading) return;
    if (slot.control) { slot.control.root.hidden = !slot.control.root.hidden; toggle.setAttribute('aria-expanded', String(!slot.control.root.hidden)); return; }
    loading = true; message.hidden = true;
    try {
      const { createProjectOrderForm } = await import('./project-order-form.js');
      if (!ownsPage()) return;
      slot.control = createProjectOrderForm(slot.row, { ownsPage }); slot.append(slot.control.root);
      toggle.setAttribute('aria-expanded', 'true');
    } catch (error) { if (ownsPage()) { message.hidden = false; message.textContent = error.message; } }
    finally { loading = false; }
  };
  slot.append(toggle, message); return slot;
}

function projectItem(row, repaint, { compact = false, orderSlot = null, restartControls = null } = {}) {
  const item = el('li', undefined, 'project-item');
  const link = el('a', undefined, 'project-open');
  link.href = projectHref(row.id); link.target = '_blank'; link.rel = 'noopener';
  link.append(el('strong', row.name || '未命名项目'), el('small', row.project || '路径不可用'));
  // Keep a real link for modifier clicks and popup-blocked fallback. Ordinary
  // open is explicit start, never a side effect of reading the project list.
  let opening = false;
  if (controlCapability() || launcher) link.onclick = event => {
    if (event?.button > 0 || event?.metaKey || event?.ctrlKey || event?.shiftKey || event?.altKey) return;
    event?.preventDefault?.();
    if (opening) return;
    opening = true;
    const popup = reserveProjectWindow();
    const endpoint = controlCapability() ? '/api/host/projects/start' : '/api/host/select';
    const body = controlCapability() ? { id: row.id } : { project: row.project };
    void api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(result => {
        const target = projectHref(result?.id || row.id);
        if (!completeProjectWindow(popup, target)) {
          link.onclick = null;
          status.textContent = '后台已就绪；点此项目在新窗口打开';
        }
      })
      .catch(error => { popup?.close?.(); status.textContent = error.message; status.classList.add('error'); })
      .finally(() => { opening = false; });
  };
  const status = el('span', summaryText(row), `project-status${row.error ? ' error' : ''}`);
  item.append(link, status);
  if (!compact) {
    const actions = el('span', undefined, 'project-item-actions');
    if (controlCapability()) {
      const kind = row.running ? 'stop' : 'start';
      const control = el('button', kind === 'stop' ? '停止后台' : '启动后台', 'ghost'); control.type = 'button';
      control.setAttribute('data-help', kind === 'stop' ? '通过空闲准入安全停止项目后台；不会取消 Worker 或删除项目' : '显式启动这个项目的后台；读取列表不会自动启动');
      control.onclick = () => void projectControl(kind, row, status, repaint); actions.append(control);
    }
    if (restartControls) actions.append(restartControls.projectControl(row));
    if (launcher) {
      const remove = el('button', '移除入口', 'ghost project-remove'); remove.type = 'button';
      remove.setAttribute('data-help', '只删除这个 Host 保存的项目入口，不停止后台、不删除项目或 Worker 数据');
      remove.onclick = () => void projectControl('remove', row, status, repaint); actions.append(remove);
    }
    if (!projectRoute()) {
      const color = el('button', '配色', 'ghost project-color-open'); color.type = 'button';
      color.setAttribute('aria-label', `${row.name || '项目'}辨识配色`);
      color.setAttribute('aria-expanded', 'false');
      let editor = null, openingColor = false, colorEpoch = 0;
      color.onclick = async () => {
        const identity = ui.view, owner = globalThis.document, list = item.parentNode;
        if (openingColor) return;
        if (editor) { ++colorEpoch; editor.dispose(); editor.root.remove(); editor = null; color.setAttribute('aria-expanded', 'false'); return; }
        openingColor = true; const epoch = ++colorEpoch;
        const ownsPage = () => epoch === colorEpoch && owner === globalThis.document && identity === ui.view && item.parentNode === list;
        try {
          const { renderProjectColorEditor } = await import('./project-color-editor.js');
          if (!ownsPage()) return;
          editor = renderProjectColorEditor(row.id, { ownsPage }); item.append(editor.root);
          color.setAttribute('aria-expanded', 'true'); await editor.ready;
        } catch (error) { if (ownsPage()) status.textContent = `配色暂不可用：${error.message}`; }
        finally { openingColor = false; }
      };
      actions.append(color);
    }
    item.append(actions);
    if (orderSlot) { orderSlot.remove(); item.append(orderSlot); }
  }
  return item;
}

function paintProjects(list, projects) {
  list.projects = projects;
  list.restartControls?.updateProjects(projects);
  const previous = list.orderSlots || new Map(), next = new Map();
  list.replaceChildren(...projects.map(row => {
    const slot = previous.get(row.id) || projectOrderSlot(row, list);
    slot.row = row; next.set(row.id, slot);
    return projectItem(row, refreshProjectList, { orderSlot: slot, restartControls: list.restartControls });
  }));
  list.orderSlots = next;
  for (const slot of next.values()) slot.control?.update(slot.row);
  const total = node('detail')?.querySelector('.project-roster-summary');
  if (total) {
    const running = projects.filter(row => row.running === true).length;
    const unavailable = projects.filter(row => row.running !== true).length;
    total.textContent = `已登记 ${projects.length} 个项目 · 在线后台 ${running} · 未运行或不可达 ${unavailable} · 本次读取 ${new Date().toLocaleTimeString()}`;
  }
}

/** 仅刷新已打开的后台总览；只探测已登记项目，不启动后台或清空目录与指令输入。 */
export async function refreshProjectList() {
  const identity = ui.view;
  const panel = node('detail');
  const list = panel?.querySelector('.project-manager-list');
  const empty = panel?.querySelector('.workbench-empty');
  if (identity?.id !== 'projects' || !list) return;
  const request = ++managerRequest;
  try {
    const { projects = [] } = await api('/api/host/projects');
    if (request !== managerRequest || identity !== ui.view) return;
    paintProjects(list, projects);
    if (empty) {
      empty.hidden = projects.length > 0;
      empty.querySelector('strong').textContent = '还没有项目入口';
      empty.querySelector('p').textContent = '输入一个绝对目录登记项目，或先浏览设置和帮助文档。';
    }
    return true;
  } catch {
    if (request !== managerRequest || identity !== ui.view || !empty) return;
    empty.hidden = false;
    empty.querySelector('strong').textContent = '项目列表刷新失败';
    empty.querySelector('p').textContent = '上次读取的列表已保留，请重试刷新。';
    return false;
  }
}

function reserveProjectWindow() {
  try {
    const popup = globalThis.open?.('about:blank', '_blank') ?? globalThis.window?.open?.('about:blank', '_blank') ?? null;
    if (popup) popup.opener = null;
    return popup;
  } catch { return null; }
}

function completeProjectWindow(popup, target) {
  if (popup) { popup.location.href = target; return true; }
  return false;
}

async function selectProject(input, submit, error) {
  const project = input?.value || '';
  // 必须在用户 submit 的同步调用栈中预约窗口；等待 select 后再 open 会被浏览器拦截。
  const popup = reserveProjectWindow();
  if (submit) submit.disabled = true;
  setError('', error);
  try {
    const result = await api('/api/host/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });
    if (!result?.id) throw new Error('启动器没有返回项目身份，请刷新后重试');
    const target = projectHref(result.id);
    if (!completeProjectWindow(popup, target)) {
      const fallback = node('project-open-fallback');
      if (fallback) { fallback.href = target; fallback.hidden = false; fallback.focus?.(); }
      else setError('浏览器阻止了新窗口；请允许弹出窗口后重试。', error);
    }
    void refreshProjectList();
  } catch (cause) {
    popup?.close?.(); setError(cause.message, error);
  } finally { if (submit) submit.disabled = false; }
}

function managerForm() {
  const form = el('form', undefined, 'project-manager-form');
  const input = el('input'); input.id = 'project-manager-path'; input.name = 'project'; input.required = true;
  input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = '/absolute/path/to/project';
  const submit = el('button', '在新窗口打开', 'primary'); submit.type = 'submit';
  const error = el('p', undefined, 'error'); error.hidden = true; error.setAttribute('role', 'alert');
  const fallback = el('a', '浏览器阻止了弹出窗口；点此打开项目', 'project-popup-fallback');
  fallback.id = 'project-open-fallback'; fallback.target = '_blank'; fallback.rel = 'noopener'; fallback.hidden = true;
  form.onsubmit = event => { event.preventDefault(); void selectProject(input, submit, error); };
  form.append(el('label', '项目目录'), el('div', undefined, 'project-path-row'));
  form.children[1].append(input, submit);
  form.append(el('p', '登记和打开是显式操作。列表刷新不会启动项目；每个项目始终在独立窗口或标签页打开。', 'hint'), error, fallback);
  return form;
}

export async function openProjectManager({ push = true } = {}) {
  const identity = activateDetailView({ view: 'projects', title: '后台总览', context: '工作台', hint: '已登记项目后台、消息与独立 Worker', push, hash: '#projects' });
  const panel = node('detail');
  const view = el('div', undefined, 'workbench-view project-manager');
  const head = el('header', undefined, 'workbench-hero');
  head.append(el('span', 'PROJECT BACKENDS', 'eyebrow'), el('h1', '后台总览'),
    el('p', '总览此 Host 已登记的项目后台，或向在线后台发送新指令。消息请从全局收件箱进入来源项目处理。读取不会启动后台；关闭项目标签不会停止开发。', 'hint'));
  const summary = el('p', '正在读取后台状态…', 'hint project-roster-summary'); summary.setAttribute('role', 'status'); head.append(summary);
  const list = el('ul', undefined, 'project-list project-manager-list'); list.id = 'project-list';
  const empty = el('div', undefined, 'workbench-empty'); empty.append(el('strong', '还没有项目入口'), el('p', '输入一个绝对目录登记项目，或先浏览设置和帮助文档。'));
  const refresh = el('button', '刷新项目状态', 'ghost'); refresh.type = 'button';
  refresh.onclick = () => refreshProjectList();
  const tools = el('div', undefined, 'workbench-backend-tools');
  tools.append(refresh); head.append(tools);
  view.append(head);
  if (launcher && hostStatus?.mode !== 'offline') view.append(managerForm());
  view.append(empty, list); panel?.replaceChildren(view);
  const owner = document;
  const ownsPage = () => owner === globalThis.document && identity === ui.view && node('detail')?.querySelector('.project-manager-list') === list;
  // Load only when the overview opens; project pages and device settings do not mount controls.
  const controlsReady = import('./service-restart.js').then(({ serviceRestartControls }) => {
    if (!ownsPage()) return;
    list.restartControls = serviceRestartControls({ ownsPage, changed: async () => {
      if (await refreshProjectList() === false) throw new Error('请显式刷新项目状态');
    } });
    view.append(list.restartControls.root);
    if (list.projects) paintProjects(list, list.projects);
    return list.restartControls.ready;
  }).catch(error => { if (ownsPage()) view.append(el('p', `重启控制加载失败：${error.message}`, 'error')); });
  const request = ++managerRequest;
  try {
    const { projects = [] } = await api('/api/host/projects');
    await controlsReady;
    if (request !== managerRequest || !ownsPage()) return;
    empty.hidden = projects.length > 0;
    paintProjects(list, projects);
  } catch (error) {
    if (request === managerRequest && ownsPage()) { empty.hidden = false; empty.querySelector('strong').textContent = '项目列表暂时不可用'; empty.querySelector('p').textContent = error.message; }
  }
}

/** 旧浮层入口改为主内容项目管理；不再 inert 整个应用。 */
export function openProjectPicker() { return openProjectManager(); }
export function closeProjectPicker() { const gate = node('project-gate'); if (gate) gate.hidden = true; node('project-app')?.removeAttribute?.('inert'); }

/**
 * 启动工作台 shell。返回 true 只表示 shell 可继续装配，不代表存在项目；调用方通过
 * workbenchStatus().projectUsable 决定是否启动项目轮询/输入写操作。
 */
export async function ensureProject() {
  hostStatus = null; launcher = false; projectUsable = false;
  closeProjectPicker();
  try {
    hostStatus = await api('/api/host');
    launcher = hostStatus.mode === 'host';
  } catch (error) {
    if (/404|no route|not found/i.test(error.message)) {
      hostStatus = { mode: 'bound' }; launcher = false; projectUsable = Boolean(projectRoute()); return true;
    }
    hostStatus = { mode: 'offline', error: error.message }; launcher = true; projectUsable = false; return true;
  }
  const current = projectRoute();
  projectUsable = Boolean(current && (hostStatus.projects || []).some(row => row.id === current));
  const switcher = node('project-switch');
  if (switcher) {
    switcher.hidden = true;
  }
  return true;
}
