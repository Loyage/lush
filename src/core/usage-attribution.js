const LIMIT = 100;
const fields = ['input', 'output', 'cache_read', 'cache_write', 'tokens', 'cost', 'unknown_cost', 'unknown_tokens'];

/** Read-only attribution; never infer missing roles from AP names or model choice. */
export function usageAttribution(metadata = {}) {
  const aps = new Map((metadata.aps || []).map(ap => [ap.id, ap]));
  const runs = new Map();
  for (const run of metadata.runs || []) {
    const list = runs.get(run.ap_id) || [];
    list.push({ ...run, start: Date.parse(run.started_at), end: run.ended_at ? Date.parse(run.ended_at) : Infinity });
    runs.set(run.ap_id, list);
  }
  const roles = new Map(), byAP = new Map(), invocations = new Map();
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
    add(apId, row) {
      const ap = aps.get(apId);
      const candidates = (runs.get(apId) || []).filter(run => row.run_id
        ? run.id === row.run_id : row.at !== null && row.at >= run.start && row.at <= run.end);
      const run = candidates.length === 1 ? candidates[0] : null;
      const role = row.role || run?.role || ap?.role || 'unknown';
      const runId = row.run_id || run?.id || null;
      if (role === 'unknown') unknownRole++;
      if (runId === null) unknownRun++;
      add(roles, role, { role }, row);
      add(byAP, apId, { ap_id: apId, role, status: ap?.status ?? null, integration: ap?.integration ?? null, goal: ap?.goal?.slice(0, 160) ?? null }, row);
      add(invocations, `${apId}:${runId}`, { ap_id: apId, run_id: runId, role, status: run?.status ?? null }, row);
    },
    result() {
      const sort = map => [...map.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
      return { roles: sort(roles), aps: sort(byAP).slice(0, LIMIT), invocations: sort(invocations).slice(0, LIMIT),
        attribution: { limit: LIMIT, ap_groups: byAP.size, invocation_groups: invocations.size,
          aps_truncated: byAP.size > LIMIT, invocations_truncated: invocations.size > LIMIT,
          unknown_role_requests: unknownRole, unknown_run_requests: unknownRun } };
    },
  };
}
