import { button, el, kv } from './dom.js';
import { workerKind } from './worker-kind.js';
import { workerLabel } from './worker-label.js';
import { show } from './messages.js';
import { ui } from './state.js';

export const waitingFirstInput = task => task?.creation?.waiting_first_input === true;
export const FIRST_INPUT_HELP = '打开绑定此 Worker 的工作指令编辑器；现在不发送、不调用 Agent。提交首条输入才创建真实 Input 并授权 Agent 执行，无需另点开始。';
export function workerCreateControl(source = null) {
  if (source && (!['order', 'child'].includes(workerKind(source)) || source.execution_retired === true || source.archived || source.branch_info?.archived)) return null;
  return button(source ? '复制创建' : '空白创建', async () => {
    const view = ui.view, boot = ui.workerNumbers;
    try { const { openWorkerCreate } = await import('./worker-create-form.js'); if (ui.view === view && ui.workerNumbers === boot) await openWorkerCreate({ source }); }
    catch (error) { show(`无法打开创建面板：${error.message}`, 'error'); }
  }, 'ghost worker-create-entry', { help: source ? '从此 Worker 的当前已提交代码和有效 Pi 检查点复制创建同父独立 Worker；不复制未提交文件、消息或授权，不调用 Agent。' : '只创建独立 Worker 和工作区；不创建 Input、不调用 Agent，稍后输入工作指令才授权执行。' });
}
export function workerCreationFacts(task) {
  const creation = task.creation;
  if (!creation) return null;
  const node = el('section', undefined, 'worker-creation-facts');
  if (waitingFirstInput(task)) node.append(el('p', '等待首条输入 · 尚未调用 Agent', 'hint worker-first-input'));
  node.append(kv('创建方式', creation.mode === 'fork' ? 'fork · 复制创建' : 'spawn · 空白创建'),
    kv('固定提交', creation.commit || '未知', 'mono'),
    kv('来源 Worker', creation.source_id == null ? '无（基于交付父）' : workerLabel(creation.source_id, creation.source_worker_number)),
    kv('交付父', workerLabel(task.parent_id, task.parent_worker_number)),
    kv('会话继承', creation.session_inherited === true ? '已继承' : creation.session_inherited === false ? '未继承' : '未知'));
  if (creation.warning) node.append(el('p', creation.warning, 'warn'));
  return node;
}
