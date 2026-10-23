import { el } from './dom.js';
import { api } from './api.js';
import { projectHref } from './route.js';
import { workerNumber } from './format.js';

// Both pages use the same editor, preview, confirmation, output and history engine.
export function renderCliTrial({ ownsPage, renderWorkerCli, command = '' }) {
  const root = el('section', undefined, 'cli-trial');
  const projectLabel = el('label', '执行项目'), project = el('select'); project.setAttribute('aria-label', '试运行项目'); projectLabel.append(project);
  const workerLabel = el('label', '执行 Worker'), worker = el('select'); worker.setAttribute('aria-label', '试运行 Worker'); workerLabel.append(worker);
  const status = el('p', '请选择在线项目；读取不会启动后台。', 'hint'); status.setAttribute('role', 'status');
  const more = el('button', '读取更多 Worker', 'ghost'); more.type = 'button'; more.hidden = true;
  const editor = el('div');
  root.append(el('h3', '就地试运行'), projectLabel, workerLabel, status, more, editor);
  let disposed = false, generation = 0, panel = null, draft = command, tasks = [], cursor = null, projects = [];
  const current = turn => !disposed && ownsPage() && turn === generation;
  const option = (value, text) => { const node = el('option', text); node.value = String(value); return node; };
  project.append(option('', '请选择在线项目')); worker.append(option('', '请先选择项目')); worker.disabled = true;
  function invalidate() { generation++; if (panel) draft = panel.getDraft(); panel?.dispose(); panel = null; editor.replaceChildren(); }
  async function mount() {
    invalidate(); const turn = generation, projectId = project.value, taskId = Number(worker.value);
    if (!taskId || !projects.some(item => item.id === projectId && item.running === true && !item.error)) return;
    status.textContent = '正在核验 Worker；切换目标不会执行或改写命令参数。';
    try {
      const task = await api(projectHref(projectId, `/api/worker/${taskId}`));
      if (!current(turn)) return;
      if (task.id !== taskId || !['main', 'order', 'child'].includes(task.task_kind)) throw Error('目标 Worker 身份不匹配');
      const request = (method, params) => {
        if (!current(turn) || project.value !== projectId || Number(worker.value) !== taskId) throw Error('执行目标已变化，请重新预检');
        return api(projectHref(projectId, '/api/action'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params: { ...params, id: taskId } }) });
      };
      panel = renderWorkerCli(task, {
        preview: command => request('worker.cli_preview', { command }), execute: params => request('worker.cli_execute', params),
        loadHistory: params => request('worker.cli_history', params), clearHistory: () => request('worker.cli_history_clear', {}),
      });
      panel.setDraft(draft); editor.append(panel);
      status.textContent = '当前登录用户真实执行，非沙箱；模板须补全。正文中的显式目标不会随执行 Worker 切换。';
    } catch (error) { if (current(turn)) status.textContent = `目标不可用：${error.message}`; }
  }
  async function loadWorkers(append = false) {
    if (!append) { invalidate(); tasks = []; cursor = null; worker.replaceChildren(option('', '正在读取 Worker…')); worker.disabled = true; }
    const turn = generation, projectId = project.value;
    if (!projects.some(item => item.id === projectId && item.running === true && !item.error)) { status.textContent = '请选择在线项目；不会启动离线后台。'; return; }
    more.disabled = true;
    try {
      const data = await api(projectHref(projectId, append ? `/api/workers?scope=all&limit=100&before=${encodeURIComponent(cursor)}` : '/api/overview'));
      if (!current(turn)) return;
      if (!Array.isArray(data.tasks)) throw Error('Worker 列表不可用');
      const selected = worker.value;
      for (const task of data.tasks) if (['main', 'order', 'child'].includes(task.task_kind) && !tasks.some(item => item.id === task.id)) tasks.push(task);
      worker.replaceChildren(option('', '请选择 Worker'));
      for (const task of tasks) worker.append(option(task.id, `${task.task_kind === 'main' ? 'main' : workerNumber(task)} · ${task.display_title || task.auto_title || task.status}`));
      worker.disabled = false;
      const page = data.task_page || data; cursor = page.has_more ? page.cursor : null; more.hidden = !cursor;
      status.textContent = cursor ? '列表未列全，可继续读取。' : '已读取可用 Worker。';
      worker.value = append ? selected : String(tasks.find(task => task.task_kind === 'main')?.id || '');
      if (!append && worker.value) await mount();
    } catch (error) { if (current(turn)) status.textContent = `读取失败：${error.message}`; }
    finally { more.disabled = false; }
  }
  project.onchange = () => loadWorkers(); worker.onchange = mount; more.onclick = () => loadWorkers(true);
  root.ready = api('/api/host/projects').then(data => {
    if (disposed || !ownsPage()) return;
    if (!Array.isArray(data.projects)) throw Error('项目列表不可用'); projects = data.projects;
    for (const item of projects) { const node = option(item.id, `${item.name || item.project} · ${item.running === true && !item.error ? '在线' : '离线／未确认'}`); node.disabled = item.running !== true || Boolean(item.error); project.append(node); }
  }).catch(error => { if (!disposed && ownsPage()) status.textContent = `项目读取失败：${error.message}`; });
  root.dispose = () => { if (disposed) return; invalidate(); disposed = true; };
  return root;
}
