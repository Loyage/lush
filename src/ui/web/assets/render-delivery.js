import { badge, button, el } from './dom.js';
import { workerKind } from './worker-kind.js';
import { action } from './api.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { show } from './messages.js';
import { detail } from './navigate.js';
import { isHistoricalDelivery } from './format.js';
import { workerLabel } from './worker-label.js';

const short = hash => String(hash || '').slice(0, 12);
/** 「已合并 · 待归档」承诺的是一次还能按的归档：分支记录已归档、或 Task 已经没有分支（回收工作区与分支、
 *  旧版落地即归档都会把 tasks.branch 清成 null）时，已经没有东西可归档，标签必须跟着真实状态落地。
 *  两个入口的数据形状不同——Task 详情是 inspect 的 branch_archive，Task 图是 branch_info，所以两个都看。 */
function archiveBadge(task) {
  const archived = task.branch_info?.archived === true || task.branch_archive?.archived === true;
  return Boolean(task.branch) && !archived
    ? { label: '已合并 · 待归档', className: 'b-awaiting' }
    : { label: '已合并 · 已归档', className: 'b-completed' };
}

/** Shared new-order delivery controls: the detail page and branch graph use exactly the same authorization path. */
export function deliveryControls(task, { refresh = () => {} } = {}) {
  if (!['order','child'].includes(workerKind(task)) || isHistoricalDelivery(task)) return null;
  const panel = el('div', undefined, 'delivery-controls');
  const reservation = task.reservation;
  if (task.task_kind === 'child' || !reservation || reservation.version === 2) {
    const controls = el('div', undefined, 'actions delivery-actions');
    const state = reservation?.version === 2 ? reservation.status : null;
    if (state) {
      // integrated 的说法由分支现状决定，其余状态照旧；不把「还在不在」混进文案表里。
      const merged = state === 'integrated' ? archiveBadge(task) : null;
      const label = merged ? merged.label : { pending: '等待合并条件', requested: '冻结 · 等待父队列',
        executing: '自动合并中 · 占用父执行位', resolving: reservation.queue_protocol === 1
          ? '源侧修复中 · 保留父执行位' : '历史源侧解分歧 · 原 Worker 已恢复工作',
        suspended: '交付已挂起 · 父执行位已释放', blocked: '交付阻塞 · 保留父侧现场' }[state] || state;
      panel.append(badge(label, merged ? merged.className : 'b-awaiting'));
    }
    if (state === 'pending' && reservation.auto_merge !== true)
      panel.append(el('p', '本轮单次合并意图仍有效；关闭自动合并不会撤销，条件满足后仍会合并。', 'hint single-merge-intent'));
    const waitReason = (!state || state === 'pending') && task.merge_readiness?.reason;
    if (waitReason) panel.append(el('p', waitReason, 'hint'));
    if (reservation?.blocked_reason && reservation.blocked_reason !== waitReason)
      panel.append(el('p', `上次检查未满足：${reservation.blocked_reason}`, 'hint'));
    if (task.integration_error) panel.append(el('p', task.integration_error, 'hint'));
    if (state === 'requested') controls.append(button('复查合并队列', async () => {
      await action('worker.reserve', { id: task.id, kind: 'merge' }); await refresh();
    }, 'ghost', { agent: true, help: agentHelp('重新检查固定的合并请求；若上次失败，受检重试，绝不重复提交已落地的 Squash；分歧时唤醒原 Agent。') }));
    const active = !['completed','failed','cancelled','awaiting_acceptance'].includes(task.status);
    if (reservation?.queue_protocol === 1 && ['suspended','blocked'].includes(state) && task.status === 'waiting') {
      controls.append(button(state === 'suspended' ? '恢复交付' : '受检复查落地', async () => {
        await action('worker.reserve', { id: task.id, kind: 'merge' }); await refresh();
      }, 'ghost', { agent: true, help: agentHelp(state === 'suspended'
        ? '重新核验源安全点并排队，创建新交付与尝试、固定当前父基线；不复用旧修复回复，分歧时唤醒源 Agent。'
        : '仅凭精确提交核对落地；未知父侧现场继续阻塞，不重放 Git 写入。确认父分支干净且未写入后才能重排，分歧时可能调用源 Agent。') }));
    }
    const canOffer = !state || state === 'pending' || (state === 'integrated' && active);
    if (canOffer && active && task.merge_readiness?.ready === true) {
      controls.append(button('合并', async () => {
        const confirmed = await confirmDialog({ title: `合并 Worker ${workerLabel(task)}？`,
          message: '复核本轮交付与 Git 条件后冻结源 Worker 的普通开发，由父 Worker 自有队列的 runtime 按入队顺序串行处理（代码依赖优先），向父分支写入一条 Squash 提交。不创建 merge Worker、不改变父子关系，也不额外调用父 Agent；包括 main 在内无需再次人工批准。取得父执行位后才固定父基线；分歧时自动唤醒原 Worker 在源侧修复并保留该执行位。挂起释放执行位，恢复重新排队并固定新基线。条件不满足时保留本次请求意图并显示原因；不会改变跨轮保留的自动合并设置。成功后进入待验收并保留源分支与 worktree；验收与归档分开。',
          confirmLabel: '合并', agent: true,
          confirmHelp: agentHelp('请求合并本轮成果；存在分歧时唤醒原 Worker 的 Agent 处理。') });
        if (!confirmed) return;
        const booked = await action('worker.reserve', { id: task.id, kind: 'merge' });
        show(`Worker ${workerLabel(task)} ${booked.reservation?.status === 'requested' ? '已发起合并请求' : '已提交合并意图，请查看交付状态'}`);
        await refresh();
      }, 'ghost', { agent: true, help: agentHelp('尝试合并本轮成果；仍须复核 Git 与交付条件，不满足时保留请求意图并显示原因，分歧会唤醒原 Agent。') }));
    }

    const protectedAutomaticIntent = reservation?.auto_merge === true && task.auto_merge?.enabled === true;
    if (state === 'resolving' && !task.auto_merge?.locked && !protectedAutomaticIntent
      && ['failed','cancelled'].includes(task.status)) controls.append(button('放弃解分歧请求', async () => {
      await action('worker.unreserve', { id: task.id }); show('已撤销失败的解分歧请求；分支与 worktree 保留'); await refresh();
    }, 'ghost', { help: '只解除自动合并请求；保留失败 Worker 的分支、提交和工作区供检查。' }));
    if (controls.children.length) panel.append(controls);
    return panel;
  }
  // 以下是历史 version 1 的固定提交审批路径，不套用父自有自动 Squash 队列。
  const readyToRequestMerge = task.status === 'waiting' && task.integration === 'pending'
    && Boolean(task.head_commit && task.base_commit && task.head_commit !== task.base_commit)
    && (task.has_result === true || task.result != null);
  const actions = el('div', undefined, 'actions delivery-actions');
  const update = async (method, params, message) => {
    await action(method, params);
    show(message);
    await refresh();
  };

  if (!reservation && !['completed', 'failed', 'cancelled'].includes(task.status)) {
    actions.append(button(readyToRequestMerge ? '请求合并' : '预约合并请求', async () => {
      const confirmed = await confirmDialog({
        title: readyToRequestMerge ? `为指令 ${workerLabel(task)} 发起合并请求？` : `为指令 ${workerLabel(task)} 预约合并请求？`,
        message: readyToRequestMerge
          ? '将检查工作区、子 Worker 及 Git 快进条件；满足时固定源提交与父分支基线，结束原 Worker 并发出合并请求。不会自动推进父分支，main/owner 仍需你批准固定提交；条件不满足时会保留请求意图并显示阻塞原因。'
          : '工作区干净、提交可快进且子 Worker 收敛后，将固定源提交与父分支基线、发出合并请求并结束原 Worker；不会自动推进父分支，main/owner 仍需你批准固定提交。',
        confirmLabel: readyToRequestMerge ? '发起请求' : '预约请求',
        confirmHelp: readyToRequestMerge
          ? '只发起固定提交的合并请求；不批准合并，条件不满足时保留意图等待复查。'
          : '这是预约，不是合并批准；条件满足后源指令可能立即终结，但父分支保持不变。',
      });
      if (confirmed) await update('worker.reserve', { id: task.id, kind: 'merge' },
        readyToRequestMerge ? `已提交指令 ${workerLabel(task)} 的合并请求意图（请查看请求状态）` : `已预约指令 ${workerLabel(task)} 的合并请求`);
    }, 'ghost', { help: readyToRequestMerge
      ? '检查交付条件并尝试发出固定提交的合并请求；条件不满足会显示原因，不会自动合入父分支。'
      : '条件满足时冻结源提交与父分支基线并发送一次请求；不会自动合并。' }));
  } else if (reservation) {
    const state = {
      pending: readyToRequestMerge ? '合并请求待就绪' : '已预约合并 · 等待条件',
      requested: '合并请求已发送 · 父分支未推进', integrated: '已确认合入父分支',
    }[reservation.status] || '预约状态需检查';
    panel.append(badge(state, reservation.status === 'failed' ? 'b-failed' : 'b-awaiting'));
    if (reservation.blocked_reason) panel.append(el('span', reservation.status === 'pending'
      ? `上次检查未满足：${reservation.blocked_reason}`
      : `请求状态：${reservation.blocked_reason}`, 'hint delivery-reason'));
    if (reservation.status === 'pending') {
      const ended = ['completed','failed','cancelled'].includes(task.status);
      // 终态指令的分歧预约仍可派独立解分歧子任务；完成后由 runtime 收尾，不需要再唤醒原 Task。
      const terminalDivergence = ended && reservation.kind === 'merge' && reservation.blocked_code === 'diverged';
      if (ended && !terminalDivergence) panel.append(el('span', 'Worker 已终结，不能直接复查预约；先检查失败现场，再在 Worker 详情中决定是否可重试。', 'hint delivery-reason'));
      if (!ended) actions.append(button(readyToRequestMerge ? '复查合并请求' : '复查预约', async () => {
        await update('worker.reserve', { id: task.id, kind: 'merge' }, `已复查指令 ${workerLabel(task)} 的预约`);
      }, 'ghost', { help: '重查已有合并预约的静息状态、工作区与 Git 快进条件；不会直接推进父分支。' }));
      if (reservation.kind === 'merge' && reservation.blocked_code === 'diverged') actions.append(button('派子 Worker 解决分歧', async () => {
        const confirmed = await confirmDialog({
          title: `让指令 ${workerLabel(task)} 在源侧解决父子分歧？`,
          message: terminalDivergence
            ? '将从源指令的固定提交建立独立 Agent 子 Worker，吸收此刻父分支的固定提交并测试；不会直接推进父分支。完成后由 runtime 快进推进指令分支并重新发出固定提交的合并请求，main/owner 仍需你批准。'
            : '将从源指令的固定提交建立独立 Agent 子 Worker，吸收此刻父分支的固定提交并测试；不会直接推进指令或父分支。子 Worker 完成后仍须指令 Agent 确认固定提交，main/owner 仍需你批准合并请求。',
          confirmLabel: '派解分歧子 Worker', agent: true,
          confirmHelp: agentHelp('启动独立的源侧解分歧子 Agent；不会自动合并到源指令或 main。'),
        });
        if (!confirmed) return;
        const result = await action('worker.resolve_divergence', { id: task.id });
        show(result.status === 'needs_review' ? result.reason
          : result.status === 'existing' ? `解分歧子 Worker ${workerLabel(result.task)} 已在处理；不会重复派发。`
            : `已派解分歧子 Worker ${workerLabel(result.task)}；不会自动推进父分支。`);
        await refresh();
      }, 'ghost', { agent: true, help: agentHelp(terminalDivergence
        ? '固定源与父分支提交后启动独立子 Agent 处理分歧；完成后由 runtime 推进指令分支并重新发合并请求。'
        : '固定源与父分支提交后启动独立子 Agent 处理分歧；完成后仍需直接父指令 Agent 确认集成。') }));
      actions.append(button(reservation.kind === 'merge' && readyToRequestMerge ? '撤销合并请求意图' : '撤销预约', async () => {
        await update('worker.unreserve', { id: task.id }, `已撤销指令 ${workerLabel(task)} 的预约`);
      }, 'ghost', { help: '只撤销尚未开始的预约；不会取消正在运行的 Agent，也不会删除提交。' }));
    }
    if (reservation.resolution_child_id) actions.append(button(`查看解分歧 ${workerLabel(reservation.resolution_child_id)}`,
      () => detail(reservation.resolution_child_id), 'link'));
    if (reservation.kind === 'merge' && reservation.status === 'requested') {
      panel.append(el('span', `源 ${reservation.commit} · 父基线 ${reservation.baseline}`, 'mono delivery-commits'));
      if (['main', 'owner'].includes(task.parent_task_kind)) actions.append(button('批准固定提交合入父分支', async () => {
        const confirmed = await confirmDialog({
          title: `批准指令 ${workerLabel(task)} 合入 ${task.target_branch}？`,
          message: '你正在批准这一份固定提交及父分支基线，不是批准分支未来的变化；源分支或父分支漂移、工作区脏或无法快进都会拒绝。',
          detail: `源提交：${reservation.commit}\n父分支基线：${reservation.baseline}\n目标分支：${task.target_branch}`,
          confirmLabel: `批准 ${short(reservation.commit)}`,
          confirmHelp: '仅当固定源提交与父基线仍匹配、工作区干净且可以快进时，才会推进目标分支。',
        });
        if (confirmed) await update('worker.approve_merge', { id: task.id, commit: reservation.commit,
          baseline: reservation.baseline }, `已将固定提交 ${short(reservation.commit)} 合入 ${task.target_branch}`);
      }, 'ghost', { help: '先检查固定源提交与父分支基线；批准后仅在无漂移、干净且可快进时移动父分支。' }));
      else panel.append(el('span', '等待直接父 Agent 确认集成；用户不能替它推进父分支。', 'hint'));
      // 只读重查：请求发出后 Git 会变，这一条不会改写父分支，只把当前事实写成诊断。
      actions.append(button('复查请求', () => update('worker.reserve', { id: task.id, kind: 'merge' },
        `已按当前 Git 事实重查指令 ${workerLabel(task)} 的合并请求`), 'ghost',
      { help: '只读重查这条请求与当前 Git 事实：仍可快进就清掉旧诊断，已被包含就提示幂等关闭，失效则说明原因；不会推进父分支。' }));
      // 请求已经把父分支基线锁住：撤销是唯一的退路，所以不隐藏；分支与提交都不删。
      actions.append(button('撤销请求', async () => {
        const confirmed = await confirmDialog({
          title: `撤销指令 ${workerLabel(task)} 的合并请求？`,
          message: '撤销只是不再请求把这次固定提交合入父分支：父分支随即解除交付锁。Worker、分支与提交都保留，但这次交付不会自动合入。',
          detail: `源提交：${reservation.commit}\n父分支基线：${reservation.baseline}`,
          confirmLabel: '撤销请求', danger: true,
          confirmHelp: '撤销未集成的请求并解除父分支的交付锁；不会删除分支或提交，也不会推进父分支。',
        });
        if (confirmed) await update('worker.unreserve', { id: task.id }, `已撤销指令 ${workerLabel(task)} 的合并请求（未集成，分支与提交保留）`);
      }, 'ghost', { help: '撤销尚未集成的请求：解除父分支的交付锁，分支与提交保留，但不会合入父分支。' }));
    }
  }
  if (actions.children.length) panel.append(actions);
  return panel;
}
