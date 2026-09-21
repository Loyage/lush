/**
 * 「分支图」视图：拉 `/api/graph` 画到 `#detail`，展示分支谱系（分支节点 + fork 父子嵌套）
 * 与每条分支下的任务 / worktree / 目标分支关系，以及任务之间的堆叠（code）/顺序（order）/
 * 解冲突（resolve）/检验（verify）关系。
 *
 * 视图只读展示，写操作只有四个按钮：父分支关系上的「合入父分支」/「让子分支跟上父分支」/
 * 「在子分支解决分歧」，以及可归档分支上的「归档」，分别与 CLI 的 `branch merge` / `branch catchup` /
 * `branch sync` / `branch archive` 同源；节点点击只跳任务详情。
 *
 * 另有一类就地处理：图里任何带「待你决断」notice 的任务行（graph.get 的 `notice` / `notice_count`）
 * 直接把这件事的正文画出来，并在原地答复 / 忽略 / 批准 / 驳回，不必先去左侧「待定事项」或意图面板。
 * 动作与别处同源：question 用 `notice.answer` / `notice.dismiss`，plan 用 `plan.approve` / `plan.reject`。
 *
 * 幂等：同一份数据重画不重复建节点、不重建外层容器，所以 1.5s 轮询不会把滚动位置冲掉；
 * 唯一的例外是用户正在决策区里打字：那时整张图都不重画（见 renderGraph 的 hasPendingDecision）。
 */
import { $, badge, button, el } from './dom.js';
import { api, action } from './api.js';
import { confirmDialog, promptDialog } from './dialog.js';
import { ROLE, statusOf } from './format.js';
import { graphLayout, graphFingerprint, graphRenderKey, emphasisClasses, isBranchCollapsed, isWorkingTask, workingState } from './graph-layout.js';
import { detail, overview } from './navigate.js';
import { activateDetailView } from './sidebar-ui.js';
import { saveGraphPrefs, ui } from './state.js';

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
  activateDetailView({ title: '分支图', context: '核心视图', hint: '沿谱系理解工作，并把成果逐层收口' });
  if (location.hash !== '#graph') window.history.pushState(null, '', '#graph');
  await loadGraph();
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
  return fetchGraph().then(graph => { renderGraph(graph, { force: true }); return graph; });
}

const LANE_CLASS = level => `graph-node l${Math.min(Number(level) || 0, 6)}`;

/** 待决 notice 的徽标文案：问题（等你答复）与计划（等你拍板）分开说，与任务详情 / 意图面板一致。 */
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
 * 任务行里的决策区（`node.notice` 存在时才有）：徽标 + 正文 + 就地的输入与按钮。
 * 口径来自 graph.get：`notice` 是 open 且 kind 为 question / plan 的最新一条，`notice_count` 是这类 notice 的总数。
 * 动作沿用本文件既有的范式：`await action(...)` 成功后写一句结论并 `await loadGraph()` 重拉这张图；
 * 失败由 dom.js 的 button 统一写进 #error，不抛到页面上。
 */
