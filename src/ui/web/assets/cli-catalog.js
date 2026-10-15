import { api } from './api.js';

const operations = ['read', 'write'];
export function validateCliCatalog(value) {
  if (value?.version !== 1 || value.source !== 'builtin-cli' || !Array.isArray(value.commands)
    || value.commands.length > 1000 || !value.commands.length
    || new Set(value.commands.map(item => item.path)).size !== value.commands.length
    || value.commands.some(item => !['lush', 'lushc'].includes(item.executable) || typeof item.command_path !== 'string'
      || item.path !== `${item.executable} ${item.command_path}` || typeof item.description !== 'string'
      || typeof item.usage !== 'string' || typeof item.format !== 'string' || typeof item.risk !== 'string' || !Array.isArray(item.rpc)
      || !Array.isArray(item.operations) || !item.operations.length || new Set(item.operations).size !== item.operations.length
      || item.operations.some(operation => !operations.includes(operation))
      || (item.directory ? item.operation !== null : !operations.includes(item.operation) || item.operations.length !== 1 || item.operations[0] !== item.operation)
      || item.rpc.some(rpc => typeof rpc.method !== 'string' || !Array.isArray(rpc.parameters) || !Array.isArray(rpc.allowed_access))
      || item.parent && !value.commands.some(parent => parent.path === item.parent && parent.directory))) {
    throw Error('CLI 目录不完整或不兼容，请重试读取目录。');
  }
  // A directory's filters must reflect actual executable-specific leaves.
  if (value.commands.some(item => item.directory && operations.some(operation => item.operations.includes(operation)
    !== value.commands.some(leaf => !leaf.directory && leaf.path.startsWith(`${item.path} `) && leaf.operation === operation)))) {
    throw Error('CLI 目录读写分类不一致，请重试读取目录。');
  }
  return value;
}

// Only code-shipped learning data is retained. HTTP's private immutable cache
// persists across browser restarts; this document-scoped flight also avoids work
// on same-page navigation. No local/session storage or project permissions enter it.
const documents = new WeakMap();
export function loadCliCatalog({ retry = false } = {}) {
  const owner = globalThis.document;
  const asset = owner.getElementById('cli-catalog-asset')?.getAttribute('content');
  if (asset && !/^\/web-[a-f0-9]{32}-cli-catalog\.json$/.test(asset)) return Promise.reject(Error('CLI 静态目录地址无效，请刷新页面。'));
  // Source modules used by historical HTML still have a Host-only, daemon-free read.
  const url = asset || '/api/host/cli/catalog';
  let entry = documents.get(owner);
  if (entry?.url === url && entry.pending) return entry.pending;
  if (entry?.url === url && entry.value && !retry) return Promise.resolve(entry.value);
  entry = { url, failed: entry?.url === url && entry.failed };
  documents.set(owner, entry);
  const pending = api(url, { cache: retry || entry.failed ? 'reload' : 'default' }).then(validateCliCatalog);
  entry.pending = pending.then(value => { entry.value = value; entry.failed = false; return value; }, error => {
    // Invalid JSON/schema must never poison the in-memory or HTTP retry path.
    entry.failed = true; throw error;
  }).finally(() => { entry.pending = null; });
  return entry.pending;
}
