import { $, el } from './dom.js';
import { projectRoute } from './route.js';
import { show } from './messages.js';
import { applyDeviceAutomation, deviceAutomationStatus, refreshDeviceAutomation, saveDeviceAutomation, validDeviceAutomation } from './workspace-automation.js';

const states = new WeakMap();
function stateFor(host) {
  let value = states.get(host);
  if (value) return value;
  value = { model: null, offline: false, busy: false }; states.set(host, value);
  const copy = el('div', undefined, 'auto-select-copy');
  value.title = el('strong');
  copy.append(value.title, el('p', '此设备的项目后台会自动答复已有和新到的问题。单选选第一项；多选和文字问题交给 Agent 判断，可能继续调用并产生费用。'));
  const actions = el('div', undefined, 'auto-select-actions');
  const view = el('a', '查看自动问答', 'ghost'); view.href = '/#notices-automatic';
  if (projectRoute()) { view.target = '_blank'; view.rel = 'noopener'; }
  view.setAttribute('data-help', '在全局收件箱只读查看各项目的原问题、答案及自动答复来源，不调用 Agent。');
  value.control = el('button', '关闭全局自动选择', 'ghost'); value.control.type = 'button';
  value.control.setAttribute('data-help', '关闭此设备所有项目之后的自动答复；不撤回已有答案，也不停止已开始的调用。');
  value.control.onclick = () => disable(host, value);
  value.controlHost = el('span', undefined, 'help-host'); value.controlHost.append(value.control);
  actions.append(view, value.controlHost); host.replaceChildren(copy, actions); return value;
}
const owns = (host, value) => globalThis.document?.getElementById?.('auto-select-banner') === host && states.get(host) === value;
function paint(host, value) {
  host.hidden = value.model?.auto_select.enabled !== true;
  if (host.hidden) return;
  value.title.textContent = value.offline ? '全局自动选择最近确认为开启 · Host 当前不可达' : '全局自动选择已开启';
  value.control.textContent = value.busy ? '正在关闭…' : '关闭全局自动选择';
  const reason = value.busy ? '正在保存，请稍候。' : value.offline ? 'Host 当前不可达，无法确认或修改全局策略；项目 daemon 可能仍按最后保存的策略运行。' : null;
  value.control.disabled = Boolean(reason);
  value.controlHost.tabIndex = reason ? 0 : -1;
  if (reason) value.controlHost.setAttribute('data-help', reason); else value.controlHost.removeAttribute('data-help');
  host.setAttribute('aria-busy', String(value.busy));
}

/** One device authorization across both shells. Project snapshots must not repaint this global policy. */
export function renderAutoSelectBanner(model, { offline = false } = {}) {
  const host = $('auto-select-banner'); if (!host) return;
  const value = stateFor(host); value.offline = offline;
  if (validDeviceAutomation(model)) value.model = model;
  const status = deviceAutomationStatus(); value.busy = status.saving;
  paint(host, value);
}
export function applyAutoSelectCatalogue(model) {
  const next = applyDeviceAutomation(model);
  const host = $('auto-select-banner'); if (!host) return;
  const value = stateFor(host);
  value.model = next; value.offline = false; paint(host, value);
}
async function disable(host, value) {
  if (!owns(host, value) || value.busy || value.offline || !value.model?.auto_select.enabled) return;
  const revision = value.model.revision; let confirmed = false;
  value.busy = true; paint(host, value);
  try {
    const result = await saveDeviceAutomation({ auto_select: { enabled: false } }, revision);
    if (!owns(host, value)) return;
    applyAutoSelectCatalogue(result);
    if (result.auto_select.enabled) throw new Error('Host 尚未确认关闭');
    confirmed = true;
    show('全局自动选择已关闭；已有答案保留，已开始的调用不会停止。');
  } catch (error) { if (owns(host, value)) show(`全局关闭未确认：${error.message}；请读取最新策略后重试。`, 'error'); }
  finally {
    value.busy = false; if (owns(host, value)) paint(host, value);
    // ACK and follow-up reads are separate facts: a later failure cannot undo a confirmed close.
    void refreshDeviceAutomation().catch(error => {
      if (owns(host, value)) show(`全局策略刷新失败：${error.message}；${confirmed ? '已经确认关闭，后续读取失败不会撤销该结果。' : '关闭结果仍未确认，请读取最新策略后再操作。'}`, 'error');
    });
  }
}
