import { api } from './api.js';
import { block, button, el } from './dom.js';
import { confirmDialog } from './dialog.js';
import { workbenchStatus } from './project-picker.js';
import { projectSettingsAction } from './settings-api.js';

/** Migration is a project-only user action, never a device mutation or an Agent call. */
export function renderSettingsMigration({ ownsPage = () => true, onMigrated = () => {} } = {}) {
  const root = block('迁移当前项目设置到设备共享'); root.classList.add('settings-migration');
  root.append(el('p', '只导入当前项目的旧设置和托管来源；成功后源项目改为继承共享默认，并保留私有备份。其他旧项目覆盖与项目历史不变。已有不同共享配置会阻止覆盖，账号不按名称合并。', 'hint'));
  const body = el('div'), feedback = el('p', '', 'hint'); feedback.setAttribute('role', 'status');
  let generation = 0, preview = null, busy = false;
  const active = version => ownsPage() && version === generation;
  const eligible = value => value?.can_migrate === true && value?.already_migrated !== true && value?.blockers?.length === 0 && value?.items?.length > 0;
  const display = value => {
    body.replaceChildren();
    for (const item of value.items || []) {
      const line = el('p', `${item.kind} · ${item.action}：`, 'settings-migration-item');
      line.append(el('code', item.source || '—'), el('span', ' → '), el('code', item.destination || '—')); body.append(line);
    }
    for (const message of value.blockers || []) body.append(el('p', `阻挡：${message}`, 'settings-error'));
    for (const message of value.warnings || []) body.append(el('p', `注意：${message}`, 'settings-warning'));
    if (value.already_migrated) body.append(el('p', '此项目已完成迁移，不会重复导入。', 'hint'));
    else if (!value.items?.length && !value.blockers?.length) body.append(el('p', '当前项目没有可迁移的设置；未修改任何配置。', 'hint'));
    apply.disabled = busy || !eligible(value);
  };
  const read = button('预检迁移范围', async () => {
    if (!ownsPage() || busy || !workbenchStatus().projectUsable) return;
    const version = ++generation; busy = true; read.disabled = apply.disabled = true; feedback.textContent = '正在预检当前项目与共享配置…';
    try {
      const value = await api('/api/settings/migration'); if (!active(version)) return;
      if (value?.version !== 1 || typeof value.revision !== 'string' || !Array.isArray(value.items) || !Array.isArray(value.blockers)) throw new Error('迁移预检格式不兼容，请更新后台');
      preview = value; busy = false; display(value);
      feedback.textContent = value.can_migrate ? '预检完成；核对范围后明确确认才会修改文件。' : '当前不能迁移；请先处理阻挡，再重新预检。';
    } catch (error) { if (active(version)) { preview = null; feedback.textContent = `预检失败：${error.message}；未改动配置。`; } }
    finally { if (active(version)) { busy = false; read.disabled = false; apply.disabled = !eligible(preview); } }
  }, 'ghost', { help: '只检查当前项目旧设置、共享目标、权限和冲突，显示迁移范围；不扫描其他项目，不修改文件或调用 Agent。' });
  read.dataset.migrationAction = 'preview';
  const apply = button('确认迁移到设备共享', async () => {
    if (!ownsPage() || busy || !eligible(preview)) return;
    const selected = preview, version = ++generation;
    const accepted = await confirmDialog({ title: '迁移当前项目设置？',
      message: '将预检列出的旧配置导入同设备同系统用户的共享层。确认成功导入后，源项目旧覆盖改为私有备份并继承共享设置；不迁移项目历史，不改其他项目覆盖。',
      detail: [...selected.items.map(item => `${item.kind} · ${item.action}\n${item.source} → ${item.destination}`), ...(selected.warnings || [])].join('\n\n'),
      confirmLabel: '备份并迁移', danger: true,
      confirmHelp: '按固定预检版本导入设置及凭证，成功后退役源项目活跃覆盖；保留私有备份，不调用 Agent。' });
    if (!accepted || !active(version)) return;
    busy = true; read.disabled = apply.disabled = true; feedback.textContent = '正在备份并迁移…';
    try {
      const result = await projectSettingsAction('settings.migration.apply', { revision: selected.revision, confirm: true });
      if (!active(version)) return;
      for (const warning of result.warnings || []) body.append(el('p', `注意：${warning}`, 'settings-warning'));
      if (result.migrated !== true && result.already_migrated !== true) throw new Error('迁移未确认全部完成；请重新预检检查可恢复状态');
      preview = null;
      feedback.textContent = `${result.already_migrated ? '已迁移，无重复操作。' : '迁移完成，当前项目继承设备共享默认。'}${result.backup ? ` 私有备份：${result.backup}` : ''}`;
      await onMigrated();
    } catch (error) {
      if (active(version)) { preview = null; feedback.textContent = `迁移未确认完成：${error.message}。已有文件和可恢复记录保留，请重新预检；不要重复使用旧预检版本。`; }
    } finally { if (active(version)) { busy = false; read.disabled = false; apply.disabled = true; } }
  }, 'danger', { help: '在用户确认后迁移预检列出的当前项目设置和凭证，保留私有备份；不覆盖冲突、不迁移历史、不调用 Agent。' });
  apply.dataset.migrationAction = 'apply'; apply.disabled = true;
  // dom.button restores enabled after callbacks; migration eligibility must survive that wrapper.
  const readClick = read.onclick, applyClick = apply.onclick;
  read.onclick = async () => { await readClick(); read.disabled = busy || !workbenchStatus().projectUsable; };
  apply.onclick = async () => { await applyClick(); apply.disabled = busy || !eligible(preview); };
  const readHost = el('span', undefined, 'help-host'), applyHost = el('span', undefined, 'help-host');
  readHost.setAttribute('data-help', read.getAttribute('data-help')); applyHost.setAttribute('data-help', apply.getAttribute('data-help'));
  if (!workbenchStatus().projectUsable) { read.disabled = true; readHost.setAttribute('data-help', '打开一个可用项目后才能预检和迁移该项目旧设置；共享设置无需项目即可管理。'); }
  readHost.append(read); applyHost.append(apply); root.append(readHost, applyHost, body, feedback); return root;
}
