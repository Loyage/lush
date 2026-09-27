/**
 * 「分支图」视图：拉 `/api/graph` 画到 `#detail`，展示分支谱系（分支节点 + fork 父子嵌套）
 * 与每条分支下的 AP / worktree / 目标分支关系，以及 AP 之间的堆叠（code）/顺序（order）/
 * 解冲突（resolve）/检验（verify）关系。
 *
 * 视图是只读展示，除下面两类动作外没有别的写入：一、父分支关系上的「合入父分支」/「让子分支跟上父分支」/
 * 「在子分支解决分歧」，以及可归档分支上的「归档」，分别与 CLI 的 `branch merge` / `branch catchup` /
 * `branch sync` / `branch archive` 同源；节点点击只跳 AP 详情。
 * 二、图末尾兜底分组（`未归属分支的 AP`）里 AP 行上的「删除」：那里的 AP 既没有分支节点可归档、
 * 也没有别的去处，所以给一个定向删除（`ap.delete`，与 CLI 的 `lush ap delete` 同源）。
 *
 * 另有一类就地处理：图里任何带「待你决断」notice 的 AP 行（graph.get 的 `notice` / `notice_count`）
 * 直接把这件事的正文画出来，并在原地答复 / 忽略 / 批准 / 驳回，不必先去左侧「待定事项」或意图面板。
 * 动作与别处同源：question 用 `notice.answer` / `notice.dismiss`，plan 用 `plan.approve` / `plan.reject`。
 *
 * 幂等：同一份数据重画不重复建节点、不重建外层容器，所以 1.5s 轮询不会把滚动位置冲掉；
 * 唯一的例外是用户正在决策区里打字：那时整张图都不重画（见 renderGraph 的 hasPendingDecision）。
 */
import { $, badge, button, el, roleBadge, routeBadge } from './dom.js';
import { api, action } from './api.js';
import { confirmDialog, promptDialog } from './dialog.js';
import { show } from './messages.js';
import { statusOf, worktreeLabel } from './format.js';
import { graphLayout, graphFingerprint, graphRenderKey, emphasisClasses, isBranchCollapsed, isWorkingAP, workingState } from './graph-layout.js';
import { detail, overview } from './navigate.js';
import { activateDetailView } from './sidebar-ui.js';
import { saveGraphPrefs, ui } from './state.js';
import { referenceable } from './context-references.js';
import { agentHelp } from './help.js';
import { renderGraphProgress } from './render-progress.js';
import { deliveryControls } from './render-delivery.js';
import { reserveBranchShowcase, unreserveBranchShowcase } from './render-showcase.js';

/** 分支状态映射：状态 -> { label, className }；已合进父分支是常态，不再单独出一个「已合并」标签。
 *  没有 archived：归档的分支根本不会被画进分支树（看 graphLayout 的 hiddenBranches）。 */
const BRANCH_STATUS = {
  active: { label: '进行中', className: 'ok' },
  failed: { label: '失败', className: 'warn' },
  ready: { label: '待合并', className: '' },
  empty: { label: '空', className: '' },
};

/** 分支来源映射：来源 -> 中文描述 */
const BRANCH_ORIGIN = {
  input: '输入锚点',
  ap: 'AP 分支',
  registered: '已登记',
  local: '本地分支',
  placeholder: '占位',
};

/** 已提交规模与工作区脏活分开，不把未知或未检出说成干净 / 零改动。 */
export function branchDiagnostics(branch) {
  const data = branch.diagnostics;
  if (!data) return null; // 兼容旧 daemon。
  const box = el('div', undefined, 'graph-diagnostics');
  const changes = data.changes;
  if (changes?.status === 'ok') {
    const scale = el('div', undefined, 'graph-change-scale');
    scale.append(el('strong', `已提交：${changes.files_total} 个文件`),
      el('span', `+${changes.added}`, 'plus mono'), el('span', `−${changes.deleted} 行`, 'minus mono'));
    if (changes.binary_files) scale.append(el('span', `含 ${changes.binary_files} 个二进制文件（不计行数）`, 'meta'));
    box.append(scale, el('div', `相对创建起点 ${changes.base_commit.slice(0, 7)} → ${changes.head_commit.slice(0, 7)} · 累计净改动，不含未提交内容`, 'meta'));
    if (changes.files_total) {
      const body = el('div', undefined, 'graph-change-files');
      const list = el('ul', undefined, 'difflist');
      for (const file of changes.files || []) {
        const item = el('li');
        const name = file.previous_path ? `${file.previous_path} → ${file.path}` : file.path;
        item.append(el('span', name, 'path'), el('span', file.added === null ? '二进制' : `+${file.added} / −${file.deleted}`, 'stat'));
        list.append(item);
      }
      body.append(list);
      if (changes.truncated) body.append(el('p', `仅列出前 ${changes.files.length} / ${changes.files_total} 个文件；汇总包含全部文件。`, 'hint'));
      const toggle = button('文件改动列表', () => {
        if (ui.graphFilesExpanded.has(branch.name)) ui.graphFilesExpanded.delete(branch.name);
        else ui.graphFilesExpanded.add(branch.name);
        paint();
      }, 'ghost');
      const paint = () => {
        const open = ui.graphFilesExpanded.has(branch.name);
        body.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = `${open ? '收起' : '展开'}文件改动列表`;
      };
      paint(); box.append(toggle, body);
    }
  } else {
    const reason = { missing_head: '分支不存在', missing_baseline: '没有记录创建起点', read_failed: '无法读取起点或提交差异' }[changes?.reason] || '读取失败';
    box.append(el('div', `改动规模不可用：${reason}`, 'meta'));
  }
  const working = data.working_tree;
  if (working?.status === 'dirty' || working?.status === 'clean') {
    const text = working.files_total ? `未提交：${working.files_total} 个文件` : '工作区干净：无未提交文件';
    const counts = working.files_total ? ` · 暂存 ${working.staged} / 未暂存 ${working.unstaged} / 未跟踪 ${working.untracked} / 冲突 ${working.conflicts}` : '';
    const node = el('div', text + counts, working.files_total ? 'graph-pending warn' : 'meta');
    node.title = `${working.path}\n按文件去重计总数，分类可能重叠；不含忽略文件及 .lush 运行时目录。`;
    box.append(node);
  } else box.append(el('div', working?.status === 'not_checked_out' ? '未提交：未检出工作区' : '未提交：工作区状态未知', 'meta'));
  const latest = data.latest_commit;
  box.append(el('div', latest
    ? `最近提交：${new Date(latest.committed_at).toLocaleString('zh-CN', { hour12: false })} · ${latest.subject}`
    : '最近提交：不可用', 'graph-latest meta'));
  return box;
}

