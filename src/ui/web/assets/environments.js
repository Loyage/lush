import { api } from './api.js';
import { confirmDialog } from './dialog.js';
import { el } from './dom.js';
import { environmentHref } from './route.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';

let requestId = 0;
let currentModel = null;
let pendingInspect = null;

function isLoopback(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
}

/** 只接受独立 Host 根地址：无凭证、路径、query/hash；明文 HTTP 仅限回环。 */
export function normalizeDirectHost(value) {
  const entered = String(value || '').trim();
  if (!entered) throw new Error('请输入 Host 地址');
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(entered) ? entered : `https://${entered}`); }
  catch { throw new Error('Host 地址无效'); }
  if (url.username || url.password) throw new Error('Host 地址不能包含用户名或密码');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('请输入 Host 根地址，不要包含路径、查询或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('远程 Host 必须使用 HTTPS；HTTP 仅允许 localhost / 回环地址');
  }
  return `${url.origin}/`;
}

function executionText(model) {
  const execution = model?.execution || {};
  return `${execution.username || '未知用户'}@${execution.hostname || '未知主机'}`;
}

function planText(plan) {
  if (!plan || typeof plan !== 'object') return '服务端未提供安装计划。';
  return Object.entries(plan).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join('\n');
}

async function connectInspected(result, status) {
  let install = false;
  if (result.requiresInstall) {
    const confirmed = await confirmDialog({
      title: '确认在 SSH 目标安装？',
      message: `SSH 由此 Web 服务的 ${executionText(currentModel)} 执行。`,
      detail: `${planText(result.plan)}\n\n不会复制模型凭证；安装与项目后台相互独立。`,
      confirmLabel: '确认计划并连接', danger: false,
    });
    if (!confirmed) { await cancelSSH(); status.textContent = '已取消并作废本次计划。'; return; }
    install = true;
  }
  status.textContent = result.ready && !install ? '目标已就绪，正在连接…' : '正在按已确认计划连接…';
  const connected = await api('/api/environments/ssh/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmation: result.confirmation, install }),
  });
  pendingInspect = null;
  const link = el('a', '在新窗口打开 SSH 环境', 'primary environment-open');
  link.href = connected.href || environmentHref(connected.id); link.target = '_blank'; link.rel = 'noopener';
  status.replaceChildren(link);
}

async function inspectSSH(alias, status) {
  status.textContent = `正在从 ${executionText(currentModel)} 检查 SSH 目标…`;
  try {
    const result = await api('/api/environments/ssh/inspect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias }),
    });
    pendingInspect = result;
    if (!result.ready && !result.requiresInstall) {
      status.textContent = (result.warnings || []).join('；') || '预检未能确认目标已就绪，也没有可安装计划。';
      status.classList.add('error'); return;
    }
    status.textContent = result.requiresInstall ? '预检完成，等待确认安装计划。' : '预检完成，目标已就绪。';
    await connectInspected(result, status); // 点击“检查并连接”已表达连接意图；ready 可直接连接。
  } catch (error) { status.textContent = error.message; status.classList.add('error'); }
}

