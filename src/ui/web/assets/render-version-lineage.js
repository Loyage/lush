import { el } from './dom.js';
import { api, projectApi } from './api.js';
import { ui } from './state.js';
import { routeContext } from './route.js';
import { workerLabel } from './worker-label.js';
import { bindWorkerPreview } from './entity-preview.js';
import { linkWorkerNumbers } from './worker-links.js';
import { inputNumber } from './format.js';
import { versionLineageLayout } from './version-lineage-layout.js';
import { createLineageMappings } from './version-lineage-mappings.js';
import { createLineageChildPath } from './version-lineage-child-path.js';
import { enhanceVersionModule } from './version-module.js';

const LIMIT = 30, CACHE_PAGES = 3;
const oid = v => typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v);
const text = (v, fallback = '未知') => typeof v === 'string' && v ? v : fallback;
const short = v => oid(v) ? v.slice(0, 8) : '未知';
function button(label, run, className = 'ghost') {
  const node = el('button', label, className); node.type = 'button'; node.onclick = run; return node;
}
function readControlHost(control) {
  const host = el('span', undefined, 'help-host');
  host.setAttribute('data-help', '正在读取版本图或快照已失效时不可定位；读取完成后重试，快照失效请刷新版本图。');
  host.append(control); return host;
}
function workerLink(worker) {
  const link = el('a', `Worker ${workerLabel(worker)}`, 'worker-link version-task-link');
  link.setAttribute('href', `#worker-${worker.id}`); bindWorkerPreview(link, worker); return link;
}
function checked(data, task) {
  const nodes = data?.commits;
  if (data?.scope !== 'lineage' || data.range !== 'first-parent' || data.worker?.id !== task.id || data.branch !== task.branch
    || !Number.isSafeInteger(data.parent?.id) || typeof data.parent.branch !== 'string'
    || !oid(data.origin?.commit) || !oid(data.tip) || !['branch.ref', 'delivery.source'].includes(data.tip_evidence)
    || typeof data.snapshot !== 'string' || !data.snapshot || !Array.isArray(nodes) || nodes.length > LIMIT
    || typeof data.has_more !== 'boolean' || (data.has_more && (typeof data.cursor !== 'string' || !data.cursor))
    || !Array.isArray(data.deliveries) || !Array.isArray(data.untraceable_deliveries)
    || [...nodes, data.origin].some(c => !oid(c.commit) || !Array.isArray(c.parents) || !c.parents.every(oid) || c.parents.includes(c.commit))
    || new Set([data.origin.commit, ...nodes.map(c => c.commit)]).size !== nodes.length + 1
    || nodes.some((c, i) => i < nodes.length - 1 && c.parents[0] !== nodes[i + 1].commit)
    || (!data.has_more && nodes.length && nodes.at(-1).parents[0] !== data.origin.commit)) throw new Error('来源图数据格式不兼容，请更新后台与界面服务。');
  const order = new Map(nodes.map((c, i) => [c.commit, i]));
  if (nodes.some((c, i) => c.parents.some(parent => order.has(parent) && order.get(parent) <= i))) throw new Error('来源图 Git 父边拓扑不兼容。');
  const events = [...data.deliveries, ...data.untraceable_deliveries];
  if (events.length > 1000 || new Set(events.map(m => m.delivery_id)).size !== events.length
    || events.some(m => !Number.isSafeInteger(m.delivery_id) || m.delivery_id <= 0
      || !(m.source_commit === null || oid(m.source_commit)) || !(m.commit === null || oid(m.commit))
      || typeof m.delivery_available !== 'boolean' || (m.delivery_available && (!m.source_commit || !m.commit || m.parent_id !== data.parent.id))
      || (!m.delivery_available && !text(m.delivery_unavailable_reason, '')))
    || data.deliveries.some(m => ![data.origin.commit, ...nodes.map(c => c.commit)].includes(m.source_commit))) throw new Error('交付映射数据格式不兼容。');
  const endpoint = e => e && (e.commit === null || oid(e.commit)) && typeof e.available === 'boolean'
    && (e.available ? oid(e.commit) && Number.isSafeInteger(e.page) && e.page >= 0
      && (e.page === 0 ? e.cursor === null : typeof e.cursor === 'string' && Boolean(e.cursor))
      : e.page === null && e.cursor === null && Boolean(text(e.reason, '')));
  const branches = data.child_branches;
  if (!Array.isArray(branches) || branches.length > 1000 || new Set(branches.map(b => b.worker?.id)).size !== branches.length
    || branches.some(b => !Number.isSafeInteger(b.worker?.id) || b.worker.id <= 0 || b.worker.id === task.id || !endpoint(b.origin)
      || !Array.isArray(b.deliveries) || b.deliveries.some(m => !endpoint(m.landing) || m.landing.commit !== m.commit
        || !Number.isSafeInteger(m.delivery_id) || m.delivery_id <= 0 || typeof m.delivery_available !== 'boolean'
        || (m.delivery_available && (!oid(m.source_commit) || !oid(m.commit) || m.parent_id !== task.id))
        || (m.landing.available && !m.delivery_available)))
    || branches.reduce((sum, b) => sum + b.deliveries.length, 0) > 1000) throw new Error('子 Worker 分合路径格式不兼容，请更新后台与界面服务。');
  return data;
}
function receipt(mapping) {
  const box = el('details', undefined, 'lineage-receipt');
  box.dataset.delivery = String(mapping.delivery_id);
  box.append(el('summary', `${mapping.delivery_available ? '交付到父轨' : '交付不可追溯'} · ${short(mapping.source_commit)} ${mapping.delivery_available ? '→' : '/'} ${mapping.commit ? `${mapping.delivery_available ? '' : '未核验落点 '}${short(mapping.commit)}` : '无可信落点'}${mapping.delivery_available ? '' : ` · ${text(mapping.delivery_unavailable_reason)}`}`),
    el('time', text(mapping.delivered_at), 'version-metadata'));
  if (!mapping.delivery_available) box.append(el('p', text(mapping.delivery_unavailable_reason), 'versions-error'));
  box.append(el('p', '持久 Event 收据映射，不是 Git parents。', 'hint'),
    el('code', `source SHA：${mapping.source_commit || '缺失'}`, 'version-boundary-sha'),
    el('code', `父侧 landing SHA：${mapping.commit || '缺失'}`, 'version-boundary-sha'),
    el('p', `证据：${text(mapping.evidence)} · Event ${mapping.delivery_id}`, 'hint'));
  return box;
}

