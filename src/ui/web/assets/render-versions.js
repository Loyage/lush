import { el } from './dom.js';
import { bindWorkerPreview } from './entity-preview.js';
import { api, projectApi } from './api.js';
import { ui } from './state.js';
import { routeContext } from './route.js';
import { workerLabel } from './worker-label.js';
import { linkWorkerNumbers } from './worker-links.js';
import { inputNumber } from './format.js';
import { versionGraphLayout, versionGraphPath } from './version-graph-layout.js';

const LIMIT = 30, CACHE_PAGES = 3;
// These read controls own their busy/disabled state; the generic action wrapper would
// unconditionally re-enable a pager after a successful read of the first/last page.
function button(label, run, className, { help } = {}) {
  const control = el('button', label, className); control.type = 'button'; control.onclick = run;
  if (help) control.setAttribute('data-help', help);
  return control;
}
const text = (value, fallback = '未知') => typeof value === 'string' && value ? value : fallback;
const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const canDrill = task => task.delivery_available === true && Number.isSafeInteger(task.delivery_id) && task.delivery_id > 0
  && ['task.merge_integrated', 'merged'].includes(task.evidence);
const svg = (tag, attributes) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
};
function workerLink(task) {
  const link = el('a', `Worker ${workerLabel(task)}`, 'worker-link version-task-link');
  link.setAttribute('href', `#worker-${task.id}`);
  link.setAttribute('aria-label', `查看 Worker ${workerLabel(task)} 的详情`);
  bindWorkerPreview(link, task);
  return link;
}

/** Compact graph nodes never contain goals/Input bodies; the marker explicitly reads one commit. */
export function renderVersionCommit(commit, { onCommit, onDelivery } = {}) {
  const card = el('li', undefined, 'version-commit'); card.dataset.commit = commit.commit;
  const rail = el('div', undefined, 'version-rail'), body = el('div', undefined, 'version-body');
  const marker = button('', () => onCommit?.(commit), 'version-node', {
    help: '按需读取此节点的完整提交消息、SHA、作者、Worker 目标与原始输入，只读，不调用 Agent。' });
  marker.setAttribute('aria-label', `查看提交 ${text(commit.short_commit, commit.commit?.slice(0, 12))}：${text(commit.subject, '（无摘要）')} 的详情`);
  rail.append(marker); body.append(el('h3', text(commit.subject, '（无摘要）')));
  const metadata = el('div', undefined, 'version-metadata');
  const time = el('time', text(commit.committed_at));
  if (commit.committed_at) time.setAttribute('datetime', commit.committed_at);
  metadata.append(el('code', text(commit.short_commit, commit.commit?.slice(0, 12)), 'version-short-sha'), time); body.append(metadata);
  const tasks = commit.association === 'verified' && Array.isArray(commit.tasks) ? commit.tasks : [];
  if (!tasks.length) body.append(el('p', '未关联 Worker', 'version-unassociated'));
  for (const task of tasks) {
    const entry = el('div', undefined, 'version-task'); entry.append(workerLink(task));
    if (canDrill(task)) entry.append(button(`交付图 · ${workerLabel(task)}`, () => onDelivery?.(task), 'ghost version-delivery-choice', {
      help: '读取此子交付 Event 固定的源提交图，不是 Worker 当前分支；可返回上层，不调用 Agent。' }));
    body.append(entry);
  }
  card.append(rail, body); return card;
}

