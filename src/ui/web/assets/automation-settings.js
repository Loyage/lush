import { el, button } from './dom.js';
import { api, action } from './api.js';
import { confirmDialog } from './dialog.js';
import { automationMetadata } from './automation-features.js';
import { MOUNT_SCOPES, completionLevelButtons } from './hook-controls.js';

export function validAutomationSettings(value) {
  return value?.version === 1 && typeof value.revision === 'string' && value.revision.length > 0
    && typeof value.completion_defaults?.enabled === 'boolean' && ['merge', 'accept'].includes(value.completion_defaults.level)
    && typeof value.acceptance_notice_defaults?.enabled === 'boolean'
    && ['completion', 'acceptance_notice'].every(id => MOUNT_SCOPES.some(item => item.value === value.mount_scopes?.[id]));
}
const acceptanceHelp = '仅授权本项目之后实际创建的用户 Worker：自动合并后安全验收，验收即归档并回收其分支子树的 worktree/ref，保留 Worker、会话及运行历史，脏改动阻止验收。自动验收不是质量评审；不修改已有 Worker，child 的锁定流程不继承验收授权。';

/** Retained, revisioned future mount/default editor. Existing authorizations stay untouched. */
export function renderAutomationSettings({ feature, catalogue: initial = null, ownsPage = () => true }) {
  const metadata = automationMetadata(feature), root = el('section', undefined, `automation-settings automation-${feature.replace('_', '-')}`);
  root.dataset.featureSettings = feature;
  const extras = el('div', undefined, 'automation-settings-extra'); root.extra = extras;
  root.append(el('p', `功能简介：${metadata.description}`, 'automation-feature-description'), el('p', `原理简介：${metadata.principle}`, 'hint'),
    el('p', '设置作用域：当前项目。具体 Worker 的开关／最高环节请到其自动化模块查看。', 'hint'));
  // Convergence has one defaults API/revision. Push edits the real main mount.
  if (!['completion', 'acceptance_notice'].includes(feature)) {
    if (feature === 'push') root.append(el('p', '挂载范围：仅 main（只读）。启停的是 main 实际挂载，不设置新 Worker 默认。', 'hint'));
    root.append(extras); root.ready = Promise.resolve(); root.setSubpage = () => root.ready;
    root.setActive = root.updateCatalogue = root.dispose = () => {}; return root;
  }
  const controls = el('div', undefined, 'automation-settings-controls');
  const status = el('p', undefined, 'hint automation-settings-status'); status.setAttribute('role', 'status');
  let model = null, draft = null, disposed = false, busy = false, uncertain = false, late = false, generation = 0, controller = null;
  const owns = () => !disposed && ownsPage();
  const scopeField = el('label', '挂载范围', 'hook-field'), scope = el('select'); scope.setAttribute('aria-label', '挂载范围');
  for (const item of MOUNT_SCOPES) { const option = el('option', item.label); option.value = item.value; scope.append(option); }
  scopeField.append(scope);
  const stateField = el('div', undefined, 'hook-field'); stateField.append(el('span', '挂载后默认状态'));
  const choices = [], key = feature === 'completion' ? 'completion_defaults' : 'acceptance_notice_defaults';
  const level = () => !draft ? null : feature === 'completion' ? draft.defaults.enabled ? draft.defaults.level : 'off' : draft.defaults.enabled ? 'on' : 'off';
  const choose = value => {
    if (!owns() || busy || uncertain || !draft) return;
    draft.defaults.enabled = value !== 'off';
    if (feature === 'completion' && value !== 'off') draft.defaults.level = value;
    sync();
  };
  let group;
  if (feature === 'completion') {
    const buttons = completionLevelButtons('挂载后默认状态', choose); group = buttons.group; choices.push(...buttons.choices);
  } else {
    group = el('div', undefined, 'hook-completion-levels'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', '挂载后默认状态');
    for (const value of ['off', 'on']) {
      const control = button(value === 'on' ? '开启' : '关闭', () => choose(value), 'hook-completion-level'); control.dataset.level = value;
      const host = el('span', undefined, 'help-host'); host.append(control); group.append(host); choices.push({ level: value, control, host });
    }
  }
  stateField.append(group);
  controls.append(scopeField, stateField, el('p', '挂载范围仅影响之后实际创建的适用 Worker，不回写已有挂载或授权；未挂载时不执行。main／分支所有者不适用此功能，选择“仅 main”不会给新开发 Worker 挂载。', 'hint'));
  if (feature === 'completion') controls.append(el('p', '开启默认仅授权新用户指令。child 始终挂载且锁定自动合并，不继承用户指令的验收授权；验收包含安全资源回收，不保证业务质量。', 'hint'));
  else controls.append(el('p', 'child 按挂载范围创建，但默认关闭，可在对应 Worker 独立开启。关闭不删除历史或屏蔽异常、未知结果与待决；自动验收成功保持静默。', 'hint'));
  const snapshot = value => ({ scope: value.mount_scopes[feature], defaults: { ...value[key] } });
  const dirty = () => !!model && !!draft && JSON.stringify(snapshot(model)) !== JSON.stringify(draft);
  const patch = () => ({ mount_scopes: { [feature]: draft.scope }, [key]: { ...draft.defaults } });
  function sync() {
    if (!owns()) return;
    const blocked = busy || uncertain || !model;
    scope.disabled = blocked; scope.value = draft?.scope ?? '';
    for (const { level: value, control, host } of choices) {
      control.disabled = blocked; control.setAttribute('aria-pressed', String(level() === value)); control.classList.toggle('is-selected', level() === value);
      const help = '选择未来挂载的默认状态，保存后生效，不改变已有授权，也不启动新的 Agent。';
      control.setAttribute('data-help', help); host.setAttribute('data-help', help); host.tabIndex = control.disabled ? 0 : -1;
    }
    save.disabled = blocked || !dirty(); reload.disabled = busy;
    const help = `只保存本项目未来 Worker 挂载范围及默认状态，不修改已有授权，不执行功能或启动新的 Agent。${feature === 'completion' && draft?.defaults.level === 'accept' ? acceptanceHelp : ''}`;
    save.setAttribute('data-help', help);
    saveHost.setAttribute('data-help', `${busy ? '正在读取或保存。' : uncertain ? '保存结果未确认，先重新读取核查，勿重发。' : !model ? '设置读面不可用，请更新服务。' : !dirty() ? '没有未保存更改。' : ''} ${help}`);
    saveHost.tabIndex = save.disabled ? 0 : -1;
    reloadHost.setAttribute('data-help', busy ? '正在读取或保存，请稍候。' : '只读核对项目策略；有草稿时先确认放弃，不自动重发未确认的保存。');
    reloadHost.tabIndex = reload.disabled ? 0 : -1; root.setAttribute('aria-busy', String(busy));
  }
  function receive(catalogue) {
    if (!owns()) return false;
    const value = catalogue?.automation_settings;
    if (!validAutomationSettings(value)) { uncertain = true; status.textContent = '项目自动化挂载设置不可用或版本不兼容，请更新项目后台与界面服务后重新读取；不使用假默认值覆盖配置。'; status.className = 'error automation-settings-status'; sync(); return false; }
    model = value; draft = snapshot(value); uncertain = false;
    status.textContent = '已读取本项目设置；挂载范围及默认状态只影响未来创建。'; status.className = 'hint automation-settings-status'; sync(); return true;
  }
  async function load() {
    if (!owns() || busy) return;
    if (dirty() && !await confirmDialog({ title: '放弃未保存设置并重新读取？', message: '重新读取本项目的权威策略，当前未保存选择会丢失；不会重发任何操作。', confirmLabel: '放弃并读取' })) return;
    if (!owns()) return;
    const request = ++generation; controller = new AbortController(); busy = true; sync();
    status.textContent = '正在读取项目设置…'; status.className = 'hint automation-settings-status';
    try { const value = await api('/api/hooks', { signal: controller.signal }); if (owns() && request === generation) receive(value); }
    catch (error) { if (owns() && request === generation && error.name !== 'AbortError') { status.textContent = `设置读取失败：${error.message}；草稿及原 revision 保留。`; status.className = 'error automation-settings-status'; } }
    finally { if (request === generation) { busy = false; controller = null; sync(); } }
  }
  const save = button('保存项目设置', async () => {
    if (!owns() || busy || uncertain || !model || !dirty()) return;
    const request = ++generation, params = { patch: patch(), expected_revision: model.revision };
    busy = true; sync(); let submitted = false;
    try {
      if (feature === 'completion' && draft.defaults.enabled && draft.defaults.level === 'accept'
        && !await confirmDialog({ title: '授权本项目未来 Worker 自动到验收？', message: acceptanceHelp,
          confirmLabel: '授权并保存', danger: true, confirmHelp: acceptanceHelp })) return;
      if (!owns()) return;
      submitted = true; status.textContent = '正在保存项目设置…'; status.className = 'hint automation-settings-status';
      const result = await action('hooks.automation_settings', params, { refresh: false });
      if (!owns() || request !== generation) { uncertain = true; late = true; return; }
      const value = result?.automation_settings;
      if (!validAutomationSettings(value) || value.mount_scopes[feature] !== params.patch.mount_scopes[feature]
        || JSON.stringify(value[key]) !== JSON.stringify(params.patch[key])) throw new Error('保存响应未确认');
      receive(result); status.textContent = '项目设置已保存；已有 Worker 挂载与授权未修改。';
    } catch (error) {
      uncertain = submitted;
      if (owns() && request === generation) { status.textContent = `${error.message}；草稿及原 revision 保留，请重新读取核查，不自动重发。`; status.className = 'error automation-settings-status'; }
    } finally { if (request === generation) { busy = false; sync(); } }
  }, 'primary', { busyLabel: '保存中…' });
  const saveHost = el('span', undefined, 'help-host'); saveHost.append(save);
  const reload = button('重新读取项目设置', load, 'ghost', { busyLabel: '读取中…' }), reloadHost = el('span', undefined, 'help-host'); reloadHost.append(reload);
  for (const control of [save, reload, ...choices.map(item => item.control)]) { const click = control.onclick; control.onclick = async () => { await click(); sync(); }; }
  scope.onchange = () => { if (owns() && !scope.disabled && draft) { draft.scope = scope.value; sync(); } };
  const actions = el('div', undefined, 'actions hook-actions'); actions.append(saveHost, reloadHost);
  root.append(controls, status, actions, extras);
  root.setSubpage = () => { if (owns() && late) { status.textContent = '离开期间的保存结果尚未核对；草稿保留，请重新读取设置，勿重复提交。'; status.className = 'error automation-settings-status'; late = false; } sync(); return root.ready; };
  root.setActive = active => { if (active) root.setSubpage(); };
  root.updateCatalogue = value => { if (!dirty() && !busy && !uncertain) receive(value); };
  root.dispose = () => { disposed = true; ++generation; controller?.abort(); };
  if (initial) { receive(initial); root.ready = Promise.resolve(); } else root.ready = load();
  return root;
}
