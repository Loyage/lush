/**
 * Branch genealogy 的纯逻辑：只认识「branch 行 + parent 指针」，不碰 git、不写盘、不渲染。
 *
 * 这样 storage/model 与 tree renderer 是两个东西：CLI 文本树只是 `buildForest` 的一个 viewer，
 * WebUI 以后可以拿同一份数据画别的形状，不必迁就 CLI 的排版。
 * 行（row）形状至少要有 `branch` 与 `parent`；`created_at` 用于稳定排序，其余字段原样透传。
 */

export const isDefaultBranch = name => name === 'main' || name === 'master';
const byCreated = (a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
  || a.branch.localeCompare(b.branch);

function index(rows) { return new Map(rows.map(row => [row.branch, row])); }

/** 自指（坏数据）当成没有 parent。 */
function rawParent(row) {
  const parent = row?.parent ?? null;
  return parent && parent !== row.branch ? parent : null;
}

/** parent(branch)：返回记录下来的 parent 名字；parent 行本身可能已经不存在（那时它仍是一个事实）。 */
export function parentOf(rows, name) { return rawParent(index(rows).get(name)); }

/** children(branch)：直接子分支，按创建时间排序。 */
export function childrenOf(rows, name) {
  return rows.filter(row => rawParent(row) === name).sort(byCreated).map(row => row.branch);
}

/** ancestors(branch)：根在前、直接 parent 在后，不含自己。坏数据成环时见好就收。 */
export function ancestorsOf(rows, name) {
  const out = [];
  const seen = new Set([name]);
  for (let current = parentOf(rows, name); current && !seen.has(current); current = parentOf(rows, current)) {
    out.unshift(current); seen.add(current);
  }
  return out;
}

/** chainOf(branch)：从根到自己的完整链条，含自己。 */
export function chainOf(rows, name) { return [...ancestorsOf(rows, name), name]; }

/** root(branch)：链条最上面那个；自己就是根时返回自己。 */
export function rootOf(rows, name) { return ancestorsOf(rows, name)[0] ?? name; }

/** descendants(branch)：全部后代（广度优先，顺序稳定），不含自己。 */
export function descendantsOf(rows, name) {
  const out = [];
  const seen = new Set([name]);
  const queue = [name];
  while (queue.length) {
    for (const child of childrenOf(rows, queue.shift())) {
      if (seen.has(child)) continue;
      seen.add(child); out.push(child); queue.push(child);
    }
  }
  return out;
}

/**
 * 组成森林：每个分支一个节点，`children` 是直接子分支数组；返回根节点数组。
 *
 * 两件必须做的事，都是为了「不要因为一条记录坏了就丢掉整棵树」：
 * - parent 只有名字、自己没有记录（也没 ref）时补一个占位节点，子分支不会从树上掉下去；
 * - parent 链成环时把这条边断开当根，绝不让渲染无限递归。
 */
export function buildForest(rows) {
  const nodes = new Map();
  const order = [];
  const put = row => {
    if (nodes.has(row.branch)) return nodes.get(row.branch);
    const node = { ...row, children: [] };
    nodes.set(row.branch, node); order.push(node); return node;
  };
  for (const row of rows) put(row);
  for (const node of [...order]) {
    const parent = rawParent(node);
    if (parent && !nodes.has(parent)) put({ branch: parent, parent: null, placeholder: true });
  }
  const roots = [];
  for (const node of order) {
    const parentName = rawParent(node);
    const parent = parentName ? nodes.get(parentName) : null;
    if (!parent || wouldCycle(node, parent, nodes)) roots.push(node); else parent.children.push(node);
  }
  const sort = list => { list.sort((a, b) => Number(isDefaultBranch(b.branch)) - Number(isDefaultBranch(a.branch)) || byCreated(a, b)); for (const node of list) sort(node.children); };
  sort(roots);
  return roots;
}

/** 把 node 挂到 parent 下会不会连成环：顺着 parent 链往上找 node。 */
function wouldCycle(node, parent, nodes) {
  const seen = new Set();
  for (let current = parent; current && !seen.has(current.branch); current = current.parent ? nodes.get(current.parent) : null) {
    if (current === node) return true;
    seen.add(current.branch);
  }
  return false;
}