function drawGraph(list, data, onCommit, onDelivery) {
  const layout = versionGraphLayout(data.commits);
  list.className = `versions-list version-graph-lanes-${Math.min(layout.lanes, 6)}`;
  const boundaries = new Set(layout.boundaries.map(edge => edge.parent));
  const cards = data.commits.map(commit => renderVersionCommit(commit, { onCommit, onDelivery }));
  cards.forEach((card, index) => {
    const row = layout.rows[index], rail = card.querySelector('.version-rail'), marker = card.querySelector('.version-node');
    const lines = svg('svg', { viewBox: `0 0 ${layout.width} 100`, preserveAspectRatio: 'none', width: layout.width,
      'aria-hidden': 'true', focusable: 'false', class: 'version-lines' });
    for (const segment of row.segments) lines.append(svg('path', { d: versionGraphPath(segment),
      class: `version-edge version-lane-${segment.to.lane % 3}${boundaries.has(segment.parent) ? ' version-edge-boundary' : ''}`,
      'data-parent': segment.parent, 'vector-effect': 'non-scaling-stroke' }));
    const dot = svg('svg', { viewBox: `0 0 ${layout.width} 100`, preserveAspectRatio: 'none', width: layout.width,
      'aria-hidden': 'true', focusable: 'false', class: 'version-marker' });
    dot.append(svg('path', { d: `M ${16 + row.lane * 22} 50 l 0 0.001`, class: `version-dot version-lane-${row.lane % 3}`, 'vector-effect': 'non-scaling-stroke' }));
    marker.replaceChildren(dot); rail.replaceChildren(lines, marker);
  });
  list.replaceChildren(...cards);
  return layout.boundaries;
}
function checkedPage(data, frame) {
  if (!data || !['current', 'main', 'delivery'].includes(data.scope) || data.worker?.id !== frame.id
    || (frame.delivery !== null && (data.delivery !== frame.delivery || data.scope !== 'delivery'))
    || typeof data.snapshot !== 'string' || !data.snapshot || typeof data.branch !== 'string'
    || !Array.isArray(data.commits) || data.commits.length > LIMIT || typeof data.has_more !== 'boolean'
    || !(data.tip === null || oid(data.tip)) || !(data.base === null || oid(data.base))
    || (data.has_more && (typeof data.cursor !== 'string' || !data.cursor))
    || data.commits.some(c => !oid(c.commit) || !Array.isArray(c.parents) || !c.parents.every(oid))) {
    throw new Error('版本数据格式不兼容，请更新后台与界面服务。');
  }
  versionGraphLayout(data.commits); return data;
}
let mounted = null;
export function disposeWorkerVersions() { mounted?.dispose(); mounted = null; }

/** One mounted Worker, at most three graph pages, one node detail and one 30-item delivery page.
 * Only lightweight signed cursors survive eviction. Same-Worker detail repaint reuses this DOM/lifetime.
 */
