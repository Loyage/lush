import { renderMarkdown } from './markdown.js';
import { SORT_MODES, treeParent, rankTasks, orderSiblings } from './tree-order.js';
import { LIVE_INTERVAL, liveTarget, liveTick } from './live.js';
import { mergeCandidates, isMergeable, previewMergeOrder, ladderEdges, freezeBlocker } from './merge-select.js';

const $ = id => document.getElementById(id);
const STATUS = {
  queued: { label: '排队', icon: '○' }, running: { label: '运行中', icon: '●' },
  waiting: { label: '等子任务', icon: '◐' }, awaiting: { label: '等你决定', icon: '◔' },
  completed: { label: '已完成', icon: '✓' }, failed: { label: '失败', icon: '✗' }, cancelled: { label: '已取消', icon: '⊘' },
};
const INTEGRATION = { pending: '待合并', review: '待复查', merging: '合并中', merged: '已合并', conflict: '冲突待处理', superseded: '已作废' };
const ROLE = { planner: '规划', scheduler: '调度', worker: '执行', coordinator: '协调', research: '调研', verifier: '检验', merger: '解冲突' };
const EVENTS = {
  created: '创建任务', 'invocation.started': '开始调用', 'invocation.completed': '调用完成',
  message: '收到消息', 'notice.opened': '向你提问', 'notice.answered': '已答复', retry: '重试',
  'workspace.created': '创建 worktree', 'workspace.removed': '回收 worktree', 'branch.removed': '回收分支',
  'verify.requested': '请求检验', 'baseline.created': '创建对照基线', 'baseline.removed': '回收对照基线',
  'merge.approved': '批准合并', merged: '已合并', 'merge.failed': '合并失败',
  'merge.conflict': '合并冲突', 'merge.resolved': '冲突已解决', 'merge.conflict.abandoned': '放弃解冲突',
  'resolution.superseded': '解冲突作废',
  completed: '完成', failed: '失败', cancelled: '取消',
};
const HOT = new Set(['running', 'awaiting', 'waiting', 'queued']);
const TERMINAL_STATUS = new Set(['completed', 'failed', 'cancelled']);
/** 时间轴里「没在跑」的四种原因：前两种是结构造成的串行，后两种是资源与人的等待。 */
const WAIT_REASON = { dep: '等依赖', children: '等子任务', user: '等你决定', slot: '等并发槽', setup: '没跑起来' };
let selected = null, selectedRevision = null, busy = false, offline = false, detailDirty = false, detailTask = null, detailRenderedAt = 0;
let draftSignature = null;
// 意图面板的重建哨兵：planner 状态、闸门、spec 计数、scheduler 进度变了才重画。
let intentSignature = null;
// 拆解队列的重建哨兵：id/status/batch_id/task_id 变化才重画，轮询不冲掉滚动。
let specSignature = null;
// 勾选与编辑态都按草稿 id 记，这样轮询重建时不会丢用户的意图；默认全选。
const draftUnchecked = new Set();
let draftIds = [], draftEditing = null;
// 左侧「等你决定」只是索引；右侧展开的那条 notice 由 noticeFocus 记住，数据每次都取自最新 snapshot。
let noticeFocus = null, noticeIndex = new Map();

/* ---------- markdown 渲染开关 ---------- */
const MARKDOWN_KEY = 'lush.markdown';
let markdownEnabled = readMarkdownPref();
function readMarkdownPref() {
  try { return localStorage.getItem(MARKDOWN_KEY) !== '0'; } catch { return true; }   // 默认开启
}
function syncMarkdownToggle() {
  const toggle = $('md-toggle');
  toggle.textContent = `Markdown 渲染：${markdownEnabled ? '开' : '关'}`;
  toggle.setAttribute('aria-pressed', String(markdownEnabled));
}
/** 受开关影响的 agent 输出：开启时返回 markdown 容器，关闭时保持与原来一致的纯文本节点。 */
function agentText(value, { className = '', plain = 'div' } = {}) {
  const text = value == null ? '' : String(value);
  if (!markdownEnabled) return el(plain, text, className || undefined);
  const node = renderMarkdown(text, document);
  if (className) node.className = `${node.className} ${className}`;
  return node;
}
$('md-toggle').onclick = () => {
  markdownEnabled = !markdownEnabled;
  try { localStorage.setItem(MARKDOWN_KEY, markdownEnabled ? '1' : '0'); } catch { /* 隐私模式里忽略 */ }
  syncMarkdownToggle();
  if (selected !== null) detail(selected).catch(error => { $('error').textContent = error.message; });
};
syncMarkdownToggle();

const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const short = value => (typeof value === 'string' ? value.slice(0, 7) : '');

/* ---------- 任务树排序偏好 ---------- */
const TREE_SORT_KEY = 'lush.treeSort';
const SORT_IDS = new Set(SORT_MODES.map(mode => mode.id));
let treeSortMode = readTreeSortPref();
let lastSnapshot = null;   // 切排序模式要立刻重排，不必等下一次轮询
function readTreeSortPref() {
  try { const value = localStorage.getItem(TREE_SORT_KEY); return SORT_IDS.has(value) ? value : 'smart'; } catch { return 'smart'; }
}
function syncTreeSortSelect() {
  const select = $('tree-sort');
  select.replaceChildren(...SORT_MODES.map(mode => { const option = el('option', mode.label); option.value = mode.id; return option; }));
  select.value = treeSortMode;
  select.title = '智能排序：有未答复问题的任务排最前，正在跑的次之，等你批准合并的再次之，已合并 / 失败 / 取消的沉到最后；父任务带着活跃子树一起靠前，只有同一层兄弟会换位置。';
}
$('tree-sort').addEventListener('change', () => {
  const value = $('tree-sort').value;
  treeSortMode = SORT_IDS.has(value) ? value : 'smart';
  try { localStorage.setItem(TREE_SORT_KEY, treeSortMode); } catch { /* 隐私模式里忽略 */ }
  if (lastSnapshot) renderTree(lastSnapshot);
});
syncTreeSortSelect();
const statusOf = task => STATUS[task.status] || { label: task.status, icon: '·' };
function relative(iso) {
  const at = Date.parse(iso); if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 5) return '刚刚'; if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
function duration(from, to) {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}
const absolute = iso => { const at = Date.parse(iso); return Number.isFinite(at) ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : ''; };
const clock = iso => { const at = Date.parse(iso); return Number.isFinite(at) ? new Date(at).toTimeString().slice(0, 8) : ''; };
/** token 只让人比大小，不让人数位数：7.2k / 1.34M。 */
const tokens = value => { const count = Number(value) || 0; return count >= 1e6 ? `${(count / 1e6).toFixed(2)}M` : count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count); };
/** 花费可能小到 0.0006 美元，三位小数会全变成 $0.000，看不出差别。 */
const money = value => { const amount = Number(value) || 0; return `$${amount > 0 && amount < 0.01 ? amount.toFixed(5) : amount.toFixed(3)}`; };
const depsOf = task => task.deps || [];
const waitingDeps = task => depsOf(task).filter(dep => !TERMINAL_STATUS.has(dep.status));
/**
 * 还没落地的解冲突任务：进行中的不许重开一轮，已经完成但没落地的可以被「重试合并」取代。
 * merged（已交付）与 superseded（已被下一轮取代）都不再算数。
 */
function resolverOf(task) {
  return (task.resolutions || [])
    .filter(row => row.integration !== 'merged' && row.integration !== 'superseded')
    .sort((a, b) => b.id - a.id)[0] || null;
}
/** 未解决的冲突会冻结同一目标分支上的合并：解冲突的产物要靠 --ff-only 原样落地，main 不能被推走。
 *  判定与运行时 approveMerge / 批量合并的候选过滤共用 merge-select.js 的 freezeBlocker。 */
const freezeOf = task => freezeBlocker(task.target_branch, task, lastSnapshot?.status?.merge_freeze || []);
const DEP_HELP = {
  code: '这是它的 worktree 基线：本任务的分支从上游分支长出来，所以合并必须先合上游，否则会把上游的改动一起带进来。',
  order: '这只是顺序依赖：等上游结束才开跑，代码仍从当时的 HEAD 开始，因此不要求先合并上游。',
};
async function api(url, options) {
  const response = await fetch(url, options); const value = await response.json();
  if (!response.ok) throw new Error(value.error || response.statusText); return value;
}
async function action(method, params) {
  $('error').textContent = '';
  const result = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  await refresh(); return result;
}
function button(text, fn, className) {
  const node = el('button', text, className); node.type = 'button';
  node.onclick = async () => { node.disabled = true; try { await fn(); } catch (error) { $('error').textContent = error.message; } finally { node.disabled = false; } };
  return node;
}
function syncChildren(container, nodes) {
  const wanted = new Set(nodes);
  for (const child of [...container.children]) if (!wanted.has(child)) child.remove();
  nodes.forEach((node, index) => { if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null); });
}
function block(title, count) {
  const section = el('div', undefined, 'block');
  const head = el('div', undefined, 'section-title');
  head.append(el('h2', title));
  if (count !== undefined) head.append(el('span', count, 'count'));
  section.append(head);
  return section;
}
const kv = (label, value, className) => { const node = el('div', undefined, 'kv'); node.append(el('b', label), el('span', value, className)); return node; };
const badge = (text, className) => el('span', text, `badge ${className}`);
const statusBadge = task => badge(`${statusOf(task).icon} ${statusOf(task).label}`, `b-${task.status}`);

async function loadHistory(taskId) {
  const events = []; let after = 0;
  for (let page = 0; page < 5; page++) {
    const chunk = await api(`/api/task/${taskId}/history?after=${after}`);
    events.push(...chunk);
    if (chunk.length < 100) return { events, truncated: false };
    after = chunk.at(-1).id;
  }
  return { events, truncated: true };
}

// 输入缓存：只落库不规划；可改、可勾选，只把选中的交给一个 planner 拆解成任务并建依赖。
async function buffer() {
  const value = $('input').value.trim();
  if (!value) return;
  await action('draft.add', { content: value });
  if ($('input').value.trim() === value) $('input').value = '';
}
const selectedDraftIds = () => draftIds.filter(draftId => !draftUnchecked.has(draftId));
// 按钮的可用性同时看输入框与勾选：都没内容就没什么可提交的。
function syncComposer() { $('draft-commit').disabled = !$('input').value.trim() && selectedDraftIds().length === 0; }
$('draft-add').onclick = async event => {
  const target = event.currentTarget; target.disabled = true;
  try { await buffer(); } catch (error) { $('error').textContent = error.message; } finally { target.disabled = false; }
};
$('input-form').onsubmit = async event => {
  event.preventDefault();
  const submit = $('draft-commit'); submit.disabled = true;
  try {
    if ($('input').value.trim()) await buffer();
    const ids = selectedDraftIds();
    if (!ids.length) throw new Error('没有勾选任何草稿；勾选要提交的，或者先在输入框里写点什么');
    const result = await action('draft.commit', { ids });
    $('error').textContent = `已提交 ${result.drafts.length} 条输入；planner #${result.task.id} 正在拆解任务并建依赖`;
  } catch (error) { $('error').textContent = error.message; } finally { syncComposer(); }
};
$('input').addEventListener('input', syncComposer);
// 回车=缓存，⌘/Ctrl+回车=整体提交，Shift+回车=换行。
$('input').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
  event.preventDefault();
  if (event.metaKey || event.ctrlKey) $('input-form').requestSubmit(); else $('draft-add').click();
});

