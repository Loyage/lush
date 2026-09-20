/**
 * 「分支图」视图：拉 `/api/graph` 画到 `#detail`，展示分支谱系（分支节点 + fork 父子嵌套）
 * 与每条分支下的任务 / worktree / 目标分支关系，以及任务之间的堆叠（code）/顺序（order）/
 * 解冲突（resolve）/检验（verify）关系。
 *
 * 只读：视图不提供任何写操作，节点点击只跳任务详情。
 * 幂等：同一份数据重画不重复建节点、不重建外层容器，所以 1.5s 轮询不会把滚动位置冲掉。
 */
import { $, button, el } from './dom.js';
import { api, action } from './api.js';
import { ROLE, statusOf } from './format.js';
import { graphLayout, graphFingerprint, graphRenderKey } from './graph-layout.js';
import { detail, overview } from './navigate.js';
import { ui } from './state.js';

/** 分支状态映射：状态 -> { label, className } */
const BRANCH_STATUS = {
  active: { label: '进行中', className: 'ok' },
  failed: { label: '失败', className: 'warn' },
  merged: { label: '已合并', className: 'ok' },
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

function taskRow(node) {
  const row = el('div', undefined, LANE_CLASS(node.level));
  row.append(el('span', `#${node.id}`, 'tid'));
  row.append(button(node.goal || '(无目标)', () => detail(node.id), 'graph-node'));
  row.append(el('span', `${ROLE[node.role] || node.role} · ${statusOf(node).label}`, 'meta'));
  const meta = el('div', undefined, 'graph-meta');
  if (node.upstreams?.length) meta.append(el('span', `⛓ 基线 #${node.upstreams.join('、#')}`, 'meta'));
  if (node.branch) meta.append(el('span', node.branch, 'graph-path mono'));
  if (node.workspace) meta.append(el('span', node.workspace, 'graph-path mono'));
  if (node.aheadBehind) meta.append(el('span', node.aheadBehind, 'meta'));
  for (const mark of node.marks || []) meta.append(el('span', mark.text, `chip ${mark.className}`.trim()));
  row.append(meta);
  return row;
}

/** 一条分支的表头：名字、顶端 commit（或缺失标记）、当前检出、谱系登记状态。 */
async function runBranchAction(method, branch) {
  try {
    const result = await action(method, { branch });
    $('error').textContent = method === 'branch.sync'
      ? `已为 ${branch} 创建同步任务 #${result.task.id}`
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

/** fork 连线也是操作面：颜色与文案说明能否直接 FF，分歧时从子侧创建同步任务。 */
function edgeRow(branch) {
  const edge = branch.incoming;
  if (!edge) return null;
  const row = el('div', undefined, `graph-edge is-${edge.status || 'unknown'}`);
  const parent = String(edge.from || '').replace(/^branch:/, '');
  const text = edge.status === 'fast_forward' ? '可 fast-forward'
    : edge.status === 'diverged' ? '父子已分歧'
    : edge.status === 'integrated' ? '已进入父分支'
    : edge.status === 'missing' ? '分支缺失'
    : '关系未知';
  row.append(el('span', `${parent} → ${branch.name}`, 'graph-edge-path mono'));
  row.append(el('span', text, `chip ${edge.status === 'fast_forward' || edge.status === 'integrated' ? 'ok' : edge.status === 'diverged' ? 'warn' : ''}`.trim()));
  if (Number.isFinite(edge.ahead) || Number.isFinite(edge.behind)) row.append(el('span', `子分支 +${edge.ahead ?? '?'} / -${edge.behind ?? '?'}`, 'meta'));
  if (edge.blockers?.length) row.append(el('span', `先收拢子分支：${edge.blockers.join('、')}`, 'graph-edge-blocker'));
  if (edge.can_merge) row.append(button('合入父分支', () => runBranchAction('branch.merge', branch.name), 'ghost'));
  else if (edge.can_sync) row.append(button('在子分支解决分歧', () => runBranchAction('branch.sync', branch.name), 'ghost'));
  return row;
}

function branchRow(branch) {
  const row = el('div', undefined, 'graph-branch');
  row.append(el('span', `⎇ ${branch.name}`, 'graph-branch-name mono'));
  if (branch.head_commit) row.append(el('span', String(branch.head_commit).slice(0, 7), 'meta mono'));
  // 只被 parent 指针提到、既无记录也无 ref：占位，不假装分支还在。
  else if (branch.placeholder) row.append(el('span', '⚠ 仅谱系提及', 'chip warn'));
  // 记录还在、ref 已经不在：分支被删了，照旧画出来但明说它现在不存在。
  else row.append(el('span', '⚠ 分支不存在', 'chip warn'));
  if (branch.current) row.append(el('span', '当前检出', 'chip'));
  // 有 ref 但没有 branches 记录：画出来，但标明谱系里没有它。
  if (!branch.tracked && !branch.placeholder) row.append(el('span', '未登记', 'chip'));

  // 分支元数据：状态、标题、来源、创建时间、任务计数
  const meta = el('div', undefined, 'graph-branch-meta');
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
 * 一条分支子树：自己的表头 + 自己的任务，子分支作为一个缩进的子树块画在下面（复用 `.graph-lane`
 * 的左边框与内缩表示父子关系）。刚创建的分支因此会出现在父分支的子树里，而不是另开一条无关的车道。
 */
function branchBlock(branch) {
  const block = el('div', undefined, 'graph-group');
  const edge = edgeRow(branch);
  if (edge) block.append(edge);
  block.append(branchRow(branch));
  const lane = el('div', undefined, 'graph-lane');
  for (const node of branch.tasks) lane.append(taskRow(node));
  block.append(lane);
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
