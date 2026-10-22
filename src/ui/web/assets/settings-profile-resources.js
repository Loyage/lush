/** Explicit profile resource selection, independent from installing/removing packages. */
import { el } from './dom.js';
import { buttonFeedback } from './button-feedback.js';
import { cachedPackagesCatalog, loadPackagesCatalog } from './settings-packages.js';

export function createProfileResources({ profile, backend, mode, ownsPage, client }) {
  let packagesCatalog = cachedPackagesCatalog(client);
  const selectedExtensions = new Set(profile.extensions || []);
  const selectedSkills = new Set(profile.skills || []);
  const resourcesBox = el('div', undefined, 'agent-resources-box');
  const resourcesHead = el('div', undefined, 'agent-resources-head');
  const loadResources = el('button', '读取已安装项', 'ghost resource-load'); loadResources.type = 'button';
  const resourcesNote = el('span', undefined, 'settings-note'); resourcesNote.setAttribute('role', 'status');
  const feedback = buttonFeedback(loadResources, '读取中…');
  let reading = false;
  const resourceChoices = el('div', undefined, 'resource-choices');
  resourcesHead.append(loadResources, resourcesNote); resourcesBox.append(resourcesHead, resourceChoices);

  const paintResourceGroup = (title, entries, selected, kind) => {
    const group = el('fieldset', undefined, 'resource-group');
    group.append(el('legend', `${title}（${entries.length}）`));
    const known = new Set(entries.map(entry => entry.value));
    const rows = [...entries];
    for (const value of selected) if (!known.has(value)) rows.push({ value, label: value.split('/').at(-1), source: '已配置但当前未发现，请核对入口路径或取消勾选', missing: true });
    if (!rows.length) group.append(el('p', '没有发现可选项。', 'settings-note'));
    for (const entry of rows) {
      const wrap = el('label', undefined, `resource-choice${entry.missing ? ' missing' : ''}`);
      const input = el('input'); input.type = 'checkbox'; input.dataset.resourceKind = kind; input.value = entry.value;
      input.checked = selected.has(entry.value); input.disabled = backend.value !== 'pi' || mode.value === 'pi';
      input.addEventListener('change', () => input.checked ? selected.add(entry.value) : selected.delete(entry.value));
      const copy = el('span'); copy.append(el('strong', entry.label), el('small', entry.description || entry.source || 'Pi 资源'), el('small', entry.value));
      wrap.append(input, copy); group.append(wrap);
    }
    return group;
  };
  const paintResources = () => {
    const pi = backend.value === 'pi' && mode.value === 'lush';
    loadResources.disabled = !pi || reading;
    if (mode.value === 'pi') {
      resourcesNote.textContent = 'Pi 默认配置由执行机器的 Pi 目录自行决定资源，这里不注入 Lush 的扩展与 Skills。';
    } else if (!pi) {
      resourcesNote.textContent = 'Pi 扩展与 Skills 不会传给 Codex；选择会保留，切回 Pi 后生效。';
    } else if (packagesCatalog?.warning) resourcesNote.textContent = packagesCatalog.warning;
    else resourcesNote.textContent = packagesCatalog
      ? '只列出插件声明的扩展入口，不必勾选目录内所有脚本；独立 MCP 服务不是 Pi 扩展。只加载显式勾选的资源；扩展拥有当前用户的完整系统权限，不是沙箱。安装与移除在页面顶部的「已安装插件与 Skills」里进行。'
      : '按需读取设备 Lush 独立 Pi 目录中的已安装资源；安装与移除在页面顶部的「已安装插件与 Skills」里进行。';
    resourceChoices.replaceChildren(...(packagesCatalog?.resources ? [
      paintResourceGroup('扩展', packagesCatalog.resources.extensions || [], selectedExtensions, 'extensions'),
      paintResourceGroup('Skills', packagesCatalog.resources.skills || [], selectedSkills, 'skills'),
    ] : []));
  };
  loadResources.onclick = async () => {
    if (!ownsPage() || reading || backend.value !== 'pi' || mode.value === 'pi') return;
    reading = true; loadResources.disabled = true; feedback(true);
    try { packagesCatalog = await loadPackagesCatalog(true, client); if (ownsPage()) paintResources(); }
    catch (error) { if (ownsPage()) resourcesNote.textContent = `资源目录读取失败：${error.message}；已选项保留。`; }
    finally { reading = false; feedback(false); if (ownsPage()) loadResources.disabled = backend.value !== 'pi' || mode.value === 'pi'; }
  };

  return { node: resourcesBox, paint: paintResources,
    clear() { selectedExtensions.clear(); selectedSkills.clear(); },
    collect() { return { extensions: [...selectedExtensions], skills: [...selectedSkills] }; },
  };
}
