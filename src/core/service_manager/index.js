/**
 * The shared business API used by RPC, Service handles and Agent Tools.
 *
 * This class is the single entry point (`service.*` / `task.*` on the wire maps
 * to its methods) and it keeps the parts that are about *nodes and work*:
 * service creation, the service transition machine, orphan supervision, and the
 * task layer that rides on it (see `tasks.js`). The other concerns live in
 * sibling modules and are delegated to from here, so the signatures and the
 * error codes stay exactly where callers expect them: the read models
 * (`queries.js`), the variables (`variables.js`), hard removal (`removal.js`),
 * everything forwarded to the runtime (`agent_calls.js`) and the task rules
 * themselves (`tasks.js`).
 *
 * The surface is wide, so it is assembled from the layers in the same-named
 * directory, all merged onto one prototype so callers keep seeing a single flat
 * object:
 *
 *   service_manager/read.js    SID 0 setup, read models, variables
 *   service_manager/nodes.js   spawn, the transition machine, orphans, removal
 *   service_manager/agents.js  profile resolution and the agent verbs
 *   service_manager/tasks.js   the task verbs
 *
 * Only the constructor and the `orphanPolicy` getter live in the class body:
 * `Object.assign` copies getter *values*, not the getters themselves.
 */
import { DEFAULT_ORPHAN_POLICY, OrphanSupervisor } from '../orphans.js';
import { agents } from './agents.js';
import { nodes } from './nodes.js';
import { read } from './read.js';
import { taskLayer } from './tasks.js';

export class ServiceManager {
  constructor(repository, templates, orphanPolicy = DEFAULT_ORPHAN_POLICY) {
    this.repository = repository;
    this.templates = templates;
    this.runtime = null; // composition root binds the AgentRuntime
    /**
     * Agent profile catalog (`agent/catalog.js`) used to resolve which backend
     * answers for one service. The composition root binds it like `runtime`;
     * when unbound (embedded use) every service uses the runtime's provider.
     */
    this.agentCatalog = null;
    /** SID 0's orphan supervision: policy plus the read model behind it. */
    this.orphanSupervisor = new OrphanSupervisor(repository, this, orphanPolicy);
    /**
     * Task waiters, in memory: `taskWaiters` is keyed by the task being awaited
     * and `childWaiters` by the parent task that wants to know when any of its
     * children settles. A restarted daemon fails unfinished tasks instead of
     * resuming them (`Repository.recover`), so nothing here needs to persist.
     */
    this.taskWaiters = new Map();
    this.childWaiters = new Map();
  }

  /**
   * Orphan supervision policy in its internal camelCase shape (the daemon
   * reads `sweepSeconds` to decide whether to arm its timer).
   */
  get orphanPolicy() {
    return this.orphanSupervisor.policy;
  }
}

Object.assign(ServiceManager.prototype, read, nodes, agents, taskLayer);
