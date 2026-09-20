/**
 * 分支图的纯逻辑：把 `graph.get` 的平铺 nodes / edges 变成「分支谱系森林 + 每条分支下的任务」。
 * 无 DOM、无副作用，浏览器里以 ES module 加载，测试里由 bun 直接 import。
 *
 * fork 边（`{ kind:'fork', from:'branch:A', to:'branch:B' }`）就是父子关系：B 从 A 分出来。
 * 任务挂在它自己那条分支节点下，找不到时退到目标分支节点，两个都没有才进 `unplaced` 兜底分组——
 * 所以刚创建的分支会作为父分支的子树出现，一眼看得出从哪条分支分出来，而不是给每条分支单开一个车道。
 * 组内 code 层级与 `src/core/merge-batch.js` 的 mergeOrder 同源（上游在前）；差别只在并列面：mergeOrder 决定
 * 执行次序用 id 升序，这里只决定展示顺序，用 id 降序（新的任务在前）。
 * 同一层级的迭代方向统一为「新的在前」：兄弟分支按创建时间从新到旧，同一分支下同 level 的任务按 id 降序。
 */

/** 领先 / 落后文案；任一侧取不到就不写，而不是假装是 0。 */
export function aheadBehindText(node) {
  const ahead = Number.isFinite(node?.ahead) ? node.ahead : null;
  const behind = Number.isFinite(node?.behind) ? node.behind : null;
  if (ahead === null && behind === null) return '';
  const parts = [];
  if (ahead !== null) parts.push(`领先 ${ahead}`);
  if (behind !== null) parts.push(`落后 ${behind}`);
  return parts.join(' · ');
}

/** 节点徽标：缺失的 worktree / 分支、是否当前检出。缺失必须显式标出来，不能假装存在。
 *  合并状态只标「未合并」：已合进目标分支是常态，不再单独占一个标签（分支图靠「未合进父分支」的强调表示异常）。 */
export function nodeMarks(node) {
  const marks = [];
  if (node?.merged === false) marks.push({ text: '未合并', className: '' });
  if (node?.workspace_state === 'missing') marks.push({ text: '⚠ 缺失 worktree', className: 'warn' });
  // 归档分支的 ref 已经删掉，但这是预期状态：报「已归档」而不是「缺失分支」。
  if (node?.archived === true) marks.push({ text: '已归档', className: '' });
  else if (node?.branch_state === 'missing' && node?.branch) marks.push({ text: '⚠ 缺失分支', className: 'warn' });
  if (node?.current) marks.push({ text: '当前检出', className: '' });
  return marks;
}

