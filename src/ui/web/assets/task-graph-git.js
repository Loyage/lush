import { el } from './dom.js';

/** Compact live Git facts, not delivery state or distance from the original baseline. */
export function graphGitStatus(node) {
  if (!node.branch || node.archived || node.branch_info?.archived) return null;
  const status = node.branch_info?.diagnostics?.working_tree?.status;
  const mark = status === 'dirty' ? '*' : status === 'clean' ? '\u00a0' : '?';
  const pending = status === 'dirty' ? '有未提交更改' : status === 'clean' ? '无未提交更改'
    : node.details_pending ? '未提交状态加载中' : '未提交状态未知';
  const box = el('span', undefined, 'task-graph-git-status mono');
  const pendingClass = status === 'dirty' ? 'is-dirty' : status === 'clean' ? 'is-clean' : 'is-unknown';
  box.append(el('span', mark, `task-graph-git-pending ${pendingClass}`));
  let description = pending;
  if (node.parent_id != null) {
    const { ahead, behind } = node.parent_relation || {};
    const valid = value => Number.isSafeInteger(value) && value >= 0;
    box.append(el('span', `+${valid(ahead) ? ahead : '?'}`, 'parent-commit-ahead'),
      el('span', `-${valid(behind) ? behind : '?'}`, 'parent-commit-behind'));
    description += `；相对直接父 Worker 分支：领先 ${valid(ahead) ? ahead : '未知'}、落后 ${valid(behind) ? behind : '未知'} 个 commit。真实 Git 关系，不代表是否已交付或合并。`;
  } else description += '；根 Worker 没有父分支可比较。';
  box.setAttribute('aria-label', description);
  box.setAttribute('data-help', description);
  box.tabIndex = 0;
  return box;
}
