import { check } from '../types.js';

/** Git owns chronology; only exact successful landing events own attribution. */
export default {
  async branchHistory(options = {}) {
    const page = await this.workspaces.mainHistory(options);
    if (!page.commits.length) return page;
    const byCommit = new Map(page.commits.map(row => [row.commit, new Map()]));
    const commits = [...byCommit.keys()];
    const safeData = "CASE WHEN json_valid(e.data) THEN e.data ELSE '{}' END";
    const rows = this.store.all(`SELECT e.type, json_extract(${safeData},'$.commit') AS landed_commit,
        json_type(${safeData},'$.parent_id') AS event_parent_type,
        json_type(${safeData},'$.parent') AS event_target_type,
        json_extract(${safeData},'$.parent') AS event_parent,
        json_extract(${safeData},'$.legacy') AS event_legacy,
        t.id, t.worker_number, substr(t.goal,1,16385) AS goal, t.task_kind, t.target_branch,
        i.id AS input_id, substr(i.content,1,131073) AS input_content, p.branch AS parent_branch
      FROM events e JOIN tasks t ON t.id=e.task_id
      LEFT JOIN inputs i ON i.id=t.input_id
      LEFT JOIN tasks p ON p.id=json_extract(${safeData},'$.parent_id')
      WHERE e.type IN ('task.merge_integrated','merged')
        AND json_extract(${safeData},'$.commit') IN (${commits.map(() => '?').join(',')})
      ORDER BY e.id DESC LIMIT 1001`, ...commits);
    check(rows.length <= 1000, 'version history associations exceed safe limit; request a smaller page');
    for (const row of rows) {
      const isMain = row.type === 'task.merge_integrated'
        ? row.event_parent_type === 'integer' && row.parent_branch === 'main'
        : row.event_target_type !== null ? row.event_parent === 'main'
          : row.event_legacy === 1 && row.task_kind === null && row.target_branch === 'main';
      if (!isMain) continue;
      check(row.goal.length <= 16384 && (row.input_content?.length ?? 0) <= 131072,
        'version history Worker or order text exceeds safe size');
      const tasks = byCommit.get(row.landed_commit);
      if (!tasks || tasks.has(row.id)) continue;
      tasks.set(row.id, { id: row.id, worker_number: row.worker_number, goal: row.goal, task_kind: row.task_kind ?? 'legacy',
        input: row.input_id === null ? null : { id: row.input_id, content: row.input_content }, evidence: row.type });
    }
    page.commits = page.commits.map(row => {
      const tasks = [...byCommit.get(row.commit).values()];
      return { ...row, association: tasks.length ? 'verified' : 'unassociated', tasks };
    });
    // Fit comfortably within the RPC 1 MiB frame; never silently crop original orders.
    check(Buffer.byteLength(JSON.stringify(page)) <= 512 * 1024, 'version history response exceeds safe size; request a smaller page');
    return page;
  },
};
