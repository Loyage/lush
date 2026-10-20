import { $, el, button } from './dom.js';
import { api } from './api.js';
import { activateDetailView } from './sidebar-ui.js';
import { projectRoute } from './route.js';
import { ui } from './state.js';
import { ADMINISTRATOR_API, ADMINISTRATOR_ROUTES } from '../../../administrator/protocol.js';

const text = value => typeof value === 'string' ? value : '';
const label = worker => text(worker?.worker_number) || `#${worker?.id ?? '未知'}`;
const statusText = value => ({ ready: '历史身份（不可追加）', running: '执行中', stopping: '停止中，尚未确认退出', stopped: '已停止',
  queued: '历史待执行项', succeeded: '已返回', failed: '失败', unknown: '结果未知', cancelled: '已取消' })[value] || '状态未知';
const reading = value => el('pre', text(value), 'administrator-reading');
function originalFailure(parent, value) {
  const error = value?.detail?.error;
  if (!error) return;
  const lines = [value.stage, value.detail.source, error.name, error.code, error.message]
    .filter(item => typeof item === 'string' || typeof item === 'number').map(String);
  if (lines.length) parent.append(el('h3', '最初失败安全证据'), reading(lines.join('\n')));
}

/** D738 legacy bookmark: bounded read/stop only. No new identity, input or confirmation controls. */
export function createAdministratorPage({ container, request = api, isCurrent = () => true } = {}) {
  if (!container) throw new Error('legacy administrator container required');
  const owner = document, pathname = location.pathname, root = el('div', undefined, 'administrator-page');
  container.replaceChildren(root);
  let disposed = false, selected = null, worker = null, before = null, hasMore = false, generation = 0, detailGeneration = 0;
  let workers = [], detailPage = null;
  const reads = new Set(), stopping = new Set(), uncertainStops = new Set();
  const owns = () => !disposed && owner === globalThis.document && pathname === globalThis.location?.pathname && root.parentNode === container && isCurrent();
  const header = el('header', undefined, 'administrator-hero'), status = el('p', '正在只读核对旧服务状态…'), notice = el('p', '', 'administrator-notice');
  header.append(el('h1', '旧全局管理员历史'), el('p', '此入口已退役，只保留历史阅读和安全停止。请在当前项目的管家输入中选择“仅本条提升为管理员权限”，并重新验证 Web 登录密码。', 'administrator-risk'), status,
    button('只读刷新历史', () => load(), 'ghost'));
  try {
    const retained = JSON.parse(globalThis.sessionStorage?.getItem('lush.administrator.unconfirmed.v1') || '[]');
    if (Array.isArray(retained) && retained.length) header.append(el('p', `本页会话仍保留 ${retained.length} 条旧提交未知证据；不会自动重发、删除或转为新项目授权。`, 'warn'));
  } catch { /* Malformed old evidence never becomes an authorization. */ }
  const list = el('section', undefined, 'administrator-card'), rows = el('div', undefined, 'administrator-rows');
  const more = button('读取更早的历史身份', () => load(true), 'ghost'); more.hidden = true;
  list.append(el('h2', '历史身份'), rows, more);
  const detail = el('div', undefined, 'administrator-detail'); root.append(header, notice, list, detail);
  const report = (message, error = false) => { if (owns()) { notice.textContent = message; notice.classList.toggle('error', error); } };
  async function read(kind, params = {}) {
    const controller = new AbortController(); reads.add(controller);
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]));
    try { return await request(`${ADMINISTRATOR_API}/${ADMINISTRATOR_ROUTES[kind]}${query.size ? `?${query}` : ''}`, { signal: controller.signal }); }
    finally { reads.delete(controller); }
  }
  function paintList() {
    rows.replaceChildren();
    for (const item of workers) {
      const row = button(`${label(item)} · ${text(item.name)} · ${statusText(item.status)}`, () => select(item.id), 'ghost administrator-row');
      row.setAttribute('aria-pressed', String(selected === item.id)); rows.append(row);
    }
    more.hidden = !hasMore;
  }
  function paintDetail() {
    detail.replaceChildren();
    if (!worker) return;
    const summary = el('section', undefined, 'administrator-card administrator-summary');
    summary.append(el('h2', `${label(worker)} · ${text(worker.name)}`), el('p', '旧全局管理员 · 只读，不可创建或追加', 'administrator-identity'), el('p', statusText(worker.status)));
    if (worker.error) summary.append(reading(worker.error));
    originalFailure(summary, worker.original_failure);
    summary.append(el('p', '停止不会回滚已发生的副作用；unknown 不代表成功，也不能作为重放依据。', 'warn'));
    const stop = button('安全停止旧管理员', () => stopWorker(worker.id), 'danger', { help: '请求停止这个旧身份并撤销未执行授权；保留历史，stopping 不代表真实退出，不重放未知操作。' });
    stop.disabled = stopping.has(worker.id) || uncertainStops.has(worker.id) || ['stopping', 'stopped', 'cancelled'].includes(worker.status);
    const host = el('span', undefined, 'help-host'); host.append(stop);
    if (stop.disabled) { host.dataset.help = uncertainStops.has(worker.id) ? '停止结果未知，请只读核对，不自动重发。' : '已停止或正在收尾，请只读核对真实状态。'; host.tabIndex = 0; }
    summary.append(host); detail.append(summary);
    const result = el('section', undefined, 'administrator-card'); result.append(el('h2', '历史结果'), reading(worker.result || '本页没有已返回结果，不代表从未执行。')); detail.append(result);
    const execution = el('section', undefined, 'administrator-card'); execution.append(el('h2', '已读取的输入与执行记录'));
    for (const item of detailPage?.instructions || []) {
      execution.append(el('h3', `指令 ${item.id} · ${statusText(item.status)}`), reading(item.instruction));
      if (item.error) execution.append(reading(item.error)); originalFailure(execution, item.original_failure);
    }
    detail.append(execution);
    const audit = el('details'); audit.append(el('summary', '历史审计（按需展开）'));
    for (const event of detailPage?.events || []) audit.append(el('p', `${event.id} · ${text(event.type)} · ${text(event.created_at)}`, 'mono'));
    if (detailPage?.coverage) audit.append(el('p', text(detailPage.coverage), 'hint'));
    detail.append(audit);
    if (detailPage?.has_more) detail.append(button('读取更早的详情', () => loadDetail(true), 'ghost'));
  }
  async function load(append = false) {
    const current = ++generation;
    try {
      const service = await read('status'); if (!owns() || current !== generation) return;
      if (service?.version !== 1 || typeof service.online !== 'boolean') throw new Error('历史服务状态不兼容');
      status.textContent = !service.online ? '旧历史服务未运行；读取不会启动它，也不能据此判断没有历史。'
        : service.retired ? '旧管理员历史服务在线，不会启动模型或接受新指令。' : '旧版服务仍在线；页面已禁止新输入，请由用户在安全点停止并更新旧服务。';
      if (!service.online) return;
      const page = await read('list', { before: append ? before : null, limit: 30 });
      if (!owns() || current !== generation) return;
      if (!Array.isArray(page.items) || typeof page.has_more !== 'boolean') throw new Error('历史列表不完整');
      workers = append ? [...new Map([...workers, ...page.items].map(item => [item.id, item])).values()] : page.items;
      before = page.next_cursor; hasMore = page.has_more; paintList();
      if (selected && !append) await loadDetail();
    } catch (error) { report(`历史读取未确认：${error.message}；不启动、不重发旧工作。`, true); }
  }
  async function select(id) { selected = id; worker = null; detailPage = null; paintList(); paintDetail(); return loadDetail(); }
  async function loadDetail(append = false) {
    const id = selected, current = ++detailGeneration;
    if (!id || !owns()) return;
    try {
      const page = await read('detail', { id, before: append ? detailPage?.next_cursor : null, limit: 30 });
      if (!owns() || selected !== id || current !== detailGeneration) return;
      if (page.worker?.id !== id || !Array.isArray(page.instructions) || !Array.isArray(page.events)) throw new Error('历史详情不完整');
      if (append) {
        page.instructions = [...new Map([...detailPage.instructions, ...page.instructions].map(item => [item.id, item])).values()];
        page.events = [...new Map([...detailPage.events, ...page.events].map(item => [item.id, item])).values()];
      }
      worker = page.worker; detailPage = page;
      if (['stopping', 'stopped', 'cancelled'].includes(worker.status)) uncertainStops.delete(id);
      paintDetail();
    } catch (error) { report(`详情读取未确认：${error.message}；不能当作已停止或没有副作用。`, true); }
  }
  async function stopWorker(id) {
    if (!owns() || stopping.has(id) || uncertainStops.has(id)) return;
    stopping.add(id); paintDetail();
    try {
      const result = await request(`${ADMINISTRATOR_API}/${ADMINISTRATOR_ROUTES.stop}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      if (!owns() || selected !== id) return;
      if (result.worker?.id !== id) throw new Error('未获得停止收据');
      worker = result.worker;
      report(worker.status === 'stopping' ? '已请求停止，仍等待真实退出。' : '停止请求已返回；历史原错与未知副作用保留。');
      await loadDetail();
    } catch (error) { uncertainStops.add(id); report(`停止结果未知：${error.message}；不自动重发，请只读核对。`, true); }
    finally { stopping.delete(id); if (owns()) paintDetail(); }
  }
  const ready = load();
  return { root, ready, refresh: () => load(), select, dispose() { disposed = true; for (const controller of reads) controller.abort(); reads.clear(); } };
}
let page = null, pageView = null, pageOwner = null;
export function disposeAdministratorPage() { page?.dispose(); page = pageView = pageOwner = null; }
export function refreshAdministratorPage() { return page?.refresh() || Promise.resolve(); }
export function openAdministrator({ push = true, request = api } = {}) {
  if (projectRoute()) throw new Error('旧全局管理员历史在独立用户工作台打开');
  const view = activateDetailView({ view: 'administrator', title: '旧全局管理员历史', context: '用户工作台', hint: '只读与安全停止 · 新工作使用项目管家密码提权', hash: '#administrator', push });
  if (page && pageView === view && pageOwner === document && page.root.parentNode === $('detail')) return page.refresh();
  disposeAdministratorPage();
  page = createAdministratorPage({ container: $('detail'), request, isCurrent: () => ui.view === view }); pageView = view; pageOwner = document;
  return page.ready;
}
