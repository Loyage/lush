import { enhanceModule } from './shared-module.js';

/** Compatibility wrapper: explicit editor folding, never automatic height clipping. */
export function automationModule(section, key, states = undefined, summary = '') {
  const view = enhanceModule(section, { key, mode: 'fold', states, summary, id: `automation-module-${key}` });
  view.states.set(key, view.expanded);
  section.classList.add('automation-module'); section.dataset.module = key;
  view.body.classList.add('automation-module-body'); view.summary.classList.add('automation-module-summary');
  view.toggle.classList.add('automation-module-toggle');
  if (!Object.getOwnPropertyDescriptor(section, 'moduleOpen')) Object.defineProperty(section, 'moduleOpen', {
    get: () => view.expanded,
    set: value => view.setExpanded(value),
  });
  section.moduleBody = view.body; section.moduleSummary = view.summary;
  return section;
}

export function automationAlerts(items = []) {
  return items.filter(item => ['pending', 'waiting', 'running', 'failed', 'unknown', 'skipped', 'missed'].includes(item.state || item.status) || item.pending_due_at)
    .map(item => `${item.name || item.command_name || '记录'}：${({ pending: '等待执行', waiting: '等待安全点', running: '执行中', failed: '失败', unknown: '结果未知', skipped: '已跳过', missed: '已错过' })[item.state || item.status] || '等待安全点'}${item.last_execution?.error || item.reason ? ` · ${item.last_execution?.error || item.reason}` : ''}`).join('；');
}