export function renderWorkerVersions(task, previous = null) {
  if (previous && mounted?.root === previous && mounted.owns()) return previous;
  disposeWorkerVersions();
  const ownerDocument = document, boot = ui.workerNumbers, project = projectApi('/api/'), view = ui.view;
  const root = el('section', undefined, 'worker-versions versions-page'); root.dataset.workerId = String(task.id);
  const heading = el('div', undefined, 'section-title'); heading.append(el('h2', '版本迭代'));
  const scope = el('h3', undefined, 'versions-scope'); scope.tabIndex = -1;
  const feedback = el('p', '滚入本模块后按需读取，每页最多 30 个节点。', 'versions-feedback hint'); feedback.setAttribute('role', 'status');
  const tip = el('p', undefined, 'version-tip hint');
  const list = el('ol', undefined, 'versions-list'); list.setAttribute('aria-label', 'Git 提交图');
  const boundaries = el('details', undefined, 'version-boundaries');
  const nodePanel = el('section', undefined, 'version-node-detail'); nodePanel.hidden = true;
  nodePanel.id = `version-node-detail-${task.id}`; nodePanel.tabIndex = -1;
  nodePanel.setAttribute('aria-label', '按需提交详情');
  const cache = new Map();
  let serial = 0, disposed = false, started = false, observer = null;
  let graphRead = null, nodeRead = null, deliveryRead = null, generation = 0;
  let displayed = null, displayedFrame = null, retryTarget = null;
  const frame = (worker, delivery = null) => ({ uid: ++serial, id: worker.id, worker, delivery, index: 0, cursors: [null], snapshot: null, identity: null });
  let frames = [frame(task)], active = frames[0];
  const owns = () => !disposed && document === ownerDocument && ui.workerNumbers === boot && ui.view === view
    && !routeContext().invalid && projectApi('/api/') === project && mounted?.root === root;
  const current = () => owns() && root.isConnected;
  const controller = () => new AbortController();
  const cancelNode = () => {
    nodeRead?.abort(); nodeRead = null; nodePanel.replaceChildren(); nodePanel.hidden = true;
    nodePanel.setAttribute('aria-busy', 'false'); root.insertBefore(nodePanel, null);
    for (const marker of list.querySelectorAll('.version-node')) marker.setAttribute('aria-expanded', 'false');
  };
  const cancel = () => {
    generation++; graphRead?.abort(); graphRead = null; cancelNode();
    if (deliveryRead) { deliveryRead.abort(); roundStatus.textContent = '轮次读取已取消，可重试。'; roundRetry.hidden = false; }
    deliveryRead = null;
    roundNewer.disabled = roundIndex === 0; roundOlder.disabled = !roundPage?.has_more;
  };
  const key = (f, index) => `${f.uid}:${index}`;
  const remember = (f, index, data) => {
    const k = key(f, index); cache.delete(k); cache.set(k, data);
    // The default graph has no cursor for offset zero. Pin its first page so returning
    // after a long browse never silently re-samples a mutable current/main ref.
    const pinned = key(frames[0], 0);
    while (cache.size > CACHE_PAGES) cache.delete([...cache.keys()].find(candidate => candidate !== pinned));
  };
  const scopeText = () => active.delivery !== null ? `Worker ${workerLabel(active.worker)} · 固定交付 Event ${active.delivery}`
    : active.worker.branch === 'main' || (displayedFrame === active && displayed?.scope === 'main') ? 'main 提交图' : `Worker ${workerLabel(active.worker)} · 当前已提交开发`;
  const sync = () => {
    scope.textContent = scopeText(); back.hidden = frames.length < 2;
    newer.disabled = Boolean(graphRead) || active.index === 0 || !active.snapshot;
    older.disabled = Boolean(graphRead) || !active.snapshot || displayedFrame !== active || !displayed?.has_more;
    start.hidden = started; retry.hidden = !retryTarget;
    root.setAttribute('aria-busy', String(Boolean(graphRead)));
    root.dataset.cachedPages = String(cache.size);
  };
  const status = (message, error = false) => {
    feedback.textContent = message; feedback.className = `versions-feedback ${error ? 'versions-error' : 'hint'}`;
    feedback.setAttribute('role', error ? 'alert' : 'status');
  };
  const present = (data, f, index) => {
    displayed = data; displayedFrame = f; f.index = index;
    tip.textContent = `固定 tip：${data.tip || '无提交'}${data.base ? ` · 开发基线：${data.base}` : ''}${f.delivery === null && data.scope === 'delivery' ? ` · 分支已回收，使用最近固定交付 Event ${data.delivery}` : ''}`;
    const edges = drawGraph(list, data, c => loadCommit(c), t => openDelivery(t));
    for (const marker of list.querySelectorAll('.version-node')) {
      marker.setAttribute('aria-controls', nodePanel.id); marker.setAttribute('aria-expanded', 'false');
    }
    boundaries.replaceChildren(el('summary', `虚线范围边界 · ${edges.length} 条父边`),
      el('p', '虚线表示父提交在本页之外（尚未读到、较新页或范围外）；线条只表示真实 Git parents。', 'hint'),
      ...edges.map(edge => el('code', edge.parent, 'version-boundary-sha')));
    boundaries.hidden = !edges.length;
    status(data.commits.length ? `第 ${index + 1} 页 · ${data.commits.length} 个节点${data.has_more ? '，可查看较早版本。' : '，已到图范围起点。'}`
      : data.scope === 'main' && data.tip === null ? '本项目尚无 main 分支。' : '本轮范围暂无额外已提交开发。');
    sync();
  };
  async function load(index = active.index, refresh = false) {
    if (!current()) return;
    started = true; observer?.disconnect(); observer = null; cancel();
    const f = active, ticket = generation;
    retryTarget = null;
    if (refresh) {
      for (const k of [...cache.keys()]) if (k.startsWith(`${f.uid}:`)) cache.delete(k);
      f.snapshot = null; f.identity = null; f.cursors = [null]; index = 0;
    }
    const cached = cache.get(key(f, index));
    if (cached && !refresh) { remember(f, index, cached); present(cached, f, index); return; }
    const reads = graphRead = controller();
    const valid = () => current() && active === f && generation === ticket && !reads.signal.aborted;
    status('正在读取版本图…'); sync();
    try {
      const query = new URLSearchParams({ limit: String(LIMIT) });
      // Preserve the REQUEST identity, not the fallback response's actual delivery.
      if (f.delivery !== null) query.set('delivery', String(f.delivery));
      if (f.cursors[index]) query.set('cursor', f.cursors[index]);
      const data = checkedPage(await api(`/api/worker/${f.id}/version-graph?${query}`, { signal: reads.signal }), f);
      if (!valid()) return;
      const identity = JSON.stringify([data.scope, data.branch, data.tip, data.base, data.delivery]);
      if (f.snapshot && f.identity !== identity) throw new Error('分页快照发生变化，请刷新版本图。');
      if (f.snapshot && f.snapshot !== data.snapshot) {
        if (index !== 0 || f.delivery === null) throw new Error('分页快照发生变化，请刷新版本图。');
        // An evicted fixed-delivery first page can only re-sample the same immutable
        // Event/tip/base. Never mix its new signature with previous snapshot cursors.
        for (const k of [...cache.keys()]) if (k.startsWith(`${f.uid}:`)) cache.delete(k);
        f.cursors = [null];
      }
      f.snapshot = data.snapshot; f.identity = identity; f.cursors[index + 1] = data.cursor;
      remember(f, index, data); graphRead = null; present(data, f, index);
    } catch (error) {
      if (!valid()) return;
      retryTarget = { index, refresh };
      status(`读取失败：${error.message}。${displayed ? '保留成功页；刷新失败时旧快照不再用于节点读取。' : '可重试或返回上层图。'}游标失效时请刷新版本图。`, true);
    } finally { if (valid()) { graphRead = null; sync(); } }
  }
  function activate(f) {
    cancel(); active = f; retryTarget = null;
    // No nodes/data from a different graph remain labelled as the new scope.
    displayed = null; displayedFrame = null; list.replaceChildren(); boundaries.hidden = true; tip.textContent = '';
    scope.focus?.({ preventScroll: true }); return load(f.index);
  }
  function openDelivery(association) {
    if (!current() || !canDrill(association)) return;
    const existing = frames.findIndex(f => f.id === association.id && f.delivery === association.delivery_id);
    if (existing >= 0) { frames = frames.slice(0, existing + 1); return activate(frames.at(-1)); }
    const f = frame(association, association.delivery_id); frames.push(f); return activate(f);
  }
  async function loadCommit(commit) {
    if (!current() || !active.snapshot || displayedFrame !== active || displayed?.snapshot !== active.snapshot || graphRead) return;
    cancelNode(); const reads = nodeRead = controller(), f = active, snapshot = f.snapshot, ticket = generation;
    const valid = () => current() && active === f && ticket === generation && nodeRead === reads && !reads.signal.aborted;
    const card = list.querySelector(`[data-commit="${commit.commit}"]`), marker = card?.querySelector('.version-node');
    card?.querySelector('.version-body')?.insertBefore(nodePanel, null);
    marker?.setAttribute('aria-expanded', 'true');
    const close = () => { cancelNode(); marker?.focus?.({ preventScroll: true }); };
    nodePanel.hidden = false; nodePanel.replaceChildren(el('p', '节点详情加载中…', 'hint'));
    nodePanel.setAttribute('aria-busy', 'true');
    nodePanel.focus?.({ preventScroll: true });
    nodePanel.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
    try {
      const query = new URLSearchParams({ snapshot, commit: commit.commit });
      const data = await api(`/api/worker/${f.id}/version-commit?${query}`, { signal: reads.signal });
      if (!valid()) return;
      if (data.worker?.id !== f.id || data.commit?.commit !== commit.commit || typeof data.commit.message !== 'string') throw new Error('节点详情数据格式不兼容');
      const c = data.commit;
      nodePanel.replaceChildren(el('h3', '提交详情'), el('code', c.commit, 'version-sha'),
        el('p', `作者：${text(c.author?.name)} · ${text(c.committed_at)}`, 'hint'), el('pre', c.message, 'version-message'));
      for (const association of c.association === 'verified' ? c.tasks || [] : []) {
        const section = el('section', undefined, 'version-detail-task');
        section.append(workerLink(association), el('p', text(association.goal, '（无 Worker 目标）'), 'version-goal'));
        if (association.delivery_unavailable_reason) section.append(el('p', association.delivery_unavailable_reason, 'hint'));
        if (association.input) {
          const input = el('details', undefined, 'version-input');
          input.append(linkWorkerNumbers(el('summary', `原始输入 ${inputNumber(association.input.id)}`)), el('pre', text(association.input.content, '（空输入）'), 'version-order'));
          section.append(input);
        }
        nodePanel.append(section);
      }
      nodePanel.append(button('关闭节点详情', close, 'ghost'));
    } catch (error) {
      if (!valid()) return;
      const message = el('p', `节点读取失败：${error.message}`, 'versions-error'); message.setAttribute('role', 'alert');
      nodePanel.replaceChildren(message, button('重试节点详情', () => loadCommit(commit), 'ghost'), button('关闭节点详情', close, 'ghost'));
    } finally { if (valid()) nodePanel.setAttribute('aria-busy', 'false'); }
  }
  const start = button('加载版本图', () => load(0), 'ghost versions-load');
  const refresh = button('刷新版本图', () => load(0, true), 'ghost versions-refresh', {
    help: '丢弃当前图的旧快照与节点详情，重新读取第一页；不自动轮询、不调用 Agent。' });
  const retry = button('重试版本读取', () => retryTarget && load(retryTarget.index, retryTarget.refresh), 'ghost versions-retry');
  const back = button('返回上层图', () => { if (!current() || frames.length < 2) return; frames.pop(); return activate(frames.at(-1)); }, 'ghost versions-back');
  const newer = button('较新版本', () => load(active.index - 1), 'ghost versions-newer');
  const older = button('较早版本', () => load(active.index + 1), 'ghost versions-more');
  const paging = el('nav', undefined, 'versions-footer'); paging.setAttribute('aria-label', '版本图分页');
  for (const control of [newer, older]) {
    const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', '每页最多 30 节点；沿固定快照切换，不累计完整图。无对应页或读取中不可切换。'); host.append(control); paging.append(host);
  }
  const controls = el('div', undefined, 'versions-controls'); controls.append(start, refresh, retry, back);
  const rounds = el('details', undefined, 'version-rounds');
  rounds.append(el('summary', `选择历史交付轮次 · Worker ${workerLabel(task)}`));
  const roundStatus = el('p', undefined, 'hint'), roundList = el('div', undefined, 'version-round-list');
  let roundIndex = 0, roundCursors = [null], roundPage = null, roundTarget = 0;
  async function loadRounds(index = 0) {
    if (!current() || !rounds.open) return;
    deliveryRead?.abort(); const reads = deliveryRead = controller(); roundTarget = index;
    const ticket = generation;
    const valid = () => current() && ticket === generation && deliveryRead === reads && !reads.signal.aborted && rounds.open;
    roundStatus.textContent = '交付轮次加载中…'; roundRetry.hidden = true; roundNewer.disabled = roundOlder.disabled = true;
    try {
      const query = new URLSearchParams({ limit: String(LIMIT) });
      if (roundCursors[index]) query.set('before', String(roundCursors[index]));
      const data = await api(`/api/worker/${task.id}/version-deliveries?${query}`, { signal: reads.signal });
      if (!valid()) return;
      if (!Array.isArray(data.deliveries) || data.deliveries.length > LIMIT || typeof data.has_more !== 'boolean'
        || (data.has_more && (!Number.isSafeInteger(data.before) || data.before <= 0))) throw new Error('交付轮次数据格式不兼容');
      roundPage = data; roundIndex = index; roundCursors[index + 1] = data.before;
      roundList.replaceChildren(...data.deliveries.map(t => {
        const item = el('div', undefined, 'version-round');
        if (canDrill(t)) item.append(button(`Event ${t.delivery_id} · ${text(t.delivered_at)}`, () => openDelivery(t), 'ghost', {
          help: '读取该成功 Event 的固定交付图，不改变开发状态，不调用 Agent。' }));
        else item.append(el('p', `Event ${t.delivery_id} · ${text(t.delivery_unavailable_reason, '缺少固定交付证据，无法追溯')}`, 'hint'));
        return item;
      }));
      roundStatus.textContent = data.deliveries.length ? `轮次第 ${index + 1} 页` : '暂无成功交付轮次。';
    } catch (error) {
      if (!valid()) return;
      roundStatus.textContent = `轮次读取失败：${error.message}。保留已读轮次，可重试。`; roundRetry.hidden = false;
    } finally {
      if (valid()) { deliveryRead = null; roundNewer.disabled = roundIndex === 0; roundOlder.disabled = !roundPage?.has_more; }
    }
  }
  const roundRetry = button('重试交付轮次', () => loadRounds(roundTarget), 'ghost'); roundRetry.hidden = true;
  const roundNewer = button('较新轮次', () => loadRounds(roundIndex - 1), 'ghost'); roundNewer.disabled = true;
  const roundOlder = button('较早轮次', () => loadRounds(roundIndex + 1), 'ghost'); roundOlder.disabled = true;
  rounds.append(roundStatus, roundList, roundRetry, roundNewer, roundOlder,
    button('刷新轮次', () => { roundCursors = [null]; return loadRounds(0); }, 'ghost'));
  rounds.ontoggle = () => {
    if (rounds.open) { if (!roundPage) return loadRounds(0); }
    else { deliveryRead?.abort(); deliveryRead = null; roundNewer.disabled = roundIndex === 0; roundOlder.disabled = !roundPage?.has_more; }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; cancel(); deliveryRead?.abort(); deliveryRead = null; observer?.disconnect(); observer = null;
    rounds.ontoggle = null; cache.clear(); frames = []; displayed = null; roundPage = null;
    for (const control of root.querySelectorAll('button')) control.onclick = null;
  };
  mounted = { root, owns, dispose };
  root.append(heading, el('p', '已提交 Git 图 · 线条是真实父边；节点详情与历史交付按需读取，不调用 Agent。', 'hint'), controls, scope, feedback, tip, list, boundaries, nodePanel, paging, rounds);
  sync();
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(entries => {
      if (current() && !started && entries.some(entry => entry.isIntersecting)) void load(0);
    }, { threshold: 0 });
    observer.observe(root);
  }
  // With no observer the accessible load button is intentionally the only startup path.
  return root;
}
