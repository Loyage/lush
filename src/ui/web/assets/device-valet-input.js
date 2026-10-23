import { $, el, button } from './dom.js';
import { formDialog, closeDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { DEVICE_VALET_API, DEVICE_VALET_ROUTES, DEVICE_VALET_RISK, normalizeDeviceValetDefinition, deviceValetIdentifier } from '../../../device-valet/protocol.js';

const storageKey = 'lush.device-valet.unconfirmed.v1', pending = new Map(), secretForms = new Set();
const endpoint = route => `${DEVICE_VALET_API}/${DEVICE_VALET_ROUTES[route]}`;
export const deviceValetDefinitionText = value => JSON.stringify(normalizeDeviceValetDefinition(value));
function restore() {
  try {
    const values = JSON.parse(globalThis.sessionStorage?.getItem(storageKey) || '[]');
    for (const value of Array.isArray(values) ? values : []) {
      const definition = normalizeDeviceValetDefinition(value.definition);
      if (!pending.has(definition.client_request_id)) pending.set(definition.client_request_id, { definition });
    }
  } catch { /* Browser recovery data is not an authorization. */ }
}
function save() {
  try { globalThis.sessionStorage?.setItem(storageKey, JSON.stringify([...pending.values()])); }
  catch { /* In-memory unknown evidence remains; never infer submission success. */ }
}
export function pendingDeviceValet(kind, id) {
  restore();
  return [...pending.values()].filter(item => !kind || item.definition.kind === kind && (kind !== 'append' || item.definition.id === id));
}
export function validDeviceValetReceipt(receipt, definition) {
  try {
    if (receipt?.version !== 1 || receipt.found !== true || !deviceValetIdentifier(receipt.worker?.id)) return false;
    if (deviceValetDefinitionText(receipt.definition) !== deviceValetDefinitionText(definition)) return false;
    const instruction = typeof receipt.instruction === 'string' ? receipt.instruction : receipt.instruction?.instruction;
    return instruction === definition.instruction && (definition.kind !== 'append' || receipt.worker.id === definition.id);
  } catch { return false; }
}
export function resolveDeviceValetReceipt(receipt, definition) {
  if (!validDeviceValetReceipt(receipt, definition)) return false;
  pending.delete(definition.client_request_id); save(); return true;
}

/** Passwords only exist in this request's local variables/DOM, never recovery data or diagnostics. */
export async function sendDeviceValet(definition, password, { send = (...args) => fetch(...args) } = {}) {
  definition = normalizeDeviceValetDefinition(definition);
  if (pendingDeviceValet(definition.kind, definition.id).length) throw new Error('原提交结果未知，请先只读核对收据，不重复发送。');
  const evidence = { definition }; pending.set(definition.client_request_id, evidence); save();
  let body = JSON.stringify({ definition, password, confirm: true }), refusal = null; password = '';
  try {
    const flight = send(endpoint('submit'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); body = '';
    const response = await flight;
    if (!response.ok) {
      let value; try { value = await response.json(); } catch { /* No trusted refusal: remain unknown. */ }
      if (value?.execution === 'not_started' && ([401, 403].includes(response.status) && value.code === 'elevation_password_rejected'
        || response.status === 429 && value.code === 'elevation_password_rate_limited')) {
        refusal = response.status === 429 ? '密码验证已限速；本条未提交，请稍后主动核对并重新输入密码。'
          : '密码验证未通过或登录已失效；本条未提交，请重新输入当前 Web 登录密码。';
        pending.delete(definition.client_request_id); save();
      }
      throw new Error('unconfirmed');
    }
    const receipt = await response.json();
    if (!resolveDeviceValetReceipt(receipt, definition)) throw new Error('unconfirmed');
    return receipt;
  } catch {
    throw new Error(refusal || '提交结果未知；已保留不含密码的原指令与请求身份。请只读核对收据，不自动重发或换身份。');
  } finally { password = ''; body = ''; }
}

export function syncDeviceValetSecrets() {
  for (const item of secretForms) if (!item.current()) {
    item.clear();
    if ($('modal')?.querySelector('.device-valet-confirmation') === item.node) closeDialog();
  }
}

export async function confirmDeviceValet(definition, { current = () => true, send, changed = () => {}, sourceLabel = '', targetLabel = '' } = {}) {
  definition = normalizeDeviceValetDefinition(definition);
  const owner = document, pathname = location.pathname, hash = location.hash;
  const owns = () => document === owner && location.pathname === pathname && location.hash === hash && current();
  const node = el('div', undefined, 'device-valet-confirmation');
  node.append(el('p', definition.kind === 'create' ? '创建设备管家并执行首条指令' : `追加到 ${targetLabel || `#${definition.id}`} · ID ${definition.id}`),
    el('p', DEVICE_VALET_RISK, 'device-valet-risk'), el('h3', '本条完整指令'), el('pre', definition.instruction, 'device-valet-reading'),
    el('p', `本条来源：${sourceLabel ? `${sourceLabel} · ` : ''}${definition.profile.connection_id} · 模型：${definition.profile.model} · 思考：${definition.profile.thinking || '默认'}`, 'device-valet-model-summary'),
    el('p', '仅这条完整指令获得设备资源权限；下一条（含追加）重新验证密码。', 'hint'));
  const label = el('label', '当前 Lush Web 登录密码'), password = el('input', undefined, 'device-valet-password');
  password.type = 'password'; password.setAttribute('type', 'password'); password.autocomplete = 'current-password'; password.setAttribute('autocomplete', 'current-password');
  password.maxLength = 1024; password.setAttribute('aria-label', '当前 Lush Web 登录密码'); label.append(password); node.append(label);
  const status = el('p', '', 'device-valet-confirm-status'); status.setAttribute('role', 'status'); node.append(status);
  const clear = () => { password.value = ''; };
  const item = { node, clear, current: owns }; secretForms.add(item);
  const leave = () => { clear(); if ($('modal')?.querySelector('.device-valet-confirmation') === node) closeDialog(); };
  const observe = typeof MutationObserver === 'function' ? new MutationObserver(() => { if (!owns()) leave(); }) : null;
  observe?.observe(owner.documentElement, { childList: true, subtree: true }); globalThis.addEventListener?.('pagehide', leave);
  let result = null;
  try {
    await formDialog({ title: '核对设备指令并验证密码', content: node, cardClass: 'device-valet-modal',
      confirmLabel: '验证密码并执行这一条', agent: true, confirmHelp: agentHelp('重新验证 Web 登录密码后执行这条设备资源指令；影响所有项目共享的模型与来源，授权不沿用。'),
      canConfirm: () => owns() && !pendingDeviceValet(definition.kind, definition.id).length,
      initialFocus: password,
      onConfirm: async () => {
        if (!owns()) { clear(); return false; }
        let secret = password.value; clear();
        if (!secret) { status.textContent = '请输入当前 Web 登录密码；不会缓存免密。'; return false; }
        try { const flight = sendDeviceValet(definition, secret, { send }); secret = ''; result = await flight; return true; }
        catch (error) { if (owns()) status.textContent = error.message; return false; }
        finally { secret = ''; clear(); changed(); }
      } });
    return result;
  } finally { clear(); secretForms.delete(item); observe?.disconnect(); globalThis.removeEventListener?.('pagehide', leave); }
}

export function deviceValetReceipts({ request, current = () => true, resolved = () => {}, changed = () => {} }) {
  const root = el('section', undefined, 'device-valet-receipts');
  function paint() {
    root.replaceChildren(); const values = pendingDeviceValet(); root.hidden = !values.length;
    if (values.length) root.append(el('h2', '提交结果未知'), el('p', '以下只读核对不会调用 Agent，也不会重新提交。未找到不证明未执行。', 'warn'));
    for (const { definition } of values) {
      const item = el('div', undefined, 'device-valet-unknown');
      item.append(el('p', `${definition.kind === 'create' ? '新建设备管家' : `追加到 #${definition.id}`} · 请求 ${definition.client_request_id}`, 'mono'),
        el('pre', definition.instruction, 'device-valet-reading'));
      const status = el('p', '', 'hint'); status.setAttribute('role', 'status');
      item.append(button('只读核对原提交', async () => {
        if (!current()) return;
        try {
          const result = await request('receipt', { client_request_id: definition.client_request_id });
          if (!current()) return;
          if (!resolveDeviceValetReceipt(result, definition)) { status.textContent = '尚未确认匹配原提交；保留未知，不重发。'; return; }
          paint(); changed(); resolved(result);
        } catch { if (current()) status.textContent = '收据核对失败；保留原指令和未知锁定，不重发。'; }
      }, 'ghost', { busyLabel: '核对中…', help: '仅读取精确原请求的提交收据；不重发、不调用 Agent，提交存在不代表执行成功。' }), status);
      root.append(item);
    }
  }
  paint(); return { root, refresh: paint };
}
