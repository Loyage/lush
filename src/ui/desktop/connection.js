import { initHelp } from '../web/assets/help.js';

const bridge = window.lushConnections;
const status = document.getElementById('connection-status');
const error = document.getElementById('connection-error');
let busy = false, busyKind = null, actionRevision = 0, refreshRevision = 0;
let sshInspection = null, selectedSSH = null;
const localButton = document.getElementById('open-local');
const localSupported = bridge.localSupported === true;
const sshSupported = typeof bridge.sshInspect === 'function';
const sshAlias = document.getElementById('ssh-alias');
const sshPlan = document.getElementById('ssh-plan');
const sshConfirm = document.getElementById('ssh-confirm');
const sshCancel = document.getElementById('ssh-cancel');
const viewTitles = { projects: '项目', environments: '环境', settings: '设置', help: '帮助' };
function openView(name) {
  if (!Object.hasOwn(viewTitles, name)) return;
  for (const view of document.querySelectorAll('[data-workbench-view]')) view.hidden = view.dataset.workbenchView !== name;
  for (const item of document.querySelectorAll('[data-workbench-nav]')) {
    const active = item.dataset.workbenchNav === name;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  }
  const title = document.getElementById('view-title');
  if (title) title.textContent = viewTitles[name];
}
for (const item of document.querySelectorAll('[data-workbench-nav]')) item.addEventListener('click', () => openView(item.dataset.workbenchNav));
for (const item of document.querySelectorAll('[data-open-view]')) item.addEventListener('click', () => openView(item.dataset.openView));
if (!localSupported) {
  const reason = 'Windows 客户端不启动本地 Bun、Host 或 daemon；请在「环境」中连接 Linux / macOS Host。';
  document.getElementById('local-help').textContent = reason;
  document.getElementById('local-help-host').dataset.help = reason;
  document.getElementById('connection-intro').textContent = '这是可用的本机管理工作台。你可以管理环境并打开远程项目；关闭窗口不会停止远端 Worker 或服务。';
}

