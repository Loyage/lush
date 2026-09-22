import { api } from './api.js';

function node(id) { return globalThis.document?.getElementById?.(id) ?? null; }
let launcher = false;

function setError(message = '') {
  const target = node('project-error');
  if (target) { target.textContent = message; target.hidden = !message; }
}

export function openProjectPicker(status = {}) {
  const gate = node('project-gate');
  if (!gate) return;
  const input = node('project-path');
  const project = status.project || status.last_project || status.allowed_projects?.[0] || '';
  if (input) input.value = project;
  const list = node('project-options');
  if (list) list.replaceChildren(...(status.allowed_projects || []).map(value => {
    const option = list.ownerDocument.createElement('option'); option.value = value; return option;
  }));
  const hint = node('project-hint');
  if (hint) hint.textContent = status.allowed_projects
    ? '公网启动器只能打开全局 web.json 白名单中的项目。'
    : '首次打开必须指定绝对路径。之后会自动恢复最后使用的项目，也可以随时切换。';
  setError(status.error || '');
  const cancel = node('project-cancel');
  if (cancel) { cancel.hidden = !status.project; cancel.onclick = () => closeProjectPicker(); }
  gate.hidden = false;
  gate.setAttribute('aria-hidden', 'false');
  node('project-app')?.setAttribute?.('inert', '');
  input?.focus?.();
}

export function closeProjectPicker() {
  const gate = node('project-gate');
  if (gate) { gate.hidden = true; gate.setAttribute('aria-hidden', 'true'); }
  node('project-app')?.removeAttribute?.('inert');
}

async function selectProject() {
  const input = node('project-path');
  const submit = node('project-submit');
  if (submit) submit.disabled = true;
  setError();
  try {
    await api('/api/launcher/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: input?.value || '' }) });
    if (typeof globalThis.location?.reload === 'function') globalThis.location.reload();
  } catch (error) {
    setError(error.message);
    if (submit) submit.disabled = false;
  }
}

function bindPicker(status) {
  const form = node('project-form');
  if (form && !form.dataset.bound) {
    form.dataset.bound = 'true';
    form.addEventListener('submit', event => { event.preventDefault(); void selectProject(); });
  }
  const choose = node('project-choose');
  const desktop = globalThis.lushDesktop;
  if (choose) {
    choose.hidden = !desktop?.chooseProject;
    choose.onclick = async () => {
      const selected = await desktop.chooseProject();
      if (selected && node('project-path')) node('project-path').value = selected;
    };
  }
  const switcher = node('project-switch');
  if (switcher) {
    switcher.hidden = !launcher;
    switcher.onclick = () => openProjectPicker(status);
  }
}

/** 返回 false 表示首启尚未选择项目，调用方不得启动项目轮询。 */
export async function ensureProject() {
  let status;
  try { status = await api('/api/launcher'); }
  catch (error) {
    // 兼容尚未提供启动器端点的旧 Web；真正的连接错误仍会在随后的 snapshot 中显示。
    if (/404|no route|not found/i.test(error.message)) return true;
    throw error;
  }
  launcher = status.mode === 'launcher';
  bindPicker(status);
  if (!launcher || status.project) { closeProjectPicker(); return true; }
  openProjectPicker(status);
  return false;
}
