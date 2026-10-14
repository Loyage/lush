import { el } from './dom.js';
import { bindWorkerPreview } from './entity-preview.js';
import { api, projectApi } from './api.js';
import { ui } from './state.js';
import { routeContext } from './route.js';
import { workerLabel } from './worker-label.js';
import { linkWorkerNumbers } from './worker-links.js';
import { inputNumber } from './format.js';
import { versionGraphLayout, versionGraphPath } from './version-graph-layout.js';
import { createWorkerLineage } from './render-version-lineage.js';
import { enhanceVersionModule } from './version-module.js';

const LIMIT = 30, CACHE_PAGES = 3;
function button(label, run, className, { help } = {}) {
  const control = el('button', label, className); control.type = 'button'; control.onclick = run;
  if (help) control.setAttribute('data-help', help); return control;
}
const text = (value, fallback = '未知') => typeof value === 'string' && value ? value : fallback;
const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const svg = (tag, attributes) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); return node;
};
function workerLink(task) {
  const link = el('a', `Worker ${workerLabel(task)}`, 'worker-link version-task-link');
  link.setAttribute('href', `#worker-${task.id}`);
  link.setAttribute('aria-label', `查看 Worker ${workerLabel(task)} 的详情`);
  bindWorkerPreview(link, task); return link;
}

/** Root graph associations navigate natively to a Worker's own lineage. */
export function renderVersionCommit(commit, { onCommit } = {}) {
  const card = el('li', undefined, 'version-commit'); card.dataset.commit = commit.commit;
  const rail = el('div', undefined, 'version-rail'), body = el('div', undefined, 'version-body');
  const marker = button('', () => onCommit?.(commit), 'version-node', {
    help: '按需读取此节点的完整提交消息、SHA、作者、Worker 目标与原始输入，只读，不调用 Agent。' });
  marker.setAttribute('aria-label', `查看提交 ${text(commit.short_commit, commit.commit?.slice(0, 12))}：${text(commit.subject, '（无摘要）')} 的详情`);
  rail.append(marker); body.append(el('h3', text(commit.subject, '（无摘要）')));
  const metadata = el('div', undefined, 'version-metadata'), time = el('time', text(commit.committed_at));
  if (commit.committed_at) time.setAttribute('datetime', commit.committed_at);
  metadata.append(el('code', text(commit.short_commit, commit.commit?.slice(0, 12)), 'version-short-sha'), time); body.append(metadata);
  const tasks = commit.association === 'verified' && Array.isArray(commit.tasks) ? commit.tasks : [];
  if (!tasks.length) body.append(el('p', '未关联 Worker', 'version-unassociated'));
  for (const task of tasks) { const entry = el('div', undefined, 'version-task'); entry.append(workerLink(task)); body.append(entry); }
  card.append(rail, body); return card;
}
function drawGraph(list, data, onCommit) {
  const layout = versionGraphLayout(data.commits);
  list.className = `versions-list version-graph-lanes-${Math.min(layout.lanes, 6)}`;
  const boundaries = new Set(layout.boundaries.map(edge => edge.parent));
  const cards = data.commits.map(commit => renderVersionCommit(commit, { onCommit }));
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
  list.replaceChildren(...cards); return layout.boundaries;
}
function checkedPage(data, id) {
  if (!data || !['current', 'main', 'delivery'].includes(data.scope) || data.worker?.id !== id
    || typeof data.snapshot !== 'string' || !data.snapshot || typeof data.branch !== 'string'
    || !Array.isArray(data.commits) || data.commits.length > LIMIT || typeof data.has_more !== 'boolean'
    || !(data.tip === null || oid(data.tip)) || !(data.base === null || oid(data.base))
    || (data.has_more && (typeof data.cursor !== 'string' || !data.cursor))
    || data.commits.some(c => !oid(c.commit) || !Array.isArray(c.parents) || !c.parents.every(oid))) throw new Error('版本数据格式不兼容，请更新后台与界面服务。');
  versionGraphLayout(data.commits); return data;
}
let mounted = null;
export function disposeWorkerVersions() { mounted?.dispose(); mounted = null; }

