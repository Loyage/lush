/**
 * The node layer: SID 0's own setup, the service read models, and the two
 * variable verbs. Everything here treats a service as a *record* — identity,
 * snapshot, Context, state — never as something that runs.
 *
 * Exported as a method group: `index.js` merges it into `ServiceManager`.
 */
import { VIEW_SECTIONS } from '../types.js';
import { checkWorkdir, spawnVariables, updateState, updateVars } from '../variables.js';
import {
  backfillTemplateSnapshots, children, inspect, list, load, parent, requireActive, tree, view,
} from '../queries.js';

export const read = {
  ensureRoot() {
    if (!this.repository.exists(0)) {
      this.repository.create(null, this.templates.get('lush-root'), 'lush', '管理 Lush 服务与收养孤儿服务', { root: true });
    }
  },

  /**
   * SID 0 is the one exception to "snapshots are creation-time": its permissions
   * and prompt follow the currently loaded `lush-root` template, refreshed once
   * per daemon start. Only SID 0 — every other service keeps its snapshot.
   */
  refreshRootTemplate() {
    if (!this.repository.exists(0)) return { refreshed: false, changed: [], missing: false };
    const template = this.templates.find('lush-root');
    if (template === null) return { refreshed: false, changed: [], missing: true };
    const changed = this.repository.replaceSnapshot(0, template);
    // The snapshot carries `system_prompt`, but a task's prompt is read from the
    // persisted Context (`buildInvocation`), so the Context has to follow the
    // template too — otherwise editing `templates/lush-root.json` would only
    // show up in `inspect` and never reach the agent.
    const promptChanged = this.repository.replaceContextPrompt(0, template.system_prompt);
    if (promptChanged && !changed.includes('system_prompt')) {
      changed.push('system_prompt');
      this.repository.event(0, 'template_refreshed', { template: template.name, fields: ['system_prompt'] });
    }
    return { refreshed: changed.length > 0, changed, missing: false };
  },

  // ── Service read models (see queries.js) ────────────────────────────────

  load(sid) {
    return load(this, sid);
  },

  list() {
    return list(this);
  },

  tree(agents = true) {
    return tree(this, agents);
  },

  inspect(sid) {
    return inspect(this, sid);
  },

  parent(sid) {
    return parent(this, sid);
  },

  children(sid) {
    return children(this, sid);
  },

  view(sid, sections = VIEW_SECTIONS) {
    return view(this, sid, sections);
  },

  backfillTemplateSnapshots() {
    return backfillTemplateSnapshots(this);
  },

  /** The read every mutating verb starts with: the service must be active. */
  requireActive(sid) {
    return requireActive(this, sid);
  },

  // ── Variables and service state (see variables.js) ─────────────────────────

  spawnVariables(template, variables) {
    return spawnVariables(template, variables);
  },

  checkWorkdir(value) {
    return checkWorkdir(value);
  },

  updateState(sid, patch) {
    return updateState(this, sid, patch);
  },

  updateVars(sid, patch) {
    return updateVars(this, sid, patch);
  },
};
