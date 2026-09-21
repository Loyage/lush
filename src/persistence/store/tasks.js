import { check, id, layerOf } from '../../core/types.js';

/** tasks 表的读写与生命周期字段。 */
export const tasks = {
  task(taskId) {
    const task = this.get('SELECT * FROM tasks WHERE id=?', id(taskId));
    check(task, `task ${taskId} not found`);
    return task;
  },
  tasks() { return this.all('SELECT * FROM tasks ORDER BY id'); },
  /** layer 省略时给全部任务（内部用）；'work' 是任务树/任务链的读模型，'intent' 是 planner + scheduler。 */
  summaries(layer = null) {
    return this.all(`SELECT id,parent_id,input_id,role,substr(goal,1,200) AS goal,status,integration,layer,updated_at,
      agent_wakes,agent_last_seen_at,verifies_task_id,resolves_task_id,review_candidate_id FROM tasks${layer ? ' WHERE layer=?' : ''} ORDER BY id`,
      ...(layer ? [layer] : []));
  },
  /** Tasks the scheduler may still touch: a clear has to wait for all of them. */
  activeTasks() {
    return this.all("SELECT id,status FROM tasks WHERE status NOT IN ('completed','failed','cancelled') ORDER BY id");
  },
  /**
   * Project-level reset: drops every task-scoped row plus the input audit trail.
   * Only Project#clear calls this, and only after proving no task is active, no
   * invocation is still unwinding, and every ended task has been through the
   * worktree/branch reclamation gates. Whatever those gates kept stays on disk,
   * which is why nextTaskId() is pinned first: the retained names must stay unambiguous.
   */
  purge() {
    const counts = {};
    return this.transaction(() => {
      this.setTaskIdHigh(Math.max(this.taskIdHigh(), this.get('SELECT COALESCE(MAX(id),0) AS value FROM tasks').value));
      // 锚点的分支名与目录名带着 input id，所以输入 id 也钉住：清空之后的输入继续往大走。
      this.setInputIdHigh(Math.max(this.inputIdHigh(), this.get('SELECT COALESCE(MAX(id),0) AS value FROM inputs').value));
      // Children of tasks/inputs go first; foreign keys are on, so the order is not decorative.
      for (const table of ['artifacts','agent_runs','review_candidates','task_specs','messages','notices','task_deps','events','tasks','draft_references','input_references','drafts','inputs']) {
        counts[table] = this.get(`SELECT count(*) AS value FROM ${table}`).value;
        this.run(`DELETE FROM ${table}`);
      }
      return counts;
    });
  },
  /** Credentials exist only while their invocation runs; Project#actor is the only reader. */
  armAgent(taskId, hash) { this.run('UPDATE tasks SET agent_token_hash=? WHERE id=?', hash, taskId); },
  /** Last authenticated agent contact; deliberately does not touch updated_at, so it never reorders the tree. */
  touchAgent(taskId) { this.run("UPDATE tasks SET agent_last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", taskId); },
  agentByToken(hash) { return this.get('SELECT * FROM tasks WHERE agent_token_hash=?', hash); },
  children(taskId) { return this.all('SELECT * FROM tasks WHERE parent_id=? ORDER BY id', taskId); },
  /** Bump the visible timestamp without touching status; used when a verification starts or settles. */
  touch(taskId) { this.run("UPDATE tasks SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", taskId); },
  update(taskId, patch) {
    const allowed = ['status','result','error','calls','agent_wakes','workspace','branch','base_commit','head_commit','integration','target_branch','integration_error','baseline_workspace','baseline_commit','plan_gate','review_candidate_id'];
    check(Object.keys(patch).every(key => allowed.includes(key)), 'invalid task patch');
    this.run(`UPDATE tasks SET ${Object.keys(patch).map(key => `${key}=?`).join(',')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`, ...Object.values(patch), taskId);
    return this.task(taskId);
  },
  /** name is the task's own short slug; it is written once at spawn and never edited, so a worktree keeps its name. */
  create({ parent_id = null, input_id, role, goal, name = null, verifies_task_id = null, resolves_task_id = null, review_candidate_id = null }) {
    const taskId = this.nextTaskId();
    const layer = layerOf(role);
    this.run('INSERT INTO tasks(id,parent_id,input_id,role,goal,name,verifies_task_id,resolves_task_id,review_candidate_id,layer) VALUES (?,?,?,?,?,?,?,?,?,?)',
      taskId, parent_id, input_id, role, goal, name, verifies_task_id, resolves_task_id, review_candidate_id, layer);
    const task = this.task(taskId);
    this.event(task.id, 'created', { parent_id, role, goal, name, verifies_task_id, resolves_task_id, review_candidate_id, layer });
    return task;
  },
};