function decisionRow(node) {
  const notice = node.notice;
  const decision = el('div', undefined, 'graph-decision');
  const head = el('div', undefined, 'graph-decision-head');
  head.append(badge(DECISION_BADGE[notice.kind] || '等你决定', 'b-awaiting'));
  if (notice.title) head.append(el('span', notice.title, 'graph-decision-title'));
  const count = Number(node.notice_count) || 0;
  // 同一任务可以攒下多条（例如又问了一次）：图上给一条最新，但要说清楚还有多少条。
  if (count > 1) head.append(el('span', `另有 ${count - 1} 条待决`, 'meta graph-decision-more'));
  decision.append(head);
  // 正文常常是问题或计划的全部说明：保留换行、限高滚动，不能只给标题或截成看不全。
  decision.append(el('p', notice.body || '（没有补充说明）', 'graph-decision-body'));

  const actions = el('div', undefined, 'actions graph-decision-actions');
  const done = async message => { $('error').textContent = message; await loadGraph(); };

  // 计划审批：与 render-intents.js 的 planActions 同一对动作（id 用 planner 任务 id，RPC 也接受这条 notice 的 id）。
  if (notice.kind === 'plan') {
    actions.append(button('批准并开发', async () => {
      await action('plan.approve', { id: node.id });
      await done(`已批准 #${node.id} 的拆解，交给 scheduler 编排`);
    }, 'primary'));
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
    }));
    decision.append(actions);
    return decision;
  }

  // 提问：输入框 + 回复 / 忽略；⌘/Ctrl+回车与任务详情里的同一个提交。
  const input = el('textarea', undefined, 'graph-decision-input');
  input.placeholder = '你的决定；⌘/Ctrl+回车提交';
  input.rows = 3;
  const reply = button('回复并继续任务', async () => {
    const answer = input.value;
    await action('notice.answer', { id: notice.id, answer });
    releaseDecisionInput(input);
    await done(`已把答复发给任务 #${node.id}，它会继续跑`);
  });
  input.addEventListener('keydown', async event => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    await reply.onclick();
  });
  actions.append(reply, button('忽略', async () => {
    await action('notice.dismiss', { id: notice.id });
    releaseDecisionInput(input);
    await done(`已忽略任务 #${node.id} 的这条待决事项`);
  }, 'ghost'));
  decision.append(input, actions);
  return decision;
}

/** 任务行。`owningBranch` 是包裹它的那条分支：任务就在这条分支上时不再重复写一遍分支名（表头已经写了）；
 *  只有当任务退到目标分支分组（自己那条分支没有节点）或兜底分组时，分支名才是独有信息，必须画出来。 */