/** 创建时间 -> 毫秒；取不到（null / 空串 / 坏值）返回 null，排序时当作「未知」排在已知时间之后。 */
const createdAtMs = value => {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** 创建时间新的在前；未知时间一律排在已知时间之后。 */
const byNewestFirst = (a, b) => {
  const ta = createdAtMs(a?.created_at);
  const tb = createdAtMs(b?.created_at);
  if (ta === tb) return 0;
  if (ta === null) return 1;
  if (tb === null) return -1;
  return tb - ta;
};

/** 分支节点的排序：当前检出的最前，其余按创建时间从新到旧；没有创建时间的排在已知时间之后，
 *  再同名时按分支名升序兜底，保证每次渲染顺序稳定、可重复。 */
const byCurrentThenNewest = (a, b) =>
  Number(b?.current === true) - Number(a?.current === true)
  || byNewestFirst(a, b)
  || String(a?.name ?? '').localeCompare(String(b?.name ?? ''));

/** 「正在工作中」的任务状态：还占着槽、等槽或等用户——这些是该被看见的活。 */
export const WORKING_STATUSES = new Set(['running', 'queued', 'waiting', 'awaiting']);
export const isWorkingTask = node => WORKING_STATUSES.has(node?.status);

/** 没有合进父分支：有 incoming fork 边、关系又不是 integrated（fast_forward / diverged / missing / unknown）。
 *  根分支（没有来边）不算——它没有父分支可合。 */
export const isUnmergedBranch = entry => Boolean(entry?.incoming) && entry.incoming.status !== 'integrated';

/** 分支节点的强调 class（顺序固定，便于断言）：未合进父分支 / 正在工作中，两个可以同时命中。 */
export function emphasisClasses(entry) {
  const classes = [];
  if (entry?.unmerged) classes.push('graph-emphasis-unmerged');
  if (entry?.working) classes.push('graph-emphasis-working');
  return classes;
}

/** 「在等」三种子状态的优先级：等你决定 > 等子任务 > 排队中；标签只取其中最高的那个。 */
const PENDING_LABELS = [
  ['awaiting', '等你决定'],
  ['waiting', '等子任务'],
  ['queued', '排队中'],
];

/** 这条分支自己的任务里，还占着槽 / 等槽 / 等用户的任务；含后代的可数版本见 countWorkingTasks。 */
const ownWorkingTasks = entry => (entry?.tasks || []).filter(isWorkingTask);

/** 一棵子树（含自己）里有多少工作态任务；workingState 的 subtree 分支只数这条分支的显示口径。 */
const countWorkingTasks = entry => {
  let total = ownWorkingTasks(entry).length;
  for (const child of entry?.children || []) total += countWorkingTasks(child);
  return total;
};

/**
 * 一条分支「怎么显示工作态」——只回答显示，不改 `working` / `defaultExpanded` / `emphasisClasses` 的语义
 * （默认折叠与强调 class 都继续依赖那几个字段）。优先级固定：
 * - `running`：本分支自己的任务里有在跑的——最直接的「现在真的在动」；
 * - `pending`：自己没有在跑，但有等用户 / 等子任务 / 排队的任务——在等，同样不是停下来的分支；
 * - `subtree`：自己什么都没有，后代子树里还有活；
 * - `null`：这条分支停下来了（当前没有任何工作态任务），可以让 UI 整体降噪。
 * `count` 一律是这些工作态任务的数量：running / pending 只数自己的，subtree 数后代子树的。
 * @returns {{key:'running'|'pending'|'subtree', label:string, count:number}|null}
 */
export function workingState(entry) {
  const own = ownWorkingTasks(entry);
  const running = own.filter(node => node?.status === 'running').length;
  if (running > 0) return { key: 'running', label: '工作中', count: running };
  const pending = PENDING_LABELS.find(([status]) => own.some(node => node?.status === status));
  if (pending) return { key: 'pending', label: pending[1], count: own.length };
  let descendants = 0;
  for (const child of entry?.children || []) descendants += countWorkingTasks(child);
  if (descendants > 0) return { key: 'subtree', label: '子树工作中', count: descendants };
  return null;
}

const NO_NAMES = new Set();

/** 这条分支当前是否收起：用户的显式切换优先于默认值。
 *  显式展开 > 显式收起 > 默认值（自己或后代未合进父分支 / 在跑的分支默认展开）。 */
export function isBranchCollapsed(entry, expanded = NO_NAMES, collapsed = NO_NAMES) {
  if (expanded.has(entry?.name)) return false;
  if (collapsed.has(entry?.name)) return true;
  return entry?.defaultExpanded !== true;
}

/**
 * 一条 fork 边对用户意味着什么：把「状态 + ahead/behind」压成一种父子关系。颜色与文案都从这一个 key 出，
 * 页面各处不会各说各话：
 * - `ahead`：子分支有独有提交（behind=0）——可以直接 fast-forward 合入父分支；
 * - `equal`：两端同一个 commit——已经一致，没什么要做；
 * - `behind`：子分支没有独有提交、父分支已前进——可以直接快进跟上；
 * - `diverged` / `missing` / `unknown`：分歧 / 缺 ref / 没可信 parent。
 */
export function edgeRelation(edge) {
  if (!edge) return null;
  const key = edge.status === 'missing' ? 'missing'
    : edge.status === 'unknown' ? 'unknown'
    : edge.status === 'diverged' ? 'diverged'
    : edge.status === 'fast_forward' ? 'ahead'
    : (edge.behind > 0 ? 'behind' : 'equal');
  const label = {
    ahead: '可 fast-forward',
    equal: '与父分支一致',
    behind: `落后父分支 ${Number.isFinite(edge.behind) ? edge.behind : '?'}`,
    diverged: '父子已分歧',
    missing: '分支缺失',
    unknown: '关系未知',
  }[key];
  return { key, label };
}

const nameOfBranchId = id => (typeof id === 'string' && id.startsWith('branch:')) ? id.slice('branch:'.length) : null;

/**
 * @param {object} graph `graph.get` 的返回（{ nodes, edges, current_branch, ... }）
 * @returns {{forest:Array, unplaced:Array, current_branch:string|null, git:boolean, truncated:boolean, error:string|null}}
 *   `forest` 是分支根节点数组，每个节点 `{ name, id, head_commit, current, tracked, placeholder, incoming, depth, children, tasks }`；
 *   另带 `unmerged`（没合进父分支）、`working`（自己或后代还有在跑的任务）、`defaultExpanded`
 *   （自己或后代命中前两者——默认展开，不允许把未合并 / 在跑的子树藏在收起的父分支里）；
 *   工作态怎么显示由纯函数 `workingState(entry)` 现算（running / pending / subtree / null），
 *   不改上面几个字段的意义；
 *   `tasks` 里的任务节点带 `level` / `upstreams` / `aheadBehind` / `marks`，直接供渲染使用；
 *   `subtreeBranches` / `subtreeTasks` 是收起这棵子树会藏起来的数量（后代分支数、自己的 + 后代的任务数）；
 *   `unplaced` 是连目标分支节点都没有的任务，按目标分支名分组。
 */
export function graphLayout(graph = {}) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const taskNodes = nodes.filter(node => node.kind === 'task');
  const branchNodes = nodes.filter(node => node.kind === 'branch');
  const branchByName = new Map(branchNodes.map(node => [node.name, node]));
  const codeEdges = edges.filter(edge => edge.kind === 'code' && byId.has(edge.from) && byId.has(edge.to));

  // fork 边 -> 直接子分支。一条分支只认第一条 fork 边（坏数据双父时见好就收）；
  // 成环时环里的节点会在下面作为额外根画出来，绝不落到看不见。
  const children = new Map(branchNodes.map(node => [node.name, []]));
  const incoming = new Map();
  const hasParent = new Set();
  for (const edge of edges) {
    if (edge.kind !== 'fork') continue;
    const from = nameOfBranchId(edge.from);
    const to = nameOfBranchId(edge.to);
    if (!from || !to || from === to) continue;
    if (!branchByName.has(from) || !branchByName.has(to) || hasParent.has(to)) continue;
    hasParent.add(to); children.get(from).push(to); incoming.set(to, edge);
  }

  const order = [...branchNodes].sort(byCurrentThenNewest);
  const built = new Map();
  const visited = new Set();
  const build = (node, depth) => {
    const archived = node.archived === true || node.status === 'archived';
    const deleted = node.deleted === true || node.status === 'deleted';
    const activeTasks = Number.isFinite(node.tasks?.active) ? node.tasks.active : 0;
    // 可归档 = 已登记分支、没归档也没被删、不是当前检出、自己与后代都没有活动任务，
    // 且还有东西可删（ref 或 worktree 至少存在一个）；已归档的分支永远不再可归档。
    const archivable = !archived && node.tracked === true && !deleted && node.current !== true
      && activeTasks === 0 && (Boolean(node.head_commit) || node.worktree_state === 'present');
    const entry = {
      name: node.name, id: node.id, head_commit: node.head_commit ?? null,
      current: node.current === true, tracked: node.tracked !== false, placeholder: node.placeholder === true,
      incoming: incoming.get(node.name) ?? null, depth, children: [], tasks: [],
      // 分支节点的元数据（来自 graph.js 的 origin / title / source_id / created_at / status / tasks）
      origin: node.origin ?? null,
      title: node.title ?? null,
      source_id: node.source_id ?? null,
      created_at: node.created_at ?? null,
      status: node.status ?? null,
      taskCounts: node.tasks ?? null,
      // 归档状态与「这条分支现在能不能归档」；render 只消费，判断只在这里。
      archived,
      archived_at: node.archived_at ?? null,
      archivable,
    };
    built.set(node.name, entry); visited.add(node.name);
    const childNames = (children.get(node.name) || [])
      .sort((a, b) => byCurrentThenNewest(branchByName.get(a), branchByName.get(b)));
    for (const childName of childNames) {
      if (visited.has(childName)) continue;
      entry.children.push(build(branchByName.get(childName), depth + 1));
    }
    return entry;
  };
  const forest = [];
  for (const node of order) if (!hasParent.has(node.name)) forest.push(build(node, 0));
  for (const node of order) if (!visited.has(node.name)) forest.push(build(node, 0));

  // 任务挂到自己的分支节点下；没有就退到目标分支节点；两个都没有才兜底。
  const unplaced = new Map();
  for (const node of taskNodes) {
    const branch = (node.branch && built.has(node.branch) && node.branch)
      || (node.target_branch && built.has(node.target_branch) && node.target_branch);
    if (branch) { built.get(branch).tasks.push(node); continue; }
    const key = node.target_branch || '(未知目标分支)';
    if (!unplaced.has(key)) unplaced.set(key, []);
    unplaced.get(key).push(node);
  }

  const decorate = items => {
    const ids = new Set(items.map(node => node.id));
    const upstreams = new Map(items.map(node => [node.id, []]));
    for (const edge of codeEdges) if (ids.has(edge.to) && ids.has(edge.from)) upstreams.get(edge.to).push(edge.from);
    const level = new Map();
    const depth = (id, seen = new Set()) => {
      if (level.has(id)) return level.get(id);
      if (seen.has(id)) return 0;
      seen.add(id);
      const ups = upstreams.get(id) || [];
      const value = ups.length ? 1 + Math.max(...ups.map(up => depth(up, seen))) : 0;
      level.set(id, value); return value;
    };
    for (const node of items) depth(node.id);
    return items.map(node => ({
      ...node,
      level: level.get(node.id) ?? 0,
      upstreams: [...(upstreams.get(node.id) || [])].sort((a, b) => a - b),
      aheadBehind: aheadBehindText(node),
      marks: nodeMarks(node),
    })).sort((a, b) => a.level - b.level || b.id - a.id);
  };
  const walk = entry => {
    entry.tasks = decorate(entry.tasks);
    // 收起一棵子树时要说清楚藏了什么：分支数只数后代，任务数包含自己的任务（它们一起被收起）。
    let branches = 0, tasks = entry.tasks.length;
    entry.unmerged = isUnmergedBranch(entry);
    let activeTasks = entry.tasks.some(isWorkingTask);
    let descendantEmphasis = false;
    for (const child of entry.children) {
      walk(child);
      branches += 1 + child.subtreeBranches;
      tasks += child.subtreeTasks;
      activeTasks = activeTasks || child.working;
      if (child.defaultExpanded) descendantEmphasis = true;
    }
    // 分支汇总 status 的 active 就是「这条子树还有 running/queued/waiting/awaiting 的任务」；
    // 汇总字段缺省时退回自己看子树里的任务状态，不把在跑的活藏起来。
    entry.working = entry.status === 'active' || activeTasks;
    entry.defaultExpanded = entry.unmerged || entry.working || descendantEmphasis;
    entry.subtreeBranches = branches; entry.subtreeTasks = tasks;
  };
  for (const root of forest) walk(root);

  return {
    forest,
    unplaced: [...unplaced.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([target_branch, items]) => ({ target_branch, items: decorate(items) })),
    branch_count: branchNodes.length, task_count: taskNodes.length,
    current_branch: graph.current_branch ?? null,
    git: graph.git !== false,
    truncated: graph.truncated === true,
    error: graph.error ?? null,
  };
}

