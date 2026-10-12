import { el, button } from './dom.js';
import { api } from './api.js';
import { workerLabel, rememberWorkers } from './worker-label.js';
import { taskTitle } from './format.js';

export const DISPATCH_STATUS = {
  waiting_conditions: '等待条件', queued: '已发射 · 等待准入', dispatching: '正在投递',
  succeeded: '已投递', failed: '发射失败', unknown: '执行结果未知', cancelled: '已撤销',
};
export function dispatchText(dispatch) {
  if (!dispatch) return '';
  return `${DISPATCH_STATUS[dispatch.state] || '发射状态未知'}${dispatch.reason ? `：${dispatch.reason}` : ''}`;
}
export function emissionAcknowledgement(result, append = false) {
  return `已${append ? '发射追加输入' : '发射输入'}${result?.draft_id ? ` #${result.draft_id}` : ''}，已可靠挂载；${result?.dispatch?.state === 'waiting_conditions' ? '等待全部条件满足，再等待安全准入' : '等待安全准入'}。${append ? '尚不代表 Agent 已收到。' : '尚不代表 Worker 已创建或开始。'}`;
}
export function emissionRequestId() {
  return globalThis.crypto?.randomUUID?.() || `input-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
const controlledButton = (label, run, className = 'ghost') => {
  const control = button(label, run, className); control.onclick = run; return control;
};
const disabledHelp = (host, disabled, reason) => {
  if (disabled) { host.setAttribute('data-help', reason); host.setAttribute('tabindex', '0'); }
  else { host.removeAttribute('data-help'); host.removeAttribute('tabindex'); }
};
const field = (label, control) => {
  control.setAttribute('aria-label', label);
  const node = el('label', undefined, 'emission-field'); node.append(el('span', label), control); return node;
};
const check = (label, value) => { const input = el('input'); input.type = 'checkbox'; input.checked = Boolean(value); return { input, node: field(label, input) }; };

/** Explicit bounded pages and exact W lookup, never the truncated overview window. */
export function createEmissionWorkerPicker({ ownsPage = () => true, label = '条件 Worker', initial = null, onChange = () => {} } = {}) {
  const node = el('div', undefined, 'emission-worker-picker');
  const select = el('select'); const workers = new Map(); let cursor = null, busy = false, disabled = false, generation = 0;
  const empty = el('option', '请选择 Worker'); empty.value = ''; select.append(empty);
  const feedback = el('p', '按需加载项目 Worker；可继续加载更早记录或按完整 W 编号定位。', 'hint'); feedback.setAttribute('role', 'status');
  function add(items) {
    rememberWorkers(items);
    for (const item of items) if (Number.isSafeInteger(item.id) && item.id > 0) workers.set(item.id, item);
    const previous = select.value;
    select.replaceChildren(empty, ...[...workers.values()].map(item => {
      const option = el('option', `${workerLabel(item)} ${taskTitle(item)}${item.status ? ` · ${item.status}` : ''}`);
      option.value = String(item.id); return option;
    })); select.value = previous;
  }
  if (initial) { add([initial]); select.value = String(initial.id); }
  const number = el('input'); number.placeholder = '例如 W123 或 W123-1'; number.maxLength = 128;
  const load = controlledButton('加载 Worker', async () => {
    if (busy || disabled || !ownsPage()) return;
    busy = true; sync(); const attempt = ++generation;
    try {
      const data = await api(`/api/workers?scope=all&limit=100${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
      if (!ownsPage() || generation !== attempt) return;
      if (!Array.isArray(data.tasks)) throw new Error('Worker 列表格式不兼容');
      add(data.tasks); cursor = data.has_more ? data.cursor : null;
      load.textContent = cursor ? '加载更早 Worker' : '重新读取 Worker';
      feedback.textContent = `已加载 ${workers.size} 个 Worker${cursor ? '，更早记录尚未加载。' : '，本次分页已读完。'}`;
    } catch (error) { if (ownsPage() && generation === attempt) feedback.textContent = `读取失败：${error.message}；现有选择保留。`; }
    finally { busy = false; if (ownsPage()) sync(); }
  }, 'ghost');
  const lookup = controlledButton('按编号定位', async () => {
    if (busy || disabled || !ownsPage()) return;
    if (!/^W[1-9]\d*(?:-[1-9]\d*)*$/.test(number.value.trim())) { feedback.textContent = '请输入完整的 W 编号，不从内部整数推算。'; return; }
    busy = true; sync(); const attempt = ++generation;
    try {
      const item = await api(`/api/worker-lookup?number=${encodeURIComponent(number.value.trim())}`);
      if (!ownsPage() || generation !== attempt) return;
      if (!Number.isSafeInteger(item.id) || item.worker_number !== number.value.trim()) throw new Error('编号定位结果不兼容');
      add([item]); select.value = String(item.id); onChange(); feedback.textContent = `已定位 ${workerLabel(item)}。`;
    } catch (error) { if (ownsPage() && generation === attempt) feedback.textContent = `定位失败：${error.message}；现有选择保留。`; }
    finally { busy = false; if (ownsPage()) sync(); }
  }, 'ghost');
  const hosts = [load, lookup].map(control => { const host = el('span', undefined, 'help-host'); host.append(control); return host; });
  function sync() { select.disabled = number.disabled = load.disabled = lookup.disabled = disabled || busy; for (const host of hosts) {
    disabledHelp(host, disabled || busy, busy ? '正在读取 Worker，请稍候。' : '当前输入已锁定，不能更改目标。');
  } }
  select.onchange = onChange;
  node.append(field(label, select), hosts[0], field('Worker 编号', number), hosts[1], feedback);
  return { node, select, value: () => workers.get(Number(select.value)) || null, setBusy(value) { disabled = value; sync(); } };
}

