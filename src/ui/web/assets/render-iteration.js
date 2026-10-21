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

// Keep an explicit unread-failure fallback and single-flight gate across same-view polling repaints.
// Document/view/project identity isolates navigation and tests; no persistent authorization is stored.
const acceptanceByDocument = new WeakMap();
function acceptanceState(owner, view, scope, taskId) {
  let states = acceptanceByDocument.get(owner);
  if (!states) { states = new Map(); acceptanceByDocument.set(owner, states); }
  const key = `${scope}:${taskId}`;
  let state = states.get(key);
  if (!state || state.view !== view) {
    state = { view, accepting: false, accepted: false, forceAvailable: false }; states.set(key, state);
    if (states.size > 200) states.delete(states.keys().next().value);
  }
  return state;
}

export const isIterationTask = task => ['order', 'child'].includes(workerKind(task));
export function iterationBlocker(task, { forAcceptance = false } = {}) {
  if (task.execution_retired === true) return '远端执行已退役，仅保留只读历史。';
  const recovery = forAcceptance && task.acceptance_recovery === true;
  if (!task.branch || (!recovery && (task.archived || task.branch_archive?.archived || task.branch_info?.archived)))
    return '分支已归档或不可用；不会重建工作区。';
  if (!recovery && task.workspace_state === 'missing') return 'worktree 缺失；请先检查现场。';
  if (task.reservation?.status === 'requested' || task.freeze || task.branch_archive?.freeze)
    return 'Worker 或分支已冻结；先处理在途合并。';
  const frozen = (ui.lastSnapshot?.status?.branch_freeze || []).find(row =>
    row.branch === task.branch || row.target_branch === task.branch);
  return frozen ? '分支已冻结；先处理在途合并。' : null;
}
/** Disabled actions keep pointer/keyboard help on a wrapper, not on the disabled button. */
export function guardedAction(node, reason) {
  if (!reason) return node;
  node.disabled = true;
  const host = el('span', undefined, 'help-host'); host.tabIndex = 0;
  host.setAttribute('data-help', `${reason} ${node.getAttribute('data-help') || ''}`);
  host.append(node); return host;
}

function valetAcceptanceControls(task, { refresh = () => {}, root = null } = {}) {
  if (task.role !== 'manager' || task.execution_retired === true || !task.management) return null;
  const facts = task.management;
  const panel = root || el('div', undefined, 'iteration-controls'); panel.replaceChildren();
  if (facts.accepted === true && facts.archived === true) {
    panel.append(el('p', '已验收归档 · 结果、会话与执行历史只读保留', 'hint iteration-phase'));
    return panel;
  }
  if (facts.acceptance_blocked) {
    panel.append(el('p', facts.acceptance_reason || '验收记录不完整 · 请检查持久记录，不能恢复旧授权', 'hint iteration-phase'));
    return panel;
  }
  if (!facts.can_accept && !facts.acceptance_recovery) return null;
  const view = ui.view, scope = projectBase(), owner = globalThis.document;
  const owns = () => ui.view === view && projectBase() === scope && !routeContext().invalid && globalThis.document === owner;
  const state = acceptanceState(owner, view, scope, task.id);
  const actions = el('div', undefined, 'actions iteration-actions');
  panel.append(el('p', facts.acceptance_recovery ? '资源回收未完成 · 请核对记录并显式续办验收' : '管理事项已安全收口 · 待验收', 'hint iteration-phase'));
  const help = '验收只归档此 Valet 并安全回收其专属空运行目录，保留编号、目标、结果、消息、Notice、事件、会话与执行历史；不会验收或删除其管理的开发 Worker，不删除共享信号。若仍绑定未来信号，确认后同时结束此身份的未来授权；排队、在途、未知副作用、未处理输入与待决均阻止验收。验收后历史只读，不可追加或启用；不调用 Agent。';
  const accept = async () => {
    if (!owns() || state.accepting || state.accepted) return;
    state.accepting = true;
    try {
      const preview = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'worker.accept_preview', params: { id: task.id } }) });
      if (!owns()) return;
      if (preview?.kind !== 'management' || preview.id !== task.id || preview.can_accept !== true
        || !/^[0-9a-f]{64}$/.test(preview.revision) || preview.history_preserved !== true
        || preview.managed_workers_unchanged !== true || !preview.resources) throw new Error('Valet 验收预检不完整；请核对服务版本，不会提交。');
      if (!await confirmDialog({ title: `验收 Valet ${workerLabel(task)}？`,
        message: preview.ends_future_binding ? '将同时结束此 Valet 尚未触发的未来信号绑定并归档；此授权不可恢复。不会取消已排队或在途事项。' : '确认此 Valet 的工作不再有异议，并归档回收其专属运行资源；验收后不可追加或启用。',
        detail: `${preview.resources.management_workspace ? `回收专属空目录：${preview.resources.management_workspace}` : '无专属运行目录需要回收。'}\n保留编号、目标、消息、Notice、事件、结果、会话与执行历史。\n不删除共享信号，不连带验收其管理或创建的开发 Worker。`,
        confirmLabel: preview.ends_future_binding ? '结束未来绑定并验收' : '验收归档', confirmHelp: help }) || !owns()) return;
      const result = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'worker.accept', params: { id: task.id, revision: preview.revision, confirm: true } }) });
      state.accepted = true;
      if (!owns()) return;
      const reclaimed = result?.id === task.id && result.management?.accepted === true && result.management?.archived === true && result.workspace === null;
      show(reclaimed ? 'Valet 已验收归档；结果、会话与执行历史保留。' : '验收请求已返回，但完成事实未确认；请刷新核对，勿重复提交。', reclaimed ? 'info' : 'error');
      for (const reload of [refreshOverview, refresh]) {
        if (!owns()) break;
        try { await reload(); } catch (error) { if (owns()) show(`验收请求已处理，但刷新失败：${error.message}`, 'error'); }
      }
    } catch (error) { if (owns()) show(error.message, 'error'); }
    finally { state.accepting = false; }
  };
  actions.append(guardedAction(button(facts.acceptance_recovery ? '续办验收' : '验收', accept, undefined, { help }), facts.can_accept ? null : facts.acceptance_reason));
  panel.append(actions); return panel;
}

