import { renderMarkdown } from './markdown.js';

const $ = id => document.getElementById(id);
const STATUS = {
  queued: { label: '排队', icon: '○' }, running: { label: '运行中', icon: '●' },
  waiting: { label: '等子任务', icon: '◐' }, awaiting: { label: '等你决定', icon: '◔' },
  completed: { label: '已完成', icon: '✓' }, failed: { label: '失败', icon: '✗' }, cancelled: { label: '已取消', icon: '⊘' },
};
const INTEGRATION = { pending: '待合并', review: '待复查', merging: '合并中', merged: '已合并' };
const ROLE = { planner: '规划', worker: '执行', coordinator: '协调', research: '调研', verifier: '检验' };
const EVENTS = {
  created: '创建任务', 'invocation.started': '开始调用', 'invocation.completed': '调用完成',
  message: '收到消息', 'notice.opened': '向你提问', 'notice.answered': '已答复', retry: '重试',
  'workspace.created': '创建 worktree', 'workspace.removed': '回收 worktree',
  'verify.requested': '请求检验', 'baseline.created': '创建对照基线', 'baseline.removed': '回收对照基线',
  'merge.approved': '批准合并', merged: '已合并', 'merge.failed': '合并失败',
  completed: '完成', failed: '失败', cancelled: '取消',
};
const HOT = new Set(['running', 'awaiting', 'waiting', 'queued']);
const TERMINAL_STATUS = new Set(['completed', 'failed', 'cancelled']);
/** 时间轴里「没在跑」的四种原因：前两种是结构造成的串行，后两种是资源与人的等待。 */
const WAIT_REASON = { dep: '等依赖', children: '等子任务', user: '等你决定', slot: '等并发槽', setup: '没跑起来' };
let selected = null, selectedRevision = null, busy = false, offline = false, detailDirty = false, detailTask = null, detailRenderedAt = 0;
let draftCount = 0, draftSignature = null;
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
const depsOf = task => task.deps || [];
const waitingDeps = task => depsOf(task).filter(dep => !TERMINAL_STATUS.has(dep.status));
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

