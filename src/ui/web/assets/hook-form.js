import { el, button } from './dom.js';
import { api } from './api.js';
import { createProfileForm } from './agent-profile-form.js';
import { STATUS, INTEGRATION } from './format.js';
import { workerLabel } from './worker-label.js';
import { browserTimezone, scheduledWallTime, hookSchedule } from './hook-schedule.js';

const SCHEDULED = 'time.scheduled';
export const COMMAND_WARNING = '任意 Shell 命令将在挂载 Worker 的目录中，以 daemon 用户权限执行；这不是沙箱，可读取或修改文件、访问网络及凭证。启用即授权在节点和条件满足时执行，不调用 Agent。未知副作用不自动重放。';
const profileAction = type => ['create_worker', 'retry_worker', 'resume_worker'].includes(type);
const targetAction = type => ['message', 'retry_worker', 'resume_worker'].includes(type);
function field(label, tag = 'input', value = '') {
  const wrap = el('label', label, 'hook-field'), input = el(tag);
  input.setAttribute('aria-label', label); input.value = value ?? ''; wrap.append(input);
  return { wrap, input };
}
function select(label, options, value) {
  const item = field(label, 'select');
  for (const [id, text] of options) { const option = el('option', text); option.value = id; item.input.append(option); }
  item.input.value = value ?? options[0]?.[0] ?? ''; return item;
}
function checked(label, initial = false) {
  const wrap = el('label', undefined, 'hook-check'), input = el('input'); input.type = 'checkbox'; input.checked = initial;
  input.setAttribute('aria-label', label); wrap.append(input, el('span', label)); return { wrap, input };
}
function conditions(label, entries, chosen) {
  const node = el('fieldset', undefined, 'hook-conditions'); node.append(el('legend', label));
  const checks = Object.entries(entries).map(([id, text]) => {
    const entry = checked(typeof text === 'object' ? text.label : text, chosen?.includes(id)); node.append(entry.wrap); return [id, entry.input];
  });
  return { node, collect: () => checks.filter(([, input]) => input.checked).map(([id]) => id) };
}

