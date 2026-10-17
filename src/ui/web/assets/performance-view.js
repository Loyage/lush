import { el, button } from './dom.js';
import { createPerformanceData } from './performance-data.js';
import { analyzeShellCommands } from './performance-model.js';
import { absolute, lifecycleDuration } from './format.js';

const stamp = value => value && Number.isFinite(Date.parse(value)) ? absolute(value) : '时间未知';
const outcomes = { failed: '明确失败', succeeded: '明确成功', unknown: '结果未知' };
const duration = value => `${value == null ? '' : '≈ '}${lifecycleDuration(value)}`;
const descending = metric => (a, b) => (b[metric] ?? -1) - (a[metric] ?? -1) || a.key.localeCompare(b.key);

/** Actual Shell commands and failed attempts, not an Agent's self-reported plan. */
export function createPerformanceView(taskId, { onStep = async () => {} } = {}) {
  const root = el('section', undefined, 'performance-view'); root.setAttribute('aria-label', '当前 Worker Shell 指令性能分析');
  const controls = el('div', undefined, 'actions performance-controls');
  const status = el('p', '仅在进入页签后读取实际 Bash 命令；完整历史须显式扫描。', 'hint performance-status'); status.setAttribute('role', 'status');
  const summary = el('div', undefined, 'performance-summary');
  const ranks = el('div', undefined, 'performance-ranks');
  const slow = el('section', undefined, 'performance-slow'), retries = el('section', undefined, 'performance-retries'); ranks.append(slow, retries);
  const advanced = el('details', undefined, 'performance-advanced'); advanced.append(el('summary', '统计口径与未知证据'));
  const notes = el('ul', undefined, 'hint performance-notes'); advanced.append(notes);
  let collector = createPerformanceData(taskId, { commandsOnly: true }), active = false, disposed = false, generation = 0, reading = null;
  let loading = false, initialized = false, needsPaint = false, message = '';
  const expandedCommands = new Set(), openAttempts = new Set(), limits = new Map();
  const sortControls = {};
  function sort(label, values, field) {
    const host = el('label', undefined, 'performance-sort'); host.append(el('span', label));
    const select = el('select'); select.setAttribute('aria-label', label);
    for (const [value, text] of values) { const option = el('option', text); option.value = value; select.append(option); }
    select.value = values[0][0]; select.onchange = () => { limits.delete(field); paint(); };
    sortControls[field] = select; host.append(select); return host;
  }
  const slowSort = sort('慢指令排序', [['max_ms', '单次最长'], ['total_ms', '累计尝试耗时']], 'slow');
  const retrySort = sort('重复失败排序', [['failed_ms', '失败尝试累计耗时'], ['failure_count', '明确失败次数']], 'retries');
  const refresh = button('刷新分析', () => {
    cancel(); collector = createPerformanceData(taskId, { commandsOnly: true }); initialized = false;
    limits.clear(); openAttempts.clear(); expandedCommands.clear(); return load(false);
  }, 'ghost');
  const scan = button('分析全部历史', () => load(true), 'ghost', { help: '显式分批读取当前 Worker 的全部执行记录，仅统计实际 Bash 命令；到预算或失败时保留局部结果，不分析计划，不读取子 Worker，也不调用 Agent。' });
  const cancelButton = button('取消读取', () => { cancel(); message = '读取已取消，保留当前范围；可继续分析全部历史。'; paint(); }, 'ghost');
  controls.append(refresh, scan, cancelButton);
  root.append(el('h2', '性能分析'), el('p', '仅统计实际 Bash 命令；定位慢指令与反复失败的时间浪费。', 'hint'), controls, status, summary, ranks, advanced);
  function cancel() { generation++; reading?.abort(); reading = null; loading = false; }
  const current = () => active && !disposed;
  function commandCard(group, scope) {
    const card = el('li', undefined, 'performance-row performance-command-row'); card.dataset.commandKey = group.key;
    const command = el('pre', undefined, 'performance-command');
    const preview = () => { command.textContent = expandedCommands.has(group.key) || group.command.length <= 400 ? group.command : `${group.command.slice(0, 400)}…`; };
    preview(); card.append(command);
    if (group.command.length > 400) {
      const toggle = button(expandedCommands.has(group.key) ? '收起命令预览' : '展开命令预览', () => {
        if (expandedCommands.has(group.key)) expandedCommands.delete(group.key); else expandedCommands.add(group.key);
        toggle.textContent = expandedCommands.has(group.key) ? '收起命令预览' : '展开命令预览'; preview();
      }, 'ghost'); card.append(toggle);
    }
    const parameters = typeof group.parameters === 'string' ? group.parameters : JSON.stringify(group.parameters);
    if (parameters && parameters !== '{}') card.append(el('p', `其余参数：${parameters}`, 'hint performance-parameters'));
    if (group.command_truncated || group.parameters_truncated) card.append(el('p', '此处仅显示有界预览；定位原始步骤可分段读取完整命令与参数。归组依据完整指纹，而非预览。', 'hint'));
    if (!group.identity_complete) card.append(el('p', '完整参数身份不可核验：本次执行独立列出，未按预览归组。', 'hint'));
    const stats = el('div', undefined, 'performance-command-stats');
    for (const [label, value] of [['最长单次', duration(group.max_ms)], ['已知累计尝试', duration(group.total_ms)],
      ['明确失败／执行次数', `${group.failure_count} / ${group.count}`], ['失败尝试已知累计', duration(group.failed_ms)]]) {
      const metric = el('span'); metric.append(el('span', `${label}：`, 'hint'), el('strong', value)); stats.append(metric);
    }
    card.append(stats, el('p', `最近结果：${outcomes[group.last_outcome]}${group.unknown_count ? ` · ${group.unknown_count} 次结果未知` : ''}${group.unknown_durations ? ` · ${group.unknown_durations} 次缺少有效计时` : ''}`, 'hint'));
    if (group.unknown_failed_durations) card.append(el('p', `${group.unknown_failed_durations} 次明确失败缺少计时，已知累计不是完整失败耗时。`, 'hint'));
    const key = `${scope}:${group.key}`, attempts = el('details', undefined, 'performance-attempts'); attempts.open = openAttempts.has(key);
    attempts.addEventListener('toggle', () => { if (attempts.open) openAttempts.add(key); else openAttempts.delete(key); });
    attempts.append(el('summary', `查看 ${group.count} 次执行与输出`));
    const list = el('ol', undefined, 'performance-attempt-list');
    const limit = limits.get(key) || 5;
    for (const attempt of group.attempts.slice(0, limit)) {
      const item = el('li', undefined, `performance-attempt performance-attempt-${attempt.outcome}`); item.dataset.attemptSeq = String(attempt.seq);
      item.append(el('strong', `#${attempt.seq} · ${outcomes[attempt.outcome]}`), el('span', duration(attempt.duration_ms), 'performance-duration'),
        el('p', `${stamp(attempt.start)} → ${stamp(attempt.end)}`, 'hint'),
        button('定位指令与输出', () => current() ? onStep(attempt.seq) : undefined, 'ghost performance-source'));
      list.append(item);
    }
    attempts.append(list);
    if (group.count > limit) attempts.append(button(`再显示 ${Math.min(20, group.count - limit)} 次执行`, () => { limits.set(key, limit + 20); openAttempts.add(key); paint(); }, 'ghost'));
    card.append(attempts); return card;
  }
  function section(host, title, rows, scope, sortNode) {
    host.replaceChildren(el('h3', title), sortNode);
    if (!rows.length) {
      host.append(el('p', scope === 'retries' ? '当前已读范围未发现同一完整指令至少两次明确失败；未知结果不当作成功或失败。' : '当前范围没有实际 Bash 命令证据；可能尚未读取或历史已缺失，不代表零耗时。', 'hint')); return;
    }
    const limit = limits.get(scope) || 5, list = el('ol', undefined, 'performance-list');
    for (const group of rows.slice(0, limit)) list.append(commandCard(group, scope)); host.append(list);
    if (rows.length > limit) host.append(button(`再显示 ${Math.min(20, rows.length - limit)} 条指令`, () => { limits.set(scope, limit + 20); paint(); }, 'ghost'));
  }
  function paint() {
    if (!current()) return;
    const scroll = root.scrollTop, data = collector.snapshot(), complete = data.coverage.steps;
    status.textContent = `${loading ? '正在读取… ' : ''}${message ? `${message} ` : ''}${complete ? '当前采样范围已扫描完；缺失记录仍保持未知。' : '仅分析已读取范围，尚非全部历史。'} 已读取 ${data.steps.length} 条执行记录${data.sampled_at ? ` · 采样 ${stamp(data.sampled_at)}` : ''}`;
    refresh.disabled = loading; scan.disabled = loading || complete || data.exhausted; cancelButton.hidden = !loading;
    if (!data.task) { summary.replaceChildren(); slow.replaceChildren(); retries.replaceChildren(); notes.replaceChildren(); return; }
    const model = analyzeShellCommands(data); summary.replaceChildren();
    for (const [label, value, extra] of [['实际 Shell 尝试', `${model.summary.attempts} 次`, `${model.summary.commands} 组指令`],
      ['明确失败', `${model.summary.failures} 次`, `${model.summary.unknown_results} 次结果未知`],
      ['失败尝试已知累计（估算）', duration(model.summary.known_failed_ms), `${model.summary.unknown_failed_durations} 次失败缺计时；非墙钟返工时间`]]) {
      const card = el('div', undefined, 'performance-metric'); card.append(el('span', label, 'hint'), el('strong', value), el('span', extra, 'hint')); summary.append(card);
    }
    section(slow, '慢指令', [...model.groups].sort(descending(sortControls.slow.value)), 'slow', slowSort);
    section(retries, '重复失败指令（返工线索）', model.groups.filter(group => group.failure_count >= 2).sort(descending(sortControls.retries.value)), 'retries', retrySort);
    notes.replaceChildren(...model.notes.map(note => el('li', note)), el('li', '仅统计当前 Worker；运行中记录不会自动替换。需要新采样时点击刷新分析。'));
    root.scrollTop = scroll;
  }
  async function load(all) {
    if (!current() || loading) return;
    cancel(); const ticket = generation, controller = new AbortController(); reading = controller; loading = true; message = ''; initialized = true; paint();
    const valid = () => current() && ticket === generation && !controller.signal.aborted;
    try { await collector.load({ all, signal: controller.signal, onProgress: () => { if (valid()) paint(); } }); }
    catch (error) { if (valid()) message = `读取未完成：${error.message}`; }
    finally { if (valid()) { loading = false; reading = null; paint(); } }
  }
  return { root,
    async setActive(value) {
      if (disposed) return; active = value;
      if (!value) { const interrupted = loading; cancel(); if (interrupted) { message = '读取已暂停，范围尚未完成；可继续分析全部历史。'; needsPaint = true; } return; }
      if (!initialized) await load(false); else if (needsPaint) { needsPaint = false; paint(); }
    },
    dispose() { disposed = true; active = false; cancel(); },
  };
}
