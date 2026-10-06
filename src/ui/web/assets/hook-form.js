import { el, button } from './dom.js';
import { api } from './api.js';
import { createProfileForm } from './agent-profile-form.js';
import { STATUS, INTEGRATION } from './format.js';
import { workerLabel } from './worker-label.js';

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
export function createHookForm(catalogue, { initial = {}, ownsPage = () => true, workerId = null, onChange = () => {} } = {}) {
  const node = el('div', undefined, 'hook-form');
  const name = field('Hook 名称', 'input', initial.name); name.input.maxLength = 120;
  const trigger = select('触发节点', (catalogue.triggers || []).map(t => [t.id, t.label]), initial.trigger);
  const mode = select('挂载方式', [['once', '一次性'], ['persistent', '持续']], initial.mode || 'once');
  const enabled = checked('启用此 Hook', initial.enabled !== false);
  const triggerHelp = el('p', undefined, 'hint');
  node.append(name.wrap, trigger.wrap, triggerHelp, mode.wrap, enabled.wrap);
  const statuses = conditions('Worker 状态条件（不选表示不限）', STATUS, initial.conditions?.statuses);
  const integrations = conditions('合并状态条件（不选表示不限）', { none: '无集成', ...INTEGRATION }, initial.conditions?.integrations);
  const modeHelp = el('p', undefined, 'hint'); node.append(modeHelp, statuses.node, integrations.node);
  const rows = [], actionsNode = el('div', undefined, 'hook-action-list'); node.append(el('h3', '按顺序执行的动作'), actionsNode);
  const error = el('p', undefined, 'error'); error.setAttribute('role', 'alert'); node.append(error);
  let pending = false;
  const allowed = () => (catalogue.actions || []).filter(a => !a.builtin_only && (!a.triggers?.length || a.triggers.includes(trigger.input.value)));
  const agentCall = () => rows.some(row => row.type.input.value === 'message' || (row.type.input.value === 'create_worker' && row.start.input.checked) || row.type.input.value === 'request_merge');
  function addRow(initialAction = {}) {
    if (rows.length >= 4) return;
    const row = { initial: initialAction, node: el('fieldset', undefined, 'hook-action'), profileForm: null, profilePending: false };
    row.node.append(el('legend', `动作 ${rows.length + 1}`));
    row.type = select('动作类型', allowed().map(a => [a.type, a.label]), initialAction.type);
    row.body = field('消息或告知正文', 'textarea', initialAction.body); row.body.input.rows = 4;
    row.title = field('告知标题', 'input', initialAction.title);
    row.target = field('目标 Worker 内部 ID（仅当前或直接父子）', 'input', initialAction.target_id ?? workerId ?? ''); row.target.input.type = 'number'; row.target.input.min = '1';
    row.content = field('新 Worker 指令', 'textarea', initialAction.content); row.content.input.rows = 5;
    row.start = checked('创建后立即开始 Agent', initialAction.start !== false);
    row.note = el('p', undefined, 'hint'); row.profileHost = el('div', undefined, 'hook-profile');
    row.configure = button('设置预约 Worker 的运行参数', async () => {
      if (row.profilePending || row.profileForm || !ownsPage()) return;
      row.profilePending = true; row.configure.disabled = true;
      try {
        const settings = await api('/api/agent/config'); if (!ownsPage() || !rows.includes(row)) return;
        const profile = initialAction.profile || settings.resolved?.agent || settings.default || {};
        row.profileForm = createProfileForm({ profile, settings, role: 'agent', ownsPage });
        row.profileHost.replaceChildren(row.profileForm.node);
        await row.profileForm.ready;
        if (!ownsPage() || !rows.includes(row)) return;
        row.note.textContent = '这份完整运行设置只写入预约；配置不调用 Agent，挂载后由安全点创建。';
      } catch (failure) { if (ownsPage()) error.textContent = `运行设置读取失败：${failure.message}`; }
      finally { row.profilePending = false; row.configure.disabled = Boolean(row.profileForm); }
    }, 'ghost hook-button', { help: '按需读取当前项目配置并编辑完整运行参数；不读取已有预约的私有 Prompt/env，不调用 Agent。' });
    row.remove = button('移除动作', () => {
      const at = rows.indexOf(row); if (at < 0) return; rows.splice(at, 1); row.node.remove(); repaint();
    }, 'ghost hook-button', { help: '只移除此表单中尚未保存的动作；不撤销已经发出的消息或交付。' });
    row.node.append(row.type.wrap, row.note, row.title.wrap, row.target.wrap, row.body.wrap, row.content.wrap, row.start.wrap, row.configure, row.profileHost, row.remove);
    row.type.input.onchange = () => { paintRow(row); repaint(); };
    row.target.input.oninput = () => paintRow(row);
    row.start.input.onchange = repaint;
    rows.push(row); actionsNode.append(row.node); paintRow(row); repaint();
  }
  function paintRow(row) {
    const type = row.type.input.value;
    row.title.wrap.hidden = type !== 'notify'; row.target.wrap.hidden = type !== 'message'; row.body.wrap.hidden = !['notify', 'message'].includes(type);
    row.content.wrap.hidden = type !== 'create_worker'; row.start.wrap.hidden = type !== 'create_worker'; row.configure.hidden = type !== 'create_worker'; row.profileHost.hidden = type !== 'create_worker';
    const description = catalogue.actions?.find(a => a.type === type)?.description || '';
    row.note.textContent = type === 'create_worker' ? `${description} ${initial.id && row.initial.type === 'create_worker'
      ? '未重新设置且动作位置不变时保留模板已保存的私有运行覆盖；不会回读 Prompt/env。'
      : '未单独设置时，挂载时冻结有效项目默认；不回读已有私有运行覆盖。'}`
      : type === 'message' ? `${description} 目标：${workerLabel(Number(row.target.input.value), Number(row.target.input.value) === row.initial.target_id ? row.initial.target_worker_number : undefined)}。此处填写内部整数 ID，不把 W 编号当作 ID。` : description;
  }
  const add = button('添加动作', () => addRow(), 'ghost hook-button', { help: '最多组合四个受控动作，按此处顺序执行；不执行脚本。' }); node.append(add);
  function repaint() {
    add.disabled = rows.length >= 4;
    triggerHelp.textContent = catalogue.triggers?.find(t => t.id === trigger.input.value)?.description || '';
    const supported = ['once', 'persistent'].filter(candidate => rows.every(row => {
      const action = catalogue.actions?.find(item => item.type === row.type.input.value);
      const modes = action?.modes || (['create_worker', 'message'].includes(row.type.input.value) ? ['once'] : ['once', 'persistent']);
      return modes.includes(candidate);
    }));
    const previous = mode.input.value;
    mode.input.replaceChildren(...supported.map(id => { const option = el('option', id === 'once' ? '一次性' : '持续'); option.value = id; return option; }));
    mode.input.value = supported.includes(previous) ? previous : supported[0] || '';
    mode.input.disabled = supported.length < 2;
    modeHelp.textContent = rows.some(row => row.type.input.value === 'message') ? '消息动作只允许一次性，避免返回→消息→调用的无限付费循环。'
      : rows.some(row => row.type.input.value === 'create_worker') ? '预约创建 Worker 只允许一次性，避免重复创建。' : '组合规则只能使用所有动作共同支持的挂载方式。';
    onChange(agentCall());
  }
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
    node, agentCall,
    validate() {
      error.textContent = '';
      let message = '';
      if (!name.input.value.trim()) message = '请填写 Hook 名称。';
      else if (!catalogue.triggers?.some(t => t.id === trigger.input.value)) message = '请选择后台支持的触发节点。';
      else if (!rows.length) message = '至少配置一个动作。';
      else for (const row of rows) {
        const type = row.type.input.value;
        const action = allowed().find(a => a.type === type);
        if (!action) message = '此触发节点不支持所选动作。';
        else if (!(action.modes || (['create_worker', 'message'].includes(type) ? ['once'] : ['once', 'persistent'])).includes(mode.input.value)) message = '此挂载方式不受所选动作支持。';
        else if (type === 'notify' && (!row.title.input.value.trim() || !row.body.input.value.trim())) message = '请填写告知标题和正文。';
        else if (type === 'message' && (!Number.isSafeInteger(Number(row.target.input.value)) || Number(row.target.input.value) < 1 || !row.body.input.value.trim())) message = '请填写消息正文和有效目标 Worker 内部整数 ID。';
        else if (type === 'create_worker' && !row.content.input.value.trim()) message = '请填写新 Worker 指令。';
        else if (type === 'create_worker' && initial.id && !row.profileForm && !row.initial.profile
          && initial.actions?.[rows.indexOf(row)]?.type !== 'create_worker') message = '新增或移动创建动作时，请显式设置运行参数；已有模板的私有覆盖不能从安全读面重建。';
        else if (row.profilePending) message = '运行设置尚在读取，请稍后确认。';
        else if (type === 'create_worker' && row.profileForm) message = row.profileForm.validate() || '';
        if (message) break;
      }
      error.textContent = message; return message;
    },
    collect() {
      return { name: name.input.value.trim(), trigger: trigger.input.value, mode: mode.input.value, enabled: enabled.input.checked,
        conditions: { statuses: statuses.collect(), integrations: integrations.collect() }, actions: rows.map(row => {
          const type = row.type.input.value;
          if (type === 'notify') return { type, title: row.title.input.value, body: row.body.input.value };
          if (type === 'message') return { type, target_id: Number(row.target.input.value), body: row.body.input.value };
          if (type === 'create_worker') return { type, content: row.content.input.value, references: row.initial.references || [], start: row.start.input.checked,
            ...(row.profileForm ? { profile: row.profileForm.collect() } : row.initial.profile ? { profile: row.initial.profile } : {}) };
          return { type };
        }) };
    },
    // Prompt replacement gets the same explicit risk confirmation as ordinary creation.
    replacesPrompt: () => rows.some(row => row.profileForm && row.profileForm.mode() !== 'pi' && row.profileForm.defaultPromptValue().trim()
      && row.profileForm.defaultPromptValue().trim() !== row.profileForm.builtInPrompt.trim()),
    setBusy(value) { pending = value; for (const input of ['input', 'select', 'textarea', 'button'].flatMap(tag => [...node.querySelectorAll(tag)])) input.disabled = pending; if (!pending) repaint(); },
  };
}
