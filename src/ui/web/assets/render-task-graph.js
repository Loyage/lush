import { $, badge, button, el, roleBadge } from './dom.js';
import { api, action } from './api.js';
import { promptDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { absolute, INTEGRATION, statusOf } from './format.js';
import { show } from './messages.js';
import { detail } from './navigate.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { scopedKey } from './prefs.js';
import { taskForest } from './task-graph-layout.js';
import { branchDiagnostics, decisionRow } from './render-graph.js';
import { renderGraphProgress } from './render-progress.js';
import { deliveryControls } from './render-delivery.js';

const KEY = 'lush.taskGraph.collapsed';
const ACTIVE = new Set(['running', 'queued', 'waiting', 'awaiting']);
const ENDED = new Set(['completed', 'failed', 'cancelled']);
function collapsed() {
  try { const saved = JSON.parse(localStorage.getItem(scopedKey(KEY))); return new Set(Array.isArray(saved) ? saved : []); }
  catch { return new Set(); }
}
function save(set) { try { localStorage.setItem(scopedKey(KEY), JSON.stringify([...set])); } catch { /* storage unavailable */ } }

function taskCard(node, folded, refresh) {
  const row = el('article', undefined, 'task-graph-card');
  row.dataset.taskId = String(node.id);
  if (node.status === 'running') row.classList.add('task-graph-running');
  else if (node.status === 'awaiting' || node.notice) row.classList.add('task-graph-awaiting');
  else if (node.status === 'failed') row.classList.add('task-graph-failed');
  else if (!ACTIVE.has(node.status)) row.classList.add('task-graph-idle');
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
    node.status === 'failed' ? 'warn' : ''));
  if (node.task_kind) head.append(badge(node.task_kind));
  if (node.freeze && node.freeze.task_id !== node.id) head.append(badge(node.status === 'running' ? '安全点后冻结' : '冻结', 'warn'));
  if (node.notice_count) head.append(badge(`${node.notice_count} 条待决`, 'b-awaiting'));
  row.append(head);

  if (node.goal_preview && node.goal_preview !== node.title) row.append(el('p', node.goal_preview, 'task-graph-goal'));
  if (node.waiting_reason) row.append(el('p', node.waiting_reason, 'task-graph-reason'));
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
  if (node.workspace) facts.append(el('span', `worktree：${node.workspace}`, 'mono'));
  if (node.workspace_state === 'missing') facts.append(badge('⚠ worktree 缺失', 'warn'));
  if (!node.branch && !node.workspace) facts.append(el('span', '无独立分支 / worktree', 'meta'));
  if (node.branch_info?.archived) facts.append(badge('分支已归档'));
  if (node.integration) facts.append(badge(`集成：${INTEGRATION[node.integration] || node.integration}`));
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
  const host = $('detail');
  const saved = collapsed();
  const forest = taskForest(graph);
  ui.taskGraphIds = new Set(graph.nodes.map(node => node.id));
  const box = el('div', undefined, 'task-graph');
  const hero = el('header', undefined, 'resource-hero task-graph-hero');
  hero.append(el('h1', 'Task 图'), el('p', 'Task 包裹 Agent、分支与 worktree；连线表示父子关系。分支归档与 Git 合并编排仍在「分支与合并」。'));
  const summary = el('div', undefined, 'task-graph-summary');
  const active = graph.nodes.filter(node => ACTIVE.has(node.status)).length;
  const decisions = graph.nodes.reduce((count, node) => count + (node.notice_count || 0), 0);
  summary.append(badge(`图中 ${graph.nodes.length} / ${graph.total} Task`), badge(`${active} 活动`), badge(`${decisions} 待决`));
  hero.append(summary, button('刷新', () => loadTaskGraph(), 'ghost'));
  box.append(hero);
  if (graph.truncated) box.append(el('p', `只显示最近及活动的 ${graph.nodes.length} / ${graph.total} 条 Task；父节点可能在截断范围外。`, 'hint'));
  const paint = (node, parent) => {
    const wrap = el('div', undefined, 'task-graph-node');
    wrap.append(taskCard(node, saved, () => renderTaskGraph(graph)));
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