let pending = null;

/** 打开分支图：清掉选中的 AP 详情（否则热 AP 刷新会把图覆盖掉），并把地址栏切到 #graph。 */
export async function openGraph() {
  const view = activateDetailView({ view: 'graph' });
  if (ui.lastGraph) renderGraph(ui.lastGraph, { force: true });
  try { await loadGraph(); }
  catch (error) {
    if (ui.view === view && !ui.lastGraph) $('detail').textContent = `分支加载失败：${error.message}。点击「分支与合并」重试。`;
    if (ui.view === view) throw error;
  }
}

/** 重新拉一次图；同一时刻只允许一个请求在飞，并发调用共享同一个 promise。
 *  拿到数据后更新 `ui.lastGraph` / `ui.graphFetchedAt` / `ui.graphFingerprint`，但不碰 DOM——
 *  「分支图」与「项目概览」都复用这一步，概览因此不必新增 RPC，也不会各自打一遍 git。 */
export function fetchGraph() {
  if (!pending) {
    pending = (async () => {
      try {
        const graph = await api('/api/graph');
        ui.lastGraph = graph;
        ui.graphFetchedAt = Date.now();
        ui.graphFingerprint = graphFingerprint(ui.lastSnapshot);
        return graph;
      } finally { pending = null; }
    })();
  }
  return pending;
}

/** 重新拉一次图并渲染到「分支图」视图；单飞语义由 fetchGraph() 保证。 */
export function loadGraph() {
  const view = ui.view;
  return fetchGraph().then(graph => {
    if (ui.view === view && ui.graphOpen) renderGraph(graph, { force: true });
    return graph;
  });
}

const LANE_CLASS = level => `graph-node l${Math.min(Number(level) || 0, 6)}`;

/** 待决 notice 的徽标文案：问题（等你答复）与计划（等你拍板）分开说，与 AP 详情 / 意图面板一致。 */
const DECISION_BADGE = { question: '◔ 等你决定', plan: '计划待批' };

/** 提交 / 忽略之后松开输入框：清掉内容，并把焦点还回去。
 *  renderGraph 会为「有内容或正聚焦的决策输入」跳过这次重画，不松开的话用户已经提交的内容
 *  还会挂在图上，而且这次重画会被自己挡住。 */
function releaseDecisionInput(input) {
  if (!input) return;
  input.value = '';
  if (globalThis.document?.activeElement === input) input.blur?.();
}

/**
 * AP 行里的决策区（`node.notice` 存在时才有）：徽标 + 正文 + 就地的输入与按钮。
 * 口径来自 graph.get：`notice` 是 open 且 kind 为 question / plan 的最新一条，`notice_count` 是这类 notice 的总数。
 * 动作沿用本文件既有的范式：`await action(...)` 成功后写一句结论并 `await loadGraph()` 重拉这张图；
 * 失败由 dom.js 的 button 统一写进顶部提示（messages.js），不抛到页面上。
 */
export function decisionRow(node, refresh = loadGraph) {
  const notice = node.notice;
  const decision = el('div', undefined, 'graph-decision');
  const head = el('div', undefined, 'graph-decision-head');
  head.append(badge(DECISION_BADGE[notice.kind] || '等你决定', 'b-awaiting'));
  if (notice.title) head.append(el('span', notice.title, 'graph-decision-title'));
  const count = Number(node.notice_count) || 0;
  // 同一 AP 可以攒下多条（例如又问了一次）：图上给一条最新，但要说清楚还有多少条。
  if (count > 1) head.append(el('span', `另有 ${count - 1} 条待决`, 'meta graph-decision-more'));
  decision.append(head);
  // 正文常常是问题或计划的全部说明：保留换行、限高滚动，不能只给标题或截成看不全。
  decision.append(el('p', notice.body || '（没有补充说明）', 'graph-decision-body'));

  const actions = el('div', undefined, 'actions graph-decision-actions');
  const done = async message => { show(message); await refresh(); };

  // 计划审批：与 render-intents.js 的 planActions 同一对动作（id 用 planner AP id，RPC 也接受这条 notice 的 id）。
  if (notice.kind === 'plan') {
    actions.append(button('批准并开发', async () => {
      await action('plan.approve', { id: node.id });
      await done(`已批准 #${node.id} 的拆解，交给 scheduler 编排`);
    }, 'primary', { agent: true, help: agentHelp('批准这份拆解并交给 scheduler 编排成真实 AP，随后会启动开发 Agent 执行。') }));
    actions.append(button('驳回', async () => {
      const reason = await promptDialog({
        title: `驳回 #${node.id} 的拆解？`,
        message: '理由会送给 planner，让它据此重拆。',
        label: '驳回理由',
        placeholder: '例如：别动架构，先加个开关',
        confirmLabel: '驳回并重拆',
      });
      if (!reason || !reason.trim()) return;   // 空理由不发：与意图面板同一条校验
      await action('plan.reject', { id: node.id, reason: reason.trim() });
      await done(`已驳回 #${node.id} 的拆解：${reason.trim()}`);
    }, undefined, { agent: true, help: agentHelp('把驳回理由送给 planner，让它据此重新拆解计划。') }));
    decision.append(actions);
    return decision;
  }

  // 提问：输入框 + 回复 / 忽略；⌘/Ctrl+回车与 AP 详情里的同一个提交。
  const input = el('textarea', undefined, 'graph-decision-input');
  input.placeholder = '你的决定；⌘/Ctrl+回车提交';
  input.rows = 3;
  const reply = button('回复并继续 AP', async () => {
    const answer = input.value;
    await action('notice.answer', { id: notice.id, answer });
    releaseDecisionInput(input);
    await done(`已把答复发给 AP #${node.id}，它会继续跑`);
  }, undefined, { agent: true, help: agentHelp('把你的答复发给该 AP 的 Agent，它会继续当前工作。') });
  input.addEventListener('keydown', async event => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    await reply.onclick();
  });
  actions.append(reply, button('忽略', async () => {
    await action('notice.dismiss', { id: notice.id });
    releaseDecisionInput(input);
    await done(`已忽略 AP #${node.id} 的这条待决事项`);
  }, 'ghost', { help: '忽略这条待决事项，不代表批准；AP 不会继续处理它。' }));
  decision.append(input, actions);
  return decision;
}

