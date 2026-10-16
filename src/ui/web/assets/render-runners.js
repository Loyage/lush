import { api } from './api.js';
import { $, el } from './dom.js';
import { ui } from './state.js';
import { activateDetailView } from './sidebar-ui.js';
import { pageModules, replacePageContent } from './page-modules.js';
import { RUNNERS_PAGE, runnersHash } from './runner-page-route.js';
import { renderRunnerSettings } from './runner-settings.js';
import { runnerButton } from './runner-settings-controls.js';

/** Device facts stay in the existing editor; project policy always belongs to its source daemon. */
export function openRunners({ projectId = '', push = true, client, projectClient,
  readProjects = () => api('/api/host/projects', { signal: AbortSignal.timeout(10000) }) } = {}) {
  const view = activateDetailView({ view: RUNNERS_PAGE, hash: runnersHash(projectId), push });
  if (ui.runnersPage?.view === view) return ui.runnersPage.showProject(projectId);
  const owner = globalThis.document, ownerWindow = globalThis.window;
  let disposed = false, rosterEpoch = 0, projectEpoch = 0, selectedId = projectId, projects = null;
  let projectEditor = null, projectObserver = null, activeSource = '', mounting = false, loading = false;
  const current = () => !disposed && owner === globalThis.document && ui.view === view;
  const root = el('div', undefined, 'runners-page');
  const device = renderRunnerSettings({ ownsPage: current, ...(client ? { client } : {}) });
  const grants = el('section', undefined, 'block runners-projects');
  const heading = el('div', undefined, 'section-title'); heading.append(el('h2', '项目授权与默认节点'));
  const tools = el('div', undefined, 'runner-actions');
  const label = el('label', undefined, 'runner-field'), select = el('select'); select.setAttribute('aria-label', '来源项目');
  label.append(el('span', '选择已登记项目'), select);
  const refresh = runnerButton('刷新项目状态', loadProjects);
  tools.append(label, refresh.host);
  const source = el('p', '', 'runners-project-source');
  // Status is outside the fold, so offline/failed/removed sources never disappear with the form.
  const status = el('p', '', 'runner-feedback'); status.setAttribute('role', 'status');
  const issues = el('p', '', 'error runners-project-issues'); issues.setAttribute('role', 'alert'); issues.hidden = true;
  const slot = el('div', undefined, 'runners-project-editor');
  grants.append(heading, el('p', '只读取已登记项目，不启动后台。授权与未来 Worker 默认节点由所选项目保存；设备启用不等于授权。', 'hint'), tools, source, slot);
  root.append(device.root, status, issues, grants); replacePageContent($('detail'), root);
  const [module] = pageModules(root, { scope: RUNNERS_PAGE, entries: [{ section: grants, key: 'project-policy', mode: 'fold' }] });
  module.setExpanded(Boolean(projectId), false);

  function clearProject() {
    ++projectEpoch; projectObserver?.disconnect(); projectObserver = null;
    projectEditor?.dispose(); projectEditor = null; activeSource = ''; mounting = false; slot.replaceChildren();
    issues.textContent = ''; issues.hidden = true;
  }
  function feedback(text, error = false) {
    status.textContent = text; status.className = `runner-feedback${error ? ' error' : ''}`; status.hidden = !text;
  }
  async function mountProject() {
    if (!current()) return;
    const row = projects?.find(row => row.id === selectedId);
    source.textContent = row ? `来源项目：${row.name || '未命名项目'} · Host ID：${row.id}` : selectedId ? `来源项目 Host ID：${selectedId}（未确认登记）` : '尚未选择来源项目';
    if (!selectedId) { clearProject(); feedback('选择来源项目后才读取授权。'); return; }
    if (!row || row.running !== true || row.error) {
      clearProject(); feedback(!row ? '所选项目未登记或列表尚未确认；不能编辑授权。' : '所选项目未运行或不可达；不能编辑授权，不会自动启动。请显式刷新项目状态。', true); return;
    }
    feedback('');
    // Refreshing the roster must not rebuild a still-valid editor or discard unsaved fields.
    if (activeSource === selectedId && (projectEditor || mounting)) return;
    clearProject(); activeSource = selectedId; mounting = true;
    const epoch = projectEpoch, id = selectedId;
    const ownsPage = () => current() && epoch === projectEpoch && selectedId === id;
    slot.textContent = '正在读取来源项目授权…';
    try {
      const { renderRunnerProjectSettings } = await import('./runner-project-settings.js');
      if (!ownsPage()) return;
      projectEditor = renderRunnerProjectSettings(id, { ownsPage, ...(projectClient ? { client: projectClient(id) } : {}) });
      const editor = projectEditor;
      const syncIssues = () => {
        if (!ownsPage()) return;
        const messages = [...new Set([...editor.root.querySelectorAll('.error')].filter(node => !node.hidden).map(node => node.textContent.trim()).filter(Boolean))];
        issues.textContent = messages.length ? `${row.name || '未命名项目'} · ${id}：${messages.join('；')}` : ''; issues.hidden = !messages.length;
      };
      slot.replaceChildren(editor.root);
      if (typeof MutationObserver === 'function') {
        projectObserver = new MutationObserver(syncIssues);
        projectObserver.observe(editor.root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden'] });
      }
      await editor.ready; syncIssues();
    } catch { if (ownsPage()) { slot.replaceChildren(); feedback('来源项目授权暂不可用；请重新选择或刷新，不会启动项目后台。', true); activeSource = ''; } }
    finally { if (ownsPage()) mounting = false; }
  }
  function paintOptions() {
    const entries = [el('option', '请选择来源项目')]; entries[0].value = '';
    for (const row of projects || []) {
      const option = el('option', `${row.name || '未命名项目'} · ${row.id}${row.running === true && !row.error ? '' : ' · 未运行或不可达'}`); option.value = row.id; entries.push(option);
    }
    if (selectedId && !projects?.some(row => row.id === selectedId)) { const option = el('option', `${selectedId} · 未登记或未确认`); option.value = selectedId; entries.push(option); }
    select.replaceChildren(...entries); select.value = selectedId;
  }
  async function loadProjects() {
    if (!current() || loading) return;
    const epoch = ++rosterEpoch; loading = true; refresh.disable(true);
    try {
      const result = await readProjects();
      if (!current() || epoch !== rosterEpoch) return;
      if (!Array.isArray(result?.projects)) throw new Error('invalid project roster');
      projects = result.projects; paintOptions(); await mountProject();
    } catch {
      if (current() && epoch === rosterEpoch) {
        projects = null; clearProject(); paintOptions();
        feedback('项目列表读取失败；不能确认来源或编辑授权。不会启动后台，请显式刷新。', true);
      }
    } finally { if (current() && epoch === rosterEpoch) { loading = false; refresh.disable(false); } }
  }
  function showProject(id) {
    if (!current()) return;
    if (selectedId !== id) { clearProject(); selectedId = id; paintOptions(); }
    if (id) module.setExpanded(true, false);
    if (!projects && (id || module.expanded)) return loadProjects();
    if (projects) return mountProject();
  }
  select.onchange = () => {
    if (!current()) return;
    selectedId = select.value; clearProject();
    ownerWindow?.history?.pushState?.(null, '', runnersHash(selectedId));
    return mountProject();
  };
  const unwatch = module.onChange(() => { if (module.expanded && !projects) void loadProjects(); });
  function dispose() {
    if (disposed) return;
    disposed = true; ++rosterEpoch; clearProject(); device.dispose(); unwatch();
    ownerWindow?.removeEventListener?.('pagehide', dispose);
    if (ui.runnersPage?.view === view) ui.runnersPage = null;
  }
  ui.runnersPage = { view, showProject, dispose }; ui.disposeRunnersPage = dispose;
  ownerWindow?.addEventListener?.('pagehide', dispose);
  paintOptions(); feedback('');
  return Promise.all([device.ready, projectId ? loadProjects() : undefined]);
}
