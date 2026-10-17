import { check, id, isPlainObject, text } from '../../core/types.js';
import { validateHookInstallation } from '../../core/hook-install.js';

function revision(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value), 'expected_revision must be a Hooks read revision');
  return value;
}
function hookId(value, label = 'Hook id') {
  check(typeof value === 'string' && value.length > 0 && value.length <= 128
    && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value), `invalid ${label}`);
  return value;
}

function commandId(value) {
  check(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value), 'invalid command id');
  return value;
}
function commandVersion(value) {
  check(Number.isSafeInteger(value) && value > 0, 'version must be a positive integer');
  return value;
}
function commandDefinition(value) {
  check(isPlainObject(value), 'command must be an object');
  check(Object.keys(value).every(key => ['id','name','kind','command','prompt','default_worker_id','description','when_to_use','tags','examples','warnings'].includes(key)), 'unknown command parameter');
  if (value.id !== undefined) commandId(value.id);
  if (Object.hasOwn(value, 'default_worker_id')) check(value.default_worker_id === null
    || Number.isSafeInteger(value.default_worker_id) && value.default_worker_id > 0, 'default_worker_id must be a positive integer or null');
  text(value.name, 'command name');
  check(value.name.length <= 120 && !value.name.includes('\0'), 'command name exceeds its size limit or contains NUL');
  // For edits the runtime preserves the existing kind. Validate the transported
  // body without forcing a prompt edit to become Shell when kind is omitted.
  const kind = value.kind ?? (value.id !== undefined && Object.hasOwn(value, 'prompt') ? 'prompt' : 'shell');
  check(['shell','prompt'].includes(kind), 'invalid shortcut command kind');
  const body = kind === 'shell' ? 'command' : 'prompt';
  check(!Object.hasOwn(value, kind === 'shell' ? 'prompt' : 'command'), 'shortcut command bodies are mutually exclusive');
  text(value[body], kind === 'shell' ? 'Shell command' : 'Agent prompt');
  check(value[body].length <= 16000 && !value[body].includes('\0'), 'invalid shortcut command body');
  for (const [key, limit] of Object.entries({ description: 2000, when_to_use: 4000, examples: 8000, warnings: 4000 })) if (Object.hasOwn(value, key)) {
    check(typeof value[key] === 'string' && value[key].length <= limit && !value[key].includes('\0'), `invalid shortcut command ${key}`);
  }
  if (Object.hasOwn(value, 'tags')) check(Array.isArray(value.tags) && value.tags.length <= 32
    && value.tags.every(tag => typeof tag === 'string' && tag.length <= 80 && !tag.includes('\0')), 'invalid shortcut command tags');
  return value;
}
function commandImportSource(value) {
  check(isPlainObject(value), 'source must be an object');
  if (Object.hasOwn(value, 'template_id')) {
    check(Object.keys(value).length === 1, 'source requires either template_id or worker_id and hook_id');
    return { template_id: hookId(value.template_id) };
  }
  check(Object.keys(value).length === 2 && Object.keys(value).every(key => ['worker_id','hook_id'].includes(key)),
    'source requires either template_id or worker_id and hook_id');
  return { worker_id: id(value.worker_id), hook_id: hookId(value.hook_id) };
}

