/**
 * The read models of the process tree: one row, the whole list, the tree with
 * live-agent activity, the unified `view`, a process handle, and the
 * snapshot backfill that keeps old rows readable.
 *
 * Nothing here decides anything; every function reads the repository through
 * the `ProcessManager` passed in. The class in `process_manager.js` is the
 * only caller.
 */
import { LushError, VIEW_SECTIONS, validPid, viewSections } from './types.js';
import { Process } from './process.js';

/**
 * Snapshot fields that older databases were written without. Adding a template
 * field is a breaking change for template files, but persisted snapshots must
 * stay readable, so they are filled in once per daemon start. Only
 * `child_templates` (creation-time permissions) and `variables`
 * (creation-time variable declaration) are read back from a snapshot; every
 * other template field is read from the currently loaded definition.
 */
const BACKFILLED_FIELDS = ['child_templates', 'variables'];

/** A PID handle bound to this manager (see `process.js`). */
export function load(manager, pid) {
  manager.repository.get(pid);
  return new Process(pid, manager);
}

/**
 * Every process metadata row; `process tree` adds live-agent activity on top
 * (see `tree`). Rows are never duplicated or filtered here.
 */
export function list(manager) {
  return manager.repository.list();
}

/**
 * `process tree`: the same rows as `list`, each with its live agents unless
 * `agents` is false. Only runtime facts are attached — no argv, no session
 * walk — so the tree stays one cheap read for N processes.
 */
export function tree(manager, agents = true) {
  if (typeof agents !== 'boolean') throw new LushError('agents must be a boolean', -32602);
  const rows = manager.repository.list();
  if (!agents) return rows;
  // The row already carries the selected profile, so the provider name costs no
  // extra read per process.
  return rows.map((row) => ({ ...row, agent: manager.agentInfo(row.pid, row.agent_profile) }));
}

export function inspect(manager, pid) {
  const process = manager.repository.get(pid);
  const profileError = manager.agentProfileError(pid, process.agent_profile);
  return {
    ...process,
    context: manager.repository.context(pid),
    agent: {
      status: manager.runtime && manager.runtime.isBusy(pid) ? 'busy' : 'idle',
      provider: manager.agentProviderName(pid, process.agent_profile),
      // The agent profile this process selected; `default` is the fallback tier.
      profile: manager.agentProfileName(pid, process.agent_profile),
      // Set when the selected profile no longer resolves (deleted or invalid
      // file): reading the process still works, calling it does not.
      ...(profileError === null ? {} : { profile_error: profileError }),
    },
    recent_calls: manager.repository.calls(pid),
    recent_events: manager.repository.events(pid),
  };
}

export function parent(manager, pid) {
  const parentPid = manager.repository.get(pid).parent_pid;
  return parentPid === null ? null : manager.repository.get(parentPid);
}

export function children(manager, pid) {
  return manager.repository.children(pid);
}

/**
 * Unified "查看" read model. Sections are validated before any lookup, and a
 * missing process is reported the same way for every section.
 */
export function view(manager, pid, sections = VIEW_SECTIONS) {
  const requested = viewSections(sections);
  validPid(pid);
  manager.repository.get(pid); // a missing process fails the same way for every section
  const result = { pid };
  for (const section of requested) {
    if (section === 'parent') result.parent = manager.parent(pid);
    else if (section === 'children') result.children = manager.children(pid);
    else if (section === 'prompt') result.call_prompt = manager.repository.context(pid).system_prompt;
    else throw new LushError(`unhandled view section: ${section}`);
  }
  return result;
}

/**
 * Fill snapshot fields that predate this version from the currently loaded
 * template of the same name. Idempotent; templates that are gone are skipped
 * instead of failing startup, and no other snapshot key is modified.
 */
export function backfillTemplateSnapshots(manager) {
  const filled = [];
  const unknown_template = [];
  for (const process of manager.repository.list()) {
    const missing = BACKFILLED_FIELDS.filter((field) => !Object.hasOwn(process.template_snapshot, field));
    if (missing.length === 0) continue;
    const template = manager.templates.find(process.template);
    if (template === null) {
      unknown_template.push(process.pid);
      continue;
    }
    const fields = Object.fromEntries(missing.map((field) => [field, template[field]]));
    if (manager.repository.backfillSnapshot(process.pid, fields).length) filled.push(process.pid);
  }
  return { filled, unknown_template };
}

/**
 * The read every mutating verb starts with: the process must exist, and it must
 * be running. The row is returned so the caller does not read it twice.
 */
export function requireRunning(manager, pid) {
  const process = manager.repository.get(pid);
  if (process.status !== 'running') {
    throw new LushError(`process ${pid} is ${process.status}, expected running`);
  }
  return process;
}

export function history(manager, pid, after = 0, limit = 100) {
  validPid(pid);
  if (!Number.isInteger(after) || after < 0 || after > Number.MAX_SAFE_INTEGER
    || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new LushError('after must be nonnegative; limit must be 1..1000', -32602);
  }
  return manager.repository.history(pid, after, limit);
}
