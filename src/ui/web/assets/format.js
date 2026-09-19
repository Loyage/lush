// 标签映射与纯格式化（无 DOM、无共享状态）：谁都能 import，自己不 import 任何人。

export const STATUS = {
  queued: { label: '排队', icon: '○' }, running: { label: '运行中', icon: '●' },
  waiting: { label: '等子任务', icon: '◐' }, awaiting: { label: '等你决定', icon: '◔' },
  completed: { label: '已完成', icon: '✓' }, failed: { label: '失败', icon: '✗' }, cancelled: { label: '已取消', icon: '⊘' },
};
export const INTEGRATION = { pending: '待合并', review: '待复查', merging: '合并中', merged: '已合并', conflict: '冲突待处理', superseded: '已作废' };
export const ROLE = { planner: '规划', scheduler: '调度', worker: '执行', coordinator: '协调', research: '调研', verifier: '检验', merger: '解冲突' };
export const EVENTS = {
  created: '创建任务', 'invocation.started': '开始调用', 'invocation.completed': '调用完成',
  message: '收到消息', 'notice.opened': '向你提问', 'notice.answered': '已答复', retry: '重试',
  'workspace.created': '创建 worktree', 'workspace.removed': '回收 worktree', 'branch.removed': '回收分支',
  'verify.requested': '请求检验', 'baseline.created': '创建对照基线', 'baseline.removed': '回收对照基线',
  'merge.approved': '批准合并', merged: '已合并', 'merge.included': '随其它变更一并落地', 'merge.failed': '合并失败',
  'merge.conflict': '合并冲突', 'merge.resolved': '冲突已解决', 'merge.conflict.abandoned': '放弃解冲突',
  'resolution.superseded': '解冲突作废',
  completed: '完成', failed: '失败', cancelled: '取消',
};
export const HOT = new Set(['running', 'awaiting', 'waiting', 'queued']);
export const TERMINAL_STATUS = new Set(['completed', 'failed', 'cancelled']);
/** 时间轴里「没在跑」的四种原因：前两种是结构造成的串行，后两种是资源与人的等待。 */
export const WAIT_REASON = { dep: '等依赖', children: '等子任务', user: '等你决定', slot: '等并发槽', setup: '没跑起来' };
export const short = value => (typeof value === 'string' ? value.slice(0, 7) : '');
export const statusOf = task => STATUS[task.status] || { label: task.status, icon: '·' };
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
  code: '这是它的 worktree 基线：本任务的分支从上游分支长出来，所以合并必须先合上游，否则会把上游的改动一起带进来。',
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
/** 一条 spec 的完整可读文本，放进 title，让人 hover 就能看全文与丢弃原因。 */
export function specTitle(spec) {
  const info = specStatus(spec);
  return [`#${spec.id} ${spec.goal}`, `状态：${info.label}`, spec.note ? `备注：${spec.note}` : null].filter(Boolean).join('\n');
}
export const MERGE_STATUS = { merged: '✓ 已合并', conflict: '⚠ 冲突', failed: '✗ 失败', skipped: '⊘ 跳过' };
export const CHANGE = { '??': '未跟踪', M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', UU: '冲突', AA: '冲突', T: '类型变更' };
export const edgeLabel = edge => `#${edge.id}（${edge.kind === 'code' ? '代码基线' : '仅顺序'} · ${statusOf(edge).label}）`;
export const STEP = { input: '输入', text: '回答', thinking: '思考', tool: '工具调用', result: '工具输出', meta: '运行时' };
export const MD_STEP = new Set(['text', 'result', 'thinking']);   // 这几类步骤正文按 markdown 渲染
/** 「最近一次执行」＝执行过程最后一条可显示步骤：相对时间（会随轮询自己走）+ 内容单行预览，全文放 title。 */
export function lastView(last) {
  if (!last) return { value: '—', title: '还没有会话记录：这个任务从未被唤醒，或会话文件已被清理。' };
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
