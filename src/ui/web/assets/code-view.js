import { el, button } from './dom.js';
import { api } from './api.js';
import { onPrefChange, pollingIntervals } from './prefs.js';
import { createCodeTree } from './code-tree.js';
import { createCodeFile } from './code-file.js';

const short = value => value ? String(value).slice(0, 10) : '未知';
const aborted = () => Object.assign(new Error('读取已暂停'), { name: 'AbortError' });

/** One Task's opt-in code reader. Probe metadata, never silently replace a selected file. */
export function createCodeView(taskId, { onSearch } = {}) {
  const root = el('section', undefined, 'code-view'); root.setAttribute('aria-label', '代码与改动');
  const toolbar = el('div', undefined, 'code-toolbar');
  const scopeSelect = el('select'); scopeSelect.setAttribute('aria-label', '代码比较范围');
  for (const [value, label] of [['task', 'Worker 累计'], ['iteration', '本次交付'], ['working', '未提交']]) {
    const option = el('option', label); option.value = value; scopeSelect.append(option);
  }
  scopeSelect.value = 'task';
  scopeSelect.setAttribute('data-help', 'Worker 累计从创建基线比较，本次交付从迭代基线比较，未提交从实际 HEAD 比较；右侧均为当前工作区，归档时明确降级。');
  const metadata = el('div', undefined, 'code-snapshot');
  const summaryLine = el('div', '尚未读取代码现场。', 'code-summary');
  const provenance = el('p', '', 'code-provenance');
  const sampling = el('details', undefined, 'code-sample-details');
  const samplingBody = el('p', '', 'hint'); sampling.append(el('summary', '采样详情'), samplingBody);
  sampling.hidden = true;
  const warning = el('p', '', 'code-snapshot-warning'); warning.hidden = true;
  metadata.append(summaryLine, provenance, sampling, warning);
  const refreshButton = button('刷新', () => refresh(), 'ghost', { help: '重新采样当前 Worker 工作区，并显式更新文件列表和选中文件；不会修改文件或调用 Agent。' });
  const toggleFiles = button('收起文件栏', () => {
    const collapsed = root.classList.toggle('code-files-collapsed'); toggleFiles.textContent = collapsed ? '展开文件栏' : '收起文件栏';
    toggleFiles.setAttribute('aria-expanded', String(!collapsed));
  }, 'ghost'); toggleFiles.setAttribute('aria-expanded', 'true');
  toolbar.append(scopeSelect, refreshButton, toggleFiles, metadata);
  const banner = el('div', undefined, 'code-update-banner'); banner.hidden = true;
  const bannerText = el('span'); bannerText.setAttribute('role', 'status');
  const latest = button('加载最新', () => refresh(), 'ghost'); banner.append(bannerText, latest);
  const layout = el('div', undefined, 'code-layout');
  const viewport = el('div', undefined, 'code-viewport'); viewport.tabIndex = 0; viewport.setAttribute('aria-label', '代码文件正文');
  let active = false, disposed = false, generation = 0, timer = null, scope = 'task';
  let snapshot = null, probing = false, refreshPromise = null, refreshGeneration = -1, selected = null;
  const controllers = new Set();
  const visible = () => active && !disposed && document.visibilityState !== 'hidden';
  const cancel = () => { generation++; for (const controller of controllers) controller.abort(); controllers.clear(); };
  async function request(endpoint, params) {
    if (!visible()) throw aborted();
    const token = generation, controller = new AbortController(); controllers.add(controller);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined) query.set(key, String(value));
    try {
      const data = await api(`/api/worker/${taskId}/${endpoint}?${query}`, { signal: controller.signal });
      if (token !== generation || !visible()) throw aborted();
      return data;
    } finally { controllers.delete(controller); }
  }
  function showUpdate(reason) {
    banner.hidden = false; bannerText.textContent = reason
      ? `${reason}${selected ? ' 当前正文仍为上次读取结果；加载最新后继续。' : ''}`
      : '工作区有新变化；保留当前正文与阅读位置，加载最新后继续。';
  }
  const file = createCodeFile({ request, onSearch, onStale: showUpdate, taskId });
  const tree = createCodeTree({ request, onStale: showUpdate, onSelect: async entry => {
    selected = entry.path; viewport.scrollTop = 0; await file.open(entry, snapshot);
  } });
  viewport.append(file.root); layout.append(tree.root, viewport); root.append(toolbar, banner, layout);
  function paintMeta(data) {
    const summary = data.summary || {};
    const current = data.source === 'workspace' ? `当前工作区（HEAD ${short(data.head_commit)}，含未提交）`
      : data.source === 'commit' ? `已提交版本 ${short(data.head_commit)} · 现场不可用` : '无可用现场';
    summaryLine.replaceChildren(...[
      `净变化 ${summary.changed_total ?? '?'} 文件`, `未提交 ${summary.pending_total ?? '?'} 文件`,
      `+${summary.added ?? '?'} −${summary.deleted ?? '?'}`, `冲突 ${summary.conflicts ?? '?'}`,
    ].map(text => el('span', text)));
    provenance.textContent = `基线 ${short(data.base_commit)} → ${current}`;
    sampling.hidden = false;
    samplingBody.textContent = `分支 ${data.branch || '未知'} · 采样 ${data.sampled_at || '未知'}`;
    warning.textContent = [data.truncated ? '范围不完整（达到读取限额）' : '', data.reason || ''].filter(Boolean).join(' · ');
    warning.hidden = !warning.textContent;
  }
  async function probe() {
    if (!visible() || probing || refreshPromise || !snapshot) return;
    probing = true;
    try {
      const data = await request('code-state', { scope, after: 0, limit: 100 });
      if (data.availability !== 'available') { showUpdate(data.reason || '代码现场暂不可读取；保留上次画面。'); return; }
      if (data.revision !== snapshot.revision) showUpdate();
      // Do not relabel the old text with a new sampling timestamp or replace any file/tree node.
    } catch (error) { if (error.name !== 'AbortError') showUpdate(`状态探测失败：${error.message}；当前画面仍是上次采样。`); }
    finally { probing = false; }
  }
  function schedule() {
    if (timer !== null) clearInterval(timer); timer = null;
    if (visible()) timer = setInterval(() => { void probe(); }, pollingIntervals().live);
  }
  async function refresh() {
    if (!visible()) return;
    if (refreshPromise && refreshGeneration === generation) return refreshPromise;
    cancel(); tree.invalidate(); file.invalidate();
    const token = generation; refreshGeneration = token;
    const run = async () => {
      refreshButton.disabled = true;
      try {
        const data = await request('code-state', { scope, after: 0, limit: 100 });
        if (token !== generation) return;
        if (data.availability === 'stale') { showUpdate(data.reason || '采样期间文件发生变化，请重试。'); return; }
        snapshot = data; paintMeta(data); banner.hidden = true;
        if (data.availability !== 'available') showUpdate(data.reason || '此 Worker 没有可读取的代码现场。');
        const scroll = tree.root.querySelector('.code-tree-scroll')?.scrollTop || 0;
        await tree.reset(data);
        if (token !== generation) return;
        const scroller = tree.root.querySelector('.code-tree-scroll'); if (scroller) scroller.scrollTop = scroll;
        if (selected && data.availability === 'available') await file.reload(data);
      } catch (error) {
        if (token === generation && error.name !== 'AbortError') showUpdate(`代码读取失败：${error.message}`);
      } finally { if (token === generation) refreshButton.disabled = false; }
    };
    const pending = run(); refreshPromise = pending;
    try { await pending; } finally { if (refreshPromise === pending) { refreshPromise = null; refreshButton.disabled = false; } }
  }
  scopeSelect.onchange = async () => {
    scope = scopeSelect.value; snapshot = null;
    showUpdate('正在切换比较范围，读取成功后更新。');
    cancel(); refreshPromise = null; await refresh();
  };
  const onVisibility = () => {
    if (!visible()) { cancel(); tree.invalidate(); file.invalidate(); }
    else {
      if (!snapshot) void refresh();
      else { void tree.reset(snapshot); void probe(); void file.resume(); }
    }
    schedule();
  };
  addEventListener('visibilitychange', onVisibility);
  const stopPref = onPrefChange('polling', schedule);
  return {
    root, refresh,
    async setActive(value) {
      active = value;
      if (!active) { cancel(); tree.invalidate(); file.invalidate(); schedule(); return; }
      schedule();
      if (!snapshot) await refresh();
      else {
        // Rebuild only the file index on return; selected code nodes and the viewport remain untouched.
        const token = generation;
        const scroller = tree.root.querySelector('.code-tree-scroll'), top = scroller?.scrollTop || 0;
        await tree.reset(snapshot);
        if (token !== generation || !visible()) return;
        if (scroller) scroller.scrollTop = top;
        await file.resume(); void probe();
      }
    },
    dispose() {
      disposed = true; active = false; cancel(); tree.invalidate(); file.invalidate(); schedule();
      stopPref(); removeEventListener('visibilitychange', onVisibility);
    },
  };
}
