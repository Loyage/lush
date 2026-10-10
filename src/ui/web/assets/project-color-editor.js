import { api } from './api.js';
import { block, button, el } from './dom.js';
import { createProjectAppearance, PROJECT_COLORS } from './appearance.js';

/** Only mounted in the user workspace; opening color controls never starts a project. */
export function renderProjectColorEditor(projectId, { ownsPage = () => true } = {}) {
  const root = block('项目辨识配色'); root.classList.add('project-color-editor');
  root.append(el('p', '只改变这个项目的品牌与侧栏辨识色。所有项目仍使用同一设备主题；旧项目主题保留但不生效。', 'hint'));
  const status = el('p', '', 'hint'); status.setAttribute('role', 'status');
  const controls = el('div', undefined, 'settings-choices project-colors');
  const inputs = [];
  const paint = state => {
    for (const input of inputs) {
      input.disabled = !state.appearance || state.loading || state.busy || Boolean(state.error);
      input.checked = input.dataset.projectColor === state.appearance?.color;
    }
    status.textContent = state.error ? `配色未同步：${state.error}；请重新读取后再保存。`
      : state.busy ? '正在保存项目辨识色…' : state.loading ? '正在读取项目辨识色…' : '项目辨识色已同步；主题仍由设备偏好管理。';
    status.className = state.error ? 'settings-error' : 'hint'; status.setAttribute('role', state.error ? 'alert' : 'status');
  };
  const controller = createProjectAppearance({ root, projectId, request: api, ownsPage, onChange: paint, setInterval: null });
  for (const { id, label } of PROJECT_COLORS) {
    const wrap = el('label', undefined, 'settings-choice project-color-choice'); wrap.dataset.color = id;
    const input = el('input'); input.type = 'radio'; input.name = `project-color-${projectId}`; input.dataset.projectColor = id;
    input.setAttribute('aria-label', `项目辨识色：${label}`);
    input.onchange = async () => {
      if (!ownsPage() || !input.checked || input.disabled) return;
      try { await controller.save({ color: id }); } catch { /* controller publishes the error; no automatic retry */ }
    };
    const swatch = el('span', undefined, 'project-color-swatch'); swatch.setAttribute('aria-hidden', 'true');
    wrap.append(input, swatch, el('span', label));
    const host = el('span', undefined, 'help-host'); host.tabIndex = 0;
    host.setAttribute('data-help', '项目配色未同步或保存中时不可修改；失败后先重新读取，不修改设备主题。');
    host.append(wrap); controls.append(host); inputs.push(input);
  }
  const retry = button('重新读取配色', () => controller.load(true), 'ghost');
  root.append(controls, status, retry); paint(controller.snapshot());
  return { root, ready: controller.load(true), dispose: () => controller.destroy() };
}
