const $ = id => document.getElementById(id);
const STATUS = {
  queued: { label: '排队', icon: '○' }, running: { label: '运行中', icon: '●' },
  waiting: { label: '等子任务', icon: '◐' }, awaiting: { label: '等你决定', icon: '◔' },
  completed: { label: '已完成', icon: '✓' }, failed: { label: '失败', icon: '✗' }, cancelled: { label: '已取消', icon: '⊘' },
};
const INTEGRATION = { pending: '待合并', review: '待复查', merging: '合并中', merged: '已合并' };
const ROLE = { planner: '规划', worker: '执行', coordinator: '协调', research: '调研' };
const EVENTS = {
  created: '创建任务', 'invocation.started': '开始调用', 'invocation.completed': '调用完成',
  message: '收到消息', 'notice.opened': '向你提问', 'notice.answered': '已答复', retry: '重试',
  'workspace.created': '创建 worktree', 'workspace.removed': '回收 worktree',
  'merge.approved': '批准合并', merged: '已合并', 'merge.failed': '合并失败',
  completed: '完成', failed: '失败', cancelled: '取消',
};
const HOT = new Set(['running', 'awaiting', 'waiting', 'queued']);
const TERMINAL_STATUS = new Set(['completed', 'failed', 'cancelled']);
let selected = null, selectedRevision = null, busy = false, offline = false, detailDirty = false, detailTask = null, detailRenderedAt = 0;
let draftCount = 0, draftSignature = null;

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
  $('drafts').replaceChildren(...drafts.map(draft => {
    const item = el('article', undefined, 'draft');
    const actions = el('div', undefined, 'actions');
    actions.append(button('移除', () => action('draft.remove', { id: draft.id }), 'ghost'));
    item.append(el('small', `草稿 #${draft.id}`), el('p', draft.content), actions);
    return item;
  }));
}
function renderTree(data) {
  const container = $('tasks');
  const flows = new Map((data.inputs || []).map(input => [input.id, input.flow]));
  const known = new Map([...container.children].map(node => [Number(node.dataset.id), node]));
  const byParent = new Map();
  for (const task of data.tasks) { const key = task.parent_id || 0; if (!byParent.has(key)) byParent.set(key, []); byParent.get(key).push(task); }
  const ordered = [];
  const walk = (parent, depth) => {
    for (const task of byParent.get(parent) || []) {
      const node = known.get(task.id) || button('', () => detail(task.id), 'task');
      const integration = INTEGRATION[task.integration];
      node.dataset.id = task.id;
      node.className = `task d${Math.min(depth, 5)} s-${task.status}${selected === task.id ? ' selected' : ''}`;
      node.replaceChildren();
      const row = el('span', undefined, 'row');
      row.append(el('span', statusOf(task).icon, `dot c-${task.status}`), el('span', `#${task.id}`, 'tid'),
        el('span', `${statusOf(task).label} · ${ROLE[task.role] || task.role}`), el('span', relative(task.updated_at), 'when'));
      const flow = task.parent_id === null ? flows.get(task.input_id) : null;
      if (flow) row.append(badge(flow === 'explain' ? '了解' : '开发', flow === 'explain' ? 'b-neutral' : 'b-completed'));
      node.append(row, el('span', task.goal, 'goal'));
      if (integration) node.append(el('span', integration, 'meta'));
      const waiting = (task.deps || []).filter(dep => !TERMINAL_STATUS.has(dep.status));
      if (waiting.length) node.append(el('span', `等 ${waiting.map(dep => `#${dep.id}`).join(' ')}`, 'meta'));
      node.title = `${task.goal}\n更新于 ${absolute(task.updated_at)}`;
      ordered.push(node); walk(task.id, depth + 1);
    }
  };
  walk(0, 0);
  syncChildren(container, ordered);
  const active = data.tasks.filter(task => HOT.has(task.status)).length;
  $('task-count').textContent = `${data.tasks.length} 个 · ${active} 进行中`;
}

function renderNotices(data) {
  const open = data.notices.filter(notice => notice.status === 'open');
  $('notice-count').textContent = open.length ? String(open.length) : '无';
  const container = $('notices');
  const known = new Map([...container.children].map(node => [Number(node.dataset.id), node]));
  const nodes = open.map(notice => {
    if (known.has(notice.id)) return known.get(notice.id);
    const form = el('form', undefined, 'notice'); form.dataset.id = notice.id;
    form.append(el('h3', `#${notice.task_id} · ${notice.title}`), el('p', notice.body));
    const answer = el('textarea'); answer.required = true; answer.placeholder = '你的决定'; answer.rows = 2;
    form.append(answer);
    const actions = el('div', undefined, 'actions');
    actions.append(button('回复', async () => { await action('notice.answer', { id: notice.id, answer: answer.value }); form.remove(); }),
      button('转到任务', () => detail(notice.task_id), 'ghost'),
      button('忽略', () => action('notice.dismiss', { id: notice.id }), 'ghost'));
    form.append(actions);
    form.onsubmit = event => { event.preventDefault(); actions.querySelector('button').click(); };
    return form;
  });
  syncChildren(container, nodes);
}

/* ---------- detail ---------- */
function renderHistory(history, { running = false, truncated = false } = {}) {
  const list = el('ol', undefined, 'timeline');
  history.forEach((event, index) => {
    const item = el('li', undefined, `e-${event.type.replaceAll('.', '-')}${running && index === history.length - 1 ? ' hot' : ''}`);
    const head = el('div'); head.append(el('strong', EVENTS[event.type] || event.type), el('span', `${relative(event.created_at)} · ${absolute(event.created_at)}`, 't-when'));
    item.append(head);
    const data = event.data || {}; let body = '';
    if (event.type === 'invocation.started') body = `第 ${data.call ?? '?'} 次调用${data.cwd ? ` · ${data.cwd}` : ''}`;
    else if (event.type === 'invocation.completed' || event.type === 'completed' || event.type === 'failed') body = String(data.result || data.error || '').slice(0, 600);
    else if (event.type === 'created') body = `${ROLE[data.role] || data.role}${data.parent_id ? ` ← #${data.parent_id}` : ' · 根任务'}`;
    else if (event.type === 'message') body = String(data.body || '').slice(0, 400);
    else if (event.type === 'notice.opened') body = data.title || '';
    else if (event.type === 'notice.answered') body = data.dismiss ? '已忽略' : String(data.answer || '');
    else if (event.type === 'workspace.created') body = [data.branch, data.workspace].filter(Boolean).join(' · ');
    else if (event.type === 'workspace.removed') body = data.branch || '';
    else if (event.type === 'merged' || event.type === 'merge.approved') body = short(data.commit);
    else if (event.type === 'merge.failed') body = data.error || '';
    else body = Object.keys(data).length ? JSON.stringify(data).slice(0, 300) : '';
    if (body) item.append(el('div', body, 't-body'));
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
    if (step.body) item.append(el('div', step.body, 'step-body'));
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
function renderDetail(task, history, diff) {
  const panel = $('detail'); panel.replaceChildren();
  const head = el('div', undefined, 'head');
  head.append(el('span', `#${task.id}`, 'tid-lg'), statusBadge(task),
    badge(ROLE[task.role] || task.role, 'b-neutral'), badge(`输入 #${task.input_id}`, 'b-neutral'));
  const integration = INTEGRATION[task.integration];
  if (integration) head.append(badge(integration, task.integration === 'merged' ? 'b-completed' : 'b-awaiting'));
  if (task.agent) head.append(badge(`agent ${task.agent.id}${task.agent.active ? ` · pid ${task.agent.pid ?? '待上报'}` : ' · 空闲'}`, 'b-neutral'));
  panel.append(head);

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
  if (!['completed', 'failed', 'cancelled'].includes(task.status)) actions.append(button('取消任务树', async () => {
    if (confirm('取消这个任务及所有子任务？工作区会保留。')) await action('task.cancel', { id: task.id });
    await detail(task.id);
  }, 'danger'));
  if (task.parent_id === null) actions.append(
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

  if (task.result) { const result = block('结果'); result.append(el('pre', task.result)); panel.append(result); }
  if (task.error) { const error = block('错误'); error.append(el('pre', task.error, 'error')); panel.append(error); }
  if (task.integration_error) { const error = block('合并错误'); error.append(el('pre', task.integration_error, 'error')); panel.append(error); }
  if (task.branch || task.workspace) {
    const workspace = block('工作区');
    workspace.append(el('p', [task.branch, task.workspace].filter(Boolean).join('\n'), 'mono'));
    panel.append(workspace);
  }
  panel.append(renderDiff(diff));

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
    data.status.project, data.status.version, data.status.fingerprint, data.status.started_at]);
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

  const notices = block('待决问题', String(open.length));
  if (!open.length) notices.append(el('p', '没有等你决定的问题。', 'hint'));
  for (const notice of open) {
    const row = el('div', undefined, 'row');
    row.append(el('span', `#${notice.task_id}`, 'tid'), button(notice.title, () => detail(notice.task_id), 'link'));
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
}

/* ---------- polling ---------- */
async function refresh() {
  if (busy) return; busy = true;
  try {
    const data = await api('/api/snapshot');
    $('project').textContent = data.status.project;
    $('project').title = data.status.project;
    $('connection').textContent = '已连接'; $('connection').classList.remove('offline');
    $('agents').textContent = `${data.status.agents.length} 运行 · ${data.status.agents_idle ?? 0} 空闲 · 并发 ${data.status.concurrency}`;
    if (offline) { offline = false; $('error').textContent = ''; }
    renderDrafts(data); renderTree(data); renderNotices(data); syncComposer();
    if (selected === null) renderOverview(data);
    const current = data.tasks.find(task => task.id === selected);
    const editing = detailDirty || [...$('detail').querySelectorAll('textarea')].some(node => node.value || node === document.activeElement);
    if (current && !editing) {
      // Live tasks also refresh on a slow tick so elapsed time and agent pid stay honest.
      const changed = current.updated_at !== selectedRevision;
      const tick = HOT.has(current.status) && Date.now() - detailRenderedAt > 15000;
      if (changed || tick) await detail(selected);
    }
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
