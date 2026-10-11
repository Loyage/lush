import { $, el, button } from './dom.js';
import { api } from './api.js';
import { detail } from './navigate.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { inputNumber } from './format.js';
import { linkWorkerNumbers } from './worker-links.js';
import { workerLabel } from './worker-label.js';
import { versionGraphLayout, versionGraphPath } from './version-graph-layout.js';

const REFRESH_HELP = '重新读取当前图的第一页；main 图取最新提交，交付图仍固定在所选交付轮次。只读 Git，不启动 Agent。';
const MORE_HELP = '沿当前图首次读取时固定的提交与交付范围继续分页，不混入新增提交。';
const text = (value, fallback = '未知') => typeof value === 'string' && value ? value : fallback;
const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const canDrill = task => task.delivery_available === true && Number.isSafeInteger(task.delivery_id) && task.delivery_id > 0;
const svg = (tag, attributes = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
};

function showDetails(root, detailed) {
  for (const node of root.querySelectorAll('.version-detail')) node.hidden = !detailed;
}

/** Commit metadata and original orders are always plain text, never executable markup. */
export function renderVersionCommit(commit, { detailed = false, onDelivery } = {}) {
  const card = el('li', undefined, 'version-commit'); card.dataset.commit = commit.commit;
  const rail = el('div', undefined, 'version-rail');
  const body = el('div', undefined, 'version-body');
  const tasks = commit.association === 'verified' && Array.isArray(commit.tasks) ? commit.tasks : [];
  const choices = el('div', undefined, 'version-delivery-choices'); choices.hidden = true;
  choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', '选择要查看的 Worker 交付');
  const feedback = el('p', undefined, 'version-node-feedback hint'); feedback.hidden = true;
  const explain = message => { feedback.textContent = message; feedback.hidden = false; };
  const choose = () => {
    if (!tasks.length) return explain('未关联 Worker：没有精确交付证据，无法查看 Worker 交付图。');
    if (tasks.length === 1) {
      if (canDrill(tasks[0]) && onDelivery) return onDelivery(tasks[0]);
      return explain(text(tasks[0].delivery_unavailable_reason, '此提交属于当前固定交付范围，没有可继续下钻的独立交付记录。'));
    }
    choices.hidden = !choices.hidden;
    marker.setAttribute('aria-expanded', String(!choices.hidden));
    if (!choices.hidden) choices.querySelector('button')?.focus();
  };
  const marker = button('', choose, 'version-node', { help: '查看此提交精确关联的固定 Worker 交付图；多条关联时选择 Worker，无交付证据时说明原因。不调用 Agent。' });
  marker.setAttribute('aria-label', `提交 ${text(commit.short_commit, text(commit.commit).slice(0, 12))}：${text(commit.subject, '（无提交摘要）')}${tasks.length ? `，Worker ${tasks.map(workerLabel).join('、')}` : '，未关联 Worker'}，查看交付图`);
  if (tasks.length > 1) marker.setAttribute('aria-expanded', 'false');
  rail.append(marker);
  body.append(el('h2', text(commit.subject, '（无提交摘要）')));
  const metadata = el('div', undefined, 'version-metadata');
  const short = el('code', text(commit.short_commit, text(commit.commit).slice(0, 12)), 'version-short-sha');
  const sha = el('code', text(commit.commit), 'version-sha version-detail');
  sha.setAttribute('aria-label', `提交 SHA ${text(commit.commit)}`);
  const time = el('time', text(commit.committed_at));
  if (commit.committed_at) time.setAttribute('datetime', commit.committed_at);
  metadata.append(short, time, sha, el('span', `作者：${text(commit.author?.name)}`, 'version-detail')); body.append(metadata);
  if (!tasks.length) {
    body.append(el('p', '未关联 Worker', 'version-unassociated'),
      el('p', '没有确切交付证据；不会根据提交标题猜测归属。', 'hint version-detail'));
  } else {
    body.append(el('p', '已核实固定范围的 Worker 关联', 'version-associated version-detail'));
    for (const task of tasks) {
      const entry = el('section', undefined, 'version-task');
      entry.append(button(`查看 Worker ${workerLabel(task)}`, () => detail(task.id), 'version-task-link', { worker: task }),
        el('p', text(task.goal, '（无 Worker 目标）'), 'version-goal version-detail'));
      if (task.goal_truncated) entry.append(el('p', 'Worker 目标已截断，可在详情中查看完整内容。', 'hint version-detail'));
      if (task.input) {
        const input = el('details', undefined, 'version-input version-detail');
        input.append(linkWorkerNumbers(el('summary', `原始指令 ${inputNumber(task.input.id)}`)), el('p', text(task.input.content, '（空输入）'), 'version-order'));
        if (task.input.truncated || task.input.content_truncated) input.append(el('p', '原始指令内容已截断。', 'hint'));
        entry.append(input);
      }
      if (tasks.length > 1) {
        const option = button(`交付图 · ${workerLabel(task)}`, () => canDrill(task) && onDelivery ? onDelivery(task)
          : explain(text(task.delivery_unavailable_reason, '该 Worker 交付缺少固定源或基线证据，无法追溯。')), 'version-delivery-choice',
        { help: '查看此提交对应的固定交付轮次，不切换到 Worker 当前分支，不调用 Agent。' });
        choices.append(option);
      }
      body.append(entry);
    }
  }
  body.append(choices, feedback);
  if (commit.subject_truncated || commit.author?.name_truncated) body.append(el('p', '提交摘要或作者信息已截断。', 'hint version-detail'));
  card.append(rail, body); showDetails(card, detailed);
  return card;
}

