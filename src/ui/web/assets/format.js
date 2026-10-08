// 标签映射与纯格式化（无 DOM、无共享状态）：谁都能 import，自己不 import 任何人。

export const STATUS = {
  queued: { label: '排队', icon: '○' }, running: { label: '运行中', icon: '●' },
  waiting: { label: '等子 Worker', icon: '◐' }, awaiting: { label: '等你决定', icon: '◔' },
  paused: { label: '已暂停', icon: '⏸' },
  awaiting_acceptance: { label: '待验收', icon: '◈' },
  completed: { label: '已完成', icon: '✓' }, failed: { label: '失败', icon: '✗' }, cancelled: { label: '已取消', icon: '⊘' },
};
export const INTEGRATION = { pending: '待合并', review: '待复查', merging: '合并中', merged: '已合并', conflict: '冲突待处理', superseded: '已作废' };
/** 无分支的历史检出只标为 detached，不再依赖已下线的专用角色。 */
export const worktreeLabel = task => (task?.task_kind === 'management' ? '管理工作目录' : !task?.branch && task?.workspace ? 'detached worktree' : 'worktree');
/** 已下线交付记录仅供回看，不提供重试、预约或迭代操作。 */
export const isHistoricalDelivery = task => task.role === 'showcase' || task.task_kind === 'showcase'
  || Boolean(task.reservation?.kind && task.reservation.kind !== 'merge');
