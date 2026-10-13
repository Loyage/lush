/** Local package/resource catalog cache and explicit install/update/remove controls. */
import { block, button, el } from './dom.js';
import { confirmDialog } from './dialog.js';
import { show } from './messages.js';
import { scopeLabel } from './settings-scope.js';
/**
 * Agent 配置页共享的已安装资源目录。优先读只读的 /api/agent/packages（含包管理与资源路径）；
 * 旧 daemon 没有该接口时退回 /api/agent/resources，只显示目录发现结果并说明安装管理不可用。
 * 打开页面只读本地，不联网安装、不查询额度、不调用 Agent。
 */
const packagesCatalogs = new Map();
const resourceValue = entry => entry?.path || entry?.id || '';
const resourceLabel = entry => entry?.name || entry?.label || String(resourceValue(entry)).split('/').at(-1) || '未命名资源';
const normalizeResourceEntries = rows => (Array.isArray(rows) ? rows : []).map(entry => ({
  value: resourceValue(entry), label: resourceLabel(entry),
  description: entry?.description || '', source: entry?.source || '', package_id: entry?.package_id || null,
})).filter(entry => entry.value);
export async function loadPackagesCatalog(force = false, client) {
  let packagesCatalog = packagesCatalogs.get(client.key);
  if (!force && packagesCatalog) return packagesCatalog;
  try {
    const data = await client.read('/api/agent/packages');
    if (data?.version !== 1 || !Array.isArray(data.packages)) throw new Error('接口数据格式不兼容');
    const resources = data.resources || {};
    packagesCatalog = { source: 'packages', installable: true, packages: data.packages,
      resources: { extensions: normalizeResourceEntries(resources.extensions), skills: normalizeResourceEntries(resources.skills) },
      warning: data.warning || null };
  } catch (error) {
    try {
      const legacy = await client.read('/api/agent/resources');
      packagesCatalog = { source: 'resources', installable: false,
        packages: Array.isArray(legacy.packages) ? legacy.packages : [],
        resources: { extensions: normalizeResourceEntries(legacy.extensions), skills: normalizeResourceEntries(legacy.skills) },
        warning: `已安装包管理不可用（${error.message}）；仅显示本地目录发现到的资源，安装 / 移除 / 更新暂不可用。` };
    } catch (second) {
      packagesCatalog = { source: 'resources', installable: false, packages: [],
        resources: { extensions: [], skills: [] }, warning: `资源目录读取失败：${second.message}` };
    }
  }
  packagesCatalogs.set(client.key, packagesCatalog);
  return packagesCatalog;
}

export const cachedPackagesCatalog = client => packagesCatalogs.get(client.key);

/** 禁用按钮不派发事件，提示必须由外层 `.help-host` 承载；可点按钮直接返回原按钮。 */
function guardedButton(label, enabled, reason, fn, className = 'ghost') {
  const node = button(label, fn, className);
  if (enabled) return node;
  node.disabled = true;
  const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', reason); host.append(node);
  return host;
}

