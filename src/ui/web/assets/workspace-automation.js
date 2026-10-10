import { api } from './api.js';

let current = null;
const listeners = new Set();
function state() {
  const owner = globalThis.document;
  if (current && current.owner === owner) return current;
  current = { owner, model: null, offline: false, error: '', read: null, saving: false, generation: 0 };
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
  return { model: value.model, offline: value.offline, error: value.error, saving: value.saving };
}
function notify(value) {
  if (!owns(value)) return;
  for (const listener of listeners) { try { listener(deviceAutomationStatus()); } catch { /* Keep independent views alive. */ } }
}
export function onDeviceAutomation(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function applyDeviceAutomation(model) {
  if (!validDeviceAutomation(model)) throw new Error('设备自动化响应无效；请更新 Host 并重新读取状态');
  const value = state();
  value.model = model; value.offline = false; value.error = ''; notify(value); return model;
}
export async function refreshDeviceAutomation() {
  const value = state();
  if (value.read) return value.read;
  if (value.saving) return value.model;
  const generation = value.generation;
  const pending = api('/api/host/automation').then(model => {
    if (!owns(value) || generation !== value.generation || value.saving) return value.model;
    return applyDeviceAutomation(model);
  }).catch(error => {
    if (owns(value) && generation === value.generation) { value.offline = true; value.error = error.message; notify(value); }
    throw error;
  }).finally(() => { if (value.read === pending) value.read = null; });
  value.read = pending; return pending;
}
export async function saveDeviceAutomation(patch, expectedRevision) {
  const value = state();
  if (value.saving) throw new Error('设备自动化正在保存，请稍候');
  if (typeof expectedRevision !== 'string' || !expectedRevision.trim()) throw new Error('请先读取设备自动化状态再保存');
  value.saving = true; value.generation++; notify(value);
  try {
    const model = await api('/api/host/automation', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch, expected_revision: expectedRevision }) });
    value.generation++;
    if (!owns(value)) return model;
    return applyDeviceAutomation(model);
  } catch (error) { if (owns(value)) { value.error = error.message; notify(value); } throw error; }
  finally { value.saving = false; notify(value); }
}
export function startDeviceAutomationObserver({ interval = 3000 } = {}) {
  const owner = globalThis.document;
  let disposed = false;
  const update = () => { if (!disposed && owner === globalThis.document) void refreshDeviceAutomation().catch(() => {}); };
  globalThis.addEventListener?.('focus', update);
  const timer = setInterval(update, interval); timer?.unref?.(); update();
  return () => { disposed = true; clearInterval(timer); globalThis.removeEventListener?.('focus', update); };
}
