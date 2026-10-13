import { el, button } from './dom.js';
import { confirmDialog } from './dialog.js';
import { api } from './api.js';
import { renderAutomationSettings } from './automation-settings.js';
import { convergenceDefaultsEditor } from './convergence-policy-controls.js';

export const renderCompletionAutomation = options => renderAutomationSettings({ ...options, feature: 'completion' });
export const renderAcceptanceNoticeAutomation = options => renderAutomationSettings({ ...options, feature: 'acceptance_notice' });

/** Project page edits future defaults only; actual target policy lives with its Worker. */
export function renderConvergenceAutomation(options) {
  const node = renderAutomationSettings({ ...options, feature: 'convergence' });
  const owns = options.ownsPage || (() => true);
  let disposed = false, uncertain = false;
  const feedback = el('p', undefined, 'error'); feedback.setAttribute('role', 'status');
  const defaults = convergenceDefaultsEditor({ ownsPage: () => !disposed && owns(), busy: () => uncertain || node.getAttribute('aria-busy') === 'true',
    setBusy(value) { if (!value && !owns() && !disposed) uncertain = true; } });
  const verify = button('核对归并默认保存结果', async () => {
    if (disposed || !owns() || !uncertain) return;
    if (!await confirmDialog({ title: '放弃归并默认草稿并核对？', message: '只读取得最新默认值，放弃本页尚未保存的归并选择；不重发任何操作。', confirmLabel: '放弃并读取' }) || !owns()) return;
    try { const value = await api('/api/branch-convergence/defaults'); if (!disposed && owns()) { defaults.setModel(value); uncertain = false; feedback.textContent = ''; defaults.syncControls(); verify.hidden = true; } }
    catch (error) { if (!disposed && owns()) feedback.textContent = `归并默认核对失败：${error.message}`; }
  }, 'ghost'); verify.hidden = true;
  node.extra.append(defaults, feedback, verify, el('p', '实际归并挂载／策略请在对应 Worker 的自动化模块设置；项目页不列出分支授权或运行批次。', 'hint'));
  const controller = new AbortController(), ready = node.ready;
  node.ready = Promise.all([ready, api('/api/branch-convergence/defaults', { signal: controller.signal }).then(value => {
    if (!disposed && owns()) defaults.setModel(value); else if (!disposed) uncertain = true;
  }).catch(error => { if (!disposed && owns() && error.name !== 'AbortError') feedback.textContent = `归并默认读取失败：${error.message}；不推断默认值。`; })]);
  const dispose = node.dispose; node.dispose = () => { disposed = true; controller.abort(); dispose(); };
  const select = node.setSubpage; node.setSubpage = () => { select(); if (owns() && uncertain) { feedback.textContent = '离开期间归并默认的读取或保存已结束，原草稿保留；请先只读核对，不重复提交。'; verify.hidden = false; } defaults.syncControls(); return node.ready; };
  return node;
}
