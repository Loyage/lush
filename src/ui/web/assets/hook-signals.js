import { el, button, block, badge } from './dom.js';
import { api } from './api.js';
import { detail } from './navigate.js';
import { confirmDialog } from './dialog.js';
import { show, clear } from './messages.js';
import { agentHelp } from './help.js';
import { absolute } from './format.js';
import { workerLabel } from './worker-label.js';
import { browserTimezone, hookSchedule, hookScheduleSummary, scheduledWallTime } from './hook-schedule.js';
import { createManagementProfileForm } from './management-profile-form.js';
import { createSignalResetPicker } from './signal-reset-picker.js';

// These mutations own their safe page projection. A failed overview refresh after a
// successful RPC must not turn a known successful creation into a retryable failure.
async function submit(method, params) {
  clear();
  return api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
}

const STATE = { idle: '尚未触发', waiting: '等待信号或安全点', queued: '已排队', running: '正在调用',
  waiting_actions: '操作已提交，等待安全点', succeeded: '已处理', emitted: '已发出', submitted: '已提交',
  skipped: '已跳过／错过', missed: '已错过', failed: '失败', unknown: '结果未知，未自动重放',
  disabled: '已停用', stopped: '已停用', consumed: '一次性授权已用完', completed: '已完成', paused: '已暂停' };
const label = state => STATE[state] || state || '暂无记录';
const option = (value, text) => { const node = el('option', text); node.value = value; return node; };
const field = (title, input) => {
  const wrap = el('label', undefined, 'hook-field'); input.setAttribute('aria-label', title);
  wrap.append(el('span', title), input); return wrap;
};
function guarded(control, reason) {
  if (!reason) return control;
  control.disabled = true;
  const host = el('span', undefined, 'help-host'); host.tabIndex = 0;
  host.setAttribute('data-help', `${reason} ${control.getAttribute('data-help') || ''}`); host.append(control); return host;
}
const occurred = signal => {
  const dueAt = signal.last_due_at || signal.last_execution?.due_at;
  // Changing a one-shot's schedule retains its older history, but authorizes a
  // new future occurrence. Only history at/after the current instant consumes it.
  return dueAt ? Date.parse(dueAt) >= Date.parse(signal.schedule?.at) : Boolean(signal.last_execution);
};
const signalEnableReason = signal => signal.schedule?.kind === 'once' && (occurred(signal) || Date.parse(signal.schedule.at) <= Date.now())
  ? '这个一次性信号已发出或错过；请新建未来的时间信号，不重放历史。' : '';
const signalBindingReason = signal => signalEnableReason(signal) || (!signal.enabled ? '请先启用时间信号。'
  : !signal.next_run_at || Date.parse(signal.next_run_at) <= Date.now() ? '请选择有未来发生时间的信号。' : '');
const unfinishedReference = binding => binding?.enabled || (binding?.pending_signal && !['failed', 'unknown'].includes(binding.state));
const managementEnableReason = model => {
  const blocked = typeof model.can_enable === 'boolean' ? !model.can_enable
    : ['failed', 'unknown', 'consumed', 'completed'].includes(model.state) || (model.mode === 'once' && (model.last_execution || model.state === 'succeeded'));
  return blocked ? model.reason || '此授权已用完或结果未知；请检查历史并新建管理指令，不自动重放。' : '';
};
const instant = (at, timezone) => {
  if (!at) return '暂无';
  try { return `${scheduledWallTime(at, timezone).replace('T', ' ')} · ${timezone}`; } catch { return absolute(at); }
};
function formBusy(node, value) {
  for (const tag of ['input', 'select', 'textarea', 'button']) for (const control of node.querySelectorAll(tag)) control.disabled = value;
}

