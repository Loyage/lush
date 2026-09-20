/**
 * 「分支图」视图：拉 `/api/graph` 画到 `#detail`，展示每个任务的分支 / worktree / 目标分支关系，
 * 以及任务之间的堆叠（code）/顺序（order）/解冲突（resolve）/检验（verify）关系。
 *
 * 只读：视图不提供任何写操作，节点点击只跳任务详情。
 * 幂等：同一份数据重画不重复建节点、不重建外层容器，所以 1.5s 轮询不会把滚动位置冲掉。
 */
import { $, button, el } from './dom.js';
import { api } from './api.js';
import { ROLE, statusOf } from './format.js';
import { graphLayout, graphFingerprint, graphRenderKey } from './graph-layout.js';
import { detail, overview } from './navigate.js';
import { ui } from './state.js';

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

function branchRow(branch) {
  const row = el('div', undefined, 'graph-branch');
  row.append(el('span', `⎇ ${branch.name}`, 'graph-branch-name mono'));
  if (branch.head_commit) row.append(el('span', String(branch.head_commit).slice(0, 7), 'meta mono'));
  if (branch.current) row.append(el('span', '当前检出', 'chip'));
  return row;
}

function groupBlock(group) {
  const lane = el('div', undefined, 'graph-group');
  const title = el('div', undefined, 'section-title');
  title.append(el('h2', `目标分支 ${group.target_branch}`));
  if (group.current) title.append(el('span', '当前检出', 'chip'));
  lane.append(title);
  if (group.branch) lane.append(branchRow(group.branch));
  const list = el('div', undefined, 'graph-lane');
  for (const node of group.items) list.append(taskRow(node));
  lane.append(list);
  return lane;
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
  if (!layout.groups.length) content.push(el('p', '还没有任何任务分支或 worktree。', 'hint'));

  for (const group of layout.groups) content.push(groupBlock(group));
  view.replaceChildren(...content);
  return view;
}
