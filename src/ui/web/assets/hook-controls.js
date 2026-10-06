import { el } from './dom.js';
import { action } from './api.js';
import { agentHelp } from './help.js';
import { show } from './messages.js';
import { workerLabel } from './worker-label.js';

const updating = new Set();

/** Built-in persistent hook; existing API and locked-child authorization remain unchanged. */
export function autoMergeControl(task, refresh = () => {}, ownsPage = () => true) {
  let setting = task.auto_merge;
  const ended = ['completed', 'failed', 'cancelled', 'awaiting_acceptance'].includes(task.status);
  const frozen = ['requested', 'executing', 'resolving', 'blocked', 'suspended'].includes(task.reservation?.status);
  const editable = () => setting?.editable === true && !setting.locked && !ended && !frozen && task.merge_readiness?.ready !== true;
  const label = el('label', undefined, 'auto-merge-toggle hook-toggle agent-call');
  const input = el('input'); input.type = 'checkbox'; input.setAttribute('aria-label', `Worker ${workerLabel(task)} 自动合并`);
  let saved = setting?.enabled === true; input.checked = saved;
  const host = el('span', undefined, 'help-host auto-merge-help');
  const paint = () => {
    input.disabled = !editable() || updating.has(task.id);
    const reason = setting?.reason || (setting?.locked ? '由父 Worker 派生，自动合并不可关闭。' : !setting ? '自动合并设置暂不可用，请刷新或更新服务。' : ended ? '本轮已结束，当前不可修改自动合并。' : frozen ? '请求已发出，不能调整持续 Hook。' : task.merge_readiness?.ready ? '本轮已交付就绪，请使用合并按钮。' : '');
    host.setAttribute('data-help', agentHelp(`${reason ? `${reason} ` : ''}持续挂载到“Agent 完成工作后”：调用实际退出、子 Worker、消息和待决均处理完且 Git 条件满足时，冻结源提交并向直接父 Worker 申请合并。父 runtime 串行处理；分歧时可能唤醒原 Agent。关闭只停用未来触发，不撤回已发请求。`));
    host.tabIndex = input.disabled ? 0 : -1;
    if (input.disabled) host.setAttribute('aria-label', `Worker ${workerLabel(task)} 自动合并：${reason || '正在保存'}`);
    else host.removeAttribute('aria-label');
  };
  paint(); label.append(input, el('span', '自动合并')); host.append(label);
  input.onchange = async () => {
    if (!ownsPage() || !editable() || updating.has(task.id)) { input.checked = saved; return; }
    const enabled = input.checked; updating.add(task.id); paint(); host.setAttribute('aria-busy', 'true');
    try {
      const result = await action('worker.auto_merge', { id: task.id, enabled });
      if (!ownsPage()) return;
      setting = result.auto_merge ?? null; saved = setting?.enabled === true; input.checked = saved;
      show(setting ? `Worker ${workerLabel(task)} 已${saved ? '挂载' : '停用'}自动合并 Hook` : '设置已提交，请刷新查看 Hook 状态');
    } catch (error) { if (ownsPage()) { input.checked = saved; show(error.message, 'error'); } }
    finally { updating.delete(task.id); paint(); host.removeAttribute('aria-busy'); }
    if (ownsPage()) try { await refresh(); } catch (error) { if (ownsPage()) show(error.message, 'error'); }
  };
  return host;
}
