import { button, el } from './dom.js';
import { confirmDialog } from './dialog.js';
import { workbenchStatus } from './project-picker.js';
import { projectSettingsAction } from './settings-api.js';

export const scopeLabel = scope => scope === 'device' ? '设备共享' : '本项目覆盖';
export const scopeImpact = scope => scope === 'device'
  ? '保存在运行 Lush 的机器上，供同一系统用户的项目共享；影响继承项目的后续调用，不打断在途调用。'
  : '仅改变当前项目；Worker 显式覆盖优先。清除项目覆盖后继承设备默认，不改变其他项目。';

/** Capture the owning pane's editable values before an asynchronous save. */
export function draftFingerprint(node) {
  let root = node;
  for (let parent = node; parent; parent = parent.parentNode) {
    if (parent.classList?.contains('agent-settings') || parent.classList?.contains('settings-scope-pane')) { root = parent; break; }
  }
  return JSON.stringify(['input', 'select', 'textarea'].flatMap(tag => [...root.querySelectorAll(tag)]
    .map(control => [control.value || '', Boolean(control.checked)])));
}

export function scopeSelector(scope, change, { projectLabel = '本项目覆盖', impact = scopeImpact, help } = {}) {
  const root = el('div', undefined, 'settings-scope-control');
  const select = el('select'); select.dataset.settingsScope = ''; select.setAttribute('aria-label', '设置作用域');
  for (const [value, label] of [['device', '设备共享'], ['project', projectLabel]]) {
    const option = el('option', label); option.value = value; option.disabled = value === 'project' && !workbenchStatus().projectUsable;
    select.append(option);
  }
  select.value = scope; select.disabled = !workbenchStatus().projectUsable;
  root.classList.add('help-host'); root.setAttribute('data-help', help || (select.disabled
    ? '未打开项目时只管理运行 Lush 的机器上的设备共享配置；打开项目后才能编辑项目覆盖。'
    : '选择设备共享默认或当前项目独立覆盖；只影响后续调用，Worker 显式配置优先。'));
  const note = el('p', impact(scope), 'hint settings-scope-impact');
  select.onchange = () => { note.textContent = impact(select.value); return change(select.value); };
  root.append(el('span', '编辑范围'), select, note); return root;
}

export function scopeSummary(model, scope) {
  const metadata = model?.configuration_scope;
  const labels = { device: '设备共享默认', project: '本项目独立覆盖', default: '环境 / 内置默认', mixed: '多层默认与覆盖组合' };
  const root = el('p', metadata ? `当前读取：${labels[metadata.source] || '来源未知'}。` : '当前配置来源未报告；请更新后台以查看继承信息。', 'hint settings-scope-summary');
  if (scope === 'device' && metadata?.project_override) root.textContent += ' 本项目仍有独立覆盖，修改共享默认不会替换它；切到“本项目覆盖”查看或清除。';
  if (scope === 'project' && metadata?.project_override) root.textContent += ' Agent、网络和快捷解释按完整文档覆盖；运行参数逐键覆盖。';
  return root;
}

export function clearOverrideButton(kind, reload, { target, ownsPage = () => true, onCleared = () => {} } = {}) {
  const node = button('清除项目覆盖，继承设备设置', async () => {
    if (!ownsPage()) return;
    const accepted = await confirmDialog({ title: '清除本项目覆盖？',
      message: '只清除当前项目这一项设置的独立覆盖，之后继承设备共享默认；其他项目、Worker 显式覆盖和已有历史保留。',
      confirmLabel: '清除并继承', danger: true,
      confirmHelp: '移除当前项目的独立设置；不删除共享默认、Worker 配置、账号或历史，不调用 Agent。' });
    if (!accepted || !ownsPage()) return;
    await projectSettingsAction('settings.clear_override', { kind, ...(target ? { target } : {}) });
    onCleared();
    if (ownsPage()) await reload();
  }, 'ghost danger', { help: '清除当前项目这项独立设置并改为继承设备共享默认；不改 Worker 显式配置或历史，不调用 Agent。' });
  node.dataset.clearOverride = kind; return node;
}