/** 分支图折叠状态的持久化 key：存的是分支名数组——用户看得见的那串名字，比内部 id 稳定也好排查。
 *  两个 key 分工明确：`lush.graphCollapsed` 是用户显式收起的分支（旧的同名 key 继续生效），
 *  `lush.graphExpanded` 是用户显式展开的分支。都不写的分支按 `defaultExpanded` 算。 */
export const GRAPH_COLLAPSED_KEY = 'lush.graphCollapsed';
export const GRAPH_EXPANDED_KEY = 'lush.graphExpanded';

/** localStorage 里的折叠列表 → Set；只保留非空字符串，坏数据当空（宁可全展开，也不静默藏东西）。 */
export function parseGraphCollapsed(raw) {
  if (typeof raw !== 'string' || !raw) return new Set();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return new Set(); }
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter(name => typeof name === 'string' && name.length > 0));
}

/** Set/数组 → localStorage 字符串：排序输出，结果稳定可断言。分支改名 / 删除后的残留名字不清理——
 *  渲染时对不上名就不生效，下次收起别的分支时顺手写回去。 */
export function serializeGraphCollapsed(collapsed) {
  const set = collapsed instanceof Set ? collapsed : new Set(Array.isArray(collapsed) ? collapsed : []);
  return JSON.stringify([...set].filter(name => typeof name === 'string' && name).sort());
}