/** 客户端先拒绝未固定版本的远端来源；后端仍会再校验，这里只负责尽早给出可操作的提示。 */
function fixedSourceError(source) {
  const value = String(source || '').trim();
  if (!value) return '请填写安装来源。';
  if (/^npm:(?:@[^/@\s]+\/)?[^@/\s]+@[^@\s]+$/.test(value)) return null;
  if (value.startsWith('npm:')) return 'npm 包必须固定版本，例如 npm:@example/pi-tools@1.0.0；不接受浮动版本。';
  if (/^git:[^\s@]+@[^\s@]+$/.test(value)) return null;
  if (value.startsWith('git:')) return 'git 来源必须固定 commit 或 tag，例如 git:github.com/example/pi-tools@v1。';
  if (/^https?:\/\/[^\s@/]+\/[^\s@]+@[^\s@]+$/.test(value)) return null;
  if (/^https?:\/\//i.test(value)) return '远端 URL 按 git 来源处理，必须固定 commit 或 tag，例如 https://github.com/example/pi-tools@v1。';
  if (/^(\.\.?\/|\/|~\/)/.test(value)) return null;
  return '不支持的来源；请使用固定版本的 npm:、固定 commit/tag 的 git:，或显式本地路径。';
}

const PACKAGE_SOURCE_HELP = '安装到设备的 Lush 独立 Pi 目录，不改用户默认 Pi。来源必须固定版本：npm:name@1.0.0、git:host/repo@commit-or-tag，或显式本地路径（./、../、/、~/）。安装不会自动启用，也不会调用 Agent。';

/** 项目级插件与 Skills 安装管理：安装与启用分开，安装 / 更新 / 移除都不调用 Agent。 */
export function packagesManager(ownsPage, client) {
  let packagesCatalog = packagesCatalogs.get(client.key);
  const section = block('已安装插件与 Skills'); section.classList.add('agent-packages');
  section.append(el('p', `安装库属于${scopeLabel(client.scope)}的 Lush 独立 Pi 目录，不改用户默认 Pi。安装与启用分开：安装不会自动勾选任何 Agent 的扩展 / Skills，启用仍在各 Agent 配置的“工作方式”里选择。设备库的移除/更新会影响其他项目使用的相同路径；不调用 Agent 或模型。`, 'settings-note settings-section-note'));
  const warning = el('p', undefined, 'settings-warning'); warning.hidden = true; warning.dataset.packageWarning = '';
  const toolbar = el('div', undefined, 'agent-package-toolbar');
  const state = el('span', undefined, 'settings-note'); state.dataset.packageState = '';
  const list = el('div', undefined, 'agent-package-list'); list.dataset.packageList = '';
  const errorBox = el('p', undefined, 'settings-error'); errorBox.hidden = true; errorBox.dataset.packageError = '';
  const source = el('input'); source.type = 'text'; source.className = 'agent-package-source'; source.dataset.packageSource = '';
  source.placeholder = 'npm:@example/pi-tools@1.0.0 或 git:github.com/example/pi-tools@v1 或 ./local-package';
  source.maxLength = 512; source.spellcheck = false; source.autocomplete = 'off';
  source.setAttribute('aria-label', '要安装的 Pi 包来源（必须固定版本）');
  const installRow = el('div', undefined, 'agent-package-install'); installRow.append(source);
  const fail = message => { errorBox.textContent = message; errorBox.hidden = false; };
  const clearInstall = () => { for (const node of [...installRow.children]) if (node !== source) node.remove(); };
  let pending = false;
  const reload = button('读取已安装包', () => load(true), 'ghost agent-package-load',
    { help: '读取设备 Lush 独立 Pi 目录中的已安装包与资源；只读本地，不联网安装、不查询额度、不调用 Agent。' });
  toolbar.append(reload, state);
  async function load(force) {
    if (!ownsPage() || pending) return;
    pending = true; reload.disabled = true; reload.textContent = '读取中…';
    try { packagesCatalog = await loadPackagesCatalog(force, client); if (ownsPage()) paint(); }
    catch (error) { if (ownsPage()) fail(error.message); }
    finally { pending = false; if (ownsPage()) { reload.disabled = false; reload.textContent = '重新读取'; } }
  }
  const mutate = async (method, params, success) => {
    errorBox.hidden = true;
    try {
      if (!ownsPage()) return false;
      await client.action(method, params);
      packagesCatalog = await loadPackagesCatalog(true, client);
      if (ownsPage()) { paint(); show(success); }
      return true;
    } catch (error) { if (ownsPage()) fail(error.message); return false; }
  };
  const removePackage = async (entry, label) => {
    const confirmed = await confirmDialog({ title: '移除已安装包？',
      message: `将从${scopeLabel(client.scope)}的 Lush 独立 Pi 安装库移除“${label}”。`,
      detail: '不会删除用户默认 Pi 的安装，也不会取消各 Agent 已勾选的启用路径；找不到的显式路径会保留为“已配置但当前未发现”。',
      confirmLabel: '移除该包', danger: true });
    if (!confirmed || !ownsPage()) return;
    await mutate('agent.packages.remove', { id: entry.id }, `已移除 ${label}。`);
  };
  const install = async () => {
    const value = source.value.trim();
    const invalid = fixedSourceError(value);
    if (invalid) { fail(invalid); return; }
    if (await mutate('agent.packages.install', { source: value }, `已安装 ${value}；安装不会自动启用，请在 Agent 配置的「工作方式」里勾选。`)) source.value = '';
  };
  const packageRow = entry => {
    const row = el('div', undefined, 'agent-package-row');
    const copy = el('div', undefined, 'agent-package-copy');
    const label = entry.label || entry.source || entry.id || '未命名包';
    copy.append(el('strong', label));
    if (entry.label && entry.source) copy.append(el('small', `来源：${entry.source}`));
    const meta = [entry.version ? `版本 ${entry.version}` : null, entry.requested ? `引用 ${entry.requested}` : null, entry.root || null].filter(Boolean).join(' · ');
    if (meta) copy.append(el('small', meta));
    if (packagesCatalog?.source === 'packages') {
      const extensions = packagesCatalog.resources.extensions.filter(resource => resource.package_id === entry.id);
      const skills = packagesCatalog.resources.skills.filter(resource => resource.package_id === entry.id);
      const details = el('details'); details.dataset.packageResources = '';
      details.append(el('summary', `可启用资源：${extensions.length} 个扩展 · ${skills.length} 个 Skill`));
      for (const [kind, resources] of [['扩展入口', extensions], ['Skill', skills]]) {
        for (const resource of resources) details.append(el('p', `${kind}：${resource.label}`), el('code', resource.value, 'settings-path'));
      }
      details.append(el('p', '扩展按插件声明或目录 index 入口识别，不需要全选目录内脚本；独立 MCP 服务不作为 Pi 扩展加载。安装不等于启用。', 'settings-note'));
      copy.append(details);
    }
    const canEdit = Boolean(entry.id) && packagesCatalog?.installable;
    const reason = '这个 daemon 未提供安装管理接口或包 ID；升级 daemon 后再试。';
    const actions = el('div', undefined, 'agent-package-actions');
    actions.append(
      guardedButton('更新', canEdit, reason, () => mutate('agent.packages.update', { id: entry.id }, `已更新 ${label}。`)),
      guardedButton('移除', canEdit, reason, () => removePackage(entry, label)));
    row.append(copy, actions); return row;
  };
  const paint = () => {
    const catalog = packagesCatalog;
    clearInstall();
    if (!catalog) {
      list.replaceChildren(el('p', '尚未读取已安装包。', 'settings-note'));
      state.textContent = ''; warning.hidden = true;
      installRow.append(guardedButton('安装', false, '请先读取已安装包，确认 daemon 是否提供安装管理接口。', () => {}, 'primary agent-package-install'));
      return;
    }
    warning.hidden = !catalog.warning; warning.textContent = catalog.warning || '';
    const packages = catalog.packages || [];
    state.textContent = `${catalog.installable ? '已安装包管理可用' : '只读目录发现'} · ${packages.length} 个包`;
    list.replaceChildren(...(packages.length ? packages.map(packageRow) : [el('p', '未发现已安装的 Pi 包。', 'settings-note')]));
    installRow.append(catalog.installable
      ? button('安装', install, 'primary agent-package-install', { help: `${scopeLabel(client.scope)}：${PACKAGE_SOURCE_HELP}` })
      : guardedButton('安装', false, '当前 daemon 没有提供安装管理接口；升级 daemon 后再试。', () => {}, 'primary agent-package-install'));
  };
  paint();
  section.append(toolbar, warning, list, installRow, errorBox);
  // 打开配置页只读一次本地目录（有缓存后不重复）；失败会退回只读发现并说明安装管理不可用。
  if (!packagesCatalog) void load(false);
  return section;
}
