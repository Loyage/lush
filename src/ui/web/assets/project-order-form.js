import { api } from './api.js';
import { el } from './dom.js';
import { agentHelp } from './help.js';
import { projectHref } from './route.js';
import { emissionRequestId } from './emission-form.js';

// Session-local drafts, scoped by document and registered project identity. Never copy project input.
const documents = new WeakMap();
export function createProjectOrderForm(row, { ownsPage = () => true } = {}) {
  if (!/^[a-f0-9]{16}$/.test(row?.id)) throw new Error('项目身份无效');
  const owner = document, projectId = row.id;
  let drafts = documents.get(owner); if (!drafts) documents.set(owner, drafts = new Map());
  let state = drafts.get(projectId);
  if (!state) drafts.set(projectId, state = { content: '', edit: 0, pending: false, message: '', result: null, error: false, requestId: null, requestContent: null });
  const root = el('form', undefined, 'project-order-form');
  const label = el('label', `在 ${row.name || '此项目'} 新建工作`);
  const input = el('textarea'); input.rows = 3; input.value = state.content;
  input.setAttribute('aria-label', `${row.name || '项目'}的工作指令正文`);
  input.placeholder = '描述你希望新 Worker 完成的工作…'; label.append(input);
  const status = el('div', undefined, 'project-order-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = el('div', undefined, 'project-order-actions');
  const create = el('button', '提交指令', 'primary agent-call'); create.type = 'button'; create.onclick = submit;
  create.setAttribute('data-help', agentHelp('提交工作指令并可靠保存执行授权，基于此项目 main 创建新 Worker；安全准入后才创建并开始，不保证立即出现在工作树。'));
  const hosts = [create].map(control => { const host = el('span', undefined, 'help-host'); host.append(control); actions.append(host); return host; });
  root.append(label, el('p', '去向：新 Worker · 基于 main；不追加到已有 Worker。Enter 换行，点击按钮提交。未提交文字只保留在当前页面会话，不是持久草稿。', 'hint'), actions, status);
  let currentRow = row;
  const current = () => owner === globalThis.document && ownsPage();
  function paint() {
    if (!current()) return;
    if (input.value !== state.content) input.value = state.content;
    const reason = state.pending ? '工作指令提交中，请勿重复提交。' : currentRow.running !== true ? '项目后台未运行或当前不可达；请先显式启动或刷新确认。' : !state.content.trim() ? '请先填写工作指令。' : '';
    for (const [index, control] of [create].entries()) {
      control.disabled = Boolean(reason);
      if (reason) { hosts[index].setAttribute('data-help', reason); hosts[index].setAttribute('tabindex', '0'); }
      else { hosts[index].removeAttribute('data-help'); hosts[index].removeAttribute('tabindex'); }
    }
    status.classList.toggle('error', state.error); status.replaceChildren(el('span', state.message));
    if (state.result) {
      const link = el('a', '查看提交状态', 'ghost');
      link.href = projectHref(projectId, `/#input-draft-${state.result.draft_id}`); link.target = '_blank'; link.rel = 'noopener'; status.append(link);
    }
  }
  state.paint = paint;
  input.oninput = () => { if (!current()) return; state.content = input.value; state.edit++; paint(); };
  async function submit() {
    if (!current() || state.pending || currentRow.running !== true || !state.content.trim()) return;
    const content = state.content, edit = state.edit;
    if (state.requestContent !== content) { state.requestContent = content; state.requestId = emissionRequestId(); }
    state.pending = true; state.message = '工作指令提交中…'; state.error = false; state.result = null; state.paint?.();
    try {
      // Explicit source path: no mutable "current project", no select/start and no retry of writes.
      const result = await api(`/p/${projectId}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'input.emit', params: { content, branch: 'main', client_request_id: state.requestId } }) });
      if (result?.emitted !== true || !Number.isSafeInteger(result.draft_id)) throw new Error('缺少可靠挂载收据，请核对后台版本与历史输入');
      if (state.edit === edit) state.content = '';
      state.result = Number.isSafeInteger(result?.draft_id) && result.draft_id > 0 ? result : null;
      state.message = '工作指令已提交，基于 main 创建新 Worker；等待安全准入，尚不代表 Worker 已创建或开始。';
      state.requestContent = null;
    } catch (error) { state.error = true; state.message = `未确认提交成功：${error.message}。文字已保留；先核对项目内提交状态，同一请求重试使用原身份。`; }
    finally { state.pending = false; state.paint?.(); }
  }
  root.onsubmit = event => event.preventDefault();
  paint();
  return { root, update(next) { if (next.id !== projectId) throw new Error('不能改变指令目标项目'); currentRow = next; paint(); } };
}