function drawGraph(frame) {
  const layout = versionGraphLayout(frame.commits);
  frame.list.className = `versions-list version-graph-lanes-${Math.min(layout.lanes, 6)}`;
  const boundaries = new Set(layout.boundaries.map(edge => edge.parent));
  frame.cards.forEach((card, index) => {
    const row = layout.rows[index], rail = card.querySelector('.version-rail'), marker = card.querySelector('.version-node');
    const lines = svg('svg', { viewBox: `0 0 ${layout.width} 100`, preserveAspectRatio: 'none', width: layout.width,
      'aria-hidden': 'true', focusable: 'false', class: 'version-lines' });
    for (const segment of row.segments) lines.append(svg('path', { d: versionGraphPath(segment),
      class: `version-edge version-lane-${segment.to.lane % 3}${boundaries.has(segment.parent) ? ' version-edge-boundary' : ''}`, 'data-parent': segment.parent, 'vector-effect': 'non-scaling-stroke' }));
    // A round-capped zero-length stroke remains round under non-uniform SVG scaling.
    const dot = svg('svg', { viewBox: `0 0 ${layout.width} 100`, preserveAspectRatio: 'none', width: layout.width,
      'aria-hidden': 'true', focusable: 'false', class: 'version-marker' });
    dot.append(svg('path', { d: `M ${16 + row.lane * 22} 50 l 0 0.001`, class: `version-dot version-lane-${row.lane % 3}`, 'vector-effect': 'non-scaling-stroke' }));
    marker.replaceChildren(dot); rail.replaceChildren(lines, marker);
  });
  frame.boundaries.replaceChildren();
  if (layout.boundaries.length) {
    frame.boundaries.append(el('p', frame.hasMore ? '虚线边界：父提交尚未加载，或位于当前交付范围之外。继续分页可展开图内的父提交。'
      : '虚线边界：以下父提交位于当前交付范围之外，不是当前图中的提交节点。', 'hint'));
    for (const { parent } of layout.boundaries) frame.boundaries.append(el('code', parent, 'version-boundary-sha'));
  }
  frame.boundaries.hidden = !layout.boundaries.length;
}

function checkedPage(data, delivery) {
  const malformed = !data || data.scope !== (delivery === null ? 'main' : 'delivery')
    || typeof data.branch !== 'string' || (delivery === null && data.branch !== 'main')
    || data.delivery !== delivery || (delivery !== null && (!data.worker || !Number.isSafeInteger(data.worker.id)))
    || !Array.isArray(data.commits) || typeof data.has_more !== 'boolean'
    || !(data.tip === null || oid(data.tip)) || !(data.base === null || oid(data.base))
    || (data.has_more && (typeof data.cursor !== 'string' || !data.cursor))
    || data.commits.some(commit => !oid(commit.commit) || !Array.isArray(commit.parents) || !commit.parents.every(oid));
  if (malformed) throw new Error('版本历史数据格式不兼容，请更新项目后台与界面服务。');
  return data;
}