/** Conditions are explicit AND, with separate quiet-at-start and lifetime exclusivity. */
export function createEmissionConditions({ conditions = [], exclusive = false, mode = 'order', ownsPage = () => true, onChange = () => {} } = {}) {
  let workerConditions = conditions.filter(item => item.kind !== 'parent_quiet').map(item => ({ ...item })), busy = false;
  const node = el('section', undefined, 'emission-conditions'); node.setAttribute('aria-label', '发射条件');
  const list = el('div', undefined, 'emission-condition-list');
  const quiet = check('等待目标树彻底静息后发射', conditions.some(item => item.kind === 'parent_quiet'));
  const exclusiveControl = check('独占开发：静息后开始，直到本轮交付收口', mode === 'order' && exclusive);
  const picker = createEmissionWorkerPicker({ ownsPage });
  const kind = el('select'); for (const [id, label] of [['worker_settled','工作安全收尾'],['worker_merged','本轮成果已合入 main']]) {
    const option = el('option', label); option.value = id; kind.append(option);
  } kind.value = 'worker_merged';
  const feedback = el('p', undefined, 'hint'); feedback.setAttribute('role', 'status');
  const add = controlledButton('添加 Worker 条件', () => {
    if (busy || !ownsPage()) return;
    const worker = picker.value(); if (!worker) { feedback.textContent = '请先选择或定位 Worker。'; return; }
    if (workerConditions.some(item => item.kind === kind.value && item.worker_id === worker.id)) { feedback.textContent = '此条件已添加。'; return; }
    if (workerConditions.length + Number(quiet.input.checked || (mode === 'order' && exclusiveControl.input.checked)) >= 16) { feedback.textContent = '最多选择 16 个条件。'; return; }
    workerConditions.push({ kind: kind.value, worker_id: worker.id }); feedback.textContent = ''; paint(); onChange();
  }, 'ghost');
  const addHost = el('span', undefined, 'help-host'); addHost.append(add);
  const removals = [];
  function paint() {
    removals.length = 0; list.replaceChildren();
    workerConditions.forEach((item, index) => {
      const row = el('div', undefined, 'emission-condition-row');
      row.append(el('span', `${workerLabel(item.worker_id, item.worker_number)}：${item.kind === 'worker_merged' ? '本轮成果已合入 main' : '工作安全收尾'}`));
      const remove = controlledButton('移除条件', () => { if (!busy && ownsPage()) { workerConditions.splice(index, 1); paint(); onChange(); } }, 'ghost');
      const host = el('span', undefined, 'help-host'); host.append(remove);
      disabledHelp(host, busy, '发射已挂载或正在处理，条件不能更改。');
      removals.push(remove); row.append(host); list.append(row);
    });
    for (const control of removals) control.disabled = busy;
  }
  quiet.input.onchange = exclusiveControl.input.onchange = onChange;
  node.append(el('h3', '发射条件'), el('p', '以下条件必须全部满足。条件信号只允许发射；父 runtime 仍需空闲并通过安全准入。工作收尾不是一次 Agent 返回，合入 main 不是仅合入直接父 Worker。', 'hint'), list, picker.node, field('等待事件', kind), addHost, quiet.node);
  if (mode === 'order') node.append(exclusiveControl.node, el('p', '静息等待仅约束开始时；独占开发还会阻塞后续其它开发调用，允许自己的子 Worker、管理、查询和交付。失败、暂停或待决可能使其它工作长期排队，不自动授权合并。', 'hint'));
  node.append(feedback); paint();
  return { node, collect: () => ({ conditions: [...workerConditions.map(({ kind, worker_id }) => ({ kind, worker_id })), ...(quiet.input.checked ? [{ kind: 'parent_quiet' }] : [])], exclusive: mode === 'order' && exclusiveControl.input.checked }),
    validate: () => workerConditions.length + Number(quiet.input.checked || (mode === 'order' && exclusiveControl.input.checked)) > 16 ? '最多选择 16 个条件（含独占隐含的静息条件）。' : '',
    setBusy(value) { busy = value; quiet.input.disabled = exclusiveControl.input.disabled = kind.disabled = add.disabled = value; picker.setBusy(value); disabledHelp(addHost, value, '发射已挂载或正在处理，条件不能更改。');
      for (const control of removals) { control.disabled = value; disabledHelp(control.parentNode, value, '发射已挂载或正在处理，条件不能更改。'); } } };
}
