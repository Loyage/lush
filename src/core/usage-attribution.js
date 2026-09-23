const LIMIT = 100;
const fields = ['input', 'output', 'cache_read', 'cache_write', 'tokens', 'cost', 'unknown_cost', 'unknown_tokens'];

/** Read-only attribution; never infer missing roles from task names or model choice. */
export function usageAttribution(metadata = {}) {
  const tasks = new Map((metadata.tasks || []).map(task => [task.id, task]));
  const runs = new Map();
  for (const run of metadata.runs || []) {
    const list = runs.get(run.task_id) || [];
    list.push({ ...run, start: Date.parse(run.started_at), end: run.ended_at ? Date.parse(run.ended_at) : Infinity });
    runs.set(run.task_id, list);
  }
  const roles = new Map(), byTask = new Map(), invocations = new Map();
  let unknownRole = 0, unknownRun = 0;
  const add = (map, key, identity, row) => {
    let group = map.get(key);
    if (!group) {
      group = { ...identity, requests: 0, ...Object.fromEntries(fields.map(field => [field, 0])) };
      map.set(key, group);
    }
    group.requests++;
    for (const field of fields) group[field] += row[field];
  };
  return {
    add(taskId, row) {
      const task = tasks.get(taskId);
      const candidates = (runs.get(taskId) || []).filter(run => row.run_id
        ? run.id === row.run_id : row.at !== null && row.at >= run.start && row.at <= run.end);
      const run = candidates.length === 1 ? candidates[0] : null;
      const role = row.role || run?.role || task?.role || 'unknown';
      const runId = row.run_id || run?.id || null;
      if (role === 'unknown') unknownRole++;
      if (runId === null) unknownRun++;
      add(roles, role, { role }, row);
      add(byTask, taskId, { task_id: taskId, role, status: task?.status ?? null, integration: task?.integration ?? null, goal: task?.goal?.slice(0, 160) ?? null }, row);
      add(invocations, `${taskId}:${runId}`, { task_id: taskId, run_id: runId, role, status: run?.status ?? null }, row);
    },
    result() {
      const sort = map => [...map.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
      return { roles: sort(roles), tasks: sort(byTask).slice(0, LIMIT), invocations: sort(invocations).slice(0, LIMIT),
        attribution: { limit: LIMIT, task_groups: byTask.size, invocation_groups: invocations.size,
          tasks_truncated: byTask.size > LIMIT, invocations_truncated: invocations.size > LIMIT,
          unknown_role_requests: unknownRole, unknown_run_requests: unknownRun } };
    },
  };
}