export const ROLE = { planner: '规划', scheduler: '调度', worker: '执行', coordinator: '协调', research: '调研', verifier: '检验', merger: '解冲突', explainer: '执行介绍', butler: '管家', manager: '管理' };
export const EVENTS = {
  created: '创建 Worker', 'invocation.started': '开始调用', 'invocation.completed': '调用完成',
  'invocation.connection': '绑定账号连接', 'invocation.inputs_delivered': '输入已交给 Agent',
  message: '收到消息', 'notice.opened': '向你提问', 'notice.answered': '已答复', retry: '重试',
  'notice.snapshot_ready': '选择快照已保存', 'notice.snapshot_unavailable': '选择快照不可用',
  'notice.reselected': '从选择点继续', 'notice.choice_route_created': '已创建重选路线',
  'task.signal': 'Worker 信号', 'child.completed': '子 Worker 完成', 'child.integrated': '子 Worker 已集成',
  'task.merge_requested': '请求合并', 'task.merge_approved': '批准合并', 'task.merge_integrated': '已合入父分支',
  'task.reserved': '已预约合并', 'task.unreserved': '已取消合并预约', 'task.request_withdrawn': '已撤回合并请求',
  'task.reservation_blocked': '合并预约受阻', 'task.reservation_rechecked': '已复查合并预约',
  'hook.attached': '挂载 Hook', 'hook.updated': '调整 Hook', 'hook.removed': '移除 Hook',
  'hook.triggered': 'Hook 节点触发', 'hook.started': '开始执行 Hook', 'hook.succeeded': 'Hook 执行成功',
  'hook.failed': 'Hook 执行失败', 'hook.unknown': 'Hook 结果待核验',
  'hook.completion_defaults_configured': '调整新指令结束后自动处理默认值',
  'hook.daemon_configured': '调整 daemon 自动选择 Hook', 'hook.daemon_failed': 'daemon 自动选择失败',
  'hook.enabled': '调整 Hook 启用状态', 'hook.execution_started': '开始执行 Hook',
  'hook.action_completed': 'Hook 动作已执行', 'hook.worker_created': 'Hook 已创建 Worker',
  'hook.execution_succeeded': 'Hook 执行成功', 'hook.execution_failed': 'Hook 执行失败',
  'hook.execution_unknown': 'Hook 结果待核验', 'hook.execution_skipped': 'Hook 动作已跳过',
  'hook.scheduled_submitted': '定时 Hook 已提交待执行动作', 'hook.schedule_missed': '定时 Hook 已错过提交时间',
  'worker.merge_received': '此 Worker 已收到合并', 'hook.command_example_installed': '初始化停用的命令 Hook 示例',
  'hook.command_submitted': '命令 Hook 已提交待安全执行',
  'hook.signal_saved': '保存时间信号', 'hook.signal_removed': '删除时间信号',
  'hook.signal_emitted': '时间信号已发出', 'hook.signal_missed': '时间信号已错过发出时刻',
  'management.created': '创建管理型 Worker', 'management.binding_updated': '调整管理信号绑定',
  'management.signal_skipped': '管理信号已跳过', 'management.signal_submitted': '管理信号已提交待执行',
  'management.invocation_started': '管理 Agent 开始调用', 'management.action_submitted': '管理操作已提交待安全点',
  'management.action_skipped': '管理操作已跳过', 'management.action_completed': '管理操作已执行',
  'management.settled': '管理信号处理已收口', 'management.failed': '管理信号处理失败', 'management.unknown': '管理结果未知，待核验',
  'hooks.template_saved': '保存 Hook 模板', 'hooks.template_removed': '删除 Hook 模板',
  'task.auto_merge_changed': '调整自动合并 Hook', 'task.merge_parent_restored': '已恢复原父 Worker',
  'task.completion_changed': '调整自动处理级别', 'completion.reminder': '提示下一人工环节',
  'completion.execution_started': '开始执行自动处理', 'completion.execution_superseded': '过期自动动作已作废',
  'completion.execution_succeeded': '自动处理执行成功', 'completion.execution_failed': '自动处理执行失败',
  'completion.execution_unknown': '自动处理结果待核验',
  'task.delivered': '已交付成果', 'task.idle': '本轮工作结束', 'task.resolved': '已标记问题解决',
  'task.delivery_resumed': '恢复交付流程', 'task.iteration_started': '开始新一轮开发',
  'task.forked': '已从父分支创建工作区', 'task.fork_failed': '创建工作区失败',
  'task.archived': '已归档 Worker', 'task.input_rule_frozen': '已固定输入规则', 'task.input_routed': '已分发追加输入',
  'task.analyze_requested': '请求分支分析',
  'task.divergence_resolution_requested': '请求解决合并分歧', 'task.divergence_resolution_started': '开始解决合并分歧',
  'task.divergence_resolved': '合并分歧已解决', 'task.divergence_integrated': '分歧修复已合入',
  'task.divergence_resolution_failed': '解决合并分歧失败',
  'child.integration_requested': '请求合入子 Worker', 'child.integrated_via_resolution': '子 Worker 已通过分歧修复合入',
  'task.accepted': '验收完成', 'task.reopened': '恢复待验收',
  'task.parent_synced': '已同步父分支', 'task.parent_sync_conflict': '父同步冲突',
  'task.sync_resolution_requested': '请求解决父同步冲突', 'task.sync_resolution_settled': '父同步冲突已解决',
  'progress.plan': '更新 Worker 计划', 'progress.completed': '完成计划步骤', 'progress.archived': '保留过往 Worker 计划',
  'workspace.created': '创建 worktree', 'workspace.removed': '回收 worktree', 'branch.removed': '回收分支',
  'verify.requested': '请求检验', 'baseline.created': '创建对照基线', 'baseline.removed': '回收对照基线',
  'merge.approved': '批准合并', merged: '已合并', 'merge.included': '随其它变更一并落地', 'merge.failed': '合并失败',
  'merge.conflict': '合并冲突', 'merge.resolved': '冲突已解决', 'merge.conflict.abandoned': '放弃解冲突',
  'resolution.superseded': '解冲突作废', 'resolution.merged': '冲突修复已合入', 'resolution.finalize_failed': '冲突修复收尾失败',
  'merge.enqueued': '合并请求已入队', 'merge.attempt_started': '开始尝试合并', 'merge.baseline_fixed': '已固定父分支基线',
  'merge.attempt_suspended': '已挂起合并尝试', 'merge.attempt_resumed': '恢复合并尝试',
  'merge.divergence_returned': '合并分歧已交回源 Worker', 'merge.divergence_ready': '分歧修复已就绪',
  'merge.tree_already_present': '目标分支已包含相同代码', 'merge.landing_prepared': '合并落地准备就绪',
  'merge.landing_blocked': '合并落地受阻', 'merge.queue_failed': '合并队列执行失败',
  'merge.queue_idle': '合并队列已静息', 'merge.queue_reopened': '合并队列已重新开启',
  'merge.unwritten_attempt_released': '已释放未落盘的合并尝试', 'merge.repair_interrupted': '分歧修复被中断',
  'merge.legacy_queue_recovered': '已恢复历史合并队列', 'merge.legacy_landing_identified': '已识别历史合并提交',
  'merge.diverged': '分支存在合并分歧',
  'merge.orchestrate.started': '开始合并编排', 'merge.orchestrate.paused': '合并编排已暂停',
  'merge.orchestrate.cancelled': '合并编排已取消', 'merge.orchestrate.completed': '合并编排已完成', 'merge.orchestrate.failed': '合并编排失败',
  'merge.run.started': '开始批量合并', 'merge.run.paused': '批量合并已暂停',
  'merge.run.cancelled': '批量合并已取消', 'merge.run.completed': '批量合并已完成', 'merge.run.failed': '批量合并失败',
  'task.interrupted': '接受中断请求', 'task.paused': '已安全暂停', 'task.resumed': '接受继续请求', 'task.configured': '调整运行设置',
  'invocation.preempted': '安全中断', 'invocation.blocked': '未启动：缺少模型来源', 'task.interrupt_timeout': '中断超时强制终止',
  'invocation.recovered': '已恢复调用记录', 'invocation.target_branch_moved': '目标分支被越过交付直接推进',
  'invocation.branch_observed': '调用期分支变动观测',
  'preempt.requested': '请求安全中断调用',
  'notice.read': '提醒已读', 'dep.added': '添加依赖关系', 'explanation.requested': '请求执行步骤介绍',
  'input.draft': '输入已关联暂存记录', 'input.anchor': '已固定输入代码基线', 'input.route': '输入已按前缀分派',
  'main.bound': '已绑定主分支', 'branch.bound': '已绑定分支', 'branch.merged': '分支已合并',
  'branch.sync.requested': '请求同步分支', 'branch.caught_up': '分支已追上父分支',
  'branch.archived': '分支已归档', 'branch.archive': '执行分支归档', 'branch.summary': '更新分支摘要',
  'analysis.checkout': '已检出分析代码现场', 'analysis.fork_failed': '创建分析代码现场失败',
  'plan.proposed': '提交拆解计划', 'plan.approved': '拆解计划已批准', 'plan.rejected': '拆解计划已驳回',
  'plan.materialized': '已从计划创建 Worker', 'plan.compiled': '拆解计划已生成 Worker', 'plan.compile_failed': '拆解计划生成 Worker 失败',
  'spec.added': '添加规划条目', 'spec.dropped': '放弃规划条目',
  'candidate.created': '创建评审候选', 'candidate.verify_requested': '请求检验评审候选', 'candidate.verified': '评审候选检验已结束',
  'candidate.verification_ignored': '已忽略过期候选检验', 'candidate.accept_failed': '评审候选验收失败',
  'candidate.integrated': '评审候选已合入', 'candidate.changes_requested': '要求修改评审候选',
  'intent.integration': '更新输入交付状态', 'intent.integration_sync': '同步输入交付分支', 'intent.integration_failed': '输入交付失败',
  'sleep.started': '开启托管模式', 'sleep.stopped': '关闭托管模式', 'sleep.resumed': '恢复托管模式', 'sleep.paused': '托管模式已暂停',
  'sleep.requested': '收到托管执行请求', 'sleep.choice.started': '管家开始选择动作',
  'sleep.choice.finished': '管家选择已结束', 'sleep.choice.executing': '管家开始执行所选动作',
  completed: '完成', failed: '失败', cancelled: '取消',
};
/** 中文名是阅读投影，保留原始 type；未知事件明确标注，不猜测含义。 */
export function eventLabel(event) {
  if (event.type === 'invocation.target_branch_moved' && event.data?.reason === 'unattributed_ref_movement') return '目标分支存在未归因的移动';
  if (event.type === 'notice.opened' && event.data?.kind === 'info') return '提醒';
  if (event.type === 'notice.answered' && event.data?.answer_source === 'lush') return 'Lush 自动选择';
  if (event.type === 'notice.answered' && event.data?.answer_source === 'user') return '用户答复';
  return Object.hasOwn(EVENTS, event.type) ? EVENTS[event.type] : '未识别事件';
}
export const HOT = new Set(['running', 'awaiting', 'awaiting_acceptance', 'waiting', 'queued', 'paused']);
export const TERMINAL_STATUS = new Set(['completed', 'failed', 'cancelled']);
export const short = value => (typeof value === 'string' ? value.slice(0, 7) : '');
/** 用户编号只是标签；不从 Input 或父子关系推算，也不改变内部整数身份。 */
export function workerNumber(task) {
  return typeof task?.worker_number === 'string' && /^W[1-9]\d*(?:-[1-9]\d*)*$/.test(task.worker_number)
    ? task.worker_number : `#${task?.id ?? '?'}`;
}
/** 只有已经发射的原始 Input 使用 O 编号，Draft 仍是独立暂存身份。 */
export const inputNumber = id => `O${id ?? '?'}`;
/** 中断意图与实际状态分开：颜色/筛选仍使用 status，不把请求冒充为已暂停。 */
export function interruptReason(task) {
  if (TERMINAL_STATUS.has(task.status)) return null;
  if (task.interrupt_state === 'requested') return '中断请求已接受，等当前调用到安全点后暂停；现在点「继续」可撤销尚未触发的请求，已触发则排队恢复。';
  if (task.interrupt_state === 'resuming') return '继续请求已接受，等旧调用释放后调度；无需等待即可再次点「继续」。';
  return null;
}
export const statusOf = task => !TERMINAL_STATUS.has(task.status) && task.interrupt_state === 'requested'
  ? { label: '中断请求中', icon: STATUS[task.status]?.icon || '◐' }
  : !TERMINAL_STATUS.has(task.status) && task.interrupt_state === 'resuming'
    ? { label: '继续排队中', icon: '○' }
    : task.status === 'paused' && (task.agent_wakes ?? 0) === 0
      ? { label: '待开始', icon: '⏸' }
      : task.status === 'awaiting_acceptance' && task.task_kind === 'child'
        ? { label: '待父确认', icon: '◈' }
        : (STATUS[task.status] || { label: task.status, icon: '·' });
