import { api, projectApi } from './api.js';
import { ui } from './state.js';
import { renderWorkerCli } from './worker-cli.js';

// One visible detail only; never retain a command session across projects or boots.
let active = null;
export function disposeWorkerCli() {
  active?.node.dispose();
  active = null;
}

export function detailWorkerCli(task) {
  if (!['order', 'child'].includes(task.task_kind) || task.execution_retired === true) {
    disposeWorkerCli();
    return null;
  }
  const endpoint = projectApi('/api/action'), document = globalThis.document, boot = ui.workerNumbers;
  if (active?.id === task.id && active.endpoint === endpoint && active.document === document && active.boot === boot) {
    return active.node.update(task);
  }
  disposeWorkerCli();
  const entry = { id: task.id, endpoint, document, boot, node: null };
  const request = (method, params) => {
    if (active !== entry || globalThis.document !== document || ui.workerNumbers !== boot || projectApi('/api/action') !== endpoint) {
      throw new Error('Worker CLI 页面已变化；未发送命令，请重新打开详情。');
    }
    // Deliberately no action() refresh: a successful execution ACK and a failed
    // supplementary read must never be confused, nor destroy the output/draft.
    return api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params: { ...params, id: entry.id } }) });
  };
  entry.node = renderWorkerCli(task, {
    preview: command => request('worker.cli_preview', { command }),
    execute: params => request('worker.cli_execute', params),
  });
  active = entry;
  return entry.node;
}
