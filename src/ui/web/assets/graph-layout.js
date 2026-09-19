/**
 * 分支图的纯逻辑：把 `graph.get` 的平铺 nodes / edges 变成「按目标分支分组的车道 + 组内层级 + 标签」。
 * 无 DOM、无副作用，浏览器里以 ES module 加载，测试里由 bun 直接 import。
 *
 * 层级口径与 `src/core/merge-batch.js` 的 mergeOrder 一致：code 上游在前，并列按 id 升序，
 * 且只看同一目标分支组内的 code 边——跨分支的 code 边不会把两边的层叠关系硬扯到一起。
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
  if (node?.branch_state === 'missing' && node?.branch) marks.push({ text: '⚠ 缺失分支', className: 'warn' });
  if (node?.current) marks.push({ text: '当前检出', className: '' });
  return marks;
}

/**
 * @param {object} graph `graph.get` 的返回（{ nodes, edges, current_branch, ... }）
 * @returns {{groups:Array, current_branch:string|null, git:boolean, truncated:boolean, error:string|null}}
 *   groups 已排序（当前检出的分支最前，其余按名字），每组 `{ target_branch, current, branch, items }`，
 *   items 里的任务节点带 `level` / `upstreams` / `aheadBehind` / `marks`，直接供渲染使用。
 */
export function graphLayout(graph = {}) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const taskNodes = nodes.filter(node => node.kind === 'task');
  const branchNodes = nodes.filter(node => node.kind === 'branch');
  const codeEdges = edges.filter(edge => edge.kind === 'code' && byId.has(edge.from) && byId.has(edge.to));

  const grouped = new Map();
  for (const node of taskNodes) {
    const key = node.target_branch || '(未知目标分支)';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(node);
  }
  // 当前检出分支即使没有任何任务，也要有自己的车道。
  for (const branch of branchNodes) if (!grouped.has(branch.name)) grouped.set(branch.name, []);

  const branchByName = new Map(branchNodes.map(node => [node.name, node]));
  const groups = [...grouped.entries()].map(([target_branch, items]) => {
    const ids = new Set(items.map(node => node.id));
    const upstreams = new Map(items.map(node => [node.id, []]));
    for (const edge of codeEdges) {
      if (ids.has(edge.to) && ids.has(edge.from)) upstreams.get(edge.to).push(edge.from);
    }
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
    const decorated = items.map(node => ({
      ...node,
      level: level.get(node.id) ?? 0,
      upstreams: [...(upstreams.get(node.id) || [])].sort((a, b) => a - b),
      aheadBehind: aheadBehindText(node),
      marks: nodeMarks(node),
    })).sort((a, b) => a.level - b.level || a.id - b.id);
    const branch = branchByName.get(target_branch) || null;
    return {
      target_branch, branch, items: decorated,
      current: branch?.current === true || decorated.some(node => node.current),
    };
  }).sort((a, b) => Number(b.current) - Number(a.current) || a.target_branch.localeCompare(b.target_branch));

  return {
    groups,
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
  const nodes = (graph?.nodes || []).map(node => [node.id, node.kind, node.branch_state ?? '-', node.workspace_state ?? '-',
    node.ahead ?? '-', node.behind ?? '-', node.merged ?? '-', node.current === true].join(':')).join('|');
  const edges = (graph?.edges || []).map(edge => `${edge.kind}:${edge.from}>${edge.to}`).join('|');
  return `${nodes}#${graph?.truncated === true}#${edges}`;
}
