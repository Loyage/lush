import { button, el } from './dom.js';
import { action } from './api.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { show } from './messages.js';
import { ui } from './state.js';
import { isHistoricalDelivery } from './format.js';

export const isIterationTask = task => ['say', 'child'].includes(task.task_kind);
export function iterationBlocker(task) {
  if (!task.branch || task.archived || task.branch_archive?.archived || task.branch_info?.archived)
    return '分支已归档或不可用；不会重建工作区。';
  if (task.workspace_state === 'missing') return 'worktree 缺失；请先检查现场。';
  if (task.reservation?.status === 'requested' || task.freeze || task.branch_archive?.freeze)
    return '任务或分支已冻结；先处理在途交付。';
  const frozen = (ui.lastSnapshot?.status?.branch_freeze || []).find(row =>
    row.branch === task.branch || row.target_branch === task.branch);
  return frozen ? '分支已冻结；先处理在途交付。' : null;
}
/** Disabled actions keep pointer/keyboard help on a wrapper, not on the disabled button. */
export function guardedAction(node, reason) {
  if (!reason) return node;
  node.disabled = true;
  const host = el('span', undefined, 'help-host'); host.tabIndex = 0;
  host.setAttribute('data-help', `${reason} ${node.getAttribute('data-help') || ''}`);
  host.append(node); return host;
}

/** Detail and graph share the same non-Agent acceptance/sync and explicit Agent conflict path. */
export function iterationControls(task, { refresh = () => {}, events = [] } = {}) {
  if (!isIterationTask(task) || isHistoricalDelivery(task)) return null;
  const ended = ['completed', 'failed', 'cancelled'].includes(task.status);
  const accepted = task.accepted === true || events.some(event => event.type === 'task.accepted');
  const historical = task.status === 'completed' && task.integration === 'merged' && !accepted
    && Boolean(task.branch && task.workspace) && !task.archived
    && !task.branch_archive?.archived && !task.branch_info?.archived;
  if (ended && !historical) return null;
  const panel = el('div', undefined, 'iteration-controls');
  const actions = el('div', undefined, 'actions iteration-actions');
  const blocker = iterationBlocker(task);
  const busy = task.status === 'running' || task.status === 'queued' || task.agent?.active;
  const reason = blocker || (!task.workspace ? 'worktree 未保留；不会自动重建。' : null)
    || (busy ? 'Agent 仍在执行；请等安全结束后操作。' : null);
  const update = async (method, message) => {
    try { await action(method, { id: task.id }); show(message); await refresh(); }
    catch (error) { show(error.message, 'error'); }
  };
  if (historical) {
    actions.append(guardedAction(button('继续开发', async () => {
      if (!await confirmDialog({ title: `恢复 Task #${task.id}？`,
        message: '仅将保留分支与 worktree 的历史已合并任务恢复为待验收。不会调用 Agent；恢复后追加输入才继续当前 Task。已归档任务不会重建。',
        confirmLabel: '恢复待验收', confirmHelp: '恢复原 Task 身份、会话与工作区；不自动运行 Agent。' })) return;
      await update('task.reopen', '已恢复待验收；追加输入可继续开发。');
    }, 'ghost', { help: '显式恢复历史已合并任务为待验收；不会调用 Agent 或重建已归档分支。' }), reason));
  } else {
    if (task.status === 'awaiting_acceptance') {
      const acceptanceReason = reason || ((task.children || []).some(child => !['completed', 'failed', 'cancelled'].includes(child.status))
        ? '后代尚未确认或结算；派生任务由其直接父 Agent 检查并确认，无需你逐个验收。' : null);
      panel.append(el('p', task.task_kind === 'child'
        ? `本轮已交付，等待父 Task #${task.parent_id} 的 Agent 检查并确认；无需你验收。需要修改时可追加输入，分支与 worktree 保留。`
        : '本轮已交付，等待你验收；追加输入可继续当前 Task。派生任务由父 Agent 检查并确认，无需你逐个验收。验收完成不会归档分支或 worktree。', 'hint'));
      if (task.task_kind !== 'child') actions.append(guardedAction(button('验收完成', async () => {
        if (!await confirmDialog({ title: `验收 Task #${task.id}？`,
          message: '将 Task 结算为已完成，不调用 Agent，也不删除分支、worktree、会话与交付历史。派生任务须先由其直接父 Agent 确认，本操作不会替它们确认；归档仍是独立的显式操作。',
          confirmLabel: '验收完成', confirmHelp: '确认本轮成果完成；结算 Task，但不归档代码现场。' })) return;
        await update('task.accept', '验收完成；分支与工作区保留。');
      }, undefined, { help: '结算为已完成，不运行 Agent；派生任务由其直接父 Agent 确认，无需你逐个验收。验收与归档独立，待验收时不能直接归档工作区。' }), acceptanceReason));
    }
    actions.append(guardedAction(button('同步父分支', async () => {
      try {
        const result = await action('task.sync_parent', { id: task.id });
        if (result.conflict) {
          task.parent_sync_conflict = { source_commit: result.source_commit, parent_commit: result.parent_commit, reason: result.reason };
          show(`同步冲突：${result.reason || '请单独点击「Agent 解决同步冲突」'}。未启动 Agent。`, 'error');
          const diagnosis = iterationControls(task, { refresh, events });
          panel.replaceChildren(...diagnosis.children);
        } else show(result.synced ? '已同步父分支；未调用 Agent。' : result.reason || '已与父分支同步。');
        await refresh();
      } catch (error) { show(error.message, 'error'); }
    }, 'ghost', { help: '只在当前 Task 分支安全吸收父分支提交；无冲突由程序完成，冲突只显示诊断，不调用 Agent，不推进父分支。' }), reason));
    const conflict = task.parent_sync_conflict;
    if (conflict) {
      panel.append(el('p', `父同步冲突：${conflict.reason || '需要处理'}\n源 ${conflict.source_commit || '未知'} · 父 ${conflict.parent_commit || '未知'}`, 'hint mono'));
      actions.append(guardedAction(button('Agent 解决同步冲突', async () => {
        if (!await confirmDialog({ title: `解决 Task #${task.id} 的同步冲突？`,
          message: 'Agent 在当前 Task 工作区吸收已记录的固定父提交、解决冲突并测试；不推进父分支。两端提交漂移会拒绝，请重新同步。',
          confirmLabel: '调用 Agent', agent: true, confirmHelp: agentHelp('解决已记录的固定父同步冲突并测试。') })) return;
        await update('task.resolve_sync', '已请求 Agent 解决同步冲突。');
      }, 'ghost', { agent: true, help: agentHelp('在当前 Task 源侧解决持久化的父同步冲突；两端漂移须重新同步。') }), reason));
    }
  }
  panel.append(actions); return panel;
}