/** Explicit entry / refresh / pagination only; identities discard late page and drilldown reads. */
export function openVersions() {
  const view = activateDetailView({ view: 'versions' });
  if (ui.versionsPage?.view === view) return ui.versionsPage.pending || Promise.resolve();
  const page = el('div', undefined, 'versions-page'), header = el('header', undefined, 'versions-head');
  const copy = el('div'), scope = el('h2', 'main 提交图', 'versions-scope'); scope.tabIndex = -1;
  copy.append(el('h1', '版本迭代'), el('p', 'Git 提交图 · 点击节点查看对应的固定 Worker 交付。', 'hint'),
    el('p', 'main 图只含已进入 main 的可达提交；线条表示真实 Git 父子关系，不是 Worker 委派关系。', 'hint version-detail'));
  const feedback = el('p', undefined, 'versions-feedback hint'); feedback.setAttribute('role', 'status');
  const tip = el('p', undefined, 'version-tip hint version-detail');
  const empty = el('p', undefined, 'hint'); empty.hidden = true;
  const canvas = el('div', undefined, 'versions-canvas'), footer = el('div', undefined, 'versions-footer');
  const makeFrame = (delivery = null, worker = null) => {
    const list = el('ol', undefined, 'versions-list'), boundaries = el('div', undefined, 'version-boundaries');
    list.setAttribute('aria-label', delivery === null ? 'main Git 提交图' : `Worker ${workerLabel(worker)} 固定交付提交图`);
    return { delivery, worker, tip: null, base: null, branch: delivery === null ? 'main' : null,
      cursor: null, hasMore: false, count: 0, loaded: false, commits: [], cards: [], list, boundaries,
      message: '', error: false, retryMore: false, scrollTop: 0, documentScrollTop: 0, focus: null };
  };
  const main = makeFrame();
  const state = { view, pending: null, request: 0, detailed: false, frames: [main], active: main };
  ui.versionsPage = state;
  const ownsPage = () => ui.view === view && ui.versionsPage === state;
  const sync = () => {
    const frame = state.active;
    Object.assign(state, { tip: frame.tip, cursor: frame.cursor, count: frame.count, loaded: frame.loaded, hasMore: frame.hasMore });
    scope.textContent = frame.delivery === null ? 'main 提交图' : `Worker ${workerLabel(frame.worker)} · 固定交付图`;
    tip.textContent = frame.tip ? `本次历史固定于 ${frame.branch}：${frame.tip}${frame.base ? ` · 开发基线：${frame.base}` : ''}` : '';
    empty.hidden = frame.count > 0 || !frame.loaded;
    empty.textContent = !frame.loaded ? '' : frame.delivery === null && frame.tip === null ? '本项目尚无 main 分支，暂时没有版本历史。'
      : frame.delivery === null ? 'main 图暂无提交记录。' : '本轮交付范围没有额外开发提交。';
    feedback.textContent = frame.message; feedback.className = `versions-feedback ${frame.error ? 'versions-error' : 'hint'}`;
    feedback.setAttribute('role', frame.error ? 'alert' : 'status');
    moreButton.hidden = !frame.hasMore; moreButton.disabled = Boolean(state.pending) || !frame.hasMore;
    moreButton.textContent = frame.retryMore ? '重试加载更早版本' : '加载更早版本';
    refreshButton.textContent = frame.loaded ? '刷新历史' : state.pending ? '刷新历史' : '重试读取';
    backButton.hidden = state.frames.length < 2; mainButton.hidden = frame.delivery === null;
    page.setAttribute('aria-busy', String(Boolean(state.pending)));
    showDetails(page, state.detailed);
  };
  const activate = frame => {
    if (state.active !== frame) {
      state.active.scrollTop = $('detail').scrollTop;
      state.active.documentScrollTop = document.scrollingElement?.scrollTop ?? 0;
      state.active.focus = document.activeElement;
    }
    state.request++; state.pending = null; state.active = frame;
    canvas.replaceChildren(frame.list, frame.boundaries); sync();
    if (frame.loaded) frame.focus?.focus?.({ preventScroll: true });
    else if (frame.delivery !== null) scope.focus({ preventScroll: true });
    $('detail').scrollTop = frame.scrollTop;
    if (document.scrollingElement) document.scrollingElement.scrollTop = frame.documentScrollTop;
  };
  const openDelivery = task => {
    if (!ownsPage() || !canDrill(task)) return Promise.resolve();
    // Never recurse to an already-open delivery even if an incompatible backend supplies it.
    const existing = state.frames.findIndex(frame => frame.delivery === task.delivery_id);
    if (existing >= 0) {
      state.frames = state.frames.slice(0, existing + 1); activate(state.frames.at(-1));
      return state.active.loaded ? Promise.resolve() : load();
    }
    const frame = makeFrame(task.delivery_id, task); state.frames.push(frame); activate(frame);
    return load();
  };
  const load = (more = false) => {
    if (!ownsPage()) return Promise.resolve();
    const frame = state.active;
    if (more && (state.pending || !frame.hasMore)) return state.pending || Promise.resolve();
    const request = ++state.request, cursor = more ? frame.cursor : null, wasLoaded = frame.loaded;
    const current = () => ownsPage() && state.request === request && state.active === frame;
    frame.message = more ? '正在读取更早版本…' : frame.delivery === null ? '正在读取 main 提交图…' : '正在读取固定交付图…';
    frame.error = false;
    const pending = (async () => {
      try {
        const data = checkedPage(await api(`/api/version-graph?limit=50${frame.delivery === null ? '' : `&delivery=${frame.delivery}`}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), frame.delivery);
        if (!current()) return;
        if (more && (data.tip !== frame.tip || data.base !== frame.base || data.branch !== frame.branch)) throw new Error('历史分页基线发生变化，请刷新后重新读取。');
        const commits = more ? [...frame.commits, ...data.commits] : data.commits;
        // Validate graph before mutating the last successfully read cards.
        versionGraphLayout(commits);
        const cards = data.commits.map(commit => renderVersionCommit(commit, { detailed: state.detailed, onDelivery: openDelivery }));
        if (!more) { frame.list.replaceChildren(); frame.cards = []; }
        frame.list.append(...cards); frame.cards.push(...cards); frame.commits = commits; frame.count = commits.length;
        frame.tip = data.tip; frame.base = data.base; frame.worker = data.worker; frame.branch = data.branch;
        frame.cursor = data.cursor; frame.hasMore = data.has_more; frame.loaded = true; frame.retryMore = false;
        drawGraph(frame);
        frame.message = `已显示 ${frame.count} 条提交${data.has_more ? '，可继续加载更早版本。' : '，已到当前图范围的起点。'} 页面不会自动刷新。`;
      } catch (error) {
        if (!current()) return;
        frame.message = `读取失败：${error.message}${frame.loaded ? more ? '。已加载记录保留，可重试加载；若游标失效，请刷新历史从当前图第一页重新读取。'
          : '。以下保留上次读取的旧历史，未取得最新版本。' : frame.delivery === null ? '。请重试。' : '。无法追溯此次交付；可重试或返回上层图，不会改看 Worker 当前分支。'}`;
        frame.error = true; frame.retryMore = more;
      } finally {
        if (current()) { state.pending = null; sync(); if (!wasLoaded && frame.delivery !== null) scope.focus({ preventScroll: true }); }
      }
    })();
    state.pending = pending; sync();
    return pending;
  };
  const refreshButton = el('button', '刷新历史', 'versions-refresh'); refreshButton.type = 'button';
  refreshButton.onclick = () => load(); refreshButton.setAttribute('data-help', REFRESH_HELP);
  const moreButton = el('button', '加载更早版本', 'versions-more'); moreButton.type = 'button';
  moreButton.onclick = () => load(true); moreButton.setAttribute('data-help', MORE_HELP);
  const moreHost = el('span', undefined, 'help-host'); moreHost.setAttribute('data-help', MORE_HELP); moreHost.append(moreButton);
  const backButton = el('button', '返回上层图', 'versions-back'); backButton.type = 'button';
  backButton.onclick = () => {
    if (!ownsPage() || state.frames.length < 2) return Promise.resolve();
    state.frames.pop(); activate(state.frames.at(-1));
    return state.active.loaded ? Promise.resolve() : load();
  };
  const mainButton = el('button', '返回 main 图', 'versions-main'); mainButton.type = 'button';
  mainButton.onclick = () => { if (!ownsPage()) return Promise.resolve(); state.frames = [main]; activate(main); return main.loaded ? Promise.resolve() : load(); };
  const navigation = el('nav', undefined, 'versions-navigation'); navigation.setAttribute('aria-label', '提交图导航');
  navigation.append(backButton, mainButton, scope);
  const controls = el('div', undefined, 'versions-controls'), mode = el('label', undefined, 'versions-mode');
  const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = state.detailed;
  checkbox.onchange = () => {
    if (!ownsPage()) return;
    state.detailed = checkbox.checked; page.classList.toggle('versions-detailed', state.detailed); showDetails(page, state.detailed);
  };
  mode.append(checkbox, el('span', '详情模式')); controls.append(mode, refreshButton);
  footer.append(moreHost); header.append(copy, controls); page.append(header, navigation, feedback, tip, empty, canvas, footer);
  $('detail').replaceChildren(page); activate(main);
  return load();
}
