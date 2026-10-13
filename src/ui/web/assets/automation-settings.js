import { el, button } from './dom.js';
import { api, action } from './api.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { automationMetadata, DISPLAY_PRINCIPLES, AUTOMATION_METADATA } from './automation-features.js';

export function validAutomationSettings(value) {
  return value?.version === 1 && typeof value.revision === 'string' && value.revision.length > 0
    && typeof value.completion_defaults?.enabled === 'boolean' && ['merge', 'accept'].includes(value.completion_defaults.level)
    && typeof value.acceptance_notice_defaults?.enabled === 'boolean'
    && AUTOMATION_METADATA.every(({ id }) => DISPLAY_PRINCIPLES.some(item => item.value === value.display_principles?.[id]));
}
const acceptanceHelp = '仅授权本项目之后实际创建的用户 Worker：自动合并后安全验收，验收即归档并回收其分支子树的 worktree/ref，保留 Worker、会话及运行历史，脏改动阻止验收。自动验收不是质量评审；不修改已有 Worker，child 的锁定流程不继承验收授权。';

/** A retained feature editor: own revision, no Worker enumeration or execution reads. */
export function renderAutomationSettings({ feature, catalogue: initial = null, ownsPage = () => true }) {
  const metadata = automationMetadata(feature), root = el('section', undefined, `automation-settings automation-${feature.replace('_', '-')}`);
  root.dataset.featureSettings = feature;
  const controls = el('div', undefined, 'automation-settings-controls'), extras = el('div', undefined, 'automation-settings-extra');
  const status = el('p', undefined, 'hint automation-settings-status'); status.setAttribute('role', 'status');
  let model = null, draft = null, disposed = false, busy = false, uncertain = false, late = false, generation = 0, controller = null;
  const owns = () => !disposed && ownsPage();
  const field = (label, options) => {
    const wrap = el('label', label, 'hook-field'), input = el('select'); input.setAttribute('aria-label', label);
    for (const [value, text] of options) { const option = el('option', text); option.value = value; input.append(option); }
    wrap.append(input); return { wrap, input };
  };
  const display = field('默认显示原则', DISPLAY_PRINCIPLES.map(({ value, label }) => [value, label]));
  let defaults = null;
  if (feature === 'completion') defaults = field('用户新建 Worker 默认开启到', [['off', '关闭'], ['merge', '自动到合并'], ['accept', '自动到验收']]);
  if (feature === 'acceptance_notice') defaults = field('用户新建 Worker 默认待验收告知', [['on', '开启'], ['off', '关闭']]);
  if (defaults) controls.append(defaults.wrap);
  controls.append(display.wrap, el('p', '仅决定 Worker 自动化模块是否需要展开才能看到；不会启用功能、改变授权或隐藏异常。非 Worker 自动创建指用户新建的指令（及 main），不含派生 child。', 'hint'));
  if (feature === 'completion') controls.append(el('p', '仅之后实际创建的新用户 Worker 生效，不修改已有授权。child 默认锁定自动合并，不继承用户指令的验收授权；验收包含安全资源回收，不保证业务质量。', 'hint'));
  if (feature === 'acceptance_notice') controls.append(el('p', '仅影响之后创建的用户 Worker；派生 child 默认关闭，可在对应 Worker 独立开启。关闭不删除历史或屏蔽异常、未知结果与待决；自动验收成功保持静默。', 'hint'));
  const selected = () => feature === 'completion' ? draft?.completion_defaults : feature === 'acceptance_notice' ? draft?.acceptance_notice_defaults : null;
  function snapshot(value) {
    return { display: value.display_principles[feature], completion_defaults: { ...value.completion_defaults }, acceptance_notice_defaults: { ...value.acceptance_notice_defaults } };
  }
  function patch() {
    const result = { display_principles: { [feature]: draft.display } };
    if (feature === 'completion') result.completion_defaults = { ...draft.completion_defaults };
    if (feature === 'acceptance_notice') result.acceptance_notice_defaults = { ...draft.acceptance_notice_defaults };
    return result;
  }
  function dirty() {
    if (!model || !draft) return false;
    const saved = snapshot(model), key = feature === 'completion' ? 'completion_defaults' : feature === 'acceptance_notice' ? 'acceptance_notice_defaults' : null;
    return saved.display !== draft.display || key && JSON.stringify(saved[key]) !== JSON.stringify(draft[key]);
  }
  function sync() {
    if (!owns()) return;
    const blocked = busy || uncertain || !model;
    display.input.disabled = blocked; display.input.value = draft?.display ?? '';
    if (defaults) {
      defaults.input.disabled = blocked;
      defaults.input.value = !draft ? '' : feature === 'completion' ? selected().enabled ? selected().level : 'off' : selected().enabled ? 'on' : 'off';
    }
    save.disabled = blocked || !dirty(); reload.disabled = busy;
    const agent = feature === 'completion' && selected()?.enabled === true;
    save.classList.toggle('agent-call', agent);
    const help = agent ? agentHelp(`保存本项目未来 Worker 的自动流程授权，未来合并分歧可能调用 Agent。${selected().level === 'accept' ? acceptanceHelp : ''}`)
      : '只保存本项目未来 Worker 默认及展示原则，不修改已有 Worker 的授权，不执行功能。';
    save.setAttribute('data-help', help);
    saveHost.setAttribute('data-help', `${busy ? '正在读取或保存。' : uncertain ? '保存结果未确认，先重新读取核查，勿重发。' : !model ? '设置读面不可用，请更新服务。' : !dirty() ? '没有未保存更改。' : ''} ${help}`);
    saveHost.tabIndex = save.disabled ? 0 : -1;
    reloadHost.setAttribute('data-help', busy ? '正在读取或保存，请稍候。' : '只读核对项目策略；有草稿时先确认放弃，不自动重发未确认的保存。');
    reloadHost.tabIndex = reload.disabled ? 0 : -1;
    root.setAttribute('aria-busy', String(busy));
  }
  function receive(catalogue) {
    if (!owns()) return false;
    const value = catalogue?.automation_settings;
    if (!validAutomationSettings(value)) { uncertain = true; status.textContent = '项目自动化设置不可用或版本不兼容，请更新项目后台与界面服务后重新读取；不使用假默认值覆盖配置。'; status.className = 'error automation-settings-status'; sync(); return false; }
    model = value; draft = snapshot(value); uncertain = false;
    status.textContent = '已读取本项目设置；默认值只影响未来创建，展示原则不改变权限。'; status.className = 'hint automation-settings-status'; sync(); return true;
  }
  async function load() {
    if (!owns() || busy) return;
    if (dirty() && !await confirmDialog({ title: '放弃未保存设置并重新读取？', message: '重新读取本项目的权威策略，当前未保存选择会丢失；不会重发任何操作。', confirmLabel: '放弃并读取' })) return;
    if (!owns()) return;
    const request = ++generation; controller = new AbortController(); busy = true; sync();
    try { const value = await api('/api/hooks', { signal: controller.signal }); if (owns() && request === generation) receive(value); }
    catch (error) { if (owns() && request === generation && error.name !== 'AbortError') { status.textContent = `设置读取失败：${error.message}；草稿及原 revision 保留。`; status.className = 'error automation-settings-status'; } }
    finally { if (request === generation) { busy = false; controller = null; sync(); } }
  }
  const save = button('保存项目设置', async () => {
    if (!owns() || busy || uncertain || !model || !dirty()) return;
    const request = ++generation, params = { patch: patch(), expected_revision: model.revision };
    busy = true; sync(); let submitted = false;
    try {
      if (feature === 'completion' && selected().enabled && selected().level === 'accept'
        && !await confirmDialog({ title: '授权本项目未来 Worker 自动到验收？', message: acceptanceHelp,
          confirmLabel: '授权并保存', danger: true, agent: true, confirmHelp: agentHelp(acceptanceHelp) })) return;
      if (!owns()) return;
      submitted = true;
      const result = await action('hooks.automation_settings', params, { refresh: false });
      if (!owns() || request !== generation) { uncertain = true; late = true; return; }
      const value = result?.automation_settings;
      if (!validAutomationSettings(value) || value.display_principles[feature] !== params.patch.display_principles[feature]
        || feature === 'completion' && JSON.stringify(value.completion_defaults) !== JSON.stringify(params.patch.completion_defaults)
        || feature === 'acceptance_notice' && value.acceptance_notice_defaults.enabled !== params.patch.acceptance_notice_defaults.enabled) throw new Error('保存响应未确认');
      receive(result); status.textContent = '项目设置已保存；已有 Worker 授权未修改。';
    } catch (error) {
      uncertain = submitted;
      if (owns() && request === generation) { status.textContent = `${error.message}；草稿及原 revision 保留，请重新读取核查，不自动重发。`; status.className = 'error automation-settings-status'; }
    } finally { if (request === generation) { busy = false; sync(); } }
  }, 'primary');
  const saveHost = el('span', undefined, 'help-host'); saveHost.append(save);
  const reload = button('重新读取项目设置', load, 'ghost'), reloadHost = el('span', undefined, 'help-host'); reloadHost.append(reload);
  for (const control of [save, reload]) { const click = control.onclick; control.onclick = async () => { await click(); sync(); }; }
  display.input.onchange = () => { if (owns() && !display.input.disabled && draft) { draft.display = display.input.value; sync(); } };
  if (defaults) defaults.input.onchange = () => {
    if (!owns() || defaults.input.disabled || !draft) return;
    if (feature === 'completion') { draft.completion_defaults.enabled = defaults.input.value !== 'off'; if (defaults.input.value !== 'off') draft.completion_defaults.level = defaults.input.value; }
    else draft.acceptance_notice_defaults.enabled = defaults.input.value === 'on';
    sync();
  };
  root.append(el('p', `功能简介：${metadata.description}`, 'automation-feature-description'), el('p', `原理简介：${metadata.principle}`, 'hint'),
    el('p', '设置作用域：当前项目。具体 Worker 的开关／最高环节请到其自动化模块查看。', 'hint'), controls, status, saveHost, reloadHost, extras);
  root.extra = extras;
  root.setSubpage = () => { if (owns() && late) { status.textContent = '离开期间的保存结果尚未核对；草稿保留，请重新读取设置，勿重复提交。'; status.className = 'error automation-settings-status'; late = false; } sync(); return root.ready; };
  root.setActive = active => { if (active) root.setSubpage(); };
  root.updateCatalogue = value => { if (!dirty() && !busy && !uncertain) receive(value); };
  root.dispose = () => { disposed = true; ++generation; controller?.abort(); };
  if (initial) { receive(initial); root.ready = Promise.resolve(); } else root.ready = load();
  return root;
}