async function cancelSSH() {
  pendingInspect = null;
  try { await api('/api/environments/ssh/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
  catch { /* 计划可能已过期；本地仍放弃它 */ }
}

async function disconnectSSH(connection, status) {
  const confirmed = await confirmDialog({ title: '断开 SSH 环境？', message: '只停止此 Host 自己建立的隧道，不停止远端 Lush Host、项目 daemon 或 Worker。',
    detail: connection.alias || connection.id, confirmLabel: '断开连接', danger: true });
  if (!confirmed) return;
  try {
    await api('/api/environments/ssh/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: connection.id }) });
    await loadEnvironments(false);
  } catch (error) { status.textContent = error.message; status.classList.add('error'); }
}

function directCard() {
  const section = el('section', undefined, 'workbench-card environment-direct');
  section.append(el('h2', 'HTTPS Host'), el('p', '直接打开你信任的 Lush Host。地址不会经当前 Host 代理，也不会携带当前页面的凭证。', 'hint'));
  const form = el('form', undefined, 'environment-form');
  const input = el('input'); input.type = 'text'; input.placeholder = 'https://lush.example.com'; input.autocomplete = 'url'; input.spellcheck = false;
  const open = el('button', '准备打开', 'primary'); open.type = 'submit';
  const error = el('p', undefined, 'error'); error.hidden = true;
  const link = el('a', '在新窗口打开 Host', 'primary environment-open'); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.hidden = true;
  form.onsubmit = event => {
    event.preventDefault(); error.hidden = true;
    try { link.href = normalizeDirectHost(input.value); link.hidden = false; link.focus?.(); }
    catch (cause) { link.hidden = true; error.textContent = cause.message; error.hidden = false; }
  };
  form.append(el('label', 'Host 地址'), input, open, link, error); section.append(form);
  return section;
}

function connectionCard(connection) {
  const card = el('li', undefined, 'environment-connection');
  const copy = el('span'); copy.append(el('strong', connection.alias || connection.id), el('small', connection.connected ? 'SSH 隧道已连接' : '已断开'));
  const status = el('span', undefined, 'environment-status'); card.append(copy);
  if (connection.connected) {
    const link = el('a', '打开环境', 'ghost'); link.href = environmentHref(connection.id); link.target = '_blank'; link.rel = 'noopener';
    const disconnect = el('button', '断开隧道', 'ghost'); disconnect.type = 'button';
    disconnect.setAttribute('data-help', '只断开此 Host 创建的 SSH 隧道；远端项目与 Worker 继续运行');
    disconnect.onclick = () => void disconnectSSH(connection, status); card.append(link, disconnect);
  }
  card.append(status); return card;
}

function sshCard(model) {
  const section = el('section', undefined, 'workbench-card environment-ssh');
  section.append(el('h2', 'SSH 环境'), el('p', `SSH 命令由 Web 服务所在的 ${executionText(model)} 执行，不是由访问此页面的电脑执行。`, 'environment-execution'));
  if (!model.ssh?.supported) {
    section.append(el('p', model.ssh?.reason || '当前 Host 未开放 SSH 环境管理。', 'workbench-empty')); return section;
  }
  for (const warning of model.ssh.warnings || []) section.append(el('p', warning, 'warning'));
  const form = el('form', undefined, 'environment-form');
  const alias = el('input'); alias.placeholder = 'SSH config Host 别名'; alias.required = true; alias.autocomplete = 'off';
  const options = el('datalist'); options.id = 'ssh-host-options';
  for (const host of model.ssh.hosts || []) { const option = el('option'); option.value = host.alias; options.append(option); }
  alias.setAttribute('list', 'ssh-host-options');
  const submit = el('button', '检查并连接', 'primary'); submit.type = 'submit';
  const cancel = el('button', '取消计划', 'ghost'); cancel.type = 'button';
  cancel.setAttribute('data-help', '作废当前会话的 SSH 预检授权并取消在途操作；不会停止已经连接的环境');
  const status = el('p', undefined, 'environment-status'); status.setAttribute('role', 'status');
  form.onsubmit = event => { event.preventDefault(); void inspectSSH(alias.value, status); };
  cancel.onclick = async () => { await cancelSSH(); status.textContent = '已取消当前 SSH 计划。'; };
  form.append(el('label', 'SSH Host'), alias, options, submit, cancel, status); section.append(form);
  const connections = el('ul', undefined, 'environment-connections');
  connections.append(...(model.ssh.connections || []).map(connectionCard));
  if (model.ssh.connections?.length) section.append(el('h3', '已保存连接'), connections);
  return section;
}

function desktopManager() {
  const bridge = globalThis.window?.lushDesktop ?? globalThis.lushDesktop;
  if (typeof bridge?.openConnections !== 'function') return null;
  const section = el('section', undefined, 'workbench-card environment-desktop');
  section.append(el('h2', '桌面连接管理'), el('p', '由受信任的桌面工作区管理本机连接；远端网页不会获得 SSH 或任意命令 IPC。', 'hint'));
  const button = el('button', '打开桌面连接管理器', 'ghost'); button.type = 'button'; button.onclick = () => void bridge.openConnections();
  section.append(button); return section;
}

async function loadEnvironments(push) {
  const identity = activateDetailView({ view: 'environments', title: '环境', context: '工作台', hint: '本地、SSH 与 HTTPS Host 连接', push, hash: '#environments' });
  const panel = globalThis.document?.getElementById?.('detail');
  const view = el('div', undefined, 'workbench-view environments-view');
  const head = el('header', undefined, 'workbench-hero'); head.append(el('span', 'ENVIRONMENTS', 'eyebrow'), el('h1', '开发环境'), el('p', '环境是项目实际所在的机器与用户上下文；断开入口不停止后台开发。', 'hint'));
  const loading = el('div', undefined, 'workbench-empty'); loading.append(el('strong', '正在读取环境能力…'));
  view.append(head, loading, directCard()); panel?.replaceChildren(view);
  const own = ++requestId;
  try {
    const model = await api('/api/environments');
    if (own !== requestId || ui.view !== identity) return;
    currentModel = model;
    const manager = desktopManager();
    view.replaceChildren(head, ...(manager ? [manager] : []), sshCard(model), directCard());
  } catch (error) {
    if (own === requestId && ui.view === identity) {
      loading.replaceChildren(el('strong', '环境服务暂时不可用'), el('p', error.message));
    }
  }
}

export function openEnvironments({ push = true } = {}) { return loadEnvironments(push); }