/** Returns one lifetime to the public renderer; no polling, global listeners or unbounded page graph. */
export function createWorkerLineage(task, isMounted) {
  const ownerDocument = document, boot = ui.workerNumbers, project = projectApi('/api/'), view = ui.view;
  const root = el('section', undefined, 'worker-versions versions-page lineage-page'); root.dataset.workerId = String(task.id);
  const title = el('div', undefined, 'section-title'); title.append(el('h2', '版本迭代'));
  const feedback = el('span', '', 'versions-feedback hint'); feedback.setAttribute('role', 'status'); feedback.hidden = true;
  const list = el('ol', undefined, 'lineage-list'); list.setAttribute('aria-label', '双轨来源链 · 从上到下旧到新');
  const canvas = el('div', undefined, 'lineage-canvas'); canvas.append(list);
  const unavailable = el('section', undefined, 'lineage-untraceable'); unavailable.hidden = true;
  const panel = el('section', undefined, 'version-node-detail'); panel.hidden = true; panel.id = `version-node-detail-${task.id}`; panel.tabIndex = -1;
  panel.setAttribute('aria-label', '按需提交详情');
  const childPanel = el('section', undefined, 'lineage-child-panel'); childPanel.id = `lineage-child-panel-${task.id}`; childPanel.tabIndex = -1;
  childPanel.setAttribute('aria-label', '选中子 Worker 的分合路径');
  const cache = new Map(), cursors = [null];
  let selectedChild = null, childButtons = [], markers = new Map();
  let module = null, disposed = false, started = false, observer = null, generation = 0, graphRead = null, nodeRead = null;
  let snapshot = null, identity = null, displayed = null, index = 0, retryTarget = null;
  const owns = () => !disposed && document === ownerDocument && ui.workerNumbers === boot && ui.view === view
    && projectApi('/api/') === project && !routeContext().invalid && isMounted(root);
  const current = () => owns() && root.isConnected;
  const mappingLines = createLineageMappings(root, canvas, current);
  const childPath = createLineageChildPath(root, canvas, current);
  const cancelNode = () => {
    nodeRead?.abort(); nodeRead = null; panel.replaceChildren(); panel.hidden = true; panel.setAttribute('aria-busy', 'false'); (module?.content || root).insertBefore(panel, null);
    for (const marker of list.querySelectorAll('.lineage-node')) marker.setAttribute('aria-expanded', 'false');
    mappingLines.changed(); childPath.changed();
  };
  const cancel = () => { generation++; graphRead?.abort(); graphRead = null; cancelNode(); };
  const status = (message, error = false) => {
    feedback.textContent = message; feedback.className = `versions-feedback ${error ? 'versions-error' : 'hint'}`;
    feedback.hidden = !message; if (module) module.summary.hidden = !message;
    feedback.setAttribute('role', error ? 'alert' : 'status');
  };
  const sync = () => {
    start.hidden = started; retry.hidden = !retryTarget;
    newer.disabled = Boolean(graphRead) || !snapshot || index === 0;
    older.disabled = Boolean(graphRead) || !snapshot || displayed?.snapshot !== snapshot || !displayed?.has_more;
    root.dataset.cachedPages = String(cache.size); root.setAttribute('aria-busy', String(Boolean(graphRead)));
    if (module) module.summary.hidden = feedback.hidden;
    for (const { control } of childButtons) control.disabled = Boolean(graphRead) || displayed?.snapshot !== snapshot;
    for (const control of childPanel.querySelectorAll('.lineage-child-locate')) control.disabled = Boolean(graphRead) || displayed?.snapshot !== snapshot;
    module?.measure();
  };
  const remember = (i, data) => {
    cache.delete(i); cache.set(i, data);
    // Offset zero has no signed cursor: pin it so it can never silently re-sample a moving ref.
    while (cache.size > CACHE_PAGES) cache.delete([...cache.keys()].find(k => k !== 0));
  };
  function commitCard(commit, origin = false) {
    const card = el('div', undefined, `lineage-card ${origin ? 'lineage-anchor' : 'lineage-source'}`); card.dataset.commit = commit.commit;
    const marker = button('', () => loadCommit(commit, card), 'lineage-node');
    marker.append(el('span', origin ? '◇' : '●', 'lineage-node-symbol'));
    marker.setAttribute('aria-label', `查看${origin ? '引出点' : '提交'} ${short(commit.commit)} 的详情`);
    marker.setAttribute('data-help', '按需读取这个固定来源节点的完整提交消息、作者与关联输入，不调用 Agent。');
    marker.id = `lineage-node-${task.id}-${commit.commit}`;
    if (origin) marker.classList.add('lineage-parent-node');
    marker.setAttribute('aria-controls', panel.id); marker.setAttribute('aria-expanded', 'false');
    const body = el('div', undefined, 'lineage-body');
    const heading = el('div', undefined, 'lineage-node-heading');
    const incoming = commit.association === 'verified' && (commit.tasks || []).some(association => association.id !== task.id && association.delivery_id);
    heading.append(el('span', origin ? '从父 Worker 引出' : incoming ? '子 Worker 合入' : '提交', 'lineage-kind'), el('code', short(commit.commit), 'version-short-sha'));
    body.append(heading, el('h4', text(commit.subject, '（无摘要）')));
    const metadata = el('div', undefined, 'version-metadata');
    const time = el('time', text(commit.committed_at).replace('T', ' ').slice(0, 16));
    if (commit.committed_at) time.setAttribute('datetime', commit.committed_at);
    metadata.append(time);
    if (origin) metadata.append(workerLink(displayed.parent));
    for (const association of commit.association === 'verified' ? commit.tasks || [] : []) {
      if (association.id !== task.id) metadata.append(workerLink(association));
    }
    body.append(metadata);
    for (const branch of displayed.child_branches) {
      if (branch.origin.commit !== commit.commit && !branch.deliveries.some(m => m.commit === commit.commit)) continue;
      const control = button(`查看 ${workerLabel(branch.worker)} 分合路径`, () => {
        if (!current() || graphRead || displayed?.snapshot !== snapshot) return;
        selectedChild = selectedChild?.worker.id === branch.worker.id ? null : branch;
        paintChild(true);
        if (!selectedChild) control.focus?.({ preventScroll: true });
      }, 'ghost lineage-child-toggle');
      control.dataset.workerId = String(branch.worker.id); control.setAttribute('aria-controls', childPanel.id);
      control.setAttribute('data-help', '在当前版本图内显示这个子 Worker 的创建引出点与各次合入点，不调用 Agent；一次显示一条子支线。');
      childButtons.push({ control, branch }); body.append(readControlHost(control));
    }
    const rail = el('div', undefined, `lineage-rail ${origin ? 'lineage-parent' : 'lineage-worker'}`);
    rail.append(marker); card.append(rail, body); return card;
  }
  function paintChild(focus = false) {
    childPanel.remove();
    for (const { control, branch } of childButtons) {
      const on = selectedChild?.worker.id === branch.worker.id;
      control.setAttribute('aria-expanded', String(on)); control.textContent = `${on ? '隐藏' : '查看'} ${workerLabel(branch.worker)} 分合路径`;
    }
    if (!selectedChild) { childPath.present(null, markers, index, childPanel); return; }
    const branch = selectedChild, heading = el('div', undefined, 'lineage-child-heading');
    heading.append(workerLink(branch.worker), button('隐藏分合路径', () => {
      selectedChild = null; paintChild(); childButtons.find(b => b.branch.worker.id === branch.worker.id)?.control.focus?.({ preventScroll: true });
    }));
    childPanel.replaceChildren(heading, el('p', '虚线表示 Worker 来源／交付关系，不是 Git 父边。', 'hint'));
    const points = el('ul', undefined, 'lineage-child-endpoints');
    const addEndpoint = (label, endpoint, mapping = null) => {
      const row = el('li'); row.append(el('span', label));
      if (endpoint.available) {
        const local = endpoint.page === index && markers.has(endpoint.commit);
        const control = button(`${short(endpoint.commit)}${local ? '' : ` · 第 ${endpoint.page + 1} 段`}`, () => locate(endpoint), 'ghost lineage-child-locate');
        control.dataset.commit = endpoint.commit; control.setAttribute('data-help', local
          ? '在本段版本图中聚焦这个固定提交节点，不重新读取历史。'
          : '在同一历史快照内切换到此节点所在分段并聚焦，不重新取样当前分支。');
        row.append(readControlHost(control));
      } else row.append(el('code', short(endpoint.commit)), el('span', text(endpoint.reason), 'versions-error'));
      if (mapping) { const details = receipt(mapping); details.querySelector('summary').textContent = '查看子 Worker 交付收据'; row.append(details); }
      points.append(row);
    };
    addEndpoint('引出点', branch.origin);
    for (const mapping of branch.deliveries) addEndpoint('合入点', mapping.landing, mapping);
    if (!branch.deliveries.length) points.append(el('li', '尚未合入'));
    childPanel.append(points);
    if (displayed.has_more && branch.origin.commit === displayed.origin.commit) childPanel.append(el('p', '引出点与本段之间有省略，不绘制跨省略区的完整支线。', 'hint'));
    const local = [branch.origin, ...branch.deliveries.map(m => m.landing)].find(e => e.available && e.page === index && markers.has(e.commit));
    const marker = local && markers.get(local.commit);
    if (marker) marker.parentNode.parentNode.querySelector('.lineage-body').append(childPanel);
    else { childPanel.append(el('p', '本段没有该子 Worker 的可定位端点。', 'hint')); canvas.append(childPanel); }
    childPath.present(branch, markers, index, childPanel); mappingLines.changed();
    if (focus) { childPanel.focus?.({ preventScroll: true }); childPanel.scrollIntoView?.({ block: 'nearest', behavior: 'auto' }); }
    sync();
  }
  async function locate(endpoint) {
    if (!current() || graphRead || !endpoint.available || displayed?.snapshot !== snapshot) return;
    const fixed = snapshot;
    if (endpoint.page > 0) cursors[endpoint.page] = endpoint.cursor;
    if (endpoint.page !== index) await load(endpoint.page);
    if (!current() || snapshot !== fixed || index !== endpoint.page || displayed?.snapshot !== fixed) return;
    const marker = markers.get(endpoint.commit);
    marker?.focus?.({ preventScroll: true }); marker?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
  }
  function present(data, pageIndex) {
    displayed = data; index = pageIndex; root.dataset.pageIndex = String(index); childButtons = [];
    if (selectedChild) selectedChild = data.child_branches.find(b => b.worker.id === selectedChild.worker.id) || selectedChild;
    const model = versionLineageLayout(data);
    const rows = [], sources = new Map(), targets = new Map();
    const renderRow = row => {
      const item = el('li', undefined, `lineage-row${row.origin ? ' lineage-origin' : ''}`);
      const card = commitCard(row.commit, row.origin), marker = card.querySelector('.lineage-node');
      const source = card.querySelector('.lineage-body');
      item.append(card); sources.set(row.commit.commit, marker);
      if (row.origin) targets.set(row.commit.commit, marker);
      if (row.deliveries.some(mapping => mapping.delivery_available)) {
        card.classList.add('lineage-delivery-source');
        card.querySelector('.lineage-node-heading').append(el('span', '交付源', 'lineage-delivery-badge'));
      }
      if (row.commit.commit === data.tip) card.querySelector('.lineage-node-heading').append(el('span', '快照末端', 'lineage-tip-badge'));
      for (const landing of row.landings) {
        const anchor = el('div', undefined, 'lineage-card lineage-anchor lineage-landing'); anchor.dataset.landing = landing;
        const body = el('div', undefined, 'lineage-body');
        const heading = el('div', undefined, 'lineage-node-heading');
        heading.append(el('span', '父侧落点', 'lineage-kind'), el('code', short(landing), 'version-short-sha'));
        const name = el('h4', '交付到 '); name.append(workerLink(data.parent)); body.append(heading, name);
        const receipts = data.deliveries.filter(m => m.delivery_available && m.commit === landing);
        const from = [...new Set(receipts.map(mapping => short(mapping.source_commit)))];
        body.append(el('p', `来源 ${from.join('、')}`, 'version-metadata'));
        const details = el('details', undefined, 'lineage-landing-receipts'); details.append(el('summary', `查看交付收据（${receipts.length}）`), ...receipts.map(receipt)); body.append(details);
        const marker = el('span', undefined, 'lineage-anchor-dot lineage-parent-node'); marker.append(el('span', '□', 'lineage-node-symbol')); marker.id = `lineage-parent-${task.id}-${landing}`;
        const rail = el('div', undefined, 'lineage-rail lineage-parent'); rail.append(marker);
        targets.set(landing, marker); anchor.append(rail, body); item.append(anchor);
      }
      for (const mapping of row.deliveries) {
        const mappingNode = receipt(mapping); mappingNode.classList.add('lineage-mapping');
        mappingNode.dataset.source = mapping.source_commit; if (mapping.commit) mappingNode.dataset.landing = mapping.commit;
        if (mapping.delivery_available) mappingNode.dataset.verified = 'true';
        source.append(mappingNode);
      }
      for (const edge of row.edges) {
        if (!edge.boundary && !edge.external) continue;
        const boundary = el('div', undefined, 'lineage-git-boundary'); boundary.dataset.child = edge.child; boundary.dataset.parent = edge.parent;
        boundary.append(el('span', `${edge.external ? '同步外部父边' : '本段之外的真实父边'} · ${short(edge.parent)}`, 'hint'));
        source.append(boundary);
      }
      return item;
    };
    const prior = el('li', undefined, 'lineage-prior'); prior.append(el('p', '⋮ 引出点之前的父轨历史省略', 'hint'));
    const originRow = renderRow(model.origin); rows.push(originRow);
    // No continuous real edge is allowed through an omitted range.
    if (model.omitted) {
      const gap = el('li', undefined, 'lineage-gap'); gap.append(el('p', '⋮ 父轨外部历史省略', 'hint'),
        el('p', '⋮ 创建起点与本段之间还有更早分段，已省略；请加载较早版本。', 'hint')); rows.push(gap);
    }
    for (const row of model.rows) rows.push(renderRow(row));
    list.replaceChildren(prior, ...rows);
    mappingLines.present(model, sources, targets); markers = sources;
    const unknown = new Map(data.untraceable_deliveries.map(m => [m.delivery_id, m]));
    unavailable.replaceChildren(el('h4', `不可追溯交付 · ${unknown.size}`), ...[...unknown.values()].map(receipt)); unavailable.hidden = !unknown.size;
    const missing = [...data.deliveries, ...data.untraceable_deliveries].filter(m => !m.delivery_available || data.untraceable_deliveries.includes(m));
    status(missing.length ? `不可追溯交付 ${missing.length} 条：${[...new Set(missing.map(m => text(m.delivery_unavailable_reason, '来源不在可追溯链中')))].join('；')}。` : '', missing.length > 0);
    paintChild(); sync();
  }
  async function load(target = index, refresh = false) {
    if (!current() || target < 0) return;
    started = true; observer?.disconnect(); observer = null; cancel(); retryTarget = null;
    if (refresh) { cache.clear(); cursors.length = 1; snapshot = identity = null; selectedChild = null; childPanel.remove(); childPath.present(null, markers, index, childPanel); target = 0; }
    const cached = cache.get(target);
    if (cached) { remember(target, cached); present(cached, target); return; }
    const reads = graphRead = new AbortController(), ticket = generation;
    const valid = () => current() && graphRead === reads && generation === ticket && !reads.signal.aborted;
    status('正在读取来源图…'); sync();
    try {
      if (target > 0 && !cursors[target]) throw new Error('此分段缺少固定快照游标，请刷新版本图。');
      const query = new URLSearchParams({ limit: String(LIMIT) }); if (cursors[target]) query.set('cursor', cursors[target]);
      const data = checked(await api(`/api/worker/${task.id}/version-lineage?${query}`, { signal: reads.signal }), task);
      if (!valid()) return;
      const nextIdentity = JSON.stringify([data.branch, data.parent, data.origin.commit, data.tip, data.tip_evidence, data.tip_delivery_id]);
      if (snapshot && (snapshot !== data.snapshot || identity !== nextIdentity)) throw new Error('分页快照发生变化，请刷新版本图。');
      if (target === 0 && data.commits[0]?.commit !== data.tip && data.tip !== data.origin.commit) throw new Error('来源图首屏 tip 不一致');
      snapshot = data.snapshot; identity = nextIdentity; cursors[target + 1] = data.cursor;
      remember(target, data); graphRead = null; present(data, target);
    } catch (error) {
      if (!valid()) return;
      retryTarget = { target, refresh }; status(`读取失败：${error.message}。保留成功页；刷新失败后旧节点不可读取，游标失效请刷新版本图。`, true);
    } finally { if (current() && generation === ticket && !reads.signal.aborted) { graphRead = null; sync(); } }
  }
  async function loadCommit(commit, card) {
    if (!current() || !snapshot || displayed?.snapshot !== snapshot || graphRead) return;
    cancelNode(); const reads = nodeRead = new AbortController(), fixed = snapshot, ticket = generation;
    const marker = card.querySelector('.lineage-node'), body = card.querySelector('.lineage-body');
    const valid = () => current() && nodeRead === reads && generation === ticket && !reads.signal.aborted;
    const close = () => { cancelNode(); marker.focus?.({ preventScroll: true }); };
    body.insertBefore(panel, null); panel.hidden = false; marker.setAttribute('aria-expanded', 'true');
    panel.replaceChildren(el('p', '节点详情加载中…', 'hint')); panel.setAttribute('aria-busy', 'true');
    panel.focus?.({ preventScroll: true }); panel.scrollIntoView?.({ block: 'nearest', behavior: 'auto' }); mappingLines.changed(); childPath.changed();
    try {
      const query = new URLSearchParams({ snapshot: fixed, commit: commit.commit });
      const data = await api(`/api/worker/${task.id}/version-lineage-commit?${query}`, { signal: reads.signal });
      if (!valid()) return;
      if (data.worker?.id !== task.id || data.scope !== 'lineage' || data.commit?.commit !== commit.commit || typeof data.commit.message !== 'string') throw new Error('节点详情数据格式不兼容');
      const c = data.commit;
      panel.replaceChildren(el('h3', '提交详情'), el('code', c.commit, 'version-sha'),
        el('p', `作者：${text(c.author?.name)} · ${text(c.committed_at)}`, 'hint'), el('pre', c.message, 'version-message'));
      for (const association of c.association === 'verified' ? c.tasks || [] : []) {
        const section = el('section', undefined, 'version-detail-task');
        section.append(workerLink(association), el('p', text(association.goal, '（无 Worker 目标）'), 'version-goal'));
        if (association.input) {
          const input = el('details', undefined, 'version-input'); input.append(linkWorkerNumbers(el('summary', `原始输入 ${inputNumber(association.input.id)}`)),
            el('pre', text(association.input.content, '（空输入）'), 'version-order')); section.append(input);
        }
        panel.append(section);
      }
      panel.append(...(data.deliveries || []).map(receipt), button('关闭节点详情', close));
    } catch (error) {
      if (!valid()) return;
      const message = el('p', `节点读取失败：${error.message}`, 'versions-error'); message.setAttribute('role', 'alert');
      panel.replaceChildren(message, button('重试节点详情', () => loadCommit(commit, card)), button('关闭节点详情', close));
    } finally { if (valid()) { panel.setAttribute('aria-busy', 'false'); mappingLines.changed(); childPath.changed(); } }
  }
  const start = button('加载来源图', () => load(0), 'ghost versions-load');
  const refresh = button('刷新版本图', () => load(0, true), 'ghost versions-refresh');
  const retry = button('重试版本读取', () => retryTarget && load(retryTarget.target, retryTarget.refresh), 'ghost versions-retry');
  const newer = button('较新版本', () => load(index - 1), 'ghost versions-newer');
  const older = button('较早版本', () => load(index + 1), 'ghost versions-more');
  const controls = el('div', undefined, 'versions-controls'); controls.append(refresh, retry);
  title.append(controls);
  const paging = el('nav', undefined, 'versions-footer'); paging.setAttribute('aria-label', '来源图分段分页');
  for (const control of [newer, older]) {
    const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', '每段最多 30 个自身提交，固定首屏快照；没有对应页或读取中不可切换。'); host.append(control); paging.append(host);
  }
  root.append(title, start, feedback, canvas, unavailable, panel, paging);
  module = enhanceVersionModule(root, feedback);
  sync();
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(entries => { if (current() && !started && entries.some(e => e.isIntersecting)) void load(0); }, { threshold: 0 }); observer.observe(root);
  }
  const dispose = () => {
    if (disposed) return; disposed = true; module?.dispose(); mappingLines.dispose(); childPath.dispose(); cancel(); observer?.disconnect(); observer = null; cache.clear(); displayed = null;
    for (const control of root.querySelectorAll('button')) control.onclick = null;
  };
  return { root, owns, dispose };
}
