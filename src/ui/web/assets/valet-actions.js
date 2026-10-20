import { $, button, el } from './dom.js';
import { action } from './api.js';
import { confirmDialog, formDialog, syncDialog } from './dialog.js';
import { elevationChoice, projectElevationDefinition, projectElevationConfirmation, sendProjectElevation, pendingProjectElevation, projectElevationReceipts } from './administrator-project-input.js';
import { agentHelp } from './help.js';
import { TERMINAL_STATUS } from './format.js';
import { isValet } from './work-type.js';
import { show } from './messages.js';
import { ui } from './state.js';
import { workerLabel } from './worker-label.js';
import { PROJECT_ELEVATION_MODE, PROJECT_ELEVATION_SCOPE } from '../../../administrator/project-protocol.js';

let appendDialog = null;
const appendHelp = agentHelp('向同一管家提交追加管理指令，明确授权新一轮；保留原始指令和历史，不重放旧操作。项目已有管家占位时拒绝，不会排队保存。');
function appendBlocker(task) {
  if (task.management?.version !== 1 || typeof task.management.can_append !== 'boolean') return '服务未提供管家追加准入信息，请更新服务并刷新详情；不会尝试提交。';
  if (task.execution_retired === true || task.agent?.active || !['completed', 'waiting'].includes(task.status)
    || ['failed', 'unknown', 'stopping'].includes(task.management.state)) return task.management.append_reason || '管家尚未正常结束并安全收口；失败、取消或未知操作不能通过追加恢复。';
  return task.management.can_append === true ? null : task.management.append_reason || '当前管家暂不能追加，请刷新详情核对安全收口状态。';
}
function appendControl(task, refresh) {
  const owner = globalThis.document, project = location.pathname, boot = ui.workerNumbers, view = ui.view;
  const current = () => globalThis.document === owner && location.pathname === project && ui.workerNumbers === boot
    && ui.view === view && !ui.deletedWorkerIds.has(task.id);
  if (appendDialog?.current() && appendDialog.task.id === task.id) {
    appendDialog.task = task; // Same-Valet detail refresh must retain the independent dialog and its text.
    if (appendBlocker(task)) appendDialog.status.textContent = appendBlocker(task);
  }
  const node = button('追加输入', () => {}, undefined, { agent: true, help: appendHelp });
  const host = el('span', undefined, 'help-host valet-append-control'); host.append(node);
  const blocker = appendBlocker(task);
  node.disabled = Boolean(blocker);
  if (blocker) { host.dataset.help = blocker; host.setAttribute('tabindex', '0'); }
  node.onclick = async () => {
    if (node.disabled || !current() || appendBlocker(task)) return;
    if (appendDialog?.current() && appendDialog.task.id === task.id) { appendDialog.input.focus(); return; }
    const content = el('div', undefined, 'valet-append-form');
    const label = el('label', `追加到 ${workerLabel(task)}`, 'modal-label'); label.setAttribute('for', 'valet-append-input');
    const input = el('textarea', undefined, 'valet-append-input'); input.id = 'valet-append-input';
    input.setAttribute('rows', '5'); input.setAttribute('maxlength', '32000'); input.setAttribute('placeholder', '填写本轮新增的管理需求…');
    const status = el('p', undefined, 'hint valet-append-status'); status.setAttribute('role', 'status');
    const confirmation = el('div', undefined, 'valet-elevation-confirmation');
    let fields = null, definition = null, requestId = crypto.randomUUID();
    const session = appendDialog = { task, input, status, current, sent: false, uncertain: false };
    const choices = elevationChoice(() => updateElevation());
    const receipts = projectElevationReceipts({ kind: 'append', id: task.id, current,
      resolved: receipt => { session.sent = true; session.uncertain = false; choices.reset(); fields?.dispose(); fields = null; confirmation.replaceChildren();
        status.textContent = `原提权提交已确认存在，实际状态：${receipt.task.management?.state || receipt.task.status || '未知'}；不代表执行成功，请核对详情，不重发。`; syncDialog(content); } });
    function updateElevation() {
      fields?.dispose(); fields = null; definition = null; confirmation.replaceChildren();
      if (choices.input.checked && input.value.trim() && input.value.length <= 32000) {
        definition = projectElevationDefinition({ kind: 'append', id: task.id, instruction: input.value, client_request_id: requestId });
        const fixed = definition;
        fields = projectElevationConfirmation(fixed, { task, current: () => current() && choices.input.checked && input.value === fixed.instruction && session.task.id === fixed.id });
        confirmation.append(fields.node);
      }
      const confirm = $('modal')?.querySelector('.modal-confirm');
      if (confirm && $('modal')?.querySelector('.valet-append-form') === content) {
        confirm.textContent = choices.input.checked ? '验证密码并执行这一条' : '提交追加';
        confirm.setAttribute('data-help', choices.input.checked ? agentHelp('验证当前 Web 登录密码后，仅本条以当前项目管理员权限追加；下一条默认普通。') : appendHelp);
      }
      syncDialog(content);
    }
    input.oninput = () => { if (!pendingProjectElevation('append', task.id).length) requestId = crypto.randomUUID(); updateElevation(); };
    content.append(label, input, choices.root, confirmation, receipts.root, status);
    try {
      const pending = formDialog({ title: `追加输入 · ${workerLabel(task)}`, content,
        message: '本轮只执行新增管理需求，不重放旧操作；沿用模型来源，每轮会话隔离。其他管家占位时拒绝提交，原文保留。',
        confirmLabel: '提交追加', cancelLabel: '关闭', agent: true, confirmHelp: appendHelp,
        canConfirm: () => current() && !session.sent && !session.uncertain && !pendingProjectElevation('append', task.id).length,
        onConfirm: async () => {
          if (!current()) { fields?.clear(); return false; }
          const reason = appendBlocker(session.task), body = input.value;
          if (reason) { fields?.clear(); status.textContent = reason; return false; }
          if (!body.trim() || body.length > 32000) { fields?.clear(); status.textContent = '请填写非空的追加指令，最多 32000 个字符。'; return false; }
          const elevated = choices.input.checked;
          try {
            if (elevated) {
              if (!definition || definition.instruction !== body || !fields) { fields?.clear(); status.textContent = '正文或目标已变化，请重新核对本条提权指令。'; return false; }
              let password = fields.password.value; fields.clear();
              if (!password) { status.textContent = '请输入当前 Web 登录密码。'; return false; }
              try { const flight = sendProjectElevation(definition, password); password = ''; await flight; }
              finally { password = ''; fields?.clear(); }
            } else await action('worker.message', { id: task.id, body }, { refresh: false });
          } catch (error) {
            session.uncertain = elevated ? pendingProjectElevation('append', task.id).length > 0 : true;
            if (current()) { status.textContent = elevated ? error.message : `追加未确认：${error.message}；原文已保留。请先刷新详情核对结果，不自动重发。`; receipts.refresh(); }
            return false;
          }
          choices.reset(); fields?.dispose(); fields = null; confirmation.replaceChildren();
          session.sent = true;
          if (!current()) return false;
          show('追加管理输入已提交，等待新一轮运行；旧操作不会重放。');
          try { await refresh(); }
          catch (error) { if (current()) show(`追加已提交，但详情刷新失败：${error.message}；请手动刷新，不要重发。`, 'error'); }
          if (!current()) return false;
          if (input.value !== body) { status.textContent = '追加已提交；请求期间的新编辑已保留，请复制后关闭，不会再次提交。'; return false; }
          return true;
        } });
      input.focus();
      await pending;
    } finally { fields?.dispose(); if (appendDialog === session) appendDialog = null; }
  };
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
  root.append(appendControl(task, refresh));
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
