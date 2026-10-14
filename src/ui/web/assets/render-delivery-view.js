import { $, el, button, badge } from './dom.js';
import { api, isReadAbort } from './api.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { projectBase } from './route.js';
import { statusOf } from './format.js';
import { deliveryStage, deliveryHash, matchesDelivery, deliveryAttentionText, deliveryExceptional } from './delivery-model.js';
import { deliveryLink, deliveryWorker, deliveryWarnings, deliveryInput } from './delivery-ui.js';

function counters(counts) {
  return `活动 ${counts.active} · ${deliveryAttentionText(counts)} · 已合并历史 ${counts.history}`;
}
function paintCount(counts, error = null) {
  const target = $('delivery-count');
  if (target) target.textContent = counts ? `活动 ${counts.active} · ${deliveryAttentionText(counts)}` : error ? '数量读取失败' : '数量尚未读取';
}
function publishCounts(counts, base) {
  ui.deliveryCounts?.controller?.abort();
  ui.deliveryCounts = { base, at: Date.now(), counts, pending: false };
  paintCount(counts);
}
/** Called by the existing snapshot refresh, not an extra polling service. */
export async function refreshDeliveryCounts() {
  const base = projectBase(), owner = document, boot = ui.workerNumbers;
  if (!base) return;
  const previous = ui.deliveryCounts;
  if (previous?.base === base && (previous.pending || Date.now() - previous.at < 10000)) return;
  const controller = new AbortController();
  const entry = ui.deliveryCounts = { base, at: Date.now(), pending: true, controller };
  previous?.controller?.abort();
  try {
    const page = await api('/api/worker-delivery-graph?limit=1', { signal: controller.signal });
    if (ui.deliveryCounts !== entry || base !== projectBase() || owner !== document || boot !== ui.workerNumbers) return;
    entry.counts = page.counts; paintCount(page.counts);
    void ui.deliveryPage?.refresh?.();
  } catch (error) {
    if (ui.deliveryCounts === entry && base === projectBase() && owner === document && boot === ui.workerNumbers && !isReadAbort(error)) paintCount(null, error);
  } finally { entry.pending = false; }
}
function advanced(item) {
  const box = el('details', undefined, 'delivery-evidence'); box.append(el('summary', '高级证据：提交、代与节点 / 收据'));
  for (const [label, value] of [['批次', item.run_id], ['generation', item.generation], ['固定基线 SHA', item.baseline],
    ['组合 / 落地 SHA', item.commit], ['收据事件', item.locator?.event_id], ['旧代节点数', item.previous_generation_node_count]])
    if (value != null) box.append(el('p', `${label}：${value}`, 'mono'));
  for (const source of item.sources || []) {
    const value = source.delivery_summary;
    box.append(el('p', `来源 #${source.id} · 本轮交付 ${value?.delivery_id ?? '未固定'} · 版本 ${value?.version ?? '未知'} · generation ${value?.generation ?? '未知'} · attempt ${value?.attempt_id ?? '无'} · 当前匹配 ${value?.current === true ? '是' : '否'}`, 'mono'));
    if (value?.source_commit) box.append(el('p', `源 SHA：${value.source_commit}`, 'mono'));
  }
  for (const node of item.nodes || []) {
    const row = el('div', `节点 #${node.id} · ${node.node_key || '键未知'} · ${node.state}`, 'delivery-node');
    row.dataset.deliveryNode = String(node.id); row.tabIndex = -1;
    const helper = item.integration_workers?.items?.find(worker => worker.id === node.helper_id);
    if (helper) row.append(deliveryWorker(helper, '查看节点整合 Worker →'));
    box.append(row);
  }
  if (item.node_count != null) box.append(el('p', `当前节点 ${item.nodes?.length || 0} / ${item.node_count}`, 'hint'));
  box.append(deliveryWarnings(item)); return box;
}
export function deliveryCard(item) {
  const card = el('article', undefined, `delivery-card${deliveryExceptional(item) ? ' delivery-exception' : ''}`);
  card.dataset.deliveryKey = item.key; card.tabIndex = -1;
  const title = item.kind === 'batch' ? `归并批次 #${item.run_id}` : item.kind === 'intent' ? '未固定交付意图' : '普通串行 / 未形成批次的固定交付';
  card.append(el('h3', title), badge(deliveryStage(item.stage, item.kind === 'batch' ? 3 : item.sources?.[0]?.delivery_summary?.version), item.stage === 'integrated' ? 'b-completed' : 'b-awaiting'));
  if (item.waiting_reason || item.error) card.append(el('p', item.waiting_reason || item.error, 'delivery-reason'));
  if (item.blocked_code) card.append(el('p', `阻塞 / 待决：${item.blocked_code}`, 'hint'));
  const helpers = el('section', undefined, 'delivery-helpers'); helpers.append(el('h4', '整合 Worker（真实状态）'));
  for (const worker of item.integration_workers?.items || []) {
    const row = el('div', undefined, 'delivery-helper');
    row.append(deliveryWorker(worker), el('span', ` · ${worker.status ? statusOf(worker).label : '状态未知'}`));
    if (worker.current === false) row.append(el('span', ' · 旧代引用，不能解释本代整合', 'warn'));
    row.append(deliveryWarnings(worker)); helpers.append(row);
  }
  if (!item.integration_workers?.items?.length) helpers.append(el('p', item.kind === 'batch' ? '当前没有真实整合 Worker 引用（纯 Git 组合或尚未创建）' : '尚无归并批次；不创建虚构整合 Worker', 'hint'));
  if (item.integration_workers?.total != null) helpers.append(el('p', `已读整合引用 ${item.integration_workers.items.length} / ${item.integration_workers.total}`, 'hint'));
  card.append(helpers);
  const sources = el('section', undefined, 'delivery-sources'); sources.append(el('h4', `来源本轮交付${item.member_count != null ? `（${item.member_count}）` : ''}`));
  for (const source of item.sources || []) {
    const value = source.delivery_summary, row = el('div', undefined, 'delivery-source');
    row.dataset.deliverySource = String(source.id); row.tabIndex = -1;
    row.append(deliveryWorker(source), el('p', `本轮交付：${value?.delivery_id ?? '尚未固定'} · ${deliveryStage(value?.stage, value?.version)}`));
    if (value?.current === false) row.append(el('p', '非当前预约交付；此历史不能表示来源新一轮已合并', 'hint'));
    if (value?.waiting_reason) row.append(el('p', value.waiting_reason, 'hint'));
    row.append(el('p', deliveryInput(value?.input_queue), 'hint'), deliveryWarnings(source), deliveryWarnings(value),
      deliveryLink('返回工作树并定位来源 →', `#worker-graph-worker-${source.id}`));
    sources.append(row);
  }
  if (!item.sources?.length) sources.append(el('p', '来源信息不可用；不能解释为没有来源', 'warn'));
  card.append(sources, deliveryWarnings(item));
  if (item.stage === 'integrated') card.append(el('p', `已实际合并 · ${item.sources?.length || 0}${item.members_truncated ? '（部分）' : ''} 条已展示来源 · ${item.commit ? `落地提交 ${item.commit.slice(0, 12)}` : '提交证据未返回'}；不自动验收或回收`, 'delivery-result'));
  card.append(advanced(item)); return card;
}
function protectedReading() {
  return Boolean(window.getSelection?.()?.toString()) || Boolean($('detail')?.querySelector('details[open]'))
    || Boolean($('detail')?.contains?.(document.activeElement));
}
export async function openDeliveryView({ history = false, locator = {}, push = true } = {}) {
  const hash = deliveryHash(locator, history), view = activateDetailView({ view: 'deliveries', key: hash, hash, push });
  const old = ui.deliveryPage;
  if (old?.view === view && old.base === projectBase()) return;
  const session = ui.deliveryPage = { view, base: projectBase(), owner: document, history, locator, items: [], page: null, error: null, loading: false };
  const current = () => ui.deliveryPage === session && ui.view === view && session.base === projectBase() && session.owner === document;
  ui.disposeDeliveryView = () => { session.controller?.abort(); if (ui.deliveryPage === session) ui.deliveryPage = null; ui.disposeDeliveryView = null; };
  const paint = () => {
    if (!current()) return;
    const box = el('div', undefined, 'delivery-view'), header = el('header', undefined, 'delivery-header');
    const match = session.items.find(item => matchesDelivery(item, locator))
      || (locator.run_id ? session.items.find(item => item.kind === 'batch' && item.run_id === locator.run_id) : null);
    const sourceUnverified = match && locator.run_id && locator.worker_id && !match.sources?.some(source => source.id === locator.worker_id);
    const treeWorker = locator.worker_id || match?.sources?.[0]?.id || (ui.taskGraphLocatorBase === session.base ? ui.taskGraphLocator : null);
    session.treeWorker = treeWorker;
    header.append(el('h1', '项目交付'), deliveryLink('工作树 →', `#worker-graph${treeWorker ? `-worker-${treeWorker}` : ''}`),
      el('p', session.page ? counters(session.page.counts) : '交付数量尚未读取', 'delivery-count-summary'),
      el('p', '临时按真实目标分组，不改变开发父子关系。只读追踪；整合 Worker 完成不等于已合并。', 'hint'));
    const controls = el('div', undefined, 'actions');
    controls.append(deliveryLink('活动与异常', deliveryHash(locator, false)), deliveryLink(`成功历史${session.page ? `（${session.page.counts.history}）` : ''}`, deliveryHash(locator, true)),
      button('从首批刷新', () => read(false), 'ghost'));
    for (const link of controls.querySelectorAll('a')) link.setAttribute('aria-current', link.href.includes('-history') === history ? 'page' : 'false');
    header.append(controls); box.append(header);
    if (session.error) box.append(el('p', `读取失败：${session.error}${session.stale ? '。分页结构已变化，请显式从首批刷新；已读内容保留但不再作为当前事实。' : '。可重试；读取失败不表示没有交付。'}`, 'warn'));
    if (locator.run_id || locator.worker_id) box.append(el('p', sourceUnverified ? '已定位批次，但指定来源未在当前返回证据中（可能截断或关联变化）；请检查来源详情 / 刷新，不能认定不存在。' : match ? '已定位对应本轮交付' : session.page?.has_more ? '对应交付尚未读到；请继续加载本筛选后续分页，也可切换成功历史。' : session.page ? '本筛选已读完但未匹配；可切换活动 / 成功历史或刷新。不能据此认定交付不存在。' : '正在读取定位范围…', 'delivery-locator-status'));
    const groups = new Map();
    for (const item of session.items) {
      const key = JSON.stringify([item.target?.id, item.target?.branch]);
      if (!groups.has(key)) groups.set(key, { target: item.target, items: [] }); groups.get(key).items.push(item);
    }
    for (const group of groups.values()) {
      const section = el('section', undefined, 'delivery-target'), head = el('h2', '目标：');
      head.append(deliveryWorker(group.target || { missing: true }), el('span', group.target?.branch ? ` · ${group.target.branch}` : ' · 目标分支未知'));
      section.append(head, deliveryWarnings(group.target));
      for (const kind of ['batch','intent','serial']) {
        const items = group.items.filter(item => item.kind === kind); if (!items.length) continue;
        const list = el('section', undefined, 'delivery-kind'); list.append(el('h3', { batch: '归并批次', intent: '尚未固定的意图 / 预约诊断', serial: '普通串行 / 未形成批次的交付' }[kind]));
        for (const item of items) list.append(deliveryCard(item)); section.append(list);
      }
      box.append(section);
    }
    if (!session.items.length && session.page && !session.error) box.append(el('p', history ? '没有已确认落地的成功历史。异常留在活动视图。' : '当前没有活动或异常交付。', 'hint'));
    if (session.page?.truncated) box.append(el('p', '有未读分页或条目证据截断；已读范围不是全量。', 'hint'));
    if (!session.stale && (session.page?.has_more || session.error)) box.append(button(session.loading ? '正在加载…' : '继续加载', () => read(!!session.page), 'ghost'));
    box.append(el('p', `已读 ${session.items.length} / ${session.page?.matched_total ?? '未知'} 条${session.loading ? ' · 读取中' : ''}。历史来源的暂存条数是现在的状态。`, 'hint'));
    for (const node of box.querySelectorAll('button')) node.disabled = session.loading;
    $('detail').replaceChildren(box);
    if (session.autoScroll != null) $('detail').scrollTop = session.autoScroll;
    if (match) {
      const card = [...box.querySelectorAll('[data-delivery-key]')].find(node => node.dataset.deliveryKey === match.key);
      let focus = locator.worker_id && locator.run_id ? card?.querySelector(`[data-delivery-source="${locator.worker_id}"]`) || card : card;
      if (locator.node_id) {
        focus = card?.querySelector(`[data-delivery-node="${locator.node_id}"]`);
        if (focus) card.querySelector('details').open = true;
        else box.querySelector('.delivery-locator-status').textContent = '已定位批次，但节点未在当前返回证据中；可能旧代或截断，不能认定节点不存在。';
      }
      if (focus) focus.classList.add('delivery-located');
      if (!session.located && focus) { focus.scrollIntoView?.({ block: 'nearest' }); focus.focus?.({ preventScroll: true }); session.located = true; }
    }
  };
  const read = async next => {
    if (!current() || session.loading || next && session.stale) return;
    session.controller = new AbortController(); session.loading = true; session.error = null;
    if (!next) { session.items = []; session.page = null; session.stale = false; session.located = false; session.paged = false; }
    else session.paged = true;
    paint();
    try {
      const query = new URLSearchParams({ history: history ? '1' : '0', limit: '20' });
      if (next && session.page?.cursor) query.set('cursor', session.page.cursor);
      const page = await api(`/api/worker-delivery-graph?${query}`, { signal: session.controller.signal });
      if (!current()) return;
      session.items = [...new Map([...session.items, ...page.items].map(item => [item.key, item])).values()]; session.page = page;
      publishCounts(page.counts, session.base);
    } catch (error) { if (current() && !isReadAbort(error)) { session.error = error.message; session.stale = /delivery graph cursor|cursor stale|project\/filter\/range mismatch/.test(error.message); } }
    finally { session.loading = false; if (current()) paint(); }
  };
  session.refresh = async () => {
    if (!current() || protectedReading() || history || session.loading || session.paged || session.error || locator.run_id || locator.worker_id) return;
    session.autoScroll = $('detail').scrollTop;
    try { await read(false); } finally { session.autoScroll = null; }
  };
  await read(false);
}