export function createSignalForm(initial = {}, { ownsPage = () => true } = {}) {
  const node = el('div', undefined, 'hook-form signal-form');
  const name = el('input'); name.maxLength = 160; name.value = initial.name || '';
  const kind = el('select'); kind.replaceChildren(option('once', '一次性日期'), option('daily', '每日固定时间'));
  kind.value = initial.schedule?.kind || 'once';
  const timezone = el('input'); timezone.maxLength = 128; timezone.value = initial.schedule?.timezone || browserTimezone();
  const date = el('input'); date.type = 'datetime-local'; date.step = '1';
  if (initial.schedule?.kind === 'once') {
    try { date.value = scheduledWallTime(initial.schedule.at, timezone.value); } catch { date.value = ''; }
  }
  let exactSchedule = initial.schedule?.kind === 'once' ? { ...initial.schedule } : null;
  let exactDate = date.value;
  const time = el('input'); time.type = 'time'; time.step = '60'; time.value = initial.schedule?.time || '00:05';
  const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = initial.enabled !== false;
  const dateWrap = field('信号日期与时间', date), timeWrap = field('信号每日时间', time);
  const preview = el('p', undefined, 'hint'); const error = el('p', undefined, 'error');
  const collect = () => ({ name: name.value.trim(), enabled: enabled.checked,
    schedule: kind.value === 'once' && exactSchedule && date.value === exactDate && timezone.value.trim() === exactSchedule.timezone
      ? { ...exactSchedule } : hookSchedule(kind.value, date.value, time.value, timezone.value) });
  const paint = () => {
    dateWrap.hidden = kind.value !== 'once'; timeWrap.hidden = kind.value !== 'daily';
    try { preview.textContent = `时间：${hookScheduleSummary(collect().schedule)}`; } catch { preview.textContent = '一次性时间必须在所选时区确实存在且无歧义。'; }
  };
  for (const input of [kind, date, time, timezone]) { input.onchange = paint; input.oninput = paint; }
  const resetPicker = createSignalResetPicker({ ownsPage, timezone: () => timezone.value,
    onSelect(schedule, local) {
      exactSchedule = schedule; kind.value = 'once'; date.value = local;
      // datetime-local may normalize :00 seconds away; compare the actual DOM value.
      exactDate = date.value; paint();
    },
  });
  node.append(field('信号名称', name), resetPicker.node, field('信号周期', kind), dateWrap, timeWrap, field('信号时区（IANA）', timezone),
    field('启用时间信号', enabled), preview,
    el('p', '信号只表示所安排的时间已到，不证明额度恢复。后台停机错过的时刻跳过；每日夏令时重复取首次，不存在的时刻跳过当天。到点持久提交，受并发和安全门限制，不保证 Agent 准点开始。', 'hint'), error);
  paint();
  return { node, collect, loadResetTimes: resetPicker.load,
    setBusy(value) { formBusy(node, value); resetPicker.setBusy(value); }, validate() {
    let message = '';
    try {
      const signal = collect();
      if (!signal.name) message = '请填写信号名称。';
      else if (signal.schedule.kind === 'once') {
        const changed = JSON.stringify(signal.schedule) !== JSON.stringify(initial.schedule);
        if ((!initial.id || changed || (!initial.enabled && signal.enabled)) && Date.parse(signal.schedule.at) <= Date.now()) message = '一次性信号必须安排在未来。';
        else if (!initial.enabled && signal.enabled && !changed && occurred(initial)) message = '这个一次性信号已发出或错过，请新建未来的时间信号。';
      }
    } catch (issue) { message = issue.message; }
    error.textContent = message; return message;
  } };
}

