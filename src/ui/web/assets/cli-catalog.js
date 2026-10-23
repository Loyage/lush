import { api } from './api.js';
import { el } from './dom.js';

// Search only code-owned documentation, never user data or a model.
export function searchCommands(commands, query) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const executable = ['lush', 'lushw'].includes(words[0]) ? words.shift() : null;
  return commands.filter(item => (!executable || item.executable === executable) && words.every(word => `${item.path} ${item.name} ${item.description} ${(item.keywords || []).join(' ')}`.toLocaleLowerCase().includes(word)));
}
export function commandType(item, commands) {
  const children = commands.some(child => child.parent === item.path);
  return item.directory ? '分类 · 查看子命令' : children ? '命令兼分类 · 可调用／查看子命令' : '独立命令 · 可调用';
}
export function commandGuide(item) {
  const box = el('div', undefined, 'cli-inline-guide');
  box.append(el('p', item.description));
  if (item.directory) { box.append(el('p', '分类不能直接执行，请选择子命令。')); return box; }
  box.append(el('code', item.usage, 'cli-command-code'));
  const required = (item.cli_parameters?.positionals || []).filter(value => value.required).map(value => value.name);
  for (const [name, value] of Object.entries(item.cli_parameters?.options || {})) if (value.required) required.push(name);
  box.append(el('p', `必填参数：${required.length ? required.join('、') : '以调用格式中的必填项为准'}。尖括号、大写参数名及示例目标均须核对并补全，不可照抄执行。`));
  const sources = Array.isArray(item.sources) ? item.sources : Object.entries(item.sources || {}).map(([name, source]) => `${name}：${typeof source === 'string' ? source : JSON.stringify(source)}`);
  for (const source of sources) box.append(el('p', typeof source === 'string' ? source : JSON.stringify(source)));
  box.append(el('p', `风险与身份边界：${item.risk} 静态可见不代表可执行，实时身份、权限与工作区以服务端预检为准。`));
  return box;
}
// Complete paths only. Once a parameter/body begins, never guess or replace it.
export function pathSuggestions(commands, text) {
  if (!/^(?:lushw?)(?: [a-z-]*)* ?$/.test(text)) return [];
  return commands.filter(item => item.path.startsWith(text) && item.path !== text).slice(0, 12);
}
export function currentCommand(commands, text) {
  return commands.filter(item => text === item.path || text.startsWith(`${item.path} `))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

const operations = ['read', 'write'];
export function validateCliCatalog(value) {
  if (value?.version !== 1 || value.source !== 'builtin-cli' || !Array.isArray(value.commands)
    || value.commands.length > 1000 || !value.commands.length
    || new Set(value.commands.map(item => item.path)).size !== value.commands.length
    || value.commands.some(item => !['lush', 'lushw'].includes(item.executable) || typeof item.command_path !== 'string'
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
