/**
 * 分支图的纯逻辑：把 `graph.get` 的平铺 nodes / edges 变成「分支谱系森林 + 每条分支下的任务」。
 * 无 DOM、无副作用，浏览器里以 ES module 加载，测试里由 bun 直接 import。
 *
 * fork 边（`{ kind:'fork', from:'branch:A', to:'branch:B' }`）就是父子关系：B 从 A 分出来。
 * 任务挂在它自己那条分支节点下，找不到时退到目标分支节点，两个都没有才进 `unplaced` 兜底分组——
 * 所以刚创建的分支会作为父分支的子树出现，一眼看得出从哪条分支分出来，而不是给每条分支单开一个车道。
 * 组内 code 层级口径与 `src/core/merge-batch.js` 的 mergeOrder 一致：上游在前、并列按 id 升序。
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

/** 节点徽标：合并状态、缺失的 worktree / 分支、是否当前检出。缺失必须显式标出来，不能假装存在。 */
export function nodeMarks(node) {
  const marks = [];
  if (node?.merged === true) marks.push({ text: '已合并', className: 'ok' });
  else if (node?.merged === false) marks.push({ text: '未合并', className: '' });
  if (node?.workspace_state === 'missing') marks.push({ text: '⚠ 缺失 worktree', className: 'warn' });
  // 归档分支的 ref 已经删掉，但这是预期状态：报「已归档」而不是「缺失分支」。
  if (node?.archived === true) marks.push({ text: '已归档', className: '' });
  else if (node?.branch_state === 'missing' && node?.branch) marks.push({ text: '⚠ 缺失分支', className: 'warn' });
  if (node?.current) marks.push({ text: '当前检出', className: '' });
  return marks;
}

/** 分支节点的排序：当前检出的最前，其余按名字，保证每次渲染顺序稳定。 */
const byCurrentThenName = (a, b) =>
  Number(b?.current === true) - Number(a?.current === true) || String(a?.name ?? '').localeCompare(String(b?.name ?? ''));

const nameOfBranchId = id => (typeof id === 'string' && id.startsWith('branch:')) ? id.slice('branch:'.length) : null;

/**
 * @param {object} graph `graph.get` 的返回（{ nodes, edges, current_branch, ... }）
 * @returns {{forest:Array, unplaced:Array, current_branch:string|null, git:boolean, truncated:boolean, error:string|null}}
 *   `forest` 是分支根节点数组，每个节点 `{ name, id, head_commit, current, tracked, placeholder, incoming, depth, children, tasks }`；
 *   `tasks` 里的任务节点带 `level` / `upstreams` / `aheadBehind` / `marks`，直接供渲染使用；
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

  const order = [...branchNodes].sort(byCurrentThenName);
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
      .sort((a, b) => byCurrentThenName(branchByName.get(a), branchByName.get(b)));
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
    })).sort((a, b) => a.level - b.level || a.id - b.id);
  };
  const walk = entry => { entry.tasks = decorate(entry.tasks); for (const child of entry.children) walk(child); };
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
