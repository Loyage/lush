import { el, button } from './dom.js';
import { api } from './api.js';
import { projectBase, routeContext } from './route.js';
import { autoCompletionControl, COMPLETION_LEVELS } from './hook-controls.js';
import { renderOperation, validOperation } from './automation-tools.js';
import { workerLabel } from './worker-label.js';

const PAGE_SIZE = 25;
const positive = value => Number.isSafeInteger(value) && value > 0;
function validPage(page, before) {
  return page?.version === 1 && Array.isArray(page.workers) && page.workers.length <= PAGE_SIZE
    && typeof page.has_more === 'boolean'
    && (!page.has_more || page.workers.length > 0 && positive(page.cursor))
    && new Set(page.workers.map(row => row.id)).size === page.workers.length
    && page.workers.every((row, index) => positive(row.id) && (before === null || row.id < before)
      && (!index || row.id < page.workers[index - 1].id) && ['order','child'].includes(row.task_kind)
      && row.hooks?.worker_id === row.id && typeof row.hooks.revision === 'string' && Array.isArray(row.hooks.mounts))
    && (!page.workers.length || page.cursor === page.workers.at(-1).id);
}

/** Feature-local UI: its parent owns navigation, title and subpage tabs. */
export function renderCompletionAutomation({ ownsPage = () => true, catalogue = null } = {}) {
  const scope = projectBase(), ownerDocument = globalThis.document;
  let disposed = false, subpage = 'settings', index = 0, epoch = 0, busy = false, editing = 0;
  let resumeRead = false, resumeCatalogue = false, cataloguePending = null;
  const pages = [], requests = new Set();
  const owns = () => !disposed && ownerDocument === globalThis.document && ownsPage()
    && !routeContext().invalid && projectBase() === scope;
  const root = el('section', undefined, 'automation-completion');
  const settings = el('section', undefined, 'automation-completion-settings');
  const defaults = el('section', undefined, 'block completion-defaults');
  const workers = el('section', undefined, 'block completion-workers');
  workers.append(el('h2', '本项目 Worker 实际授权'), el('p', '点击最高环节即保存该 Worker 授权；高亮不是执行成功。child 流程只读，不继承指令的验收授权。', 'hint'));
  const workerRows = el('div', undefined, 'completion-worker-rows'); workers.append(workerRows);
  settings.append(defaults, workers);
  const history = el('section', undefined, 'block automation-completion-history');
  history.append(el('h2', '合并／验收运行记录'), el('p', '按 Worker 编号从新到旧分页，展示每个 Worker 当前读面提供的最近合并、验收真实操作快照；不是按操作时间分页，也不是全部历史审计。设置保存或 Agent 返回不能证明操作完成。', 'hint'));
  const historyRows = el('div', undefined, 'completion-history-rows'); history.append(historyRows);
  const footer = el('div', undefined, 'actions completion-pagination');
  const range = el('p', undefined, 'hint completion-page-range'), error = el('p', undefined, 'error'); error.setAttribute('role', 'status');
  const previous = button('上一页', () => switchPage(index - 1), 'ghost');
  const next = button('下一页', () => switchPage(index + 1), 'ghost');
  const refresh = button('刷新当前页', () => readPage(index, pages[index]?.before ?? null), 'ghost');
  footer.append(previous, next, refresh); root.append(settings, history, range, error, footer);
  for (const control of [previous, next, refresh]) {
    const clicked = control.onclick; control.onclick = async () => { await clicked(); paint(); };
  }

  function paintDefaults(value, failure = null) {
    if (!owns()) return;
    const link = el('a', '打开设备级全局自动化设置'); link.href = '/#automation';
    defaults.replaceChildren(el('h2', '设备默认作用域'), el('p', '完工默认属于设备，项目没有覆盖。只影响之后实际创建的新指令；不改已有 Worker 或 child。', 'hint'), link);
    const model = value?.completion_defaults;
    defaults.append(el('p', failure ? `设备默认读取失败：${failure}` : typeof model?.enabled === 'boolean' && ['merge','accept','archive'].includes(model.level)
      ? `读取时设备默认：${model.enabled ? COMPLETION_LEVELS[model.level] : '关闭'}（记住的最高环节：${COMPLETION_LEVELS[model.level]}）。`
      : '设备默认状态尚未确认；请在全局自动化设置核查。', failure ? 'error' : 'hint'));
  }
  function paint() {
    if (!owns()) return;
    settings.hidden = subpage !== 'settings'; history.hidden = subpage !== 'history';
    const page = pages[index];
    if (page) { workerRows.replaceChildren(page.workerNode); historyRows.replaceChildren(page.historyNode); }
    range.textContent = busy ? '正在读取本项目 Worker 分页…' : page
      ? `第 ${index + 1} 页 · 已读取 ${page.workers.length} 个 Worker${page.workers.length ? ` · ${workerLabel(page.workers[0])} 至 ${workerLabel(page.workers.at(-1))}` : ''} · ${page.has_more ? '还有未读取的 Worker' : '已到 Worker 分页末尾'}。`
      : '尚未读到本项目 Worker；不能据此判断无记录。';
    previous.disabled = busy || editing > 0 || index === 0;
    next.disabled = busy || editing > 0 || !page?.has_more;
    refresh.disabled = busy || editing > 0;
    error.hidden = !error.textContent;
    root.setAttribute('aria-busy', String(busy));
  }
  function buildPage(value, before) {
    const page = { ...value, before, workerNode: el('div'), historyNode: el('div') };
    let records = 0, unavailable = 0, building = true;
    const ownsWorkerPage = () => owns() && (building || pages[index] === page);
    for (const task of value.workers) {
      const row = el('article', undefined, 'hook-mount completion-worker'); row.dataset.workerId = task.id;
      row.append(el('h3', `${workerLabel(task)} · ${task.display_title || task.auto_title || task.goal || 'Worker'}`));
      row.append(autoCompletionControl(task, task.hooks, () => readPage(index, page.before), ownsWorkerPage,
        active => {
          editing += active ? 1 : -1;
          if (!active && !ownsWorkerPage()) resumeRead = true;
          paint();
        }));
      page.workerNode.append(row);
      for (const mount of task.hooks.mounts) {
        if (!['auto-merge','auto-accept'].includes(mount.id) || mount.operation == null) continue;
        if (!validOperation(mount.operation, mount) || mount.operation.worker_id !== task.id) { unavailable++; continue; }
        const card = el('article', undefined, 'hook-mount completion-record');
        card.append(el('h3', `${workerLabel(task)} · ${mount.id === 'auto-merge' ? '合并／交付' : '验收'}`), renderOperation(mount));
        page.historyNode.append(card); records++;
      }
    }
    if (!value.workers.length) page.workerNode.append(el('p', '本页没有可管理的指令／child Worker。', 'hint'));
    if (!records) page.historyNode.append(el('p', '本页 Worker 暂无真实合并／验收操作记录；不代表其他页或全部历史无记录。', 'hint'));
    if (unavailable) page.historyNode.append(el('p', `${unavailable} 项操作证据版本不兼容或身份不符；无法确认结果，请只读刷新核查。`, 'error'));
    building = false;
    return page;
  }
  async function readPage(target, before) {
    if (!owns() || busy || editing > 0) return;
    const generation = ++epoch, controller = new AbortController(); requests.add(controller);
    busy = true; resumeRead = false; error.textContent = ''; paint();
    try {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) }); if (before !== null) query.set('before', String(before));
      const value = await api(`/api/automation/completion/workers?${query}`, { signal: controller.signal });
      if (!owns() || generation !== epoch) return;
      if (!validPage(value, before)) throw new Error('Worker 分页读面不完整或版本不兼容');
      pages[target] = buildPage(value, before); pages.splice(target + 1); index = target;
    } catch (failure) {
      if (owns() && generation === epoch && failure.name !== 'AbortError') error.textContent = `Worker／记录读取失败：${failure.message}；保留已读取页面，不推断无记录。`;
    } finally {
      requests.delete(controller);
      // The parent retains inactive feature nodes. Release bookkeeping without
      // painting them; re-read discarded results when this feature owns the page again.
      if (generation === epoch) { busy = false; resumeRead = !owns(); paint(); }
    }
  }
  async function switchPage(target) {
    if (!owns() || busy || editing > 0 || target < 0 || target > index + 1) return;
    if (pages[target]) { index = target; error.textContent = ''; paint(); }
    else if (pages[index]?.has_more) await readPage(target, pages[index].cursor);
  }
  root.setSubpage = nextSubpage => {
    if (!owns()) return root.ready;
    subpage = nextSubpage === 'history' ? 'history' : 'settings'; paint();
    const pending = [];
    if (resumeRead && !busy && editing === 0) pending.push(readPage(index, pages[index]?.before ?? null));
    if (resumeCatalogue && !cataloguePending) pending.push(loadCatalogue());
    if (pending.length) root.ready = Promise.all(pending);
    return root.ready;
  };
  root.updateCatalogue = value => { if (owns()) { catalogue = value; resumeCatalogue = false; paintDefaults(value); } };
  root.dispose = () => {
    if (disposed) return;
    disposed = true; epoch++;
    for (const controller of requests) controller.abort(); requests.clear();
    for (const page of pages) for (const node of page.workerNode.querySelectorAll('button')) node.onclick = null;
    for (const node of root.querySelectorAll('button')) node.onclick = null;
    pages.length = 0;
  };
  function loadCatalogue() {
    if (!owns() || catalogue) return Promise.resolve();
    if (cataloguePending) return cataloguePending;
    const controller = new AbortController(); requests.add(controller); resumeCatalogue = false;
    cataloguePending = (async () => {
      try { const value = await api('/api/hooks', { signal: controller.signal }); if (owns() && !catalogue) { catalogue = value; paintDefaults(value); } }
      catch (failure) { if (owns() && !catalogue && failure.name !== 'AbortError') paintDefaults(null, failure.message); }
      finally { requests.delete(controller); cataloguePending = null; resumeCatalogue = !owns() && !catalogue; }
    })();
    return cataloguePending;
  }
  paintDefaults(catalogue); paint();
  root.ready = Promise.all([readPage(0, null), catalogue ? Promise.resolve() : loadCatalogue()]);
  return root;
}