/** Detail and graph share the same non-Agent acceptance/sync and explicit Agent conflict path. */
export function iterationControls(task, { refresh = () => {}, events = [], showParentDistance = false, onRebuild = () => {}, root = null } = {}) {
  if (task.task_kind === 'management') return valetAcceptanceControls(task, { refresh, root });
  if (task.execution_retired === true || !isIterationTask(task) || isHistoricalDelivery(task)) return null;
  const ended = ['completed', 'failed', 'cancelled'].includes(task.status);
  const accepted = task.accepted === true || events.some(event => event.type === 'task.accepted');
  const recovery = task.acceptance_recovery === true && !['failed', 'cancelled'].includes(task.status);
  const historical = task.status === 'completed' && task.integration === 'merged' && !accepted
    && Boolean(task.branch && task.workspace) && !task.archived
    && !task.branch_archive?.archived && !task.branch_info?.archived;
  const reclaimAccepted = task.status === 'completed' && accepted && Boolean(task.branch)
    && !task.archived && !task.branch_archive?.archived && !task.branch_info?.archived;
  if (ended && !historical && !reclaimAccepted && !recovery) return null;
  const panel = root || el('div', undefined, 'iteration-controls');
  panel.replaceChildren();
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
        ? '合并预约尚未结算；验收不能绕过在途合并。' : null;
      const acceptanceReason = reason || deliveryReason
        || ((task.children || []).some(child => !['completed', 'failed', 'cancelled'].includes(child.status)
          && !(workerKind(child) === 'child' && child.status === 'awaiting_acceptance'))
          ? '后代工作尚未完成或有独立指令未验收；先处理相关工作，已完成的派生 child 可随父 Worker 一并安全验收。' : null);
      const phase = noChangeAnswer
        ? '本轮仅回答，无新增提交 · 待验收（无需先请求合并）'
        : '本轮工作完成 · 待验收';
      const acceptanceHelp = '验收表示对该 Worker 的工作不再有异议，一并安全验收已完成的派生 child（不连带验收独立指令），同时归档并删除本分支及全部后代分支的 worktree 与本地 ref，保留 Worker、结果、消息、事件与会话等运行历史；脏工作区、未读输入、待决或未完成的改动会阻止验收。不调用 Agent，验收后如有新要求请另发指令。';
      // Keep the phase and exceptional facts visible; shared lifecycle rules live in help/docs.
      panel.append(el('p', task.task_kind === 'child'
        ? recovery
          ? `资源回收未完成 · 等待父 Worker ${workerLabel(task.parent_id, task.parent_worker_number)} 按持久记录续办验收`
          : `本轮工作完成 · 保留供父 Worker ${workerLabel(task.parent_id, task.parent_worker_number)} 追加需求，随父级验收`
        : recovery
          ? '资源回收未完成 · 已保留精确续办记录，请续办验收'
          : reclaimAccepted
            ? '历史验收尚未回收开发资源 · 可再次验收补办'
            : phase, 'hint iteration-phase'));
      if (task.task_kind !== 'child') {
        const state = acceptanceState(owner, view, scope, task.id);
        let forceButton = null;
        const offerForce = () => {
          if (forceButton || !state.forceAvailable) return;
          forceButton = button('强制验收…', () => accept(true), 'ghost', {
            help: '先预检并二次确认，仅跳过已结束 Worker 的系统通知。用户追加、暂存输入和其他安全检查不放宽；不调用 Agent。' });
          actions.append(guardedAction(forceButton, acceptanceReason));
        };
        const accept = async (force = false) => {
          if (!owns() || state.accepting || state.accepted) return;
          state.accepting = true;
          try {
            // One authoritative mutation; never follow acceptance with branch.archive.
            let result;
            try {
              let method = 'worker.accept', params = { id: task.id };
              if (force) {
                const preview = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ method: 'worker.accept_preview', params }) });
                if (!owns()) return;
                if (preview?.id !== task.id || preview.can_force !== true || !/^[0-9a-f]{64}$/.test(preview.revision)
                  || !preview.notifications?.length || !Array.isArray(preview.workers)
                  || !Array.isArray(preview.resources?.branches) || !Array.isArray(preview.resources?.worktrees)
                  || !Array.isArray(preview.warnings)) throw new Error('强制验收预检不完整；不会提交，请检查服务版本。');
                const detail = [
                  ...preview.warnings,
                  '\n将跳过的系统通知（不是用户追加要求）：',
                  ...preview.notifications.map(row => `${workerLabel(row.worker_id, row.worker_number)} · ${row.status} · ${row.signal_type} · 消息 #${row.message_id} · 来源 ${workerLabel(row.sender_id, row.sender_worker_number)}`),
                  '\n回收范围：',
                  ...preview.workers.map(row => `${workerLabel(row)} · ${row.status}`),
                  ...preview.resources.branches, ...preview.resources.worktrees,
                ].join('\n');
                if (!await confirmDialog({ title: `强制验收 Worker ${workerLabel(task)}？`,
                  message: '仅跳过下面列出的终态系统通知并验收回收。失败/取消后代不会被改成成功；原消息和跳过记录保留。',
                  detail, danger: true, cardClass: 'force-acceptance-dialog', confirmLabel: '跳过所列通知并验收回收',
                  confirmHelp: '确认本次预检的通知与回收范围；不会放弃用户输入、绕过其他安全门或调用 Agent。' }) || !owns()) return;
                method = 'worker.accept_force'; params = { id: task.id, revision: preview.revision, confirm: true };
              }
              result = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method, params }) });
            } catch (error) {
              if (owns()) {
                show(error.message, 'error');
                if (error.message.includes('unread input must be processed before acceptance')) {
                  state.forceAvailable = true; offerForce();
                }
              }
              return;
            }
            state.accepted = true;
            if (!owns()) return;
            const reclaimed = result?.id === task.id && result.status === 'completed' && result.workspace === null;
            show(reclaimed ? '验收完成，开发资源已归档回收；结果与运行历史保留。'
              : '验收请求已处理，但资源回收结果未确认；请刷新并确认服务版本，勿重复提交。', reclaimed ? 'info' : 'error');
            for (const reload of [refreshOverview, refresh]) {
              if (!owns()) break;
              try { await reload(); }
              catch (error) { if (owns()) show(`验收请求已处理，但刷新失败：${error.message}`, 'error'); }
            }
          } finally { state.accepting = false; }
        };
        actions.append(guardedAction(button(recovery ? '续办验收' : '验收', () => accept(), undefined, { help: acceptanceHelp }), acceptanceReason));
        offerForce();
      }
    }
    if (reclaimAccepted || recovery) { panel.append(actions); return panel; }
    const sync = guardedAction(button('同步父分支', async () => {
      try {
        const result = await action('worker.sync_parent', { id: task.id });
        if (result.conflict) {
          task.parent_sync_conflict = { source_commit: result.source_commit, parent_commit: result.parent_commit, reason: result.reason };
          show(`同步冲突：${result.reason || '请单独点击「Agent 解决同步冲突」'}。未启动 Agent。`, 'error');
          iterationControls(task, { refresh, events, showParentDistance, onRebuild, root: panel });
          // Detail may present action rows elsewhere; keep its slots current before refresh.
          onRebuild(panel);
        } else show(result.synced ? '已同步父分支；未调用 Agent。' : result.reason || '已与父分支同步。');
        await refresh();
      } catch (error) { show(error.message, 'error'); }
    }, 'ghost', { help: '只在当前 Worker 分支安全吸收父分支提交；无冲突由程序完成，冲突只显示诊断，不调用 Agent，不推进父分支。' }), reason);
    sync.classList.add('iteration-sync-control'); actions.append(sync);
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
