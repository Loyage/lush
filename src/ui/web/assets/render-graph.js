/**
 * 「分支图」视图：拉 `/api/graph` 画到 `#detail`，展示分支谱系（分支节点 + fork 父子嵌套）
 * 与每条分支下的任务 / worktree / 目标分支关系，以及任务之间的堆叠（code）/顺序（order）/
 * 解冲突（resolve）/检验（verify）关系。
 *
 * 视图只读展示，写操作只有四个按钮：父分支关系上的「合入父分支」/「让子分支跟上父分支」/
 * 「在子分支解决分歧」，以及可归档分支上的「归档」，分别与 CLI 的 `branch merge` / `branch catchup` /
 * `branch sync` / `branch archive` 同源；节点点击只跳任务详情。
 * 幂等：同一份数据重画不重复建节点、不重建外层容器，所以 1.5s 轮询不会把滚动位置冲掉。
 */
import { $, button, el } from './dom.js';
import { api, action } from './api.js';
import { ROLE, statusOf } from './format.js';
import { graphLayout, graphFingerprint, graphRenderKey, edgeRelation, emphasisClasses, isBranchCollapsed, isWorkingTask } from './graph-layout.js';
import { detail, overview } from './navigate.js';
import { saveGraphPrefs, ui } from './state.js';

/** 分支状态映射：状态 -> { label, className }；已合进父分支是常态，不再单独出一个「已合并」标签。 */
const BRANCH_STATUS = {
  active: { label: '进行中', className: 'ok' },
  failed: { label: '失败', className: 'warn' },
  ready: { label: '待合并', className: '' },
  empty: { label: '空', className: '' },
  archived: { label: '已归档', className: '' },
};

/** 分支来源映射：来源 -> 中文描述 */
const BRANCH_ORIGIN = {
  input: '输入锚点',
  task: '任务分支',
  registered: '已登记',
  local: '本地分支',
  placeholder: '占位',
};

let pending = null;

/** 打开分支图：清掉选中的任务详情（否则热任务刷新会把图覆盖掉），并把地址栏切到 #graph。 */
export async function openGraph() {
  ui.graphOpen = true;
  ui.docsOpen = false;   // 右栏同一时刻只归一个视图
  ui.selected = null; ui.selectedRevision = null; ui.detailDirty = false; ui.detailTask = null;
  if (location.hash !== '#graph') window.history.pushState(null, '', '#graph');
  await loadGraph();
}

/** 重新拉一次图并渲染；同一时刻只允许一个请求在飞，并发调用共享同一个 promise。 */
export function loadGraph() {
  if (!pending) {
    pending = (async () => {
      try {
        const graph = await api('/api/graph');
        ui.graphFetchedAt = Date.now();
        ui.graphFingerprint = graphFingerprint(ui.lastSnapshot);
        renderGraph(graph, { force: true });
        return graph;
      } finally { pending = null; }
    })();
  }
  return pending;
}

const LANE_CLASS = level => `graph-node l${Math.min(Number(level) || 0, 6)}`;

/** 任务行。`owningBranch` 是包裹它的那条分支：任务就在这条分支上时不再重复写一遍分支名（表头已经写了）；
 *  只有当任务退到目标分支分组（自己那条分支没有节点）或兜底分组时，分支名才是独有信息，必须画出来。 */
function taskRow(node, owningBranch = null) {
  const row = el('div', undefined, LANE_CLASS(node.level));
  // 在跑 / 排队 / 等着的任务同样带上工作态强调，和它所在的分支一起被看见。
  if (isWorkingTask(node)) row.classList.add('graph-emphasis-working');
  row.append(el('span', `#${node.id}`, 'tid'));
  row.append(button(node.goal || '(无目标)', () => detail(node.id), 'graph-node'));
  row.append(el('span', `${ROLE[node.role] || node.role} · ${statusOf(node).label}`, 'meta'));
  const meta = el('div', undefined, 'graph-meta');
  if (node.upstreams?.length) meta.append(el('span', `⛓ 基线 #${node.upstreams.join('、#')}`, 'meta'));
  if (node.branch && node.branch !== owningBranch) meta.append(el('span', node.branch, 'graph-path mono'));
  if (node.workspace) meta.append(el('span', node.workspace, 'graph-path mono'));
  if (node.aheadBehind) meta.append(el('span', node.aheadBehind, 'meta'));
  for (const mark of node.marks || []) meta.append(el('span', mark.text, `chip ${mark.className}`.trim()));
  row.append(meta);
  return row;
}

/** 父分支上的三个动作：合入父分支 / 让子分支跟上父分支 / 在子分支解决分歧。
 *  失败只写进错误栏，不抛到页面上；成功后重拉一次图，颜色与按钮随之更新。 */