/** AP 行。`owningBranch` 是包裹它的那条分支：AP 就在这条分支上时不再重复写一遍分支名（表头已经写了）；
 *  只有当 AP 退到目标分支分组（自己那条分支没有节点）或兜底分组时，分支名才是独有信息，必须画出来。 */
function apRow(node, owningBranch = null) {
  const row = el('div', undefined, LANE_CLASS(node.level));
  // 在跑 / 排队 / 等着的 AP 同样带上工作态强调，和它所在的分支一起被看见。
  if (isWorkingAP(node)) row.classList.add('graph-emphasis-working');
  // 快速路由的 AP 整行加一层底色，滚动时不会被淹没；徽章在下方角色旁。
  if (node.route) row.classList.add('route-flagged');
  // 在跑的 AP 行除了左边条再给一个脉冲点：旁边的「运行中」文案有了一眼可见的对应标记。
  if (node.status === 'running') row.append(el('span', '●', 'graph-work-dot'));
  row.append(el('span', `#${node.id}`, 'tid'));
  row.append(button(node.goal || '(无目标)', () => detail(node.id), 'graph-node'));
  row.append(roleBadge(node.role), el('span', statusOf(node).label, 'meta'), ...(node.route ? [routeBadge()] : []));
  const meta = el('div', undefined, 'graph-meta');
  if (node.upstreams?.length) meta.append(el('span', `⛓ 基线 #${node.upstreams.join('、#')}`, 'meta'));
  if (node.branch && node.branch !== owningBranch) meta.append(el('span', node.branch, 'graph-path mono'));
  if (node.workspace) meta.append(el('span', node.role === 'showcase' ? `${worktreeLabel(node)}：${node.workspace}` : node.workspace, 'graph-path mono'));
  if (node.aheadBehind) meta.append(el('span', node.aheadBehind, 'meta'));
  for (const mark of node.marks || []) meta.append(el('span', mark.text, `chip ${mark.className}`.trim()));
  if (node.ap_kind === 'say' && node.reservation) meta.append(badge({
    pending: '交付待就绪', started: '展示中', requested: '待确认合并', integrated: '已合入',
    completed: '展示已交付', failed: '展示失败', cancelled: '展示已取消',
  }[node.reservation.status] || '预约需检查', 'b-awaiting'));
  row.append(meta);
  const progress = renderGraphProgress(node.progress, { running: node.status === 'running', status: node.status });
  if (progress) row.append(progress);
  // 这件事在等你拍板：整行带琥珀强调（与未合并 / 工作中的强调可同时存在），决策区把正文与
  // 处理按钮直接摊在这一行里——用户不用先去左侧「待定事项」或别的页面。没有 notice 的 AP 行一个字段都不加。
  if (node.notice && node.notice.kind !== 'plan') {
    row.classList.add('graph-emphasis-awaiting');
    row.append(decisionRow(node));
  }
  referenceable(row, [
    { kind: 'ap', target: { ap_id: node.id }, label: `AP #${node.id}`, quote: node.goal || '(无目标)', location: { view: 'branch-graph', ap_id: node.id } },
    { kind: 'ap_subtree', target: { ap_id: node.id }, label: `AP 子树 #${node.id}`, quote: node.goal || '(无目标)', location: { view: 'branch-graph', ap_id: node.id } },
  ]);
  return row;
}

/** 父分支上的三个动作：合入父分支 / 让子分支跟上父分支 / 在子分支解决分歧。
 *  失败只写进顶部提示（messages.js），不抛到页面上；成功后重拉一次图，颜色与按钮随之更新。 */
async function runBranchAction(method, branch) {
  try {
    const result = await action(method, { branch });
    show(method === 'branch.sync'
      ? `已为 ${branch} 创建同步 AP #${result.ap.id}`
      : method === 'branch.catchup'
        ? (result.already_integrated ? `${branch} 已经与父分支一致，无需快进` : `${branch} 已 fast-forward 跟上 ${result.parent}`)
      : (result.needs_sync ? `${branch} 已与父分支分歧，请先在子分支侧解决分歧`
        : result.already_integrated ? `${branch} 已经在 ${result.parent} 中` : `${branch} 已 fast-forward 合入 ${result.parent}`));
    await loadGraph();
  } catch (error) { show(error.message, 'error'); }
}

