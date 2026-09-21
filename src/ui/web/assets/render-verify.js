import { $, block, button, el, statusBadge } from './dom.js';
import { absolute, relative, short } from './format.js';
import { detail } from './navigate.js';
import { referenceable } from './context-references.js';

const reportButton = taskId => button('打开 HTML 报告', () => { window.open(`/api/task/${taskId}/report`, '_blank', 'noopener'); }, 'ghost');
/** 检验区块：worker 看自己的历次检验，verifier 看自己的报告。 */
export function renderVerifications(task) {
  if (task.role === 'verifier') {
    const section = block('检验');
    section.append(el('p', `本任务检验 #${task.verifies_task_id}：演示它 worktree 里的实际运行结果，并对照目标分支的同一场景。`, 'hint'));
    if (task.report) { const actions = el('div', undefined, 'actions'); actions.append(reportButton(task.id)); section.append(actions); }
    else section.append(el('p', '还没有生成 HTML 报告；报告写到任务 result 里给出的 report_path。', 'hint'));
    referenceable(section, { kind: 'verification', target: { verification_id: task.id }, label: `检验任务 #${task.id}`,
      quote: task.result || `检验任务 #${task.id}，被检验任务 #${task.verifies_task_id}`, location: { view: 'task-detail', task_id: task.id, section: 'verification' } });
    return section;
  }
  const verifications = task.verifications || [];
  const section = block('检验', String(verifications.length));
  if (!verifications.length) {
    section.append(el('p', '还没有检验。点上面的「检验」会派一个只读 agent，用它自己判断的最直观方式演示 worktree 结果，并对照目标分支。', 'hint'));
    return section;
  }
  for (const item of verifications) {
    const card = el('div', undefined, 'verify');
    const row = el('div', undefined, 'row');
    row.append(statusBadge(item), el('span', `#${item.id}`, 'tid'), button('查看检验任务', () => detail(item.id), 'link'),
      el('span', `${relative(item.updated_at)} · ${absolute(item.updated_at)}`, 'when'));
    card.append(row);
    if (item.baseline_commit) card.append(el('p', `对照基线 ${short(item.baseline_commit)}`, 'hint'));
    if (item.result) card.append(el('pre', item.result));
    if (item.error) card.append(el('pre', item.error, 'error'));
    if (item.has_report) { const actions = el('div', undefined, 'actions'); actions.append(reportButton(item.id)); card.append(actions); }
    referenceable(card, { kind: 'verification', target: { verification_id: item.id }, label: `检验 #${item.id}`,
      quote: item.result || item.error || `检验 #${item.id} · ${item.status}`, location: { view: 'task-detail', task_id: task.id, section: 'verification' } });
    section.append(card);
  }
  return section;
}
