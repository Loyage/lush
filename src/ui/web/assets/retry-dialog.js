import { action, api } from './api.js';
import { button, el } from './dom.js';
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

/**
 * 任务级 Agent Profile 面板：terminal retry 与 paused 的「调整运行设置」共用同一套字段。
 * 字段含配置模式、本轮 Agent / 模型 / 思考深度 / Prompt / 扩展 / Skills / 软预算，以及只在本任务生效的 Pi 环境变量。
 * Profile 只送到 worker.retry / worker.configure，不修改项目 agent.json，Worker 结算时失效。
 */
export async function retryTask(task) {
  return profileDialog(task, { method: 'worker.retry' });
}

/** 暂停或请求中断时的「调整运行设置」：只保存 Profile，下一次调用生效，不改变旧调用。 */
export async function configureTask(task) {
  return profileDialog(task, { method: 'worker.configure' });
}

async function profileDialog(task, options) {
  const configuring = options.method === 'worker.configure';
  const view = ui.view; let active = true;
  const ownsPage = () => active && ui.view === view;
  try {
    const settings = await api('/api/agent/config');
    const { role, profile } = roleProfile(settings, task.role);
    // agent.json does not contain the env-file layers. Match invocation precedence:
    // common env < role env < profile env. Do not silently open an incomplete form on read failure.
    const [commonEnv, roleEnv] = await Promise.all([
      api('/api/agent/environment?target=common'),
      api(`/api/agent/environment?target=${encodeURIComponent(role)}`),
    ]);
    profile.env = { ...commonEnv.values, ...roleEnv.values, ...(profile.env || {}) };

    const form = createProfileForm({ profile, settings, role, ownsPage, applyDefaultModelOnChange: true });
    const content = el('div', undefined, 'retry-profile-form-wrap');
    content.append(form.node, el('p', '确认后，所选完整 Profile 会固定到这个 Worker，直到它再次完成、失败或取消。', 'retry-scope-note'));
    await form.ready;
    if (!ownsPage()) return false;
    // Read local sources on open; a slow/failed read must not block editing.
    // Start after initialization so its repaint cannot erase a read failure or loading state.
    void form.picker.load();

    // Keep the same live form when the profile is invalid, so fixing it does not lose other edits.
    for (;;) {
      const confirmed = await formDialog({
        title: configuring ? `调整 Worker ${workerLabel(task)} 的运行设置` : `检查后重试 Worker ${workerLabel(task)}`,
        message: configuring
          ? '这些设置用于下一次 Agent 调用，不改变仍在运行的调用。尚未生效的中断可用「继续」撤销；Worker 结算后设置自动清除。'
          : `Worker 因“${task.status === 'cancelled' ? '已取消' : '失败'}”停止。请检查并调整 ${task.role} Agent；这些设置只用于本轮重试。`,
        content, confirmLabel: configuring ? '保存设置' : '使用这些设置重试',
        cancelLabel: configuring ? '不修改' : '暂不重试', cardClass: 'retry-modal',
        agent: !configuring,
        confirmHelp: configuring
          ? '保存这次运行设置，在下一次 Agent 调用时生效；不改变当前调用，也不自动继续。'
          : agentHelp('用上面选定的 Agent 设置重新启动这个 Worker。'),
      });
      if (!confirmed || ui.view !== view) return false;
      const error = form.validate();
      if (error) { show(error, 'error'); continue; }
      break;
    }
    active = false;

    const builtIn = form.builtInPrompt;
    const entered = form.defaultPromptValue();
    const nextDefault = entered === builtIn.trim() ? '' : entered;
    if (nextDefault && nextDefault !== (profile.default_prompt || '') && form.mode() !== 'pi') {
      const accepted = await confirmDialog({
        title: configuring ? '用自定义 Prompt 保存设置？' : '用自定义 Prompt 重试？',
        message: '自定义内容会替换 Lush 内置 Worker 规则，仅本轮生效。',
        detail: '可能影响：Worker API 使用、权限边界、子 Worker 协作、工作区安全和交付流程。',
        confirmLabel: configuring ? '仍然保存' : '仍然重试', cancelLabel: configuring ? '取消修改' : '取消重试', danger: true,
        agent: !configuring,
        confirmHelp: configuring ? '保存这份自定义 Prompt 作为本轮运行设置。' : agentHelp('用这份自定义 Prompt 重新启动这个 Worker。'),
      });
      if (!accepted) return false;
    }
    const taskProfile = form.collect();
    await action(options.method, { id: task.id, profile: taskProfile });
    show(configuring
      ? `Worker ${workerLabel(task)} 的运行设置已保存，将在下一次 Agent 调用时生效。`
      : `Worker ${workerLabel(task)} 已按本轮 Agent 设置进入重试队列。`);
    return true;
  } catch (error) {
    show(configuring ? `无法保存运行设置：${error.message}` : `无法重试：${error.message}`, 'error');
    return false;
  } finally { active = false; }
}
