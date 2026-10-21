import { $, el, button } from './dom.js';
import { api, projectApi } from './api.js';
import { formDialog, closeDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { workerLabel } from './worker-label.js';
import { ui } from './state.js';

import { PROJECT_ELEVATION_HTTP, PROJECT_ELEVATION_MODE, PROJECT_ELEVATION_SCOPE, PROJECT_ELEVATION_RISK,
  normalizeProjectElevation, projectElevationText } from '../../../administrator/project-protocol.js';
export { PROJECT_ELEVATION_RISK };
const endpoint = PROJECT_ELEVATION_HTTP.submit, receiptEndpoint = PROJECT_ELEVATION_HTTP.receipt;
const managementTask = task => Number.isSafeInteger(task?.id) && task.id > 0 && task.role === 'manager' && task.task_kind === 'management';
const pending = new Map(), secretForms = new Set();
const key = definition => `${projectApi(receiptEndpoint)}:${definition.client_request_id}`;
const storageKey = () => `lush.project-elevation.unknown:${projectApi(receiptEndpoint)}`;
export function projectElevationDefinition({ kind, instruction, client_request_id, id, profile }) {
  return normalizeProjectElevation({ kind, mode: PROJECT_ELEVATION_MODE, scope: PROJECT_ELEVATION_SCOPE, instruction, client_request_id,
    ...(kind === 'append' ? { id } : profile ? { profile } : {}) });
}
const definitionText = projectElevationText;
function restore() {
  try {
    const values = JSON.parse(sessionStorage.getItem(storageKey()) || '[]');
    for (const item of Array.isArray(values) ? values : []) {
      const definition = normalizeProjectElevation(item.definition);
      pending.set(key(definition), { definition });
    }
  } catch { /* Malformed local evidence is never an authorization. */ }
}
function save() {
  try { sessionStorage.setItem(storageKey(), JSON.stringify([...pending.entries()].filter(([id]) => id.startsWith(projectApi(receiptEndpoint) + ':')).map(([, value]) => value))); }
  catch { /* Keep in-memory evidence and never treat storage failure as submission success. */ }
}
export function pendingProjectElevation(kind, id) {
  restore();
  return [...pending.entries()].filter(([name, item]) => name.startsWith(projectApi(receiptEndpoint) + ':')
    && item.definition.kind === kind && (kind !== 'append' || item.definition.id === id)).map(([, item]) => item);
}
export function elevationChoice(onChange) {
  const root = el('div', undefined, 'project-elevation-choice'), label = el('label', undefined, 'project-elevation-label');
  const input = el('input'); input.type = 'checkbox'; input.checked = false; input.setAttribute('type', 'checkbox');
  label.append(input, el('span', '以管理员身份运行'));
  const risk = el('p', PROJECT_ELEVATION_RISK, 'project-elevation-risk'); risk.hidden = true;
  input.onchange = () => { risk.hidden = !input.checked; onChange?.(input.checked); };
  root.append(label, risk);
  return { root, input, reset() { input.checked = false; risk.hidden = true; } };
}
export function syncProjectElevationSecrets() {
  for (const item of secretForms) if (!item.current()) {
    item.clear();
    if ($('modal')?.querySelector('.project-elevation-confirmation') === item.node) closeDialog();
  }
}
export function projectElevationConfirmation(definition, { task = null, current = () => true } = {}) {
  definition = normalizeProjectElevation(definition);
  const owner = document, pathname = location.pathname, route = projectApi('/api/');
  const project = ui.lastSnapshot?.status?.project || pathname;
  const owns = () => document === owner && location.pathname === pathname && projectApi('/api/') === route && current();
  const node = el('div', undefined, 'project-elevation-confirmation');
  node.append(el('p', definition.kind === 'submit' ? '创建管家并执行以下首条指令' : `追加到 ${workerLabel(task || definition.id)} · ID ${definition.id}`),
    el('p', `目标项目：${project}`, 'mono'), el('p', `模式：${definition.mode} · 范围：${definition.scope}`), el('p', PROJECT_ELEVATION_RISK, 'project-elevation-risk'));
  const body = el('pre', definition.instruction, 'project-elevation-full-content'); node.append(body);
  if (definition.profile) {
    const model = definition.profile;
    node.append(el('p', `本条模型覆盖：${model.config_mode || 'Lush'} · ${model.model || '已选来源默认'} · ${model.thinking || '默认思考深度'}`, 'hint'));
  }
  const label = el('label', '当前 Lush Web 登录密码'), password = el('input', undefined, 'project-elevation-password');
  password.type = 'password'; password.setAttribute('type', 'password'); password.autocomplete = 'current-password';
  password.setAttribute('autocomplete', 'current-password'); password.setAttribute('aria-label', '当前 Lush Web 登录密码');
  password.maxLength = 1024; label.append(password); node.append(label);
  const clear = () => { password.value = ''; };
  const item = { node, current: owns, clear }; secretForms.add(item);
  const leave = () => { clear(); if ($('modal')?.querySelector('.project-elevation-confirmation') === node) closeDialog(); };
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => { if (!owns()) leave(); }) : null;
  observer?.observe(owner.documentElement, { subtree: true, childList: true });
  globalThis.addEventListener?.('pagehide', leave);
  return { node, password, body, clear, current: owns, dispose() { clear(); secretForms.delete(item); observer?.disconnect(); globalThis.removeEventListener?.('pagehide', leave); } };
}