/** 归档一子树分支：删掉这条分支与它全部后代的 worktree / 本地 ref，AP、会话与分支记录都留着。
 *  未提交改动只能连 worktree 一起丢，所以先确认；确认走应用内弹窗（dialog.js）——原生 confirm
 *  会被浏览器静默吃掉，那时按钮会变成什么都不做。 */
async function runBranchArchive(branch) {
  const descendants = Number(branch.subtreeBranches) || 0;
  const scope = descendants
    ? `会删除这条分支与它下面 ${descendants} 条后代分支的 worktree 与本地 ref`
    : '会删除这条分支的 worktree 与本地 ref';
  const confirmed = await confirmDialog({
    title: `归档 ${branch.name}？`,
    message: `${scope}，保留 AP、会话与分支记录（记录仍可在「分支详情」与 AP 详情里查）；未提交改动会被丢弃。`,
    confirmLabel: '归档',
    cancelLabel: '保留',
    danger: true,
  });
  if (!confirmed) return;
  try {
    const result = await action('branch.archive', { branch: branch.name, discard: true });
    const count = Number(result?.count) || 1;
    const dropped = result?.discarded ? '，已丢弃未提交改动' : '';
    show(count > 1
      ? `已归档 ${branch.name} 及它下面 ${count - 1} 条后代分支（共 ${count} 条）：worktree 与本地 ref 已删${dropped}，AP、会话与分支记录都保留`
      : `${branch.name} 已归档（worktree ${result?.worktree ?? 'absent'}、分支 ${result?.ref ?? 'absent'}${dropped}）；AP 与会话已保留`);
    await loadGraph();
  } catch (error) { show(error.message, 'error'); }
}

/** 删除一条兜底分组里的 AP（`ap.delete`）：这条 AP 既挂不上分支节点、也没有别的去处。
 *  删除比归档更重：AP 行与它的全部后代、消息、事件、notice、spec 一起从库里消失，不能撤销，
 *  所以确认文案把「会丢掉什么」写满；安全门在 runtime 侧（活动 AP、未处理 spec、外部引用、
 *  磁盘状态收不回来都会拒绝），失败原因由 messages.js 原样提示。 */
async function runAPDelete(node) {
  const confirmed = await confirmDialog({
    title: `删除 AP #${node.id}？`,
    message: '这条 AP 与它下面全部已结束后代的 AP 行会从库里删除（消息、事件、notice、spec 一并清），无法撤销，这部分 AP 历史不再保留。有分支 / worktree 会先按回收的安全门收尾；收不回来或还有别的 AP 引用它时会拒绝，什么都不删。',
    confirmLabel: '删除',
    cancelLabel: '保留',
    danger: true,
  });
  if (!confirmed) return;
  try {
    const result = await action('ap.delete', { id: node.id });
    const ids = result?.deleted?.ids ?? [node.id];
    show(ids.length > 1
      ? `已删除 AP #${ids.join('、#')}（共 ${ids.length} 条，含后代）：AP 行与它们的消息、事件已清，输入与分支记录保留`
      : `已删除 AP #${node.id}：AP 行与它的消息、事件已清，输入与分支记录保留`);
    await loadGraph();
  } catch (error) { show(error.message, 'error'); }
}

/** 动作按钮：能执行就接上 RPC；暂时不能执行也照画，但禁用并把原因写进 title——
 *  选项不该因为当前状态不对就整块消失，否则用户只会看到「这里什么都没有」。 */
function branchAction(label, title, run) {
  const node = run ? button(label, run, 'ghost graph-branch-action') : el('button', label, 'ghost graph-branch-action');
  if (!run) {
    node.type = 'button';
    node.disabled = true;
    // 禁用的按钮不派发指针事件，data-help 放外层 span.help-host。
    const host = el('span', undefined, 'help-host');
    host.setAttribute('data-help', title);
    host.append(node);
    return host;
  }
  node.setAttribute('data-help', title);
  return node;
}

/**
 * 父子关系的处理选项（文案与颜色都来自 graphLayout 算好的 relation.key）：
 * - 领先：合入父分支（子 → 父 fast-forward）；
 * - 落后：让子分支跟上父分支（父 → 子 fast-forward，不产生 merge commit）；
 * - 分歧：在子分支解决分歧（开一个 merger AP 把父分支合进子分支），合入父分支同时摆出来但禁用；
 * - 有未收拢的子分支时运行时两边都会拒绝，所以按钮禁用，并在 title 里列出 blocker。
 */
function blockerText(blockers = []) {
  const aps = blockers.filter(value => String(value).startsWith('ap:#')).map(value => String(value).slice('ap:'.length));
  const branches = blockers.filter(value => !String(value).startsWith('ap:#'));
  return [aps.length ? `等待 AP ${aps.join('、')} 完成` : null,
    branches.length ? `先收拢子分支：${branches.join('、')}` : null].filter(Boolean).join('；');
}

/** 描述一键合并顺序：与 daemon 的 mergeAllPlan 同一份字段，不在前端另算一套规则。 */
const MERGE_ALL_ACTION = { merge: '快进合入', sync: '子侧解法', skip: '不处理' };
/** 描述合并编排顺序：与 daemon 的 orchestratePlan 同一份字段。 */
const ORCHESTRATE_ACTION = { merge: '快进合入', resolve: '源侧解分歧', skip: '不处理' };

