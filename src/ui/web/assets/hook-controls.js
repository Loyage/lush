import { el, button } from './dom.js';
import { confirmDialog } from './dialog.js';
import { action } from './api.js';
import { agentHelp } from './help.js';
import { show } from './messages.js';
import { workerLabel } from './worker-label.js';
import { projectBase, routeContext } from './route.js';

const updating = new Set();
export const COMPLETION_LEVELS = { off: '关闭自动链', merge: '自动到合并', accept: '自动到验收', archive: '自动到归档' };
export const HOOK_STATES = { idle: '已挂载', waiting: '等待条件', running: '动作执行中', succeeded: '已执行', skipped: '已跳过', failed: '执行失败', unknown: '结果未知·需检查' };
const rank = level => Object.keys(COMPLETION_LEVELS).indexOf(level);

/** Shared stage buttons; callers decide whether selection is a draft or saved authorization. */
export function completionLevelButtons(label, onSelect, { includeOff = true } = {}) {
  const group = el('div', undefined, 'hook-completion-levels');
  group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
  const choices = [];
  for (const [level, text] of Object.entries({ off: '关闭', merge: '合并', accept: '验收', archive: '归档' })) {
    if (!includeOff && level === 'off') continue;
    const control = button(text, () => onSelect(level), 'hook-completion-level'); control.dataset.level = level;
    control.setAttribute('aria-label', COMPLETION_LEVELS[level]);
    const host = el('span', undefined, 'help-host hook-completion-help'); host.append(control);
    choices.push({ level, control, host }); group.append(host);
  }
  return { group, choices };
}

/** One-click highest-stage authorization; delegated Worker flow Hooks are read-only. */
export function autoCompletionControl(task, model, refresh = () => {}, ownsPage = () => true, onEditing = () => {}) {
  const scope = projectBase(), updateKey = `${scope}:${task.id}`;
  const owns = () => ownsPage() && !routeContext().invalid && projectBase() === scope;
  let setting = model?.completion, revision = model?.revision, saved = setting?.level;
  const node = el('div', undefined, 'hook-completion-control');
  const { group, choices } = completionLevelButtons(`Worker ${workerLabel(task)} 自动执行到`, save);
  const status = el('span', undefined, 'hint hook-completion-state'); status.setAttribute('role', 'status');
  const ended = ['failed', 'cancelled'].includes(task.status);
  const delivered = ['completed', 'awaiting_acceptance'].includes(task.status);
  const frozen = ['requested', 'executing', 'resolving', 'blocked', 'suspended'].includes(task.reservation?.status);
  const archived = task.archived || task.branch_archive?.archived;
  const locked = () => task.task_kind === 'child' || setting?.locked === true;
  const editable = () => owns() && !locked() && setting?.editable === true && rank(saved) >= 0 && typeof revision === 'string'
    && !ended && !frozen && !archived && !['running', 'unknown'].includes(setting.state);
  const allowed = level => rank(level) >= Math.max(0, rank(setting?.min_level)) && (!delivered || rank(level) >= rank(saved));
  const mayCallAgent = () => !delivered && !['accept', 'archive'].includes(setting?.phase);
  const costHelp = (level, help) => level !== 'off' && mayCallAgent() ? agentHelp(help) : help;
  const reason = () => (locked() ? '父 Worker 派生的子 Worker 流程 Hook 已锁定，用户不能修改自动级别。' : setting?.reason) || (ended ? 'Worker 已结束，不能设置自动链。' : archived ? '分支已归档。'
    : frozen ? '合并请求已冻结，不能修改当前自动链。' : setting?.state === 'running' ? '自动动作正在执行，不能修改当前链。'
      : setting?.state === 'unknown' ? '结果未知，请先检查现场；不能通过修改级别重放动作。'
        : !editable() ? '自动链设置或版本暂不可用，请刷新。' : '');
  function paint() {
    const busy = updating.has(updateKey);
    for (const { level, control, host } of choices) {
      control.disabled = !editable() || busy || !allowed(level);
      control.setAttribute('aria-pressed', String(level === saved));
      control.classList.toggle('is-selected', level === saved);
      control.classList.toggle('is-included', level !== 'off' && rank(level) < rank(saved));
      control.classList.toggle('agent-call', level !== 'off' && mayCallAgent());
      const blocked = busy ? '正在保存。' : reason() || (!allowed(level) ? setting?.min_level === 'merge' && level === 'off'
        ? '父 Worker 派生的 child 至少自动合并，不能关闭。' : '已交付成果只能提高自动级别补办。' : '');
      const consequence = level === 'off' ? '关闭未来自动执行，不撤回已发请求。' : level === 'merge'
        ? '交付就绪后自动合并；分歧时可能唤醒源 Agent。' : level === 'accept'
          ? '自动合并后验收；仅检查安全条件，不评审或保证业务质量。'
          : '自动合并、验收并归档；删除分支及后代的 worktree/ref，保留 Worker、会话和历史，不丢弃未提交改动。';
      const help = costHelp(level, `${blocked ? `${blocked} ` : ''}${consequence}点击即保存当前 Worker 授权，高档包含前面的环节，设置不继承给子 Worker。`);
      control.setAttribute('data-help', help); host.setAttribute('data-help', help);
      host.tabIndex = control.disabled ? 0 : -1;
      if (control.disabled) host.setAttribute('aria-label', `${COMPLETION_LEVELS[level]}：${blocked}`);
      else host.removeAttribute('aria-label');
    }
    const diagnostic = setting?.last_execution?.error;
    status.textContent = busy ? '正在保存…' : diagnostic || (['running', 'failed', 'unknown'].includes(setting?.state)
      ? HOOK_STATES[setting.state] : reason());
    status.hidden = !status.textContent;
    status.classList.toggle('error', ['failed', 'unknown'].includes(setting?.state));
    status.setAttribute('data-help', status.textContent); status.tabIndex = status.hidden ? -1 : 0;
  }
  async function save(level) {
    if (!owns() || !editable() || updating.has(updateKey) || level === saved || !allowed(level)) return;
    updating.add(updateKey); onEditing(true); paint(); node.setAttribute('aria-busy', 'true');
    let submitted = false;
    try {
      if (level === 'archive' && !await confirmDialog({ title: '授权自动合并、验收并归档？',
        message: '此授权只作用于当前 Worker。满足安全条件后可立即执行；归档会删除此分支及后代的 worktree/ref，保留 Worker、会话和历史，不丢弃未提交改动。自动验收不是业务质量评审。',
        confirmLabel: '授权自动归档', danger: true, agent: mayCallAgent(),
        confirmHelp: costHelp(level, '授权串行完成合并、验收、归档；已完成环节不重复执行，失败或结果未知时保留现场，不自动重试。') })) return;
      if (!owns()) return;
      const result = await action('worker.completion', { id: task.id, level, expected_revision: revision });
      submitted = true;
      if (!owns()) return;
      setting = result?.worker_id === task.id ? result.completion : null; revision = result?.revision;
      if (rank(setting?.level) < 0) { show('设置已提交，但未收到有效自动链状态；请刷新查看，勿重复提交。', 'error'); return; }
      saved = setting.level;
      show(`Worker ${workerLabel(task)} 已设置：${COMPLETION_LEVELS[saved]}。`);
    } catch (error) { if (owns()) show(`${error.message}；请刷新读取最新 Hook 版本。`, 'error'); }
    finally { updating.delete(updateKey); onEditing(false); paint(); node.removeAttribute('aria-busy'); }
    if (submitted && owns()) try { await refresh(); } catch (error) { if (owns()) show(`自动级别已保存，但刷新失败：${error.message}`, 'error'); }
  }
  for (const { control } of choices) {
    // button() restores its generic enabled state; reapply the authorization gate afterwards.
    const clicked = control.onclick; control.onclick = async () => { await clicked(); paint(); };
  }
  node.append(el('span', '自动到', 'hook-completion-label'), group, status); paint(); return node;
}

