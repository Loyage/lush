import { api } from './api.js';

let current = null;
const listeners = new Set();
function state() {
  const owner = globalThis.document;
  if (current && current.owner === owner) return current;
  current = { owner, model: null, offline: false, error: '', read: null, saving: false, reservation: null, uncertain: false, generation: 0 };
  return current;
}
const owns = value => value === state();
export function validDeviceAutomation(model) {
  return model?.version === 1 && typeof model.revision === 'string' && !!model.revision.trim()
    && typeof model.auto_select?.enabled === 'boolean' && typeof model.completion_defaults?.enabled === 'boolean'
    && ['merge', 'accept', 'archive'].includes(model.completion_defaults.level);
}
export function deviceAutomationStatus() {
  const value = state();
  return { model: value.model, offline: value.offline, error: value.error, saving: value.saving,
    confirming: !!value.reservation, uncertain: value.uncertain, reading: !!value.read };
}
function notify(value) {
  if (!owns(value)) return;
  for (const listener of listeners) { try { listener(deviceAutomationStatus()); } catch { /* Independent views. */ } }
}
export function onDeviceAutomation(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function publish(value, model) {
  if (!validDeviceAutomation(model)) throw new Error('设备自动化响应无效；请更新 Host 并重新读取状态');
  value.model = model; value.offline = false; value.uncertain = false; value.error = ''; notify(value); return model;
}
export function applyDeviceAutomation(model) {
  const value = state();
  if (value.saving || value.uncertain) return value.model;
  value.generation++; return publish(value, model);
}
/** Confirmation is a shared lease too: no other entry may write through it. */
export function reserveDeviceAutomation() {
  const value = state();
  if (value.saving || value.reservation || value.uncertain || value.offline || !value.model) return null;
  const reservation = {}; value.reservation = reservation; notify(value);
  return { reservation, release() { if (value.reservation === reservation) { value.reservation = null; notify(value); } } };
}
export async function refreshDeviceAutomation({ reconcile = true } = {}) {
  const value = state();
  if (value.uncertain && !reconcile) return value.model; // Only an explicit reread unlocks an unknown write.
  if (value.read) return value.read;
  if (value.saving) return value.model;
  const generation = value.generation;
  const pending = api('/api/host/automation').then(model => {
    if (!owns(value) || generation !== value.generation || value.saving) return value.model;
    return publish(value, model);
  }).catch(error => {
    if (owns(value) && generation === value.generation) { value.offline = true; value.error = error.message; notify(value); }
    throw error;
  }).finally(() => { if (value.read === pending) { value.read = null; notify(value); } });
  value.read = pending; notify(value); return pending;
}
export async function saveDeviceAutomation(patch, expectedRevision, { reservation = null } = {}) {
  const value = state();
  if (value.saving || value.reservation && value.reservation !== reservation) throw new Error('设备自动化正在确认或保存，请稍候');
  if (value.uncertain || value.offline || !value.model) throw new Error('策略未确认，请先重新读取设备自动化状态');
  if (expectedRevision !== value.model.revision) throw new Error('设备策略已变化，请重新读取后再操作');
  value.saving = true; value.generation++; value.read = null; notify(value);
  try {
    const model = await api('/api/host/automation', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch, expected_revision: expectedRevision }) });
    if (!validDeviceAutomation(model) || model.auto_select.enabled !== patch.auto_select?.enabled) throw new Error('保存结果未确认，请重新读取后检查，勿重复提交');
    value.generation++;
    if (!owns(value)) return model;
    return publish(value, model);
  } catch (error) { if (owns(value)) { value.uncertain = true; value.error = error.message; notify(value); } throw error; }
  finally { value.saving = false; notify(value); }
}
export function startDeviceAutomationObserver({ interval = 3000 } = {}) {
  const owner = globalThis.document;
  let disposed = false;
  const update = () => { if (!disposed && owner === globalThis.document) void refreshDeviceAutomation({ reconcile: false }).catch(() => {}); };
  globalThis.addEventListener?.('focus', update);
  const timer = setInterval(update, interval); timer?.unref?.(); update();
  return () => { disposed = true; clearInterval(timer); globalThis.removeEventListener?.('focus', update); };
}