/* ---------- sidebar ---------- */
/** 点一条草稿就地编辑：Enter / 失焦保存，Esc 取消；轮询不重建正在编辑的那条。 */
function startDraftEdit(draft) {
  if (draftEditing !== null) return;
  const item = $('drafts').querySelector(`[data-id="${draft.id}"]`);
  const body = item?.querySelector('.goal');
  if (!item || !body) return;
  const box = document.createElement('textarea');
  box.className = 'draft-edit';
  box.value = draft.content;
  box.rows = Math.min(10, Math.max(2, Math.ceil(draft.content.length / 40) + 1));
  let done = false;
  const finish = () => { draftEditing = null; draftSignature = null; };
  const cancel = () => { if (done) return; done = true; finish(); refresh(); };
  const save = async () => {
    if (done) return;
    const value = box.value.trim();
    if (!value) { $('error').textContent = '草稿不能为空'; box.focus?.(); return; }
    done = true; finish();
    if (value === draft.content) { await refresh(); return; }
    try { await action('draft.update', { id: draft.id, content: value }); }
    catch (error) { $('error').textContent = error.message; await refresh(); }
  };
  box.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    else if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) { event.preventDefault(); save(); }
  });
  box.addEventListener('blur', save);
  draftEditing = draft.id;
  body.remove();
  item.append(box);
  box.focus?.();
}
function draftItem(draft) {
  const item = el('article', undefined, 'draft');
  item.dataset.id = draft.id;
  const row = el('span', undefined, 'row');
  const pick = document.createElement('input');
  pick.type = 'checkbox'; pick.className = 'pick';
  pick.checked = !draftUnchecked.has(draft.id);
  pick.setAttribute('aria-label', `选中草稿 #${draft.id} 一起提交`);
  pick.title = '勾选后「提交并规划」只提交选中的；不勾的继续留在缓存里';
  pick.onchange = () => { if (pick.checked) draftUnchecked.delete(draft.id); else draftUnchecked.add(draft.id); syncComposer(); };
  const edit = button('编辑', () => startDraftEdit(draft), 'edit');
  edit.setAttribute('aria-label', `编辑草稿 #${draft.id}`);
  const drop = button('移除', () => action('draft.remove', { id: draft.id }), 'drop');
  drop.setAttribute('aria-label', `从缓存移除草稿 #${draft.id}`); drop.title = '从缓存移除这条输入（已提交的输入不可删）';
  row.append(pick, el('span', '○', 'dot c-queued'), el('span', `#${draft.id}`, 'tid'), el('span', '待规划'),
    el('span', relative(draft.created_at), 'when'), edit, drop);
  const body = el('span', draft.content, 'goal');
  body.title = '点击就地编辑这条缓存';
  body.onclick = () => startDraftEdit(draft);
  item.append(row, body);
  item.title = `${draft.content}\n加入缓存于 ${absolute(draft.created_at)}`;
  return item;
}
function renderDrafts(data) {
  const drafts = data.drafts || [];
  draftIds = drafts.map(draft => draft.id);
  $('draft-count').textContent = drafts.length ? `${drafts.length} 条` : '缓存空';
  // 被提交或移除的草稿不再保留勾选/编辑态。
  const live = new Set(draftIds);
  for (const draftId of [...draftUnchecked]) if (!live.has(draftId)) draftUnchecked.delete(draftId);
  // 正在编辑的那条不重建：replaceChildren 会摘掉 textarea，把光标和未保存的内容一起冲掉。
  // 轮询在编辑期间只更新勾选态；保存 / 取消会把 draftSignature 归空，那时再重建。
  if (draftEditing !== null) {
    if (live.has(draftEditing)) { syncComposer(); return; }
    draftEditing = null;
  }
  // 只在内容变化时重建，否则轮询会把滚动和正在输入的光标丢掉。
  const signature = drafts.map(draft => `${draft.id}:${draft.content}`).join('\u0000');
  if (signature === draftSignature) { syncComposer(); return; }
  draftSignature = signature;
  $('drafts').replaceChildren(...drafts.map(draftItem));
  syncComposer();
}
/* ---------- 意图（intent）：一条用户输入 + 它的 planner 拆解 / scheduler 编排 ---------- */
// 意图层不是任务：planner 与 scheduler 不进任务树，在这里跟「待提交缓存」放在一起。
const PLAN_GATE = { proposed: { label: '等你批准', className: 'b-awaiting' }, approved: { label: '已批准', className: 'b-completed' },
  rejected: { label: '已驳回', className: 'b-failed' } };