/** Dedicated password transport never exposes raw server errors or saves a body containing a password. */
export async function sendProjectElevation(definition, password) {
  const original = normalizeProjectElevation(definition), identity = key(original);
  if (pending.has(identity) || pendingProjectElevation(original.kind, original.id).length) throw new Error('原提权提交结果未知，请先只读核对收据，不重复发送。');
  const storage = globalThis.sessionStorage, target = projectApi(endpoint), savedKey = storageKey(), receiptPrefix = projectApi(receiptEndpoint) + ':';
  const owner = globalThis.document, pathname = location.pathname;
  const evidence = { definition: original }; pending.set(identity, evidence); save();
  const persistCaptured = () => {
    try { storage.setItem(savedKey, JSON.stringify([...pending.entries()].filter(([id]) => id.startsWith(receiptPrefix)).map(([, item]) => item))); } catch {}
  };
  let passwordRejection = null;
  let body = JSON.stringify({ definition: original, password, confirm: true }); password = '';
  try {
    const flight = fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); body = '';
    const response = await flight;
    if (!response.ok) {
      let rejection = null;
      try { rejection = await response.json(); } catch { /* No trusted refusal envelope: remain unknown. */ }
      const rejected = [401, 403].includes(response.status) && rejection?.code === 'elevation_password_rejected';
      const limited = response.status === 429 && rejection?.code === 'elevation_password_rate_limited';
      if ((rejected || limited) && rejection.execution === 'not_started') {
        passwordRejection = limited ? 'rate_limited' : 'rejected'; pending.delete(identity); persistCaptured();
      }
      if (response.status === 401 && globalThis.document === owner && location.pathname === pathname && typeof location.assign === 'function') {
        location.assign(`/login?next=${encodeURIComponent(pathname + (location.search || '') + (location.hash || ''))}`);
      }
      throw new Error('unconfirmed');
    }
    const result = await response.json();
    if (result?.management !== true || !managementTask(result.task) || result.instruction !== original.instruction
      || original.kind === 'append' && result.task.id !== original.id) throw new Error('unconfirmed');
    pending.delete(identity); persistCaptured(); return result;
  } catch (error) {
    if (passwordRejection) throw new Error(passwordRejection === 'rate_limited'
      ? '密码验证尝试已限速，本条尚未提交；请稍后由你重新输入密码并主动提交，不会自动重试。'
      : '密码验证未通过或登录已失效，本条尚未提交；请重新核对并输入密码，不会自动重试。');
    throw new Error('提权提交结果未确认；已保留不含密码的精确原稿与请求身份，只能先只读核对，不能自动重发或换 key。');
  } finally { body = ''; password = ''; }
}

export function projectElevationReceipts({ kind, id, current = () => true, resolved = () => {} } = {}) {
  const owner = document, pathname = location.pathname;
  const owns = () => globalThis.document === owner && location.pathname === pathname && current();
  const root = el('div', undefined, 'project-elevation-receipts');
  function paint() {
    root.replaceChildren(); const items = pendingProjectElevation(kind, id); root.hidden = !items.length;
    for (const item of items) {
      const definition = item.definition;
      root.append(el('p', '本次提权提交未知；保留原稿，只读核对，不重发。', 'error'), el('p', `请求身份：${definition.client_request_id}`, 'mono'),
        el('pre', definition.instruction, 'project-elevation-full-content'));
      const status = el('p', '', 'hint'); status.setAttribute('role', 'status');
      const check = button('只读核对提权提交', async () => {
        if (!owns()) return;
        try {
          const receipt = await api(`${receiptEndpoint}?client_request_id=${encodeURIComponent(definition.client_request_id)}`);
          if (!owns()) return;
          if (receipt?.version !== 1 || receipt.found !== true) { status.textContent = '尚未确认找到原提交，可能仍在并发处理；继续保留未知，不重发。'; return; }
          // Do not normalize away extra fields or a different mode/scope from a remote receipt.
          const expected = definitionText(definition);
          if (projectElevationText(receipt.definition) !== expected || !managementTask(receipt.task)
            || receipt.instruction !== definition.instruction || kind === 'append' && receipt.task.id !== id) { status.textContent = '收据与精确原稿、权限或目标不符；保留未知，不重发。'; return; }
          pending.delete(key(definition)); save();
          root.replaceChildren(el('p', `原提权提交已确认存在；实际状态：${receipt.task.management?.state || receipt.task.status || '未知'}，不代表执行成功或副作用已确定。`, 'hint'));
          resolved(receipt);
        } catch { if (owns()) status.textContent = '只读收据核对失败或项目离线；保留原稿与未知锁定，不重发。'; }
      }, 'ghost', { help: '仅读取与原请求身份绑定的精确收据，不调用 Agent、不重发指令；未找到不代表未执行。' });
      root.append(check, status);
    }
  }
  paint(); return { root, refresh: paint };
}

export async function confirmProjectElevation(definition, { current = () => true } = {}) {
  const form = projectElevationConfirmation(definition, { current });
  const status = el('p', '', 'project-elevation-status'); status.setAttribute('role', 'status'); form.node.append(status);
  let result = null;
  try {
    await formDialog({ title: '核对本条管理员指令并验证密码', content: form.node, cardClass: 'project-elevation-modal',
      confirmLabel: '验证密码并执行这一条', agent: true, confirmHelp: agentHelp('重新验证当前 Web 登录密码后，仅以当前项目管理员权限执行这条完整指令；下一条默认普通。'),
      canConfirm: () => form.current() && !pendingProjectElevation(definition.kind, definition.id).length,
      onConfirm: async () => {
        if (!form.current()) { form.clear(); return false; }
        let password = form.password.value; form.clear();
        if (!password) { status.textContent = '请输入当前 Web 登录密码；不会缓存免密。'; return false; }
        try { const flight = sendProjectElevation(definition, password); password = ''; result = await flight; return true; }
        catch (error) { status.textContent = error.message; return false; }
        finally { password = ''; form.clear(); }
      } });
    return result;
  } finally { form.dispose(); }
}