export function relative(iso) {
  const at = Date.parse(iso); if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 5) return '刚刚'; if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
export function duration(from, to) {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}
/** 任务墙钟耗时里的「工作用时」：各轮调用的时长之和（未结束的 run 算到 now）。 */
export function runWorkMs(runs, now = Date.now()) {
  let total = 0;
  for (const run of runs || []) {
    const start = Date.parse(run?.started_at);
    const end = run?.ended_at ? Date.parse(run.ended_at) : now;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) total += end - start;
  }
  return total;
}
export const absolute = iso => { const at = Date.parse(iso); return Number.isFinite(at) ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : ''; };
export const clock = iso => { const at = Date.parse(iso); return Number.isFinite(at) ? new Date(at).toTimeString().slice(0, 8) : ''; };
/** token 只让人比大小，不让人数位数：7.2k / 1.34M。 */
export const tokens = value => { const count = Number(value) || 0; return count >= 1e6 ? `${(count / 1e6).toFixed(2)}M` : count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count); };
/** 花费可能小到 0.0006 美元，三位小数会全变成 $0.000，看不出差别。 */
export const money = value => { const amount = Number(value) || 0; return `$${amount > 0 && amount < 0.01 ? amount.toFixed(5) : amount.toFixed(3)}`; };
export const depsOf = task => task.deps || [];
export const waitingDeps = task => depsOf(task).filter(dep => !TERMINAL_STATUS.has(dep.status));
/**
 * 还没落地的解冲突任务：进行中的不许重开一轮，已经完成但没落地的可以被「重试合并」取代。
 * merged（已交付）与 superseded（已被下一轮取代）都不再算数。
 */