/** User-only Hook configuration; the runtime owns definition validation and execution. */
export const handlers = {
  'hooks.list'(p) { return p.hooksList(); },
  'hooks.install'(p, { _token, ...params }) { return p.installCommandHook(validateHookInstallation(params)); },
  'hooks.automation_settings'(p, params) {
    return p.setAutomationSettings(params.patch, revision(params.expected_revision));
  },
  'worker.acceptance_notice'(p, params) {
    return p.setTaskAcceptanceNotice(id(params.id), params.enabled, revision(params.expected_revision));
  },
  'hooks.command_save'(p, params) {
    const expected = revision(params.expected_revision);
    return p.saveShortcutCommand(commandDefinition(params.command), expected);
  },
  'hooks.command_export'(p, params) {
    return p.exportShortcutCommand(commandId(params.id), commandVersion(params.version));
  },
  'hooks.command_remove'(p, params) {
    return p.removeShortcutCommand(commandId(params.id), revision(params.expected_revision));
  },
  'hooks.command_history'(p, params) {
    const options = {};
    if (Object.hasOwn(params, 'before')) {
      check(Number.isSafeInteger(params.before) && params.before > 0, 'before must be a positive event cursor');
      options.before = params.before;
    }
    if (Object.hasOwn(params, 'limit')) {
      check(Number.isSafeInteger(params.limit) && params.limit >= 1 && params.limit <= 100, 'limit must be 1..100');
      options.limit = params.limit;
    }
    if (Object.hasOwn(params, 'execution_id')) {
      check(!Object.hasOwn(params, 'before'), 'execution_id cannot be combined with before');
      options.execution_id = commandId(params.execution_id);
    }
    return p.shortcutCommandHistory(options);
  },
  'hooks.command_history_remove'(p, params) {
    check(Object.keys(params).filter(key => key !== '_token').length === 1
      && (Object.hasOwn(params, 'execution_id') || params.clear === true), 'provide either execution_id or clear:true');
    return p.removeShortcutCommandHistory(Object.hasOwn(params, 'execution_id')
      ? { execution_id: commandId(params.execution_id) } : { clear: true });
  },
  'hooks.command_import'(p, params) {
    const expected = revision(params.expected_revision);
    return p.importLegacyHookCommands(commandImportSource(params.source), expected);
  },
  'hooks.auto_select'(p, params) {
    const expected = revision(params.expected_revision);
    check(typeof params.enabled === 'boolean', 'enabled must be a boolean');
    return p.setDaemonAutoSelect(params.enabled, expected);
  },
  'hooks.completion_defaults'(p, params) {
    const expected = revision(params.expected_revision);
    check(typeof params.enabled === 'boolean', 'enabled must be a boolean');
    check(typeof params.level === 'string' && ['merge','accept','archive'].includes(params.level),
      'level must be merge|accept|archive');
    return p.setCompletionDefaults(params.enabled, params.level, expected);
  },
  'hooks.save'(p, params) {
    const expected = revision(params.expected_revision);
    check(isPlainObject(params.template), 'template must be an object');
    return p.saveHookTemplate(params.template, expected);
  },
  'hooks.remove'(p, params) { return p.removeHookTemplate(hookId(params.id), revision(params.expected_revision)); },
  'hooks.signal_save'(p, params) {
    const expected = revision(params.expected_revision);
    check(isPlainObject(params.signal), 'signal must be an object');
    return p.saveHookSignal(params.signal, expected);
  },
  'hooks.signal_remove'(p, params) { return p.removeHookSignal(hookId(params.id), revision(params.expected_revision)); },
  'management.permissions'(p) { return p.managementPermissions(); },
  'management.permission_get'(p, params) { return p.managementPermissionGet(params.method, params.scope); },
  'management.permission_set'(p, params) {
    return p.managementPermissionSet(params.method, params.access, params.expected_revision, params.scope);
  },
  'management.permissions_update'() {
    check(false, 'project management permissions writes are retired; explicitly save device permissions at /api/host/management/permissions');
  },
  async 'management.create'(p, params) {
    const name = text(params.name, 'name'), instruction = text(params.instruction, 'instruction');
    const signal_id = hookId(params.signal_id);
    check(params.mode === undefined || ['once','persistent'].includes(params.mode), 'mode must be once|persistent');
    check(params.profile === undefined || isPlainObject(params.profile), 'profile must be an object');
    const client_request_id = params.client_request_id === undefined ? undefined : hookId(params.client_request_id, 'client_request_id');
    return { task: await p.createManagementWorker({ name, instruction, signal_id,
      ...(params.mode === undefined ? {} : { mode: params.mode }), ...(params.profile === undefined ? {} : { profile: params.profile }),
      ...(client_request_id === undefined ? {} : { client_request_id }) }) };
  },
  'management.submit'(p, params) {
    const { _token: _privateToken, ...options } = params;
    return p.submitManagementInstruction(options);
  },
  'manager.catalog'(p, params, actor) { return p.managementCapabilityCatalog(id(actor)); },
  'manager.history'(p, params, actor) {
    const { _token: _privateToken, ...options } = params;
    return p.managementHistory(id(actor), options);
  },
  'manager.call'(p, params, actor) {
    return p.callManagementCapability(id(actor), params.method, params.params ?? {}, params.request_id);
  },
  'management.binding_update'(p, params) {
    const expected = revision(params.expected_revision);
    check(typeof params.enabled === 'boolean', 'enabled must be a boolean');
    return p.updateManagementBinding(id(params.id), params.enabled, expected);
  },
  'manager.query'(p, params, actor) {
    return p.managementQuery(id(actor), params.id === undefined ? undefined : id(params.id));
  },
  'manager.start'(p, params, actor) { return p.requestManagementAction(id(actor), 'start', id(params.id)); },
  'manager.retry'(p, params, actor) { return p.requestManagementAction(id(actor), 'retry', id(params.id)); },
  'worker.hooks'(p, params) { return p.taskHooks(id(params.id)); },
  'worker.completion_page'(p, params) { return p.completionWorkerPage(params); },
  'worker.completion'(p, params) {
    const expected = revision(params.expected_revision);
    check(typeof params.level === 'string' && ['off','merge','accept','archive'].includes(params.level),
      'level must be off|merge|accept|archive');
    return p.setTaskCompletion(id(params.id), params.level, expected);
  },
  'worker.hook_attach'(p, params) {
    const expected = revision(params.expected_revision);
    check(isPlainObject(params.hook), 'hook must be an object');
    return p.attachTaskHook(id(params.id), params.hook, expected);
  },
  'worker.hook_update'(p, params) {
    const expected = revision(params.expected_revision);
    if (params.hook !== undefined) {
      check(params.enabled === undefined, 'hook and enabled are mutually exclusive');
      check(isPlainObject(params.hook), 'hook must be an object');
      return p.updateTaskHook(id(params.id), hookId(params.hook_id), undefined, expected, params.hook);
    }
    check(typeof params.enabled === 'boolean', 'enabled must be a boolean');
    return p.updateTaskHook(id(params.id), hookId(params.hook_id), params.enabled, expected);
  },
  'worker.hook_remove'(p, params) {
    return p.removeTaskHook(id(params.id), hookId(params.hook_id), revision(params.expected_revision));
  },
};
