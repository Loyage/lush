import { $, el } from './dom.js';
import { projectRoute } from './route.js';
import { show } from './messages.js';
import { applyDeviceAutomation, deviceAutomationStatus, refreshDeviceAutomation, validDeviceAutomation } from './workspace-automation.js';
import { changeAutoSelect, autoSelectReason } from './auto-select-action.js';

const states = new WeakMap();
function stateFor(host) {
  let value = states.get(host);
  if (value) return value;
  value = { model: null, offline: false, busy: false }; states.set(host, value);
  const copy = el('div', undefined, 'auto-select-copy');
  value.title = el('strong');
  value.description = el('p'); copy.append(value.title, value.description);
  const actions = el('div', undefined, 'auto-select-actions');
  const view = el('a', '查看自动问答', 'nav-link'); view.href = '/#notices-automatic';
  if (projectRoute()) { view.target = '_blank'; view.rel = 'noopener'; }
  view.setAttribute('data-help', '在全局收件箱只读查看各项目的原问题、答案及自动答复来源，不调用 Agent。');
  value.control = el('button', '关闭全局自动选择', 'ghost'); value.control.type = 'button';
  value.control.setAttribute('data-help', '关闭此设备所有项目之后的自动答复；不撤回已有答案，也不停止已开始的调用。');
  value.control.onclick = () => disable(host, value);
  value.controlHost = el('span', undefined, 'help-host'); value.controlHost.append(value.control);
  value.reread = el('button', '重新读取策略', 'ghost'); value.reread.type = 'button';
  value.reread.onclick = async () => { try { await refreshDeviceAutomation(); } catch (error) { if (owns(host, value)) show(error.message, 'error'); } };
  actions.append(view, value.controlHost, value.reread); host.replaceChildren(copy, actions); return value;
}
const owns = (host, value) => globalThis.document?.getElementById?.('auto-select-banner') === host && states.get(host) === value;
function paint(host, value) {
  const shared = deviceAutomationStatus();
  host.hidden = value.model?.auto_select.enabled !== true && !shared.uncertain;
  if (host.hidden) return;
  value.title.textContent = shared.uncertain ? '全局自动选择状态未知 · 请重新读取策略' : value.offline ? '全局自动选择最近确认为开启 · Host 当前不可达' : '全局自动选择已开启';
  value.description.textContent = shared.uncertain || value.offline
    ? '当前策略未确认，项目后台可能仍按最后保存的授权运行；请先重新读取，不会自动重试写入。'
    : '此设备的项目后台会自动答复已有和新到的问题。单选选第一项；多选和文字问题交给 Agent 判断，可能继续调用并产生费用。';
  value.control.textContent = value.busy ? '正在关闭…' : '关闭全局自动选择';
  const reason = autoSelectReason(shared) || (value.offline ? 'Host 当前不可达，无法确认或修改全局策略；项目 daemon 可能仍按最后保存的策略运行。' : null);
  value.reread.hidden = !shared.uncertain && !value.offline;
  value.reread.disabled = shared.saving || shared.confirming || shared.reading;
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
  const status = deviceAutomationStatus(); value.busy = status.saving || status.confirming;
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
  try {
    if (await changeAutoSelect(false, { ownsPage: () => owns(host, value) })) {
      if (owns(host, value)) show('全局自动选择已关闭；已有答案保留，已开始的调用不会停止。');
    }
  } catch (error) { if (owns(host, value)) show(`全局关闭未确认：${error.message}；请读取最新策略后重试。`, 'error'); }
  finally { value.busy = false; if (owns(host, value)) paint(host, value); }
}
