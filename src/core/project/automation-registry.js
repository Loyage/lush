import { randomUUID } from 'node:crypto';
import { check } from '../types.js';
import { hookObject, hookRevision, HOOK_LIMITS } from '../hooks.js';
import { builtinAutomationMounted } from '../automation-scopes.js';
import { HOOK_MOUNT_KEYS } from '../hook-registration.js';

const KEY = 'hook_templates';
export const SYSTEM_AUTOMATIONS = Object.freeze([
  { id: 'builtin:completion', name: '成果自动合并与验收', origin: 'builtin', purpose: '交付就绪后按已授权最高级别推进；child 流程锁定。' },
  { id: 'builtin:acceptance-notice', name: '待验收告知', origin: 'builtin', purpose: '真实进入待验收时告知。' },
  { id: 'system:delivery-handler', name: '交付处理器', origin: 'system', purpose: '串行处理已授权交付，不产生来源授权。' },
  { id: 'system:input-signal', name: '输入条件信号', origin: 'system', purpose: '输入意图的受保护条件信号，不直接执行输入。' },
  { id: 'system:interruption-notice', name: '中断完成告知', origin: 'system', purpose: '维护批次真实安全退出后的受保护告知。' },
  { id: 'system:deferred-order', name: '预约发射 Worker', origin: 'system', purpose: '内部输入接缝保存的精确预约参数。' },
]);
export const registryData = project => JSON.parse(project.store.get('SELECT value FROM meta WHERE key=?', KEY)?.value ?? '{"version":1,"templates":[]}');
export function writeRegistry(project, data) {
  check(Buffer.byteLength(JSON.stringify(data)) <= 4 * HOOK_LIMITS.bytes, 'Hook registry exceeds 512 KiB');
  project.store.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, JSON.stringify(data));
}
export const registryVersion = item => item.version ?? 1;
export function registryDefinition(item, version) {
  check(Number.isSafeInteger(version) && version > 0, 'template_version must be an explicit positive integer');
  const value = version === registryVersion(item) ? item.definition : item.versions?.find(entry => entry.version === version)?.definition;
  check(value, 'registered automation version not found');
  return structuredClone(value);
}
export function pinCommands(project, definition) {
  return { ...definition, actions: definition.actions.map(action => ['command','prompt_command'].includes(action.type)
    ? { ...action, command_version: project.resolveShortcutCommand(action).version } : action) };
}
/** Trusted runtime bootstrap only; never call from a read API. */
export function ensureSystemRegistry(project) {
  const data = registryData(project); let changed = false;
  for (const entry of SYSTEM_AUTOMATIONS) if (!data.templates.some(item => item.id === entry.id)) {
    data.templates.push({ ...entry, version: 1, protected: true }); changed = true;
  }
  if (changed) writeRegistry(project, data);
}
export function systemRegistration(project, id) {
  ensureSystemRegistry(project);
  check(SYSTEM_AUTOMATIONS.some(item => item.id === id), 'unknown system automation');
  return { registry_id: id, registry_version: 1 };
}
export function resolveRegisteredMount(project, raw) {
  hookObject(raw, HOOK_MOUNT_KEYS, 'registered mount; register with hooks.save before mounting');
  const item = registryData(project).templates.find(item => item.id === raw.template_id);
  check(item, 'registered automation not found');
  check(!item.protected, 'system automation is read-only; use its dedicated authorized entry');
  check(item.definition, 'registered automation definition not found');
  check(item.version, 'legacy registration requires explicit hooks.upgrade before mounting');
  check(raw.enabled === undefined || typeof raw.enabled === 'boolean', 'enabled must be boolean');
  const definition = registryDefinition(item, raw.template_version);
  check(definition.actions.every(action => !['command','prompt_command'].includes(action.type) || Number.isSafeInteger(action.command_version)),
    'legacy registration requires explicit hooks.upgrade before mounting');
  return { definition: { ...definition, ...(raw.enabled === undefined ? {} : { enabled: raw.enabled }) },
    registration: { registry_id: item.id, registry_version: raw.template_version } };
}
export function registerDefinition(project, definition, { id, origin = 'custom', purpose } = {}) {
  const data = registryData(project), previous = id ? data.templates.find(item => item.id === id) : null;
  check(!id || previous, 'Hook template not found');
  check(!previous?.protected, 'system automation is read-only');
  check(previous || data.templates.filter(item => !item.protected).length < HOOK_LIMITS.templates, 'too many registered automations');
  const version = previous ? registryVersion(previous) + 1 : 1;
  check(Number.isSafeInteger(version), 'automation version limit reached');
  const item = { id: previous?.id ?? randomUUID(), origin: previous?.origin ?? origin, purpose: purpose ?? previous?.purpose ?? definition.name,
    version, definition: pinCommands(project, definition), versions: previous ? [...(previous.versions ?? []),
      { version: registryVersion(previous), definition: previous.definition }] : [] };
  if (previous) data.templates[data.templates.indexOf(previous)] = item; else data.templates.push(item);
  writeRegistry(project, data); return item;
}
export function automationRegistry(project) {
  const data = registryData(project), targets = new Map(data.templates.map(item => [item.id, { count: 0, items: [] }]));
  let legacy = 0;
  const add = (registryId, task, hookId, version) => {
    const list = targets.get(registryId);
    if (!list) { legacy++; return; }
    list.count++;
    if (list.items.length < 100) list.items.push({ worker_id: task.id, worker_number: task.worker_number ?? null, hook_id: hookId, version });
  };
  for (const task of project.store.all('SELECT id,worker_number,task_kind,status,branch,auto_merge,hooks FROM tasks ORDER BY id')) {
    if (builtinAutomationMounted(task, 'completion')) add('builtin:completion', task, 'auto-merge', 1);
    if (builtinAutomationMounted(task, 'acceptance_notice')) add('builtin:acceptance-notice', task, 'acceptance-notice', 1);
    if (project.taskConvergenceView(task)) add('system:delivery-handler', task, 'delivery-handler', 1);
    for (const mount of JSON.parse(task.hooks ?? '{"mounts":[]}').mounts)
      add(mount.registry_id, task, mount.id, mount.registry_version ?? null);
  }
  return { version: 1, revision: hookRevision(data), upgrade_revision: hookRevision({ data, commands: project.shortcutCommands().revision, hooks: project.store.all('SELECT id,hooks FROM tasks WHERE hooks IS NOT NULL ORDER BY id') }), complete: true, total: data.templates.length, legacy_mount_count: legacy,
    target_limit: 100, items: data.templates.map(item => {
      const mounted = targets.get(item.id), definition = item.definition;
      const reason = item.protected ? '受保护功能；仅可通过专用安全入口配置。'
        : !item.version || definition?.actions.some(action => ['command','prompt_command'].includes(action.type) && !action.command_version)
          ? '旧定义须显式升级后挂载。' : project.shortcutHookIssue(definition) ?? null;
      return { id: item.id, name: definition?.name ?? item.name, origin: item.origin ?? 'custom', version: registryVersion(item),
        versions: [...(item.versions ?? []).map(entry => entry.version), registryVersion(item)], purpose: item.purpose ?? definition?.name ?? item.name,
        mount_count: mounted.count, targets: mounted.items, targets_complete: mounted.count <= 100,
        mountable: !reason, readonly: Boolean(item.protected), reason };
    }) };
}