function taskRow(node, owningBranch = null) {
  const row = el('div', undefined, LANE_CLASS(node.level));
  // 在跑 / 排队 / 等着的任务同样带上工作态强调，和它所在的分支一起被看见。
  if (isWorkingTask(node)) row.classList.add('graph-emphasis-working');
  // 在跑的任务行除了左边条再给一个脉冲点：旁边的「运行中」文案有了一眼可见的对应标记。
  if (node.status === 'running') row.append(el('span', '●', 'graph-work-dot'));
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
  // 这件事在等你拍板：整行带琥珀强调（与未合并 / 工作中的强调可同时存在），决策区把正文与
  // 处理按钮直接摊在这一行里——用户不用先去左侧「待定事项」或别的页面。没有 notice 的任务行一个字段都不加。
  if (node.notice) {
    row.classList.add('graph-emphasis-awaiting');
    row.append(decisionRow(node));
  }
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

/** 归档一子树分支：删掉这条分支与它全部后代的 worktree / 本地 ref，任务、会话与分支记录都留着。
 *  未提交改动只能连 worktree 一起丢，所以先确认；确认走应用内弹窗（dialog.js）——原生 confirm
 *  会被浏览器静默吃掉，那时按钮会变成什么都不做。 */
async function runBranchArchive(branch) {
  const descendants = Number(branch.subtreeBranches) || 0;
  const scope = descendants
    ? `会删除这条分支与它下面 ${descendants} 条后代分支的 worktree 与本地 ref`
    : '会删除这条分支的 worktree 与本地 ref';
  const confirmed = await confirmDialog({
    title: `归档 ${branch.name}？`,
    message: `${scope}，保留任务、会话与分支记录（记录仍可在「分支详情」与任务详情里查）；未提交改动会被丢弃。`,
    confirmLabel: '归档',
    cancelLabel: '保留',
    danger: true,
  });
  if (!confirmed) return;
  try {
    const result = await action('branch.archive', { branch: branch.name, discard: true });
    const count = Number(result?.count) || 1;
    const dropped = result?.discarded ? '，已丢弃未提交改动' : '';
    $('error').textContent = count > 1
      ? `已归档 ${branch.name} 及它下面 ${count - 1} 条后代分支（共 ${count} 条）：worktree 与本地 ref 已删${dropped}，任务、会话与分支记录都保留`
      : `${branch.name} 已归档（worktree ${result?.worktree ?? 'absent'}、分支 ${result?.ref ?? 'absent'}${dropped}）；任务与会话已保留`;
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
 * 父子关系的处理选项（文案与颜色都来自 graphLayout 算好的 relation.key）：
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
  // 工作态标识只回答显示：running / pending 给 chip，subtree 给一行更弱的话，停下来的分支一个都不画。
  const work = workingState(branch);
  // 当前没有工作的分支整体降噪（.graph-idle）：分支名与元信息降到次级色，不再占工作态的强调通道。
  // 只在 `working` 也为 false 时才加，保证强调 class（未合并 / 工作态）永远不会被降噪规则盖掉。
  if (!work && !branch.working) row.classList.add('graph-idle');
  // 只有真的能藏东西的分支才给箭头：任务和子分支都是空的时候，收起没意义。
  const hideable = branch.subtreeBranches + branch.subtreeTasks > 0;
  if (hideable) row.append(collapseCaret(branch, onCollapsed));
  row.append(el('span', `⎇ ${branch.name}`, 'graph-branch-name mono'));
  if (branch.head_commit) row.append(el('span', String(branch.head_commit).slice(0, 7), 'meta mono'));
  // 只被 parent 指针提到、既无记录也无 ref：占位，不假装分支还在。
  else if (branch.placeholder) row.append(el('span', '⚠ 仅谱系提及', 'chip warn'));
  // 记录还在、ref 已经不在（又不是归档：归档的分支不会画进分支树）：分支被删了，明说它现在不存在。
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

  // 工作态标识放在分支名之后、关系 chip 之前：先看到「这条还在动」，再看它和父分支的关系。
  // 收起的是任务与子分支，状态属于这条分支本身，所以表头上永远显示。
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
  for (const node of forkActions(branch, edge)) row.append(node);

  // 分支元数据：状态、标题、来源、创建时间、任务计数
  const meta = el('div', undefined, 'graph-branch-meta');
  // 有子分支还没收拢时不能合并：这条提示只和 fork 边有关，但不适合塞进挤满 chip 的表头行。
  if (edge?.blockers?.length) meta.append(el('span', `先收拢子分支：${edge.blockers.join('、')}`, 'graph-branch-blocker'));
  // 归档分支的状态固定显示「已归档」，不被汇总出来的旧状态盖掉。表头已经报过它（ref 是归档时
  // 按预期删掉的），所以这里只补归档时间，不把同一个词再说一遍。
  // 归档分支的状态不需要在这里特判：归档的分支不会被画进分支树（见 graphLayout 的 hiddenBranches）。
  if (BRANCH_STATUS[branch.status]) {
    const statusInfo = BRANCH_STATUS[branch.status];
    meta.append(el('span', statusInfo.label, `chip ${statusInfo.className}`.trim()));
  }
  if (branch.title) {
    const titleNode = el('span', branch.title, 'graph-branch-title');
    // 摘要可能被分支名等挤窄：悬停时给出完整摘要，不依赖标题文本本身。
    if (branch.summary) titleNode.title = branch.summary;
    meta.append(titleNode);
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
  // 归档一条＝归档它整棵子树（见 runBranchArchive 的确认文案）。
  if (branch.archivable && !branch.archived) row.append(button('归档', () => runBranchArchive(branch), 'ghost'));

  return row;
}

/**
 * 一条分支子树：自己的表头 + 自己的任务，子分支作为一个缩进的子树块画在下面。父子的连接靠 CSS 画的
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
  heading.append(el('span', 'BRANCH MAP', 'eyebrow'), el('span', '分支图', 'tid-lg'),
    el('p', '分支是项目演进的主线。顺着父子关系检查工作状态、处理分歧，并将完成的成果逐层合回。', 'hero-description'));
  const actions = el('div', undefined, 'actions');
  actions.append(button('刷新分支状态', () => loadGraph(), 'ghost'), button('查看概览', () => overview(), 'ghost'));
  head.append(heading, actions);
  content.push(head);

  const summary = el('div', undefined, 'graph-summary');
  for (const [label, value] of [
    ['分支', String(layout.branch_count)],
    ['任务', String(layout.task_count)],
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
  if (!layout.forest.length && !layout.unplaced.length) content.push(el('p', '还没有任何任务分支或 worktree。', 'hint'));

  for (const branch of layout.forest) content.push(branchBlock(branch));
  for (const group of layout.unplaced) content.push(unplacedBlock(group));
  view.replaceChildren(...content);
  return view;
}
