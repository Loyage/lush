import { check } from './types.js';

export const AUTOMATION_SCOPES = ['main', 'all', 'user', 'none'];
export function automationScope(value) {
  check(AUTOMATION_SCOPES.includes(value), 'automation scope must be main, all, user or none');
  return value;
}
export function scopeMatches(scope, taskKind) {
  return scope === 'all' || scope === 'main' && ['main','owner'].includes(taskKind)
    || scope === 'user' && ['main','owner','order'].includes(taskKind);
}

/** Missing birth metadata is legacy installed capability, not permission to rewrite it. */
export function builtinAutomationMounted(task, feature) {
  // Historical say already supported notices; raw legacy records must not lose that capability.
  if (feature === 'acceptance_notice' && task.task_kind === 'say') return true;
  if (!['order','child'].includes(task.task_kind)) return false;
  if (feature === 'completion' && task.task_kind === 'child') return true;
  const config = JSON.parse(task.auto_merge ?? '{}');
  const mounted = config.mounted_features?.[feature] ?? true;
  check(typeof mounted === 'boolean', 'invalid persisted automation mount');
  return mounted;
}