function paintBusy() {
  for (const button of document.querySelectorAll('button')) button.disabled = busy;
  localButton.disabled = busy || !localSupported;
  document.getElementById('ssh-inspect').disabled = busy || !sshSupported;
  sshConfirm.disabled = busy || !sshInspection?.confirmation || !(sshInspection.ready || sshInspection.requiresInstall);
  // Cancellation must remain available while the other buttons are single-flight.
  sshCancel.disabled = !sshSupported || busyKind === 'ssh-cancel' || (busy && !busyKind?.startsWith('ssh-'))
    || (!sshInspection && !busyKind?.startsWith('ssh-'));
}
function clearSSHPlan() {
  sshInspection = null; sshPlan.hidden = true;
  document.getElementById('ssh-target').textContent = '';
  document.getElementById('ssh-plan-details').textContent = '';
  document.getElementById('ssh-warnings').replaceChildren();
}
async function run(action, message, success = '已打开独立工作窗口。', kind = 'normal') {
  if (busy) return;
  const revision = ++actionRevision;
  const current = () => revision === actionRevision;
  busy = true; busyKind = kind; error.textContent = ''; status.textContent = message; paintBusy();
  try {
    if (kind === 'normal' && sshInspection) {
      clearSSHPlan();
      await bridge.sshCancel();
      if (!current()) return;
    }
    await action(current);
    if (!current()) return;
    status.textContent = typeof success === 'function' ? success() : success;
    await refresh();
  } catch (failure) {
    if (current()) { error.textContent = failure.message; status.textContent = ''; }
  } finally {
    if (current()) { busy = false; busyKind = null; paintBusy(); }
  }
}
function renderSSHPlan(inspection) {
  sshInspection = inspection;
  document.getElementById('ssh-target').textContent = `目标：${inspection.profile.alias}（连接 ${inspection.profile.id}）`;
  const plan = inspection.plan ?? {};
  document.getElementById('ssh-plan-details').textContent = [
    `远端平台：${plan.target ?? '未提供'}`,
    `安装目录：${plan.installDirectory ?? '未提供'}`,
    `Lush 版本：${plan.version ?? '未提供'}`,
    `源码指纹：${plan.fingerprint ?? '未提供'}`,
    plan.download ? `运行包来源：${plan.download.releaseURL}（确认后下载目标架构，最大 ${Math.ceil(plan.download.maximumBytes / 1024 / 1024)} MiB；完成校验前不安装）` : '运行包来源：已验证的本机产物或下载缓存',
    `使用运行时：${plan.useExistingBun ? '远端已有 Bun' : '用户私有 Bun'} ${plan.bunVersion ?? ''}`,
    `私有 Bun：${plan.privateBunVersion ?? '未提供'}（随包保留为备用，不修改系统 PATH）`,
    `本地入口：${plan.origin ?? '未提供'}`,
    `将执行：${Array.isArray(plan.operations) ? plan.operations.join(' → ') : '请查看完整计划'}`,
    '', '完整技术计划：', JSON.stringify(plan, null, 2),
  ].join('\n');
  const warnings = document.getElementById('ssh-warnings'); warnings.replaceChildren();
  for (const warning of Array.isArray(inspection.warnings) ? inspection.warnings : []) {
    const row = document.createElement('li');
    row.textContent = typeof warning === 'string' ? warning : JSON.stringify(warning);
    warnings.append(row);
  }
  sshConfirm.textContent = inspection.requiresInstall ? '确认安装并连接' : '确认连接';
  sshPlan.hidden = false; paintBusy();
}
const sshConnectedMessage = '已打开独立 SSH 工作窗口；连接成功不代表 Agent 已认证。';
function inspectSSH(profile, connectIfReady = false) {
  if (!sshSupported || busy) return;
  clearSSHPlan();
  let connected = false;
  void run(async current => {
    const inspection = await bridge.sshInspect(profile);
    if (!current()) return;
    if (inspection.profile?.alias !== sshAlias.value.trim()) throw new Error('服务器已更改，请重新预检');
    selectedSSH = inspection.profile;
    if (connectIfReady && inspection.ready && !inspection.requiresInstall && inspection.confirmation) {
      busyKind = 'ssh-connect'; status.textContent = '预检已完成，正在连接已安装的远端入口…'; paintBusy();
      await bridge.sshConnect({ confirmation: inspection.confirmation, install: false });
      if (current()) connected = true;
    } else renderSSHPlan(inspection);
  }, '正在通过 SSH 预检服务器…', () => connected ? sshConnectedMessage : sshInspection?.confirmation
    ? '预检已完成，请核对服务器与计划后确认。' : '预检尚未就绪，请根据警告修复环境后重试。', 'ssh-inspect');
}
async function cancelSSH(message = '已取消本次操作；远端服务与 Worker 不会被停止。') {
  if (!sshSupported || busyKind === 'ssh-cancel') return;
  const revision = ++actionRevision;
  clearSSHPlan(); busy = true; busyKind = 'ssh-cancel';
  error.textContent = ''; status.textContent = '正在取消本次 SSH 操作…'; paintBusy();
  try {
    await bridge.sshCancel();
    if (revision === actionRevision) status.textContent = message;
  } catch (failure) {
    if (revision === actionRevision) { error.textContent = failure.message; status.textContent = ''; }
  } finally {
    if (revision === actionRevision) { busy = false; busyKind = null; paintBusy(); }
  }
}
function helpedButton(label, help, action) {
  const host = document.createElement('span'); host.className = 'help-host'; host.dataset.help = help;
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
  button.addEventListener('click', action); host.append(button);
  return host;
}
async function refresh() {
  const revision = ++refreshRevision;
  const [recentResult, recordsResult, configResult] = await Promise.allSettled([
    bridge.list(), sshSupported ? bridge.sshList() : [],
    typeof bridge.sshConfig === 'function' ? bridge.sshConfig() : { hosts: [], warnings: [] },
  ]);
  if (revision !== refreshRevision) return;
  const recent = recentResult.status === 'fulfilled' ? recentResult.value : [];
  const sshRecords = recordsResult.status === 'fulfilled' ? recordsResult.value : [];
  const configList = document.getElementById('ssh-config-hosts'); configList.replaceChildren();
  const configStatus = document.getElementById('ssh-config-status');
  if (configResult.status === 'rejected') {
    configStatus.textContent = `无法读取本机 SSH 配置：${configResult.reason.message}。仍可手动输入服务器。`;
  } else {
    const config = configResult.value;
    configStatus.textContent = [config.hosts.length ? `找到 ${config.hosts.length} 个 SSH Host。` : '未找到可选择的 SSH Host；可在下方手动输入。', ...config.warnings].join('\n');
    for (const { alias } of config.hosts) {
      const row = document.createElement('li');
      const open = helpedButton(alias, '自动预检此 SSH Host；已安装则直接启动远端入口并连接，首次安装需确认计划；不调用模型', () => {
        if (busy) return;
        sshAlias.value = alias; selectedSSH = null;
        inspectSSH({ alias }, true);
      });
      row.append(open); configList.append(row);
    }
  }
  const list = document.getElementById('recent-connections');
  list.replaceChildren();
  if (!recent.length) { const row = document.createElement('li'); row.textContent = recentResult.status === 'rejected' ? '无法读取远程连接记录；仍可手动输入地址。' : '暂无远程连接记录'; list.append(row); }
  for (const url of recent) {
    const row = document.createElement('li');
    const open = document.createElement('button'); open.type = 'button'; open.textContent = url;
    open.addEventListener('click', () => { document.getElementById('host-url').value = url; void run(() => bridge.openRemote(url), '正在连接远程 Host…'); });
    const host = helpedButton('仅移除记录', '只从最近连接中移除此地址，不退出登录、不关闭窗口，也不停止远端服务', () => {
      void run(() => bridge.remove(url), '正在移除记录…', '已移除连接记录。');
    });
    host.children[0].className = 'secondary';
    row.append(open, host); list.append(row);
  }
  const sshList = document.getElementById('ssh-connections'); sshList.replaceChildren();
  if (!sshRecords.length) { const row = document.createElement('li'); row.textContent = recordsResult.status === 'rejected' ? '无法读取 SSH 连接记录；请检查本机连接记录文件。' : '暂无 SSH 连接记录'; sshList.append(row); }
  for (const record of sshRecords) {
    const row = document.createElement('li');
    const openHost = helpedButton(record.alias, '自动预检此 SSH 记录；已安装则直接连接，首次安装需确认；不停止远端开发，也不调用模型', () => {
      if (busy) return;
      sshAlias.value = record.alias; selectedSSH = { id: record.id, alias: record.alias };
      inspectSSH(selectedSSH, true);
    });
    const state = document.createElement('span'); state.className = 'ssh-state'; state.textContent = record.connected ? '隧道已连接' : '未连接';
    const disconnect = helpedButton('断开隧道', '仅停止此连接的本地 SSH 隧道；工作窗口会离线，但不停止远端 Host、daemon 或 Worker，也不删除记录', () => {
      if (busy) return;
      clearSSHPlan();
      void run(async () => { await bridge.sshCancel(); await bridge.sshDisconnect(record.id); }, '正在断开本地 SSH 隧道…', '已断开隧道；远端开发继续运行。');
    });
    disconnect.children[0].className = 'secondary';
    row.append(openHost, state, disconnect); sshList.append(row);
  }
  paintBusy();
}