async function runBranchAction(method, branch) {
  try {
    const result = await action(method, { branch });
    $('error').textContent = method === 'branch.sync'
      ? `已为 ${branch} 创建同步任务 #${result.task.id}`
      : method === 'branch.catchup'
        ? (result.already_integrated ? `${branch} 已经与父分支一致，无需快进` : `${branch} 已 fast-forward 跟上 ${result.parent}`)
      : (result.needs_sync ? `${branch} 已与父分支分歧，请先在子分支侧解决分歧`
        : result.already_integrated ? `${branch} 已经在 ${result.parent} 中` : `${branch} 已 fast-forward 合入 ${result.parent}`);
    await loadGraph();
  } catch (error) { $('error').textContent = error.message; }
}

/** 归档：删掉分支与 worktree，任务与会话留在库里；未提交改动只能连 worktree 一起丢，所以先确认。 */
async function runBranchArchive(branch) {
  if (!confirm(`归档 ${branch}？\n会删除分支与 worktree，保留任务与会话，未提交改动会被丢弃。`)) return;
  try {
    const result = await action('branch.archive', { branch, discard: true });
    const dropped = result?.discarded ? '，已丢弃未提交改动' : '';
    $('error').textContent = `${branch} 已归档（worktree ${result?.worktree ?? 'absent'}、分支 ${result?.ref ?? 'absent'}${dropped}）；任务与会话已保留`;
    await loadGraph();
  } catch (error) { $('error').textContent = error.message; }
}

/** 动作按钮：能执行就接上 RPC；暂时不能执行也照画，但禁用并把原因写进 title——
 *  选项不该因为当前状态不对就整块消失，否则用户只会看到「这里什么都没有」。 */
function branchAction(label, title, run) {
  const node = run ? button(label, run, 'ghost graph-branch-action') : el('button', label, 'ghost graph-branch-action');
  if (!run) { node.type = 'button'; node.disabled = true; }
  node.title = title;
  return node;
}

/**
 * 父子关系的处理选项（文案与颜色都来自 edgeRelation 的 key）：
 * - 领先：合入父分支（子 → 父 fast-forward）；
 * - 落后：让子分支跟上父分支（父 → 子 fast-forward，不产生 merge commit）；
 * - 分歧：在子分支解决分歧（开一个 merger 任务把父分支合进子分支），合入父分支同时摆出来但禁用；
 * - 有未收拢的子分支时运行时两边都会拒绝，所以按钮禁用，并在 title 里列出 blocker。
 */
function forkActions(branch, edge) {
  if (!edge) return [];
  const blocked = edge.blockers?.length ? `未收拢的子分支：${edge.blockers.join('、')}` : null;
  const why = (reason, extra = null) => [reason, extra, blocked].filter(Boolean).join('\n');
  const nodes = [];
  if (edge.status === 'fast_forward') {
    nodes.push(branchAction('合入父分支', why(`把 ${branch.name} fast-forward 合入父分支；不会在父分支上产生 merge commit。`),
      edge.can_merge ? () => runBranchAction('branch.merge', branch.name) : null));
  }
  if (edge.status === 'diverged') {
    nodes.push(branchAction('在子分支解决分歧',
      why(`开一个 merger 任务，把父分支合进 ${branch.name} 并解决冲突；先不动父分支。`,
        `父分支已有 ${Number.isFinite(edge.behind) ? edge.behind : '?'} 个提交不在本分支。`),
      edge.can_sync ? () => runBranchAction('branch.sync', branch.name) : null));
    nodes.push(branchAction('合入父分支', why('父子已分歧：先在子分支解决分歧，之后才能合入。'), null));
  }
  if (edge.status === 'integrated' && edge.behind > 0) {
    nodes.push(branchAction('让子分支跟上父分支',
      why(`把父分支已有的 ${edge.behind} 个提交 fast-forward 进 ${branch.name}；不产生 merge commit，也不改父分支。`),
      edge.can_catchup ? () => runBranchAction('branch.catchup', branch.name) : null));
  }
  return nodes;
}

/**
 * 收起整棵子树（自己的任务 + 全部子分支）：只改这一个 block 的 class 与 aria，不重画整张图，
 * 所以滚动位置和键盘焦点都不会丢。约定与左侧区块抽屉一致：`.collapsed` 由 CSS 藏内容，箭头同步翻转。
 * 初始值来自 isBranchCollapsed：用户的显式切换优先，否则未合进父分支 / 在跑的分支默认展开。
 */