export function resolverOf(task) {
  return (task.resolutions || [])
    .filter(row => row.integration !== 'merged' && row.integration !== 'superseded')
    .sort((a, b) => b.id - a.id)[0] || null;
}
/** 未解决的冲突会冻结同一目标分支上的合并：解冲突的产物要靠 --ff-only 原样落地，main 不能被推走。
 *  判定与运行时 approveMerge / 批量合并的候选过滤共用 merge-select.js 的 freezeBlocker。 */
export const DEP_HELP = {
  code: '这是它的 worktree 基线：本 Worker 的分支从上游分支长出来，所以合并必须先合上游，否则会把上游的改动一起带进来。',
  order: '这只是顺序依赖：等上游结束才开跑，代码仍从当时的 HEAD 开始，因此不要求先合并上游。',
};
export const PLAN_GATE = { proposed: { label: '等你批准', className: 'b-awaiting' }, approved: { label: '已批准', className: 'b-completed' },
  rejected: { label: '已驳回', className: 'b-failed' } };
export const SPEC_STATUS = {
  pending: { label: '排队中', className: 'b-queued' },
  planned: { label: '已排期', className: 'b-completed' },
  dropped: { label: '已丢弃', className: 'b-failed' },
};
export const specStatus = spec => SPEC_STATUS[spec.status] || { label: spec.status, className: 'b-neutral' };
/** 一句话标题的上限：与后端 graph.js 的 TITLE_LIMIT 同口径，超出截断加省略号。 */
export const GOAL_TITLE_LIMIT = 60;
/** 一句话摘要：goal 第一行、压缩空白、按字数截断。没有内容时返回 null，不把空串当标题。
 *  前端不能 import 后端的 src/core/project/graph.js，这里按同一口径重写。 */