localButton.addEventListener('click', () => { if (localSupported) void run(() => bridge.openLocal(), '正在启动本地 Host…'); });
document.getElementById('remote-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(() => bridge.openRemote(document.getElementById('host-url').value), '正在连接远程 Host…');
});
document.getElementById('ssh-form').addEventListener('submit', event => {
  event.preventDefault();
  const alias = sshAlias.value.trim();
  inspectSSH(selectedSSH?.alias === alias ? selectedSSH : { alias });
});
sshAlias.addEventListener('input', () => {
  selectedSSH = null;
  const needsCancel = sshInspection !== null || busyKind?.startsWith('ssh-');
  if (needsCancel) void cancelSSH('服务器已更改，请重新预检；旧计划已取消。');
  else { clearSSHPlan(); paintBusy(); }
});
sshConfirm.addEventListener('click', () => {
  if (busy || !sshInspection?.confirmation || !(sshInspection.ready || sshInspection.requiresInstall)) return;
  const confirmation = { confirmation: sshInspection.confirmation, install: sshInspection.requiresInstall };
  clearSSHPlan();
  void run(() => bridge.sshConnect(confirmation), confirmation.install ? '正在获取并校验确认的运行包，随后安装并建立 SSH 隧道…' : '正在启动远端入口并建立 SSH 隧道…', sshConnectedMessage, 'ssh-connect');
});
sshCancel.addEventListener('click', () => { if (!sshCancel.disabled) void cancelSSH(); });
paintBusy();
initHelp();
if (typeof bridge.startupState === 'function') void bridge.startupState().then(state => {
  if (state?.failure) error.textContent = `${state.failure}。管理工作台仍可使用。`;
}).catch(() => {});
void refresh().catch(failure => { error.textContent = `无法读取连接记录：${failure.message}`; });
window.addEventListener('focus', () => { if (!busy) void refresh().catch(failure => { error.textContent = failure.message; }); });
window.addEventListener('pagehide', () => { if (sshSupported) void bridge.sshCancel().catch(() => {}); });
