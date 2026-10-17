import { el } from './dom.js';
import { projectBase } from './route.js';

export function executionTarget(hash) {
  const match = /^#worker-([1-9]\d*)-execution(?:-(code|performance))?$/.exec(hash);
  const taskId = Number(match?.[1]);
  return match && Number.isSafeInteger(taskId) ? { taskId, mode: match[2] || 'transcript' } : null;
}

/** Native links preserve the source project, modifiers and the original detail page. */
export function executionLink(taskId, { mode = 'transcript', className = '', help = '' } = {}) {
  const link = el('a', mode === 'code' ? '打开代码阅读器' : '打开执行详情', `nav-link ${className}`.trim());
  link.href = `${projectBase()}/#worker-${taskId}-execution${mode === 'code' ? '-code' : ''}`;
  link.target = '_blank'; link.rel = 'noopener';
  if (help) link.setAttribute('data-help', help);
  return link;
}
