import { $, badge, button, el, roleBadge } from './dom.js';
import { api, action } from './api.js';
import { confirmDialog, promptDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { absolute, INTEGRATION, statusOf, worktreeLabel } from './format.js';
import { show } from './messages.js';
import { detail } from './navigate.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { scopedKey } from './prefs.js';
import { taskForest } from './task-graph-layout.js';
import { branchDiagnostics, decisionRow, runOrchestrate, runOrchestrateCancel } from './render-graph.js';
import { renderGraphProgress } from './render-progress.js';
import { deliveryControls } from './render-delivery.js';

const KEY = 'lush.taskGraph.collapsed';
const ACTIVE = new Set(['running', 'queued', 'waiting', 'awaiting']);
const ENDED = new Set(['completed', 'failed', 'cancelled']);
/** 状态计数 / 图例的固定顺序：先是活动态，再到终结态；只画出现过的。 */
const STATUS_ORDER = ['running', 'queued', 'waiting', 'awaiting', 'completed', 'failed', 'cancelled'];
/** 图上画成卡片的 Task：自己拥有分支 / worktree 的 main / owner / say / child。
 *  planner / scheduler 属于意图层（在分支图上），merge 是中间层，见 mergeQueueActive。 */
const VISIBLE_KINDS = new Set(['say', 'child', 'main', 'owner']);
/** 在飞的合并预约：已预约等静息 / 已发请求待落地 / 已退回源侧解分歧。 */
const IN_FLIGHT = new Set(['pending', 'requested', 'resolving']);

/** merge Task 是父 Task 的常驻合并队列身份（`parent_id` 就是那个父 Task），只有队列真在动时才值得占一张卡片：
 *  自己还没结算，或名下还有请求在飞。队列空闲时整层收起，被它收拢的子 Task 回到父 Task 下，不留空壳。 */
function mergeQueueActive(node, children) {
  if (!ENDED.has(node.status)) return true;
  return children.some(child => !ENDED.has(child.status) || IN_FLIGHT.has(child.reservation?.status));
}

/** merge 卡片的队列摘要：谁先落地以库为准（`driveTaskMerge` 取 id 最小的 requested），展示层不猜。 */
function mergeQueueNotes(raw) {
  const queues = new Map();
  for (const node of raw) {
    if (node.task_kind !== 'merge') continue;
    const inFlight = raw.filter(child => child.parent_id === node.id && IN_FLIGHT.has(child.reservation?.status))
      .sort((a, b) => a.id - b.id);
    const requested = inFlight.filter(child => child.reservation.status === 'requested');
    const resolving = inFlight.filter(child => child.reservation.status === 'resolving');
    const pending = inFlight.length - requested.length - resolving.length;
    const parts = [];
    if (requested.length) parts.push(`${requested.length} 条已发请求待落地（正在处理 #${requested[0].id}）`);
    if (pending) parts.push(`${pending} 条已预约、等静息`);
    if (resolving.length) parts.push(`${resolving.length} 条源侧解分歧中（#${resolving.map(child => child.id).join('、#')}）`);
    if (parts.length) queues.set(node.id, `合并队列：${parts.join(' · ')}`);
  }
  return queues;
}

function collapsed() {
  try { const saved = JSON.parse(localStorage.getItem(scopedKey(KEY))); return new Set(Array.isArray(saved) ? saved : []); }
  catch { return new Set(); }
}
function save(set) { try { localStorage.setItem(scopedKey(KEY), JSON.stringify([...set])); } catch { /* storage unavailable */ } }

/** 归档后的 Task：分支已归档（合并队列收尾时自动发生）。归档是记录状态，任务行仍在库里，
 *  只是默认不再占 Task 图主视图；这里只认读模型给出的字段，不自己猜 Git 现状。 */
function isArchivedTask(node) {
  return node.branch_info?.archived === true || node.archived === true;
}

/** 卡片颜色口径：running 最醒目，其余按真实状态各自一色（排队 / 在等 / 待你 / 完成 / 失败 / 取消）；
 *  只有既非活动也没有明确终结语义的才落到 idle。看板一眼能分清「正在跑」和「停下来了」。 */
function taskVisualState(node) {
  if (node.status === 'running') return 'running';
  if (node.status === 'awaiting' || node.notice) return 'awaiting';
  if (node.status === 'failed') return 'failed';
  if (node.status === 'queued') return 'queued';
  if (node.status === 'waiting') return 'waiting';
  if (node.status === 'completed') return 'completed';
  if (node.status === 'cancelled') return 'cancelled';
  return 'idle';
}

/** Task 级的合并编排入口：目标就是这条 Task 自己的分支，复用分支图同一份只读计划与 runtime。
 *  没有子 say 分支就没有可收拢的对象，不给入口；已有运行改显进度 + 取消；被别的 merger / 一键合并
 *  冻结时禁用并写明原因。delivery 冻结正是「有待集成的合并请求」，不挡编排。 */
function taskOrchestration(node) {
  const info = node.branch_info;
  if (!info || info.archived) return null;
  const run = info.merge_run;
  const box = el('section', undefined, 'task-graph-orchestrate');
  if (run) {
    const done = run.done ?? 0;
    const total = run.total ?? 0;
    box.append(el('span', `合并编排中 · ${done}/${total}${run.status === 'paused' ? '（源侧解分歧中）' : ''}`,
      'chip graph-work run'));
    box.append(button('取消合并编排', () => runOrchestrateCancel({ name: node.branch },
      { refresh: loadTaskGraph, scope: `Task #${node.id}` }), 'ghost',
      { help: '停止这条 Task 分支的合并编排并释放冻结；已落地的合并不回滚，等待中的解分歧子任务会被取消。' }));
    return box;
  }
  if (!info.subtree_say) return null;
  if (node.freeze && node.freeze.kind !== 'delivery') {
    const disabled = el('button', '编排合并全部子 Task', 'ghost');
    disabled.type = 'button'; disabled.disabled = true;
    const host = el('span', undefined, 'help-host');
    host.setAttribute('data-help', `合并编排暂时不可用：${node.freeze.reason}。`);
    host.append(disabled); box.append(host);
    return box;
  }
  box.append(button('编排合并全部子 Task', () => runOrchestrate({ name: node.branch },
    { refresh: loadTaskGraph, label: '子 Task', taskLabel: 'Task', scope: `Task #${node.id}` }), 'ghost',
    { agent: true, help: agentHelp(`按叶子到根自动把 Task #${node.id} 下所有已固定提交的子 Task 合并请求 ff-only 收拢进 ${node.branch}；没有请求但符合条件的会先自动补发固定提交请求；遇分歧自动派源侧解分歧子任务；运行期间冻结 ${node.branch} 及其全部后代，耗时较长并消耗 token。`) }));
  return box;
}

/**
 * 「合并所有」的候选：目标分支就是这条 Task、已静息且仍待集成的 say/child。展示层只做只读筛选
 * （v2 预约 JSON 不在图里展开，所以按状态 + 集成口径判断），真正能不能发出请求由 runtime 的
 * `task.reserve_all` → `reserveMergeAll` 再逐条校验一次。
 */
function mergeAllCandidates(graph) {
  const byBranch = new Map();
  for (const node of graph.nodes || []) {
    if (!['say', 'child'].includes(node.task_kind)) continue;
    if (node.status !== 'waiting' || node.integration !== 'pending') continue;
    if (!node.target_branch) continue;
    if (node.reservation?.kind && node.reservation.kind !== 'merge') continue;
    const list = byBranch.get(node.target_branch) ?? [];
    list.push({ id: node.id, title: node.title });
    byBranch.set(node.target_branch, list);
  }
  return byBranch;
}

/**
 * 分支所有者卡片上的「合并所有」：把这条分支下所有已静息、待合并的 Task 一次性交给父 Task 的 merge
 * 子任务串行处理。没有候选时也保留按钮并写明原因，选项不因当前状态整块消失。
 */
function mergeAllControl(node, candidates, refresh) {
  const box = el('section', undefined, 'task-graph-merge-all');
  if (!candidates.length) {
    const disabled = el('button', '合并所有', 'ghost');
    disabled.type = 'button'; disabled.disabled = true;
    const host = el('span', undefined, 'help-host');
    host.setAttribute('data-help', `这条分支下没有已静息、待合并的 Task；等 Task 完成并静息后再刷新。`);
    host.append(disabled); box.append(host);
    return box;
  }
  box.append(button(`合并所有（${candidates.length}）`, async () => {
    const detail = candidates.map(item => `#${item.id} ${item.title}`).join('\n');
    const confirmed = await confirmDialog({
      title: `把 ${node.branch} 下 ${candidates.length} 条待合并 Task 一并放入 merge 队列？`,
      message: '逐个请求合并；父 Task 的 merge 子任务一次只落地一条，其余请求按序排队。与父分支分歧的 Task 会自动唤醒其 Agent 在源侧合入固定父提交并测试，修好后继续合并。已发出的请求不能批量撤销；分支与提交不会因失败丢失。',
      detail,
      confirmLabel: '开始合并',
      confirmHelp: agentHelp('按顺序自动合并所有已静息的待合并 Task；发生分歧时会唤醒对应 Task 的 Agent。'),
      agent: true,
    });
    if (!confirmed) return;
    const result = await action('task.reserve_all', { branch: node.branch });
    const bits = [`共 ${result.total} 条`];
    if (result.requested) bits.push(`${result.requested} 条已发出请求`);
    if (result.blocked) bits.push(`${result.blocked} 条仍在等待条件`);
    if (result.failed) bits.push(`${result.failed} 条失败`);
    show(`已把 ${node.branch} 的待合并 Task 放入 merge 队列：${bits.join('、')}。`);
    await refresh();
  }, 'ghost', { agent: true, help: agentHelp(`一次性请求合并 ${node.branch} 下全部已静息、待合并的 Task；由父 Task 的 merge 子任务串行处理，分歧时唤醒对应 Agent。`) }));
  return box;
}

function taskCard(node, folded, refresh, mergeAllByBranch = new Map(), queueNote = null) {
  const row = el('article', undefined, 'task-graph-card');
  row.dataset.taskId = String(node.id);
  row.classList.add(`task-graph-${taskVisualState(node)}`);
  const head = el('div', undefined, 'task-graph-head');
  if (node.children.length) {
    const toggle = button(folded.has(node.id) ? '▸' : '▾', () => {
      if (hasPendingInput()) { show('请先提交或清空正在编辑的待决答复，再折叠 Task。'); return; }
      if (folded.has(node.id)) folded.delete(node.id); else folded.add(node.id);
      save(folded); refresh();
    }, 'ghost', { help: `展开或收起 Task #${node.id} 的 ${node.children.length} 条直接子任务` });
    toggle.setAttribute('aria-expanded', String(!folded.has(node.id)));
    head.append(toggle);
  }
  const title = button(`#${node.id} ${node.title}`, () => detail(node.id), 'ghost');
  title.classList.add('task-graph-title');
  head.append(title, roleBadge(node.role), badge(node.status === 'waiting' && !node.children_active ? '静息' : statusOf(node).label,
    `b-${node.status}`));
  // 分支合并状态放进卡片首行的标签：与任务状态并排，一眼看清这条 Task 的改动合进父分支没有。
  // 用与任务详情同一份 INTEGRATION 文案与配色；none（没有独有提交）/ 未知值不占位。
  const merge = INTEGRATION[node.integration];
  if (merge) head.append(badge(merge, node.integration === 'merged' ? 'b-completed' : 'b-awaiting'));
  if (node.task_kind) head.append(badge(node.task_kind));
  if (node.freeze && node.freeze.task_id !== node.id) head.append(badge(node.status === 'running' ? '安全点后冻结' : '冻结', 'warn'));
  if (node.notice_count) head.append(badge(`${node.notice_count} 条待决`, 'b-awaiting'));
  row.append(head);

  if (node.goal_preview && node.goal_preview !== node.title) row.append(el('p', node.goal_preview, 'task-graph-goal'));
  if (node.waiting_reason) row.append(el('p', node.waiting_reason, 'task-graph-reason'));
  if (queueNote) row.append(el('p', queueNote, 'task-graph-reason'));
  if (node.result_preview) row.append(el('p', `最近结果：${node.result_preview}${node.result_preview.length >= 320 ? '…' : ''}`, 'task-graph-result'));
  const progress = renderGraphProgress(node.progress, { running: node.status === 'running', status: node.status });
  if (progress) row.append(progress);

  const facts = el('div', undefined, 'task-graph-facts');
  if (node.resolves_task_id) facts.append(button(`正在解决 Task #${node.resolves_task_id}`, () => detail(node.resolves_task_id), 'ghost',
    { help: '这是被修复的源 Task；父子连线表示负责收敛的 Task，不会改写已终结源 Task 的血缘。' }));
  if (node.branch) facts.append(el('span', `分支：${node.branch}`, 'mono'));
  if (node.target_branch) facts.append(el('span', `父分支：${node.target_branch}`, 'mono'));
  if (node.base_commit) facts.append(el('span', `任务基线：${node.base_commit.slice(0, 12)}`, 'mono'));
  if (node.head_commit) facts.append(el('span', `固定提交：${node.head_commit.slice(0, 12)}`, 'mono'));
  if (node.workspace) facts.append(el('span', `${worktreeLabel(node)}：${node.workspace}`, 'mono'));
  if (node.workspace_state === 'missing') facts.append(badge('⚠ worktree 缺失', 'warn'));
  if (!node.branch && !node.workspace) facts.append(el('span', '无独立分支 / worktree', 'meta'));
  if (node.branch_info?.archived) facts.append(badge('分支已归档'));
  if (node.delivery) facts.append(badge(`交付：${node.delivery.kind} · ${node.delivery.status}`));
  if (node.has_rule) facts.append(badge('固定输入规则'));
  if (node.children_total) facts.append(el('span', `子 Task：${node.children_total}${node.children_active ? `（${node.children_active} 活动）` : ''}`, 'meta'));
  if (Number.isInteger(node.calls) && node.calls) facts.append(el('span', `Agent 调用 ${node.calls} 次`, 'meta'));
  if (node.created_at) facts.append(el('span', `创建 ${absolute(node.created_at)}`, 'meta'));
  if (node.updated_at) facts.append(el('span', `更新 ${absolute(node.updated_at)}`, 'meta'));
  row.append(facts);
  if (node.integration_error) row.append(el('p', `集成受阻：${node.integration_error}`, 'hint'));
  if (node.task_kind !== 'say' && node.delivery?.blocked_reason) row.append(el('p', `交付受阻：${node.delivery.blocked_reason}`, 'hint'));
  if (node.parent_id && !ui.taskGraphIds?.has(node.parent_id)) row.append(el('p', `父 Task #${node.parent_id} 不在当前图中`, 'hint'));

  if (node.branch_info && !node.branch_info.archived) {
    const branch = node.branch_info;
    const git = el('section', undefined, 'task-graph-git');
    const header = el('div', '分支诊断', 'task-graph-git-head');
    if (branch.current_head) header.append(el('span', `HEAD ${branch.current_head.slice(0, 12)}`, 'mono'));
    else header.append(el('span', '当前分支 ref 不可用', 'warn'));
    if (branch.current_head && node.head_commit && branch.current_head !== node.head_commit) {
      header.append(el('span', `与 Task 固定提交 ${node.head_commit.slice(0, 12)} 不同`, 'warn'));
    }
    git.append(header);
    if (branch.diagnostics) git.append(branchDiagnostics({ name: node.branch, diagnostics: branch.diagnostics }));
    else git.append(el('p', '分支诊断不可用，不能推断工作区干净或已合并。', 'hint'));
    row.append(git);
  }

  if (node.notice) {
    if (['question', 'plan'].includes(node.notice.kind)) {
      // Same decision controls as the branch graph, but refresh this Task view after a response.
      const decision = decisionRow(node, loadTaskGraph);
      if (node.notice.body?.length >= 1000) decision.append(el('p', '正文仅显示前 1000 字；完整内容请打开 Task 详情。', 'hint'));
      row.append(decision);
    } else {
      const pending = el('div', undefined, 'graph-decision');
      pending.append(el('strong', node.notice.title || '等待你回答问卷'),
        el('p', '这条待决事项需要在 Task 详情完成问卷；图中不会把选项误当作普通文字答复。', 'hint'),
        button('打开待决事项', () => detail(node.id), 'ghost', { help: '到 Task 详情查看完整问题与选项并答复。' }));
      row.append(pending);
    }
  }
  if (['main', 'owner'].includes(node.task_kind) && node.branch)
    row.append(mergeAllControl(node, mergeAllByBranch.get(node.branch) ?? [], loadTaskGraph));
  const controls = deliveryControls(node, { refresh: loadTaskGraph });
  if (controls) row.append(controls);
  if (['say', 'child'].includes(node.task_kind) && !ENDED.has(node.status)) {
    row.append(button('向此 Task 输入', async () => {
      const body = await promptDialog({ title: `发给 Task #${node.id}`, label: '输入', confirmLabel: '发送消息',
        confirmHelp: agentHelp('把输入交给这条 Task；固定规则可请求 Agent 在安全点提前收尾，否则轮末投递。'), agent: true });
      if (!body) return;
      await action('task.message', { id: node.id, body });
      show(`已提交给 Task #${node.id}`);
      await loadTaskGraph();
    }, 'ghost', { agent: true, help: agentHelp('给这个 Task 的 Agent 发送输入；可能在安全点提前收尾，不会立即硬杀。') }));
  }
  return row;
}

export function renderTaskGraph(graph) {
  if (ui.view?.id !== 'task-graph') return;
  const raw = graph.nodes || [];
  const byId = new Map(raw.map(node => [node.id, node]));
  const childrenOf = new Map();
  for (const node of raw) {
    if (node.parent_id === null || node.parent_id === undefined) continue;
    const list = childrenOf.get(node.parent_id);
    if (list) list.push(node); else childrenOf.set(node.parent_id, [node]);
  }
  const visible = new Set(raw.filter(node => VISIBLE_KINDS.has(node.task_kind)).map(node => node.id));
  for (const node of raw) {
    if (node.task_kind === 'merge' && mergeQueueActive(node, childrenOf.get(node.id) ?? [])) visible.add(node.id);
  }
  // 被收起的中间 Task 不制造孤儿：父指到最近的可见祖先，所以 merge 空闲时它的子 Task 回到原父 Task 下。
  // 祖先都不在这一页（被截断 / 真的缺节点）时保留原 parent_id，照旧画成根并写明「父 Task 不在当前图中」。
  const parentInView = node => {
    const seen = new Set([node.id]);
    for (let parent = byId.get(node.parent_id); parent && !seen.has(parent.id); parent = byId.get(parent.parent_id)) {
      if (visible.has(parent.id)) return parent.id;
      seen.add(parent.id);
    }
    return node.parent_id ?? null;
  };
  const all = raw.filter(node => visible.has(node.id)).map(node => ({ ...node, parent_id: parentInView(node) }));
  const mergeQueue = mergeQueueNotes(raw);
  const full = { ...graph, nodes: all };
  // 归档 Task 默认不画：它们是收尾后的记录，收进「显示已归档」开关后面，避免压住仍在进行的工作。
  // 过滤在 taskForest 之前完成，所以归档父节点下的未归档子 Task 会像分支图那样顶成根，不会一起消失。
  const archivedCount = all.filter(isArchivedTask).length;
  const nodes = ui.taskGraphShowArchived ? all : all.filter(node => !isArchivedTask(node));
  const view = { ...full, nodes };
  const host = $('detail');
  const saved = collapsed();
  const forest = taskForest(view);
  const mergeAllByBranch = mergeAllCandidates(view);
  // 用 all 而不是 nodes：可见子 Task 的父 Task 可能只是被归档藏起来，不该被说成「不在当前图中」。
  ui.taskGraphIds = new Set(all.map(node => node.id));
  const box = el('div', undefined, 'task-graph');
  const hero = el('header', undefined, 'resource-hero task-graph-hero');
  hero.append(el('h1', 'Task 图'), el('p', 'Task 包裹 Agent、分支与 worktree；连线表示父子关系。代码集成由直接父 Agent 或用户按固定提交批准。'));
  const summary = el('div', undefined, 'task-graph-summary');
  const active = nodes.filter(node => ACTIVE.has(node.status)).length;
  const decisions = nodes.reduce((count, node) => count + (node.notice_count || 0), 0);
  const counts = new Map();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) || 0) + 1);
  summary.append(badge(`图中 ${nodes.length} / ${graph.total} Task`), badge(`${active} 活动`));
  // 状态计数本身兼作图例：running 的活动色与卡片左边条同源，扫一眼就知道每种颜色代表什么。
  for (const status of STATUS_ORDER) {
    const count = counts.get(status) || 0;
    if (!count) continue;
    const info = statusOf({ status });
    summary.append(badge(`${info.icon} ${info.label} ${count}`, `b-${status}`));
  }
  if (decisions) summary.append(badge(`${decisions} 待决`, 'b-awaiting'));
  if (archivedCount) {
    const toggle = button(ui.taskGraphShowArchived ? `隐藏已归档（${archivedCount}）` : `显示已归档（${archivedCount}）`, () => {
      ui.taskGraphShowArchived = !ui.taskGraphShowArchived;
      renderTaskGraph(full);
    }, 'ghost', { help: '归档 Task 是分支合并收尾后自动隐藏的记录；这里只在当前页面显示，不写库、不改任务状态，重开页面仍默认隐藏。' });
    toggle.classList.add('task-graph-archived-toggle');
    summary.append(toggle);
  }
  hero.append(summary, button('刷新', () => loadTaskGraph(), 'ghost'));
  box.append(hero);
  if (view.truncated) box.append(el('p', `只显示最近及活动的 ${nodes.length} / ${graph.total} 条 Task；父节点可能在截断范围外。`, 'hint'));
  const paint = (node, parent) => {
    const wrap = el('div', undefined, 'task-graph-node');
    wrap.append(taskCard(node, saved, () => renderTaskGraph(full), mergeAllByBranch, mergeQueue.get(node.id) ?? null));
    if (node.children.length && !saved.has(node.id)) {
      const children = el('div', undefined, 'task-graph-children');
      for (const child of node.children) paint(child, children);
      wrap.append(children);
    }
    parent.append(wrap);
  };
  for (const node of forest) paint(node, box);
  host.replaceChildren(box);
}

let pending = null;
export async function loadTaskGraph() {
  const view = ui.view;
  if (!pending) pending = api('/api/task-graph').finally(() => { pending = null; });
  const graph = await pending;
  if (ui.view === view) {
    ui.taskGraphFetchedAt = Date.now();
    if (!hasPendingInput()) renderTaskGraph(graph);
  }
  return graph;
}
function hasPendingInput() {
  for (const node of $('detail').querySelectorAll('textarea')) {
    if (node.value || node === document.activeElement) return true;
  }
  return false;
}
export async function openTaskGraph() {
  activateDetailView({ view: 'task-graph' });
  try { await loadTaskGraph(); }
  catch (error) { if (ui.view?.id === 'task-graph') $('detail').textContent = `Task 图加载失败：${error.message}`; throw error; }
}
