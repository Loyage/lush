import { check, isPlainObject } from '../types.js';
import { hookRevision } from '../hooks.js';
import { validateHookRegistration } from '../hook-registration.js';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : isPlainObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function hookInstallationReceipt(project, options) {
  const previous = project.store.get(`SELECT data FROM events WHERE type='hook.installed'
    AND json_extract(data,'$.request_key')=? ORDER BY id LIMIT 1`, hookRevision(options.client_request_id));
  if (!previous) return null;
  const receipt = JSON.parse(previous.data);
  check(receipt.definition_hash === hookRevision(canonical(options)), 'client_request_id was used for a different Hook installation');
  return receipt.result;
}

// This capability has only transactional SQLite effects. The atomic receipt is
// exact completion proof, including a crash after commit but before management settlement.
export function hookInstallationOutcome(project, call) {
  try {
    const result = hookInstallationReceipt(project, call.params);
    return result ? { status: 'succeeded', result: { submitted: true, ...result }, reason: null }
      : { status: 'failed', reason: '命令自动化未安装；事务未提交，命令与挂载均未写入。' };
  } catch { return { status: 'unknown', reason: '无法核验命令自动化安装收据；不自动重放。' }; }
}

export function hookRegistrationReceipt(project, options) {
  const previous = project.store.get(`SELECT data FROM events WHERE type='hook.registered'
    AND json_extract(data,'$.request_key')=? ORDER BY id LIMIT 1`, hookRevision(options.client_request_id));
  if (!previous) return null;
  const receipt = JSON.parse(previous.data);
  check(receipt.definition_hash === hookRevision(canonical(options)), 'client_request_id was used for a different automation registration');
  return receipt.result;
}
export function hookRegistrationOutcome(project, call) {
  try {
    const result = hookRegistrationReceipt(project, call.params);
    return result ? { status: 'succeeded', result: { submitted: true, ...result }, reason: null }
      : { status: 'failed', reason: '注册事务未提交；不自动重放。' };
  } catch { return { status: 'unknown', reason: '无法核验自动化注册收据；不自动重放。' }; }
}

export const TEMPORARY_RECEIPT_EVENTS = Object.freeze({ 'hooks.temporary_create': 'hook.temporary_created', 'hooks.temporary_reclaim': 'hook.temporary_reclaimed' });
export function temporaryAutomationReceipt(project, method, options) {
  const previous = project.store.get(`SELECT data FROM events WHERE type=? AND json_extract(data,'$.request_key')=? ORDER BY id LIMIT 1`,
    TEMPORARY_RECEIPT_EVENTS[method], hookRevision(options.client_request_id));
  if (!previous) return null;
  const receipt = JSON.parse(previous.data);
  check(receipt.definition_hash === hookRevision(canonical(options)), 'client_request_id was used for a different temporary automation request');
  return receipt.result;
}
export function saveTemporaryAutomationReceipt(project, method, options, result) {
  project.store.event(null, TEMPORARY_RECEIPT_EVENTS[method], { registry_id: result.template_id,
    request_key: hookRevision(options.client_request_id), definition_hash: hookRevision(canonical(options)), result });
}
export function temporaryAutomationOutcome(project, call) {
  try {
    const result = temporaryAutomationReceipt(project, call.method, call.params);
    return result ? { status: 'succeeded', result: { submitted: true, ...result }, reason: null }
      : { status: 'failed', reason: '临时功能事务未提交；不自动重放。' };
  } catch { return { status: 'unknown', reason: '无法核验临时功能事务收据；不自动重放。' }; }
}

export default {
  registerCommandHook(options) {
    this.assertWritable('register command automation');
    validateHookRegistration(options);
    return this.store.transaction(() => {
      const previous = hookRegistrationReceipt(this, options);
      if (previous) return previous;
      check(this.hooksList().registry.revision === options.expected_revisions.registry, 'Hook revision changed; reload before editing');
      const command = this.saveShortcutCommand(options.command, options.expected_revisions.commands).commands.items.at(-1);
      const list = this.saveHookTemplate({ ...options.hook, purpose: options.command.description ?? options.hook.name, actions: [{ type: 'command', command_id: command.id, command_version: command.version }] }, options.expected_revisions.registry);
      const item = list.templates.at(-1);
      const result = { registered: true, command_id: command.id, template_id: item.id, template_version: item.version };
      this.store.event(null, 'hook.registered', { request_key: hookRevision(options.client_request_id), definition_hash: hookRevision(canonical(options)), result });
      return result;
    });
  },

  installCommandHook() {
    check(false, 'hooks.install is retired; first hooks.register, then separately request worker.hook_attach with registered id and explicit version');
  },

};
