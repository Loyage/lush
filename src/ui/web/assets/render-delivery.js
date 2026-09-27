import { badge, button, el } from './dom.js';
import { action } from './api.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { show } from './messages.js';
import { detail } from './navigate.js';

const short = hash => String(hash || '').slice(0, 12);

/** Shared new-say delivery controls: the detail page and branch graph use exactly the same authorization path. */
export function deliveryControls(task, { refresh = () => {} } = {}) {
  if (!['say','child'].includes(task.task_kind)) return null;
  const panel = el('div', undefined, 'delivery-controls');
  const reservation = task.reservation;
  if (task.task_kind === 'child' || !reservation || reservation.version === 2) {
    const controls = el('div', undefined, 'actions delivery-actions');
    const state = reservation?.version === 2 ? reservation.status : null;
    if (state) panel.append(badge({ pending: '已预约合并 · 等待静息', requested: '冻结 · 自动合并中',
      resolving: '分歧处理中 · 原 Task 已恢复工作', integrated: '已合并 · 待归档' }[state] || state, 'b-awaiting'));
    if (reservation?.blocked_reason) panel.append(el('p', reservation.blocked_reason, 'hint'));
    if (task.integration_error) panel.append(el('p', task.integration_error, 'hint'));
    if (state === 'requested') controls.append(button('复查合并队列', async () => {
      await action('task.reserve', { id: task.id, kind: 'merge' }); await refresh();
    }, 'ghost', { help: '重新检查固定的合并请求；若上次失败，受检重试，绝不重复提交已落地的 Squash。' }));
    if ((!reservation || state === 'pending') && !['completed','failed','cancelled'].includes(task.status)) {
      const ready = task.status === 'waiting';
      controls.append(button(ready ? '合并到父 Task' : '预约合并', async () => {
        const confirmed = await confirmDialog({ title: `${ready ? '请求合并' : '预约合并'} Task #${task.id}？`,
          message: '静息后会冻结原 Task，由父 Task 的 merge 子任务串行处理；可合并时向父分支写入一条 Squash 提交。出现分歧时自动唤醒原 Task 处理。包括 main 在内无需再次人工批准；成功后归还原父 Task 并保留源分支与 worktree，由你决定何时归档。',
          confirmLabel: ready ? '请求合并' : '预约合并', agent: true,
          confirmHelp: agentHelp('提交自动合并意图；若存在分歧，将唤醒原 Task 的 Agent 处理。') });
        if (!confirmed) return;
        await action('task.reserve', { id: task.id, kind: 'merge' });
        show(`Task #${task.id} 已${ready ? '发起合并请求' : '预约合并'}`);
        await refresh();
      }, 'ghost', { agent: true, help: agentHelp('合并请求由 merge 子任务自动处理，发生分歧时会唤醒原 Agent。') }));
    }
    if (task.task_kind === 'say' && !reservation && !['completed','failed','cancelled'].includes(task.status))
      controls.append(button('预约展示', async () => {
        await action('task.reserve', { id: task.id, kind: 'showcase' });
        show('已预约效果展示'); await refresh();
      }, 'ghost', { agent: true, help: agentHelp('启动展示子 Agent，展示交付不自动合并。') }));
    if (state === 'resolving' && ['failed','cancelled'].includes(task.status)) controls.append(button('放弃解分歧请求', async () => {
      await action('task.unreserve', { id: task.id }); show('已撤销失败的解分歧请求；分支与 worktree 保留'); await refresh();
    }, 'ghost', { help: '只解除自动合并请求；保留失败 Task 的分支、提交和工作区供检查。' }));
    if (state === 'pending') controls.append(button('撤销预约', async () => {
      await action('task.unreserve', { id: task.id }); show('已撤销合并预约'); await refresh();
    }, 'ghost', { help: '只撤销尚未发出的合并预约；不会删除工作区或提交。' }));
    if (controls.children.length) panel.append(controls);
    return panel;
  }
  // say 在一次成功调用后仍保持 waiting；有待交付提交时，入口应是「请求合并」而非预约未来的工作。
  const readyToRequestMerge = task.status === 'waiting' && task.integration === 'pending'
    && Boolean(task.head_commit && task.base_commit && task.head_commit !== task.base_commit)
    && (task.has_result === true || task.result != null);
  // 展示交付后原 say 已终结，pending 合并预约永远等不到；只要还有未集成的提交，
  // 就允许补发一次固定提交的合并请求（含撤销请求后 reservation 为空的情况）。
  const settledShowcaseMerge = task.status === 'completed' && task.integration === 'pending'
    && Boolean(task.head_commit && task.base_commit && task.head_commit !== task.base_commit)
    && (task.has_result === true || task.result != null)
    && (!reservation || (reservation.kind === 'showcase' && reservation.status === 'completed'));
  const actions = el('div', undefined, 'actions delivery-actions');
  const update = async (method, params, message) => {
    await action(method, params);
    show(message);
    await refresh();
  };

  if (!reservation && !['completed', 'failed', 'cancelled'].includes(task.status)) {
    actions.append(button(readyToRequestMerge ? '请求合并' : '预约合并请求', async () => {
      const confirmed = await confirmDialog({
        title: readyToRequestMerge ? `为 say #${task.id} 发起合并请求？` : `为 say #${task.id} 预约合并请求？`,
        message: readyToRequestMerge
          ? '将检查工作区、子任务及 Git 快进条件；满足时固定源提交与父分支基线，结束原 Task 并发出合并请求。不会自动推进父分支，main/owner 仍需你批准固定提交；条件不满足时会保留请求意图并显示阻塞原因。'
          : '工作区干净、提交可快进且子任务收敛后，将固定源提交与父分支基线、发出合并请求并结束原 Task；不会自动推进父分支，main/owner 仍需你批准固定提交。',
        confirmLabel: readyToRequestMerge ? '发起请求' : '预约请求',
        confirmHelp: readyToRequestMerge
          ? '只发起固定提交的合并请求；不批准合并，条件不满足时保留意图等待复查。'
          : '这是预约，不是合并批准；条件满足后源 say 可能立即终结，但父分支保持不变。',
      });
      if (confirmed) await update('task.reserve', { id: task.id, kind: 'merge' },
        readyToRequestMerge ? `已提交 say #${task.id} 的合并请求意图（请查看请求状态）` : `已预约 say #${task.id} 的合并请求`);
    }, 'ghost', { help: readyToRequestMerge
      ? '检查交付条件并尝试发出固定提交的合并请求；条件不满足会显示原因，不会自动合入父分支。'
      : '条件满足时冻结源提交与父分支基线并发送一次请求；不会自动合并，不能与展示预约并存。' }));
  } else if (reservation) {
    const kind = reservation.kind === 'showcase' ? '展示' : '合并';
    const state = {
      pending: reservation.kind === 'merge' && readyToRequestMerge ? '合并请求待就绪' : `已预约${kind} · 等待条件`,
      preparing: '已预约展示 · 展示准备中',
      started: '展示中 · 原 say 尚未完成',
      requested: '合并请求已发送 · 父分支未推进', integrated: '已确认合入父分支',
      completed: '展示已交付 · 未自动合并', failed: '展示失败 · 工作区保留',
      cancelled: '展示已取消 · 工作区保留',
    }[reservation.status] || '预约状态需检查';
    panel.append(badge(state, reservation.status === 'failed' ? 'b-failed' : 'b-awaiting'));
    if (reservation.blocked_reason) panel.append(el('span', ['pending','preparing'].includes(reservation.status)
      ? `上次检查未满足：${reservation.blocked_reason}`
      : `请求状态：${reservation.blocked_reason}`, 'hint delivery-reason'));
    if (['pending','preparing'].includes(reservation.status)) {
      const ended = ['completed','failed','cancelled'].includes(task.status);
      // 终态 say 的分歧预约仍可派独立解分歧子任务；完成后由 runtime 收尾，不需要再唤醒原 Task。
      const terminalDivergence = ended && reservation.kind === 'merge' && reservation.blocked_code === 'diverged';
      if (ended && !terminalDivergence) panel.append(el('span', 'Task 已终结，不能直接复查预约；先检查失败现场，再在 Task 详情中决定是否可重试。', 'hint delivery-reason'));
      const startsAgent = reservation.kind === 'showcase';
      if (!ended) actions.append(button(reservation.kind === 'merge' && readyToRequestMerge ? '复查合并请求' : '复查预约', async () => {
        if (startsAgent) {
          const confirmed = await confirmDialog({
            title: `复查 say #${task.id} 的展示预约？`,
            message: reservation.status === 'preparing'
              ? '将重查 say 静息状态、工作区与展示准入；若已满足条件，会向已创建的展示子 Agent 发信号，让它按最终提交交付。不会自动合并。'
              : '将重查静息状态、工作区与展示准入；若已满足条件，会立即创建并启动展示子 Agent。不会自动合并。',
            confirmLabel: '复查展示', agent: true,
            confirmHelp: agentHelp(reservation.status === 'preparing'
              ? '复查展示准备与准入；满足时给已创建的展示子 Agent 发完成信号。'
              : '复查已持久化的展示预约；如果条件满足，立即启动展示 Agent。'),
          });
          if (!confirmed) return;
        }
        await update('task.reserve', { id: task.id, kind: reservation.kind }, `已复查 say #${task.id} 的预约`);
      }, 'ghost', { agent: startsAgent,
        help: startsAgent
          ? agentHelp(reservation.status === 'preparing'
            ? '重查安全准入，符合条件就向已创建的展示子 Agent 补发完成信号；不清理用户改动或推进父分支。'
            : '重查安全准入，符合条件就启动展示子 Agent；不清理用户改动或推进父分支。')
          : '重查已有合并预约的静息状态、工作区与 Git 快进条件；不会直接推进父分支。' }));
      if (reservation.kind === 'merge' && reservation.blocked_code === 'diverged') actions.append(button('派子任务解决分歧', async () => {
        const confirmed = await confirmDialog({
          title: `让 say #${task.id} 在源侧解决父子分歧？`,
          message: terminalDivergence
            ? '将从源 say 的固定提交建立独立 Agent 子任务，吸收此刻父分支的固定提交并测试；不会直接推进父分支。完成后由 runtime 快进推进 say 分支并重新发出固定提交的合并请求，main/owner 仍需你批准。'
            : '将从源 say 的固定提交建立独立 Agent 子任务，吸收此刻父分支的固定提交并测试；不会直接推进 say 或父分支。子任务完成后仍须 say Agent 确认固定提交，main/owner 仍需你批准合并请求。',
          confirmLabel: '派解分歧子任务', agent: true,
          confirmHelp: agentHelp('启动独立的源侧解分歧子 Agent；不会自动合并到源 say 或 main。'),
        });
        if (!confirmed) return;
        const result = await action('task.resolve_divergence', { id: task.id });
        show(result.status === 'needs_review' ? result.reason
          : result.status === 'existing' ? `解分歧子任务 #${result.task.id} 已在处理；不会重复派发。`
            : `已派解分歧子任务 #${result.task.id}；不会自动推进父分支。`);
        await refresh();
      }, 'ghost', { agent: true, help: agentHelp(terminalDivergence
        ? '固定源与父分支提交后启动独立子 Agent 处理分歧；完成后由 runtime 推进 say 分支并重新发合并请求。'
        : '固定源与父分支提交后启动独立子 Agent 处理分歧；完成后仍需直接父 say Agent 确认集成。') }));
      actions.append(button(reservation.kind === 'merge' && readyToRequestMerge ? '撤销合并请求意图' : '撤销预约', async () => {
        await update('task.unreserve', { id: task.id }, `已撤销 say #${task.id} 的预约`);
      }, 'ghost', { help: reservation.status === 'preparing'
        ? '撤销展示预约并取消尚未交付的准备中子 Task；不会删除分支或提交。'
        : '只撤销尚未开始的预约；不会取消正在运行的 Agent，也不会删除提交。' }));
    }
    if (reservation.resolution_child_id) actions.append(button(`查看解分歧 #${reservation.resolution_child_id}`,
      () => detail(reservation.resolution_child_id), 'link'));
    if (reservation.child_id) actions.append(button(`查看展示 #${reservation.child_id}`, () => detail(reservation.child_id), 'link'));
    if (reservation.kind === 'merge' && reservation.status === 'requested') {
      panel.append(el('span', `源 ${reservation.commit} · 父基线 ${reservation.baseline}`, 'mono delivery-commits'));
      if (['main', 'owner'].includes(task.parent_task_kind)) actions.append(button('批准固定提交合入父分支', async () => {
        const confirmed = await confirmDialog({
          title: `批准 say #${task.id} 合入 ${task.target_branch}？`,
          message: '你正在批准这一份固定提交及父分支基线，不是批准分支未来的变化；源分支或父分支漂移、工作区脏或无法快进都会拒绝。',
          detail: `源提交：${reservation.commit}\n父分支基线：${reservation.baseline}\n目标分支：${task.target_branch}`,
          confirmLabel: `批准 ${short(reservation.commit)}`,
          confirmHelp: '仅当固定源提交与父基线仍匹配、工作区干净且可以快进时，才会推进目标分支。',
        });
        if (confirmed) await update('task.approve_merge', { id: task.id, commit: reservation.commit,
          baseline: reservation.baseline }, `已将固定提交 ${short(reservation.commit)} 合入 ${task.target_branch}`);
      }, 'ghost', { help: '先检查固定源提交与父分支基线；批准后仅在无漂移、干净且可快进时移动父分支。' }));
      else panel.append(el('span', '等待直接父 Agent 确认集成；用户不能替它推进父分支。', 'hint'));
      // 只读重查：请求发出后 Git 会变，这一条不会改写父分支，只把当前事实写成诊断。
      actions.append(button('复查请求', () => update('task.reserve', { id: task.id, kind: 'merge' },
        `已按当前 Git 事实重查 say #${task.id} 的合并请求`), 'ghost',
      { help: '只读重查这条请求与当前 Git 事实：仍可快进就清掉旧诊断，已被包含就提示幂等关闭，失效则说明原因；不会推进父分支。' }));
      // 请求已经把父分支基线锁住：撤销是唯一的退路，所以不隐藏；分支与提交都不删。
      actions.append(button('撤销请求', async () => {
        const confirmed = await confirmDialog({
          title: `撤销 say #${task.id} 的合并请求？`,
          message: '撤销只是不再请求把这次固定提交合入父分支：父分支随即解除交付锁。任务、分支与提交都保留，但这次交付不会自动合入。',
          detail: `源提交：${reservation.commit}\n父分支基线：${reservation.baseline}`,
          confirmLabel: '撤销请求', danger: true,
          confirmHelp: '撤销未集成的请求并解除父分支的交付锁；不会删除分支或提交，也不会推进父分支。',
        });
        if (confirmed) await update('task.unreserve', { id: task.id }, `已撤销 say #${task.id} 的合并请求（未集成，分支与提交保留）`);
      }, 'ghost', { help: '撤销尚未集成的请求：解除父分支的交付锁，分支与提交保留，但不会合入父分支。' }));
    }
  }
  if (settledShowcaseMerge) actions.append(button('请求合并', async () => {
    const confirmed = await confirmDialog({
      title: `为已交付展示的 say #${task.id} 发起合并请求？`,
      message: '展示已交付。将重新打开源 Task、预约自动合并：静息后由父 Task 的 merge 子任务串行写入一条 Squash 提交；分歧时原 Task 会恢复工作。包括 main 在内无需再次批准。',
      confirmLabel: '发起请求',
      confirmHelp: agentHelp('启动自动合并；若存在分歧将唤醒原 Agent 处理。'),
      agent: true,
    });
    if (!confirmed) return;
    try {
      await update('task.reserve', { id: task.id, kind: 'merge' },
        `已提交 say #${task.id} 的合并请求意图（请查看请求状态）`);
    } catch (error) { show(error.message, 'error'); }
  }, 'ghost', { agent: true, help: agentHelp('展示后的 say 重新打开并自动合并；分歧会唤醒原 Agent。') }));
  if (actions.children.length) panel.append(actions);
  return panel;
}
