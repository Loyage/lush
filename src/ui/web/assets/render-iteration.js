import { button, el } from './dom.js';
import { workerKind } from './worker-kind.js';
import { action, api } from './api.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { show } from './messages.js';
import { ui } from './state.js';
import { isHistoricalDelivery } from './format.js';
import { refresh as refreshOverview } from './navigate.js';
import { workerLabel } from './worker-label.js';
import { projectBase, routeContext } from './route.js';

export const isIterationTask = task => ['order', 'child'].includes(workerKind(task));
export function iterationBlocker(task, { forAcceptance = false } = {}) {
  const recovery = forAcceptance && task.acceptance_recovery === true;
  if (!task.branch || (!recovery && (task.archived || task.branch_archive?.archived || task.branch_info?.archived)))
    return '分支已归档或不可用；不会重建工作区。';
  if (!recovery && task.workspace_state === 'missing') return 'worktree 缺失；请先检查现场。';
  if (task.reservation?.status === 'requested' || task.freeze || task.branch_archive?.freeze)
    return 'Worker 或分支已冻结；先处理在途交付。';
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
export function iterationControls(task, { refresh = () => {}, events = [], showParentDistance = false } = {}) {
  if (!isIterationTask(task) || isHistoricalDelivery(task)) return null;
  const ended = ['completed', 'failed', 'cancelled'].includes(task.status);
  const accepted = task.accepted === true || events.some(event => event.type === 'task.accepted');
  const recovery = task.acceptance_recovery === true && !['failed', 'cancelled'].includes(task.status);
  const historical = task.status === 'completed' && task.integration === 'merged' && !accepted
    && Boolean(task.branch && task.workspace) && !task.archived
    && !task.branch_archive?.archived && !task.branch_info?.archived;
  const reclaimAccepted = task.status === 'completed' && accepted && Boolean(task.branch)
    && !task.archived && !task.branch_archive?.archived && !task.branch_info?.archived;
  if (ended && !historical && !reclaimAccepted && !recovery) return null;
  const panel = el('div', undefined, 'iteration-controls');
  const view = ui.view, scope = projectBase(), owner = globalThis.document;
  const owns = () => ui.view === view && projectBase() === scope && !routeContext().invalid && globalThis.document === owner;
  const actions = el('div', undefined, 'actions iteration-actions');
  const blocker = iterationBlocker(task, { forAcceptance: recovery });
  const iterationBase = task.iteration_base_commit ?? task.base_commit;
  // A known unchanged iteration and a returned answer are candidates, not delivery proof.
  // The daemon still checks the worktree, inbox, decisions, descendants and fixed Git facts.
  const noChangeAnswer = workerKind(task) === 'order' && task.status === 'waiting'
    && (task.result != null || task.has_result === true)
    && Boolean(iterationBase && task.head_commit === iterationBase);
  const busy = task.status === 'running' || task.status === 'queued' || task.agent?.active;
  const reason = blocker || (!recovery && !task.workspace ? 'worktree 未保留；不会自动重建。' : null)
    || (busy ? 'Agent 仍在执行；请等安全结束后操作。' : null)
    || (recovery && !['waiting', 'awaiting_acceptance', 'completed'].includes(task.status) ? 'Worker 尚未静息；先处理当前状态再续办验收。' : null);
  const update = async (method, message) => {
    try { await action(method, { id: task.id }); show(message); await refresh(); }
    catch (error) { show(error.message, 'error'); }
  };
  if (historical && !recovery) {
    actions.append(guardedAction(button('继续开发', async () => {
      if (!await confirmDialog({ title: `恢复 Worker ${workerLabel(task)}？`,
        message: '仅将保留分支与 worktree 的历史已合并 Worker 恢复为待验收。不会调用 Agent；恢复后追加输入才继续当前 Worker。已归档 Worker 不会重建。',
        confirmLabel: '恢复待验收', confirmHelp: '恢复原 Worker 身份、会话与工作区；不自动运行 Agent。' })) return;
      await update('worker.reopen', '已恢复待验收；追加输入可继续开发。');
    }, 'ghost', { help: '显式恢复历史已合并 Worker为待验收；不会调用 Agent 或重建已归档分支。' }), reason));
  } else {
    if (task.status === 'awaiting_acceptance' || noChangeAnswer || reclaimAccepted || recovery) {
      const booking = task.reservation;
      const deliveryReason = (noChangeAnswer || recovery) && booking && !['integrated', 'completed', 'withdrawn'].includes(booking.status)
        ? '交付预约尚未结算；验收不能绕过在途交付。' : null;
      const acceptanceReason = reason || deliveryReason
        || ((task.children || []).some(child => !['completed', 'failed', 'cancelled'].includes(child.status))
          ? '后代尚未确认或结算；派生 Worker 由其直接父 Agent 检查并确认，无需你逐个验收。' : null);
      const phase = noChangeAnswer
        ? '本轮仅回答，无新增提交 · 待验收（无需先请求合并）'
        : '本轮已交付 · 待验收';
      const acceptanceHelp = '验收表示对该 Worker 的工作不再有异议，同时归档并删除本分支及全部后代分支的 worktree 与本地 ref，保留 Worker、结果、消息、事件与会话等运行历史；脏工作区、未读输入、待决或未交付改动会阻止验收。不调用 Agent，验收后如有新要求请另发指令。';
      // Keep the phase and exceptional facts visible; shared lifecycle rules live in help/docs.
      panel.append(el('p', task.task_kind === 'child'
        ? recovery
          ? `资源回收未完成 · 等待父 Worker ${workerLabel(task.parent_id, task.parent_worker_number)} 按持久记录续办验收`
          : `本轮已交付 · 等待父 Worker ${workerLabel(task.parent_id, task.parent_worker_number)} 确认`
        : recovery
          ? '资源回收未完成 · 已保留精确续办记录，请续办验收'
          : reclaimAccepted
            ? '历史验收尚未回收开发资源 · 可再次验收补办'
            : phase, 'hint iteration-phase'));
      if (task.task_kind !== 'child') {
        let accepting = false, accepted = false;
        const accept = async () => {
          if (!owns() || accepting || accepted) return;
          accepting = true;
          try {
            // One authoritative mutation; never follow acceptance with branch.archive.
            let result;
            try { result = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ method: 'worker.accept', params: { id: task.id } }) }); }
            catch (error) { if (owns()) show(error.message, 'error'); return; }
            accepted = true;
            if (!owns()) return;
            const reclaimed = result?.id === task.id && result.status === 'completed' && result.workspace === null;
            show(reclaimed ? '验收完成，开发资源已归档回收；结果与运行历史保留。'
              : '验收请求已处理，但资源回收结果未确认；请刷新并确认服务版本，勿重复提交。', reclaimed ? 'info' : 'error');
            for (const reload of [refreshOverview, refresh]) {
              if (!owns()) break;
              try { await reload(); }
              catch (error) { if (owns()) show(`验收请求已处理，但刷新失败：${error.message}`, 'error'); }
            }
          } finally { accepting = false; }
        };
        actions.append(guardedAction(button(recovery ? '续办验收' : '验收', accept, undefined, { help: acceptanceHelp }), acceptanceReason));
      }
    }
    if (reclaimAccepted || recovery) { panel.append(actions); return panel; }
    actions.append(guardedAction(button('同步父分支', async () => {
      try {
        const result = await action('worker.sync_parent', { id: task.id });
        if (result.conflict) {
          task.parent_sync_conflict = { source_commit: result.source_commit, parent_commit: result.parent_commit, reason: result.reason };
          show(`同步冲突：${result.reason || '请单独点击「Agent 解决同步冲突」'}。未启动 Agent。`, 'error');
          const diagnosis = iterationControls(task, { refresh, events, showParentDistance });
          panel.replaceChildren(...diagnosis.children);
        } else show(result.synced ? '已同步父分支；未调用 Agent。' : result.reason || '已与父分支同步。');
        await refresh();
      } catch (error) { show(error.message, 'error'); }
    }, 'ghost', { help: '只在当前 Worker 分支安全吸收父分支提交；无冲突由程序完成，冲突只显示诊断，不调用 Agent，不推进父分支。' }), reason));
    if (showParentDistance) {
      const { ahead, behind } = task.parent_relation || {};
      const distance = el('span', undefined, 'parent-commit-distance');
      if ([ahead, behind].every(count => Number.isSafeInteger(count) && count >= 0)) {
        distance.append(el('span', `领先 ${ahead}`, 'parent-commit-ahead'), el('span', ' / '),
          el('span', `落后 ${behind}`, 'parent-commit-behind'), el('span', ' 个 commit'));
      } else distance.textContent = '父分支 commit 距离未知';
      actions.append(distance);
    }
    const conflict = task.parent_sync_conflict;
    if (conflict) {
      panel.append(el('p', `父同步冲突：${conflict.reason || '需要处理'}\n源 ${conflict.source_commit || '未知'} · 父 ${conflict.parent_commit || '未知'}`, 'hint mono'));
      actions.append(guardedAction(button('Agent 解决同步冲突', async () => {
        if (!await confirmDialog({ title: `解决 Worker ${workerLabel(task)} 的同步冲突？`,
          message: 'Agent 在当前 Worker 工作区吸收已记录的固定父提交、解决冲突并测试；不推进父分支。两端提交漂移会拒绝，请重新同步。',
          confirmLabel: '调用 Agent', agent: true, confirmHelp: agentHelp('解决已记录的固定父同步冲突并测试。') })) return;
        await update('worker.resolve_sync', '已请求 Agent 解决同步冲突。');
      }, 'ghost', { agent: true, help: agentHelp('在当前 Worker 源侧解决持久化的父同步冲突；两端漂移须重新同步。') }), reason));
    }
  }
  panel.append(actions); return panel;
}
