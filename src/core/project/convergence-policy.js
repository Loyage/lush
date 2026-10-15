import { check, isPlainObject } from '../types.js';
import { automationScope } from '../automation-scopes.js';
import { CONVERGENCE_COUNT_STATES, CONVERGENCE_POLICY_PREFIX, CONVERGENCE_LIMITS,
  CONVERGENCE_STATES, convergenceRevision, convergenceJSON } from '../convergence-contract.js';

const OWNERS = "task_kind IN ('main','owner','order','say','child') AND status NOT IN ('completed','failed','cancelled')";
const defaults = () => ({ version: 1, mounted: false, enabled: false, validation: null, generation: 0 });
const DEFAULTS_KEY = 'convergence_defaults:v1';
const RETIRED = 'continuous convergence is retired; use one-shot branch integration';
function flags(mounted, enabled) {
  check(typeof mounted === 'boolean', 'convergence mounted must be boolean');
  check(typeof enabled === 'boolean', 'convergence enabled must be boolean');
}
function editable() {
  return { retired: true, editable: false, reason: RETIRED };
}
function projectDefaults(project) {
  const raw = project.store.get('SELECT value FROM meta WHERE key=?', DEFAULTS_KEY)?.value;
  if (raw === undefined) return { version: 1, mounted: false, scope: 'none', enabled: false, generation: 0 };
  const value = convergenceJSON(raw);
  check(isPlainObject(value) && value.version === 1 && Number.isSafeInteger(value.generation) && value.generation >= 0,
    'invalid persisted convergence defaults');
  flags(value.mounted, value.enabled);
  if (value.scope !== undefined) {
    automationScope(value.scope);
    check(value.mounted === (value.scope !== 'none'), 'convergence mounted must match scope');
  }
  return value;
}
function defaultsView(project) {
  const value = projectDefaults(project);
  return { version: 1, mounted: value.mounted, enabled: value.enabled, scope: value.scope ?? (value.mounted ? 'all' : 'none'),
    revision: convergenceRevision({ key: DEFAULTS_KEY, value }), ...editable(project) };
}
const positive = value => Number.isSafeInteger(value) && value > 0;
const label = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : null;
const number = value => typeof value === 'string' && /^W\d+(?:-\d+)*$/.test(value) ? value : null;
const sha = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ? value : null;
const date = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
const ERROR_MESSAGES = {
  validation_failed: '最终验证失败', authorization_changed: '验证指令定义已变化',
  source_changed: '固定来源已变化，需核查', baseline_changed: '目标基线连续变化，需重新验证',
  integration_failed: '整合 Worker 未成功交付', interrupted: '执行中断，未取得完整证据',
  unknown_publish: '落地现场未知，禁止自动重放', resource_busy: '归并资源不可用', budget_exhausted: '归并重试预算已用尽',
};
export function safeConvergenceError(value) {
  if (value === null || value === undefined) return null;
  const code = typeof value === 'string' ? value : value?.code;
  return Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : '归并未完成，请检查固定来源、授权和执行记录';
}
function reference(value) {
  if (value === null) return null;
  check(isPlainObject(value)
    && Object.keys(value).every(key => ['command_id','command_version'].includes(key))
    && typeof value.command_id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.command_id)
    && (value.command_version === undefined || positive(value.command_version)), 'invalid convergence validation reference');
  return { command_id: value.command_id, ...(value.command_version === undefined ? {} : { command_version: value.command_version }) };
}
function branchName(branch) {
  check(typeof branch === 'string' && branch.length > 0 && branch.length <= 512
    && branch === branch.trim() && !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch)
    && !branch.includes('..') && !branch.includes('@{') && !branch.includes('//')
    && !branch.startsWith('/') && !branch.endsWith('/') && !branch.endsWith('.')
    && !branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')), 'invalid convergence target branch');
  return branch;
}
function owners(project, branch) {
  return project.store.all(`SELECT id,worker_number,task_kind,branch,status FROM tasks WHERE branch=? AND ${OWNERS}`, branch)
    .filter(task => !['archived','deleted'].includes(project.store.branch(task.branch)?.status));
}
function owner(project, branch) {
  const tasks = owners(project, branch); check(tasks.length === 1, 'convergence target requires one active branch owner'); return tasks[0];
}
async function localRefs(project) {
  try {
    const refs = await project.workspaces.git(project.config.project, 'for-each-ref', '--format=%(refname)', 'refs/heads');
    return new Set(refs.split('\n').filter(ref => ref.startsWith('refs/heads/')).map(ref => ref.slice(11)));
  } catch { check(false, 'cannot read local convergence target branches'); }
}
async function target(project, branch) {
  branchName(branch);
  check((await localRefs(project)).has(branch), 'convergence target must be a real local branch');
  return owner(project, branch);
}
function stored(project, branch) {
  const raw = project.store.get('SELECT value FROM meta WHERE key=?', CONVERGENCE_POLICY_PREFIX + branch)?.value;
  if (raw === undefined) return null;
  const value = convergenceJSON(raw);
  check(isPlainObject(value) && value.version === 1 && typeof value.enabled === 'boolean' && positive(value.owner_id)
    && Number.isSafeInteger(value.generation) && value.generation >= 0, 'invalid persisted convergence policy');
  check(value.mounted === undefined || typeof value.mounted === 'boolean', 'invalid persisted convergence mount');
  reference(value.validation); return value;
}
function policyRevision(project, branch, own) {
  return convergenceRevision({ version: 1, branch, owner_id: own.id, policy: stored(project, branch) });
}
function validationView(project, value) {
  if (value === null || value === undefined) return null;
  const ref = reference(value); let current = null;
  try { current = project.resolveShortcutCommand(ref); } catch { /* Missing or type-switched definitions remain unavailable. */ }
  return { ...ref, name: label(current?.name) };
}
function counts(project, branch) {
  const out = Object.fromEntries(CONVERGENCE_COUNT_STATES.map(state => [state, 0]));
  for (const row of project.store.all(`SELECT state,count(*) AS n FROM delivery_runs WHERE target_branch=?
    AND state IN (${CONVERGENCE_COUNT_STATES.map(() => '?').join(',')}) GROUP BY state`, branch, ...CONVERGENCE_COUNT_STATES))
    if (Object.hasOwn(out, row.state)) out[row.state] = row.n;
  return out;
}
function branchView(project, branch, own, activity = null) {
  const policy = project.convergencePolicy(branch);
  return { version: 1, branch, owner_id: own.id, owner_worker_number: number(own.worker_number),
    mounted: policy.mounted, enabled: policy.enabled, validation: validationView(project, policy.validation), revision: policyRevision(project, branch, own),
    ...editable(project),
    counts: activity ?? counts(project, branch) };
}

