import { api } from './api.js';
import { el } from './dom.js';
import { agentHelp } from './help.js';
import { projectHref } from './route.js';
import { workerLabel } from './worker-label.js';

// Session-local drafts, scoped by document and registered project identity. Never copy project input.
const documents = new WeakMap();
export function createProjectOrderForm(row, { ownsPage = () => true } = {}) {
  if (!/^[a-f0-9]{16}$/.test(row?.id)) throw new Error('项目身份无效');
  const owner = document, projectId = row.id;
  let drafts = documents.get(owner); if (!drafts) documents.set(owner, drafts = new Map());
  let state = drafts.get(projectId);
  if (!state) drafts.set(projectId, state = { content: '', edit: 0, pending: false, message: '', result: null, error: false });
  const root = el('form', undefined, 'project-order-form');
  const label = el('label', `向 ${row.name || '此项目'} 发送新指令`);
  const input = el('textarea'); input.rows = 3; input.value = state.content;
  input.setAttribute('aria-label', `${row.name || '项目'}的新 Worker 指令`);
  input.placeholder = '描述这个独立 Worker 要完成的工作'; label.append(input);
  const status = el('div', undefined, 'project-order-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = el('div', undefined, 'project-order-actions');
  const create = el('button', '创建 Worker', 'primary'); create.type = 'button'; create.onclick = () => submit(false);
  create.setAttribute('data-help', '在此项目的 main 下创建独立 Worker，留待你开始；不调用 Agent。');
  const start = el('button', '创建并开始', 'primary agent-call'); start.type = 'button'; start.onclick = () => submit(true);
  start.setAttribute('data-help', agentHelp('向这个项目后台发送新指令，在 main 下创建并开始独立 Worker。'));
  const hosts = [create, start].map(control => { const host = el('span', undefined, 'help-host'); host.append(control); actions.append(host); return host; });
  root.append(label, el('p', '父 Worker 固定为 main；不追加到已有开发 Worker。Enter 换行，点击按钮发送。未发送文字只保留在当前页面会话。', 'hint'), actions, status);
  let currentRow = row;
  const current = () => owner === globalThis.document && ownsPage();
  function paint() {
    if (!current()) return;
    if (input.value !== state.content) input.value = state.content;
    const reason = state.pending ? '指令发送中，请勿重复提交。' : currentRow.running !== true ? '项目后台未运行或当前不可达；请先显式启动或刷新确认。' : !state.content.trim() ? '请先填写新 Worker 的指令。' : '';
    for (const [index, control] of [create, start].entries()) {
      control.disabled = Boolean(reason);
      if (reason) { hosts[index].setAttribute('data-help', reason); hosts[index].setAttribute('tabindex', '0'); }
      else { hosts[index].removeAttribute('data-help'); hosts[index].removeAttribute('tabindex'); }
    }
    status.classList.toggle('error', state.error); status.replaceChildren(el('span', state.message));
    if (state.result) {
      const link = el('a', `查看 Worker ${workerLabel(state.result)}`, 'ghost');
      link.href = projectHref(projectId, `/#worker-${state.result.id}`); link.target = '_blank'; link.rel = 'noopener'; status.append(link);
    }
  }
  state.paint = paint;
  input.oninput = () => { if (!current()) return; state.content = input.value; state.edit++; paint(); };
  async function submit(startNow) {
    if (!current() || state.pending || currentRow.running !== true || !state.content.trim()) return;
    const content = state.content, edit = state.edit;
    state.pending = true; state.message = '指令发送中…'; state.error = false; state.result = null; state.paint?.();
    try {
      // Explicit source path: no mutable "current project", no select/start and no retry of writes.
      const result = await api(`/p/${projectId}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'order.submit', params: { content, branch: 'main', start: startNow } }) });
      if (state.edit === edit) state.content = '';
      state.result = Number.isSafeInteger(result?.task?.id) && result.task.id > 0 ? result.task : null;
      state.message = startNow ? '独立 Worker 已创建，已请求开始；可进入项目查看实际运行状态。' : '独立 Worker 已创建，待开始。';
    } catch (error) { state.error = true; state.message = `未确认创建成功：${error.message}。文字已保留，请先核对项目内的 Worker，避免重复创建。`; }
    finally { state.pending = false; state.paint?.(); }
  }
  root.onsubmit = event => event.preventDefault();
  paint();
  return { root, update(next) { if (next.id !== projectId) throw new Error('不能改变指令目标项目'); currentRow = next; paint(); } };
}
