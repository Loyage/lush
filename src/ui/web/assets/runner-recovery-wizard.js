import { el } from './dom.js';
import { runnerButton, runnerDetails, runnerLifetime } from './runner-settings-controls.js';
import { canonicalPreview as canonical, previewText as text, sameRunnerActions, runnerPlanIssues, renderRunnerActions } from './runner-action-preview.js';

const STATES = { planned: '待确认恢复计划', blocked: '恢复已阻塞', running: '恢复执行中', unknown: '恢复结果未知', failed: '恢复已失败', ready: '新运行能力已恢复' };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const generation = value => Number.isSafeInteger(value) && value >= 0;
const unresolved = recovery => ['running', 'unknown'].includes(recovery?.status);
const qualified = value => value?.managed === true && value?.status === 'confirmed' && typeof value.runner_id === 'string' && Boolean(value.runner_id.trim()) && typeof value.node_id === 'string' && Boolean(value.node_id.trim());
const mutable = new Set(['revision', 'updated_at', 'runtime_generation', 'recoveries', 'recoveries_truncated', 'observation']);
const installationEvidence = value => canonical(Object.fromEntries(Object.entries(value).filter(([key]) => !mutable.has(key))));
// Only explicit root/recovery observational envelopes and update times are independent read data.
// Never strip similarly named fields inside the original installation plan or frozen recovery plan.
function receiptEvidence(value) {
  const omit = object => Object.fromEntries(Object.entries(object).filter(([key]) => key !== 'observation' && key !== 'updated_at'));
  return canonical({ ...omit(value), recoveries: value.recoveries.map(omit) });
}
function operationEvidence(value, id) {
  const recovery = recoveryOf(value, id);
  return canonical({ runtime_generation: value.runtime_generation, recovery: recovery ? Object.fromEntries(
    ['id', 'status', 'plan', 'stages', 'approved_actions'].filter(key => Object.hasOwn(recovery, key)).map(key => [key, recovery[key]])) : null });
}
const keyOf = (receipt, recovery) => `${receipt.id}/${recovery.id}`;
const recoveryOf = (receipt, id) => receipt?.recoveries.find(item => item.id === id);
function validRecovery(value) {
  return value && validId(value.id) && Object.hasOwn(STATES, value.status) && value.plan && typeof value.plan === 'object'
    && Array.isArray(value.plan.blockers) && Array.isArray(value.stages);
}
function validReceipt(value) {
  return value && validId(value.id) && generation(value.revision) && typeof value.status === 'string'
    && typeof value.ssh_alias === 'string' && typeof value.name === 'string' && typeof value.project_id === 'string'
    && value.plan && typeof value.plan === 'object' && Array.isArray(value.stages) && generation(value.runtime_generation)
    && Array.isArray(value.recoveries) && typeof value.recoveries_truncated === 'boolean' && value.recoveries.every(validRecovery)
    && new Set(value.recoveries.map(item => item.id)).size === value.recoveries.length;
}
function recoveryIssues(plan) {
  const issues = runnerPlanIssues(plan, { recovery: true });
  if (plan.supported !== true) issues.push('恢复环境或权限未确认支持，不能提交。');
  if (!generation(plan.from_generation) || !generation(plan.to_generation) || plan.to_generation <= plan.from_generation) issues.push('原代次／拟新代次缺失或无效。');
  if (typeof plan.boot_changed !== 'boolean') issues.push('boot 变化未确认。');
  if (!plan.cgroup || typeof plan.cgroup.previous_path !== 'string' || !plan.cgroup.previous_path.trim()
    || typeof plan.cgroup.observed_path !== 'string' || !plan.cgroup.observed_path.trim() || typeof plan.cgroup.changed !== 'boolean') issues.push('cgroup 原路径／观测路径或变化状态未确认。');
  if (plan.old_commands?.status !== 'stopped' || typeof plan.old_commands.message !== 'string' || !plan.old_commands.message.trim()) issues.push('旧命令停止证据不足；不能恢复新运行能力。');
  return issues;
}

const readyEvidence = (receipt, item) => qualified(receipt) && item?.status === 'ready' && generation(item.plan.from_generation)
  && generation(item.plan.to_generation) && item.plan.to_generation > item.plan.from_generation && receipt.runtime_generation === item.plan.to_generation
  && !recoveryIssues(item.plan).length && !item.plan.blockers.length;
