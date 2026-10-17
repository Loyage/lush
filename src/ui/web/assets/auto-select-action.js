import { el } from './dom.js';
import { confirmDialog, closeDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { deviceAutomationStatus, reserveDeviceAutomation, refreshDeviceAutomation, saveDeviceAutomation, onDeviceAutomation } from './workspace-automation.js';

export const autoSelectEnableHelp = agentHelp('保存设备级持续授权，已有及之后待答的 Worker 可能继续调用。');
export const autoSelectDisableHelp = '关闭所有项目的未来自动答复，不撤回已有答案或停止已开始调用。';
export function autoSelectReason(status = deviceAutomationStatus()) {
  return status.saving || status.confirming ? '正在确认或保存设备策略，请稍候。' : status.uncertain
    ? '保存结果未确认，先重新读取策略；不会自动重试。' : status.offline || !status.model ? '设备策略未知，请先重新读取策略。' : null;
}
export async function changeAutoSelect(enabled, { ownsPage = () => true, canAct = () => true, confirm = confirmDialog } = {}) {
  const status = deviceAutomationStatus();
  if (!ownsPage() || !canAct() || autoSelectReason(status) || status.model.auto_select.enabled === enabled) return false;
  const lease = reserveDeviceAutomation(); if (!lease) return false;
  const revision = status.model.revision;
  try {
    if (enabled && !await confirm({ title: '开启此设备的全局自动选择？',
      message: '持续授权所有使用此设备配置的项目后台，自动答复已有和新到问题。可能恢复多个 Worker 并产生调用费用。不会启动已停止的项目；项目以后恢复时再按安全边界处理。关闭只撤销未来答复，不撤回已经写入的答案或调用。',
      confirmLabel: '授权并开启', agent: true, confirmHelp: autoSelectEnableHelp })) return false;
    const latest = deviceAutomationStatus();
    // An edit/navigation, or another successful policy observation, invalidates this confirmation.
    if (!ownsPage() || !canAct() || latest.uncertain || latest.offline || latest.model?.revision !== revision) return false;
    await saveDeviceAutomation({ auto_select: { enabled } }, revision, lease);
    return true;
  } finally { lease.release(); }
}

/** Same persistent control and authorization semantics in the card and global page. */
export function createAutoSelectAction({ ownsPage = () => true, canAct = () => true, confirm = null } = {}) {
  const root = el('div', undefined, 'device-auto-select-action');
  const status = el('p', '', 'device-auto-select-status'); status.setAttribute('role', 'status');
  const actions = el('div', undefined, 'device-auto-select-buttons');
  const control = el('button', '', 'ghost'); control.type = 'button'; control.dataset.quickAction = 'auto_select';
  const host = el('span', undefined, 'help-host'); host.append(control);
  const reread = el('button', '重新读取策略', 'ghost'); reread.type = 'button'; reread.classList.add('device-auto-select-reread');
  actions.append(host, reread); root.append(status, actions);
  let disposed = false, dialog = null;
  const active = () => !disposed && ownsPage();
  const ask = confirm || (async settings => {
    const result = confirmDialog(settings), identity = document.getElementById('modal')?.firstElementChild; dialog = identity;
    try { return await result; } finally { if (dialog === identity) dialog = null; }
  });
  function sync() {
    if (disposed) return;
    const value = deviceAutomationStatus(), unknown = value.uncertain || value.offline || !value.model;
    const enabled = value.model?.auto_select.enabled === true;
    status.textContent = `自动选择${unknown ? '状态未知' : enabled ? '已确认开启' : '已确认关闭'}${value.error ? `：${value.error}` : ''}`;
    status.classList.toggle('error', unknown);
    control.textContent = unknown ? '自动选择状态未知' : enabled ? '关闭全局自动选择' : '开启全局自动选择';
    control.classList.toggle('agent-call', !enabled && !unknown);
    const help = enabled ? autoSelectDisableHelp : autoSelectEnableHelp;
    control.dataset.help = help;
    const reason = !canAct() ? '请先保存或取消编辑，再修改自动选择策略。' : autoSelectReason(value);
    control.disabled = !!reason; host.tabIndex = reason ? 0 : -1;
    if (reason) host.dataset.help = reason; else delete host.dataset.help;
    reread.hidden = !unknown; reread.disabled = value.saving || value.confirming || value.reading;
  }
  control.onclick = async () => {
    if (!active()) return;
    try { await changeAutoSelect(!deviceAutomationStatus().model?.auto_select.enabled, { ownsPage: active, canAct, confirm: ask }); }
    catch { /* Shared status preserves unknown/error and requires an explicit reread. */ }
    if (active()) sync();
  };
  reread.onclick = async () => { if (!active()) return; try { await refreshDeviceAutomation(); } catch {} if (active()) sync(); };
  const unsubscribe = onDeviceAutomation(() => { if (active()) sync(); });
  sync();
  const ready = refreshDeviceAutomation({ reconcile: false }).catch(() => {}).finally(() => { if (active()) sync(); });
  function dispose() {
    if (disposed) return; disposed = true; unsubscribe();
    globalThis.removeEventListener?.('pagehide', dispose);
    if (dialog && document.getElementById('modal')?.firstElementChild === dialog) closeDialog(); dialog = null;
  }
  globalThis.addEventListener?.('pagehide', dispose);
  return { root, control, status, sync, ready, dispose };
}
