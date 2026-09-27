/**
 * 左栏排序：纯函数，不依赖 DOM / window，浏览器里以 ES module 加载，测试里由 bun 直接 import。
 *
 * AP 树的「分组」（谁挂在谁下面）和「排序」（同一父 AP 下谁先渲染）必须是同一棵树的两面。
 * 两边各写一遍 parent 规则迟早会漂移，所以 renderTree 与这里的 rankAPs 共用 treeParent()。
 * 历史输入 / 规划 AP / 待定事项没有树结构，只按「最多一条时间线」排，共用 orderList()。
 *
 * 档位（数字越小越靠前）：
 *   0 有未答复 notice  —— 卡在用户身上的 AP 最该被看见。
 *   1 活跃              —— running / awaiting / waiting / queued，机器还在推进或马上会推进。
 *   2 等待人工处理的终态 —— completed 且 integration ∈ pending/review/merging，等你批准合并。
 *   3 没什么用的        —— completed 且 integration ∈ merged/none，以及 failed / cancelled。
 * failed 与 cancelled 不再单独拆档：两者都没有可交付的产出（失败没结果，取消是用户主动放弃），
 * 与「已合并」一样属于「不需要你再动手」，单独拆一档只会多出一个语义几乎相同的档位。测试固定住这个选择。
 *
 * 排序只决定同一父 AP 下兄弟的先后，树结构与嵌套不变：祖先永远在子孙之前渲染。
 */

export const SORT_MODES = [
  { id: 'smart', label: '智能排序' },
  { id: 'updated', label: '按最近更新' },
  { id: 'id', label: '按编号（新在前）' },
];

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
/** 终态里还需要用户动手的合并状态；merged / none 表示这条线已经收尾。 */
const LIVE_INTEGRATION = new Set(['pending', 'review', 'merging', 'conflict']);
const EMPTY = new Set();

/** 与 app.js 的分组规则一致：verifier / merger 用关联边，父不在当前列表里时当根 AP，不丢节点。 */
export function treeParent(ap, ids) {
  const parent = ap.parent_id ?? ap.verifies_ap_id ?? ap.resolves_ap_id ?? 0;
  return ids.has(parent) ? parent : 0;
}

/** 时间字段解析不出的当 0：排序永远确定，不会因为一条坏数据抛异常。毫秒数与 ISO 字符串都接受。 */
function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : 0;
}

/** 单个 AP 自己的档位，不含后代。 */
function rankOf(ap, openAPIds) {
  if (openAPIds.has(ap.id)) return 0;
  if (!TERMINAL.has(ap.status)) return 1;
  if (ap.status === 'completed' && LIVE_INTEGRATION.has(ap.integration)) return 2;
  return 3;
}

/**
 * 对整棵扁平 AP 表自底向上算档位。
 * @param {Array} aps store.summaries() 的扁平 AP（字段含 id/parent_id/verifies_ap_id/resolves_ap_id/status/integration/updated_at）
 * @param {Set|Array} openNoticeIds 存在未答复 notice 的 ap id 集合（调用方从 notices 里筛 status==='open' 后取 ap_id）；
 *   也接受 notice 行对象（取 ap_id，缺省取 id），方便调用方直接把筛选结果传进来。数字一律按 ap id 解释。
 * @returns {Map<number, {rank:number, effectiveRank:number, activity:number}>}
 *   rank 自身档位；effectiveRank = 自身与所有后代档位的最小值（自己已合并、子树里还有活跃 AP 时不至于把活跃子树藏到底部）；
 *   activity = 自身与后代 updated_at 的最大值（毫秒），用于档位相同时优先看最近动过的。
 */
