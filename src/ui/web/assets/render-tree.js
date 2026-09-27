import { $, badge, button, el, roleBadge, routeBadge, syncChildren } from './dom.js';
import { api } from './api.js';
import { DEP_HELP, HOT, INTEGRATION, ROLE, TERMINAL_STATUS, absolute, depsOf, relative, statusOf, waitingDeps } from './format.js';
import { filterUi, roleOption, syncSelectOptions, uniqueValues, withCurrent } from './filters-ui.js';
import { detail } from './navigate.js';
import { countText, describeFilters, filterAPs, isFiltering, matchAP } from './sidebar.js';
import { setNavCount } from './sidebar-ui.js';
import { ui } from './state.js';
import { orderSiblings, rankAPs, treeParent } from './tree-order.js';
import { referenceable } from './context-references.js';
import { renderCompactProgress } from './render-progress.js';

/** 同一个父 AP 下互相没有依赖的兄弟可以同时跑；有依赖的串成链——这就是树里看不到的并行/串行。 */
function siblingChain(children) {
  const ids = new Set(children.map(child => child.id));
  const inner = new Map(children.map(child => [child.id, depsOf(child).filter(dep => ids.has(dep.id))]));
  const level = new Map();
  const depth = (apId, seen = new Set()) => {
    if (level.has(apId)) return level.get(apId);
    if (seen.has(apId)) return 0;
    seen.add(apId);
    const upstreams = inner.get(apId) || [];
    const value = upstreams.length ? 1 + Math.max(...upstreams.map(dep => depth(dep.id, seen))) : 0;
    level.set(apId, value); return value;
  };
  for (const child of children) depth(child.id);
  const levels = new Map();
  for (const child of children) { const at = level.get(child.id); if (!levels.has(at)) levels.set(at, []); levels.get(at).push(child.id); }
  return [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group.sort((a, b) => a - b));
}
/** 一行依赖标签：同名依赖合并成一个标签，词义放在 title 里，免得一行被标签挤爆。 */
function depChips(ap) {
  const kinds = ['code', 'order'].filter(kind => depsOf(ap).some(dep => dep.kind === kind));
  return kinds.map(kind => {
    const deps = depsOf(ap).filter(dep => dep.kind === kind);
    const waiting = deps.some(dep => !TERMINAL_STATUS.has(dep.status));
    const chip = el('span', `${kind === 'code' ? '⛓' : '⏳'}#${deps.map(dep => dep.id).join(',')}${waiting ? '·等' : ''}`,
      `dep dep-${kind}${waiting ? ' dep-wait' : ''}`);
    chip.title = `${kind === 'code' ? 'code 依赖（分支基线）' : 'order 依赖（只等结束）'}：${DEP_HELP[kind]}\n上游：${deps.map(dep => `#${dep.id} ${statusOf(dep).label}`).join('、')}`;
    return chip;
  });
}
/** 此刻为什么没在干活：等依赖 / 等槽 / 等子 AP / 等你决定。四种拼起来才是完整的并行-串行关系。 */
function whyLine(ap, index) {
  const waiting = waitingDeps(ap);
  if (ap.status === 'running') return `运行中 · 占 1 个并发槽`;
  if (ap.status === 'queued' && waiting.length) return `排队：等 ${waiting.map(dep => `#${dep.id}`).join('、')} 结束`;
  if (ap.status === 'queued') return `排队：没有依赖、但没有空槽（上限 ${index.concurrency}）`;
  if (ap.status === 'waiting') {
    const kids = index.children(ap.id);
    const live = kids.filter(child => child.status === 'running').length;
    return `等子 AP：${live} 个在跑 · ${kids.filter(child => !TERMINAL_STATUS.has(child.status)).length} 个未结束`;
  }
  if (ap.status === 'awaiting') return '等你决定：有没答复的问题';
  if (ap.status === 'completed' && ap.integration === 'conflict') return '已完成，合并冲突等你决定';
  if (ap.status === 'completed' && ['pending', 'review'].includes(ap.integration)) return '已完成，等你批准合并';
  return null;
}
export function renderTree(data) {
  const container = $('aps');
  const known = new Map([...container.children].map(node => [Number(node.dataset.id), node]));
  const allIds = new Set(data.aps.map(ap => ap.id));
  // 完整父子索引：whyLine 说「等子 AP」时要数全部子 AP，不能因为筛选把它们藏掉。
  const fullByParent = new Map();
  for (const ap of data.aps) {
    const key = treeParent(ap, allIds);
    if (!fullByParent.has(key)) fullByParent.set(key, []);
    fullByParent.get(key).push(ap);
  }
  // 全类型 AP 列表包含 planner，计划审批同样属于待我处理。
  const openNoticeIds = new Set((data.notices || []).filter(notice => notice.status === 'open').map(notice => notice.ap_id));
  // 筛选只影响呈现：可见集合 = 命中项 + 命中项的全部祖先（父作为通路保留），子 AP 被筛掉时父仍可见。
  const query = { ...ui.filters.aps, openNoticeIds };
  const visible = filterAPs(data.aps, query);
  const visibleIds = new Set(visible.map(ap => ap.id));
  const byParent = new Map();
  // 分组规则与 tree-order.js 的 rankAPs 共用同一个函数，保证排序看到的就是这棵树。
  for (const ap of visible) {
    const key = treeParent(ap, visibleIds);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(ap);
  }
  // 角色选项随 AP 出现：轮询里只换 option 节点，不换 select，不打断正在选择的人。
  if (filterUi.apRole) {
    const roles = [...new Set([...Object.keys(ROLE), ...uniqueValues(data.aps, 'role')])];
    const options = [{ value: 'all', label: '全部类型' }, ...roles.map(roleOption)];
    syncSelectOptions(filterUi.apRole, withCurrent(options, ui.filters.aps.role, roleOption), ui.filters.aps.role);
  }
  const ranks = rankAPs(visible, openNoticeIds);
  const index = { concurrency: data.status.concurrency ?? 1, children: apId => fullByParent.get(apId) || [] };
  const ordered = [];
  const walk = (parent, depth) => {
    // 每层兄弟先按当前偏好排好；band 行仍插在这层兄弟之前，节点复用 / dataset / 点击行为不变。
    const siblings = orderSiblings(byParent.get(parent) || [], { mode: ui.sidebarSortMode, ranks });
    // 根 AP 之间的并行由 planner 槽决定（不是一个父 AP 下的兄弟关系），所以只画委派出来的兄弟。
    if (parent !== 0 && siblings.length > 1) {
      const chain = siblingChain(siblings).map(group => group.length > 1 ? `{${group.map(apId => `#${apId}`).join(' ‖ ')}}` : `#${group[0]}`).join(' → ');
      const band = el('div', `‖ ${chain}（并列可同时跑，上限 ${index.concurrency}）`, `band d${Math.min(depth, 5)}`);
      band.title = '∥ 表示同一父 AP 下互相无依赖、可以同时跑；→ 的顺序来自依赖边：⛓ 基线还要求先合并上游，⏳ 顺序只等上游结束。';
      ordered.push(band);
    }
    for (const ap of siblings) {
      const node = known.get(ap.id) || button('', () => { ui.noticeFocus = null; return detail(ap.id); }, 'ap');
      const integration = INTEGRATION[ap.integration];
      node.dataset.id = ap.id;
      node.className = `ap d${Math.min(depth, 5)} s-${ap.status}${ui.selected === ap.id ? ' selected' : ''}${ap.route ? ' route-flagged' : ''}`;
      node.replaceChildren();
      const row = el('span', undefined, 'row');
      row.append(el('span', statusOf(ap).icon, `dot c-${ap.status}`), el('span', `#${ap.id}`, 'tid'),
        el('span', statusOf(ap).label), roleBadge(ap.role));
      if (ap.route) row.append(routeBadge());
      for (const chip of depChips(ap)) row.append(chip);
      row.append(el('span', relative(ap.updated_at), 'when'));
      node.append(row, el('span', ap.goal, 'goal'));
      if (HOT.has(ap.status)) {
        const progress = renderCompactProgress(ap.progress);
        if (progress) node.append(progress);
      }
      const why = whyLine(ap, index);
      if (why) node.append(el('span', why, 'meta reason'));
      // 已经用一句话说了"等你批准合并"，就不用再挂一个"待合并"标签。
      if (integration && integration !== '待合并') node.append(el('span', integration, 'meta'));
      node.title = `${ap.goal}\n更新于 ${absolute(ap.updated_at)}`;
      referenceable(node, [
        { kind: 'ap', target: { ap_id: ap.id }, label: `AP #${ap.id}`, quote: `${ap.goal}\n状态：${statusOf(ap).label} · ${ROLE[ap.role] || ap.role}`, location: { view: 'ap-tree', ap_id: ap.id } },
        { kind: 'ap_subtree', target: { ap_id: ap.id }, label: `AP 子树 #${ap.id}`, quote: `${ap.goal}\n从此 AP 开始的分支`, location: { view: 'ap-tree', ap_id: ap.id } },
      ]);
      ordered.push(node); walk(ap.id, depth + 1);
    }
  };
  walk(0, 0);
  if (isFiltering(query) && !visible.length) ordered.push(el('div', data.ap_page?.has_more
    ? '已加载 AP 中没有符合筛选的条目；更早记录尚未加载，请继续加载历史。'
    : '没有符合筛选的条目', 'filter-empty'));
  const page = data.ap_page;
  if (page) {
    const paging = el('div', undefined, 'ap-pagination');
    paging.append(el('span', page.truncated
      ? `当前显示全部 ${page.active} 个活动 AP 和最近 ${page.shown} / ${page.historical} 个历史 AP（列表已截断）`
      : `已显示全部 ${page.total} 个 AP`, 'hint'));
    if (page.has_more) {
      const more = button('加载更早 50 个', async () => {
        more.disabled = true; more.textContent = '加载中…';
        try {
          const next = await api(`/api/aps?scope=all&before=${page.cursor}&limit=50`);
          const loaded = new Map([...ui.apHistory, ...next.aps].map(ap => [ap.id, ap]));
          ui.apHistory = [...loaded.values()];
          ui.apHistoryPage = { ...page, cursor: next.cursor, has_more: next.has_more, truncated: next.has_more,
            shown: page.shown + next.aps.length };
          const all = new Map([...data.aps, ...next.aps].map(ap => [ap.id, ap]));
          data.aps = [...all.values()].sort((a, b) => a.id - b.id);
          data.ap_page = ui.apHistoryPage;
          renderTree(data);
        } catch (error) { more.disabled = false; more.textContent = '加载更早 50 个'; more.title = error.message; }
      }, 'ghost');
      more.type = 'button'; paging.append(more);
    }
    ordered.push(paging);
  }
  syncChildren(container, ordered);
  const active = data.aps.filter(ap => HOT.has(ap.status)).length;
  const matched = isFiltering(query) ? data.aps.filter(ap => matchAP(ap, query)).length : data.aps.length;
  const paths = visible.length - matched;
  const summary = describeFilters(query);
  $('ap-count').textContent = isFiltering(query)
    ? `${countText(matched, data.aps.length)}${paths > 0 ? `（含 ${paths} 个父级）` : ''}${summary ? ` · ${summary}` : ''}`
    : `${data.aps.length} 个 · ${active} 进行中`;
  setNavCount('aps', page?.total ?? data.aps.length);
}