/** Built-in persistent hook; existing API and locked-child authorization remain unchanged. */
export function autoMergeControl(task, refresh = () => {}, ownsPage = () => true) {
  const scope = projectBase(), updateKey = `${scope}:${task.id}`, pageOwner = ownsPage;
  ownsPage = () => pageOwner() && !routeContext().invalid && projectBase() === scope;
  let setting = task.auto_merge;
  const ended = ['completed', 'failed', 'cancelled', 'awaiting_acceptance'].includes(task.status);
  const frozen = ['requested', 'executing', 'resolving', 'blocked', 'suspended'].includes(task.reservation?.status);
  const editable = () => ownsPage() && task.task_kind !== 'child' && setting?.editable === true && !setting.locked && !ended && !frozen && task.merge_readiness?.ready !== true;
  const label = el('label', undefined, 'auto-merge-toggle hook-toggle agent-call');
  const input = el('input'); input.type = 'checkbox'; input.setAttribute('aria-label', `Worker ${workerLabel(task)} 自动合并`);
  let saved = setting?.enabled === true; input.checked = saved;
  const host = el('span', undefined, 'help-host auto-merge-help');
  const paint = () => {
    input.disabled = !editable() || updating.has(updateKey);
    const reason = setting?.reason || (!setting ? '自动合并设置暂不可用，请刷新或更新服务。' : task.task_kind === 'child' || setting.locked ? '由父 Worker 派生，流程 Hook 已锁定，用户不能修改自动合并。' : ended ? '本轮已结束，当前不可修改自动合并。' : frozen ? '请求已发出，不能调整持续 Hook。' : task.merge_readiness?.ready ? '本轮已交付就绪，请使用合并按钮。' : '');
    host.setAttribute('data-help', agentHelp(`${reason ? `${reason} ` : ''}持续挂载到“Agent 完成工作后”：调用实际退出、子 Worker、消息和待决均处理完且 Git 条件满足时，冻结源提交并向直接父 Worker 申请合并。父 runtime 串行处理；分歧时可能唤醒原 Agent。关闭只停用未来触发，不撤回已发请求。`));
    host.tabIndex = input.disabled ? 0 : -1;
    if (input.disabled) host.setAttribute('aria-label', `Worker ${workerLabel(task)} 自动合并：${reason || '正在保存'}`);
    else host.removeAttribute('aria-label');
  };
  paint(); label.append(input, el('span', '自动合并')); host.append(label);
  input.onchange = async () => {
    if (!ownsPage() || !editable() || updating.has(updateKey)) { input.checked = saved; return; }
    const enabled = input.checked; updating.add(updateKey); paint(); host.setAttribute('aria-busy', 'true');
    try {
      const result = await action('worker.auto_merge', { id: task.id, enabled });
      if (!ownsPage()) return;
      setting = result.auto_merge ?? null; saved = setting?.enabled === true; input.checked = saved;
      show(setting ? `Worker ${workerLabel(task)} 已${saved ? '挂载' : '停用'}自动合并 Hook` : '设置已提交，请刷新查看 Hook 状态');
    } catch (error) { if (ownsPage()) { input.checked = saved; show(error.message, 'error'); } }
    finally { updating.delete(updateKey); paint(); host.removeAttribute('aria-busy'); }
    if (ownsPage()) try { await refresh(); } catch (error) { if (ownsPage()) show(error.message, 'error'); }
  };
  return host;
}