export function rankAPs(aps, openNoticeIds = []) {
  const raw = openNoticeIds instanceof Set ? [...openNoticeIds] : Array.isArray(openNoticeIds) ? openNoticeIds : [];
  const open = new Set(raw.map(entry => entry && typeof entry === 'object' ? entry.ap_id ?? entry.id : entry));
  const list = Array.isArray(aps) ? aps : [];
  const ids = new Set(list.map(ap => ap.id));
  const byId = new Map(list.map(ap => [ap.id, ap]));
  const children = new Map();
  for (const ap of list) {
    const parent = treeParent(ap, ids);
    if (parent === 0) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(ap.id);
  }
  const ranks = new Map();
  const visiting = new Set();
  const visit = apId => {
    if (ranks.has(apId)) return ranks.get(apId);
    const ap = byId.get(apId);
    if (!ap) return null;
    if (visiting.has(apId)) return null;   // 防环：坏数据下当作没有这个后代，而不是无限递归
    visiting.add(apId);
    let effectiveRank = rankOf(ap, open);
    let activity = timestamp(ap.updated_at);
    for (const childId of children.get(apId) || []) {
      const child = visit(childId);
      if (!child) continue;
      effectiveRank = Math.min(effectiveRank, child.effectiveRank);
      activity = Math.max(activity, child.activity);
    }
    visiting.delete(apId);
    const value = { rank: rankOf(ap, open), effectiveRank, activity };
    ranks.set(apId, value);
    return value;
  };
  for (const ap of list) visit(ap.id);
  return ranks;
}

/** ranks 缺项时按 AP 自身情况兜底（不回滚成"排最后"，只是拿不到后代 roll-up）。 */
function rankEntry(ranks, ap) {
  const known = ranks instanceof Map ? ranks.get(ap.id)
    : ranks && typeof ranks === 'object' ? ranks[ap.id] : null;
  if (known && Number.isFinite(known.effectiveRank)) {
    return { rank: Number.isFinite(known.rank) ? known.rank : known.effectiveRank,
      effectiveRank: known.effectiveRank,
      activity: Number.isFinite(known.activity) ? known.activity : timestamp(ap.updated_at) };
  }
  const rank = rankOf(ap, EMPTY);
  return { rank, effectiveRank: rank, activity: timestamp(ap.updated_at) };
}

/**
 * 只重排同一父 AP 下的兄弟：返回新数组，不修改入参。
 * smart（默认，未知 mode 也回落）：effectiveRank ↑ → rank ↑ → activity ↓ → id ↑。
 * updated：updated_at ↓ → id ↑。id：id ↓（新在前）。
 */
export function orderSiblings(children, { mode, ranks } = {}) {
  const list = Array.isArray(children) ? [...children] : [];
  const sorted = mode === 'updated' || mode === 'id' ? mode : 'smart';
  if (sorted === 'id') return list.sort((a, b) => b.id - a.id);
  if (sorted === 'updated') return list.sort((a, b) => timestamp(b.updated_at) - timestamp(a.updated_at) || a.id - b.id);
  return list.sort((a, b) => {
    const left = rankEntry(ranks, a), right = rankEntry(ranks, b);
    return left.effectiveRank - right.effectiveRank || left.rank - right.rank
      || right.activity - left.activity || a.id - b.id;
  });
}

/**
 * 左栏四个列表共用的排序（行动 AP 另有 orderSiblings，它要跟着树结构走）。
 * smart（默认，未知 mode 也回落）原样返回入参数组本身：每个列表的「智能」口径不同——
 * 历史输入与待定事项保持接口返回的时间线顺序，规划 AP 保持批次分组 + 组内编号升序——
 * 这些都由调用方先排好，orderList 不再插手，零开销也不会打乱它们的口径。
 * updated：按 timeOf(row) 倒序（最近的在最前），时间相同时 id 升序兜底；
 * id：按编号倒序（新在前）。
 * timeOf 缺省取 row.updated_at，返回 ISO 字符串或毫秒数都行，解析不出当 0。
 * 两种模式都返回新数组，不修改入参。
 */
export function orderList(rows, { mode, timeOf } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (mode !== 'updated' && mode !== 'id') return list;
  const copy = [...list];
  if (mode === 'id') return copy.sort((a, b) => b.id - a.id);
  const pick = typeof timeOf === 'function' ? timeOf : row => row?.updated_at;
  return copy.sort((a, b) => timestamp(pick(b)) - timestamp(pick(a)) || a.id - b.id);
}