function planActions(intent) {
  if (intent.plan_gate !== 'proposed') return null;
  const actions = el('span', undefined, 'intent-actions');
  actions.append(button('批准并开发', () => action('plan.approve', { id: intent.task_id }), 'primary'));
  actions.append(button('驳回', () => {
    const reason = prompt('驳回理由（会送给 planner，让它据此重拆）：', '');
    if (!reason || !reason.trim()) return Promise.resolve();
    return action('plan.reject', { id: intent.task_id, reason: reason.trim() });
  }));
  return actions;
}
/** 一条意图：输入正文 + planner 状态/闸门 + 拆解条数 + scheduler 编排进度。只读，除了批准/驳回。 */
function intentItem(intent) {
  const status = statusOf(intent);
  const item = el('div', undefined, `intent${intent.plan_gate === 'proposed' ? ' needs-approval' : ''}`);
  const row = el('span', undefined, 'row');
  row.append(el('span', `#${intent.id}`, 'tid'), badge(`${status.icon} ${status.label}`, `b-${intent.status}`));
  if (intent.flow) row.append(badge(intent.flow === 'explain' ? '了解' : '开发', 'b-neutral'));
  row.append(el('span', relative(intent.created_at), 'when'));
  item.append(row);
  const goal = el('span', intent.content, 'goal intent-goal');
  goal.title = intent.content;
  item.append(goal);
  const meta = el('span', undefined, 'meta');
  meta.append(el('span', `规划 #${intent.task_id}`, 'tid'));
  const counts = [intent.specs_pending ? `待编排 ${intent.specs_pending}` : null, intent.specs_planned ? `已编排 ${intent.specs_planned}` : null,
    intent.specs_dropped ? `已丢弃 ${intent.specs_dropped}` : null].filter(Boolean);
  meta.append(el('span', counts.length ? `拆解 ${counts.join(' · ')}` : '还没拆解'));
  if (intent.scheduler_id) {
    const scheduler = el('button', `调度 #${intent.scheduler_id} · ${STATUS[intent.scheduler_status]?.label ?? intent.scheduler_status}`, 'link');
    scheduler.type = 'button';
    scheduler.onclick = () => { noticeFocus = null; return detail(intent.scheduler_id); };
    meta.append(scheduler);
  }
  if (PLAN_GATE[intent.plan_gate]) meta.append(badge(PLAN_GATE[intent.plan_gate].label, PLAN_GATE[intent.plan_gate].className));
  if (intent.work_tasks) meta.append(el('span', `开发任务 ${intent.work_tasks}`));
  item.append(meta);
  const actions = planActions(intent);
  if (actions) item.append(actions);
  item.append(el('span', intent.plan_gate === 'proposed'
    ? 'planner 认为这次改动影响面大 / 与现状冲突 / 没把握读准意图，先请你拍板；不批就不进 scheduler。'
    : '点这条看 planner 的拆解与调试详情。', 'hint'));
  item.onclick = event => { if (event.target === item || event.target.classList.contains('goal')) { noticeFocus = null; return detail(intent.task_id); } };
  return item;
}
function renderIntents(data) {
  const intents = data.inputs || [];
  const signature = intents.map(intent => [intent.id, intent.status, intent.plan_gate, intent.specs_pending, intent.specs_planned,
    intent.specs_dropped, intent.scheduler_id, intent.scheduler_status, intent.work_tasks, intent.flow].join(':')).join('\u0000');
  if (signature === intentSignature) return;
  intentSignature = signature;
  const container = $('intents');
  if (!intents.length) { container.replaceChildren(el('div', '还没有意图：在下面输入框回车就提交一条。', 'intent-empty')); return; }
  container.replaceChildren(...intents.map(intentItem));
}
/* ---------- 拆解队列（只读）：planner 写、scheduler 取走、Web 只展示 ---------- */
// deps 可能是已解析的数组（{spec,kind} 或裸 id），也可能是 JSON 字符串（旧库/旧读模型）；三种都要兼容。
function specDeps(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
const SPEC_STATUS = {
  pending: { label: '排队中', className: 'b-queued' },
  planned: { label: '已排期', className: 'b-completed' },
  dropped: { label: '已丢弃', className: 'b-failed' },
};
const specStatus = spec => SPEC_STATUS[spec.status] || { label: spec.status, className: 'b-neutral' };
/** 一条 spec 的完整可读文本，放进 title，让人 hover 就能看全文与丢弃原因。 */
function specTitle(spec) {
  const info = specStatus(spec);
  return [`#${spec.id} ${spec.goal}`, `状态：${info.label}`, spec.note ? `备注：${spec.note}` : null].filter(Boolean).join('\n');
}
/** 一条 spec：id / 状态 / role / name / goal（单行截断）/ 更新时间 / 派生的任务 / 依赖。纯只读。 */
function specItem(spec) {
  const info = specStatus(spec);
  const item = el('div', undefined, 'spec');
  const row = el('span', undefined, 'row');
  row.append(el('span', `#${spec.id}`, 'tid'), badge(info.label, info.className));
  if (spec.role) row.append(badge(ROLE[spec.role] || spec.role, 'b-neutral'));
  if (spec.name) row.append(el('span', spec.name, 'spec-name'));
  row.append(el('span', relative(spec.updated_at), 'when'));
  item.append(row);
  const goal = el('span', spec.goal, 'spec-goal');
  goal.title = spec.goal;
  item.append(goal);
  const deps = specDeps(spec.deps).map(dep => (dep && typeof dep === 'object' ? dep.spec : dep));
  if (deps.length) item.append(el('span', `依赖 spec #${deps.join('、')}`, 'meta'));
  if (spec.note && spec.status === 'dropped') item.append(el('span', `原因：${spec.note}`, 'meta'));
  if (spec.status === 'planned' && spec.task_id !== null && spec.task_id !== undefined) {
    const taskRow = el('span', undefined, 'spec-task');
    taskRow.append(el('span', `任务 #${spec.task_id}`, 'tid'),
      button('查看任务', () => { noticeFocus = null; return detail(spec.task_id); }, 'link'));
    item.append(taskRow);
  }
  item.title = specTitle(spec);
  return item;
}
/** 只读展示拆解队列：按批次分组，区分「等 scheduler 编排」与「已被 scheduler #N 取走」。 */
function renderSpecs(data) {
  const specs = data.specs || [];
  const tasks = data.tasks || [];
  const stats = data.status?.specs || {};
  $('spec-count').textContent = specs.length
    ? `排队 ${stats.pending ?? 0} · 已排期 ${stats.planned ?? 0} · 丢弃 ${stats.dropped ?? 0}`
    : '空';
  // 只在队列结构变化时重建：轮询不能把左侧的滚动位置冲掉。
  const signature = specs.map(spec => `${spec.id}:${spec.status}:${spec.batch_id}:${spec.task_id}`).join('\u0000');
  if (signature === specSignature) return;
  specSignature = signature;
  const container = $('specs');
  if (!specs.length) { container.replaceChildren(el('div', '拆解队列空：planner 还没写下可编排的条目；写完由 scheduler 一次性编排本批。', 'spec-empty')); return; }
  // 组：batch_id 为空的是还没被 scheduler 取走的一轮拆解（按 planner 分）；否则按 batch（= scheduler 任务 id）分。
  const groups = new Map();
  for (const spec of specs) {
    const key = spec.batch_id === null || spec.batch_id === undefined ? `planner:${spec.planner_task_id}` : `batch:${spec.batch_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(spec);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    const pendingA = a[0].batch_id === null || a[0].batch_id === undefined;
    const pendingB = b[0].batch_id === null || b[0].batch_id === undefined;
    if (pendingA !== pendingB) return pendingA ? -1 : 1;   // 等编排的组在前
    if (pendingA) return a[0].planner_task_id - b[0].planner_task_id;
    return a[0].batch_id - b[0].batch_id;                  // 已被取走的按 scheduler id 升序
  });
  container.replaceChildren(...ordered.map(rows => {
    const sorted = [...rows].sort((a, b) => a.id - b.id);
    const first = sorted[0];
    const group = el('div', undefined, 'spec-group');
    let title;
    if (first.batch_id === null || first.batch_id === undefined) {
      title = `等 scheduler 编排 · planner #${first.planner_task_id} 的一轮拆解（${sorted.length} 条）`;
    } else {
      const scheduler = tasks.find(task => task.id === first.batch_id);
      title = `已被 scheduler #${first.batch_id}${scheduler ? `（${statusOf(scheduler).label}）` : ''} 取走 · planner #${first.planner_task_id} 的一轮拆解（${sorted.length} 条）`;
    }
    group.append(el('div', title, 'spec-batch'));
    for (const spec of sorted) group.append(specItem(spec));
    return group;
  }));
}
/** 顶部并发槽：并行不是树里的属性，而是全局资源——画出来才知道谁在占槽、谁在等槽。 */
function slotGauge(data) {
  const limit = data.status.concurrency ?? 1, used = data.status.agents.length;
  const ready = data.tasks.filter(task => task.status === 'queued' && !waitingDeps(task).length).length;
  const node = el('span', undefined, 'slots');
  node.append(el('span', '并发槽', 'slot-label'));
  const dots = el('span', undefined, 'slot-dots');
  for (let i = 0; i < Math.min(limit, 16); i++) dots.append(el('span', '●', `slot ${i < used ? 'on' : 'off'}`));
  if (limit > 16) dots.append(el('span', `+${limit - 16}`, 'slot'));
  node.append(dots, el('span', `${used}/${limit}`, 'slot-count'));
  // 没有依赖却没在跑的 queued 任务，等的就是槽——这是「为什么还没开始」最常见的答案。
  if (ready) node.append(el('span', `排队 ${ready} 等槽`, 'slot-queue'));
  node.title = `并发上限 ${limit}：同一时刻最多 ${limit} 个 agent 在跑。没有依赖却在排队的任务就是在等槽。`;
  return node;
}
/** 同一个父任务下互相没有依赖的兄弟可以同时跑；有依赖的串成链——这就是树里看不到的并行/串行。 */
function siblingChain(children) {
  const ids = new Set(children.map(child => child.id));
  const inner = new Map(children.map(child => [child.id, depsOf(child).filter(dep => ids.has(dep.id))]));
  const level = new Map();
  const depth = (taskId, seen = new Set()) => {
    if (level.has(taskId)) return level.get(taskId);
    if (seen.has(taskId)) return 0;
    seen.add(taskId);
    const upstreams = inner.get(taskId) || [];
    const value = upstreams.length ? 1 + Math.max(...upstreams.map(dep => depth(dep.id, seen))) : 0;
    level.set(taskId, value); return value;
  };
  for (const child of children) depth(child.id);
  const levels = new Map();
  for (const child of children) { const at = level.get(child.id); if (!levels.has(at)) levels.set(at, []); levels.get(at).push(child.id); }
  return [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group.sort((a, b) => a - b));
}
/** 一行依赖标签：同名依赖合并成一个标签，词义放在 title 里，免得一行被标签挤爆。 */
function depChips(task) {
  const kinds = ['code', 'order'].filter(kind => depsOf(task).some(dep => dep.kind === kind));
  return kinds.map(kind => {
    const deps = depsOf(task).filter(dep => dep.kind === kind);
    const waiting = deps.some(dep => !TERMINAL_STATUS.has(dep.status));
    const chip = el('span', `${kind === 'code' ? '⛓' : '⏳'}#${deps.map(dep => dep.id).join(',')}${waiting ? '·等' : ''}`,
      `dep dep-${kind}${waiting ? ' dep-wait' : ''}`);
    chip.title = `${kind === 'code' ? 'code 依赖（分支基线）' : 'order 依赖（只等结束）'}：${DEP_HELP[kind]}\n上游：${deps.map(dep => `#${dep.id} ${statusOf(dep).label}`).join('、')}`;
    return chip;
  });
}
/** 此刻为什么没在干活：等依赖 / 等槽 / 等子任务 / 等你决定。四种拼起来才是完整的并行-串行关系。 */
function whyLine(task, index) {
  const waiting = waitingDeps(task);
  if (task.status === 'running') return `运行中 · 占 1 个并发槽`;
  if (task.status === 'queued' && waiting.length) return `排队：等 ${waiting.map(dep => `#${dep.id}`).join('、')} 结束`;
  if (task.status === 'queued') return `排队：没有依赖、但没有空槽（上限 ${index.concurrency}）`;
  if (task.status === 'waiting') {
    const kids = index.children(task.id);
    const live = kids.filter(child => child.status === 'running').length;
    return `等子任务：${live} 个在跑 · ${kids.filter(child => !TERMINAL_STATUS.has(child.status)).length} 个未结束`;
  }
  if (task.status === 'awaiting') return '等你决定：有没答复的问题';
  if (task.status === 'completed' && task.integration === 'conflict') return '已完成，合并冲突等你决定';
  if (task.status === 'completed' && ['pending', 'review'].includes(task.integration)) return '已完成，等你批准合并';
  return null;
}
function renderTree(data) {
  const container = $('tasks');
  const flows = new Map((data.inputs || []).map(input => [input.id, input.flow]));
  const known = new Map([...container.children].map(node => [Number(node.dataset.id), node]));
  const byParent = new Map();
  const ids = new Set(data.tasks.map(task => task.id));
  // verifier 用 verifies_task_id 而不是 parent_id；父任务不在列表里时当根任务渲染，不丢节点。
  // 分组规则与 tree-order.js 的 rankTasks 共用同一个函数，保证排序看到的就是这棵树。
  for (const task of data.tasks) {
    const key = treeParent(task, ids);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(task);
  }
  const openNoticeIds = new Set((data.notices || []).filter(notice => notice.status === 'open').map(notice => notice.task_id));
  const ranks = rankTasks(data.tasks, openNoticeIds);
  const index = { concurrency: data.status.concurrency ?? 1, children: taskId => byParent.get(taskId) || [] };
  const ordered = [];
  const walk = (parent, depth) => {
    // 每层兄弟先按当前偏好排好；band 行仍插在这层兄弟之前，节点复用 / dataset / 点击行为不变。
    const siblings = orderSiblings(byParent.get(parent) || [], { mode: treeSortMode, ranks });
    // 根任务之间的并行由 planner 槽决定（不是一个父任务下的兄弟关系），所以只画委派出来的兄弟。
    if (parent !== 0 && siblings.length > 1) {
      const chain = siblingChain(siblings).map(group => group.length > 1 ? `{${group.map(taskId => `#${taskId}`).join(' ‖ ')}}` : `#${group[0]}`).join(' → ');
      const band = el('div', `‖ ${chain}（并列可同时跑，上限 ${index.concurrency}）`, `band d${Math.min(depth, 5)}`);
      band.title = '∥ 表示同一父任务下互相无依赖、可以同时跑；→ 的顺序来自依赖边：⛓ 基线还要求先合并上游，⏳ 顺序只等上游结束。';
      ordered.push(band);
    }
    for (const task of siblings) {
      const node = known.get(task.id) || button('', () => { noticeFocus = null; return detail(task.id); }, 'task');
      const integration = INTEGRATION[task.integration];
      node.dataset.id = task.id;
      node.className = `task d${Math.min(depth, 5)} s-${task.status}${selected === task.id ? ' selected' : ''}`;
      node.replaceChildren();
      const row = el('span', undefined, 'row');
      row.append(el('span', statusOf(task).icon, `dot c-${task.status}`), el('span', `#${task.id}`, 'tid'),
        el('span', `${statusOf(task).label} · ${ROLE[task.role] || task.role}`));
      const flow = task.parent_id === null && !task.verifies_task_id && !task.resolves_task_id ? flows.get(task.input_id) : null;
      if (flow) row.append(badge(flow === 'explain' ? '了解' : '开发', flow === 'explain' ? 'b-neutral' : 'b-completed'));
      for (const chip of depChips(task)) row.append(chip);
      row.append(el('span', relative(task.updated_at), 'when'));
      node.append(row, el('span', task.goal, 'goal'));
      const why = whyLine(task, index);
      if (why) node.append(el('span', why, 'meta reason'));
      // 已经用一句话说了"等你批准合并"，就不用再挂一个"待合并"标签。
      if (integration && integration !== '待合并') node.append(el('span', integration, 'meta'));
      node.title = `${task.goal}\n更新于 ${absolute(task.updated_at)}`;
      ordered.push(node); walk(task.id, depth + 1);
    }
  };
  walk(0, 0);
  syncChildren(container, ordered);
  const active = data.tasks.filter(task => HOT.has(task.status)).length;
  $('task-count').textContent = `${data.tasks.length} 个 · ${active} 进行中`;
}
/* ---------- 批量合并的选择 ---------- */
/** 勾选状态按 id 存：任务树 / 阶梯每次重画都从它取，轮询不会把勾选丢掉。 */
const mergeSelection = new Set();
/** 最近一次批量合并的逐条结果，刷新后仍留在页面上，直到用户收起。 */
let lastMergeResult = null;
const MERGE_STATUS = { merged: '✓ 已合并', conflict: '⚠ 冲突', failed: '✗ 失败', skipped: '⊘ 跳过' };

/** 合并一批选中的任务：先按与运行时相同的规则预览顺序，再整批交给 task.merge_many。 */
async function mergeBatch(ids, candidates) {
  const picked = [...new Set(ids)];
  if (!picked.length) return;
  const nodes = lastSnapshot?.ladder?.nodes || [];
  const order = previewMergeOrder(picked, ladderEdges(nodes));
  const goalOf = id => candidates.find(candidate => candidate.id === id)?.goal || nodes.find(node => node.id === id)?.goal || '';
  const lines = order.map((taskId, index) => `${index + 1}. #${taskId}${goalOf(taskId) ? ` ${String(goalOf(taskId)).slice(0, 40)}` : ''}`);
  if (!confirm(`将按依赖顺序合并 ${order.length} 个任务（上游先合，逐个写主树，遇到冲突或错误就停下并把剩余跳过）：\n\n${lines.join('\n')}\n\n请先确认代码与测试结果都审阅过。`)) return;
  const result = await action('task.merge_many', { ids: picked });
  lastMergeResult = { requested: order, result };
  overviewKey = null;   // 结果要落在概览里，强制重画一次
  await refresh();
}

/** 合并阶梯：该先合哪个、哪些已经被别的分支带进来了，以及勾选 / 一键多任务合并。 */
function renderLadder(data) {
  const nodes = data?.ladder?.nodes || [];
  const candidates = mergeCandidates(data?.tasks || [], { nodes, freeze: data?.status?.merge_freeze || [] });
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  // 已经不合法的勾选（任务合完了 / 被冻结 / 从阶梯消失）在重画时清掉。
  for (const id of [...mergeSelection]) if (!byId.has(id) || !isMergeable(byId.get(id))) mergeSelection.delete(id);
  const mergeable = candidates.filter(isMergeable);

  // 这里就是「待你批准合并」：待合并分支、谁必须先合、谁已经被别人带进来了。
  const section = block('合并阶梯', nodes.length ? `待批准 ${nodes.length}` : undefined);
  if (!nodes.length) { section.append(el('p', '没有待合并的分支。', 'hint')); return section; }
  section.append(el('p', '⛓ code 依赖＝下游 worktree 的基线：必须先合上游，否则下游的分支会把它一起带进来。\n⏳ order 依赖只要求上游结束，所以下游可以先合——那时它有没有把上游带进来由 git 判定。', 'hint'));

  const boxes = new Map();
  const actions = el('div', undefined, 'actions pick-actions');
  const mergeSelected = button('合并选中', () => mergeBatch(mergeable.filter(candidate => mergeSelection.has(candidate.id)).map(candidate => candidate.id), candidates));
  const mergeAll = button('一键合并所有可合并任务', () => mergeBatch(mergeable.map(candidate => candidate.id), candidates));
  const selectAll = button('全选可合并', () => { for (const candidate of mergeable) mergeSelection.add(candidate.id); sync(); }, 'ghost');
  const clearAll = button('清空选择', () => { mergeSelection.clear(); sync(); }, 'ghost');
  const sync = () => {
    const picked = mergeable.filter(candidate => mergeSelection.has(candidate.id)).length;
    mergeSelected.textContent = `合并选中 (${picked})`;
    mergeSelected.disabled = !picked;
    mergeAll.textContent = `一键合并所有可合并任务 (${mergeable.length})`;
    mergeAll.disabled = !mergeable.length;
    selectAll.disabled = !mergeable.length;
    clearAll.disabled = !mergeSelection.size;
    for (const [id, box] of boxes) box.checked = mergeSelection.has(id);
  };
  actions.append(mergeSelected, mergeAll, selectAll, clearAll);
  section.append(actions);

  for (const node of nodes) {
    const candidate = byId.get(node.id);
    const line = el('div', undefined, `ladder l${Math.min(node.level, 5)}`);
    const row = el('div', undefined, 'row');
    if (candidate) {
      const box = el('input', undefined, 'pick');
      box.type = 'checkbox'; box.checked = mergeSelection.has(candidate.id); box.disabled = !isMergeable(candidate);
      box.setAttribute('aria-label', `选择任务 #${candidate.id} 参与批量合并`);
      box.title = isMergeable(candidate) ? '勾选后点「合并选中」' : `合并被冻结：#${candidate.frozen_by} 的冲突还没解决`;
      box.onchange = () => {
        if (box.checked) mergeSelection.add(candidate.id); else mergeSelection.delete(candidate.id);
        sync();
      };
      boxes.set(candidate.id, box);
      row.append(box);
    } else {
      // 还没到 completed（比如刚创建的解冲突任务）：列出来说明它占着阶梯，但不可合并。
      row.append(el('span', '·', 'tid'));
    }
    row.append(el('span', `L${node.level}`, 'tid'), el('span', `#${node.id}`, 'tid'),
      button(node.goal, () => detail(node.id), 'link'),
      el('span', [INTEGRATION[node.integration] || node.integration, node.branch].filter(Boolean).join(' · '), 'when'));
    line.append(row);
    for (const dep of node.deps) {
      line.append(el('span', `${dep.kind === 'code' ? '⛓ 必须先合' : '⏳ 只等结束'} #${dep.id}${dep.merged ? '（已合并）' : ''}${dep.kind === 'order' && dep.contains ? '（它的提交已经在你里面）' : ''}`, 'meta'));
    }
    if (node.covered_by.length) line.append(el('span', `⚠ 已经被 #${node.covered_by.join('、')} 带进来：合后者即可，本分支会变成 no-op`, 'meta warn'));
    if (candidate && candidate.frozen_by) line.append(el('span', `⛔ 合并被冻结：#${candidate.frozen_by} 的冲突还没解决，先处理它的待决问题`, 'meta warn'));
    section.append(line);
  }
  sync();
  const first = nodes.filter(node => node.level === 0 && !node.covered_by.length).map(node => node.id);
  if (first.length) section.append(el('p', `建议先合 ${first.map(taskId => `#${taskId}`).join('、')}；命令：lush task merge <id> ，或在上面勾选后一键合并。`));
  if (lastMergeResult) section.append(renderMergeResult(lastMergeResult));
  return section;
}

/** 批量合并的逐条结果：成功、失败原因、冲突并指向新开的解冲突任务。 */
function renderMergeResult(entry) {
  const { result } = entry;
  const section = block('批量合并结果', `${result.merged} 个成功`);
  const summary = result.stopped
    ? `合并 ${result.merged} 个后停在 #${result.stopped.id}：${result.stopped.reason}；剩余任务已跳过（未动主树）。`
    : `全部合并成功：${result.merged} 个。`;
  section.append(el('p', summary, result.stopped ? 'hint warn' : 'hint'));
  for (const row of result.merges) {
    const line = el('div', undefined, 'row');
    line.append(el('span', MERGE_STATUS[row.status] || row.status, `c-${row.status === 'merged' ? 'completed' : row.status === 'conflict' || row.status === 'failed' ? 'failed' : 'queued'}`),
      el('span', `#${row.id}`, 'tid'));
    if (row.status === 'conflict' && row.resolution_task_id) {
      line.append(el('span', `已开解冲突任务 #${row.resolution_task_id}`, 'meta'), button('查看解冲突任务', () => detail(row.resolution_task_id), 'link'));
    } else if (row.error && row.status !== 'merged') line.append(el('span', row.error, 'meta'));
    if (row.status === 'merged') line.append(el('span', '已进入目标分支', 'meta'));
    section.append(line);
  }
  const actions = el('div', undefined, 'actions');
  actions.append(button('收起结果', () => { lastMergeResult = null; overviewKey = null; return refresh(); }, 'ghost'));
  section.append(actions);
  return section;
}
/** 并行时间轴：实心＝真的在跑，虚线＝排队，最下面一行是同时占用槽的数量。 */
function renderTimeline(timeline) {
  const section = block('并行时间轴', `${timeline?.tasks?.length ?? 0} 个任务`);
  const tasks = timeline?.tasks || [];
  if (!tasks.length) { section.append(el('p', '还没有任务。', 'hint')); return section; }
  const start = Date.parse(timeline.start), end = Date.parse(timeline.end);
  const span = Math.max(end - start, 1);
  const pct = at => ((at - start) / span) * 100;
  section.append(el('p', `${clock(timeline.start)} → ${clock(timeline.end)}（最近 ${tasks.length} 个任务${timeline.clamped ? '，窗口已截断' : ''}）· 上限 ${timeline.concurrency} 个并发${timeline.truncated ? ' · 更早的任务没有列出' : ''}`, 'hint'));
  const chart = el('div', undefined, 'gantt');
  for (const task of tasks) {
    const row = el('div', undefined, 'gantt-row');
    row.append(el('span', `#${task.id} ${ROLE[task.role] || task.role}`, 'gantt-label'));
    const track = el('div', undefined, 'gantt-track');
    for (const segment of task.segments) {
      const left = pct(Date.parse(segment.start));
      const width = Math.max(pct(Date.parse(segment.end)) - left, 0.35);
      if (segment.kind === 'wait' && width < 0.6) continue;   // 毫秒级的调度延迟不画
      const bar = el('span', undefined, `gantt-seg ${segment.kind}${segment.open ? ' open' : ''}${segment.reason ? ` r-${segment.reason}` : ''}`);
      bar.style.left = `${left}%`; bar.style.width = `${width}%`;
      const what = segment.kind === 'run' ? '运行' : WAIT_REASON[segment.reason] || '排队';
      bar.title = `${what} ${clock(segment.start)} → ${clock(segment.end)}（${duration(segment.start, segment.end)}）${segment.blocked_by?.length ? `\n在等：${segment.blocked_by.map(taskId => `#${taskId}`).join('、')}` : ''}`;
      track.append(bar);
    }
    row.append(track); chart.append(row);
  }
  // 槽位行：按所有区间边界采样，看每个时刻到底有几个 agent 在跑。
  const limit = timeline.concurrency || 1;
  const points = [...new Set(tasks.flatMap(task => task.segments.flatMap(segment => [Date.parse(segment.start), Date.parse(segment.end)])))].sort((a, b) => a - b);
  const slotRow = el('div', undefined, 'gantt-row');
  const slotTrack = el('div', undefined, 'gantt-track slot-track');
  let peak = 0;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const from = points[index], to = points[index + 1], mid = (from + to) / 2;
    const busy = tasks.reduce((sum, task) => sum + task.segments.filter(segment => segment.kind === 'run' && Date.parse(segment.start) <= mid && Date.parse(segment.end) >= mid).length, 0);
    peak = Math.max(peak, busy);
    const bar = el('span', undefined, `gantt-seg slot-${busy === 0 ? 'idle' : busy >= limit ? 'full' : 'busy'}`);
    const left = pct(from);
    bar.style.left = `${left}%`; bar.style.width = `${Math.max(pct(to) - left, 0.2)}%`;
    bar.title = `${clock(new Date(from).toISOString())} 起同时 ${busy} 个在跑（上限 ${limit}）`;
    slotTrack.append(bar);
  }
  slotRow.append(el('span', `槽位 峰值 ${peak}/${limit}`, 'gantt-label'), slotTrack);
  chart.append(slotRow);
  section.append(chart);
  const axis = el('div', undefined, 'gantt-axis');
  axis.append(el('span', clock(timeline.start)), el('span', clock(timeline.end)));
  section.append(axis);
  section.append(el('p', '实心＝agent 真的在跑（来自 invocation 事件）；虚线＝排队，颜色区分等依赖 / 等子任务 / 等并发槽 / 等你决定。', 'hint'));
  return section;
}

/** 左侧只放索引：点一下才在右侧展开正文与回复框。 */
function renderNotices(data) {
  // 计划审批在意图面板上批（kind='plan'），不走这里的问答。
  const open = data.notices.filter(notice => notice.status === 'open' && notice.kind !== 'plan');
  noticeIndex = new Map(open.map(notice => [notice.id, notice]));
  // notice 可能被 CLI 或另一个标签页答复/忽略；关掉了就不再展开。
  if (noticeFocus !== null && !noticeIndex.has(noticeFocus)) noticeFocus = null;
  $('notice-count').textContent = open.length ? String(open.length) : '无';
  const container = $('notices');
  const known = new Map([...container.children].map(node => [Number(node.dataset.id), node]));
  const nodes = open.map(notice => {
    const node = known.get(notice.id) || button('', () => openNotice(notice.id), 'notice-brief');
    node.dataset.id = notice.id;
    node.className = `notice-brief${noticeFocus === notice.id ? ' selected' : ''}`;
    node.replaceChildren();
    const row = el('span', undefined, 'row');
    row.append(el('span', '◔', 'dot c-awaiting'), el('span', `#${notice.task_id}`, 'tid'),
      el('span', relative(notice.created_at), 'when'));
    node.append(row, el('span', notice.title, 'goal'));
    node.title = `${notice.title}\n发布于 ${absolute(notice.created_at)}`;
    return node;
  });
  syncChildren(container, nodes);
}
function openNotice(noticeId) {
  const notice = noticeIndex.get(noticeId);
  if (!notice) return Promise.resolve();
  noticeFocus = noticeId;
  return detail(notice.task_id);
}

/* ---------- detail ---------- */
/** 右侧顶部的 notice：完整正文 + 回复框，下面继续跟它所属任务的详情。 */
function noticePanel(notice) {
  const section = el('section', undefined, 'notice focus');
  section.dataset.id = notice.id;
  const head = el('div', undefined, 'notice-head');
  head.append(badge('◔ 等你决定', 'b-awaiting'), el('span', `任务 #${notice.task_id}`, 'tid'),
    el('span', `${relative(notice.created_at)} · ${absolute(notice.created_at)}`, 'when'));
  section.append(head, el('h3', notice.title), el('p', notice.body || '（没有补充说明）', 'notice-body'));

  const answer = el('textarea');
  answer.placeholder = '你的决定；⌘/Ctrl+回车提交'; answer.rows = 3;
  answer.addEventListener('input', () => { detailDirty = true; });
  const actions = el('div', undefined, 'actions');
  const settle = async () => {
    actions.querySelectorAll('button').forEach(node => { node.disabled = true; });
    await action('notice.answer', { id: notice.id, answer: answer.value });
    noticeFocus = null; detailDirty = false;
    await detail(notice.task_id);
  };
  actions.append(
    button('回复并继续任务', settle),
    button('忽略', async () => {
      actions.querySelectorAll('button').forEach(node => { node.disabled = true; });
      await action('notice.dismiss', { id: notice.id });
      noticeFocus = null; detailDirty = false;
      await detail(notice.task_id);
    }, 'ghost'),
    button('收起，只看任务详情', () => { noticeFocus = null; detailDirty = false; return detail(notice.task_id); }, 'ghost'));
  answer.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault(); actions.querySelector('button').click();
  });
  section.append(answer, actions);
  return section;
}
function renderHistory(history, { running = false, truncated = false } = {}) {
  const list = el('ol', undefined, 'timeline');
  history.forEach((event, index) => {
    const item = el('li', undefined, `e-${event.type.replaceAll('.', '-')}${running && index === history.length - 1 ? ' hot' : ''}`);
    const head = el('div'); head.append(el('strong', EVENTS[event.type] || event.type), el('span', `${relative(event.created_at)} · ${absolute(event.created_at)}`, 't-when'));
    item.append(head);
    const data = event.data || {}; let body = '', agent = false;
    if (event.type === 'invocation.started') body = `第 ${data.call ?? '?'} 次调用${data.cwd ? ` · ${data.cwd}` : ''}`;
    else if (event.type === 'invocation.completed' || event.type === 'completed' || event.type === 'failed') { body = String(data.result || data.error || '').slice(0, 600); agent = true; }
    else if (event.type === 'created') body = `${ROLE[data.role] || data.role}${data.parent_id ? ` ← #${data.parent_id}` : ' · 根任务'}`;
    else if (event.type === 'message') { body = String(data.body || '').slice(0, 400); agent = true; }
    else if (event.type === 'notice.opened') body = data.title || '';
    else if (event.type === 'notice.answered') body = data.dismiss ? '已忽略' : String(data.answer || '');
    else if (event.type === 'workspace.created') body = [data.branch, data.workspace,
      data.dirty_source ? `创建时主树有 ${data.dirty_source.files} 处未提交改动，worker 看不到` : null].filter(Boolean).join(' · ');
    else if (event.type === 'workspace.removed') body = data.branch || '';
    else if (event.type === 'branch.removed') body = data.branch || '';
    else if (event.type === 'verify.requested') body = `检验任务 #${data.verify_task} · 对照 ${data.baseline}`;
    else if (event.type === 'baseline.created') body = [data.target_branch, short(data.commit), data.workspace].filter(Boolean).join(' · ');
    else if (event.type === 'baseline.removed') body = data.workspace || '';
    else if (event.type === 'merged' || event.type === 'merge.approved') body = short(data.commit);
    else if (event.type === 'merge.failed') body = data.error || '';
    else body = Object.keys(data).length ? JSON.stringify(data).slice(0, 300) : '';
    if (body) item.append(agent ? agentText(body, { className: 't-body' }) : el('div', body, 't-body'));
    list.append(item);
  });
  if (truncated) list.append(el('li', '… 更早的事件未显示（每页 100 条）', 't-body'));
  return list;
}
const CHANGE = { '??': '未跟踪', M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', UU: '冲突', AA: '冲突', T: '类型变更' };
function fileList(rows, total) {
  const list = el('ul', undefined, 'difflist');
  for (const file of rows) {
    const item = el('li'), stat = el('span', undefined, 'stat');
    if (file.code) item.append(el('span', CHANGE[file.code] || file.code, 'change'));
    if (file.added === null && file.deleted === null) stat.append(el('span', file.code === '??' ? '' : '二进制', 'plus'));
    else stat.append(el('span', `+${file.added}`, 'plus'), el('span', ` −${file.deleted}`, 'minus'));
    item.append(el('span', file.path, 'path'), stat); list.append(item);
  }
  if (total > rows.length) list.append(el('li', `… 另有 ${total - rows.length} 个文件`, 'path'));
  return list;
}
function renderDiff(diff) {
  const section = block('改动概览');
  if (!diff) { section.append(el('p', '尚无工作区（规划任务或不改动代码的任务不创建 worktree）。', 'hint')); return section; }
  const grid = el('div', undefined, 'grid');
  grid.append(kv('分支', diff.branch || '—', 'mono'), kv('目标分支', diff.target_branch || '—', 'mono'));
  grid.append(kv('基准 → 提交', diff.committed ? `${short(diff.base_commit)} → ${short(diff.head_commit)}` : `${short(diff.base_commit) || '—'} → 无提交`, 'mono'));
  if (diff.base_behind) grid.append(kv('基线落后主树', `${diff.base_behind} 个提交`));
  grid.append(kv('提交文件', diff.committed ? String(diff.files_total) : '0'));
  grid.append(kv('未提交文件', String(diff.pending_total || 0)));
  section.append(grid);
  if (diff.commits?.length) {
    const list = el('ul', undefined, 'difflist');
    for (const line of diff.commits) { const item = el('li'); item.append(el('span', line, 'path')); list.append(item); }
    section.append(el('p', '提交', 'hint'), list);
  }
  if (diff.files?.length) section.append(el('p', '已提交的文件', 'hint'), fileList(diff.files, diff.files_total));
  if (diff.pending?.length) {
    section.append(el('p', '未提交的改动（agent 未提交或失败时留下的）', 'hint'), fileList(diff.pending, diff.pending_total));
  }
  return section;
}
const edgeLabel = edge => `#${edge.id}（${edge.kind === 'code' ? '代码基线' : '仅顺序'} · ${statusOf(edge).label}）`;

/* ---------- agent 执行过程：只读投影 pi 会话记录 ---------- */
const STEP = { input: '输入', text: '回答', thinking: '思考', tool: '工具调用', result: '工具输出', meta: '运行时' };
const MD_STEP = new Set(['text', 'result', 'thinking']);   // 这几类步骤正文按 markdown 渲染
const transcriptOpen = new Set();    // 用户展开过「执行过程」的任务
const transcriptCache = new Map();   // taskId -> 已加载的步骤窗口
/** 单步折叠：默认每步只占一行（类型 + 标题 + 时间），点这一行才看正文；只有大模型的「回答」默认展开。 */
const STEP_OPEN = new Set(['text']);
const stepToggle = new Map();        // `<taskId>:<seq>` -> 用户显式选择的展开状态，重画详情不会丢
const stepKey = (taskId, step) => `${taskId}:${step.seq}`;
const stepExpanded = (taskId, step) => stepToggle.get(stepKey(taskId, step)) ?? STEP_OPEN.has(step.kind);

/** 一步：折叠状态只改这一个节点，不重建整个执行过程（否则滚动位置会跳）。 */
function stepNode(taskId, step) {
  const item = el('li', undefined, `step s-${step.kind}`);
  const head = el('button', undefined, 'step-head');
  head.type = 'button';
  const caret = el('span', '', 'step-caret');
  head.append(caret, el('span', STEP[step.kind] || step.kind, `step-kind k-${step.kind}`), el('span', step.title, 'step-title'));
  if (step.at) head.append(el('span', relative(step.at), 'when'));
  item.append(head);
  // 没有正文的步骤（运行时元数据）保持一行，也不做可点的样子。
  if (!step.body) { head.classList.add('static'); head.tabIndex = -1; return item; }
  const body = MD_STEP.has(step.kind) ? agentText(step.body, { className: 'step-body' }) : el('div', step.body, 'step-body');
  const paint = open => {
    item.classList.toggle('open', open);
    caret.textContent = open ? '▾' : '▸';
    body.hidden = !open;
    head.setAttribute('aria-expanded', String(open));
  };
  head.title = '点击展开／收起这一步的正文';
  head.onclick = () => { const open = !item.classList.contains('open'); stepToggle.set(stepKey(taskId, step), open); paint(open); };
  paint(stepExpanded(taskId, step));
  item.append(body);
  return item;
}

function transcriptContent(taskId) {
  const state = transcriptCache.get(taskId);
  if (!state) return [el('p', '正在读取会话记录…', 'hint')];
  const meta = el('p', transcriptMetaText(state), 'hint');
  meta.dataset.live = 'transcript-meta';
  if (!state.steps.length) return [meta];
  const list = el('ol', undefined, 'steps');
  list.dataset.live = 'transcript-steps';
  for (const step of state.steps) list.append(stepNode(taskId, step));
  const foldable = state.steps.filter(step => step.body);
  const actions = el('div', undefined, 'actions');
  // 一步一行，但轮到要看全文时不该点几十次：一个按钮把整段过程一次摊开或收起。
  if (foldable.length > 1) {
    const allOpen = foldable.every(step => stepExpanded(taskId, step));
    actions.append(button(allOpen ? '收起全部步骤' : '展开全部步骤', () => {
      for (const step of foldable) stepToggle.set(stepKey(taskId, step), !allOpen);
      paintTranscript(taskId);
    }, 'ghost'));
  }
  if (state.has_more) { const more = button(`加载更多（已有 ${state.steps.length} 步）`, async () => {
    const page = await api(`/api/task/${taskId}/transcript?after=${state.next}`);
    state.steps.push(...page.steps); state.next = page.next; state.has_more = page.has_more;
    paintTranscript(taskId);
  }, 'ghost'); more.dataset.live = 'transcript-more'; actions.append(more); }
  actions.append(button('重新加载', async () => { await loadTranscript(taskId); await detail(taskId); }, 'ghost'));
  return [meta, list, actions, state.truncated ? el('p', '会话记录过大，只读取了前面一部分。', 'hint') : null].filter(Boolean);
}
/** 只替换执行过程区块，避免为了追加一页步骤重建整个详情面板。 */
function paintTranscript(taskId) {
  if (selected !== taskId) return;
  const holder = $('detail').querySelector('.transcript');
  if (holder) holder.replaceChildren(...transcriptContent(taskId));
}
const transcriptMetaText = state => state.steps.length
  ? `${state.steps.length} 步 \u00b7 来自 pi 会话记录：${state.files.join('\u3001')} \u00b7 默认折叠成一行，点标题展开（「回答」默认展开）`
  : (state.files.length ? '会话记录里还没有可显示的步骤。' : '这个任务还没有 pi 会话记录（可能从未被唤醒，或会话文件已被清理）。');
/**
 * 热任务轮询的增量续读：只往现有 <ol> 后面接新步骤，不重建列表、不动 #detail 的滚动位置，
 * 也不碰用户正在输入的 textarea。列表还没画出来（刚展开/之前没有步骤）时才整体重画那一个区块。
 */
function appendTranscriptSteps(taskId, steps) {
  if (selected !== taskId) return;
  const state = transcriptCache.get(taskId);
  const holder = $('detail').querySelector('.transcript');
  if (!state || !holder) return;
  const list = holder.querySelector('[data-live="transcript-steps"]');
  if (list) for (const step of steps) list.append(stepNode(taskId, step));
  else paintTranscript(taskId);
  const meta = holder.querySelector('[data-live="transcript-meta"]');
  if (meta) meta.textContent = transcriptMetaText(state);
  const more = holder.querySelector('[data-live="transcript-more"]');
  if (more) more.textContent = `加载更多（已有 ${state.steps.length} 步）`;
}
async function loadTranscript(taskId) {
  const page = await api(`/api/task/${taskId}/transcript?after=0`);
  transcriptCache.set(taskId, { steps: page.steps, files: page.files, next: page.next, has_more: page.has_more, truncated: page.truncated });
  paintTranscript(taskId);
}
function renderDeps(task) {
  const section = block('任务依赖');
  section.append(el('p', task.deps?.length ? `本任务等这些结算：${task.deps.map(edgeLabel).join('、')}` : '本任务不依赖其他任务。', 'hint'));
  section.append(el('p', task.dependents?.length ? `这些任务在等它：${task.dependents.map(edgeLabel).join('、')}` : '没有任务在等它。', 'hint'));
  return section;
}
const reportButton = taskId => button('打开 HTML 报告', () => { window.open(`/api/task/${taskId}/report`, '_blank', 'noopener'); }, 'ghost');
/** 检验区块：worker 看自己的历次检验，verifier 看自己的报告。 */
function renderVerifications(task) {
  if (task.role === 'verifier') {
    const section = block('检验');
    section.append(el('p', `本任务检验 #${task.verifies_task_id}：演示它 worktree 里的实际运行结果，并对照目标分支的同一场景。`, 'hint'));
    if (task.report) { const actions = el('div', undefined, 'actions'); actions.append(reportButton(task.id)); section.append(actions); }
    else section.append(el('p', '还没有生成 HTML 报告；报告写到任务 result 里给出的 report_path。', 'hint'));
    return section;
  }
  const verifications = task.verifications || [];
  const section = block('检验', String(verifications.length));
  if (!verifications.length) {
    section.append(el('p', '还没有检验。点上面的「检验」会派一个只读 agent，用它自己判断的最直观方式演示 worktree 结果，并对照目标分支。', 'hint'));
    return section;
  }
  for (const item of verifications) {
    const card = el('div', undefined, 'verify');
    const row = el('div', undefined, 'row');
    row.append(statusBadge(item), el('span', `#${item.id}`, 'tid'), button('查看检验任务', () => detail(item.id), 'link'),
      el('span', `${relative(item.updated_at)} · ${absolute(item.updated_at)}`, 'when'));
    card.append(row);
    if (item.baseline_commit) card.append(el('p', `对照基线 ${short(item.baseline_commit)}`, 'hint'));
    if (item.result) card.append(el('pre', item.result));
    if (item.error) card.append(el('pre', item.error, 'error'));
    if (item.has_report) { const actions = el('div', undefined, 'actions'); actions.append(reportButton(item.id)); card.append(actions); }
    section.append(card);
  }
  return section;
}
/** 「最近一次执行」＝执行过程最后一条可显示步骤：相对时间（会随轮询自己走）+ 内容单行预览，全文放 title。 */
function lastView(last) {
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
/** 轮询里只重画这一行：「最近一次执行」的相对时间不必等整个详情面板重建。 */
function paintUsageLast(taskId, usage) {
  if (selected !== taskId) return;
  const row = $('detail').querySelector('[data-live="last"]');
  if (!row) return;
  const view = lastView(usage?.last ?? null);
  const span = row.querySelector('span');
  if (span) span.textContent = view.value;
  row.title = view.title;
}
/** 一个 agent 的全部信息：身份与唤醒次数（Lush 侧）+ 模型、上下文、花费（pi 会话记录侧）。
 *  执行过程就在同一块里——它就是 agent 这个身份干过的事，不是另一类数据。 */
function renderAgent(task, usage) {
  const section = block('Agent');
  const grid = el('div', undefined, 'grid');
  if (task.agent) {
    grid.append(kv('agent', `${task.agent.id} · ${task.agent.active ? `运行中 · pid ${task.agent.pid ?? '待上报'}` : '空闲'}`));
    grid.append(kv('唤醒', `累计 ${task.agent.wakes} 次${task.agent.last_seen_at ? ` · 上次动手 ${relative(task.agent.last_seen_at)}` : ''}`));
  }
  // 用户要的“最近一次执行”：时间就是执行过程最后一条步骤的时间，内容就是那一步。
  const last = lastView(usage?.last ?? null);
  const lastRow = kv('最近一次执行', last.value);
  lastRow.dataset.live = 'last';
  lastRow.title = last.title;
  grid.append(lastRow);
  if (usage?.files?.length) {
    grid.append(kv('模型', usage.model ? [usage.model.provider, usage.model.model_id].filter(Boolean).join('/') : '—', 'mono'));
    if (usage.thinking_level) grid.append(kv('思考等级', usage.thinking_level));
    // 还没等到模型回复就结束的会话（被杀、启动失败）没有用量，不摆一排 0 充数。
    if (usage.requests) {
      // 上下文占用＝最近一次请求真的送进去又收回来的 token（输入 + 缓存 + 输出），当作那一刻的上下文大小。
      const context = kv('上下文占用', `${tokens(usage.context_tokens)} tokens（最近一次请求）`);
      context.title = '最近一次模型请求的输入 + 缓存读 + 缓存写 + 输出。来自 pi 会话记录，不是估算。';
      const spent = [`输入 ${tokens(usage.totals.input)}`, `输出 ${tokens(usage.totals.output)}`, `缓存读 ${tokens(usage.totals.cache_read)}`];
      if (usage.totals.cache_write) spent.push(`缓存写 ${tokens(usage.totals.cache_write)}`);
      if (usage.totals.reasoning) spent.push(`推理 ${tokens(usage.totals.reasoning)}`);
      const cumulative = kv('累计 token', spent.join(' · '));
      cumulative.title = '这个任务的全部会话文件累计；重试不会清空 agent 的历史。';
      const cost = kv('预计花费', money(usage.totals.cost));
      cost.title = 'pi 按模型单价对每次请求算出的 cost.total 累加；模型换过就按各自单价分别计。';
      grid.append(context, cumulative, cost);
    }
    grid.append(kv('模型请求', `${usage.requests} 次${usage.last_at ? ` · 最近 ${relative(usage.last_at)}` : ''}`));
    grid.append(kv('会话记录', `${usage.files.length} 个文件${usage.compacted ? ` · 上下文压缩 ${usage.compacted} 次` : ''}`, 'mono'));
  }
  section.append(grid);

  const process = block('执行过程');
  const holder = el('div', undefined, 'transcript');
  const cached = transcriptCache.get(task.id);
  if (cached) holder.replaceChildren(...transcriptContent(task.id));
  // 会话文件不存在就别摆一个点了没用的按钮，直接说清楚为什么没东西可看。
  else if (usage && !usage.files.length) holder.append(el('p', '这个任务还没有 pi 会话记录（可能从未被唤醒，或会话文件已被清理）。', 'hint'));
  else if (transcriptOpen.has(task.id)) holder.append(el('p', '正在读取会话记录…', 'hint'));
  else {
    holder.append(el('p', '思考、工具调用与工具输出保存在 pi 会话记录里，默认不展开。', 'hint'));
    const actions = el('div', undefined, 'actions');
    actions.append(button('查看执行过程', async () => {
      transcriptOpen.add(task.id);
      try { await loadTranscript(task.id); } catch (error) { transcriptOpen.delete(task.id); throw error; }
      if (selected === task.id) await detail(task.id);
    }, 'ghost'));
    holder.append(actions);
  }
  process.append(holder);
  section.append(process);
  return section;
}

/**
 * 合并冲突的处理记录：git 自己合不了的那次合并交给了哪几个专用任务，各自到哪了。
 * 已经落地的用 --ff-only 落地（落地的树＝测过的树）；superseded 表示被下一轮取代。
 */
function renderResolutions(task) {
  const section = block('合并冲突', String(task.resolutions.length));
  section.append(el('p', '内容冲突会开一个专用任务：它在自己的 worktree 里（基线＝目标分支顶端）把已审阅的提交并进来、解冲突、跑测试；批准时用 --ff-only 落地，所以落地的就是它测过的那棵树。', 'hint'));
  for (const row of task.resolutions) {
    const line = el('div', undefined, 'row');
    line.append(el('span', `#${row.id}`, 'tid'), el('span', `${statusOf(row).icon} ${statusOf(row).label}`, `dot c-${row.status}`),
      badge(INTEGRATION[row.integration] || row.integration, row.integration === 'merged' ? 'b-completed' : 'b-awaiting'),
      button('查看', () => detail(row.id), 'link'), el('span', row.head_commit ? short(row.head_commit) : '', 'when'));
    section.append(line);
  }
  return section;
}
/** planner 这一轮写下的拆解 / scheduler 这一批取走的 spec：只读，和左侧队列同一套行。 */
function renderTaskSpecs(task) {
  const specs = task.specs || [];
  const section = block('拆解队列', String(specs.length));
  section.append(el('p', task.role === 'scheduler'
    ? '本任务这一批取走的 spec：每一条都要有归宿——spawn 成任务，或明确丢弃。'
    : '这一轮写下的拆解（等 scheduler 编排）：scheduler 会把它们一次性编排成真实任务，批内没有依赖边的会同时开工。', 'hint'));
  if (!specs.length) section.append(el('p', '这一批是空的。', 'hint'));
  for (const spec of [...specs].sort((a, b) => a.id - b.id)) section.append(specItem(spec));
  return section;
}
function renderDetail(task, history, diff, usage) {
  const panel = $('detail'); panel.replaceChildren();
  const head = el('div', undefined, 'head');
  head.append(el('span', `#${task.id}`, 'tid-lg'), statusBadge(task),
    badge(ROLE[task.role] || task.role, 'b-neutral'), badge(`输入 #${task.input_id}`, 'b-neutral'));
  const integration = INTEGRATION[task.integration];
  if (integration) head.append(badge(integration, task.integration === 'merged' ? 'b-completed' : 'b-awaiting'));
  if (task.agent) head.append(badge(`agent ${task.agent.id}${task.agent.active ? ` · pid ${task.agent.pid ?? '待上报'}` : ' · 空闲'}`, 'b-neutral'));
  panel.append(head);

  const notice = noticeFocus === null ? null : noticeIndex.get(noticeFocus);
  if (notice && notice.task_id === task.id) panel.prepend(noticePanel(notice));

  const actions = el('div', undefined, 'actions');
  const stacked = (task.deps || []).filter(edge => edge.kind === 'code');
  const freeze = freezeOf(task);
  const resolver = resolverOf(task);
  if (freeze) {
    // 同一目标分支上有没解决的冲突：这里点合并只会失败，所以禁用并指向那个任务。
    const node = button('合并已被冻结', () => {}, 'ghost');
    node.disabled = true;
    node.title = `#${freeze.task_id} 的合并冲突还没解决：先处理它的待决问题（或让它的解冲突任务作废），${task.target_branch} 上的合并才能继续。`;
    actions.append(node);
  } else if (task.status === 'completed' && ['pending', 'review', 'conflict'].includes(task.integration)) {
    const live = resolver && !TERMINAL_STATUS.has(resolver.status);
    const retry = task.integration === 'conflict';
    const label = live ? `解冲突任务 #${resolver.id} 进行中`
      : retry ? '重试合并' : task.integration === 'review' ? '检查后重新批准合并' : '批准合并';
    const node = button(label, async () => {
      const lines = [retry ? `重新尝试把 ${task.branch} 合并到 ${task.target_branch}？如果还冲突，会再开一轮解冲突任务。`
        : `将 ${task.branch} 合并到 ${task.target_branch}？请先审阅代码和测试结果。`];
      if (stacked.length) lines.push(`本任务 stacked 在 #${stacked.map(edge => edge.id).join('、')} 之上，必须先合并上游，否则会把它的改动一起带进来。`);
      if (task.resolves_task_id) lines.push('这是解冲突任务：落地用 --ff-only，落地的树就是它测过的那棵树。');
      if (resolver) lines.push(`解冲突任务 #${resolver.id} 还没落地：重试会让它作废（分支与目录保留在磁盘上）。`);
      if (!confirm(lines.join('\n\n'))) return;
      const result = await action('task.merge', { id: task.id });
      if (result?.merge?.status === 'conflict') $('error').textContent = `合并冲突：已开解冲突任务 #${result.merge.resolution_task_id}，请处理左侧的待决问题（${task.target_branch} 上的其它合并已冻结）。`;
      else if (result?.merge?.status === 'resolved') $('error').textContent = `冲突已解决：原任务 #${result.merge.resolved_task_id} 也标成已合并。`;
      await detail(task.id);
    });
    if (live) { node.disabled = true; node.title = `#${resolver.id} 正在解冲突：等它结束，或者先取消它再重试。`; }
    actions.append(node);
  }
  if (['failed', 'cancelled'].includes(task.status)) actions.append(button('检查后重试', async () => { await action('task.retry', { id: task.id }); await detail(task.id); }));
  const reclaimable = task.status === 'completed' && ['merged', 'none', 'superseded'].includes(task.integration) && (task.workspace || task.branch);
  if (reclaimable) actions.append(button('回收工作区与分支', async () => {
    const plan = [task.workspace && `删除 ${task.workspace}`, task.branch && `回收分支 ${task.branch}`].filter(Boolean).join('\n');
    if (!confirm(`${plan}\n\n只有分支顶端就是审阅过的那次提交、且已经进入 ${task.target_branch} 时才删；否则分支保留并在事件里说明原因。`)) return;
    await action('task.cleanup', { id: task.id }); await detail(task.id);
  }, 'ghost'));
  if (reclaimable && task.workspace && task.branch) actions.append(button('只回收 worktree（保留分支）', async () => { await action('task.cleanup', { id: task.id, keep_branch: true }); await detail(task.id); }, 'ghost'));
  const verifications = task.verifications || [];
  const activeVerification = verifications.find(item => !TERMINAL_STATUS.has(item.status));
  if (task.role === 'worker' && task.status === 'completed' && task.workspace && task.head_commit) {
    const node = button(activeVerification ? `检验中… #${activeVerification.id}` : (verifications.length ? '重新检验' : '检验'),
      async () => { await action('task.verify', { id: task.id }); await detail(task.id); });
    if (activeVerification) node.disabled = true;
    actions.append(node);
  }
  if (!['completed', 'failed', 'cancelled'].includes(task.status)) actions.append(button('取消任务树', async () => {
    if (confirm('取消这个任务及所有子任务？工作区会保留。')) await action('task.cancel', { id: task.id });
    await detail(task.id);
  }, 'danger'));
  if (task.parent_id === null && task.role === 'planner') actions.append(
    button('标记为开发', async () => { await action('input.flow', { id: task.id, flow: 'develop' }); await detail(task.id); }, 'ghost'),
    button('标记为了解', async () => { await action('input.flow', { id: task.id, flow: 'explain' }); await detail(task.id); }, 'ghost'));
  actions.append(button('刷新详情', () => detail(task.id), 'ghost'));
  panel.append(actions);

  const goal = block('目标'); goal.append(el('p', task.goal)); panel.append(goal);

  const stats = block('状态');
  const grid = el('div', undefined, 'grid');
  grid.append(kv('调用次数', `${task.calls}（本次尝试）`));
  grid.append(kv(task.status === 'running' ? '本次已运行' : '耗时', duration(task.created_at, task.status === 'running' ? new Date().toISOString() : task.updated_at)));
  grid.append(kv('创建', `${absolute(task.created_at)}`, 'mono'));
  grid.append(kv('最后更新', `${absolute(task.updated_at)} · ${relative(task.updated_at)}`));
  stats.append(grid); panel.append(stats);
  if (task.specs) panel.append(renderTaskSpecs(task));
  panel.append(renderDeps(task));
  if ((task.resolutions || []).length) panel.append(renderResolutions(task));

  if (task.result) { const result = block('结果'); result.append(agentText(task.result, { plain: 'pre' })); panel.append(result); }
  if (task.error) { const error = block('错误'); error.append(agentText(task.error, { className: 'error', plain: 'pre' })); panel.append(error); }
  if (task.integration_error) { const error = block('合并错误'); error.append(agentText(task.integration_error, { className: 'error', plain: 'pre' })); panel.append(error); }
  if (task.branch || task.workspace) {
    const workspace = block('工作区');
    workspace.append(el('p', [task.branch, task.workspace].filter(Boolean).join('\n'), 'mono'));
    panel.append(workspace);
  }
  panel.append(renderDiff(diff));
  if (task.role === 'verifier' || verifications.length || (task.role === 'worker' && task.status === 'completed' && task.workspace && task.head_commit)) panel.append(renderVerifications(task));

  if (task.children?.length) {
    const children = block('子任务', String(task.children.length));
    for (const child of task.children) {
      const row = el('div', undefined, 'row');
      row.append(el('span', statusOf(child).icon, `dot c-${child.status}`), el('span', `#${child.id}`, 'tid'));
      const jump = button(`${child.goal}`, () => detail(child.id), 'link');
      row.append(jump, el('span', relative(child.updated_at), 'when'));
      children.append(row);
    }
    panel.append(children);
  }
  if (task.messages?.length) {
    const messages = block('消息', String(task.messages.length));
    for (const message of task.messages) {
      const item = el('div', undefined, 'msg');
      item.append(el('small', `${message.sender_id ? `来自 #${message.sender_id}` : '来自你'} · ${absolute(message.created_at)}`), el('p', message.body));
      messages.append(item);
    }
    panel.append(messages);
  }
  if (task.calls) panel.append(renderAgent(task, usage));
  if (history?.events?.length) {
    const events = block('事件时间线', String(history.events.length));
    events.append(renderHistory(history.events.slice(-200), { running: task.status === 'running', truncated: history.truncated }));
    panel.append(events);
  }

  if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
    const follow = block('追加说明');
    const form = el('form'), input = el('textarea');
    input.placeholder = '追加要求，不打断当前 agent'; input.required = true; input.rows = 3;
    input.addEventListener('input', () => { detailDirty = true; });
    form.append(input, button('追加说明', async () => { await action('task.message', { id: task.id, body: input.value }); detailDirty = false; await detail(task.id); }));
    form.onsubmit = event => { event.preventDefault(); form.querySelector('button').click(); };
    follow.append(form); panel.append(follow);
  }
}
function renderDetailError(taskId, message) {
  const panel = $('detail');
  panel.replaceChildren(el('h2', `无法打开 #${taskId}`), el('p', message, 'error'));
}
/** 回到项目概览：清掉选中与地址栏 hash，再把概览重画一次。入口是左上角的 Lush 标志。 */
async function overview() {
  selected = null; selectedRevision = null; detailDirty = false; overviewKey = null;
  if (location.hash) window.history.replaceState(null, '', location.pathname);
  await refresh();
}
async function detail(taskId) {
  selected = taskId;
  const scrolled = detailTask === taskId ? $('detail').scrollTop : 0;
  // window.history: a local `history` binding here would shadow the global and throw a TDZ error on click.
  // pushState（而不是 replace）让浏览器后退能回到概览或上一个任务；hash 没变时不重复压栈。
  if (location.hash !== `#task-${taskId}`) window.history.pushState(null, '', `#task-${taskId}`);
  let task, timeline, diff, usage;
  try {
    [task, timeline, diff, usage] = await Promise.all([
      api(`/api/task/${taskId}`), loadHistory(taskId).catch(() => ({ events: [], truncated: false })),
      api(`/api/task/${taskId}/diff`).catch(() => null),
      // agent 用量（模型、上下文、花费）来自 pi 会话记录：读不到会话不影响详情其余部分。
      api(`/api/task/${taskId}/usage`).catch(() => null),
    ]);
  } catch (error) {
    if (selected === taskId) renderDetailError(taskId, error.message);
    throw error;
  }
  if (selected !== taskId) return;
  selectedRevision = task.updated_at; detailTask = taskId; detailRenderedAt = Date.now(); detailDirty = false;
  renderDetail(task, timeline, diff, usage);
  $('detail').scrollTop = scrolled;
  const tree = $('tasks').querySelector(`[data-id="${taskId}"]`);
  if (tree) for (const node of $('tasks').children) node.classList.toggle('selected', node === tree);
}

let overviewKey = null;
function renderOverview(data) {
  const open = data.notices.filter(notice => notice.status === 'open');
  const key = JSON.stringify([data.status.tasks, data.status.agents, data.status.agents_idle, data.status.pending_merges, data.status.drafts, open.map(n => n.id),
    data.tasks.length, data.status.project, data.status.version, data.status.fingerprint, data.status.started_at,
    // 时间轴的开口段一直在长，但只在结构变化或每 15 秒才需要重画一次，免得轮询把滚动位置冲掉。
    Math.floor(Date.now() / 15000),
    (data.timeline?.tasks || []).map(task => `${task.id}:${task.status}:${task.segments.length}`).join(','),
    (data.ladder?.nodes || []).map(node => `${node.id}:${node.level}:${node.deps.length}:${node.covered_by.join('|')}`).join(','),
    // 冻结状态一变，可合并集合与勾选可用性就跟着变，所以它也必须进 key。
    (data.status.merge_freeze || []).map(row => `${row.task_id}:${row.target_branch}:${row.resolves_task_id ?? '-'}`).join(',')]);
  if (key === overviewKey) return;
  overviewKey = key;
  const panel = $('detail'); panel.replaceChildren();
  const head = el('div', undefined, 'head');
  head.append(el('span', '项目概览', 'tid-lg'));
  panel.append(head, el('p', '从左侧选择任务，查看结果、改动、子任务与事件时间线。', 'hint'));

  const counts = block('任务');
  const grid = el('div', undefined, 'grid');
  for (const status of Object.keys(STATUS)) {
    const row = data.status.tasks.find(entry => entry.status === status);
    const cell = kv(`${statusOf({ status }).icon} ${statusOf({ status }).label}`, String(row?.count ?? 0));
    cell.querySelector('span').className = `c-${status}`;
    grid.append(cell);
  }
  counts.append(grid); panel.append(counts);

  const agents = block('运行中的 agent', `${data.status.agents.length} / ${data.status.agents_total ?? data.status.agents.length}`);
  if (!data.status.agents.length) agents.append(el('p', `并发额度 ${data.status.concurrency}，当前空闲；另有 ${data.status.agents_idle ?? 0} 个 agent 待唤醒。`, 'hint'));
  else if (data.status.agents_idle) agents.append(el('p', `另有 ${data.status.agents_idle} 个 agent 空闲待唤醒。`, 'hint'));
  for (const agent of data.status.agents) {
    const row = el('div', undefined, 'row');
    row.append(el('span', '●', 'dot c-running'), el('span', agent.id ?? `#${agent.task_id}`, 'tid'),
      button('查看任务', () => detail(agent.task_id), 'link'),
      el('span', `${agent.pid ? `pid ${agent.pid}` : 'pid 待上报'} · 第 ${agent.wakes} 次唤醒`, 'when'));
    agents.append(row);
  }
  panel.append(agents);

  panel.append(renderLadder(data));
  panel.append(renderTimeline(data.timeline));

  const notices = block('待决问题', String(open.length));
  if (!open.length) notices.append(el('p', '没有等你决定的问题。', 'hint'));
  for (const notice of open) {
    const row = el('div', undefined, 'row');
    row.append(el('span', `#${notice.task_id}`, 'tid'), button(notice.title, () => openNotice(notice.id), 'link'));
    notices.append(row);
  }
  panel.append(notices);

  const info = block('运行时');
  const meta = el('div', undefined, 'grid');
  meta.append(kv('项目', data.status.project, 'mono'), kv('provider', data.status.provider || '—'), kv('并发额度', String(data.status.concurrency)),
    kv('缓存中的输入', String(data.status.drafts ?? 0)),
    kv('版本', [data.status.version, data.status.fingerprint].filter(Boolean).join(' · ') || '—', 'mono'),
    kv('状态目录', data.status.home || '—', 'mono'), kv('启动', absolute(data.status.started_at) || '—'));
  info.append(meta); panel.append(info);

  // 一键清空：删库里的已结束任务，并按 cleanup 的安全门回收 worktree/分支，所以必须二次确认。
  const maintenance = block('维护');
  const live = data.status.tasks.filter(row => HOT.has(row.status)).reduce((sum, row) => sum + row.count, 0);
  if (live) maintenance.append(el('p', `还有 ${live} 个任务没有结束。取消它们或等它们结束之后，才能清空看板。`, 'hint'));
  else if (!data.tasks.length) maintenance.append(el('p', '任务看板是空的。', 'hint'));
  else {
    maintenance.append(el('p', `删除全部 ${data.tasks.length} 个已结束任务，以及 inputs / drafts / notices / events。能安全回收的连 worktree 目录、对照检出与任务分支一起删；有未合并成果或分支被改过的保留在磁盘上，返回值会列出原因。旧 task id 不会被新任务复用。`, 'hint'));
    const actions = el('div', undefined, 'actions');
    actions.append(button('清空任务看板', async () => {
      if (!confirm(`删除全部 ${data.tasks.length} 个已结束任务？`)) return;
      if (!confirm('再次确认：库里的任务、输入与事件将不可恢复；已进目标分支的 worktree 目录与分支会一并删除，未合并的保留。')) return;
      const result = await action('task.clear');
      await overview();
      $('error').textContent = `已清空 ${result.cleared.tasks} 个任务、${result.cleared.inputs} 条输入；回收 ${result.reclaimed?.worktrees ?? 0} 个 worktree、${result.reclaimed?.branches ?? 0} 个分支，保留 ${result.retained.tasks.length} 个`;
    }, 'danger'));
    maintenance.append(actions);
  }
  panel.append(maintenance);
}

/* ---------- polling ---------- */
async function refresh() {
  if (busy) return; busy = true;
  try {
    const data = await api('/api/snapshot');
    lastSnapshot = data;
    $('project').textContent = data.status.project;
    $('project').title = data.status.project;
    $('connection').textContent = '已连接'; $('connection').classList.remove('offline');
    $('agents').replaceChildren(slotGauge(data));
    if (offline) { offline = false; $('error').textContent = ''; }
    renderDrafts(data); renderIntents(data); renderTree(data); renderSpecs(data);
    const noticeBefore = noticeFocus;
    renderNotices(data); syncComposer();
    if (selected === null) renderOverview(data);
    const current = data.tasks.find(task => task.id === selected);
    const editing = detailDirty || [...$('detail').querySelectorAll('textarea')].some(node => node.value || node === document.activeElement);
    if (current && !editing) {
      // Live tasks also refresh on a slow tick so elapsed time and agent pid stay honest.
      const changed = current.updated_at !== selectedRevision;
      const tick = HOT.has(current.status) && Date.now() - detailRenderedAt > 15000;
      if (changed || tick) await detail(selected);
    }
    // 展开中的 notice 被别处答复/忽略后，右侧要收敛回普通任务详情。
    if (noticeBefore !== noticeFocus && selected !== null && !editing) await detail(selected);
  } catch (error) {
    $('connection').textContent = '离线 · 自动重连'; $('connection').classList.add('offline');
    offline = true; $('error').textContent = error.message;
  } finally { busy = false; }
}
const linked = taskId => /^#task-(\d+)$/.test(taskId) ? Number(taskId.slice(6)) : null;
$('home').onclick = () => { overview().catch(error => { $('error').textContent = error.message; }); };
await refresh();
const initial = linked(location.hash);
if (initial) { try { await detail(initial); } catch (error) { $('error').textContent = error.message; } }
addEventListener('hashchange', () => {
  const next = linked(location.hash);
  // 后退到没有 hash 的地址＝用户想回概览：只画详情不换面板会让合并按钮彻底消失。
  if (!next) { if (selected !== null) overview().catch(error => { $('error').textContent = error.message; }); return; }
  if (next !== selected) detail(next).catch(error => { $('error').textContent = error.message; });
});
setInterval(refresh, 1500);

/* ---------- 热任务的实时刷新：页面自己变新，不用手点 ---------- */
let liveBusy = false;
async function liveRefresh() {
  if (busy || liveBusy) return;
  const task = liveTarget(lastSnapshot?.tasks || [], selected);
  if (!task) return;
  const taskId = task.id;
  liveBusy = true;
  try {
    await liveTick({
      task,
      // 只有用户已经展开、有缓存时才增量续读；没展开就不读整份会话文件。
      transcript: transcriptCache.get(taskId) ?? null,
      fetchUsage: id => api(`/api/task/${id}/usage`).catch(() => null),
      fetchTranscript: (id, after) => api(`/api/task/${id}/transcript?after=${after}`),
      publish: { usage: paintUsageLast, steps: appendTranscriptSteps },
    });
  } catch { /* 网络抖动交给主 refresh 的离线提示，live tick 不弹错 */ }
  finally { liveBusy = false; }
}
setInterval(liveRefresh, LIVE_INTERVAL);
