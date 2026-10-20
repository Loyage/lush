import { button, el } from './dom.js';
import { action } from './api.js';
import { confirmDialog } from './dialog.js';
import { appendToWorker } from './composer.js';
import { valetAppendBlocker } from './worker-input.js';
import { TERMINAL_STATUS } from './format.js';
import { isValet } from './work-type.js';
import { show } from './messages.js';
import { ui } from './state.js';
import { workerLabel } from './worker-label.js';
import { PROJECT_ELEVATION_MODE, PROJECT_ELEVATION_SCOPE } from '../../../administrator/project-protocol.js';

function appendControl(task) {
  const node = button('追加输入', () => appendToWorker(task), undefined, {
    help: '在主输入框编辑向同一管家追加的管理指令；现在不发送、不调用 Agent。保留原始指令和历史，不重放旧操作；项目已有管家占位时拒绝，不会排队保存。',
  });
  const host = el('span', undefined, 'help-host valet-append-control'); host.append(node);
  const blocker = valetAppendBlocker(task);
  node.disabled = Boolean(blocker);
  if (blocker) { host.dataset.help = blocker; host.setAttribute('tabindex', '0'); }
  return host;
}

/** User-authorized fresh rounds plus revocation/stop controls; never replay old management work. */
export function valetLifecycleControls(task, { refresh = () => {} } = {}) {
  if (!isValet(task) || task.role !== 'manager' || task.task_kind !== 'management') return null;
  const root = el('span', undefined, 'valet-lifecycle-controls');
  const controls = [];
  let busy = false, sent = false;
  const add = (label, method, params, message, help, success) => {
    const node = button(label, () => {}, 'danger', { help });
    node.onclick = async () => {
      if (busy || sent || node.disabled) return;
      const view = ui.view, owner = globalThis.document, project = location.pathname;
      const current = () => globalThis.document === owner && ui.view === view && location.pathname === project
        && !ui.deletedWorkerIds.has(task.id);
      busy = true; for (const control of controls) control.disabled = true;
      try {
        const authority = task.management?.authority || task.management?.pending_signal?.authority;
        const elevatedStop = method === 'worker.cancel' && authority?.mode === PROJECT_ELEVATION_MODE && authority.scope === PROJECT_ELEVATION_SCOPE;
        const accepted = elevatedStop || await confirmDialog({ title: `${label} ${workerLabel(task)}？`, message,
          confirmLabel: label, cancelLabel: '保留', danger: true, confirmHelp: help });
        if (!accepted || !current()) return;
        sent = true;
        try { await action(method, params, { refresh: false }); }
        catch (error) {
          if (current()) show(`操作未确认：${error.message}；请刷新详情核对，不自动重发。`, 'error');
          return;
        }
        if (!current()) return;
        show(success);
        try { await refresh(); }
        catch (error) { if (current()) show(`操作已提交，刷新失败：${error.message}；请手动刷新，不要重发。`, 'error'); }
      } finally {
        busy = false;
        for (const control of controls) control.disabled = sent;
      }
    };
    controls.push(node); root.append(node);
  };
  root.append(appendControl(task));
  const binding = task.management;
  if (binding?.version === 1 && binding.enabled === true && typeof binding.revision === 'string') {
    add('停用授权', 'management.binding_update', { id: task.id, enabled: false, expected_revision: binding.revision },
      '停用这个管家的后续授权，撤销尚未执行的动作及危险操作确认。不会强杀正在运行的模型，也不会撤回已经开始或完成的操作；它们仍须实际收尾。',
      '撤销该管家尚未执行的授权，不强杀模型、不撤回已开始的副作用；需实际收口后重新预检删除。',
      '管家授权已停用；已开始的调用或操作仍须收尾，是否可删除请重新预检。');
  }
  if (!TERMINAL_STATUS.has(task.status) || task.agent?.active) {
    add('停止管家', 'worker.cancel', { id: task.id },
      '停止这个管家并撤销尚未执行的授权。记录和专属目录保留；已执行的操作不撤回。停止请求成功或状态变为 cancelled 都不代表调用已经退出，删除前必须重新预检。',
      '请求停止该管家并保留历史；不撤回已执行操作，不调用 Agent。必须等待真实退出及在途操作收口后再预检删除。',
      '管家停止请求已提交，不代表已完全退出；请刷新详情并重新预检删除。');
  }
  return root;
}
