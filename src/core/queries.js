/**
 * The read models of the service tree: one row, the whole list, the tree with
 * live-agent activity, the unified `view`, a service handle, and the
 * snapshot backfill that keeps old rows readable.
 *
 * Nothing here decides anything; every function reads the repository through
 * the `ServiceManager` passed in. The class in `service_manager.js` is the
 * only caller.
 */
import { LushError, VIEW_SECTIONS, validSid, viewSections } from './types.js';
import { Service } from './service.js';

/**
 * Snapshot fields that older databases were written without. Adding a template
 * field is a breaking change for template files, but persisted snapshots must
 * stay readable, so they are filled in once per daemon start. Only
 * `child_templates` (creation-time permissions) and `variables`
 * (creation-time variable declaration) are read back from a snapshot; every
 * other template field is read from the currently loaded definition.
 */
const BACKFILLED_FIELDS = ['child_templates', 'variables'];

/** A SID handle bound to this manager (see `service.js`). */
export function load(manager, sid) {
  manager.repository.get(sid);
  return new Service(sid, manager);
}

/**
 * Every service metadata row; `service tree` adds live-agent activity on top
 * (see `tree`). Rows are never duplicated or filtered here.
 */
export function list(manager) {
  return manager.repository.list();
}

/**
 * `service tree`: the same rows as `list`, each with its live agents unless
 * `agents` is false. Only runtime facts are attached — no argv, no session
 * walk — so the tree stays one cheap read for N services.
 */
export function tree(manager, agents = true) {
  if (typeof agents !== 'boolean') throw new LushError('agents must be a boolean', -32602);
  const rows = manager.repository.list();
  if (!agents) return rows;
  // The row already carries the selected profile, so the provider name costs no
  // extra read per service.
  return rows.map((row) => ({ ...row, agent: manager.agentInfo(row.sid, row.agent_profile) }));
}

export function inspect(manager, sid) {
  const service = manager.repository.get(sid);
  const profileError = manager.agentProfileError(sid, service.agent_profile);
  return {
    ...service,
    /** Work mounted on this node, newest first: the tasks it is the home of. */
    recent_tasks: manager.repository.tasksOfService(sid).slice(-10).reverse(),
    context: manager.repository.context(sid),
    agent: {
      status: manager.runtime && manager.runtime.isBusy(sid) ? 'busy' : 'idle',
      provider: manager.agentProviderName(sid, service.agent_profile),
      // The agent profile this service selected; `default` is the fallback tier.
      profile: manager.agentProfileName(sid, service.agent_profile),
      // Set when the selected profile no longer resolves (deleted or invalid
      // file): reading the service still works, calling it does not.
      ...(profileError === null ? {} : { profile_error: profileError }),
    },
    recent_calls: manager.repository.calls(sid),
    recent_events: manager.repository.events(sid),
  };
}

export function parent(manager, sid) {
  const parentSid = manager.repository.get(sid).parent_sid;
  return parentSid === null ? null : manager.repository.get(parentSid);
}

export function children(manager, sid) {
  return manager.repository.children(sid);
}

/**
 * The child templates a service may still create: its creation-time permission
 * list (`child_templates`) filtered to what `spawn` would accept right now, in
 * loader (hierarchy) order. A singleton whose slot under this parent is already
 * taken is *not* available — advertising it would only produce a failed call.
 *
 * Both read paths go through here so they cannot drift: `service.view`'s
 * `templates` section and the `available_child_templates` an agent sees in its
 * Context.
 */
export function availableTemplates(templates, childTemplates, activeCount) {
  const snapshot = childTemplates ?? [];
  const loaded = templates === null || templates === undefined ? {} : templates.templates;
  return Object.values(loaded)
    .filter((template) => template.name !== 'lush-root'
      && (snapshot.includes('*') || snapshot.includes(template.name)))
    .filter((template) => !template.singleton || activeCount(template.name) === 0)
    .map((template) => ({
      name: template.name,
      singleton: template.singleton,
      description: template.description,
      spawn_prompt: template.spawn_prompt,
    }));
}

/**
 * Unified "查看" read model. Sections are validated before any lookup, and a
 * missing service is reported the same way for every section.
 */
export function view(manager, sid, sections = VIEW_SECTIONS) {
  const requested = viewSections(sections);
  validSid(sid);
  // A missing service fails the same way for every section, so read it once.
  const service = manager.repository.get(sid);
  const snapshot = service.template_snapshot ?? {};
  const templates = manager.templates ?? null;
  const result = { sid };
  for (const section of requested) {
    if (section === 'description') {
      // The description is template identity, not creation-time data: read the
      // loaded definition and only fall back to the snapshot when the template
      // is gone.
      const template = templates === null ? null : templates.find(service.template);
      result.description = (template ?? snapshot).description ?? null;
    } else if (section === 'parent') {
      result.parent = manager.parent(sid);
    } else if (section === 'children') {
      result.children = manager.children(sid);
    } else if (section === 'prompt') {
      result.call_prompt = manager.repository.context(sid).system_prompt;
    } else if (section === 'templates') {
      result.available_child_templates = availableTemplates(
        templates, snapshot.child_templates, (name) => manager.repository.activeCount(sid, name),
      );
    } else {
      throw new LushError(`unhandled view section: ${section}`);
    }
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
  for (const service of manager.repository.list()) {
    const missing = BACKFILLED_FIELDS.filter((field) => !Object.hasOwn(service.template_snapshot, field));
    if (missing.length === 0) continue;
    const template = manager.templates.find(service.template);
    if (template === null) {
      unknown_template.push(service.sid);
      continue;
    }
    const fields = Object.fromEntries(missing.map((field) => [field, template[field]]));
    if (manager.repository.backfillSnapshot(service.sid, fields).length) filled.push(service.sid);
  }
  return { filled, unknown_template };
}

/**
 * The read every mutating verb starts with: the service must exist, and it must
 * be active (taking work). The row is returned so the caller does not read it
 * twice.
 */
export function requireActive(manager, sid) {
  const service = manager.repository.get(sid);
  if (service.status !== 'active') {
    throw new LushError(`service ${sid} is ${service.status}, expected active`);
  }
  return service;
}

export function history(manager, sid, after = 0, limit = 100) {
  validSid(sid);
  if (!Number.isInteger(after) || after < 0 || after > Number.MAX_SAFE_INTEGER
    || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new LushError('after must be nonnegative; limit must be 1..1000', -32602);
  }
  return manager.repository.history(sid, after, limit);
}