/** One mounted Worker, at most three pages and one inline node detail. */
export function renderWorkerVersions(task, previous = null) {
  if (previous && previous.dataset.workerId === String(task.id) && mounted?.root === previous && mounted.owns()) return previous;
  disposeWorkerVersions();
  if (['order', 'child'].includes(task.task_kind)) {
    mounted = createWorkerLineage(task, root => mounted?.root === root); return mounted.root;
  }
  // Roots and historical compatibility records retain the graph API, never a
  // retired delivery-round selector. Unreadable legacy/owner scopes fail explicitly.
  const ownerDocument = document, boot = ui.workerNumbers, project = projectApi('/api/'), view = ui.view;
  const root = el('section', undefined, 'worker-versions versions-page'); root.dataset.workerId = String(task.id);
  const heading = el('div', undefined, 'section-title'); heading.append(el('h2', '版本迭代'));
  const scope = el('h3', `${task.branch} 提交图`, 'versions-scope');
  const feedback = el('span', '滚入本模块后按需读取，每页最多 30 个节点。', 'versions-feedback hint'); feedback.setAttribute('role', 'status');
  const tip = el('p', undefined, 'version-tip hint');
  const list = el('ol', undefined, 'versions-list'); list.setAttribute('aria-label', 'Git 提交图');
  const boundaries = el('details', undefined, 'version-boundaries');
  const panel = el('section', undefined, 'version-node-detail'); panel.hidden = true; panel.id = `version-node-detail-${task.id}`; panel.tabIndex = -1;
  panel.setAttribute('aria-label', '按需提交详情');
  const cache = new Map(), cursors = [null];
  let module = null, disposed = false, started = false, observer = null, graphRead = null, nodeRead = null, generation = 0;
  let displayed = null, snapshot = null, identity = null, index = 0, retryTarget = null;
  const owns = () => !disposed && document === ownerDocument && ui.workerNumbers === boot && ui.view === view
    && !routeContext().invalid && projectApi('/api/') === project && mounted?.root === root;
  const current = () => owns() && root.isConnected;
  const cancelNode = () => {
    nodeRead?.abort(); nodeRead = null; panel.replaceChildren(); panel.hidden = true; panel.setAttribute('aria-busy', 'false'); (module?.content || root).insertBefore(panel, null);
    for (const marker of list.querySelectorAll('.version-node')) marker.setAttribute('aria-expanded', 'false');
  };
  const cancel = () => { generation++; graphRead?.abort(); graphRead = null; cancelNode(); };
  const remember = (i, data) => {
    cache.delete(i); cache.set(i, data);
    // Offset zero has no cursor: pin it to prevent re-sampling a moving root ref.
    while (cache.size > CACHE_PAGES) cache.delete([...cache.keys()].find(key => key !== 0));
  };
  const sync = () => {
    newer.disabled = Boolean(graphRead) || index === 0 || !snapshot;
    older.disabled = Boolean(graphRead) || !snapshot || displayed?.snapshot !== snapshot || !displayed?.has_more;
    start.hidden = started; retry.hidden = !retryTarget;
    root.setAttribute('aria-busy', String(Boolean(graphRead))); root.dataset.cachedPages = String(cache.size); module?.measure();
  };
  const status = (message, error = false) => {
    feedback.textContent = message; feedback.className = `versions-feedback ${error ? 'versions-error' : 'hint'}`;
    feedback.setAttribute('role', error ? 'alert' : 'status');
  };
  const present = (data, i) => {
    displayed = data; index = i; tip.textContent = `固定 tip：${data.tip || '无提交'}${data.base ? ` · 开发基线：${data.base}` : ''}`;
    const edges = drawGraph(list, data, loadCommit);
    for (const marker of list.querySelectorAll('.version-node')) { marker.setAttribute('aria-controls', panel.id); marker.setAttribute('aria-expanded', 'false'); }
    boundaries.replaceChildren(el('summary', `虚线范围边界 · ${edges.length} 条父边`),
      el('p', '虚线表示父提交在本页之外（尚未读到、较新页或范围外）；线条只表示真实 Git parents。', 'hint'),
      ...edges.map(edge => el('code', edge.parent, 'version-boundary-sha'))); boundaries.hidden = !edges.length;
    status(data.commits.length ? `第 ${i + 1} 页 · ${data.commits.length} 个节点${data.has_more ? '，可查看较早版本。' : '，已到图范围起点。'}`
      : data.scope === 'main' && data.tip === null ? '本项目尚无 main 分支。' : '当前范围暂无额外已提交开发。'); sync();
  };
  async function load(target = index, refresh = false) {
    if (!current() || target < 0) return;
    started = true; observer?.disconnect(); observer = null; cancel(); const ticket = generation; retryTarget = null;
    if (refresh) { cache.clear(); snapshot = identity = null; cursors.length = 1; target = 0; }
    const cached = cache.get(target); if (cached) { remember(target, cached); present(cached, target); return; }
    const reads = graphRead = new AbortController();
    const valid = () => current() && generation === ticket && !reads.signal.aborted;
    status('正在读取版本图…'); sync();
    try {
      const query = new URLSearchParams({ limit: String(LIMIT) }); if (cursors[target]) query.set('cursor', cursors[target]);
      const data = checkedPage(await api(`/api/worker/${task.id}/version-graph?${query}`, { signal: reads.signal }), task.id);
      if (!valid()) return;
      const nextIdentity = JSON.stringify([data.scope, data.branch, data.tip, data.base, data.delivery]);
      if (snapshot && (snapshot !== data.snapshot || identity !== nextIdentity)) throw new Error('分页快照发生变化，请刷新版本图。');
      snapshot = data.snapshot; identity = nextIdentity; cursors[target + 1] = data.cursor;
      remember(target, data); present(data, target);
    } catch (error) {
      if (!valid()) return; retryTarget = { target, refresh };
      status(`读取失败：${error.message}。保留成功页；刷新失败时旧快照不再用于节点读取。游标失效时请刷新版本图。`, true);
    } finally { if (valid()) { graphRead = null; sync(); } }
  }
  async function loadCommit(commit) {
    if (!current() || !snapshot || displayed?.snapshot !== snapshot || graphRead) return;
    cancelNode(); const reads = nodeRead = new AbortController(), fixed = snapshot, ticket = generation;
    const valid = () => current() && ticket === generation && nodeRead === reads && !reads.signal.aborted;
    const card = list.querySelector(`[data-commit="${commit.commit}"]`), marker = card?.querySelector('.version-node');
    card?.querySelector('.version-body')?.insertBefore(panel, null); marker?.setAttribute('aria-expanded', 'true');
    const close = () => { cancelNode(); marker?.focus?.({ preventScroll: true }); };
    panel.hidden = false; panel.replaceChildren(el('p', '节点详情加载中…', 'hint')); panel.setAttribute('aria-busy', 'true');
    panel.focus?.({ preventScroll: true }); panel.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
    try {
      const query = new URLSearchParams({ snapshot: fixed, commit: commit.commit });
      const data = await api(`/api/worker/${task.id}/version-commit?${query}`, { signal: reads.signal }); if (!valid()) return;
      if (data.worker?.id !== task.id || data.commit?.commit !== commit.commit || typeof data.commit.message !== 'string') throw new Error('节点详情数据格式不兼容');
      const c = data.commit;
      panel.replaceChildren(el('h3', '提交详情'), el('code', c.commit, 'version-sha'),
        el('p', `作者：${text(c.author?.name)} · ${text(c.committed_at)}`, 'hint'), el('pre', c.message, 'version-message'));
      for (const association of c.association === 'verified' ? c.tasks || [] : []) {
        const section = el('section', undefined, 'version-detail-task'); section.append(workerLink(association), el('p', text(association.goal, '（无 Worker 目标）'), 'version-goal'));
        if (association.delivery_unavailable_reason) section.append(el('p', association.delivery_unavailable_reason, 'hint'));
        if (association.input) {
          const input = el('details', undefined, 'version-input'); input.append(linkWorkerNumbers(el('summary', `原始输入 ${inputNumber(association.input.id)}`)),
            el('pre', text(association.input.content, '（空输入）'), 'version-order')); section.append(input);
        }
        panel.append(section);
      }
      panel.append(button('关闭节点详情', close, 'ghost'));
    } catch (error) {
      if (!valid()) return;
      const message = el('p', `节点读取失败：${error.message}`, 'versions-error'); message.setAttribute('role', 'alert');
      panel.replaceChildren(message, button('重试节点详情', () => loadCommit(commit), 'ghost'), button('关闭节点详情', close, 'ghost'));
    } finally { if (valid()) panel.setAttribute('aria-busy', 'false'); }
  }
  const start = button('加载版本图', () => load(0), 'ghost versions-load');
  const refresh = button('刷新版本图', () => load(0, true), 'ghost versions-refresh');
  const retry = button('重试版本读取', () => retryTarget && load(retryTarget.target, retryTarget.refresh), 'ghost versions-retry');
  const newer = button('较新版本', () => load(index - 1), 'ghost versions-newer');
  const older = button('较早版本', () => load(index + 1), 'ghost versions-more');
  const paging = el('nav', undefined, 'versions-footer'); paging.setAttribute('aria-label', '版本图分页');
  for (const control of [newer, older]) { const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', '每页最多 30 节点；沿固定快照切换，不累计完整图。无对应页或读取中不可切换。'); host.append(control); paging.append(host); }
  const controls = el('div', undefined, 'versions-controls'); controls.append(refresh, retry);
  mounted = { root, owns, dispose: () => {
    if (disposed) return; disposed = true; module?.dispose(); cancel(); observer?.disconnect(); observer = null; cache.clear(); displayed = null;
    for (const control of root.querySelectorAll('button')) control.onclick = null;
  } };
  root.append(heading, el('p', `${task.branch} 已提交 Git 图 · 线条是真实父边；子 Worker 来源链请通过详情链接查看。`, 'hint'), start, controls, scope, feedback, tip, list, boundaries, panel, paging);
  module = enhanceVersionModule(root, feedback);
  sync();
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(entries => { if (current() && !started && entries.some(e => e.isIntersecting)) void load(0); }, { threshold: 0 }); observer.observe(root);
  }
  return root;
}