export function convergenceRunRevision(store, run) {
  return convergenceRevision({ version: 1, run, members: store.deliveryMembers(run.id) });
}
export function convergenceRunView(project, run) {
  check(run, 'convergence run not found');
  const rows = project.store.all(`SELECT m.*,t.worker_number AS live_worker_number,t.display_title,t.auto_title,t.name,substr(t.goal,1,200) AS goal
    FROM all_delivery_members m LEFT JOIN tasks t ON t.id=m.task_id WHERE m.run_id=? ORDER BY m.ordinal LIMIT ?`, run.id, CONVERGENCE_LIMITS.members);
  const memberCount = project.store.get('SELECT count(*) AS n FROM all_delivery_members WHERE run_id=?', run.id).n;
  const data = convergenceJSON(run.data, {}), outcome = convergenceJSON(run.validation_result, {});
  const ref = convergenceJSON(run.validation); let commandName = label(outcome?.command_name) || label(data?.validation_name);
  if (!commandName && ref) { try { commandName = label(project.resolveShortcutCommand(reference(ref), false).name); } catch {} }
  const validationState = outcome?.state ?? outcome?.status;
  const validation = ref || run.validation_result ? {
    state: ['pending','running','waiting','validating','succeeded','passed','failed','unknown','cancelled','blocked','not_started'].includes(validationState)
      ? validationState : 'pending',
    command_id: typeof outcome?.command_id === 'string' ? outcome.command_id : ref?.command_id ?? null,
    command_version: positive(outcome?.command_version) ? outcome.command_version : null,
    command_name: commandName, started_at: date(outcome?.started_at ?? data?.validation_started_at),
    finished_at: date(outcome?.finished_at ?? data?.validation_finished_at), error: safeConvergenceError(outcome?.error ?? (outcome?.reason ? 'validation_failed' : null)),
  } : null;
  const helperNode = project.store.get(`SELECT helper_id,helper_worker_number FROM delivery_nodes
    WHERE run_id=? AND generation=? AND helper_id IS NOT NULL ORDER BY id DESC LIMIT 1`, run.id, run.generation);
  const helperId = run.integration_worker_id ?? helperNode?.helper_id;
  const helperNumber = run.integration_worker_id !== null ? run.integration_worker_number : helperNode?.helper_worker_number;
  const helper = helperId ? project.store.get("SELECT id,worker_number,status FROM tasks WHERE id=? AND task_kind='integration' AND parent_id=?", helperId, run.parent_id) : null;
  return { id: run.id, revision: convergenceRunRevision(project.store, run), parent_id: run.parent_id,
    target_branch: run.target_branch, state: CONVERGENCE_STATES.includes(run.state) ? run.state : 'blocked',
    baseline: sha(run.baseline), commit: sha(run.candidate_commit), member_count: memberCount,
    members: rows.map(row => ({ id: row.task_id, worker_number: number(row.worker_number) ?? number(row.live_worker_number),
      title: label(row.display_title) || label(row.auto_title) || label(row.goal?.split('\n')[0]) || label(row.name) || label(row.title) || `Worker #${row.task_id}`,
      delivery_id: row.delivery_id, source_commit: sha(row.source_commit) })),
    members_truncated: memberCount > rows.length, validation,
    integration_worker: helperId ? { id: helperId, worker_number: number(helperNumber) ?? number(helper?.worker_number), status: helper?.status ?? 'deleted' } : null,
    error: safeConvergenceError(run.error), created_at: date(run.created_at), updated_at: date(run.updated_at) };
}

