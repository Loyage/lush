import { check, id, isPlainObject, text } from '../../core/types.js';

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

/** User-only Hook configuration; the runtime owns definition validation and execution. */
export const handlers = {
  'hooks.list'(p) { return p.hooksList(); },
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
    check(typeof params.enabled === 'boolean', 'enabled must be a boolean');
    return p.updateTaskHook(id(params.id), hookId(params.hook_id), params.enabled, expected);
  },
  'worker.hook_remove'(p, params) {
    return p.removeTaskHook(id(params.id), hookId(params.hook_id), revision(params.expected_revision));
  },
};
