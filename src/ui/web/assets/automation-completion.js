import { el } from './dom.js';
import { renderAutomationSettings } from './automation-settings.js';

export const renderCompletionAutomation = options => renderAutomationSettings({ ...options, feature: 'completion' });
export const renderAcceptanceNoticeAutomation = options => renderAutomationSettings({ ...options, feature: 'acceptance_notice' });

/** Compatibility for old module callers; never loads or changes retired defaults. */
export function renderConvergenceAutomation() {
  const node = el('p', '持续归并设置已退役；普通自动合并与已有历史保留。', 'hint');
  node.ready = Promise.resolve();
  return node;
}
