import { $, badge, button, el, roleBadge } from './dom.js';
import { api, action } from './api.js';
import { promptDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { absolute, INTEGRATION, statusOf, worktreeLabel } from './format.js';
import { show } from './messages.js';
import { detail } from './navigate.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { scopedKey } from './prefs.js';
import { apForest } from './ap-graph-layout.js';
import { branchDiagnostics, decisionRow, runOrchestrate, runOrchestrateCancel } from './render-graph.js';
import { renderGraphProgress } from './render-progress.js';
import { deliveryControls } from './render-delivery.js';

const KEY = 'lush.apGraph.collapsed';
const ACTIVE = new Set(['running', 'queued', 'waiting', 'awaiting']);
const ENDED = new Set(['completed', 'failed', 'cancelled']);
/** 状态计数 / 图例的固定顺序：先是活动态，再到终结态；只画出现过的。 */
const STATUS_ORDER = ['running', 'queued', 'waiting', 'awaiting', 'completed', 'failed', 'cancelled'];
function collapsed() {
  try { const saved = JSON.parse(localStorage.getItem(scopedKey(KEY))); return new Set(Array.isArray(saved) ? saved : []); }
  catch { return new Set(); }
}
function save(set) { try { localStorage.setItem(scopedKey(KEY), JSON.stringify([...set])); } catch { /* storage unavailable */ } }

/** 卡片颜色口径：running 最醒目，其余按真实状态各自一色（排队 / 在等 / 待你 / 完成 / 失败 / 取消）；
 *  只有既非活动也没有明确终结语义的才落到 idle。看板一眼能分清「正在跑」和「停下来了」。 */
function apVisualState(node) {
  if (node.status === 'running') return 'running';
  if (node.status === 'awaiting' || node.notice) return 'awaiting';
  if (node.status === 'failed') return 'failed';
  if (node.status === 'queued') return 'queued';
  if (node.status === 'waiting') return 'waiting';
  if (node.status === 'completed') return 'completed';
  if (node.status === 'cancelled') return 'cancelled';
  return 'idle';
}

/** AP 级的合并编排入口：目标就是这条 AP 自己的分支，复用分支图同一份只读计划与 runtime。
 *  没有子 say 分支就没有可收拢的对象，不给入口；已有运行改显进度 + 取消；被别的 merger / 一键合并
 *  冻结时禁用并写明原因。delivery 冻结正是「有待集成的合并请求」，不挡编排。 */
function apOrchestration(node) {
  const info = node.branch_info;
  if (!info || info.archived) return null;
  const run = info.merge_run;
  const box = el('section', undefined, 'ap-graph-orchestrate');
  if (run) {
    const done = run.done ?? 0;
    const total = run.total ?? 0;
    box.append(el('span', `合并编排中 · ${done}/${total}${run.status === 'paused' ? '（源侧解分歧中）' : ''}`,
      'chip graph-work run'));
    box.append(button('取消合并编排', () => runOrchestrateCancel({ name: node.branch },
      { refresh: loadAPGraph, scope: `AP #${node.id}` }), 'ghost',
      { help: '停止这条 AP 分支的合并编排并释放冻结；已落地的合并不回滚，等待中的解分歧子 AP 会被取消。' }));
    return box;
  }
  if (!info.subtree_say) return null;
  if (node.freeze && node.freeze.kind !== 'delivery') {
    const disabled = el('button', '编排合并全部子 AP', 'ghost');
    disabled.type = 'button'; disabled.disabled = true;
    const host = el('span', undefined, 'help-host');
    host.setAttribute('data-help', `合并编排暂时不可用：${node.freeze.reason}。`);
    host.append(disabled); box.append(host);
    return box;
  }
  box.append(button('编排合并全部子 AP', () => runOrchestrate({ name: node.branch },
    { refresh: loadAPGraph, label: '子 AP', apLabel: 'AP', scope: `AP #${node.id}` }), 'ghost',
    { agent: true, help: agentHelp(`按叶子到根自动把 AP #${node.id} 下所有已固定提交的子 AP 合并请求 ff-only 收拢进 ${node.branch}；没有请求但符合条件的会先自动补发固定提交请求；遇分歧自动派源侧解分歧子 AP；运行期间冻结 ${node.branch} 及其全部后代，耗时较长并消耗 token。`) }));
  return box;
}

function apCard(node, folded, refresh) {
  const row = el('article', undefined, 'ap-graph-card');
  row.dataset.apId = String(node.id);
  row.classList.add(`ap-graph-${apVisualState(node)}`);
  const head = el('div', undefined, 'ap-graph-head');
  if (node.children.length) {
    const toggle = button(folded.has(node.id) ? '▸' : '▾', () => {
      if (hasPendingInput()) { show('请先提交或清空正在编辑的待决答复，再折叠 AP。'); return; }
      if (folded.has(node.id)) folded.delete(node.id); else folded.add(node.id);
      save(folded); refresh();
    }, 'ghost', { help: `展开或收起 AP #${node.id} 的 ${node.children.length} 条直接子 AP` });
    toggle.setAttribute('aria-expanded', String(!folded.has(node.id)));
    head.append(toggle);
  }
  const title = button(`#${node.id} ${node.title}`, () => detail(node.id), 'ghost');
  title.classList.add('ap-graph-title');
  head.append(title, roleBadge(node.role), badge(node.status === 'waiting' && !node.children_active ? '静息' : statusOf(node).label,
    `b-${node.status}`));
  // 分支合并状态放进卡片首行的标签：与 AP 状态并排，一眼看清这条 AP 的改动合进父分支没有。
  // 用与 AP 详情同一份 INTEGRATION 文案与配色；none（没有独有提交）/ 未知值不占位。
  const merge = INTEGRATION[node.integration];
  if (merge) head.append(badge(merge, node.integration === 'merged' ? 'b-completed' : 'b-awaiting'));
  if (node.ap_kind) head.append(badge(node.ap_kind));
  if (node.freeze && node.freeze.ap_id !== node.id) head.append(badge(node.status === 'running' ? '安全点后冻结' : '冻结', 'warn'));
  if (node.notice_count) head.append(badge(`${node.notice_count} 条待决`, 'b-awaiting'));
  row.append(head);

  if (node.goal_preview && node.goal_preview !== node.title) row.append(el('p', node.goal_preview, 'ap-graph-goal'));
  if (node.waiting_reason) row.append(el('p', node.waiting_reason, 'ap-graph-reason'));
  if (node.result_preview) row.append(el('p', `最近结果：${node.result_preview}${node.result_preview.length >= 320 ? '…' : ''}`, 'ap-graph-result'));
  const progress = renderGraphProgress(node.progress, { running: node.status === 'running', status: node.status });
  if (progress) row.append(progress);

  const facts = el('div', undefined, 'ap-graph-facts');
  if (node.resolves_ap_id) facts.append(button(`正在解决 AP #${node.resolves_ap_id}`, () => detail(node.resolves_ap_id), 'ghost',
    { help: '这是被修复的源 AP；父子连线表示负责收敛的 AP，不会改写已终结源 AP 的血缘。' }));
  if (node.branch) facts.append(el('span', `分支：${node.branch}`, 'mono'));
  if (node.target_branch) facts.append(el('span', `父分支：${node.target_branch}`, 'mono'));
  if (node.base_commit) facts.append(el('span', `AP 基线：${node.base_commit.slice(0, 12)}`, 'mono'));
  if (node.head_commit) facts.append(el('span', `固定提交：${node.head_commit.slice(0, 12)}`, 'mono'));
  if (node.workspace) facts.append(el('span', `${worktreeLabel(node)}：${node.workspace}`, 'mono'));
  if (node.workspace_state === 'missing') facts.append(badge('⚠ worktree 缺失', 'warn'));
  if (!node.branch && !node.workspace) facts.append(el('span', '无独立分支 / worktree', 'meta'));
  if (node.branch_info?.archived) facts.append(badge('分支已归档'));
  if (node.delivery) facts.append(badge(`交付：${node.delivery.kind} · ${node.delivery.status}`));
  if (node.has_rule) facts.append(badge('固定输入规则'));
  if (node.children_total) facts.append(el('span', `子 AP：${node.children_total}${node.children_active ? `（${node.children_active} 活动）` : ''}`, 'meta'));
  if (Number.isInteger(node.calls) && node.calls) facts.append(el('span', `Agent 调用 ${node.calls} 次`, 'meta'));
  if (node.created_at) facts.append(el('span', `创建 ${absolute(node.created_at)}`, 'meta'));
  if (node.updated_at) facts.append(el('span', `更新 ${absolute(node.updated_at)}`, 'meta'));
  row.append(facts);
  if (node.integration_error) row.append(el('p', `集成受阻：${node.integration_error}`, 'hint'));
  if (node.ap_kind !== 'say' && node.delivery?.blocked_reason) row.append(el('p', `交付受阻：${node.delivery.blocked_reason}`, 'hint'));
  if (node.parent_id && !ui.apGraphIds?.has(node.parent_id)) row.append(el('p', `父 AP #${node.parent_id} 不在当前图中`, 'hint'));

  if (node.branch_info && !node.branch_info.archived) {
    const branch = node.branch_info;
    const git = el('section', undefined, 'ap-graph-git');
    const header = el('div', '分支诊断', 'ap-graph-git-head');
    if (branch.current_head) header.append(el('span', `HEAD ${branch.current_head.slice(0, 12)}`, 'mono'));
    else header.append(el('span', '当前分支 ref 不可用', 'warn'));
    if (branch.current_head && node.head_commit && branch.current_head !== node.head_commit) {
      header.append(el('span', `与 AP 固定提交 ${node.head_commit.slice(0, 12)} 不同`, 'warn'));
    }
    git.append(header);
    if (branch.diagnostics) git.append(branchDiagnostics({ name: node.branch, diagnostics: branch.diagnostics }));
    else git.append(el('p', '分支诊断不可用，不能推断工作区干净或已合并。', 'hint'));
    row.append(git);
  }

  if (node.notice) {
    if (['question', 'plan'].includes(node.notice.kind)) {
      // Same decision controls as the branch graph, but refresh this AP view after a response.
      const decision = decisionRow(node, loadAPGraph);
      if (node.notice.body?.length >= 1000) decision.append(el('p', '正文仅显示前 1000 字；完整内容请打开 AP 详情。', 'hint'));
      row.append(decision);
    } else {
      const pending = el('div', undefined, 'graph-decision');
      pending.append(el('strong', node.notice.title || '等待你回答问卷'),
        el('p', '这条待决事项需要在 AP 详情完成问卷；图中不会把选项误当作普通文字答复。', 'hint'),
        button('打开待决事项', () => detail(node.id), 'ghost', { help: '到 AP 详情查看完整问题与选项并答复。' }));
      row.append(pending);
    }
  }
  const controls = deliveryControls(node, { refresh: loadAPGraph });
  if (controls) row.append(controls);
  if (['say', 'child'].includes(node.ap_kind) && !ENDED.has(node.status)) {
    row.append(button('向此 AP 输入', async () => {
      const body = await promptDialog({ title: `发给 AP #${node.id}`, label: '输入', confirmLabel: '发送消息',
        confirmHelp: agentHelp('把输入交给这条 AP；固定规则可请求 Agent 在安全点提前收尾，否则轮末投递。'), agent: true });
      if (!body) return;
      await action('ap.message', { id: node.id, body });
      show(`已提交给 AP #${node.id}`);
      await loadAPGraph();
    }, 'ghost', { agent: true, help: agentHelp('给这个 AP 的 Agent 发送输入；可能在安全点提前收尾，不会立即硬杀。') }));
  }
  return row;
}

export function renderAPGraph(graph) {
  if (ui.view?.id !== 'ap-graph') return;
  graph = { ...graph, nodes: (graph.nodes || []).filter(node => ['say','child','main','owner'].includes(node.ap_kind)) };
  const host = $('detail');
  const saved = collapsed();
  const forest = apForest(graph);
  ui.apGraphIds = new Set(graph.nodes.map(node => node.id));
  const box = el('div', undefined, 'ap-graph');
  const hero = el('header', undefined, 'resource-hero ap-graph-hero');
  hero.append(el('h1', 'AP 图'), el('p', 'AP 包裹 Agent、分支与 worktree；连线表示父子关系。代码集成由直接父 Agent 或用户按固定提交批准。'));
  const summary = el('div', undefined, 'ap-graph-summary');
  const active = graph.nodes.filter(node => ACTIVE.has(node.status)).length;
  const decisions = graph.nodes.reduce((count, node) => count + (node.notice_count || 0), 0);
  const counts = new Map();
  for (const node of graph.nodes) counts.set(node.status, (counts.get(node.status) || 0) + 1);
  summary.append(badge(`图中 ${graph.nodes.length} / ${graph.total} AP`), badge(`${active} 活动`));
  // 状态计数本身兼作图例：running 的活动色与卡片左边条同源，扫一眼就知道每种颜色代表什么。
  for (const status of STATUS_ORDER) {
    const count = counts.get(status) || 0;
    if (!count) continue;
    const info = statusOf({ status });
    summary.append(badge(`${info.icon} ${info.label} ${count}`, `b-${status}`));
  }
  if (decisions) summary.append(badge(`${decisions} 待决`, 'b-awaiting'));
  hero.append(summary, button('刷新', () => loadAPGraph(), 'ghost'));
  box.append(hero);
  if (graph.truncated) box.append(el('p', `只显示最近及活动的 ${graph.nodes.length} / ${graph.total} 条 AP；父节点可能在截断范围外。`, 'hint'));
  const paint = (node, parent) => {
    const wrap = el('div', undefined, 'ap-graph-node');
    wrap.append(apCard(node, saved, () => renderAPGraph(graph)));
    if (node.children.length && !saved.has(node.id)) {
      const children = el('div', undefined, 'ap-graph-children');
      for (const child of node.children) paint(child, children);
      wrap.append(children);
    }
    parent.append(wrap);
  };
  for (const node of forest) paint(node, box);
  host.replaceChildren(box);
}

let pending = null;
export async function loadAPGraph() {
  const view = ui.view;
  if (!pending) pending = api('/api/ap-graph').finally(() => { pending = null; });
  const graph = await pending;
  if (ui.view === view) {
    ui.apGraphFetchedAt = Date.now();
    if (!hasPendingInput()) renderAPGraph(graph);
  }
  return graph;
}
function hasPendingInput() {
  for (const node of $('detail').querySelectorAll('textarea')) {
    if (node.value || node === document.activeElement) return true;
  }
  return false;
}
export async function openAPGraph() {
  activateDetailView({ view: 'ap-graph' });
  try { await loadAPGraph(); }
  catch (error) { if (ui.view?.id === 'ap-graph') $('detail').textContent = `AP 图加载失败：${error.message}`; throw error; }
}
