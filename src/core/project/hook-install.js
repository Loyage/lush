import { check, isPlainObject } from '../types.js';
import { hookRevision, HOOK_LIMITS } from '../hooks.js';
import { validateHookInstallation } from '../hook-install.js';

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

export default {
  installCommandHook(options) {
    this.assertWritable('install a command Hook');
    validateHookInstallation(options);
    const requestKey = hookRevision(options.client_request_id);
    const definitionHash = hookRevision(canonical(options));
    return this.store.transaction(() => {
      // Project-scoped durable receipt survives command/Hook removal and daemon restart.
      // It holds only hashes/identities, never Shell text or an authorization payload.
      const previous = hookInstallationReceipt(this, options);
      if (previous) return previous;
      // Existing methods retain their original lifecycle, size, definition and revision gates.
      // Nested Store transactions use SQLite savepoints: either both definitions and receipt commit, or none do.
      const sourceFloor = this.store.get('SELECT max(id) AS id FROM events')?.id ?? 0;
      const command = this.saveShortcutCommand(options.command, options.expected_revisions.commands).commands.items.at(-1);
      const hooks = this.attachTaskHook(options.id, { ...options.hook,
        actions: [{ type: 'command', command_id: command.id }] }, options.expected_revisions.worker_hooks);
      const mount = hooks.mounts.find(item => item.actions.some(action => action.command_id === command.id));
      // Installation subscribes to future merge identities, never old events submitted again after installation.
      const state = JSON.parse(this.store.task(options.id).hooks);
      state.mounts.find(item => item.id === mount.id).command_last_source = sourceFloor;
      const stored = JSON.stringify(state);
      check(Buffer.byteLength(stored) <= HOOK_LIMITS.bytes, 'mounted Hooks exceed size limit');
      this.store.update(options.id, { hooks: stored });
      const result = { installed: true, worker_id: options.id, worker_number: this.store.task(options.id).worker_number ?? null,
        command_id: command.id, hook_id: mount.id };
      this.store.event(null, 'hook.installed', { request_key: requestKey, definition_hash: definitionHash, result });
      return result;
    });
  },
};
