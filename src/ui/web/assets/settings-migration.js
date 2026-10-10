import { api } from './api.js';
import { block, button, el } from './dom.js';
import { confirmDialog } from './dialog.js';
import { projectSettingsAction } from './settings-api.js';

/** Select a registered source; reads never start a project or inspect an arbitrary path. */
export function renderSettingsMigration({ ownsPage = () => true, onMigrated = () => {} } = {}) {
  const root = block('导入旧项目设置到设备'); root.classList.add('settings-migration');
  root.append(el('p', '选择已登记且后台在线的项目，显式预检并导入旧设置和托管来源。成功后保留私有备份，JSON／环境／凭证源文件按协议退役；Markdown 本机补充原件保留但不再参与调用。不迁移项目历史。设备已有不同配置会阻止覆盖，账号不按名称合并。', 'hint'));
  const select = el('select', undefined, 'pref-select'); select.dataset.migrationSource = ''; select.setAttribute('aria-label', '迁移来源项目');
  const sourceRow = el('div', undefined, 'settings-row help-host'); sourceRow.append(el('span', '迁移来源项目', 'settings-copy'), select);
  sourceRow.setAttribute('data-help', '只选择已登记来源；读取或迁移期间暂不能切换，不扫描目录、不启动后台。');
  const body = el('div'), feedback = el('p', '', 'hint'); feedback.setAttribute('role', 'status');
  let generation = 0, preview = null, busy = false, projects = [];
  const source = () => projects.find(project => project.id === select.value);
  const active = (version, projectId) => ownsPage() && version === generation && (projectId === undefined || select.value === projectId);
  const eligible = value => value?.can_migrate === true && value?.already_migrated !== true && value?.blockers?.length === 0 && value?.items?.length > 0;
  const update = () => {
    const online = source()?.running === true;
    read.disabled = busy || !online;
    apply.disabled = busy || !online || !eligible(preview);
    select.disabled = busy;
    readHost.setAttribute('data-help', online ? '只预检所选登记项目的旧设置与设备目标，不修改文件、不扫描其它目录、不调用 Agent。'
      : '请选择已登记且后台在线的来源；查看列表和迁移预检不会启动已停止的后台。');
  };
  const display = value => {
    body.replaceChildren();
    for (const item of value.items || []) {
      const line = el('p', `${item.kind} · ${item.action}：`, 'settings-migration-item');
      line.append(el('code', item.source || '—'), el('span', ' → '), el('code', item.destination || '—')); body.append(line);
    }
    for (const message of value.blockers || []) body.append(el('p', `阻挡：${message}`, 'settings-error'));
    for (const message of value.warnings || []) body.append(el('p', `注意：${message}`, 'settings-warning'));
    if (value.already_migrated) body.append(el('p', '此项目已完成迁移，不会重复导入。', 'hint'));
    else if (!value.items?.length && !value.blockers?.length) body.append(el('p', '所选项目没有可迁移的设置；未修改任何配置。', 'hint'));
    update();
  };
  const read = button('预检迁移范围', async () => {
    if (!ownsPage() || busy || source()?.running !== true) return;
    const projectId = select.value, version = ++generation; busy = true; preview = null; update(); feedback.textContent = '正在预检所选项目与设备配置…';
    try {
      const value = await api(`/p/${projectId}/api/settings/migration`); if (!active(version, projectId)) return;
      if (value?.version !== 1 || typeof value.revision !== 'string' || !Array.isArray(value.items) || !Array.isArray(value.blockers)) throw new Error('迁移预检格式不兼容，请更新来源后台');
      preview = value; busy = false; display(value);
      feedback.textContent = value.can_migrate ? '预检完成；核对范围后明确确认才会修改文件。' : '当前不能迁移；请先处理阻挡，再重新预检。';
    } catch (error) { if (active(version, projectId)) { preview = null; feedback.textContent = `预检失败：${error.message}；未改动配置。`; } }
    finally { if (active(version, projectId)) { busy = false; update(); } }
  }, 'ghost', { help: '只检查所选登记项目旧设置、设备目标、权限和冲突；不修改文件、不启动后台、不调用 Agent。' });
  read.dataset.migrationAction = 'preview';
  const apply = button('确认迁移到设备设置', async () => {
    if (!ownsPage() || busy || source()?.running !== true || !eligible(preview)) return;
    const selected = preview, projectId = select.value, projectName = source().name, version = ++generation;
    const accepted = await confirmDialog({ title: `迁移 ${projectName} 的旧设置？`,
      message: '将预检列出的旧配置导入同设备同系统用户的唯一设置。成功导入后保留私有备份，JSON／环境／凭证源文件按协议退役；Markdown 本机补充保留不活跃的项目原件。设备补充影响所有项目后续调用，仓库约定应留在 AGENTS.md 或 .lush-agent/。不迁移项目历史、不静默覆盖设备冲突。',
      detail: [...selected.items.map(item => `${item.kind} · ${item.action}\n${item.source} → ${item.destination}`), ...(selected.warnings || [])].join('\n\n'),
      confirmLabel: '备份并迁移', danger: true,
      confirmHelp: '按所选项目的固定预检版本导入配置及凭证，成功后保留私有备份，按协议退役 JSON／环境／凭证源文件，保留不活跃的 Markdown 原件；不调用 Agent。' });
    if (!accepted || !active(version, projectId) || preview !== selected) return;
    busy = true; update(); feedback.textContent = '正在备份并迁移…';
    try {
      const result = await projectSettingsAction('settings.migration.apply', { revision: selected.revision, confirm: true }, projectId);
      if (!active(version, projectId)) return;
      for (const warning of result.warnings || []) body.append(el('p', `注意：${warning}`, 'settings-warning'));
      if (result.migrated !== true && result.already_migrated !== true) throw new Error('迁移未确认全部完成；请重新预检检查可恢复状态');
      preview = null;
      feedback.textContent = `${result.already_migrated ? '已迁移，无重复操作。' : '迁移完成，所有项目使用设备设置。'}${result.backup ? ` 私有备份：${result.backup}` : ''}`;
      try { await onMigrated(); }
      catch (error) { if (active(version, projectId)) feedback.textContent += ` 设置重读失败：${error.message}；迁移已完成，请手动刷新。`; }
    } catch (error) {
      if (active(version, projectId)) { preview = null; feedback.textContent = `迁移未确认完成：${error.message}。已有文件和可恢复记录保留，请重新预检；不要重复使用旧预检版本。`; }
    } finally { if (active(version, projectId)) { busy = false; update(); } }
  }, 'danger', { help: '确认后迁移预检列出的所选项目设置和凭证并保留备份；不覆盖冲突、不迁移历史、不调用 Agent。' });
  apply.dataset.migrationAction = 'apply';
  const readHost = el('span', undefined, 'help-host'), applyHost = el('span', undefined, 'help-host');
  applyHost.setAttribute('data-help', apply.getAttribute('data-help')); readHost.append(read); applyHost.append(apply);
  select.onchange = () => { generation++; busy = false; preview = null; body.replaceChildren(); feedback.textContent = source()?.running === true ? '请预检所选来源；切换来源后旧预检已失效。' : '来源后台不在线；不会自动启动，请在项目页显式启动后刷新列表。'; update(); };
  async function loadSources() {
    if (!ownsPage() || busy) return;
    const version = ++generation, selected = select.value; busy = true; preview = null; body.replaceChildren(); update(); feedback.textContent = '正在读取已登记项目…';
    try {
      const data = await api('/api/host/projects'); if (!active(version)) return;
      if (!Array.isArray(data.projects)) throw new Error('项目列表格式不兼容');
      projects = data.projects.filter(project => typeof project.id === 'string' && /^[a-f0-9]{16}$/.test(project.id));
      select.replaceChildren(); const empty = el('option', '请选择迁移来源'); empty.value = ''; select.append(empty);
      for (const project of projects) { const option = el('option', `${project.name || project.id}${project.running === true ? '' : '（后台离线）'}`); option.value = project.id; select.append(option); }
      select.value = projects.some(project => project.id === selected) ? selected : '';
      feedback.textContent = projects.length ? '只列出已登记项目；选择来源后预检，不会启动项目后台。' : '尚无已登记项目；设备设置仍可编辑。';
    } catch (error) { if (active(version)) { projects = []; feedback.textContent = `来源列表读取失败：${error.message}；不会启动后台或修改配置。`; } }
    finally { if (active(version)) { busy = false; update(); } }
  }
  const refresh = button('刷新来源列表', loadSources, 'ghost', { help: '仅刷新已登记项目的运行状态，不扫描目录、不启动项目后台。' }); refresh.dataset.migrationAction = 'sources';
  for (const node of [read, apply, refresh]) { const click = node.onclick; node.onclick = async () => { await click(); update(); }; }
  root.append(sourceRow, refresh, readHost, applyHost, body, feedback); update(); root.ready = loadSources(); return root;
}
