import { check, isPlainObject, LushError } from './types.js';

const failed = () => new LushError('managed model selection failed');
const cancelled = () => new LushError('managed model selection cancelled');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** Await a trusted hook without allowing an uncooperative promise to hold an invocation slot after cancellation. */
async function abortable(operation, signal) {
  if (!signal) return operation();
  if (signal.aborted) throw cancelled();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw cancelled();
      return operation();
    }), aborted]);
  } finally { signal.removeEventListener('abort', onAbort); }
}

/** Internal extension seam, not a user-script loader or an Agent-writable routing setting. */
export class AgentSelectionService {
  constructor(project, { strategy = null } = {}) {
    check(strategy === null || typeof strategy === 'function', 'model selection strategy must be a function');
    this.project = project;
    this.strategy = strategy;
  }

  get enabled() { return this.strategy !== null; }

  resources() {
    try {
      const list = this.project.agentConnections.list();
      return { version: 1, checked_at: list.checked_at,
        connections: list.connections.map(connection => ({ ...connection, supported_agents: ['pi'] })),
        ...(list.warning ? { warning: list.warning } : {}) };
    } catch { throw failed(); }
  }

  async select(task, profile, { explicit = false, signal } = {}) {
    // This fast path must not instantiate the credential manager, query resources or touch the network.
    if (!this.enabled || explicit) return profile;
    try {
      if (signal?.aborted || this.project.stopping) throw cancelled();
      const resources = freeze(structuredClone(this.resources()));
      // Keep private cache revisions out of the hook's input. Credential/account or endpoint edits
      // while the hook is pending must not turn an old balance decision into use of a new account.
      const revisions = new Map(resources.connections.map(connection => [connection.id,
        this.project.agentConnections.snapshot(connection.id).state.revision]));
      const input = Object.freeze({
        worker: freeze({ id: task.id, role: task.role, task_kind: task.task_kind }),
        profile: freeze({ agent: profile.agent, model: profile.model || '', thinking: profile.thinking || '',
          ...(profile.connection_id ? { connection_id: profile.connection_id } : {}) }),
        resources, signal,
      });
      const selection = await abortable(() => this.strategy(input), signal);
      if (signal?.aborted || this.project.stopping) throw cancelled();
      if (selection === null || selection === undefined) return profile;
      check(isPlainObject(selection) && Object.keys(selection).length === 2
        && Object.keys(selection).every(key => ['connection_id', 'model'].includes(key)), 'invalid model selection');
      check(typeof selection.connection_id === 'string' && UUID.test(selection.connection_id)
        && typeof selection.model === 'string' && Buffer.byteLength(selection.model) <= 256
        && selection.model.trim() === selection.model && !/[\x00-\x1f\x7f]/.test(selection.model), 'invalid model selection');
      // Re-read the local public view after the hook: a concurrent edit/remove must not be validated against its old input.
      const connection = this.resources().connections.find(item => item.id === selection.connection_id);
      check(connection && revisions.has(connection.id) && connection.enabled
        && connection.supported_agents.includes(profile.agent), 'unavailable model selection');
      check(this.project.agentConnections.snapshot(connection.id).state.revision === revisions.get(connection.id),
        'changed model selection connection');
      check(connection.credential.status === 'configured'
        || (connection.auth_type === 'oauth' && connection.credential.status === 'expired'), 'unavailable model selection');
      const prefix = `${connection.provider}/`;
      check(selection.model.startsWith(prefix) && selection.model.length > prefix.length, 'invalid model selection');
      const modelId = selection.model.slice(prefix.length);
      check(!connection.models.length || connection.models.includes(modelId), 'invalid model selection');
      return { ...profile, connection_id: selection.connection_id, model: selection.model };
    } catch {
      // Strategy exceptions, malicious output and raw provider errors must never reach events, RPC or model context.
      if (signal?.aborted || this.project.stopping) throw cancelled();
      throw failed();
    }
  }
}
