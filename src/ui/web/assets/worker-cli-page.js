import { $, el } from './dom.js';
import { api, projectApi } from './api.js';
import { ui } from './state.js';
import { activateDetailView } from './sidebar-ui.js';
import { projectBase } from './route.js';
import { workerNumber } from './format.js';
import { detailWorkerCli, disposeWorkerCli } from './worker-cli-detail.js';

let active = null;
function disposePage() {
  active?.reads.abort();
  active = null;
  disposeWorkerCli();
}

/** Reloadable, project-scoped destination. No CLI requests occur merely by opening it. */
export async function openWorkerCliPage({ taskId }) {
  const view = activateDetailView({ view: 'worker-cli', key: `worker-cli-${taskId}`, title: 'CLI 交互',
    hint: '单次 Lush 命令 · 当前登录用户真实执行', push: false });
  const owner = document, endpoint = projectApi('/api/'), boot = ui.workerNumbers, hash = location.hash;
  const reusable = active?.view === view && active.owner === owner && active.endpoint === endpoint && active.boot === boot;
  if (!reusable) disposePage();
  else active.reads.abort();
  const entry = { view, owner, endpoint, boot, reads: new AbortController(), node: reusable ? active.node : null };
  active = entry; ui.disposeWorkerCli = disposePage;
  const current = () => active === entry && document === owner && ui.view === view && ui.workerNumbers === boot
    && projectApi('/api/') === endpoint && location.hash === hash && !entry.reads.signal.aborted;
  const back = el('a', '返回 Worker 详情', 'nav-link nav-back'); back.href = `${projectBase()}/#worker-${taskId}`;
  const box = el('div', undefined, 'worker-cli-page'), header = el('header', undefined, 'worker-cli-page-header');
  const title = el('h1', 'CLI 交互'); header.append(title, back); box.append(header);
  if (!entry.node) {
    box.append(el('p', '正在读取 Worker…', 'hint'));
    $('detail').replaceChildren(box);
  }
  try {
    const task = await api(`/api/worker/${taskId}`, { signal: entry.reads.signal });
    if (!current()) return;
    if (task?.id !== taskId) throw Error('返回的 Worker 身份不匹配。');
    const node = detailWorkerCli(task);
    title.textContent = `${workerNumber(task)} · CLI 交互`;
    if (node && node === entry.node) return node;
    entry.node = node;
    box.replaceChildren(header, node || el('p', '此 Worker 不支持 CLI 交互；仅本机开发指令或子 Worker 可用。', 'hint'));
    $('detail').replaceChildren(box);
    return node;
  } catch (error) {
    if (!current()) return;
    disposeWorkerCli(); entry.node = null;
    box.replaceChildren(header, el('p', `无法打开 CLI 交互：${error.message}`, 'error'));
    $('detail').replaceChildren(box);
  }
}
