import { el, button } from './dom.js';
import { confirmDialog } from './dialog.js';
import { action } from './api.js';
import { agentHelp } from './help.js';
import { show } from './messages.js';
import { workerLabel } from './worker-label.js';
import { projectBase, routeContext } from './route.js';

const updating = new Set();
export const COMPLETION_LEVELS = { off: '关闭自动链', merge: '自动到合并', accept: '自动到验收', archive: '自动到归档' };
export const HOOK_STATES = { idle: '已挂载', waiting: '等待条件', running: '动作执行中', succeeded: '已执行', failed: '执行失败', unknown: '结果未知·需检查' };
const rank = level => Object.keys(COMPLETION_LEVELS).indexOf(level);

/** Highest authorized stage. A locked minimum never disables higher user choices. */
export function autoCompletionControl(task, model, refresh = () => {}, ownsPage = () => true, onEditing = () => {}) {
  const scope = projectBase(), updateKey = `${scope}:${task.id}`;
  const owns = () => ownsPage() && !routeContext().invalid && projectBase() === scope;
  let setting = model?.completion, revision = model?.revision;
  let saved = setting?.level;
  const node = el('div', undefined, 'hook-completion-control');
  const host = el('span', undefined, 'help-host hook-completion-help');
  const label = el('label', undefined, 'hook-field hook-completion-field');
  const select = el('select', undefined, 'hook-completion-select');
  select.setAttribute('aria-label', `Worker ${workerLabel(task)} 最高自动级别`);
  label.append(el('span', '最高自动级别'), select); host.append(label);
  const explanation = el('p', undefined, 'hint hook-completion-explanation');
  const execution = el('p', undefined, 'hint hook-completion-state');
  const error = el('p', undefined, 'error hook-completion-error');
  const ended = ['failed', 'cancelled'].includes(task.status);
  const delivered = ['completed', 'awaiting_acceptance'].includes(task.status);
  const frozen = ['requested', 'executing', 'resolving', 'blocked', 'suspended'].includes(task.reservation?.status);
  const archived = task.archived || task.branch_archive?.archived;
  const editable = () => owns() && setting?.editable === true && rank(saved) >= 0 && typeof revision === 'string'
    && !ended && !frozen && !archived && !['running', 'unknown'].includes(setting.state);
  const allowed = level => rank(level) >= Math.max(0, rank(setting?.min_level)) && (!delivered || rank(level) >= rank(saved));
  const mayCallAgent = () => !delivered && !['accept', 'archive'].includes(setting?.phase);
  const costHelp = help => select.value !== 'off' && mayCallAgent() ? agentHelp(help) : help;
  const reason = () => setting?.reason || (ended ? 'Worker 已结束，不能设置自动链。' : archived ? '分支已归档。'
    : frozen ? '合并请求已冻结，不能修改当前自动链。' : setting?.state === 'running' ? '自动动作正在执行，不能修改当前链。'
      : setting?.state === 'unknown' ? '结果未知，请先检查现场；不能通过修改级别重放动作。'
      : !editable() ? '自动链设置或版本暂不可用，请刷新。' : '');
  function paint() {
    for (const option of select.children) option.disabled = !allowed(option.value);
    select.disabled = !editable() || updating.has(updateKey);
    save.disabled = select.disabled || select.value === saved || !allowed(select.value);
    const agent = select.value !== 'off' && mayCallAgent();
    label.classList.toggle('agent-call', agent); save.classList.toggle('agent-call', agent);
    const help = `${reason() ? `${reason()} ` : ''}选择当前 Worker 自动执行的最高环节，高档包含前面的步骤。级别不继承给子 Worker；请求冻结或执行中不可修改，交付后只能显式提高级别补办。${setting?.min_level === 'merge' ? '父 Worker 派生的 child 至少自动合并，不能关闭；可显式选择更高档。' : ''}`;
    host.setAttribute('data-help', costHelp(help)); label.setAttribute('data-help', costHelp(help)); host.tabIndex = select.disabled ? 0 : -1;
    if (select.disabled) host.setAttribute('aria-label', `Worker ${workerLabel(task)} 最高自动级别：${updating.has(updateKey) ? '正在保存' : reason()}`);
    else host.removeAttribute('aria-label');
    const saveHelp = costHelp('保存当前 Worker 的最高自动级别授权；安全条件满足后可立即补办。自动验收不评审业务质量；自动归档删除分支及后代的 worktree/ref，保留 Worker、会话和历史，不丢弃未提交改动。');
    saveHost.setAttribute('data-help', saveHelp); save.setAttribute('data-help', saveHelp);
    saveHost.tabIndex = save.disabled ? 0 : -1;
    execution.textContent = `已保存：${COMPLETION_LEVELS[saved] || '级别未知'} · 自动链状态：${HOOK_STATES[setting?.state] || setting?.state || '未知'}${setting?.phase ? ` · ${COMPLETION_LEVELS[setting.phase]?.replace('自动到', '') || setting.phase}` : ''}`;
    error.textContent = setting?.last_execution?.error || (['failed', 'unknown'].includes(setting?.state) ? '保留现场，不自动重试；请检查执行记录和安全条件。' : '');
    error.hidden = !error.textContent;
    explanation.textContent = `${reason() ? `${reason()} ` : ''}合并 → 验收 → 归档；高级别包含前面的环节，设置不继承。自动验收只核验安全条件，不调用质量评审 Agent，也不保证业务质量。归档清理分支及后代的 worktree/ref，保留 Worker、会话和历史，不丢弃未提交改动。自动成功环节只留记录；只提醒下一人工环节，失败和待决仍会提醒。${delivered ? '已交付成果可提高级别补办，不重新合并已落地成果。' : ''}${setting?.min_level === 'merge' ? '子 Worker 至少自动合并；更高档需用户显式授权。' : ''}`;
  }
  const save = button('保存自动级别', async () => {
    const level = select.value;
    if (!owns() || !editable() || updating.has(updateKey) || level === saved || !allowed(level)) return;
    updating.add(updateKey); onEditing(true); paint(); node.setAttribute('aria-busy', 'true');
    let submitted = false;
    try {
      if (level === 'archive' && !await confirmDialog({ title: '授权自动合并、验收并归档？',
        message: '此授权只作用于当前 Worker。满足安全条件后可立即执行；归档会删除此分支及后代的 worktree/ref，保留 Worker、会话和历史，不丢弃未提交改动。自动验收不是业务质量评审。',
        confirmLabel: '授权自动归档', danger: true, agent: mayCallAgent(),
        confirmHelp: costHelp('授权串行完成合并、验收、归档；已完成环节不重复执行，失败或结果未知时保留现场，不自动重试。') })) return;
      if (!owns()) return;
      const result = await action('worker.completion', { id: task.id, level, expected_revision: revision });
      submitted = true;
      if (!owns()) return;
      setting = result?.worker_id === task.id ? result.completion : null; revision = result?.revision;
      if (rank(setting?.level) < 0) { select.value = saved; show('设置已提交，但未收到有效自动链状态；请刷新查看，勿重复提交。', 'error'); return; }
      saved = setting.level; select.value = saved;
      show(`Worker ${workerLabel(task)} 已设置：${COMPLETION_LEVELS[saved]}。执行结果见 Hooks。`);
    } catch (error) { if (owns()) { select.value = saved; show(`${error.message}；请刷新读取最新 Hook 版本。`, 'error'); } }
    finally {
      updating.delete(updateKey); onEditing(!submitted && select.value !== saved); paint(); node.removeAttribute('aria-busy');
    }
    if (submitted && owns()) try { await refresh(); } catch (error) { if (owns()) show(`自动级别已保存，但刷新失败：${error.message}`, 'error'); }
  }, 'hook-button');
  const clicked = save.onclick; save.onclick = async () => { await clicked(); paint(); };
  const saveHost = el('span', undefined, 'help-host'); saveHost.append(save);
  for (const [level, text] of Object.entries(COMPLETION_LEVELS)) {
    const option = el('option', text); option.value = level; select.append(option);
  }
  select.value = saved ?? '';
  select.onchange = () => {
    if (!owns() || !editable() || updating.has(updateKey) || !allowed(select.value)) select.value = saved ?? '';
    onEditing(select.value !== saved); paint();
  };
  node.append(host, saveHost, execution, error, explanation); paint(); return node;
}

