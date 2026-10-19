import { el } from './dom.js';
import { executionLink } from './execution-route.js';

/** Presentation only: retain the original controls, handlers, guards and live action rows. */
export function detailActions(task, { open = false } = {}) {
  const root = el('div', undefined, 'actions task-actions');
  root.setAttribute('aria-label', 'Worker 操作');
  const groups = {}, adopted = new WeakMap();
  const group = (key, label) => {
    const node = el('div', undefined, `worker-action-group worker-action-${key}`);
    node.setAttribute('role', 'group'); node.setAttribute('aria-label', label);
    node.dataset.label = label; groups[key] = node; return node;
  };
  root.append(executionLink(task.id, { help: '在新标签页打开工作台，默认显示执行记录，可切换代码与改动、性能分析及适用 Worker 的 CLI 交互。打开页面不会执行命令或调用 Agent；CLI 命令仍需显式提交和原有确认。' }),
    group('work', '工作'), group('delivery', '交付'), group('utility', '页面'));
  const more = el('details', undefined, 'worker-action-more'); more.open = open; more.hidden = true;
  const summary = el('summary', '更多操作', 'ghost');
  const extra = el('div', undefined, 'worker-action-more-panel');
  extra.append(group('collaboration', '协作'), group('settings', '设置'), group('danger', '危险操作'));
  more.append(summary, extra); root.append(more);
  return {
    root, work: groups.work,
    add(key, node) {
      if (!node) return;
      node.remove(); groups[key].append(node);
      if (['collaboration', 'settings', 'danger'].includes(key)) more.hidden = false;
    },
    adopt(panel, selector, key = 'delivery') {
      // Move the whole row: async additions (e.g. force-acceptance recovery) keep their owner.
      if (!panel) return;
      let slots = adopted.get(panel);
      if (!slots) { slots = new Map(); adopted.set(panel, slots); }
      for (const old of slots.get(selector) || []) old.remove();
      const rows = [...panel.querySelectorAll(selector)]; slots.set(selector, rows);
      for (const row of rows) {
        row.remove();
        if (selector === '.iteration-actions' && !row.children.length) continue;
        this.add(key, row);
      }
    },
  };
}