// randomUUID is unavailable on plain HTTP; getRandomValues is still supported.
// Never generate a fresh key for a retry of the same form.
function creationRequestId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createManagementForm(signals, { ownsPage = () => true } = {}) {
  const requestId = creationRequestId();
  const node = el('div', undefined, 'hook-form management-form');
  const name = el('input'); name.maxLength = 160;
  const instruction = el('textarea'); instruction.rows = 5; instruction.maxLength = 32768;
  instruction.placeholder = '例如：在收到信号后，重试失败的 W12；若 W13 待开始，则开始 W13。';
  const signal = el('select'); signal.append(option('', '请选择时间信号'));
  for (const item of signals) {
    const unavailable = signalBindingReason(item);
    const entry = option(item.id, `${item.name}${unavailable ? `（${unavailable}）` : ''}`);
    entry.disabled = Boolean(unavailable); signal.append(entry);
  }
  const mode = el('select'); mode.replaceChildren(option('once', '一次性绑定（默认）'), option('persistent', '持续绑定')); mode.value = 'once';
  const error = el('p', undefined, 'error'); const profileHost = el('div', undefined, 'hook-profile');
  const submissionNote = el('p', undefined, 'hint');
  let profile = null, loading = false, busy = false, submitted = false;
  const configure = button('管理 Agent 运行设置', async () => {
    if (!ownsPage() || busy || loading || profile) return;
    loading = true; configure.disabled = true;
    try {
      const settings = await api('/api/agent/config'); if (!ownsPage()) return;
      profile = createManagementProfileForm(settings, { ownsPage }); profileHost.replaceChildren(profile.node); await profile.ready;
    } catch (issue) { if (ownsPage()) { error.textContent = `读取管理运行设置失败：${issue.message}`; show(error.textContent, 'error'); } }
    finally { loading = false; if (ownsPage()) configure.disabled = busy || Boolean(profile); }
  }, 'ghost', { help: '为管理 Agent 选择独立模式、模型来源和思考深度；不改变目标 Worker 的账号，不加载开发扩展，不立即调用 Agent。' });
  node.append(field('管理指令名称', name), field('管理指令', instruction), field('绑定时间信号', signal), field('信号绑定方式', mode),
    el('p', '首版仅查询当前项目、开始／继续已暂停的开发 Worker、重试失败的开发 Worker；可指定当前项目任意 W 编号。不创建或追加开发任务，不取消、合并、验收、归档、删除或修改账号／服务。', 'hint'),
    el('p', '一次绑定处理首个信号后停止；持续绑定复用同一管理 Agent，后续信号会再次产生调用费用。已有调用或操作未收口时不并发、不堆积每日信号；失败或未知副作用不自动重试。', 'hint'),
    el('p', '未展开运行设置时，保存将冻结项目管理角色有效默认；不会借用目标 Worker 的账号或开发提示词。保存与绑定不立即调用 Agent，信号发出后才排队。', 'hint'), configure, profileHost, submissionNote, error);
  return { node, setBusy(value) { busy = value; formBusy(node, value); configure.disabled = busy || loading || Boolean(profile); profile?.setBusy(value); },
    validate() {
      const message = !name.value.trim() ? '请填写管理指令名称。' : !instruction.value.trim() ? '请填写管理指令。'
        : !signals.some(item => item.id === signal.value) ? '请选择有效的时间信号。'
          : (!submitted && signalBindingReason(signals.find(item => item.id === signal.value))) || (loading ? '管理运行设置正在读取，请稍后。' : profile?.validate() || '');
      error.textContent = message; return message;
    },
    noteSubmitted() {
      submitted = true;
      submissionNote.textContent = '已发出创建请求。重试使用同一创建标识；如果之前已成功，将返回原管理 Worker，不重复创建。修改已提交内容后会核验冲突，请先检查已有管理 Worker，不要另开表单绕过响应丢失。';
    },
    collect: () => ({ client_request_id: requestId, name: name.value.trim(), instruction: instruction.value.trim(), signal_id: signal.value, mode: mode.value,
      ...(profile ? { profile: profile.collect() } : {}) }),
  };
}