// 输入缓存：只落库不规划；整批交给一个 planner 拆解成任务并建依赖。
async function buffer() {
  const value = $('input').value.trim();
  if (!value) return;
  await action('draft.add', { content: value });
  if ($('input').value.trim() === value) $('input').value = '';
}
function syncComposer() { $('draft-commit').disabled = !draftCount && !$('input').value.trim(); }
$('draft-add').onclick = async event => {
  const target = event.currentTarget; target.disabled = true;
  try { await buffer(); } catch (error) { $('error').textContent = error.message; } finally { target.disabled = false; }
};
$('input-form').onsubmit = async event => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('button[type="submit"]'); submit.disabled = true;
  try {
    if ($('input').value.trim()) await buffer();
    const result = await action('draft.commit');
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
function renderDrafts(data) {
  const drafts = data.drafts || [];
  draftCount = drafts.length;
  $('draft-count').textContent = drafts.length ? `${drafts.length} 条` : '缓存空';
  // 只在内容变化时重建，否则轮询会把滚动和正在输入的光标丢掉。
  const signature = drafts.map(draft => `${draft.id}:${draft.content}`).join('\u0000');
  if (signature === draftSignature) return;
  draftSignature = signature;
  // 和任务树同一套行结构（状态点 / #id / 状态 / 时间 + 一行正文），右侧挂一个删除入口。
  $('drafts').replaceChildren(...drafts.map(draft => {
    const item = el('article', undefined, 'draft');
    item.dataset.id = draft.id;
    const row = el('span', undefined, 'row');
    const drop = button('移除', () => action('draft.remove', { id: draft.id }), 'drop');
    drop.setAttribute('aria-label', `从缓存移除草稿 #${draft.id}`); drop.title = '从缓存移除这条输入（已提交的输入不可删）';
    row.append(el('span', '○', 'dot c-queued'), el('span', `#${draft.id}`, 'tid'), el('span', '待规划'),
      el('span', relative(draft.created_at), 'when'), drop);
    item.append(row, el('span', draft.content, 'goal'));
    item.title = `${draft.content}\n加入缓存于 ${absolute(draft.created_at)}`;
    return item;
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
/** 一行依赖标签：⛓ 是分支基线（必须先合上游），⏳ 只是等它结束；未结算的上游高亮。 */
function depChip(dep) {
  const code = dep.kind === 'code', waiting = !TERMINAL_STATUS.has(dep.status);
  const chip = el('span', `${code ? '⛓' : '⏳'}#${dep.id}${code ? '基线' : '顺序'}${waiting ? '·等' : ''}`,
    `dep dep-${code ? 'code' : 'order'}${waiting ? ' dep-wait' : ''}`);
  chip.title = `#${dep.id} ${code ? '（code 依赖）' : '（order 依赖）'}${DEP_HELP[code ? 'code' : 'order']}\n上游状态：${statusOf(dep).label}`;
  return chip;
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
  for (const task of data.tasks) {
    const parent = task.parent_id ?? task.verifies_task_id ?? 0;
    const key = ids.has(parent) ? parent : 0;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(task);
  }
  const index = { concurrency: data.status.concurrency ?? 1, children: taskId => byParent.get(taskId) || [] };
  const ordered = [];
  const walk = (parent, depth) => {
    const siblings = byParent.get(parent) || [];
    // 根任务之间的并行由 planner 槽决定（不是一个父任务下的兄弟关系），所以只画委派出来的兄弟。
    if (parent !== 0 && siblings.length > 1) {
      const chain = siblingChain(siblings).map(group => group.length > 1 ? `{${group.map(taskId => `#${taskId}`).join(' ‖ ')}}` : `#${group[0]}`).join(' → ');
      const band = el('div', `并行关系 ${chain}　并列的可同时跑，箭头表示要等前面结束（上限 ${index.concurrency} 个）`,
        `band d${Math.min(depth, 5)}`);
      band.title = '∥ 表示同一父任务下互相无依赖、可以同时跑；→ 的顺序来自依赖边：⛓ 基线还要求先合并上游。';
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
      const flow = task.parent_id === null && !task.verifies_task_id ? flows.get(task.input_id) : null;
      if (flow) row.append(badge(flow === 'explain' ? '了解' : '开发', flow === 'explain' ? 'b-neutral' : 'b-completed'));
      for (const dep of depsOf(task)) row.append(depChip(dep));
      row.append(el('span', relative(task.updated_at), 'when'));
      node.append(row, el('span', task.goal, 'goal'));
      const why = whyLine(task, index);
      if (why) node.append(el('span', why, 'meta reason'));
      if (integration) node.append(el('span', integration, 'meta'));
      node.title = `${task.goal}\n更新于 ${absolute(task.updated_at)}`;
      ordered.push(node); walk(task.id, depth + 1);
    }
  };
  walk(0, 0);
  syncChildren(container, ordered);
  const active = data.tasks.filter(task => HOT.has(task.status)).length;
  $('task-count').textContent = `${data.tasks.length} 个 · ${active} 进行中`;
}
/** 合并阶梯：该先合哪个、哪些分支已经被别的分支带进来了。 */
function renderLadder(ladder) {
  const nodes = ladder?.nodes || [];
  const section = block('合并阶梯', String(nodes.length));
  if (!nodes.length) { section.append(el('p', '没有待合并的分支。', 'hint')); return section; }
  section.append(el('p', '⛓ code 依赖＝下游 worktree 的基线：必须先合上游，否则下游的分支会把它一起带进来。\n⏳ order 依赖只要求上游结束，所以下游可以先合——那时它有没有把上游带进来由 git 判定。', 'hint'));
  for (const node of nodes) {
    const line = el('div', undefined, `ladder l${Math.min(node.level, 5)}`);
    const row = el('div', undefined, 'row');
    row.append(el('span', `L${node.level}`, 'tid'), el('span', `#${node.id}`, 'tid'),
      button(node.goal, () => detail(node.id), 'link'), el('span', node.branch, 'when'));
    line.append(row);
    for (const dep of node.deps) {
      line.append(el('span', `${dep.kind === 'code' ? '⛓ 必须先合' : '⏳ 只等结束'} #${dep.id}${dep.merged ? '（已合并）' : ''}${dep.kind === 'order' && dep.contains ? '（它的提交已经在你里面）' : ''}`, 'meta'));
    }
    if (node.covered_by.length) line.append(el('span', `⚠ 已经被 #${node.covered_by.join('、')} 带进来：合后者即可，本分支会变成 no-op`, 'meta warn'));
    section.append(line);
  }
  const first = nodes.filter(node => node.level === 0 && !node.covered_by.length).map(node => node.id);
  if (first.length) section.append(el('p', `建议先合 ${first.map(taskId => `#${taskId}`).join('、')}；命令：lush task merge <id>`));
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
  const open = data.notices.filter(notice => notice.status === 'open');
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
    else if (event.type === 'workspace.created') body = [data.branch, data.workspace].filter(Boolean).join(' · ');
    else if (event.type === 'workspace.removed') body = data.branch || '';
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

function transcriptContent(taskId) {
  const state = transcriptCache.get(taskId);
  if (!state) return [el('p', '正在读取会话记录…', 'hint')];
  const meta = el('p', state.steps.length
    ? `${state.steps.length} 步 \u00b7 来自 pi 会话记录：${state.files.join('\u3001')}`
    : (state.files.length ? '会话记录里还没有可显示的步骤。' : '这个任务还没有 pi 会话记录（可能从未被唤醒，或会话文件已被清理）。'), 'hint');
  if (!state.steps.length) return [meta];
  const list = el('ol', undefined, 'steps');
  for (const step of state.steps) {
    const item = el('li', undefined, `step s-${step.kind}`);
    const head = el('div', undefined, 'step-head');
    head.append(el('span', STEP[step.kind] || step.kind, `step-kind k-${step.kind}`), el('span', step.title, 'step-title'));
    if (step.at) head.append(el('span', relative(step.at), 'when'));
    item.append(head);
    if (step.body) item.append(MD_STEP.has(step.kind) ? agentText(step.body, { className: 'step-body' }) : el('div', step.body, 'step-body'));
    list.append(item);
  }
  const actions = el('div', undefined, 'actions');
  if (state.has_more) actions.append(button(`加载更多（已有 ${state.steps.length} 步）`, async () => {
    const page = await api(`/api/task/${taskId}/transcript?after=${state.next}`);
    state.steps.push(...page.steps); state.next = page.next; state.has_more = page.has_more;
    paintTranscript(taskId);
  }, 'ghost'));
  actions.append(button('重新加载', async () => { await loadTranscript(taskId); await detail(taskId); }, 'ghost'));
  return [meta, list, actions, state.truncated ? el('p', '会话记录过大，只读取了前面一部分。', 'hint') : null].filter(Boolean);
}
/** 只替换执行过程区块，避免为了追加一页步骤重建整个详情面板。 */
function paintTranscript(taskId) {
  if (selected !== taskId) return;
  const holder = $('detail').querySelector('.transcript');
  if (holder) holder.replaceChildren(...transcriptContent(taskId));
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
function renderDetail(task, history, diff) {
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
  if (task.status === 'completed' && ['pending', 'review'].includes(task.integration)) actions.append(button(
    task.integration === 'review' ? '检查后重新批准合并' : '批准合并', async () => {
      const warning = stacked.length ? `\n\n本任务 stacked 在 #${stacked.map(edge => edge.id).join('、')} 之上，必须先合并上游，否则会把它的改动一起带进来。` : '';
      if (confirm(`将 ${task.branch} 合并到 ${task.target_branch}？请先审阅代码和测试结果。${warning}`)) await action('task.merge', { id: task.id });
      await detail(task.id);
    }));
  if (['failed', 'cancelled'].includes(task.status)) actions.append(button('检查后重试', async () => { await action('task.retry', { id: task.id }); await detail(task.id); }));
  if (task.status === 'completed' && task.workspace && ['merged', 'none'].includes(task.integration)) actions.append(button('回收 worktree', async () => { await action('task.cleanup', { id: task.id }); await detail(task.id); }, 'ghost'));
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
  if (task.agent) {
    grid.append(kv('agent', `${task.agent.id} · 累计唤醒 ${task.agent.wakes} 次`));
    grid.append(kv('agent 上次动手', task.agent.last_seen_at ? `${absolute(task.agent.last_seen_at)} · ${relative(task.agent.last_seen_at)}` : '—'));
  }
  grid.append(kv(task.status === 'running' ? '本次已运行' : '耗时', duration(task.created_at, task.status === 'running' ? new Date().toISOString() : task.updated_at)));
  grid.append(kv('创建', `${absolute(task.created_at)}`, 'mono'));
  grid.append(kv('最后更新', `${absolute(task.updated_at)} · ${relative(task.updated_at)}`));
  stats.append(grid); panel.append(stats);
  panel.append(renderDeps(task));

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
  if (task.calls) {
    const process = block('执行过程');
    const holder = el('div', undefined, 'transcript');
    const cached = transcriptCache.get(task.id);
    if (cached) holder.replaceChildren(...transcriptContent(task.id));
    else if (transcriptOpen.has(task.id)) holder.append(el('p', '正在读取会话记录…', 'hint'));
    else {
      holder.append(el('p', 'agent 的思考、工具调用与工具输出保存在 pi 会话记录里，默认不展开。', 'hint'));
      const actions = el('div', undefined, 'actions');
      actions.append(button('查看执行过程', async () => {
        transcriptOpen.add(task.id);
        try { await loadTranscript(task.id); } catch (error) { transcriptOpen.delete(task.id); throw error; }
        if (selected === task.id) await detail(task.id);
      }, 'ghost'));
      holder.append(actions);
    }
    process.append(holder);
    panel.append(process);
  }
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
async function detail(taskId) {
  selected = taskId;
  const scrolled = detailTask === taskId ? $('detail').scrollTop : 0;
  // window.history: a local `history` binding here would shadow the global and throw a TDZ error on click.
  if (location.hash !== `#task-${taskId}`) window.history.replaceState(null, '', `#task-${taskId}`);
  let task, timeline, diff;
  try {
    [task, timeline, diff] = await Promise.all([
      api(`/api/task/${taskId}`), loadHistory(taskId).catch(() => ({ events: [], truncated: false })),
      api(`/api/task/${taskId}/diff`).catch(() => null),
    ]);
  } catch (error) {
    if (selected === taskId) renderDetailError(taskId, error.message);
    throw error;
  }
  if (selected !== taskId) return;
  selectedRevision = task.updated_at; detailTask = taskId; detailRenderedAt = Date.now(); detailDirty = false;
  renderDetail(task, timeline, diff);
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
    (data.ladder?.nodes || []).map(node => `${node.id}:${node.level}:${node.deps.length}:${node.covered_by.join('|')}`).join(',')]);
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

  const merges = block('待你批准合并', String(data.status.pending_merges.length));
  if (!data.status.pending_merges.length) merges.append(el('p', '没有待合并的分支。', 'hint'));
  for (const task of data.status.pending_merges) {
    const row = el('div', undefined, 'row');
    row.append(el('span', `#${task.id}`, 'tid'), button(task.goal, () => detail(task.id), 'link'), el('span', task.branch, 'when'));
    merges.append(row);
  }
  panel.append(merges);
  panel.append(renderLadder(data.ladder));
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

  // 一键清空：只删库里已结束的任务；磁盘上的 worktree、分支与会话记录不碰，所以必须二次确认。
  const maintenance = block('维护');
  const live = data.status.tasks.filter(row => HOT.has(row.status)).reduce((sum, row) => sum + row.count, 0);
  if (live) maintenance.append(el('p', `还有 ${live} 个任务没有结束。取消它们或等它们结束之后，才能清空看板。`, 'hint'));
  else if (!data.tasks.length) maintenance.append(el('p', '任务看板是空的。', 'hint'));
  else {
    maintenance.append(el('p', `删除全部 ${data.tasks.length} 个已结束任务，以及 inputs / drafts / notices / events。worktree、分支与 pi 会话记录保留在磁盘上；旧 task id 不会被新任务复用。`, 'hint'));
    const actions = el('div', undefined, 'actions');
    actions.append(button('清空任务看板', async () => {
      if (!confirm(`删除全部 ${data.tasks.length} 个已结束任务？`)) return;
      if (!confirm('再次确认：库里的任务、输入与事件将不可恢复；磁盘上的 worktree 与分支会保留。')) return;
      const result = await action('task.clear');
      selected = null; overviewKey = null;
      window.history.replaceState(null, '', location.pathname);
      await refresh();
      $('error').textContent = `已清空 ${result.cleared.tasks} 个任务、${result.cleared.inputs} 条输入；磁盘上保留 ${result.retained.tasks.length} 个 worktree/分支`;
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
    $('project').textContent = data.status.project;
    $('project').title = data.status.project;
    $('connection').textContent = '已连接'; $('connection').classList.remove('offline');
    $('agents').replaceChildren(slotGauge(data));
    if (offline) { offline = false; $('error').textContent = ''; }
    renderDrafts(data); renderTree(data);
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
await refresh();
const initial = linked(location.hash);
if (initial) { try { await detail(initial); } catch (error) { $('error').textContent = error.message; } }
addEventListener('hashchange', () => { const next = linked(location.hash); if (next && next !== selected) detail(next).catch(error => { $('error').textContent = error.message; }); });
setInterval(refresh, 1500);
