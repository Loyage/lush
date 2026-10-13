import { block, el } from './dom.js';
import { absolute, noticeNumber } from './format.js';
import { workerLabel } from './worker-label.js';

const STATES = { idle: '尚未触发', waiting: '等待信号或安全点', queued: '已排队', running: '正在调用',
  waiting_actions: '操作已提交，等待安全点', succeeded: '已处理', submitted: '已提交', skipped: '已跳过／错过',
  failed: '失败', unknown: '结果未知，未自动重放', disabled: '已停用', stopped: '已停用', consumed: '一次性授权已用完', completed: '已完成' };
const stateLabel = state => STATES[state] || state || '暂无记录';
const CAPABILITIES = { pending_confirmation: '待用户确认（尚未执行）', approved: '授权已通过，等待安全点',
  running: '正在执行', succeeded: '已执行', rejected: '未获授权', failed: '未执行，预检或授权已变化', unknown: '结果待核验，不自动重放' };

/** Only display safe projection fields; never stringify private receipt parameters. */
export function managementReceipts(binding) {
  const area = el('div', undefined, 'management-receipts');
  const executions = [binding?.pending_signal, binding?.last_execution].filter(Boolean);
  for (const execution of executions) {
    const receipts = execution.actions || [], capabilities = execution.control_calls || [];
    for (const receipt of receipts.slice(0, 32)) area.append(el('p', `${receipt.action === 'retry' ? '重试' : receipt.action === 'start' ? '开始／继续' : '受控操作'} ${workerLabel(receipt.target_id, receipt.target_worker_number)}：${stateLabel(receipt.status)}${receipt.reason ? ` · ${receipt.reason}` : ''}`, 'hint'));
    if (execution.actions_truncated || receipts.length > 32) area.append(el('p', `操作摘要：${Number.isSafeInteger(execution.actions_count) ? `显示 ${Math.min(32, receipts.length)} / ${execution.actions_count} 项` : '仅显示部分'}；完整记录请查看调用历史。`, 'hint management-actions-truncated'));
    for (const receipt of capabilities.slice(0, 32)) {
      const notice = Number.isSafeInteger(receipt.notice_id) && receipt.notice_id > 0
        ? ` · 确认提醒 ${noticeNumber({ id: receipt.notice_id, kind: receipt.notice_kind })}` : '';
      area.append(el('p', `管理能力 ${receipt.method}：${CAPABILITIES[receipt.status] || '状态未知'}${notice}${receipt.reason ? ` · ${receipt.reason}` : ''}`, 'hint'));
    }
    if (execution.control_calls_truncated || capabilities.length > 32) area.append(el('p', `管理能力摘要：${Number.isSafeInteger(execution.control_calls_count) ? `显示 ${Math.min(32, capabilities.length)} / ${execution.control_calls_count} 项` : '仅显示部分'}；完整记录请查看调用历史。`, 'hint management-capabilities-truncated'));
  }
  return area;
}
export function renderManagementState(task) {
  const section = block('Valet 管理状态'); section.classList.add('management-state');
  const binding = task.management;
  if (!binding || binding.version !== 1) {
    section.append(el('p', '绑定状态暂不可用；不会默认启用或重放。', 'hint')); return section;
  }
  section.append(el('p', `${stateLabel(binding.state)} · ${binding.enabled ? '授权启用' : '授权停用'} · ${binding.mode === 'persistent' ? '持续绑定' : '一次性'}`));
  section.append(el('p', binding.origin === 'input' ? '来源：即时 Valet 输入，不等待时间信号。' : `绑定信号：${binding.signal_id || '未知'}；绑定编辑请到 Valet 设置。`, 'hint'));
  if (binding.reason) section.append(el('p', binding.reason, ['failed', 'unknown'].includes(binding.state) ? 'error' : 'hint'));
  if (binding.pending_signal) section.append(el('p', `已提交待处理：${absolute(binding.pending_signal.due_at)}；等待槽或安全点，不保证准点开跑。`, 'hint'));
  const last = binding.last_execution;
  if (last) section.append(el('p', `最近处理：${stateLabel(last.status)} · ${absolute(last.finished_at || last.started_at || last.submitted_at || last.created_at || last.due_at)}`, 'hint'));
  section.append(managementReceipts(binding));
  return section;
}