export default {
  // Retired birth hooks intentionally do nothing. Keep callers compatible without
  // installing policies, writing initialization markers, or touching historical authorization.
  initializeMainConvergence() {},
  initializeNewWorkerConvergence() {},

  branchConvergenceDefaults() { return this.store.transaction(() => defaultsView(this)); },

  async setBranchConvergenceDefaults() {
    check(false, RETIRED);
  },

  /** Same safe branch read model for Worker automation, without Git writes or generic Hook actions. */
  taskConvergenceView(task) {
    if (!task.branch || !['main','owner','order','child'].includes(task.task_kind)) return null;
    return this.store.transaction(() => {
      const active = owners(this, task.branch);
      return active.length === 1 && active[0].id === task.id ? branchView(this, task.branch, task) : null;
    });
  },

  /** Synchronous internal policy lookup; a new owner never inherits an old owner's authorization. */
  convergencePolicy(branch) {
    branchName(branch); const saved = stored(this, branch), active = owners(this, branch);
    if (!saved || active.length !== 1 || saved.owner_id !== active[0].id) return defaults();
    const mounted = saved.mounted ?? true; // Every legacy saved policy was an actual branch configuration.
    return { version: 1, mounted, enabled: mounted && saved.enabled, validation: reference(saved.validation), generation: saved.generation };
  },

  async branchConvergence(branch) {
    await target(this, branch);
    return this.store.transaction(() => branchView(this, branch, owner(this, branch)));
  },

  async branchConvergenceList() {
    const refs = await localRefs(this);
    return this.store.transaction(() => {
      const tasks = this.store.all(`SELECT id,worker_number,task_kind,branch,status FROM tasks
        WHERE branch IS NOT NULL AND ${OWNERS} ORDER BY CASE task_kind WHEN 'main' THEN 0 ELSE 1 END,branch COLLATE BINARY,id`);
      const frequencies = new Map(); for (const task of tasks) frequencies.set(task.branch, (frequencies.get(task.branch) ?? 0) + 1);
      const eligible = tasks.filter(task => refs.has(task.branch) && frequencies.get(task.branch) === 1
        && !['archived','deleted'].includes(this.store.branch(task.branch)?.status));
      const page = eligible.slice(0, 500), activity = new Map(page.map(task => [task.branch, Object.fromEntries(CONVERGENCE_COUNT_STATES.map(state => [state, 0]))]));
      if (page.length) for (const row of this.store.all(`SELECT target_branch,state,count(*) AS n FROM delivery_runs
        WHERE target_branch IN (${page.map(() => '?').join(',')}) AND state IN (${CONVERGENCE_COUNT_STATES.map(() => '?').join(',')})
        GROUP BY target_branch,state`, ...page.map(task => task.branch), ...CONVERGENCE_COUNT_STATES)) {
        const out = activity.get(row.target_branch); if (Object.hasOwn(out, row.state)) out[row.state] = row.n;
      }
      return { version: 1, items: page.map(task => branchView(this, task.branch, task, activity.get(task.branch))), defaults: defaultsView(this), count: eligible.length, truncated: eligible.length > page.length };
    });
  },

  async setBranchConvergence() {
    check(false, RETIRED);
  },

  async branchConvergenceRuns(branch, before = null, limit = 20) {
    check(before === null || positive(before), 'convergence cursor must be a positive integer');
    check(positive(limit) && limit <= 50, 'convergence run limit must be 1..50');
    await target(this, branch);
    return this.store.transaction(() => {
      owner(this, branch);
      const rows = this.store.all(`SELECT * FROM delivery_runs WHERE target_branch=?${before === null ? '' : ' AND id<?'} ORDER BY id DESC LIMIT ?`,
        branch, ...(before === null ? [] : [before]), limit + 1);
      const page = rows.slice(0, limit), hasMore = rows.length > page.length;
      return { version: 1, branch, items: page.map(run => convergenceRunView(this, run)), next_before: hasMore ? page.at(-1).id : null, has_more: hasMore };
    });
  },

  convergenceRunView(runOrId) {
    return this.store.transaction(() => convergenceRunView(this, typeof runOrId === 'number' ? this.store.deliveryRun(runOrId) : runOrId));
  },
};