function collapseCaret(branch, onCollapsed) {
  const caret = el('button', undefined, 'graph-caret');
  caret.type = 'button';
  const collapsedNow = () => isBranchCollapsed(branch, ui.graphExpanded, ui.graphCollapsed);
  const sync = collapsed => {
    caret.textContent = collapsed ? '▶' : '▼';
    caret.setAttribute('aria-expanded', String(!collapsed));
    caret.title = `${collapsed ? '展开' : '收起'} ${branch.name} 的任务与子分支`;
  };
  sync(collapsedNow());
  caret.onclick = () => {
    const collapsed = !collapsedNow();
    // 收起与展开分别记：展开某个默认收起的分支后，重画不能又按默认值把它收回去。
    if (collapsed) { ui.graphCollapsed.add(branch.name); ui.graphExpanded.delete(branch.name); }
    else { ui.graphExpanded.add(branch.name); ui.graphCollapsed.delete(branch.name); }
    saveGraphPrefs();
    onCollapsed(collapsed);
    sync(collapsed);
  };
  return caret;
}

function branchRow(branch, onCollapsed) {
  const row = el('div', undefined, 'graph-branch');
  // 未合进父分支 / 正在工作的分支带强调 class（样式见 styles.css）；两者可同时命中。
  for (const name of emphasisClasses(branch)) row.classList.add(name);
  // 只有真的能藏东西的分支才给箭头：任务和子分支都是空的时候，收起没意义。
  const hideable = branch.subtreeBranches + branch.subtreeTasks > 0;
  if (hideable) row.append(collapseCaret(branch, onCollapsed));
  row.append(el('span', `⎇ ${branch.name}`, 'graph-branch-name mono'));
  if (branch.head_commit) row.append(el('span', String(branch.head_commit).slice(0, 7), 'meta mono'));
  // 只被 parent 指针提到、既无记录也无 ref：占位，不假装分支还在。
  else if (branch.placeholder) row.append(el('span', '⚠ 仅谱系提及', 'chip warn'));
  // 记录还在、ref 已经不在：分支被删了，照旧画出来但明说它现在不存在。
  else row.append(el('span', '⚠ 分支不存在', 'chip warn'));
  if (branch.current) row.append(el('span', '当前检出', 'chip'));
  // 有 ref 但没有 branches 记录：画出来，但标明谱系里没有它。
  if (!branch.tracked && !branch.placeholder) row.append(el('span', '未登记', 'chip'));
  // 收起时告诉用户藏了什么；展开时这条由 CSS 隐掉（.graph-group:not(.collapsed) > .graph-branch > ...）。
  if (hideable) {
    const parts = [];
    if (branch.subtreeBranches) parts.push(`${branch.subtreeBranches} 分支`);
    if (branch.subtreeTasks) parts.push(`${branch.subtreeTasks} 任务`);
    row.append(el('span', `已收起 ${parts.join(' / ')}`, 'meta graph-collapsed-hint'));
  }

  // 与父分支的关系（fork 边）：状态 chip 与 ahead/behind 共用 edgeRelation 的 key（颜色见
  // styles.css 的 [data-relation]），后面跟这个关系当前能做的动作。
  const edge = branch.incoming;
  const relation = edgeRelation(edge);
  if (relation) row.append(el('span', relation.label, 'chip graph-relation'));
  if (edge && (Number.isFinite(edge.ahead) || Number.isFinite(edge.behind))) {
    row.append(el('span', `子分支 +${edge.ahead ?? '?'} / -${edge.behind ?? '?'}`, 'meta'));
  }
  for (const node of forkActions(branch, edge)) row.append(node);

  // 分支元数据：状态、标题、来源、创建时间、任务计数
  const meta = el('div', undefined, 'graph-branch-meta');
  // 有子分支还没收拢时不能合并：这条提示只和 fork 边有关，但不适合塞进挤满 chip 的表头行。
  if (edge?.blockers?.length) meta.append(el('span', `先收拢子分支：${edge.blockers.join('、')}`, 'graph-branch-blocker'));
  // 归档分支的状态固定显示「已归档」，不被汇总出来的旧状态盖掉。
  const statusInfo = branch.archived ? BRANCH_STATUS.archived : BRANCH_STATUS[branch.status];
  if (statusInfo) {
    meta.append(el('span', statusInfo.label, `chip ${statusInfo.className}`.trim()));
  }
  if (branch.title) {
    meta.append(el('span', branch.title, 'graph-branch-title'));
  }
  if (branch.origin && branch.origin !== 'placeholder') {
    const originText = BRANCH_ORIGIN[branch.origin] || branch.origin;
    const sourceText = branch.source_id ? ` #${branch.source_id}` : '';
    meta.append(el('span', `${originText}${sourceText}`, 'meta'));
  }
  if (branch.created_at) {
    meta.append(el('span', `创建于 ${new Date(branch.created_at).toLocaleString('zh-CN', { hour12: false })}`, 'meta'));
  }
  if (branch.taskCounts && branch.taskCounts.total > 0) {
    const parts = [];
    if (branch.taskCounts.active > 0) parts.push(`${branch.taskCounts.active} 活跃`);
    if (branch.taskCounts.failed > 0) parts.push(`${branch.taskCounts.failed} 失败`);
    if (branch.taskCounts.completed > 0) parts.push(`${branch.taskCounts.completed} 完成`);
    meta.append(el('span', `任务：${branch.taskCounts.total}（${parts.join('，')}）`, 'meta'));
  }
  if (meta.children.length > 0) row.append(meta);

  // 只有「可归档且尚未归档」的分支才给动作；当前检出、未登记、还有活没完的都不给。
  if (branch.archivable && !branch.archived) row.append(button('归档', () => runBranchArchive(branch.name), 'ghost'));

  return row;
}

