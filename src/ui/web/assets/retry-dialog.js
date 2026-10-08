import { action, api } from './api.js';
import { el } from './dom.js';
import { confirmDialog, formDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { show } from './messages.js';
import { createProfileForm, parseEnvLines } from './agent-profile-form.js';
import { ui } from './state.js';
import { workerLabel } from './worker-label.js';

export { parseEnvLines };

const roleProfile = (settings, role) => {
  const resolved = role === 'scheduler' ? 'planner' : role;
  return { role: resolved, profile: { ...(settings.resolved?.[resolved] || settings.default) } };
};

/** Worker-local settings survive delivery; saving never changes project defaults. */
export async function retryTask(task) {
  return profileDialog(task, { method: 'worker.retry' });
}

/** One entry for model source and all other settings; save does not resume the Worker. */
export async function configureTask(task) {
  return profileDialog(task, { method: 'worker.configure' });
}

async function profileDialog(task, options) {
  const configuring = options.method === 'worker.configure';
  const view = ui.view; let active = true;
  const ownsPage = () => active && ui.view === view;
  try {
    const settings = await api('/api/agent/config');
    if (!ownsPage()) return false;
    const { role, profile: defaults } = roleProfile(settings, task.role);
    // Full Worker profiles stay out of inspect/list. Read only through the user-only settings API.
    // Failure must not silently replace an existing override with role defaults.
    const [commonEnv, roleEnv, current] = await Promise.all([
      api('/api/agent/environment?target=common'),
      api(`/api/agent/environment?target=${encodeURIComponent(role)}`),
      api(`/api/worker/${task.id}/run-settings`),
    ]);
    if (!ownsPage()) return false;
    if (!current?.profile || typeof current.explicit !== 'boolean') throw new Error('无法读取 Worker 已有运行设置，请更新后台后重试');
    defaults.env = { ...commonEnv.values, ...roleEnv.values, ...(defaults.env || {}) };
    const profile = { ...current.profile, env: { ...commonEnv.values, ...roleEnv.values, ...(current.profile.env || {}) } };
    const form = createProfileForm({ profile, defaultProfile: defaults, settings, role, ownsPage,
      applyDefaultModelOnChange: true, collapseAdvanced: true });
    const content = el('div', undefined, 'retry-profile-form-wrap');
    const errorBox = el('p', undefined, 'settings-error'); errorBox.setAttribute('role', 'alert');
    content.append(el('p', current.explicit ? '已载入本 Worker 的独立运行覆盖；未修改项保留。' : '已载入当前项目 / 角色默认；保存后成为本 Worker 的独立运行覆盖。', 'hint'),
      form.node, el('p', '运行覆盖只属于这个 Worker，跨交付与验收保留，直到显式清除或重新保存；不修改项目默认。', 'retry-scope-note'), errorBox);
    await form.ready;
    if (!ownsPage()) return false;
    void form.picker.load();

    for (;;) {
      if (!ownsPage()) return false;
      const confirmed = await formDialog({
        title: configuring ? `调整 Worker ${workerLabel(task)} 的运行设置` : `检查后重试 Worker ${workerLabel(task)}`,
        message: configuring
          ? '模型来源与其他运行设置在此统一调整；用于下一次 Agent 调用，不改变仍在运行的调用。保存不会自动开始或继续。'
          : `Worker 因“${task.status === 'cancelled' ? '已取消' : '失败'}”停止。请检查并调整 ${task.role} Agent；这些设置只用于本轮重试及后续调用。`,
        content, confirmLabel: configuring ? '保存设置' : '使用这些设置重试',
        cancelLabel: configuring ? '不修改' : '暂不重试', cardClass: 'retry-modal',
        agent: !configuring,
        confirmHelp: configuring
          ? '保存本 Worker 的运行设置，未修改项保留；下一次 Agent 调用生效，不改变当前调用，也不自动继续。'
          : agentHelp('用上面选定的 Agent 设置重新启动这个 Worker。'),
      });
      if (!confirmed || !ownsPage()) return false;
      const error = form.validate();
      if (error) { errorBox.textContent = error; show(error, 'error'); continue; }
      const entered = form.defaultPromptValue();
      const nextDefault = entered === form.builtInPrompt.trim() ? '' : entered;
      if (nextDefault && nextDefault !== (profile.default_prompt || '') && form.mode() !== 'pi') {
        const accepted = await confirmDialog({
          title: configuring ? '用自定义 Prompt 保存设置？' : '用自定义 Prompt 重试？',
          message: '自定义内容会替换 Lush 内置 Worker 规则，作为本 Worker 的运行覆盖保留。',
          detail: '可能影响：Worker API 使用、权限边界、子 Worker 协作、工作区安全和交付流程。',
          confirmLabel: configuring ? '仍然保存' : '仍然重试', cancelLabel: configuring ? '取消修改' : '取消重试', danger: true,
          agent: !configuring,
          confirmHelp: configuring ? '保存这份自定义 Prompt 作为本 Worker 的运行覆盖。' : agentHelp('用这份自定义 Prompt 重新启动这个 Worker。'),
        });
        if (!ownsPage()) return false;
        if (!accepted) continue;
      }
      try {
        await action(options.method, { id: task.id, profile: form.collect() });
        if (!ownsPage()) return false;
        show(configuring
          ? `Worker ${workerLabel(task)} 的运行设置已保存，将在下一次 Agent 调用时生效。`
          : `Worker ${workerLabel(task)} 已按选定的 Agent 设置进入重试队列。`);
        return true;
      } catch (error) {
        if (!ownsPage()) return false;
        errorBox.textContent = `保存失败：${error.message}。当前编辑已保留，请检查后重试。`;
      }
    }
  } catch (error) {
    if (ownsPage()) show(configuring ? `无法保存运行设置：${error.message}` : `无法重试：${error.message}`, 'error');
    return false;
  } finally { active = false; }
}
