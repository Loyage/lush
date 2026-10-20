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
  { id: 'system:merge-conditions', name: '本轮条件合并', origin: 'system', purpose: '本轮安全交付或确实合入直接父的 AND 门禁；仅专用授权接口可配置。' },
  { id: 'system:input-signal', name: '输入条件信号', origin: 'system', purpose: '输入意图的受保护条件信号，不直接执行输入。' },
  { id: 'system:interruption-notice', name: '中断完成告知', origin: 'system', purpose: '维护批次真实安全退出后的受保护告知。' },
  { id: 'system:deferred-order', name: '预约发射 Worker', origin: 'system', purpose: '内部输入接缝保存的精确预约参数。' },
]);
export const registryData = project => JSON.parse(project.store.get('SELECT value FROM meta WHERE key=?', KEY)?.value ?? '{"version":1,"templates":[]}');
export function writeRegistry(project, data) {
  // Reclamation must remain possible at capacity without increasing the existing
  // byte budget. Reserve bounded tombstone space inside that same budget.
  const reclaimReserve = data.templates.filter(item => item.temporary && !item.reclaimed_at).length * 64;
  check(Buffer.byteLength(JSON.stringify(data)) + reclaimReserve <= 4 * HOOK_LIMITS.bytes, 'Hook registry exceeds 512 KiB');
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
  check(!item.reclaimed_at, 'temporary automation has been reclaimed; it cannot be mounted');
  check(item.definition, 'registered automation definition not found');
  check(item.version, 'legacy registration requires explicit hooks.upgrade before mounting');
  check(raw.enabled === undefined || typeof raw.enabled === 'boolean', 'enabled must be boolean');
  const definition = registryDefinition(item, raw.template_version);
  check(definition.actions.every(action => !['command','prompt_command'].includes(action.type) || Number.isSafeInteger(action.command_version)),
    'legacy registration requires explicit hooks.upgrade before mounting');
  return { definition: { ...definition, ...(raw.enabled === undefined ? {} : { enabled: raw.enabled }) },
    registration: { registry_id: item.id, registry_version: raw.template_version } };
}
export function registerDefinition(project, definition, { id, origin = 'custom', purpose, temporary = false } = {}) {
  const data = registryData(project), previous = id ? data.templates.find(item => item.id === id) : null;
  check(!id || previous, 'Hook template not found');
  check(!previous?.protected, 'system automation is read-only');
  check(!previous?.temporary, 'temporary automation is immutable; use explicit temporary reclaim');
  check(previous || data.templates.filter(item => !item.protected && !item.reclaimed_at).length < HOOK_LIMITS.templates, 'too many registered automations');
  const version = previous ? registryVersion(previous) + 1 : 1;
  check(Number.isSafeInteger(version), 'automation version limit reached');
  const item = { id: previous?.id ?? randomUUID(), origin: previous?.origin ?? origin, purpose: purpose ?? previous?.purpose ?? definition.name,
    ...(temporary ? { temporary: true, created_at: new Date().toISOString() } : {}),
    version, definition: pinCommands(project, definition), versions: previous ? [...(previous.versions ?? []),
      { version: registryVersion(previous), definition: previous.definition }] : [] };
  if (previous) data.templates[data.templates.indexOf(previous)] = item; else data.templates.push(item);
  writeRegistry(project, data); return item;
}
// A compact project-owned usage audit survives explicit Worker/history deletion.
// Original runtime events retain their identity and task ownership. This is an
// audit projection, never an execution/retry authorization or a copied definition.
export function automationHookEvent(project, taskId, type, data) {
  return project.store.transaction(() => {
    const eventId = project.store.event(taskId, type, data);
    if (data.registry_id && registryData(project).templates.some(item => item.id === data.registry_id && item.temporary)) {
      const fields = ['registry_id','registry_version','hook_id','execution_id','automatic','effects_unknown','enabled','worker_id','input_id'];
      const safe = Object.fromEntries(fields.filter(key => data[key] !== undefined).map(key => [key, data[key]]));
      project.store.event(null, 'hook.temporary_usage', { ...safe, usage_type: type, source_event_id: eventId,
        owner_id: taskId, owner_worker_number: project.store.get('SELECT worker_number FROM tasks WHERE id=?', taskId)?.worker_number ?? null });
    }
    return eventId;
  });
}
// Never infer completion from an absent mount or a hidden command history.
export function temporaryUsage(project, item) {
  const rows = project.store.all(`SELECT json_extract(data,'$.usage_type') AS type,count(*) AS n FROM events
    WHERE type='hook.temporary_usage' AND json_extract(data,'$.registry_id')=? GROUP BY json_extract(data,'$.usage_type')`, item.id);
  const counts = Object.fromEntries(rows.map(row => [row.type, row.n]));
  const uncertain = project.store.get(`SELECT count(DISTINCT coalesce(json_extract(data,'$.execution_id'),json_extract(data,'$.hook_id'),id)) AS n
    FROM events WHERE type='hook.temporary_usage' AND json_extract(data,'$.registry_id')=?
    AND (json_extract(data,'$.usage_type')='hook.execution_unknown' OR json_extract(data,'$.effects_unknown')=1)`, item.id).n;
  const live = project.store.all('SELECT id,hooks FROM tasks WHERE hooks IS NOT NULL').flatMap(task =>
    JSON.parse(task.hooks).mounts.filter(mount => mount.registry_id === item.id).map(mount => ({ task, mount })));
  const pending = live.filter(({ mount }) => mount.maintenance_pending || mount.pending_due_at || mount.command_pending > 0).length;
  const runningIds = new Set(live.filter(({ mount }) => mount.state === 'running').map(({ task, mount }) => `${task.id}:${mount.id}`));
  const owners = new Set([...(project.lifecycleHookRunning ?? []), ...(project.lifecycleHookQueued ?? []),
    ...(project.scheduledHookQueued ?? []), ...(project.commandHookQueued ?? [])].map(key => key.split(':').slice(0, 2).join(':')));
  for (const key of owners) {
    const [taskId, hookId] = key.split(':');
    if (project.store.get(`SELECT id FROM events WHERE type='hook.temporary_usage' AND json_extract(data,'$.registry_id')=?
      AND json_extract(data,'$.owner_id')=? AND json_extract(data,'$.hook_id')=? LIMIT 1`, item.id, Number(taskId), hookId)) runningIds.add(key);
  }
  const running = runningIds.size;
  // Unknown mount state can be left by interrupted runtime before its audit was
  // settled. Historical unknown never becomes success merely by detaching.
  const unrecorded = live.filter(({ mount }) => mount.state === 'unknown' && !project.store.get(`SELECT id FROM events
    WHERE type='hook.temporary_usage' AND json_extract(data,'$.registry_id')=? AND json_extract(data,'$.hook_id')=?
    AND (json_extract(data,'$.usage_type')='hook.execution_unknown' OR json_extract(data,'$.effects_unknown')=1) LIMIT 1`, item.id, mount.id)).length;
  const unknown = uncertain + unrecorded;
  return { mount_count: live.length, pending_count: pending, running_count: running, unknown_count: unknown,
    attached_total: counts['hook.attached'] ?? 0, succeeded_total: counts['hook.execution_succeeded'] ?? 0,
    failed_total: counts['hook.execution_failed'] ?? 0, skipped_total: counts['hook.execution_skipped'] ?? 0,
    reclaimable: !item.reclaimed_at && !live.length && !pending && !running && !unknown,
    coverage: 'retained_definition_and_usage_audit', history_complete: false };
}
export function registryPage(data, options = {}) {
  hookObject(options, ['include_reclaimed','after','limit'], 'automation list');
  check(options.include_reclaimed === undefined || typeof options.include_reclaimed === 'boolean', 'include_reclaimed must be boolean');
  check(options.limit === undefined || Number.isSafeInteger(options.limit) && options.limit >= 1 && options.limit <= 100, 'limit must be 1..100');
  const visible = data.templates.filter(item => options.include_reclaimed || !item.reclaimed_at);
  const index = options.after === undefined ? -1 : visible.findIndex(item => item.id === options.after);
  check(options.after === undefined || index >= 0, 'automation list cursor not found; reload the directory');
  const items = visible.slice(index + 1, index + 1 + (options.limit ?? 100));
  return { items, total: visible.length, has_more: index + 1 + items.length < visible.length,
    next_cursor: items.at(-1)?.id ?? null };
}
export function automationRegistry(project, options = {}) {
  const data = registryData(project), targets = new Map(data.templates.map(item => [item.id, { count: 0, items: [] }]));
  let legacy = 0;
  const add = (registryId, task, hookId, version) => {
    const list = targets.get(registryId);
    if (!list) { legacy++; return; }
    list.count++;
    if (list.items.length < 100) list.items.push({ worker_id: task.id, worker_number: task.worker_number ?? null, hook_id: hookId, version });
  };
  for (const task of project.store.all('SELECT id,worker_number,task_kind,status,branch,auto_merge,hooks FROM tasks ORDER BY id')) {
    const mergeConditions = JSON.parse(task.auto_merge ?? '{}').merge_conditions;
    if (mergeConditions && mergeConditions.state !== 'consumed') add('system:merge-conditions', task, 'merge-conditions', 1);
    if (builtinAutomationMounted(task, 'completion')) add('builtin:completion', task, 'auto-merge', 1);
    if (builtinAutomationMounted(task, 'acceptance_notice')) add('builtin:acceptance-notice', task, 'acceptance-notice', 1);
    if (project.taskConvergenceView(task)) add('system:delivery-handler', task, 'delivery-handler', 1);
    for (const mount of JSON.parse(task.hooks ?? '{"mounts":[]}').mounts)
      add(mount.registry_id, task, mount.id, mount.registry_version ?? null);
  }
  const page = registryPage(data, options);
  return { version: 1, revision: hookRevision(data), upgrade_revision: hookRevision({ data, commands: project.shortcutCommands().revision, hooks: project.store.all('SELECT id,hooks FROM tasks WHERE hooks IS NOT NULL ORDER BY id') }), complete: !options.after && !page.has_more,
    total: page.total, retained_total: data.templates.length, reclaimed_total: data.templates.filter(item => item.reclaimed_at).length,
    has_more: page.has_more, next_cursor: page.next_cursor, include_reclaimed: options.include_reclaimed ?? false, legacy_mount_count: legacy,
    target_limit: 100, items: page.items.map(item => {
      const mounted = targets.get(item.id), definition = item.definition;
      const reason = item.reclaimed_at ? '临时功能已回收；仅保留定义及使用审计，不可再次挂载。'
        : item.protected ? '受保护功能；仅可通过专用安全入口配置。'
        : !item.version || definition?.actions.some(action => ['command','prompt_command'].includes(action.type) && !action.command_version)
          ? '旧定义须显式升级后挂载。' : project.shortcutHookIssue(definition) ?? null;
      return { id: item.id, name: definition?.name ?? item.name, origin: item.origin ?? 'custom', version: registryVersion(item),
        versions: [...(item.versions ?? []).map(entry => entry.version), registryVersion(item)], purpose: item.purpose ?? definition?.name ?? item.name,
        temporary: Boolean(item.temporary), lifecycle: item.reclaimed_at ? 'reclaimed' : 'active',
        created_at: item.created_at ?? null, reclaimed_at: item.reclaimed_at ?? null,
        ...(item.temporary ? { usage: temporaryUsage(project, item) } : {}),
        mount_count: mounted.count, targets: mounted.items, targets_complete: mounted.count <= 100,
        mountable: !reason, readonly: Boolean(item.protected || item.temporary), reason };
    }) };
}