export function summarizeGoal(goal) {
  const line = String(goal ?? '').split('\n')[0].replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > GOAL_TITLE_LIMIT ? `${line.slice(0, GOAL_TITLE_LIMIT)}…` : line;
}
/** 详情页 hero 的短标题：goal 的摘要；goal 为空时退回 `任务 #id`，标题区永不留空。 */
export const taskTitle = task => summarizeGoal(task?.goal) ?? `Worker ${workerNumber(task)}`;
/** 一条 spec 的完整可读文本，放进 title，让人 hover 就能看全文与丢弃原因。 */
export function specTitle(spec) {
  const info = specStatus(spec);
  return [`#${spec.id} ${spec.goal}`, `状态：${info.label}`, spec.note ? `备注：${spec.note}` : null].filter(Boolean).join('\n');
}
export const MERGE_STATUS = { merged: '✓ 已合并', conflict: '⚠ 冲突', failed: '✗ 失败', skipped: '⊘ 跳过' };
export const CHANGE = { '??': '未跟踪', M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', UU: '冲突', AA: '冲突', T: '类型变更' };
export const edgeLabel = edge => `${workerNumber(edge)}（${edge.kind === 'code' ? '代码基线' : '仅顺序'} · ${statusOf(edge).label}）`;
export const STEP = { input: '输入', text: '回答', thinking: '思考', tool: '工具调用', result: '工具输出', meta: '运行时' };
export const MD_STEP = new Set(['text', 'result', 'thinking']);   // 这几类步骤正文按 markdown 渲染
/** 一步占多少上下文（读 src/core/transcript.js 给的 tokens 字段，前端不再自己算差值）：
 *  精确（exact/turn）＝ pi 记录的这一次模型请求的合计（输入 + 缓存读 + 缓存写 + 输出）；
 *  估算（estimated/batch）＝ 相邻两次请求的上下文差值，即这一批步骤（工具输出等）推入上下文的量。
 *  返回 chip 的文案与悬停口径；没有可用的 tokens 时返回 null（调用方据此不渲染 chip）。 */
export function tokensView(t) {
  if (!t) return null;
  if (t.estimated) return { text: `+${tokens(t.context_added)}`,
    title: '估算：从上一次模型请求到下一次之间，上下文新增的 token（含本批工具输出等），由两次请求的上下文差值推算，不是 pi 记录的数字。' };
  if (t.exact) return { text: `上下文 ${tokens(t.total)}`,
    title: '这一次模型请求真的送进模型并收回来的 token：输入 + 缓存读 + 缓存写 + 输出，来自 pi 会话记录，不是估算；同一次回复的多个步骤共享这个合计。' };
  return null;
}
/** 「最近一次执行」＝执行过程最后一条可显示步骤：相对时间（会随轮询自己走）+ 内容单行预览，全文放 title。 */
export function lastView(last) {
  if (!last) return { value: '—', title: '还没有会话记录：这个 Worker 从未被唤醒，或会话文件已被清理。' };
  const when = last.at ? relative(last.at) : '时间未知';
  const kindLabel = last.kind ? STEP[last.kind] || last.kind : '';
  const title = last.title || '';
  // 「回答」这类步骤的 kind 标签与 title 相同，不重复写两遍。
  const what = title && title !== kindLabel ? [kindLabel, title].filter(Boolean).join(' ') : (title || kindLabel);
  const body = String(last.body || '').replace(/\s+/g, ' ').trim();
  const preview = body.length > 80 ? `${body.slice(0, 79)}…` : body;
  const value = [when, what && body && body !== what ? `${what}：${preview}` : what || preview].filter(Boolean).join(' · ');
  const full = [last.at ? `${when}（${absolute(last.at)}）` : when, what, body].filter(Boolean).join(' · ');
  return { value, title: full };
}
