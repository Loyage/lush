import { randomUUID } from 'node:crypto';
import { id, check } from '../types.js';
import { runnerIdentity } from '../runner-service.js';
import { options, LIMITS } from '../workspaces/code-io.js';
import { codeEnvelope, emptyCode } from '../workspaces/code.js';

const methods = Object.freeze({ state: 'codeState', tree: 'codeTree', file: 'codeFile' });
const active = new WeakMap();
async function read(project, taskId, raw, kind) {
  const task = project.store.task(id(taskId)), binding = project.store.runnerBinding(task.id);
  if (!binding) return project.workspaces[methods[kind]](task, raw);
  // Only confirmed resource removal permits commit-only archival. Offline/unknown is not archival.
  if (binding.state === 'removed') return project.workspaces[methods[kind]]({ ...task, workspace: null }, raw);
  const opts = options(raw, kind === 'file');
  const unavailable = (reason, availability = 'unavailable') => ({ ...codeEnvelope(task, opts), ...emptyCode(kind, opts), reason, availability });
  if (binding.state !== 'ready') return unavailable('远端工作区尚未就绪或状态未知，不能确认代码现场');
  if ((active.get(project) ?? 0) >= 4) return unavailable('代码读取繁忙，请稍后重试');
  active.set(project, (active.get(project) ?? 0) + 1);
  const identity = runnerIdentity(binding, { operation_id: randomUUID() });
  let connection;
  const unchanged = () => {
    const current = project.store.runnerBinding(task.id), latest = project.store.task(task.id);
    return current?.revision === binding.revision && current.state === 'ready'
      && ['branch', 'base_commit', 'iteration_base_commit'].every(key => latest[key] === task[key]);
  };
  const started = Date.now();
  try {
    connection = await project.runners.connect(identity, { observation: true });
    connection.assertCurrent();
    if (!unchanged()) return unavailable('远端工作区身份或基线已变化，请刷新后重试', 'stale');
    const result = await connection.client.call('workspace.code.read', { kind, branch: task.branch,
      base_commit: task.base_commit, iteration_base_commit: task.iteration_base_commit, expected_commit: binding.head_commit, options: opts },
    { timeout_ms: Math.max(1, LIMITS.timeout - (Date.now() - started)) });
    connection.assertCurrent();
    project.runners.assertBinding(identity, { observation: true });
    if (!unchanged()) return unavailable('远端工作区身份或基线已变化，请刷新后重试', 'stale');
    check(result?.version === 1 && result.task_id === task.id && result.branch === task.branch && result.scope === opts.scope
      && ['available', 'unavailable', 'stale'].includes(result.availability) && ['workspace', 'none'].includes(result.source)
      && Buffer.byteLength(JSON.stringify(result)) <= LIMITS.response, 'Invalid remote code response');
    return result;
  } catch (error) {
    if (error.code === 'INVALID_REQUEST') throw new Error('Invalid remote code path or read parameters');
    return unavailable(error.code === 'BUSY' ? '远端工作区有活动或未知写入，请在停止确认后重试'
      : error.code === 'STALE' ? '远端工作区身份已变化，请刷新后重试'
        : '远端代码现场不可用；请检查节点连接、授权与工作区状态', error.code === 'STALE' ? 'stale' : 'unavailable');
  } finally {
    try { await connection?.close(); } catch { /* Read-only connection closure is not a workspace stop receipt. */ }
    active.set(project, (active.get(project) ?? 1) - 1);
  }
}

/** Task identity is resolved here; callers cannot choose a filesystem root or Git ref. */
export default {
  codeState(taskId, options = {}) { return read(this, taskId, options, 'state'); },
  codeTree(taskId, options = {}) { return read(this, taskId, options, 'tree'); },
  codeFile(taskId, options = {}) { return read(this, taskId, options, 'file'); },
};
