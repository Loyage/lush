import { el } from './dom.js';
import { workerNumber } from './format.js';
import { formDialog, closeDialog } from './dialog.js';
import { agentHelp } from './help.js';

const present = value => typeof value === 'string' && value.trim().length > 0;
const errorText = error => error?.message || String(error);

/** Standalone UI: the adapter owns the fixed Worker id and authenticated user API.
 * No cwd, environment, credentials, shell or backend imports belong in this module.
 * Reuse update() for page refresh; call dispose() before removing the node.
 */
export function renderWorkerCli(initialTask, { preview, execute } = {}) {
  const root = el('section', undefined, 'worker-cli');
  root.setAttribute('aria-label', 'CLI 交互');
  const body = el('div', undefined, 'worker-cli-body'); root.append(body);
  const identity = el('div', undefined, 'worker-cli-identity');
  const worker = el('strong'), workspace = el('code', undefined, 'worker-cli-workspace');
  identity.append(worker, workspace);
  body.append(identity, el('p', '以当前登录用户身份真实执行，不是沙箱，也不借用 Worker 的 Agent token。', 'worker-cli-warning'));
  const unavailable = el('p', undefined, 'worker-cli-unavailable'); unavailable.setAttribute('role', 'status');
  body.append(unavailable);
  const row = el('div', undefined, 'worker-cli-controls');
  const label = el('label', undefined, 'worker-cli-field'); label.append(el('span', '单次 Lush 命令'));
  const input = el('textarea', undefined, 'worker-cli-input'); input.rows = 2; input.placeholder = 'lush status';
  input.setAttribute('aria-label', '单次 Lush 命令'); input.spellcheck = false;
  input.setAttribute('aria-keyshortcuts', 'Control+Enter');
  const shortcut = el('span', 'Ctrl+Enter 执行 · 有副作用的命令仍需确认', 'worker-cli-shortcut');
  label.append(input, shortcut);
  const runHost = el('span', undefined, 'help-host');
  const run = el('button', '执行', 'worker-cli-run'); run.type = 'button';
  run.dataset.help = '先预览命令与真实工作目录；有副作用或调用 Agent 时确认后才执行，不会自动重试。';
  runHost.append(run); row.append(label, runHost); body.append(row);
  const status = el('p', '', 'worker-cli-status'); status.setAttribute('role', 'status'); body.append(status);

  const advanced = el('details', undefined, 'worker-cli-advanced');
  advanced.append(el('summary', '示例、限制与选项'));
  const examples = el('div', undefined, 'worker-cli-examples'); advanced.append(examples);
  advanced.append(el('p', '示例只填入命令，不执行。仅支持单次 Lush CLI 命令，不是交互式终端；不支持任意 shell、管道或重定向。目录、环境与身份由服务端固定，不能在此选择。'));
  advanced.append(el('p', '输出、耗时和执行上限以服务端返回为准。超时、信号、截断或连接中断不代表命令没有产生副作用；结果未知时请先核查，勿盲目再次执行。'));
  const result = el('section', undefined, 'worker-cli-result'); result.hidden = true;
  result.setAttribute('aria-label', 'CLI 执行结果');
  const resultMeta = el('p', undefined, 'worker-cli-result-meta');
  const resultCommand = el('pre', undefined, 'worker-cli-result-command');
  const stdout = el('pre', undefined, 'worker-cli-output'); stdout.setAttribute('aria-label', 'stdout');
  const stderr = el('pre', undefined, 'worker-cli-output'); stderr.setAttribute('aria-label', 'stderr');
  result.append(el('h3', '执行结果'), resultCommand, resultMeta, el('h4', 'stdout'), stdout, el('h4', 'stderr'), stderr); body.append(result, advanced);

  let task, disposed = false, busy = false, generation = 0, draftVersion = 0, confirmation = null;
  const exampleHandlers = [];
  function reason() {
    if (disposed) return '页面已离开，请重新打开 CLI 交互。';
    if (!['order', 'child'].includes(task?.task_kind) || task?.execution_retired === true) return '仅本机开发指令或子 Worker 可以使用 CLI 交互。';
    if (!Number.isSafeInteger(task?.id) || task.id <= 0) return 'Worker 身份不可用。';
    if (!present(task?.workspace)) return 'Worker 工作区不存在或不可用；不会回落到项目目录。';
    if (typeof preview !== 'function' || typeof execute !== 'function') return 'CLI 执行接口尚未连接。';
    return '';
  }
  function sync() {
    const disabledReason = reason();
    unavailable.textContent = disabledReason; unavailable.hidden = !disabledReason;
    input.disabled = Boolean(disabledReason);
    run.disabled = Boolean(disabledReason) || busy || !input.value.trim();
    const help = disabledReason || (busy ? '命令请求在途，不会重复提交；仍可编辑下一条命令草稿。' : !input.value.trim() ? '请先输入一条 Lush 命令。' : '');
    if (run.disabled) { runHost.dataset.help = help; runHost.setAttribute('tabindex', '0'); }
    else { delete runHost.dataset.help; runHost.removeAttribute('tabindex'); }
  }
  function dismissConfirmation() {
    // Never close a replacement dialog owned by another feature.
    if (confirmation && document.getElementById('modal')?.querySelector('.worker-cli-confirm') === confirmation) closeDialog();
    confirmation = null;
  }
  function edited() {
    draftVersion++;
    if (confirmation) { dismissConfirmation(); status.textContent = '命令已修改，旧预览未执行；请重新执行以预览新命令。'; }
    sync();
  }
  function clearResult() { result.hidden = true; resultMeta.textContent = ''; resultCommand.textContent = ''; stdout.textContent = ''; stderr.textContent = ''; }
  function fillExamples() {
    for (const [node, handler] of exampleHandlers.splice(0)) node.removeEventListener('click', handler);
    examples.replaceChildren();
    // This is deliberately not a second CLI catalog: only three fixed starter commands.
    for (const command of ['lush help', 'lush status', `lush worker inspect ${task.worker_number || task.id}`]) {
      const node = el('button', `填入 ${command}`, 'ghost'); node.type = 'button';
      const handler = () => { if (disposed || reason()) return; input.value = command; edited(); input.focus(); };
      node.addEventListener('click', handler); exampleHandlers.push([node, handler]); examples.append(node);
    }
  }
  async function submit() {
    if (busy || reason() || !input.value.trim()) return;
    const command = input.value, id = task.id, version = draftVersion, turn = ++generation;
    const current = () => !disposed && generation === turn && task.id === id;
    const unchanged = () => current() && draftVersion === version && input.value === command && !reason();
    busy = true; sync(); status.textContent = '正在预览，尚未执行…';
    let started = false, executionWorkspace = '';
    try {
      const plan = await preview(command);
      if (!current()) return;
      if (!unchanged()) { status.textContent = '命令已修改，旧预览未执行；请重新执行。'; return; }
      if (plan?.id !== id || plan.command !== command || !present(plan.workspace) || !present(plan.revision)
        || typeof plan.requires_confirmation !== 'boolean' || !present(plan.kind)
        || !Array.isArray(plan.argv) || plan.argv.some(arg => typeof arg !== 'string') || !present(plan.executable) || !present(plan.path)) {
        throw Error('预览返回的 Worker、命令或执行信息无效。');
      }
      workspace.textContent = plan.workspace;
      const agent = plan.kind === 'agent';
      const needsConfirmation = plan.requires_confirmation || agent;
      if (needsConfirmation) {
        const content = el('div', undefined, 'worker-cli-confirm'); confirmation = content;
        content.append(el('p', `${workerNumber(task)} · 当前登录用户 · 真实执行，不是沙箱。`));
        const consequence = agent ? '将提交或唤醒 Agent 工作，并可能修改项目与持久状态。'
          : '将执行有副作用的 Lush 操作，可能修改文件、项目状态、Worker 或资源；这不是只读预览。';
        content.append(el('p', consequence));
        content.append(el('pre', `命令：${plan.command}\n目录：${plan.workspace}\n执行程序：${plan.executable}\n命令路径：${plan.path}\n参数：${JSON.stringify(plan.argv)}\n分类：${plan.kind}`, 'worker-cli-confirm-detail'));
        status.textContent = '等待确认，尚未执行；修改草稿会取消本次执行。';
        const accepted = await formDialog({ title: '确认真实 CLI 执行', content, confirmLabel: agent ? '确认并调用 Agent' : '确认执行',
          agent, confirmHelp: agent ? agentHelp(consequence) : consequence, canConfirm: unchanged });
        if (confirmation === content) confirmation = null;
        if (!current()) return;
        if (!unchanged()) { status.textContent = '命令或工作区已变化，旧预览未执行；请重新预览。'; return; }
        if (!accepted) { status.textContent = '已取消，未执行。'; return; }
      }
      if (!unchanged()) return;
      started = true; executionWorkspace = plan.workspace; clearResult();
      result.hidden = false;
      resultCommand.textContent = `命令：${command}\n目录：${plan.workspace}`;
      resultMeta.textContent = '正在真实执行，等待输出…';
      status.textContent = '正在真实执行，请勿重复提交…';
      const outcome = await execute({ command, revision: plan.revision, confirm: needsConfirmation });
      if (!current()) return;
      result.hidden = false;
      resultCommand.textContent = `命令：${command}\n目录：${outcome?.workspace || plan.workspace}`;
      stdout.textContent = String(outcome?.stdout ?? ''); stderr.textContent = String(outcome?.stderr ?? '');
      const unknown = !['succeeded', 'failed'].includes(outcome?.status);
      const succeeded = !unknown && outcome.status === 'succeeded' && outcome.exit_code === 0 && !outcome.signal && !outcome.timed_out;
      const summary = unknown ? '结果未知，请先核查真实状态；不会自动重试。' : succeeded ? '执行成功。' : '执行失败，不是成功。';
      const diagnostics = [`退出码：${outcome?.exit_code ?? '未知'}`, `耗时：${outcome?.duration_ms ?? '未知'} ms`];
      if (outcome?.signal) diagnostics.push(`信号：${outcome.signal}`);
      if (outcome?.timed_out) diagnostics.push('已超时，可能已有副作用');
      if (outcome?.truncated) diagnostics.push('输出已截断，并非完整输出');
      resultMeta.textContent = `${summary} ${diagnostics.join(' · ')}`; status.textContent = summary;
    } catch (error) {
      if (!current()) return;
      status.textContent = started ? `结果未知：执行请求失败，命令可能已执行；请先核查，不会自动重试。${errorText(error)}`
        : `预览失败，未执行。${errorText(error)}`;
      if (started) {
        result.hidden = false; resultMeta.textContent = status.textContent;
        resultCommand.textContent = `命令：${command}\n目录：${executionWorkspace}`;
      }
    } finally {
      if (current()) { busy = false; sync(); }
    }
  }
  function keydown(event) {
    if (event.key !== 'Enter' || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
      || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat) return submit();
  }
  input.addEventListener('input', edited); input.addEventListener('keydown', keydown); run.addEventListener('click', submit);
  root.update = next => {
    if (disposed) return root;
    const changed = !task || task.id !== next?.id;
    const contextChanged = changed || task.workspace !== next?.workspace || task.task_kind !== next?.task_kind || task.execution_retired !== next?.execution_retired;
    if (contextChanged) { generation++; busy = false; dismissConfirmation(); }
    task = { ...next };
    if (changed) { input.value = ''; draftVersion++; clearResult(); status.textContent = ''; advanced.open = false; }
    else if (contextChanged) status.textContent = '工作区或 Worker 类型已变化，旧请求不再更新此面板；已发出的命令仍可能执行，请先核查。';
    worker.textContent = workerNumber(task);
    if (contextChanged) workspace.textContent = present(task.workspace) ? task.workspace : '工作区不可用';
    fillExamples(); sync(); return root;
  };
  root.dispose = () => {
    if (disposed) return;
    disposed = true; generation++; busy = false; dismissConfirmation();
    input.removeEventListener('input', edited); input.removeEventListener('keydown', keydown); run.removeEventListener('click', submit);
    for (const [node, handler] of exampleHandlers.splice(0)) node.removeEventListener('click', handler);
    sync();
  };
  return root.update(initialTask);
}
