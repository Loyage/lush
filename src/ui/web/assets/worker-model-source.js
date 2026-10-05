import { action } from './api.js';
import { button, el } from './dom.js';
import { formDialog } from './dialog.js';
import { createAgentConnectionPicker } from './agent-connection-picker.js';
import { TERMINAL_STATUS, isHistoricalDelivery } from './format.js';
import { workerKind } from './worker-kind.js';
import { ui } from './state.js';
import { show } from './messages.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SAVE_HELP = '仅保存本 Worker 下一次调用的模型来源与模型，后台保留其他运行覆盖；不启动 Agent，不自动继续，不改变当前调用。';

export function canConfigureModelSource(task) {
  return !isHistoricalDelivery(task) && ['order', 'child'].includes(workerKind(task))
    && !TERMINAL_STATUS.has(task.status) && (task.status === 'paused' || task.interrupt_state === 'requested');
}

/** Runtime binding is authoritative; old backends can fall back to a same-run connection event. */
export function modelSourceSummary(task, history = []) {
  const node = el('div', undefined, 'worker-model-source-summary');
  let current = task.agent?.active ? '未知（缺少当前调用的来源绑定证据）' : '无进行中的调用';
  if (task.agent?.active && Object.hasOwn(task.agent, 'connection_id')) {
    // An explicit null also matters: parked/aborted/ended invocations have no active binding.
    if (UUID.test(task.agent.connection_id)) current = `${task.agent.connection_id} · ${task.agent.model || '模型未知'}`;
  } else if (task.agent?.active) {
    const run = [...(task.runs || [])].filter(row => row.status === 'running').sort((a, b) => b.id - a.id)[0];
    for (const event of Array.isArray(history) ? history : []) {
      if (!run || event.type !== 'invocation.connection' || event.task_id !== task.id) continue;
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data?.run_id === run.id && UUID.test(data.connection_id)) current = `${data.connection_id} · ${data.model || '模型未知'}`;
      } catch { /* Missing or malformed history is not binding evidence. */ }
    }
  }
  node.append(el('p', `当前调用来源：${current}`, 'hint'));
  const next = task.model_selection;
  node.append(el('p', next
    ? `下一次配置：${next.agent} → ${next.connection_id || (next.agent === 'pi' ? '未选择来源（不会回退外部 Pi）' : 'Codex CLI 自身认证')} → ${next.model || '未指定模型'} · ${next.explicit ? 'Worker 独立覆盖' : '继承项目 / 角色配置'}`
    : '下一次配置：未知（后台未提供安全模型选择摘要）', 'hint'));
  return node;
}

export function modelSourceControl(task, onSaved = () => {}) {
  if (!canConfigureModelSource(task)) return null;
  const reason = !task.model_selection ? '后台尚未提供安全模型选择摘要，请更新后台后刷新详情。'
    : task.model_selection.agent !== 'pi' ? 'Codex CLI 不支持 Lush 托管来源；切换执行后端请使用完整运行设置。' : null;
  const node = button('切换模型来源', async () => { if (await configureModelSource(task)) await onSaved(); }, 'ghost', { help: reason || SAVE_HELP });
  if (!reason) return node;
  node.disabled = true;
  const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', reason); host.append(node); return host;
}

/** Submit a narrow patch, never round-trip Prompt/env or reconstruct a full Worker profile. */
export async function configureModelSource(task) {
  if (!canConfigureModelSource(task) || task.model_selection?.agent !== 'pi') return false;
  const view = ui.view;
  let active = true;
  const ownsPage = () => active && ui.view === view;
  try {
    const backend = el('select'); const pi = el('option', 'Pi'); pi.value = 'pi'; backend.append(pi); backend.value = 'pi'; backend.disabled = true;
    const model = el('input'); model.value = task.model_selection.model || ''; model.maxLength = 256;
    model.setAttribute('aria-label', '模型'); model.dataset.workerModelField = 'model';
    const picker = createAgentConnectionPicker({ backend, model, connectionId: task.model_selection.connection_id || '', ownsPage });
    picker.connection.dataset.workerModelField = 'connection_id';
    picker.connection.setAttribute('aria-label', '模型来源');
    const form = el('div', undefined, 'retry-profile-form');
    const sourceField = el('div', undefined, 'retry-field'); sourceField.append(el('span', '模型来源', 'retry-field-label'), picker.node);
    const modelField = el('label', undefined, 'retry-field'); modelField.append(el('span', '模型', 'retry-field-label'), model);
    form.append(el('p', '执行后端：Pi（此操作不切换后端）', 'hint'), sourceField, modelField,
      el('p', '先选择来源，再选择匹配模型；不会自动选取模型或转用付费账号。Prompt、环境变量、Skills、扩展与预算均保留。', 'hint'));
    const errorBox = el('p', undefined, 'settings-error'); errorBox.setAttribute('role', 'alert'); form.append(errorBox);
    // Loading is local only. Render first so a slow read remains cancellable.
    const loading = picker.load();
    for (;;) {
      if (!ownsPage()) return false;
      const confirmed = await formDialog({ title: `切换 Worker #${task.id} 的模型来源`,
        message: '下一次 Agent 调用生效，不改变仍在运行的调用。保存后如需开始或继续，请另行操作。',
        content: form, confirmLabel: '保存来源与模型', cancelLabel: '取消', confirmHelp: SAVE_HELP });
      if (!confirmed || !ownsPage()) return false;
      await loading;
      if (!ownsPage()) return false;
      const problem = !picker.value() ? 'Pi 必须选择 Lush 模型来源；不会回退到外部 Pi 认证。'
        : !picker.entry() ? '尚未取得此来源配置，请重新读取来源并检查后保存。' : picker.validate();
      if (problem) { errorBox.textContent = problem; continue; }
      try {
        const result = await action('worker.configure', { id: task.id, model_selection: { connection_id: picker.value(), model: model.value.trim() } });
        if (!ownsPage()) return false;
        if (result?.model_selection) task.model_selection = result.model_selection;
        show('模型来源与模型已保存；其他运行设置保留，下一次调用生效。');
        return true;
      } catch (error) {
        if (!ownsPage()) return false;
        errorBox.textContent = `保存失败：${error.message}。当前选择保留，请检查后重试。`;
      }
    }
  } finally { active = false; }
}
