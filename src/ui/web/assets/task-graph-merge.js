import { button, el } from './dom.js';
import { detail } from './navigate.js';

export const MERGE_PHASES = {
  executing: { label: '合并中', active: true },
  resolving: { label: '分歧处理中', active: true },
  requested: { label: '已请求等待合并' },
  suspended: { label: '交付挂起', warning: true },
  blocked: { label: '落地待核验', warning: true },
};

// parent_id remains the real delegation parent, even when layout skips hidden nodes.
export function mergePhase(node) {
  const r = node.reservation;
  return Number.isSafeInteger(node.parent_id) && node.parent_id > 0
    && r?.version === 2 && r.kind === 'merge' && r.queue_protocol === 1
    && r.parent_id === node.parent_id && MERGE_PHASES[r.status] ? r.status : null;
}
export function mergePriority(node) {
  const phase = mergePhase(node);
  return ['executing', 'resolving'].includes(phase) ? 0 : phase === 'requested' ? 1 : 2;
}
function taskLink(id, key) {
  const link = button(`#${id}`, () => detail(id), 'ghost task-graph-merge-link',
    { help: `打开 Worker #${id} 的已有详情，不调用 Agent。` });
  link.dataset.graphFocus = key;
  return link;
}
function phaseLabel(phase) {
  const info = MERGE_PHASES[phase];
  const label = el('span', undefined, `task-graph-merge-phase${info.warning ? ' warn' : ''}`);
  if (info.active) {
    const dot = el('span', undefined, 'task-graph-merge-dot');
    dot.setAttribute('aria-hidden', 'true'); label.append(dot);
  }
  label.append(info.label);
  return label;
}

/** Current queue facts are server-side aggregates, never counts over filtered cards. */
export function mergeRelations(node) {
  const line = el('div', undefined, 'task-graph-merge-relations');
  const phase = mergePhase(node);
  if (phase) {
    const own = el('span', undefined, 'task-graph-merge-own');
    own.append('→ ', taskLink(node.parent_id, `merge-parent-${node.id}`),
      node.target_branch ? ` / ${node.target_branch} · ` : ' · ', phaseLabel(phase));
    own.setAttribute('data-help', phase === 'resolving'
      ? '源侧分歧处理阶段，保留父执行位；不代表 Agent 此刻正在运行。'
      : phase === 'blocked' ? '落地结果待核验，仍保留父执行位；不代表正在推进合并。'
      : phase === 'suspended' ? '交付已挂起并释放执行位；恢复后重新排队。'
      : '持久合并请求的处理阶段；不代表 Worker 的 Agent 运行状态。');
    line.append(own);
  }
  const queue = node.merge_queue;
  if (queue?.total) {
    const incoming = el('span', undefined, 'task-graph-merge-incoming');
    incoming.append('合入此 Worker：');
    for (const status of Object.keys(MERGE_PHASES)) {
      const count = queue.counts[status] || 0;
      if (!count) continue;
      const group = el('span', undefined, 'task-graph-merge-group');
      group.append(phaseLabel(status), ` ${count} 条 `);
      const items = queue.items.filter(item => item.status === status);
      for (const item of items) group.append(taskLink(item.id, `merge-child-${node.id}-${item.id}`));
      if (count > items.length) group.append(`（另 ${count - items.length} 条未列出）`);
      incoming.append(group);
    }
    incoming.setAttribute('data-help', '完整直接子 Worker 的持久请求计数，不受筛选、折叠或图节点截断影响；编号仅列有界摘要，不表示严格执行次序。分歧处理中不是 Agent 运行状态，落地待核验仍占执行位但不代表正在推进。');
    line.append(incoming);
  } else if (!queue && node.children_total) {
    line.append(el('span', '合入摘要不可用（旧读面）', 'meta'));
  }
  if (!line.childNodes.length) return null;
  line.tabIndex = 0;
  line.dataset.graphFocus = `merge-relations-${node.id}`;
  line.setAttribute('aria-label', '合并关系摘要；窄屏可横向滚动查看完整关系');
  line.setAttribute('data-help', '持久预约的合并阶段，不代表 Agent 正在运行。合入计数覆盖完整直接子 Worker，编号是有界摘要；落地待核验仍占父执行位但不表示正在推进。窄屏可横向滚动查看，点击编号只打开详情。');
  return line;
}
