/**
 * The node layer: PID 0's own setup, the process read models, and the two
 * variable verbs. Everything here treats a process as a *record* — identity,
 * snapshot, Context, state — never as something that runs.
 *
 * Exported as a method group: `index.js` merges it into `ProcessManager`.
 */
import { VIEW_SECTIONS } from '../types.js';
import { checkWorkdir, spawnVariables, updateState, updateVars } from '../variables.js';
import {
  backfillTemplateSnapshots, children, inspect, list, load, parent, requireActive, tree, view,
} from '../queries.js';

export const read = {
  ensureRoot() {
    if (!this.repository.exists(0)) {
      this.repository.create(null, this.templates.get('lush-root'), 'lush', '管理 Lush 进程与收养孤儿进程', { root: true });
    }
  },

  /**
   * PID 0 is the one exception to "snapshots are creation-time": its permissions
   * and prompt follow the currently loaded `lush-root` template, refreshed once
   * per daemon start. Only PID 0 — every other process keeps its snapshot.
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

  // ── Process read models (see queries.js) ────────────────────────────────

  load(pid) {
    return load(this, pid);
  },

  list() {
    return list(this);
  },

  tree(agents = true) {
    return tree(this, agents);
  },

  inspect(pid) {
    return inspect(this, pid);
  },

  parent(pid) {
    return parent(this, pid);
  },

  children(pid) {
    return children(this, pid);
  },

  view(pid, sections = VIEW_SECTIONS) {
    return view(this, pid, sections);
  },

  backfillTemplateSnapshots() {
    return backfillTemplateSnapshots(this);
  },

  /** The read every mutating verb starts with: the process must be active. */
  requireActive(pid) {
    return requireActive(this, pid);
  },

  // ── Variables and process state (see variables.js) ─────────────────────────

  spawnVariables(template, variables) {
    return spawnVariables(template, variables);
  },

  checkWorkdir(value) {
    return checkWorkdir(value);
  },

  updateState(pid, patch) {
    return updateState(this, pid, patch);
  },

  updateVars(pid, patch) {
    return updateVars(this, pid, patch);
  },
};
