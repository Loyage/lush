import { api, projectApi } from './api.js';
import { ui } from './state.js';
import { renderWorkerCli } from './worker-cli.js';

// One visible CLI page only; never retain a command session across projects or boots.
let active = null;
export function disposeWorkerCli() {
  active?.node?.dispose();
  active = null;
}

export function detailWorkerCli(task, { preview, execute, loadHistory, clearHistory } = {}) {
  if (!['order', 'child'].includes(task.task_kind) || task.execution_retired === true) {
    disposeWorkerCli();
    return null;
  }
  const endpoint = projectApi('/api/action'), document = globalThis.document, boot = ui.workerNumbers;
  const view = ui.view, hash = location.hash;
  if (active?.id === task.id && active.endpoint === endpoint && active.document === document && active.boot === boot
    && active.view === view && active.hash === hash) {
    return active.node.update(task);
  }
  disposeWorkerCli();
  const entry = { id: task.id, endpoint, document, boot, view, hash, node: null };
  const request = (method, params) => {
    if (active !== entry || globalThis.document !== document || ui.workerNumbers !== boot || projectApi('/api/action') !== endpoint || ui.view !== view || location.hash !== hash) {
      throw new Error('CLI 交互页面已变化；未发送命令，请重新打开 CLI 交互。');
    }
    // Deliberately no action() refresh: a successful execution ACK and a failed
    // supplementary read must never be confused, nor destroy the output/draft.
    return api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params: { ...params, id: entry.id } }) });
  };
  // Initial history loading starts during render; bind identity before callbacks run.
  active = entry;
  entry.node = renderWorkerCli(task, {
    preview: preview || (command => request('worker.cli_preview', { command })),
    execute: execute || (params => request('worker.cli_execute', params)),
    loadHistory: loadHistory || (params => request('worker.cli_history', params)),
    clearHistory: clearHistory || (() => request('worker.cli_history_clear', {})),
  });
  return entry.node;
}
