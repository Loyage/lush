import { el, button } from './dom.js';

/** Page-owned information zoom. Hiding a body never discards its editor or selection. */
export function automationModule(section, key, states = new Map(), summary = '') {
  if (section.moduleBody) { section.moduleSummary.textContent = summary; return section; }
  section.classList.add('automation-module'); section.dataset.module = key;
  const head = section.querySelector('.section-title');
  const body = el('div', undefined, 'automation-module-body'); body.id = `automation-module-${key}`;
  const status = el('p', summary, 'hint automation-module-summary'); status.setAttribute('role', 'status');
  for (const child of [...section.children]) if (child !== head) { child.remove(); body.append(child); }
  const toggle = button('收起', () => { section.moduleOpen = !section.moduleOpen; }, 'ghost automation-module-toggle');
  toggle.setAttribute('aria-controls', body.id);
  Object.defineProperty(section, 'moduleOpen', {
    get: () => !body.hidden,
    set(value) { states.set(key, !!value); body.hidden = !value; toggle.textContent = value ? '收起' : '展开'; toggle.setAttribute('aria-expanded', String(!!value)); },
  });
  head.append(toggle); section.append(status, body); section.moduleBody = body; section.moduleSummary = status;
  section.moduleOpen = states.get(key) ?? true;
  return section;
}

export function automationAlerts(items = []) {
  return items.filter(item => ['pending', 'waiting', 'running', 'failed', 'unknown', 'skipped', 'missed'].includes(item.state || item.status) || item.pending_due_at)
    .map(item => `${item.name || item.command_name || '记录'}：${({ pending: '等待执行', waiting: '等待安全点', running: '执行中', failed: '失败', unknown: '结果未知', skipped: '已跳过', missed: '已错过' })[item.state || item.status] || '等待安全点'}${item.last_execution?.error || item.reason ? ` · ${item.last_execution?.error || item.reason}` : ''}`).join('；');
}
