import { button, el } from './dom.js';
import { action } from './api.js';
import { projectBase } from './route.js';
import { ui } from './state.js';
import { show } from './messages.js';

// Per-boot identity keeps a second render from submitting the same in-flight check.
// No request secrets or operation payloads are stored here.
const sessions = new WeakMap();
export function runnerVerification(task, { ownsPage = () => true, refresh = async () => {} } = {}) {
  const runner = task.runner, owner = document, boot = ui.workerNumbers, project = projectBase();
  let records = sessions.get(boot);
  if (!records) sessions.set(boot, records = new Map());
  const key = `${project}/${task.id}/${runner.node_id}/${runner.runner_id}/${runner.generation}`;
  let state = records.get(key);
  if (!state) records.set(key, state = { busy: false, revision: null, message: '', error: false });
  const root = el('div', undefined, 'runner-verification runner-actions');
  const status = el('p', '', 'runner-feedback'); status.setAttribute('role', 'status');
  const current = () => owner === document && ui.workerNumbers === boot && projectBase() === project && ownsPage() && !ui.deletedWorkerIds.has(task.id);
  const validRevision = Number.isSafeInteger(runner.revision) && runner.revision > 0;
  const active = ['running', 'queued'].includes(task.status);
  function sync() {
    if (!current()) return;
    const consumed = state.revision === runner.revision;
    check.disabled = state.busy || active || !validRevision || consumed || ui.offline;
    host.setAttribute('data-help', state.busy ? '核验正在进行，请等待；不会重复发起。' : consumed
      ? '此次绑定修订已核验或结果未确认；请先重新读取状态，勿重复提交。' : active
        ? 'Worker 仍在运行或排队；须先停止并等待调用退出。' : !validRevision
          ? '缺少可靠绑定修订，请更新后台并重新读取。' : ui.offline ? '项目不可达；请先恢复连接并重新读取。' : help);
    host.tabIndex = check.disabled ? 0 : -1;
    reload.disabled = state.busy;
    reloadHost.setAttribute('data-help', state.busy ? '请等待当前核验结束。' : '只重新读取中央状态，不发起远端核验。');
    status.textContent = state.busy ? '正在核验原请求及停止证据；不启动 Agent…' : consumed ? state.message : '';
    status.className = `runner-feedback${consumed && state.error ? ' error' : ''}`;
  }
  const help = '显式连接原节点，核验持久请求与真实停止证据；不重放命令、不丢弃修改、不调用 Agent。通过后仍须另行决定是否重试。';
  const check = button('核验远端现场', async () => {
    sync(); if (!current() || check.disabled) return;
    state.busy = true; state.revision = runner.revision; state.message = ''; state.error = false; state.render?.();
    try {
      const result = await action('runner.worker.reconcile', { id: task.id, expected_revision: runner.revision }, { refresh: false });
      const matched = result?.worker_id === task.id && result.node_id === runner.node_id && result.runner_id === runner.runner_id
        && result.generation === runner.generation && Number.isSafeInteger(result.revision) && result.revision >= runner.revision;
      const passed = matched && result.reconciled === true && result.state === 'ready' && result.pending === 0;
      state.error = !passed;
      state.message = passed ? '远端现场核验通过；未启动 Agent，未重试。保留的修改不代表已提交、已交付或可验收。'
        : '核验尚未通过：证据不足、发生变化或仍有屏障；现场保留，不自动重试。请重新读取状态后检查。';
    } catch {
      state.error = true;
      state.message = '核验结果未确认或绑定版本已变化；现场保留。请先重新读取状态，不要重复提交。';
    }
    if (current()) show(state.message, state.error ? 'error' : undefined);
    state.render?.();
    // A read failure after a successful check is not a failed mutation. Never resend it.
    try { if (current()) await refresh(); }
    catch { if (current()) { state.message += ' 页面更新失败，请显式重新读取状态；不要重复提交。'; state.error = true; } }
    finally { state.busy = false; state.render?.(); }
  }, 'ghost', { help });
  const host = el('span', undefined, 'help-host'); host.append(check);
  const reload = button('重新读取状态', async () => {
    if (!current() || state.busy) return;
    state.busy = true; state.render?.();
    try { await refresh(); state.revision = null; }
    catch { if (current()) { state.revision = runner.revision; state.message = '状态读取失败；保留现场，请稍后重新读取。'; state.error = true; } }
    finally { state.busy = false; state.render?.(); }
  }, 'ghost');
  const reloadHost = el('span', undefined, 'help-host'); reloadHost.append(reload);
  state.render = sync;
  root.append(host, reloadHost, status); sync();
  return root;
}
