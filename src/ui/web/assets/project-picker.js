import { api } from './api.js';
import { projectHref, projectRoute } from './route.js';

function node(id) { return globalThis.document?.getElementById?.(id) ?? null; }
let launcher = false;

function setError(message = '') {
  const target = node('project-error');
  if (target) { target.textContent = message; target.hidden = !message; }
}

/* ---------- 项目列表（宿主级界面元数据 + 已连接项目的有界摘要） ---------- */

function summaryText(row) {
  if (row.error) return row.error;
  if (!row.connected) return '未打开';
  const summary = row.summary;
  if (!summary) return '已连接';
  const parts = [];
  if (summary.notices > 0) parts.push(`待决 ${summary.notices}`);
  if (summary.waiting_approval > 0) parts.push(`待批计划 ${summary.waiting_approval}`);
  if (summary.agents_total > 0) parts.push(`执行中 ${summary.agents_total}`);
  return parts.length ? parts.join(' · ') : '空闲';
}

/**
 * 每个项目一个链接：href 就是该项目的稳定身份路由，浏览器前进 / 后退与深链接都直接可用。
 * 已经打开着别的项目时用新标签打开，当前标签的输入与导航不因「看看另一个项目」被清空。
 */
function projectItems(rows) {
  const document = globalThis.document;
  if (!document) return [];
  const current = projectRoute();
  const newTab = Boolean(current);
  return rows.map(row => {
    const item = document.createElement('li');
    item.className = 'project-item';
    if (row.id === current) item.dataset.current = 'true';
    const link = document.createElement('a');
    link.className = 'project-open';
    link.href = projectHref(row.id);
    if (newTab) { link.target = '_blank'; link.rel = 'noopener'; }
    const name = document.createElement('strong'); name.textContent = row.name;
    const path = document.createElement('small'); path.textContent = row.project;
    link.append(name, path);
    const status = document.createElement('span');
    status.className = row.error ? 'project-status error' : 'project-status';
    status.textContent = summaryText(row);
    item.append(link, status);
    if (launcher) {
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'ghost project-remove';
      remove.textContent = '移除';
      remove.setAttribute('data-help', '只从项目列表移除入口并断开这个 Web 连接，不会停止项目的 daemon；停止请用项目命令');
      remove.onclick = () => void removeProject(row, item);
      item.append(remove);
    }
    return item;
  });
}

function paint(containerId, rows) {
  const list = node(containerId);
  if (list) list.replaceChildren(...projectItems(rows));
}