/** Built-in persistent hook; existing API and locked-child authorization remain unchanged. */
export function autoMergeControl(task, refresh = () => {}, ownsPage = () => true) {
  const scope = projectBase(), updateKey = `${scope}:${task.id}`, pageOwner = ownsPage;
  ownsPage = () => pageOwner() && !routeContext().invalid && projectBase() === scope;
  let setting = task.auto_merge;
  const ended = ['completed', 'failed', 'cancelled', 'awaiting_acceptance'].includes(task.status);
  const frozen = ['requested', 'executing', 'resolving', 'blocked', 'suspended'].includes(task.reservation?.status);
  const editable = () => ownsPage() && setting?.editable === true && !setting.locked && !ended && !frozen && task.merge_readiness?.ready !== true;
  const label = el('label', undefined, 'auto-merge-toggle hook-toggle agent-call');
  const input = el('input'); input.type = 'checkbox'; input.setAttribute('aria-label', `Worker ${workerLabel(task)} 自动合并`);
  let saved = setting?.enabled === true; input.checked = saved;
  const host = el('span', undefined, 'help-host auto-merge-help');
  const paint = () => {
    input.disabled = !editable() || updating.has(updateKey);
    const reason = setting?.reason || (setting?.locked ? '由父 Worker 派生，自动合并不可关闭。' : !setting ? '自动合并设置暂不可用，请刷新或更新服务。' : ended ? '本轮已结束，当前不可修改自动合并。' : frozen ? '请求已发出，不能调整持续 Hook。' : task.merge_readiness?.ready ? '本轮已交付就绪，请使用合并按钮。' : '');
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