/** 一键合并：先拉只读计划给用户确认顺序与阻塞，再开始；运行期间冻结目标与全部后代。 */
async function runMergeAll(branch) {
  try {
    const plan = await action('branch.merge_plan', { branch: branch.name });
    if (!plan.order?.length) {
      show(`${branch.name} 现在没有可以一键合并的后代分支。`, 'warn');
      return;
    }
    const lines = plan.items.map(item =>
      `${item.ready ? '→' : '·'} ${item.branch}（${MERGE_ALL_ACTION[item.action] || item.action}）${item.blockers?.length ? ` · 阻塞：${item.blockers.join('、')}` : ''}`).join('\n');
    const confirmed = await confirmDialog({
      title: `一键合并 ${branch.name} 的全部子分支？`,
      message: `按叶子到根自动收拢 ${plan.order.length} 条分支；遇分歧自动开子侧 merger 并暂停等你处理，已完成的不回滚。运行期间 ${branch.name} 及其全部后代被冻结，不能新建输入 / 编辑 / 合并，直到完成或你在图上取消。`,
      detail: lines,
      confirmLabel: '开始一键合并',
      cancelLabel: '取消',
      agent: true,
      confirmHelp: agentHelp('一键合并会按叶子到根自动快进合并，并在分歧 / 冲突时启动 merger Agent；耗时较长并消耗 token。'),
    });
    if (!confirmed) return;
    await action('branch.merge_all', { branch: branch.name });
    show(`${branch.name} 的一键合并已开始，按序处理 ${plan.order.length} 条分支。`);
    await loadGraph();
  } catch (error) { show(error.message, 'error'); }
}