const labelFor = (receipt, item) => item.status === 'ready' && !readyEvidence(receipt, item) ? 'ready 证据未确认（不代表当前运行能力恢复）' : STATES[item.status];

/** Pure UI. Adapter must explicitly qualify managed installations with managed:true; absence never grants eligibility.
 * old_commands.status === 'stopped' is the only accepted stop-evidence projection here, not an observation flag.
 * Root/recovery observation and updated_at may vary independently; other unknown root fields remain frozen.
 * Real schema normalization, permissions and evidence verification remain the embedding adapter/backend's job.
 */
export function createRunnerRecoveryWizard({ adapter, ownsPage = () => true, onChanged = () => {} } = {}) {
  for (const method of ['receipts', 'plan', 'apply', 'reconcile']) if (typeof adapter?.[method] !== 'function') throw new Error(`恢复向导缺少 adapter.${method}`);
  const life = runnerLifetime(ownsPage), current = life.current, ownerWindow = globalThis.window;
  const root = el('section', undefined, 'runner-recovery-wizard block');
  root.append(el('h2', '恢复原受管安装'), el('p', '仅恢复同一已确认受管安装的新运行能力。不重装、不升级、不解除每 SSH 账户一套安装的保护，不换安装 ID、不改项目授权或默认节点、不重跑旧命令、不启动 Worker。', 'hint'));
  const feedback = el('p', '', 'runner-recovery-feedback'); feedback.setAttribute('role', 'status'); feedback.hidden = true;
  const historyStatus = el('p', '', 'runner-recovery-history-status');
  const selectHost = el('span', undefined, 'help-host'), select = el('select'); select.setAttribute('aria-label', '原已确认受管安装'); select.dataset.recoveryField = 'installation'; selectHost.append(select);
  const label = el('label', undefined, 'runner-recovery-field'); label.append(el('span', '选择原已确认受管安装'), selectHost);
  const controls = el('div', undefined, 'runner-recovery-actions'), preview = el('section', undefined, 'runner-recovery-preview');
  const stages = el('section', undefined, 'runner-recovery-stages'), history = runnerDetails('原安装恢复历史');
  const historyList = el('div'); history.append(historyList); root.append(feedback, historyStatus, label, controls, preview, stages, history);
  let items = [], truncated = false, loaded = false, busy = false, receipt = null, recoveryId = '', uncertain = false, effectUncertain = false, pendingPlan = null;
  let approved = new Set(), historyButtons = [], paint = 0;
  const trusted = new Map(), frozen = new Map(), submitted = new Set(), buttons = [];
  const active = () => recoveryOf(receipt, recoveryId);
  const globalUnknown = () => items.some(item => item.recoveries.some(unresolved));
  const locked = () => uncertain || pendingPlan || unresolved(active()) || globalUnknown();
  const completeHistory = () => loaded && !truncated && !receipt?.recoveries_truncated;
  const canPlan = () => qualified(receipt) && completeHistory() && !locked() && !['planned'].includes(active()?.status);
  const planUsable = () => qualified(receipt) && active()?.status === 'planned' && !locked() && completeHistory()
    && active().plan.from_generation === receipt.runtime_generation && !recoveryIssues(active().plan).length && !active().plan.blockers.length;
  const canApply = () => planUsable() && sameRunnerActions([...approved], active().plan.actions.filter(item => item.privileged).map(item => item.id));
  function status(message, error = false) { if (!current()) return; feedback.textContent = message; feedback.className = `runner-recovery-feedback${error ? ' error' : ''}`; feedback.hidden = !message; }
  function action(label, work, allowed, reason, help = '') {
    const item = runnerButton(label, () => current() && !busy && allowed() ? work() : undefined, help);
    buttons.push({ ...item, allowed, reason }); controls.append(item.host);
  }
  action('刷新恢复收据', refresh, () => true, '', '只读取有界收据，不连接 SSH，不重发恢复请求。');
  action('检查原安装恢复条件', plan, canPlan, '需要明确受管、原身份已确认且历史完整的安装；未知操作须先核对，不能换节点绕过。', '显式检查同一原安装的恢复条件；不安装、不升级、不自动提交恢复。');
  action('确认恢复原安装', apply, canApply, '需要当前完整冻结计划、充分旧命令停止证据、受支持权限及逐项未复用的 sudo 授权。', '总确认冻结计划的全部动作；sudo 必须逐项勾选，仅恢复新运行能力，不重跑旧命令或启动 Worker。');
  action('核对原恢复操作', reconcile, () => qualified(receipt) && Boolean(active()) && active().status !== 'ready' && !pendingPlan,
    '须先取得同一原恢复操作 ID；检查结果未知且尚无 ID 时，只能刷新收据查找新操作。', '显式核对同一恢复 ID 的原现场，不重放恢复、不重试安装。');
  function sync() {
    if (!current()) return;
    select.disabled = busy || Boolean(uncertain || pendingPlan || unresolved(active()));
    if (select.disabled) { selectHost.dataset.help = busy ? '请求尚未结束；不会重复提交。' : '原恢复结果未知或仍在执行，不能换安装绕过；请刷新或核对同一操作。'; selectHost.setAttribute('tabindex', '0'); }
    else { delete selectHost.dataset.help; selectHost.removeAttribute('tabindex'); }
    for (const item of buttons) item.disable(busy || !item.allowed(), busy ? '请求尚未结束；不会重复提交或自动重试。' : item.reason);
    for (const item of historyButtons) item.disable(busy, '请求尚未结束；不能更换原恢复操作。');
    for (const input of preview.querySelectorAll('input')) {
      input.disabled = busy || !planUsable();
      const host = input.parentNode;
      if (input.disabled) { host.dataset.help = busy ? '请求尚未结束，不能改变系统授权。' : '恢复计划不可提交；先核对缺失证据或原操作。'; host.setAttribute('tabindex', '0'); }
      else { delete host.dataset.help; host.removeAttribute('tabindex'); }
    }
  }
  async function run(work) {
    if (!current() || busy) return;
    busy = true; sync();
    try { await work(); } catch { if (current()) status('恢复请求未确认；保留原操作，显式刷新或核对，不会自动重试。', true); }
    finally { busy = false; sync(); }
  }
  function check(next, previous, { mutation = false, operation = recoveryId } = {}) {
    if (!validReceipt(next)) throw new Error('invalid installation receipt');
    if (previous) {
      if (next.id !== previous.id || installationEvidence(next) !== installationEvidence(previous) || next.revision < previous.revision
        || (mutation && next.revision <= previous.revision) || (next.revision === previous.revision && receiptEvidence(next) !== receiptEvidence(previous))) throw new Error('changed installation evidence');
    }
    for (const item of next.recoveries) {
      const prior = frozen.get(keyOf(next, item));
      if (prior && canonical(item.plan) !== prior) throw new Error('changed frozen recovery plan');
      if (submitted.has(keyOf(next, item)) && item.status === 'planned') throw new Error('stale recovery after apply');
      if (Object.hasOwn(item, 'approved_actions') && !sameRunnerActions(item.approved_actions,
        submitted.has(keyOf(next, item)) || !['planned', 'blocked'].includes(item.status) ? (Array.isArray(item.plan.actions) ? item.plan.actions.map(action => action?.id) : []) : [])) throw new Error('changed approvals');
      const old = recoveryOf(previous, item.id);
      if (old && Object.hasOwn(old, 'approved_actions') && !Object.hasOwn(item, 'approved_actions')) throw new Error('missing approval evidence');
    }
    if (previous) {
      if (!operation && next.runtime_generation !== previous.runtime_generation) {
        const completed = next.recoveries.filter(item => item.status === 'ready' && recoveryOf(previous, item.id)?.status !== 'ready'
          && item.plan.from_generation === previous.runtime_generation && readyEvidence(next, item));
        if (completed.length !== 1) throw new Error('unattributed generation change');
        operation = completed[0].id;
      }
      const item = recoveryOf(next, operation), prior = recoveryOf(previous, operation);
      if (operation && !item) throw new Error('missing original recovery');
      if (item?.status === 'ready') {
        if (!readyEvidence(next, item)
          || (prior?.status !== 'ready' && item.plan.from_generation !== previous.runtime_generation)) throw new Error('unconfirmed runtime generation');
      } else if (next.runtime_generation !== previous.runtime_generation) throw new Error('unexpected generation change');
    }
  }
  function remember(value) {
    const copy = structuredClone(value); trusted.set(copy.id, copy);
    for (const item of copy.recoveries) frozen.set(keyOf(copy, item), canonical(item.plan));
    items = items.filter(item => item.id !== copy.id); items.push(copy);
    return copy;
  }
  function adopt(value, id, options = {}) {
    const previous = receipt; check(value, previous, { ...options, operation: id });
    const resolved = !effectUncertain || operationEvidence(value, id) !== operationEvidence(previous, id);
    receipt = remember(value); recoveryId = id; uncertain = !resolved;
    if (resolved) { effectUncertain = false; pendingPlan = null; }
    approved.clear(); render();
    if (resolved && active()?.status === 'ready' && receipt.runtime_generation === active().plan.to_generation && options.notify) {
      try { Promise.resolve(onChanged()).catch(() => {}); } catch { /* Callback is not evidence and cannot replay a successful operation. */ }
    }
  }
  function findNew(value, request) {
    check(value, request.receipt, { mutation: true, operation: '' });
    const fresh = value.recoveries.filter(item => !request.known.has(item.id));
    if (fresh.length !== 1 || fresh[0].plan.from_generation !== request.receipt.runtime_generation
      || !generation(fresh[0].plan.to_generation) || fresh[0].plan.to_generation <= fresh[0].plan.from_generation) throw new Error('ambiguous original plan');
    return fresh[0];
  }
  async function refresh() {
    return run(async () => {
      try {
        const result = await adapter.receipts(); if (!current()) return;
        if (result?.version !== 1 || !Array.isArray(result.items) || typeof result.truncated !== 'boolean'
          || !result.items.every(validReceipt) || new Set(result.items.map(item => item.id)).size !== result.items.length) throw new Error('invalid roster');
        for (const item of result.items) check(item, trusted.get(item.id), { operation: receipt?.id === item.id ? recoveryId : '' });
        const found = receipt && result.items.find(item => item.id === receipt.id);
        if (pendingPlan) {
          if (!found) throw new Error('missing original installation');
          const fresh = findNew(found, pendingPlan);
          // Explicit refresh may find one new operation only; old same-target history never substitutes for a lost plan ACK.
          adopt(found, fresh.id); status('已找到原未知请求的新恢复操作；只核对此操作，不重发检查。', unresolved(fresh));
        } else if (receipt && !found) throw new Error('missing original installation or operation');
        else if (found) adopt(found, recoveryId, { notify: active()?.status !== 'ready' });
        items = result.items.map(remember); truncated = result.truncated; loaded = true;
        if (!receipt) {
          const original = items.find(item => item.recoveries.some(unresolved));
          if (original) { receipt = original; recoveryId = original.recoveries.find(unresolved).id; }
        }
        render();
        if (locked()) status('原恢复未知或仍在执行：普通连接与新 Worker 应保持阻塞，只刷新收据或核对原恢复操作。', true);
      } catch { if (current()) { loaded = false; if (receipt) uncertain = true; approved.clear(); render(); status('恢复收据缺失、修订／身份不一致或新操作无法唯一确认；缺记录不代表未执行，不能重复检查或换安装绕过。', true); } }
    });
  }
  async function plan() {
    return run(async () => {
      const request = { receipt: structuredClone(receipt), known: new Set(receipt.recoveries.map(item => item.id)) };
      pendingPlan = request; approved.clear();
      try {
        const next = await adapter.plan({ id: receipt.id, expected_revision: receipt.revision }); if (!current()) return;
        const fresh = findNew(next, request);
        if (!['planned', 'blocked'].includes(fresh.status) || next.runtime_generation !== request.receipt.runtime_generation) throw new Error('false plan ACK');
        adopt(next, fresh.id, { mutation: true }); status('原安装恢复条件已返回；尚未执行恢复，请核对计划及逐项系统授权。', fresh.status === 'blocked');
      } catch { if (current()) { uncertain = true; effectUncertain = true; approved.clear(); render(); status('检查结果未确认且可能已生成恢复操作；仅可刷新收据寻找同安装、修订推进且唯一新增的恢复 ID，不能重复检查或换安装。', true); } }
    });
  }
  async function apply() {
    return run(async () => {
      const previous = receipt, original = active(), actions = original.plan.actions.map(item => item.id);
      submitted.add(keyOf(previous, original)); approved.clear(); render();
      try {
        const next = await adapter.apply({ id: previous.id, expected_revision: previous.revision, recovery_id: original.id, approved_actions: actions, confirm: true }); if (!current()) return;
        if (!['running', 'unknown', 'blocked', 'failed', 'ready'].includes(recoveryOf(next, original.id)?.status)) throw new Error('false apply ACK');
        adopt(next, original.id, { mutation: true, notify: true }); statusForActive();
      } catch { if (current()) { uncertain = true; effectUncertain = true; approved.clear(); render(); status('恢复结果未确认；系统授权已清空。保留同一恢复 ID，仅可刷新或核对，不重放、不换安装。', true); } }
    });
  }
  async function reconcile() {
    return run(async () => {
      const previous = receipt, id = recoveryId;
      try {
        const next = await adapter.reconcile({ id: previous.id, expected_revision: previous.revision, recovery_id: id }); if (!current()) return;
        adopt(next, id, { notify: true }); statusForActive();
      } catch { if (current()) { uncertain = true; effectUncertain = true; approved.clear(); render(); status('同一原恢复操作仍无法确认；原身份、计划或代次不一致，保留阻塞，不自动重试。', true); } }
    });
  }
  function statusForActive() { status(`原恢复操作：${labelFor(receipt, active())}。ready 仅表示新运行能力恢复，不代表旧 Run 已对账，也不保证所有崩溃均可恢复。`, active().status !== 'ready'); }
  function selectInstallation(id) {
    if (!current() || busy) return;
    if (uncertain || pendingPlan || unresolved(active())) { select.value = receipt?.id || ''; status('先核对同一原恢复操作，不能换安装绕过未知结果。', true); return; }
    const item = items.find(item => item.id === id);
    receipt = item || null; recoveryId = item?.recoveries.find(unresolved)?.id || ''; approved.clear(); render(); sync();
  }
  select.onchange = () => selectInstallation(select.value);
  function render() {
    if (!current()) return;
    const rendering = ++paint;
    const empty = el('option', '请选择原受管安装'); empty.value = ''; select.replaceChildren(empty);
    for (const item of items) { const option = el('option', `${item.name} · ${item.ssh_alias} · ${item.id}${qualified(item) ? '' : ' · 非已确认受管安装，拒绝恢复'}`); option.value = item.id; select.append(option); }
    select.value = receipt?.id || '';
    historyStatus.textContent = `${truncated ? '安装收据列表已截断，不代表完整历史；不能新建恢复计划。' : '只读安装收据；读取不连接 SSH。'}${receipt?.recoveries_truncated ? ' 原安装恢复历史已截断，缺记录不证明未执行；不能新建恢复计划。' : ''}`;
    preview.replaceChildren(); stages.replaceChildren(); historyList.replaceChildren(); historyButtons = [];
    if (!receipt) { preview.append(el('p', '先选择原已确认受管安装，再显式检查恢复条件。')); return; }
    preview.append(el('h3', '原安装身份与恢复计划'), el('p', `安装收据 ${receipt.id} · 修订 ${receipt.revision}`), el('p', `原 Runner 身份：${text(receipt.runner_id)} · 节点：${text(receipt.node_id)}`), el('p', `配对项目：${receipt.project_id} · 当前已发布代次：${receipt.runtime_generation}`));
    if (!qualified(receipt)) preview.append(el('p', '无明确受管标记或原安装未确认；手动节点不能假定可恢复。请由 adapter 核实资格，后端阻塞仍为最终判断。', 'error'));
    const historyOwner = receipt;
    for (const item of receipt.recoveries) {
      const row = el('div'); row.append(el('p', `原恢复 ${item.id} · ${labelFor(receipt, item)}`));
      const control = runnerButton('查看此恢复操作', () => {
        if (!current() || busy || receipt !== historyOwner || rendering !== paint) return;
        if ((uncertain || pendingPlan || unresolved(active())) && item.id !== recoveryId) { status('不能用其他历史操作替代原未知恢复。', true); return; }
        recoveryId = item.id; approved.clear(); render(); sync();
      }, '只选择同一安装的原持久恢复操作，不检查、不提交、不重放。');
      historyButtons.push(control); row.append(control.host); historyList.append(row);
    }
    const item = active();
    if (!item) preview.append(el('p', '尚未检查恢复条件；原安装 confirmed 不是恢复成功。'));
    else {
      const p = item.plan;
      preview.append(el('p', `恢复 ID：${item.id} · ${labelFor(receipt, item)}`), el('p', `运行代次：${text(p.from_generation)} → ${text(p.to_generation)}`),
        el('p', `boot 是否变化：${typeof p.boot_changed === 'boolean' ? p.boot_changed ? '已变化' : '未变化' : '未确认'}`),
        el('p', `cgroup 原路径：${text(p.cgroup?.previous_path)}`), el('p', `cgroup 观测路径：${text(p.cgroup?.observed_path)} · 变化：${typeof p.cgroup?.changed === 'boolean' ? p.cgroup.changed ? '是' : '否' : '未确认'}`),
        el('p', `旧命令停止状态：${text(p.old_commands?.status)} · ${text(p.old_commands?.message)}`, p.old_commands?.status === 'stopped' ? '' : 'error'));
      for (const blocker of p.blockers) preview.append(el('p', `恢复阻塞：${text(blocker?.code)} · ${text(blocker?.message)}`, 'error'));
      if (item.status === 'planned' && p.from_generation !== receipt.runtime_generation) preview.append(el('p', '计划原代次不匹配当前已发布代次；不能提交。', 'error'));
      for (const issue of recoveryIssues(p)) preview.append(el('p', `恢复计划不可提交：${issue}`, 'error'));
      const snapshot = receipt, operation = item;
      preview.append(renderRunnerActions(p, { prefix: 'runner-recovery', confirmLabel: '确认恢复原安装', onToggle(action, input) {
        if (!current() || busy || snapshot !== receipt || operation !== active() || rendering !== paint || !planUsable()) return;
        if (input.dataset.recoveryAction !== action.id) { approved.clear(); render(); status('系统动作 ID 与冻结计划不符；清空授权，不能提交未知动作。', true); }
        else if (input.checked) approved.add(action.id); else approved.delete(action.id);
        sync();
      } }));
      const advanced = runnerDetails('验证预算与高级摘要');
      const budgets = p.verification_budgets || {};
      for (const key of ['max_commands', 'timeout_ms', 'output_bytes']) advanced.append(el('p', `验证 ${key}：${text(budgets[key])}`));
      advanced.append(el('p', `恢复创建：${text(item.created_at)} · 更新：${text(item.updated_at)}`)); preview.append(advanced);
      stages.append(el('h3', '原恢复操作阶段结果'));
      for (const stage of item.stages) stages.append(el('p', `${text(stage?.id)}：${text(stage?.status)} · ${text(stage?.message)}`, ['failed', 'unknown', 'blocked'].includes(stage?.status) ? 'error' : ''));
      if (!item.stages.length) stages.append(el('p', '尚无恢复阶段结果。'));
      if (item.observation) stages.append(el('p', `观测 complete：${item.observation.complete === true ? '是' : '否／未知'} · remote_status：${text(item.observation.remote_status)}。仅是观测，不是成功、解锁或重试依据。`, 'hint'));
      if (!uncertain && readyEvidence(receipt, item)) stages.append(el('p', '同一恢复操作 ready：新运行能力已恢复；不代表旧 Run 已对账，不自动启动 Worker。'));
      else stages.append(el('p', `原安装 confirmed 不是恢复成功；此操作${item.status === 'ready' ? '的 ready 证据或代次尚未确认' : `为${STATES[item.status]}`}。`, 'error'));
    }
    if (uncertain || pendingPlan || globalUnknown() || unresolved(item)) stages.prepend(el('p', '恢复未知或执行中：普通连接／新 Worker 保持阻塞；不能重放、换节点绕过或把 activated 观测当成功。', 'error'));
  }
  function dispose() { life.dispose(); approved.clear(); pendingPlan = null; trusted.clear(); frozen.clear(); submitted.clear(); ownerWindow?.removeEventListener?.('pagehide', dispose); }
  ownerWindow?.addEventListener?.('pagehide', dispose);
  render(); const ready = refresh();
  return { root, ready, dispose };
}