async function removeProject(row, item) {
  item.querySelector?.('.project-remove')?.setAttribute('disabled', '');
  try {
    await api('/api/launcher/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: row.id }) });
    item.remove?.();
    if (row.id === projectRoute() && typeof globalThis.location?.assign === 'function') globalThis.location.assign('/');
  } catch (error) { setError(error.message); item.querySelector?.('.project-remove')?.removeAttribute('disabled'); }
}

/** 读取项目列表与已经连接项目的有界摘要（`system.summary`：状态 + 待决数），不启动没打开过的 daemon。 */
export async function refreshProjectList() {
  const panel = node('project-list-panel');
  const gate = node('project-gate');
  const visible = (panel && !panel.hidden) || (gate && !gate.hidden);
  if (!visible) return;
  try {
    const { projects } = await api('/api/launcher/projects');
    paint('project-list', projects);
    paint('project-recent-list', projects);
    const recent = node('project-recent');
    if (recent) recent.hidden = projects.length === 0;
  } catch { /* 列表读取失败不影响项目页面本身 */ }
}

/* ---------- 选择 / 切换 ---------- */

export function openProjectPicker(status = {}) {
  const gate = node('project-gate');
  if (!gate) return;
  const input = node('project-path');
  const project = status.project || status.last_project || status.allowed_projects?.[0] || '';
  if (input) input.value = project;
  const list = node('project-options');
  if (list) list.replaceChildren(...(status.allowed_projects || []).map(value => {
    const option = list.ownerDocument.createElement('option'); option.value = value; return option;
  }));
  const hint = node('project-hint');
  if (hint) hint.textContent = status.allowed_projects
    ? '公网启动器只能打开全局 web.json 白名单中的项目。'
    : '首次打开必须指定绝对路径。之后会自动恢复最后使用的项目，也可以随时切换。';
  setError(status.error || '');
  const cancel = node('project-cancel');
  if (cancel) { cancel.hidden = !projectRoute() && !status.project; cancel.onclick = () => closeProjectPicker(); }
  gate.hidden = false;
  gate.setAttribute('aria-hidden', 'false');
  node('project-app')?.setAttribute?.('inert', '');
  paint('project-recent-list', status.projects || []);
  const recent = node('project-recent');
  if (recent) recent.hidden = !(status.projects || []).length;
  input?.focus?.();
  void refreshProjectList();
}

export function closeProjectPicker() {
  const gate = node('project-gate');
  if (gate) { gate.hidden = true; gate.setAttribute('aria-hidden', 'true'); }
  node('project-app')?.removeAttribute?.('inert');
}

async function selectProject() {
  const input = node('project-path');
  const submit = node('project-submit');
  if (submit) submit.disabled = true;
  setError();
  try {
    const result = await api('/api/launcher/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: input?.value || '' }) });
    if (!result?.id) throw new Error('启动器没有返回项目身份，请刷新页面后重试');
    closeProjectPicker();
    const target = projectHref(result.id);
    // 在别的项目页面里切换：新标签打开，当前标签的输入与页面保持不变。
    if (projectRoute() && typeof globalThis.open === 'function') globalThis.open(target, '_blank', 'noopener');
    else globalThis.location?.assign?.(target);
  } catch (error) {
    setError(error.message);
    if (submit) submit.disabled = false;
  }
}

async function openSwitcher() {
  try { openProjectPicker(await api('/api/launcher')); }
  catch (error) { setError(error.message); }
}

function bindPicker(status) {
  const form = node('project-form');
  if (form && !form.dataset.bound) {
    form.dataset.bound = 'true';
    form.addEventListener('submit', event => { event.preventDefault(); void selectProject(); });
  }
  const choose = node('project-choose');
  const desktop = globalThis.lushDesktop;
  if (choose) {
    choose.hidden = !desktop?.chooseProject;
    choose.onclick = async () => {
      const selected = await desktop.chooseProject();
      if (selected && node('project-path')) node('project-path').value = selected;
    };
  }
  const panel = node('project-list-panel');
  if (panel) panel.hidden = !launcher;
  const refresh = node('project-list-refresh');
  if (refresh) refresh.onclick = () => void refreshProjectList();
  const switcher = node('project-switch');
  if (switcher) {
    switcher.hidden = !launcher;
    switcher.onclick = () => void openSwitcher();
  }
  void status;
}

/** 返回 false 表示首启尚未落到具体项目，调用方不得启动项目轮询。 */
export async function ensureProject() {
  let status;
  try { status = await api('/api/launcher'); }
  catch (error) {
    // 兼容尚未提供启动器端点的旧 Web；真正的连接错误仍会在随后的 snapshot 中显示。
    if (/404|no route|not found/i.test(error.message)) return true;
    throw error;
  }
  launcher = status.mode === 'launcher';
  bindPicker(status);
  if (!launcher) { closeProjectPicker(); return true; }

  const current = projectRoute();
  if (current) {
    // 已在一个项目页面：项目身份来自地址，不需要也不允许服务端再决定「当前项目」。
    if (!(status.projects || []).some(row => row.id === current)) {
      openProjectPicker({ ...status, error: '这个项目已从列表移除；请重新打开，或换一个项目。' });
      return false;
    }
    closeProjectPicker();
    void refreshProjectList();
    return true;
  }

  // 根路径：恢复上次项目只决定新窗口首次落点，不覆盖已经打开的页面。
  const restored = status.last_project_id && (status.projects || []).some(row => row.id === status.last_project_id);
  if (restored && typeof globalThis.location?.replace === 'function') {
    globalThis.location.replace(projectHref(status.last_project_id) + (globalThis.location.hash || ''));
    return false;
  }
  openProjectPicker(status);
  return false;
}