/** Declarative editor. Trigger/action IDs and compatibility come exclusively from the catalogue. */
export function createHookForm(catalogue, { initial = {}, ownsPage = () => true, workerId = null, failedSelf = false, copying = false, onChange = () => {} } = {}) {
  const node = el('div', undefined, 'hook-form');
  const name = field('Hook 名称', 'input', initial.name); name.input.maxLength = 120;
  const trigger = select('触发节点', (catalogue.triggers || []).filter(t => !failedSelf || t.id === SCHEDULED).map(t => [t.id, t.label]), initial.trigger);
  const mode = select('挂载方式', [['once', '一次性'], ['persistent', '持续']], initial.mode || 'once');
  const enabled = checked('启用此 Hook', !copying && initial.enabled !== false); enabled.input.disabled = copying;
  const triggerHelp = el('p', undefined, 'hint');
  node.append(name.wrap, trigger.wrap, triggerHelp, mode.wrap, enabled.wrap);
  const scheduleNode = el('fieldset', undefined, 'hook-schedule'); scheduleNode.append(el('legend', '定时提交'));
  const kind = select('定时周期', [['once', '指定日期执行一次'], ['daily', '每日固定时间']], initial.schedule?.kind || 'once');
  const timezone = field('时区（IANA）', 'input', initial.schedule?.timezone || browserTimezone());
  let initialLocal = '';
  if (initial.schedule?.at) { try { initialLocal = scheduledWallTime(initial.schedule.at, timezone.input.value); } catch {} }
  const date = field('执行日期和时间（所选时区）', 'input', initialLocal); date.input.type = 'datetime-local'; date.input.step = '1';
  const time = field('每日提交时间（所选时区）', 'input', initial.schedule?.time || '00:05'); time.input.type = 'time'; time.input.step = '60';
  scheduleNode.append(kind.wrap, timezone.wrap, date.wrap, time.wrap,
    el('p', '到点提交非阻塞动作，安全点尽早执行；不保证 Agent 准点开始。项目后台停机期间错过的时间跳过，不自动启动已停止项目，也不自动判断额度恢复。每日夏令时回拨只触发首次，跳时不存在的时间跳过当天。', 'hint'));
  node.append(scheduleNode);
  const statuses = conditions('Worker 状态条件（不选表示不限）', STATUS, initial.conditions?.statuses);
  const integrations = conditions('合并状态条件（不选表示不限）', { none: '无集成', ...INTEGRATION }, initial.conditions?.integrations);
  const modeHelp = el('p', undefined, 'hint'); node.append(modeHelp, statuses.node, integrations.node);
  const rows = [], actionsNode = el('div', undefined, 'hook-action-list'); node.append(el('h3', '按顺序执行的动作'), actionsNode);
  const error = el('p', undefined, 'error'); error.setAttribute('role', 'alert'); node.append(error);
  let pending = false, disabledBeforeBusy = null;
  const isScheduled = () => trigger.input.value === SCHEDULED;
  const allowed = () => (catalogue.actions || []).filter(a => !a.builtin_only && (!a.triggers?.length || a.triggers.includes(trigger.input.value))
    && (!failedSelf || ['retry_worker', 'notify'].includes(a.type)));
  const modesFor = action => action?.modes_by_trigger?.[trigger.input.value] ?? action?.modes
    ?? (['create_worker', 'message'].includes(action?.type) ? ['once'] : ['once', 'persistent']);
  const agentCall = () => rows.some(row => row.type.input.value === 'create_worker' ? row.start.input.checked
    : catalogue.actions?.find(action => action.type === row.type.input.value)?.agent_call === true);
  const collectSchedule = () => {
    // Metadata-only edits preserve an exact existing instant, including milliseconds
    // and an originally explicit offset resolving a repeated wall-clock time.
    if (initialLocal && kind.input.value === 'once' && initial.schedule?.kind === 'once' && date.input.value === initialLocal
      && timezone.input.value.trim() === initial.schedule.timezone) return { ...initial.schedule };
    return hookSchedule(kind.input.value, date.input.value, time.input.value, timezone.input.value);
  };
  function addRow(initialAction = {}) {
    if (rows.length >= 4) return;
    const row = { initial: initialAction, node: el('fieldset', undefined, 'hook-action'), profileForm: null, profilePending: false };
    row.node.append(el('legend', `动作 ${rows.length + 1}`));
    row.type = select('动作类型', allowed().map(a => [a.type, a.label]), initialAction.type || (failedSelf ? 'retry_worker' : undefined));
    row.command = field('Shell 命令', 'textarea', initialAction.command); row.command.input.rows = 5;
    row.command.input.spellcheck = false; row.command.input.classList.add('hook-command-input');
    row.body = field('消息或告知正文', 'textarea', initialAction.body); row.body.input.rows = 4;
    row.title = field('告知标题', 'input', initialAction.title);
    row.target = field('目标 Worker 内部 ID（仅当前或直接父子）', 'input', failedSelf ? workerId : initialAction.target_id ?? workerId ?? ''); row.target.input.type = 'number'; row.target.input.min = '1';
    row.content = field('新 Worker 指令', 'textarea', initialAction.content); row.content.input.rows = 5;
    row.start = checked('创建后立即开始 Agent', initialAction.start !== false);
    row.note = el('p', undefined, 'hint'); row.profileHost = el('div', undefined, 'hook-profile');
    row.configure = button('设置预约 Worker 的运行参数', async () => {
      if (row.profilePending || row.profileForm || !ownsPage()) return;
      const configuredType = row.type.input.value;
      row.profilePending = true; paintRow(row);
      try {
        const settings = await api('/api/agent/config'); if (!ownsPage() || !rows.includes(row) || row.type.input.value !== configuredType) return;
        const profile = row.initial.type === configuredType && row.initial.profile ? row.initial.profile : settings.resolved?.agent || settings.default || {};
        row.profileForm = createProfileForm({ profile, settings, role: 'agent', ownsPage, applyDefaultModelOnChange: true });
        row.profileHost.replaceChildren(row.profileForm.node);
        await row.profileForm.ready;
        if (!ownsPage() || !rows.includes(row) || row.type.input.value !== configuredType) return;
        paintRow(row);
      } catch (failure) { if (ownsPage()) error.textContent = `运行设置读取失败：${failure.message}`; }
      finally { row.profilePending = false; paintRow(row); }
    }, 'ghost hook-button', { help: '按需读取项目配置作为新覆盖的编辑起点；保存将替换目标的完整运行设置。不会回读目标或模板的私有 Prompt/env，不调用 Agent。' });
    // button() releases its temporary click lock unconditionally; restore this
    // form's persistent disabled state after the wrapper has settled.
    const configureClick = row.configure.onclick;
    row.configure.onclick = async () => { await configureClick(); paintRow(row); };
    row.configureHost = el('span', undefined, 'help-host'); row.configureHost.append(row.configure);
    row.remove = button('移除动作', () => {
      const at = rows.indexOf(row); if (at < 0) return; rows.splice(at, 1); row.node.remove(); repaint();
    }, 'ghost hook-button', { help: '只移除此表单中尚未保存的动作；不撤销已经发出的消息或交付。' });
    row.node.append(row.type.wrap, row.note, row.title.wrap, row.target.wrap, row.body.wrap, row.command.wrap, row.content.wrap, row.start.wrap, row.configureHost, row.profileHost, row.remove);
    row.type.input.onchange = () => { paintRow(row); repaint(); };
    row.target.input.oninput = () => paintRow(row);
    row.start.input.onchange = repaint;
    rows.push(row); actionsNode.append(row.node); paintRow(row); repaint();
  }
  function paintRow(row) {
    const type = row.type.input.value;
    if (row.paintedType && row.paintedType !== type) { row.profileForm = null; row.profileHost.replaceChildren(); }
    row.paintedType = type;
    row.command.wrap.hidden = type !== 'command';
    row.title.wrap.hidden = type !== 'notify'; row.target.wrap.hidden = !targetAction(type); row.body.wrap.hidden = !['notify', 'message'].includes(type);
    row.target.input.disabled = pending || failedSelf;
    row.content.wrap.hidden = type !== 'create_worker'; row.start.wrap.hidden = type !== 'create_worker'; row.configureHost.hidden = !profileAction(type); row.profileHost.hidden = !profileAction(type);
    row.configure.textContent = type === 'create_worker' ? '设置预约 Worker 的运行参数' : '显式覆盖目标 Worker 的运行参数';
    row.configure.disabled = pending || row.profilePending || Boolean(row.profileForm);
    row.configureHost.tabIndex = row.configure.disabled ? 0 : -1;
    row.configureHost.setAttribute('data-help', row.profilePending ? '运行设置正在读取，请稍后。' : row.profileForm ? '完整运行覆盖已展开，请在下方编辑。' : row.configure.getAttribute('data-help'));
    const description = catalogue.actions?.find(a => a.type === type)?.description || '';
    const preserved = !copying && initial.id && row.initial.type === type;
    row.note.textContent = type === 'command' ? `${description} ${COMMAND_WARNING}` : type === 'create_worker' ? `${description} ${preserved
      ? '未重新设置且动作位置不变时保留模板已保存的私有运行覆盖；不会回读 Prompt/env。'
      : '未单独设置时，挂载时冻结有效项目默认；不回读已有私有运行覆盖。'}`
      : targetAction(type) ? `${description} 目标：${workerLabel(Number(row.target.input.value), Number(row.target.input.value) === row.initial.target_id ? row.initial.target_worker_number : undefined)}。此处填写内部整数 ID，不把 W 编号当作 ID。${type === 'message'
        ? '追加输入只使用目标 Worker 现有运行设置，不自动切换账号或唤醒失败的 Worker。'
        : `${preserved ? '位置与类型不变时保留模板已有私有覆盖；否则' : ''}未显式覆盖就沿用目标 Worker 已有运行设置，不隐式换账号。只有目标${type === 'retry_worker' ? '失败' : '已暂停'}时执行，其他状态跳过；不自动判断额度恢复。显式覆盖从项目配置起步，会替换完整设置而非只换模型。`}` : description;
    if (copying && profileAction(type)) row.note.textContent += ' 复制不复制私有运行覆盖或执行记录；请显式设置新的完整运行参数。';
    if (row.profileForm) row.note.textContent += ' 已展开的完整运行覆盖将写入此动作；可以显式选择模型来源，不复制凭证。';
  }
  const add = button('添加动作', () => addRow(), 'ghost hook-button', { help: '最多组合四个目录允许的动作，按此处顺序执行；Shell 命令需要明确授权。' });
  const addHost = el('span', undefined, 'help-host'); addHost.append(add); node.append(addHost);
  const addClick = add.onclick; add.onclick = async () => { await addClick(); repaint(); };
  function repaint() {
    add.disabled = pending || rows.length >= 4;
    addHost.tabIndex = add.disabled ? 0 : -1;
    addHost.setAttribute('data-help', rows.length >= 4 ? '每条 Hook 最多四个动作；请先移除一个动作。' : add.getAttribute('data-help'));
    triggerHelp.textContent = catalogue.triggers?.find(t => t.id === trigger.input.value)?.description || '';
    scheduleNode.hidden = !isScheduled(); date.wrap.hidden = kind.input.value !== 'once'; time.wrap.hidden = kind.input.value !== 'daily';
    const supported = ['once', 'persistent'].filter(candidate => rows.every(row => modesFor(catalogue.actions?.find(item => item.type === row.type.input.value)).includes(candidate)));
    const previous = mode.input.value, desired = isScheduled() ? kind.input.value === 'daily' ? 'persistent' : 'once' : previous;
    const options = isScheduled() ? [desired] : supported;
    mode.input.replaceChildren(...options.map(id => { const option = el('option', id === 'once' ? '一次性' : '持续'); option.value = id; return option; }));
    mode.input.value = options.includes(desired) ? desired : options[0] || '';
    mode.input.disabled = pending || isScheduled() || supported.length < 2;
    modeHelp.textContent = isScheduled() ? '一次性或每日由定时周期决定。每条规则最多保留一项待执行动作，受阻不累计补跑；到点提交不等于 Agent 已开始。'
      : rows.some(row => row.type.input.value === 'message') ? '消息动作只允许一次性，避免返回→消息→调用的无限付费循环。'
        : rows.some(row => row.type.input.value === 'create_worker') ? '预约创建 Worker 只允许一次性，避免重复创建。' : '组合规则只能使用所有动作共同支持的挂载方式。';
    for (const row of rows) paintRow(row);
    onChange(enabled.input.checked && agentCall());
  }
  enabled.input.onchange = repaint;
  kind.input.onchange = repaint;
  trigger.input.onchange = () => {
    for (const row of rows) {
      const previous = row.type.input.value, choices = allowed();
      row.type.input.replaceChildren(...choices.map(a => { const option = el('option', a.label); option.value = a.type; return option; }));
      row.type.input.value = choices.some(a => a.type === previous) ? previous : choices[0]?.type ?? '';
      paintRow(row);
    }
    repaint();
  };
  for (const action of initial.actions?.length ? initial.actions : [{}]) addRow(action);
  repaint();
  return {
    node, agentCall, enabled: () => !copying && enabled.input.checked,
    validate() {
      error.textContent = '';
      let message = '';
      if (!name.input.value.trim()) message = '请填写 Hook 名称。';
      else if (!catalogue.triggers?.some(t => t.id === trigger.input.value) || (failedSelf && !isScheduled())) message = '请选择后台支持的触发节点。';
      else if (!rows.length) message = '至少配置一个动作。';
      if (!message && isScheduled()) { try { collectSchedule(); } catch (failure) { message = failure.message; } }
      if (!message && failedSelf && !rows.some(row => row.type.input.value === 'retry_worker')) message = '失败 Worker 只允许定时重试自身，可组合纯告知。';
      if (!message) for (const row of rows) {
        const type = row.type.input.value, action = allowed().find(a => a.type === type);
        if (!action) message = '此触发节点不支持所选动作。';
        else if (!modesFor(action).includes(mode.input.value)) message = '此挂载方式不受所选动作支持。';
        else if (type === 'notify' && (!row.title.input.value.trim() || !row.body.input.value.trim())) message = '请填写告知标题和正文。';
        else if (targetAction(type) && (!Number.isSafeInteger(Number(row.target.input.value)) || Number(row.target.input.value) < 1
          || (failedSelf && Number(row.target.input.value) !== workerId))) message = '请填写有效目标 Worker 内部整数 ID；失败 Worker 只能重试自身。';
        else if (type === 'message' && !row.body.input.value.trim()) message = '请填写消息正文和有效目标 Worker 内部整数 ID。';
        else if (type === 'command' && !row.command.input.value.trim()) message = '请填写 Shell 命令。';
        else if (copying && profileAction(type) && !row.profileForm) message = '复制私有运行覆盖动作时，请显式设置新的完整运行参数，不能从安全摘要重建。';
        else if (type === 'create_worker' && !row.content.input.value.trim()) message = '请填写新 Worker 指令。';
        else if (profileAction(type) && initial.id && !row.profileForm && !(row.initial.type === type && row.initial.profile)
          && (initial.actions?.[rows.indexOf(row)] !== row.initial || row.initial.type !== type)) message = type === 'create_worker'
            ? '新增或移动创建动作时，请显式设置运行参数；已有模板的私有覆盖不能从安全读面重建。'
            : '新增、移动或改变运行覆盖动作时，请显式设置运行参数；已有模板的私有覆盖不能从安全读面重建。';
        else if (row.profilePending) message = '运行设置尚在读取，请稍后确认。';
        else if (profileAction(type) && row.profileForm) message = row.profileForm.validate() || '';
        if (message) break;
      }
      error.textContent = message; return message;
    },
    collect() {
      return { name: name.input.value.trim(), trigger: trigger.input.value, mode: mode.input.value, enabled: !copying && enabled.input.checked,
        ...(isScheduled() ? { schedule: collectSchedule() } : {}),
        conditions: { statuses: statuses.collect(), integrations: integrations.collect() }, actions: rows.map(row => {
          const type = row.type.input.value;
          if (type === 'command') return { type, command: row.command.input.value };
          if (type === 'notify') return { type, title: row.title.input.value, body: row.body.input.value };
          if (type === 'message') return { type, target_id: Number(row.target.input.value), body: row.body.input.value };
          const profile = row.profileForm ? { profile: row.profileForm.collect() } : row.initial.type === type && row.initial.profile ? { profile: row.initial.profile } : {};
          if (type === 'create_worker') return { type, content: row.content.input.value, references: row.initial.references || [], start: row.start.input.checked, ...profile };
          if (['retry_worker', 'resume_worker'].includes(type)) return { type, target_id: Number(row.target.input.value), ...profile };
          return { type };
        }) };
    },
    // Prompt replacement gets the same explicit risk confirmation as ordinary creation.
    replacesPrompt: () => rows.some(row => profileAction(row.type.input.value) && row.profileForm && row.profileForm.mode() !== 'pi' && row.profileForm.defaultPromptValue().trim()
      && row.profileForm.defaultPromptValue().trim() !== row.profileForm.builtInPrompt.trim()),
    setBusy(value) {
      if (value && !pending) {
        disabledBeforeBusy = new Map(['input', 'select', 'textarea', 'button'].flatMap(tag => [...node.querySelectorAll(tag)]).map(input => [input, input.disabled]));
        for (const input of disabledBeforeBusy.keys()) input.disabled = true;
      } else if (!value && pending) { for (const [input, disabled] of disabledBeforeBusy || []) input.disabled = disabled; disabledBeforeBusy = null; }
      pending = value; repaint();
    },
  };
}