/**
 * 廉价结构指纹：从 1.5s 轮询拿到的 snapshot 派生，只用来判断「值不值得再拉一次 /api/graph」。
 * 它不求覆盖分支 / worktree 的全部变化（那些只有 graph 自己知道），但任务状态、合并状态与
 * 交付队列的依赖结构一变就会不同，足以覆盖绝大多数自动刷新场景；用户还可以点视图内刷新。
 * 分支在 UI 外新建时指纹不会变，所以视图另有一条最长刷新间隔兜底（见 refresh.js）。
 */
export function graphFingerprint(snapshot) {
  if (!snapshot) return '';
  const tasks = (snapshot.tasks || []).map(task => `${task.id}:${task.status}:${task.integration}:${task.role}`).join(',');
  const ladder = snapshot.ladder || {};
  const nodes = (ladder.nodes || []).map(node => `${node.id}:${node.branch ?? '-'}:${node.target_branch ?? '-'}:${node.level ?? 0}:${node.integration ?? '-'}`).join(',');
  const groups = (ladder.groups || []).map(group => `${group.target_branch}:${(group.items || []).map(item => `${item.id}:${item.phase}`).join('|')}`).join(',');
  return `${tasks}::${nodes}::${groups}`;
}

/** 渲染幂等用的图指纹：同一份数据重画不重复建节点，滚动位置也不被冲掉。 */
export function graphRenderKey(graph) {
  const nodes = (graph?.nodes || []).map(node => [node.id, node.kind, node.name ?? '-', node.head_commit ?? '-',
    node.branch_state ?? '-', node.workspace_state ?? '-', node.ahead ?? '-', node.behind ?? '-', node.merged ?? '-',
    node.current === true, node.tracked === false, node.placeholder === true, node.archived === true,
    node.worktree_state ?? '-', node.tasks?.active ?? '-',
    node.origin ?? '-', node.status ?? '-', node.title ?? '-', node.source_id ?? '-'].join(':')).join('|');
  const edges = (graph?.edges || []).map(edge => `${edge.kind}:${edge.from}>${edge.to}:${edge.status ?? '-'}:${edge.ahead ?? '-'}:${edge.behind ?? '-'}:${(edge.blockers || []).join(',')}`).join('|');
  return `${nodes}#${graph?.truncated === true}#${edges}`;
}
