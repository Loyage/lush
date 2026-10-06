import { check, id, isPlainObject } from '../../core/types.js';

function revision(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value), 'expected_revision must be a Hooks read revision');
  return value;
}
function hookId(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 128
    && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value), 'invalid Hook id');
  return value;
}

/** User-only Hook configuration; the runtime owns definition validation and execution. */
export const handlers = {
  'hooks.list'(p) { return p.hooksList(); },
  'hooks.save'(p, params) {
    const expected = revision(params.expected_revision);
    check(isPlainObject(params.template), 'template must be an object');
    return p.saveHookTemplate(params.template, expected);
  },
  'hooks.remove'(p, params) { return p.removeHookTemplate(hookId(params.id), revision(params.expected_revision)); },
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
