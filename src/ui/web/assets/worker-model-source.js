import { action } from './api.js';
import { button, el } from './dom.js';
import { confirmDialog } from './dialog.js';
import { TERMINAL_STATUS, isHistoricalDelivery } from './format.js';
import { normalizeConfigMode } from './agent-config-mode.js';
import { workerKind } from './worker-kind.js';
import { show } from './messages.js';
import { workerLabel } from './worker-label.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const nextConfigMode = task => normalizeConfigMode(task?.model_selection?.config_mode);

/** Task-local overrides survive delivery; clearing one is an explicit, non-Agent action. */
export function canClearOverride(task) {
  return !isHistoricalDelivery(task) && ['order', 'child'].includes(workerKind(task))
    && !TERMINAL_STATUS.has(task.status) && task.status !== 'running'
    && task.model_selection?.explicit === true && !task.agent?.active;
}

/** Runtime binding is authoritative; old backends can fall back to a same-run connection event. */
export function modelSourceSummary(task, history = [], connections = null) {
  const node = el('div', undefined, 'worker-model-source-summary');
  const names = new Map();
  const rows = Array.isArray(connections) ? connections : (Array.isArray(connections?.connections) ? connections.connections : []);
  for (const row of rows) {
    if (typeof row?.id === 'string' && typeof row?.label === 'string' && row.label.trim()) names.set(row.id, row.label.trim());
  }
  const sourceName = id => names.get(id) || id;
  let current = task.agent?.active ? '未知（缺少当前调用的来源绑定证据）' : '无进行中的调用';
  if (task.agent?.active && Object.hasOwn(task.agent, 'connection_id')) {
    if (UUID.test(task.agent.connection_id)) current = `${sourceName(task.agent.connection_id)} · ${task.agent.model || '模型未知'}`;
  } else if (task.agent?.active) {
    const run = [...(task.runs || [])].filter(row => row.status === 'running').sort((a, b) => b.id - a.id)[0];
    for (const event of Array.isArray(history) ? history : []) {
      if (!run || event.type !== 'invocation.connection' || event.task_id !== task.id) continue;
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data?.run_id === run.id && UUID.test(data.connection_id)) current = `${sourceName(data.connection_id)} · ${data.model || '模型未知'}`;
      } catch { /* Missing or malformed history is not binding evidence. */ }
    }
  }
  node.append(el('p', `当前调用来源：${current}`, 'hint'));
  const next = task.model_selection;
  node.append(el('p', next && nextConfigMode(task) === 'pi'
    ? `下一次配置：Pi 默认配置（执行机器的 Pi 自行决定来源与模型）· ${next.explicit ? 'Worker 独立覆盖' : '继承项目 / 角色配置'}`
    : next
      ? `下一次配置：${next.agent} → ${next.connection_id ? sourceName(next.connection_id) : (next.agent === 'pi' ? '未选择来源（不会回退外部 Pi）' : 'Codex CLI 自身认证')} → ${next.model || '未指定模型'} · ${next.explicit ? 'Worker 独立覆盖' : '继承项目 / 角色配置'}`
      : '下一次配置：未知（后台未提供安全模型选择摘要）', 'hint'));
  return node;
}

export function clearOverrideControl(task, onCleared = () => {}) {
  if (!canClearOverride(task)) return null;
  const help = '移除本 Worker 的独立运行覆盖（配置模式、模型来源、模型、Prompt、扩展、Skills、软预算与环境变量），下一次调用回到项目/角色默认；不启动 Agent，不改变当前调用。项目默认若是 Lush 模式且未绑定来源，会在启动前被拦截并提示配置。';
  return button('清除运行覆盖', async () => {
    const confirmed = await confirmDialog({
      title: `清除 Worker ${workerLabel(task)} 的运行覆盖？`,
      message: '本 Worker 的独立运行覆盖将被移除，下一次调用改用项目/角色默认。此操作不启动 Agent，也不改变当前调用；只有你显式清除或重新保存覆盖才会改变它。',
      confirmLabel: '清除覆盖', cancelLabel: '保留', danger: true,
    });
    if (!confirmed) return;
    try {
      await action('worker.clear_override', { id: task.id });
      show('已清除本 Worker 的运行覆盖；下一次调用使用项目 / 角色默认。');
      await onCleared();
    } catch (error) { show(`无法清除覆盖：${error.message}`, 'error'); }
  }, 'ghost', { help });
}