/** Keeps the page's shared editor and its draft intact across catalogue/toggle repaints. */
export function renderSignalManagement({ catalogue, editor, ownsPage, busy, setBusy, setEditing, onCatalogue, onManagement }) {
  const model = catalogue.signals;
  const supported = model?.version === 1 && typeof model.revision === 'string' && Array.isArray(model.items);
  const signals = supported ? model.items : [];
  const managers = Array.isArray(catalogue.management_workers) ? catalogue.management_workers : [];
  const signalSection = block('时间信号', supported ? String(signals.length) : ''); signalSection.classList.add('hook-signals');
  const managerSection = block('管理型 Agent', String(managers.length)); managerSection.classList.add('hook-managers');
  signalSection.append(el('p', '用具名时间信号通知绑定的管理 Agent，例如「Codex 额度更新时间已到」。同一信号可绑定多个管理指令；不是实际额度已恢复的观测。', 'hint'));
  managerSection.append(el('p', '只在此处创建信号驱动的管理指令；默认输入框仍用于开发任务。独立管理提示词和受限工具，不进行代码开发、Git 提交或合并。创建与绑定不立即调用 Agent。', 'hint'));
  if (!supported) {
    signalSection.append(el('p', '时间信号接口暂不可用，请更新后台后刷新。', 'hint'));
    managerSection.append(el('p', '管理指令接口暂不可用；不会回退到开发输入或直接启动 Worker。', 'hint'));
    return [signalSection, managerSection];
  }
  const finishEdit = () => { setEditing(false); editor.replaceChildren(); };
  function editSignal(initial = {}) {
    if (!ownsPage() || busy()) return;
    setEditing(true); let form;
    const ownsForm = () => ownsPage() && editor.querySelector('.signal-form') === form.node;
    form = createSignalForm(initial, { ownsPage: ownsForm });
    editor.replaceChildren(el('h2', initial.id ? `编辑时间信号：${initial.name}` : '新建时间信号'), form.node);
    const save = button('保存时间信号', async () => {
      if (!ownsForm() || busy() || form.validate()) return;
      setBusy(true); form.setBusy(true); save.disabled = true;
      try {
        const result = await submit('hooks.signal_save', { signal: { ...(initial.id ? { id: initial.id } : {}), ...form.collect() }, expected_revision: model.revision });
        if (ownsForm()) { finishEdit(); onCatalogue(result); show('时间信号已保存；到点才提交，不立即调用 Agent。'); }
      } catch (issue) { if (ownsForm()) show(`${issue.message}；时间信号编辑已保留。版本冲突请复制内容后刷新。`, 'error'); }
      finally { setBusy(false); if (ownsForm()) { form.setBusy(false); save.disabled = false; } }
    }, 'hook-button', { agent: true, help: agentHelp('保存具名时间信号，允许到点唤醒已绑定的管理 Agent；保存时不立即调用。') });
    editor.append(save, button('取消编辑', () => { if (ownsForm() && !busy()) finishEdit(); }, 'ghost'));
    void form.loadResetTimes();
  }
  function editManagement() {
    if (!ownsPage() || busy()) return;
    setEditing(true); let form;
    const ownsForm = () => ownsPage() && editor.querySelector('.management-form') === form.node;
    form = createManagementForm(signals, { ownsPage: ownsForm });
    editor.replaceChildren(el('h2', '新建管理指令'), form.node);
    let created = false;
    const save = button('创建并绑定管理指令', async () => {
      if (!ownsForm() || busy() || created || form.validate()) return;
      const params = form.collect();
      setBusy(true); form.setBusy(true); save.disabled = true;
      try {
        if (!await confirmDialog({ title: '授权信号驱动的管理 Agent？',
          message: `保存后不会立即调用 Agent；新发出的时间信号将触发管理指令。允许查询当前项目、开始／继续已暂停的开发 Worker、重试失败的开发 Worker。${params.mode === 'persistent' ? '这是持续绑定，后续每次信号均可能产生调用费用；请记得停用。' : '这是一次性绑定，首个信号处理后停止。'}时间到点不证明额度恢复，原安全门继续生效。`,
          confirmLabel: '授权并创建管理指令', agent: true, confirmHelp: agentHelp('创建独立管理 Worker 并绑定未来信号，不立即启动开发或管理调用。') })) return;
        if (!ownsForm()) return;
        form.noteSubmitted();
        const result = await submit('management.create', params); created = true;
        if (ownsForm()) {
          finishEdit(); onManagement(result);
          show(`管理指令 ${workerLabel(result.task || result)} 已创建；等待新信号，不立即调用。`);
        }
      } catch (issue) { if (ownsForm()) show(`${issue.message}；管理指令和运行设置编辑已保留，重试沿用同一创建标识。若内容已修改或结果不明，请先检查已有管理 Worker，勿另建重复指令。`, 'error'); }
      finally { setBusy(false); if (ownsForm()) { form.setBusy(false); save.disabled = created; } }
    }, 'hook-button', { agent: true, help: agentHelp('授权未来信号触发管理指令；仅保存绑定，不立即调用 Agent。') });
    editor.append(save, button('取消编辑', () => { if (ownsForm() && !busy()) finishEdit(); }, 'ghost'));
  }
  signalSection.append(guarded(button('新建时间信号', () => editSignal(), 'ghost hook-button', { help: '编辑具名时间与时区；打开编辑器不调用 Agent，保存前说明未来触发代价。' }), busy() ? '当前正在保存，请稍候。' : ''));
  if (!signals.length) signalSection.append(el('p', '还没有时间信号。先添加信号，再绑定管理指令。', 'hint'));
  for (const signal of signals) {
    const card = el('article', undefined, 'hook-mount hook-signal'); card.dataset.signalId = signal.id;
    const head = el('div', undefined, 'hook-mount-head'); head.append(el('strong', signal.name), badge(signal.enabled ? '启用' : '停用'), badge(signal.schedule?.kind === 'daily' ? '每日' : '一次性'));
    card.append(head, el('p', hookScheduleSummary(signal.schedule), 'hook-schedule-preview'),
      el('p', `下次发出：${instant(signal.next_run_at, signal.schedule?.timezone)}`, 'hint'));
    if (signal.last_due_at) card.append(el('p', `最近原定时刻：${instant(signal.last_due_at, signal.schedule?.timezone)}`, 'hint'));
    if (signal.last_execution) card.append(el('p', `最近信号：${signal.last_execution.status === 'succeeded' ? '已发出' : label(signal.last_execution.status)} · ${absolute(signal.last_execution.finished_at || signal.last_execution.created_at || signal.last_execution.due_at)}`, 'hint'),
      ...(signal.last_execution.reason || signal.last_execution.error ? [el('p', signal.last_execution.reason || signal.last_execution.error, 'hint')] : []));
    const controls = el('div', undefined, 'actions');
    const mutate = async deleting => {
      if (!ownsPage() || busy() || (!deleting && !signal.enabled && signalEnableReason(signal))
        || (deleting && managers.some(item => unfinishedReference(item.management) && item.management.signal_id === signal.id))) return;
      setBusy(true); for (const control of controls.querySelectorAll('button')) control.disabled = true;
      try {
        if (deleting && !await confirmDialog({ title: `删除时间信号「${signal.name}」？`, message: '仅撤销这个信号的未来发出，不删除管理 Worker、已提交操作或历史。启用中或尚未收口的绑定引用此信号时不可删除。', confirmLabel: '删除时间信号', confirmHelp: '删除信号配置；历史与已产生的 Worker 操作保留。' })) return;
        if (!ownsPage()) return;
        const result = await submit(deleting ? 'hooks.signal_remove' : 'hooks.signal_save', { ...(deleting ? { id: signal.id } : { signal: { id: signal.id, name: signal.name, schedule: signal.schedule, enabled: !signal.enabled } }), expected_revision: model.revision });
        if (ownsPage()) { onCatalogue(result); show(deleting ? '时间信号已删除；历史与已有操作不变。' : '时间信号启用状态已保存。'); }
      } catch (issue) { if (ownsPage()) show(`${issue.message}；未假定配置已更改，请刷新目录。`, 'error'); }
      finally { setBusy(false); if (ownsPage()) {
        toggle.disabled = !signal.enabled && Boolean(signalEnableReason(signal));
        remove.disabled = managers.some(item => unfinishedReference(item.management) && item.management.signal_id === signal.id);
        edit.disabled = false;
      } }
    };
    const toggle = button(signal.enabled ? '停用时间信号' : '启用时间信号', () => mutate(false), 'ghost hook-button', {
      agent: !signal.enabled, help: signal.enabled ? '停止未来发出，不撤回已经提交的绑定或操作。' : agentHelp('允许未来时刻发出信号并唤醒绑定的管理 Agent；不补发错过的历史。'),
    });
    const remove = button('删除时间信号', () => mutate(true), 'ghost hook-button', { help: '仅删除信号配置；启用绑定仍引用时需先停用对应绑定，不删除历史。' });
    const edit = button('编辑时间信号', () => editSignal(signal), 'ghost hook-button');
    controls.append(guarded(toggle, busy() ? '正在保存，请稍候。' : !signal.enabled ? signalEnableReason(signal) : ''),
      guarded(edit, busy() ? '正在保存，请稍候。' : ''),
      guarded(remove, busy() ? '正在保存，请稍候。' : managers.some(item => unfinishedReference(item.management) && item.management.signal_id === signal.id) ? '仍有启用或未收口的管理绑定引用此信号，请先停用绑定并等待调用及操作收口。' : ''));
    card.append(controls); signalSection.append(card);
  }
  managerSection.append(guarded(button('新建管理指令', editManagement, 'ghost hook-button', { help: '编辑管理指令与信号绑定，不走开发输入框，不立即调用 Agent。' }), busy() ? '正在保存，请稍候。' : !signals.length ? '请先创建时间信号。' : ''));
  if (!managers.length) managerSection.append(el('p', '还没有管理指令。可写「开始 Wxx」或「重试失败的 Wxx」，再选择未来信号。', 'hint'));
  for (const task of managers) {
    const binding = task.management;
    const card = el('article', undefined, 'hook-mount hook-manager'); card.dataset.workerId = String(task.id);
    const head = el('div', undefined, 'hook-mount-head'); head.append(el('strong', task.name || `管理 ${workerLabel(task)}`), badge('管理型 Agent'));
    card.append(head, el('p', task.goal || '', 'hook-action-preview'));
    if (task.goal_truncated) card.append(el('p', '指令仅显示摘要；完整指令请打开下方详情。', 'hint management-goal-truncated'));
    if (!binding || binding.version !== 1 || typeof binding.revision !== 'string') {
      card.append(el('p', '绑定状态暂不可用；不会默认启用或重放。', 'hint')); managerSection.append(card); continue;
    }
    head.append(badge(binding.mode === 'persistent' ? '持续' : '一次性'), badge(binding.enabled ? '授权启用' : '授权停用'), badge(label(binding.state)));
    const source = signals.find(item => item.id === binding.signal_id);
    card.append(el('p', `绑定信号：${source?.name || '原信号已移除'}${source && !source.enabled ? '（信号停用）' : ''}`, 'hint'));
    if (binding.reason) card.append(el('p', binding.reason, ['failed', 'unknown'].includes(binding.state) ? 'error' : 'hint'));
    if (binding.pending_signal) card.append(el('p', `已提交信号 #${binding.pending_signal.id || binding.pending_signal.occurrence_id || '?'}：${instant(binding.pending_signal.due_at, source?.schedule?.timezone)}；等待槽或安全点，不保证准点开跑。`, 'hint'));
    const last = binding.last_execution;
    if (last) card.append(el('p', `最近处理：${label(last.status)} · ${absolute(last.finished_at || last.started_at || last.submitted_at || last.created_at || last.due_at)}`, 'hint'),
      ...(last.reason || last.error ? [el('p', last.reason || last.error, 'hint')] : []));
    const execution = binding.pending_signal?.actions ? binding.pending_signal : last;
    const receipts = execution?.actions || [];
    const displayed = receipts.slice(0, 32);
    for (const receipt of displayed) {
      card.append(el('p', `${receipt.action === 'retry' ? '重试' : receipt.action === 'start' ? '开始／继续' : '受控操作'} ${workerLabel(receipt.target_id, receipt.target_worker_number)}：${label(receipt.status)}${receipt.reason ? ` · ${receipt.reason}` : ''}`, 'hint'));
    }
    if (execution?.actions_truncated || receipts.length > displayed.length) {
      const count = Number.isSafeInteger(execution.actions_count) && execution.actions_count >= displayed.length
        ? `显示 ${displayed.length} / ${execution.actions_count} 项` : '仅显示部分';
      card.append(el('p', `操作摘要：${count}；完整操作记录请查看下方详情与调用历史。`, 'hint management-actions-truncated'));
    }
    if (task.model_selection) card.append(el('p', `管理调用来源：${task.model_selection.config_mode === 'pi' ? '执行机器 Pi 默认配置' : [task.model_selection.agent, task.model_selection.connection_id && `来源 ${task.model_selection.connection_id}`, task.model_selection.model, task.model_selection.thinking].filter(Boolean).join(' · ') || '已固定角色默认'}`, 'hint'));
    const controls = el('div', undefined, 'actions');
    const toggle = button(binding.enabled ? '停用管理绑定' : '启用管理绑定', async () => {
      if (!ownsPage() || busy() || (!binding.enabled && managementEnableReason(binding))) return;
      setBusy(true); toggle.disabled = true;
      try {
        if (!binding.enabled && !await confirmDialog({ title: '重新启用管理绑定？', message: '只接收之后新发出的信号，不重放旧信号。后续信号可能启动管理 Agent 并操作允许的项目 Worker；持续绑定可能多次产生调用费用。', confirmLabel: '授权并启用绑定', agent: true, confirmHelp: agentHelp('保存管理指令的未来信号授权，不立即调用 Agent。') })) return;
        if (!ownsPage()) return;
        const result = await submit('management.binding_update', { id: task.id, enabled: !binding.enabled, expected_revision: binding.revision });
        if (ownsPage()) { onManagement(result); show(binding.enabled ? '管理绑定已停用；不会撤销已完成操作。' : '管理绑定已启用；只等待新信号。'); }
      } catch (issue) { if (ownsPage()) show(`${issue.message}；请刷新读取最新授权，不自动重试操作。`, 'error'); }
      finally { setBusy(false); if (ownsPage()) toggle.disabled = !binding.enabled && Boolean(managementEnableReason(binding)); }
    }, 'ghost hook-button', { agent: !binding.enabled,
      help: binding.enabled ? '撤销未来和未开始操作的授权；不强杀当前调用、不撤回已完成操作。' : agentHelp('授权新的时间信号触发管理指令，不重放已处理的信号。'),
    });
    controls.append(guarded(toggle, busy() ? '当前正在保存，请稍候。' : !binding.enabled ? managementEnableReason(binding) : ''),
      button('查看指令、结果与调用历史', () => { if (ownsPage()) detail(task.id); }, 'ghost hook-button', { help: '只读打开此管理 Worker 的指令、结果、历史与执行过程，不运行、不合并、不验收。' }));
    card.append(controls); managerSection.append(card);
  }
  return [signalSection, managerSection];
}