/**
 * 一条分支子树：自己的表头 + 自己的任务，子分支作为一个缩进的子树块画在下面。父子的连接靠 CSS 画的
 * 竖线与拐角（.graph-children），而不是一块块看起来平级的卡片；收起时整棵子树一起藏进表头里。
 */
function branchBlock(branch) {
  const block = el('div', undefined, 'graph-group');
  // 关系色画在 block 上（--rel-ink / --rel-tint 由 styles.css 的 [data-relation] 定义）：
  // 分支面板的底色与左边条、挂到它的那段连接线与拐角都跟着走。根分支没有来边，保持默认强调色。
  const relation = edgeRelation(branch.incoming);
  if (relation) block.dataset.relation = relation.key;
  if (isBranchCollapsed(branch, ui.graphExpanded, ui.graphCollapsed)) block.classList.add('collapsed');
  block.append(branchRow(branch, collapsed => block.classList.toggle('collapsed', collapsed)));
  // 空任务车道不画：否则表头下面会拖出一段没有去处的竖线。子分支车道的连接段自己补上这段空隙。
  if (branch.tasks.length) {
    const lane = el('div', undefined, 'graph-lane');
    for (const node of branch.tasks) lane.append(taskRow(node, branch.name));
    block.append(lane);
  }
  if (branch.children.length) {
    const kids = el('div', undefined, 'graph-lane graph-children');
    for (const child of branch.children) kids.append(branchBlock(child));
    block.append(kids);
  }
  return block;
}

/** 兜底分组：连目标分支节点都没有的任务，仍然要画出来，只是明确说明它没落在任何分支节点上。 */
function unplacedBlock(group) {
  const block = el('div', undefined, 'graph-group graph-unplaced');
  const title = el('div', undefined, 'section-title');
  title.append(el('h2', '未归属分支的任务'));
  block.append(title);
  block.append(el('p', `图上找不到目标分支 ${group.target_branch} 的节点。`, 'hint'));
  const lane = el('div', undefined, 'graph-lane');
  for (const node of group.items) lane.append(taskRow(node));
  block.append(lane);
  return block;
}

/**
 * 渲染一份图。默认幂等：容器还在且图指纹没变时不重画。
 * 传 `{ force: true }`（用户点刷新或刚拉到新数据）时无条件重画。
 */
export function renderGraph(graph, { force = false } = {}) {
  const panel = $('detail'); panel.dataset.view = 'graph';
  let view = panel.querySelector('div.graph-view');
  if (!view) { panel.replaceChildren(); view = el('div', undefined, 'graph-view'); panel.append(view); force = true; }
  const key = graphRenderKey(graph);
  if (!force && key === ui.graphRenderKey) return view;
  ui.graphRenderKey = key;

  const layout = graphLayout(graph);
  const content = [];
  const head = el('div', undefined, 'head');
  head.append(el('span', '分支图', 'tid-lg'));
  head.append(el('span', layout.current_branch ? `当前检出 ${layout.current_branch}` : '当前未检出分支', 'hint'));
  const actions = el('div', undefined, 'actions');
  actions.append(button('刷新', () => loadGraph(), 'ghost'), button('返回概览', () => overview(), 'ghost'));
  head.append(actions);
  content.push(head);

  if (!layout.git) content.push(el('p', `读取 git 失败：${layout.error || '这个项目不是 git 仓库'}`, 'hint warn'));
  else if (layout.error) content.push(el('p', `读取 git 时出错：${layout.error}`, 'hint warn'));
  if (layout.truncated) content.push(el('p', '分支图的节点或边太多，已截断展示；请用 CLI 查看完整状态。', 'hint warn'));
  if (!layout.forest.length && !layout.unplaced.length) content.push(el('p', '还没有任何任务分支或 worktree。', 'hint'));

  for (const branch of layout.forest) content.push(branchBlock(branch));
  for (const group of layout.unplaced) content.push(unplacedBlock(group));
  view.replaceChildren(...content);
  return view;
}