/** 取消一键合并：释放冻结，已完成的合并保留不回滚。 */
async function runMergeCancel(branch) {
  const confirmed = await confirmDialog({
    title: `取消 ${branch.name} 的一键合并？`,
    message: '取消后释放冻结；已完成的合并保留、不回滚，正在等待的 merger 子 AP 会被取消。',
    confirmLabel: '取消合并',
    cancelLabel: '继续合并',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await action('branch.merge_cancel', { branch: branch.name });
    show(`已取消 ${branch.name} 的一键合并，已完成的合并保留。`);
    await loadGraph();
  } catch (error) { show(error.message, 'error'); }
}

/** 合并编排计划的一行文本；分支图与 AP 图共用同一份只读计划字段，不在前端另算一套规则。
 *  `apLabel` 只影响 AP 编号前缀（分支图说「say」，AP 图说「AP」），固定提交、动作与阻塞口径一致。 */
export function orchestratePlanLines(plan, { apLabel = 'say' } = {}) {
  return (plan.items || []).map(item => {
    const commit = item.commit ? ` · 固定 ${String(item.commit).slice(0, 12)}` : '';
    const auto = item.auto_request ? ' · 将自动补发合并请求' : '';
    return `${item.ready ? '→' : '·'} ${item.branch}${item.ap_id ? `（${apLabel} #${item.ap_id}）` : ''}${commit} · ${ORCHESTRATE_ACTION[item.action] || item.action}${auto}${item.blockers?.length ? ` · 阻塞：${item.blockers.join('、')}` : ''}`;
  }).join('\n');
}

/** 合并编排：先拉只读计划给用户确认固定顺序与每条固定提交，再开始；之后 runtime 不再逐条问。
 *  分支图与 AP 图共用这份实现，只通过 `refresh` / 文案口径区分（AP 图的目标就是 AP 自己的分支）。 */
export async function runOrchestrate(branch, { refresh = loadGraph, label = 'say 子分支', apLabel = 'say', scope = branch.name } = {}) {
  try {
    const plan = await action('branch.orchestrate_plan', { branch: branch.name });
    if (!plan.order?.length) {
      // 没有可编排项时把原因说清楚：可能是还没点「请求合并」、分支已合入、或仍有 AP 在跑。
      const why = plan.items.filter(item => item.blockers?.length)
        .map(item => `${item.branch}：${item.blockers.join('、')}`).join('；');
      show(`${scope} 现在没有可编排的 ${label}${why ? `（${why}）` : ''}。`, 'warn');
      return;
    }
    const confirmed = await confirmDialog({
      title: `编排合并 ${scope} 的全部 ${label}？`,
      message: `按叶子到根自动把 ${plan.order.length} 条固定提交的合并请求 ff-only 收拢进 ${branch.name}；没有请求但符合条件的 ${apLabel} 分支会先由 runtime 自动补发固定提交请求；遇分歧自动在源侧派解分歧子 AP，完成后自动继续；已完成的不回滚。运行期间 ${branch.name} 及其全部后代被冻结，直到完成或你在图上取消。确认一次后不再逐条批准。`,
      detail: orchestratePlanLines(plan, { apLabel }),
      confirmLabel: '开始合并编排',
      cancelLabel: '取消',
      agent: true,
      confirmHelp: agentHelp('合并编排会按叶子到根自动 ff-only 收拢已固定提交的合并请求，并在分歧时派源侧解分歧子 AP；没有请求但符合条件的分支会先自动补发固定提交请求。耗时较长并消耗 token。'),
    });
    if (!confirmed) return;
    const started = await action('branch.orchestrate', { branch: branch.name });
    show(`${scope} 的合并编排已开始（AP #${started.ap?.id ?? '?'}），按序处理 ${plan.order.length} 条 ${apLabel} 分支。`);
    await refresh();
  } catch (error) { show(error.message, 'error'); }
}

/** 取消合并编排：释放冻结，已落地的合并保留不回滚；分支图与 AP 图共用。 */
export async function runOrchestrateCancel(branch, { refresh = loadGraph, scope = branch.name } = {}) {
  const confirmed = await confirmDialog({
    title: `取消 ${scope} 的合并编排？`,
    message: '取消后释放冻结；已落地的合并保留、不回滚，正在等待的解分歧子 AP 会被取消。',
    confirmLabel: '取消编排',
    cancelLabel: '继续编排',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await action('branch.orchestrate_cancel', { branch: branch.name });
    show(`已取消 ${scope} 的合并编排，已落地的合并保留。`);
    await refresh();
  } catch (error) { show(error.message, 'error'); }
}

function forkActions(branch, edge) {
  if (!edge) return [];
  const blocked = edge.blockers?.length ? blockerText(edge.blockers) : null;
  const why = (reason, extra = null) => [reason, extra, blocked].filter(Boolean).join('\n');
  const nodes = [];
  if (edge.status === 'fast_forward') {
    nodes.push(branchAction('合入父分支', why(`把 ${branch.name} fast-forward 合入父分支；不会在父分支上产生 merge commit。`),
      edge.can_merge ? () => runBranchAction('branch.merge', branch.name) : null));
  }
  if (edge.status === 'diverged') {
    nodes.push(branchAction('在子分支解决分歧',
      why(`开一个 merger AP，把父分支合进 ${branch.name} 并解决冲突；先不动父分支。`,
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
 * 收起整棵子树（自己的 AP + 全部子分支）：只改这一个 block 的 class 与 aria，不重画整张图，
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
    caret.setAttribute('data-help', `${collapsed ? '展开' : '收起'} ${branch.name} 的 AP 与子分支`);
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
  const ownerSay = branch.aps.find(ap => ap.ap_kind === 'say' && ap.branch === branch.name) || null;
  const newSayBelow = branch.children.some(function hasSay(child) {
    return child.aps.some(ap => ap.ap_kind === 'say') || child.children.some(hasSay);
  });
  // main 是项目主干，不是 Lush 管理的交付分支：graph.get 仍如实返回它的 tracked / origin / status / aps，
  // 这里只过滤会把「未登记」或后代 AP 汇总误说成 main 自身诊断的表头信息。
  const isMain = branch.name === 'main';
  // 未合进父分支 / 正在工作的分支带强调 class（样式见 styles.css）；两者可同时命中。
  for (const name of emphasisClasses(branch)) row.classList.add(name);
  // 工作态标识只回答显示：running / pending 给 chip，subtree 给一行更弱的话，停下来的分支一个都不画。
  const work = workingState(branch);
  // 真的有 AP 在这一条分支上跑（只有 work.key === 'running' 才算）才加 .graph-running：整行做呼吸动效（样式见
  // styles.css），与 .graph-emphasis-working 的静态外环并存。注意两者语义不同：.graph-emphasis-working 表示
  // 「自己或后代还有在跑的 AP」（含 subtree），在等 / 子树 / 停下来的分支都不能拿到 .graph-running，必须完全静止。
  // 动效全部由 CSS 承担，这里不加计时器，也不碰分支图的重画指纹。
  if (work?.key === 'running') row.classList.add('graph-running');
  // 当前没有工作的分支整体降噪（.graph-idle）：分支名与元信息降到次级色，不再占工作态的强调通道。
  // 只在 `working` 也为 false 时才加，保证强调 class（未合并 / 工作态）永远不会被降噪规则盖掉。
  if (!work && !branch.working) row.classList.add('graph-idle');
  // 只有真的能藏东西的分支才给箭头：AP 和子分支都是空的时候，收起没意义。
  const hideable = branch.subtreeBranches + branch.subtreeAPs > 0;
  if (hideable) row.append(collapseCaret(branch, onCollapsed));
  row.append(el('span', `⎇ ${branch.name}`, 'graph-branch-name mono'));
  if (branch.head_commit) row.append(el('span', String(branch.head_commit).slice(0, 7), 'meta mono'));
  // 只被 parent 指针提到、既无记录也无 ref：占位，不假装分支还在。
  else if (branch.placeholder) row.append(el('span', '⚠ 仅谱系提及', 'chip warn'));
  // 记录还在、ref 已经不在（又不是归档：归档的分支不会画进分支树）：分支被删了，明说它现在不存在。
  else row.append(el('span', '⚠ 分支不存在', 'chip warn'));
  if (branch.current) row.append(el('span', '当前检出', 'chip'));
  // 有 ref 但没有 branches 记录：画出来，但标明谱系里没有它。
  if (!isMain && !branch.tracked && !branch.placeholder) {
    row.append(el('span', '未登记', 'chip'));
    if (branch.head_commit) row.append(button('绑定分支', async () => {
      const confirmed = await confirmDialog({ title: `绑定 ${branch.name}？`,
        message: `确认这条本地分支的 HEAD 为 ${branch.head_commit}。绑定只创建静息 owner AP，不修改分支或提交。`,
        confirmLabel: '绑定', confirmHelp: '按当前固定 HEAD 建立分支所有者 AP；HEAD 漂移时会拒绝。' });
      if (!confirmed) return;
      await action('branch.bind', { branch: branch.name, commit: branch.head_commit });
      await loadGraph();
    }, 'ghost', { help: '确认本地分支的固定 HEAD，再创建静息 owner AP；不移动 ref。' }));
  }
  // 收起时告诉用户藏了什么；展开时这条由 CSS 隐掉（.graph-group:not(.collapsed) > .graph-branch > ...）。
  if (hideable) {
    const parts = [];
    if (branch.subtreeBranches) parts.push(`${branch.subtreeBranches} 分支`);
    if (branch.subtreeAPs) parts.push(`${branch.subtreeAPs} AP`);
    row.append(el('span', `已收起 ${parts.join(' / ')}`, 'meta graph-collapsed-hint'));
  }

  // 工作态标识放在分支名之后、关系 chip 之前：先看到「这条还在动」，再看它和父分支的关系。
  // 收起的是 AP 与子分支，状态属于这条分支本身，所以表头上永远显示。
  if (work) {
    if (work.key === 'subtree') {
      const node = el('span', undefined, 'graph-work subtree');
      node.append(`${work.label} · ${work.count}`);
      row.append(node);
    } else {
      const chip = el('span', undefined, `chip graph-work ${work.key === 'running' ? 'run' : work.key}`);
      // ● 用 append 加在最前（浏览器与测试 stub 都支持 append，混入文本节点也一样）。
      if (work.key === 'running') chip.append(el('span', '●', 'graph-work-dot'));
      chip.append(work.label);
      row.append(chip);
    }
  }

  // 与父分支的关系（fork 边）：状态 chip 与 ahead/behind 共用 graphLayout 算好的 relation（颜色见
  // styles.css 的 [data-relation]），后面跟这个关系当前能做的动作。归档把 ref 删掉之后不算「分支缺失」：
  // 已归档的分支没有关系可谈（relation 为 null），父分支已归档的报「父分支已归档」。
  const edge = branch.incoming;
  const relation = branch.relation;
  if (relation) row.append(el('span', relation.label, 'chip graph-relation'));
  if (edge && (Number.isFinite(edge.ahead) || Number.isFinite(edge.behind))) {
    row.append(el('span', `子分支 +${edge.ahead ?? '?'} / -${edge.behind ?? '?'}`, 'meta'));
  }
  // Old branch merge/sync/catchup actions are not part of the AP delivery API.
  // Legacy merge runs are history only: do not offer resume or cancellation actions.
  if (branch.merge_run) row.append(el('span', '历史合并编排记录（已停用）', 'chip'));

  // 分支元数据：状态、标题、来源、创建时间、AP 计数
  const meta = el('div', undefined, 'graph-branch-meta');
  // 活动 AP 或未收拢子分支都会阻止收口；按真实类型说明，不能把 ap:#N 冒充成子分支。
  if (edge?.blockers?.length) meta.append(el('span', blockerText(edge.blockers), 'graph-branch-blocker'));
  // 归档分支的状态固定显示「已归档」，不被汇总出来的旧状态盖掉。表头已经报过它（ref 是归档时
  // 按预期删掉的），所以这里只补归档时间，不把同一个词再说一遍。
  // 归档分支的状态不需要在这里特判：归档的分支不会被画进分支树（见 graphLayout 的 hiddenBranches）。
  if (!isMain && BRANCH_STATUS[branch.status]) {
    const statusInfo = BRANCH_STATUS[branch.status];
    meta.append(el('span', statusInfo.label, `chip ${statusInfo.className}`.trim()));
  }
  if (branch.title) {
    const titleNode = el('span', branch.title, 'graph-branch-title');
    // 摘要可能被分支名等挤窄：悬停时给出完整摘要，不依赖标题文本本身。
    if (branch.summary) titleNode.title = branch.summary;
    meta.append(titleNode);
  }
  if (!isMain && branch.origin && branch.origin !== 'placeholder') {
    const originText = BRANCH_ORIGIN[branch.origin] || branch.origin;
    const sourceText = branch.source_id ? ` #${branch.source_id}` : '';
    meta.append(el('span', `${originText}${sourceText}`, 'meta'));
  }
  if (branch.created_at) {
    meta.append(el('span', `创建于 ${new Date(branch.created_at).toLocaleString('zh-CN', { hour12: false })}`, 'meta'));
  }
  if (!isMain && branch.apCounts && branch.apCounts.total > 0) {
    const parts = [];
    if (branch.apCounts.active > 0) parts.push(`${branch.apCounts.active} 活跃`);
    if (branch.apCounts.failed > 0) parts.push(`${branch.apCounts.failed} 失败`);
    if (branch.apCounts.completed > 0) parts.push(`${branch.apCounts.completed} 完成`);
    meta.append(el('span', `AP：${branch.apCounts.total}（${parts.join('，')}）`, 'meta'));
  }
  if (meta.children.length > 0) row.append(meta);
  const diagnostics = branchDiagnostics(branch);
  if (diagnostics) row.append(diagnostics);

  if (ownerSay) row.append(deliveryControls(ownerSay, { refresh: loadGraph }));
  // 只有「可归档且尚未归档」的分支才给归档；当前检出、未登记、还有活没完的都不给。
  // 归档一条＝归档它整棵子树（见 runBranchArchive 的确认文案）。
  if (branch.archivable && !branch.archived) row.append(button('归档', () => runBranchArchive(branch), 'ghost',
    { help: '归档这条分支及它下面的全部后代分支：删除 worktree 与本地 ref，未提交改动会丢失；AP 与会话记录保留。' }));

  referenceable(row, { kind: 'delivery_branch', target: { target_branch: branch.name, section: 'graph' }, label: `分支 ${branch.name}`,
    quote: [branch.title || branch.name, branch.summary, branch.parent ? `父分支：${branch.parent}` : null,
      branch.apCounts ? `AP：${branch.apCounts.total}` : null].filter(Boolean).join('\n'),
    location: { view: 'branch-graph', section: branch.name } });
  return row;
}

/**
 * 一条分支子树：自己的表头 + 自己的 AP，子分支作为一个缩进的子树块画在下面。父子的连接靠 CSS 画的
 * 竖线与拐角（.graph-children），而不是一块块看起来平级的卡片；收起时整棵子树一起藏进表头里。
 */
function branchBlock(branch) {
  const block = el('div', undefined, 'graph-group');
  // 关系色画在 block 上（--rel-ink / --rel-tint 由 styles.css 的 [data-relation] 定义）：
  // 分支面板的底色与左边条、挂到它的那段连接线与拐角都跟着走。根分支与已归档的分支没有关系可谈，
  // 保持默认强调色。
  if (branch.relation) block.dataset.relation = branch.relation.key;
  if (isBranchCollapsed(branch, ui.graphExpanded, ui.graphCollapsed)) block.classList.add('collapsed');
  block.append(branchRow(branch, collapsed => block.classList.toggle('collapsed', collapsed)));
  // 空 AP 车道不画：否则表头下面会拖出一段没有去处的竖线。子分支车道的连接段自己补上这段空隙。
  if (branch.aps.length) {
    const lane = el('div', undefined, 'graph-lane');
    for (const node of branch.aps) lane.append(apRow(node, branch.name));
    block.append(lane);
  }
  if (branch.children.length) {
    const kids = el('div', undefined, 'graph-lane graph-children');
    for (const child of branch.children) kids.append(branchBlock(child));
    block.append(kids);
  }
  return block;
}

/** 分支森林里最深的嵌套层数（根为 0）。窄屏靠这个数决定分支树至少要留多宽，才不会被逐层挤成窄条。 */
function forestDepth(forest) {
  let max = 0;
  const visit = (node, depth) => {
    if (depth > max) max = depth;
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of forest) visit(root, 0);
  return max;
}

/** 兜底分组：连目标分支节点都没有的 AP，仍然要画出来，只是明确说明它没落在任何分支节点上。
 *  这里的 AP 没有分支可归档，也没别的去处，所以每行多一个「删除」（`ap.delete`）；
 *  它是这个分组唯一的出口，也是页面上唯一会丢 AP 历史的按钮，确认文案写满了代价。 */
function unplacedBlock(group) {
  const block = el('div', undefined, 'graph-group graph-unplaced');
  const title = el('div', undefined, 'section-title');
  title.append(el('h2', '未归属分支的 AP'));
  block.append(title);
  block.append(el('p', `图上找不到目标分支 ${group.target_branch} 的节点。`, 'hint'));
  const lane = el('div', undefined, 'graph-lane');
  for (const node of group.items) {
    const row = apRow(node);

    lane.append(row);
  }
  block.append(lane);
  return block;
}

/** 图上还有没提交的决策输入吗：有内容、或正被聚焦的都算。
 *  重画整张图会把 textarea 连同用户打了一半的字一起换掉，所以拿不到「用户已经写完」的信号时先不画。
 *  只看决策区里的输入框（图上没有别的 textarea），不影响分支动作的重画。 */
function hasPendingDecision(view) {
  return [...view.querySelectorAll('textarea.graph-decision-input')]
    .some(node => node.value || node === globalThis.document?.activeElement);
}

/**
 * 渲染一份图。默认幂等：容器还在且图指纹没变时不重画。
 * 传 `{ force: true }`（用户点刷新或刚拉到新数据）时无条件重画——**唯一**的例外是用户正在
 * 决策区里打字：那时跳过这次渲染，只保留输入（fetchGraph 照常更新 `ui.lastGraph`，所以用户
 * 提交 / 忽略之后走的那次正常重画看到的是最新数据）。
 */
export function renderGraph(graph, { force = false } = {}) {
  const panel = $('detail'); panel.dataset.view = 'graph';
  let view = panel.querySelector('div.graph-view');
  if (!view) { panel.replaceChildren(); view = el('div', undefined, 'graph-view'); panel.append(view); force = true; }
  else if (hasPendingDecision(view)) return view;
  const key = graphRenderKey(graph);
  if (!force && key === ui.graphRenderKey) return view;
  ui.graphRenderKey = key;

  const layout = graphLayout(graph);
  const content = [];
  const head = el('div', undefined, 'head graph-head');
  const heading = el('div', undefined, 'graph-heading');
  heading.append(el('span', 'BRANCH MAP', 'eyebrow'), el('span', '分支与合并', 'tid-lg'),
    el('p', '分支是项目演进的主线。顺着父子关系检查工作状态、处理分歧，并将完成的成果逐层合回。', 'hero-description'));
  const actions = el('div', undefined, 'actions');
  actions.append(button('刷新分支状态', () => loadGraph(), 'ghost'), button('查看概览', () => overview(), 'ghost'));
  head.append(heading, actions);
  content.push(head);

  const summary = el('div', undefined, 'graph-summary');
  for (const [label, value] of [
    ['分支', String(layout.branch_count)],
    ['AP', String(layout.ap_count)],
    ['当前检出', layout.current_branch || '未检出'],
  ]) {
    const item = el('div', undefined, 'graph-summary-item');
    item.append(el('span', label, 'eyebrow'), el('strong', value)); summary.append(item);
  }
  const legend = el('div', undefined, 'graph-legend');
  legend.append(el('span', '关系', 'eyebrow'));
  for (const [key, label] of [['ahead', '可合入'], ['equal', '一致'], ['behind', '落后'], ['diverged', '分歧'], ['missing', '缺失']]) {
    const item = el('span', label, `graph-legend-item relation-${key}`); item.dataset.relation = key; legend.append(item);
  }
  summary.append(legend); content.push(summary);

  if (!layout.git) content.push(el('p', `读取 git 失败：${layout.error || '这个项目不是 git 仓库'}`, 'hint warn'));
  else if (layout.error) content.push(el('p', `读取 git 时出错：${layout.error}`, 'hint warn'));
  if (layout.truncated) content.push(el('p', '分支图的节点或边太多，已截断展示；请用 CLI 查看完整状态。', 'hint warn'));
  if (!layout.forest.length && !layout.unplaced.length) content.push(el('p', '还没有任何 AP 分支或 worktree。', 'hint'));

  // 把所有根分支包进一个整体容器：窄屏下它就是唯一的横向滚动区，桌面端只是个普通块。
  // `--graph-depth` 记下森林的最大嵌套深度（根为 0），窄屏 CSS 用它算出分支树的最小宽度，
  // 保证最深层卡片仍有可读宽度；unplaced 兜底分组不属于分支森林，留在容器外。
  if (layout.forest.length) {
    const tree = el('div', undefined, 'graph-tree');
    tree.style.setProperty('--graph-depth', String(forestDepth(layout.forest)));
    for (const branch of layout.forest) tree.append(branchBlock(branch));
    content.push(tree);
  }
  for (const group of layout.unplaced) content.push(unplacedBlock(group));
  view.replaceChildren(...content);
  return view;
}
