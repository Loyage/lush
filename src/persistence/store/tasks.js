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
  /**
   * 集合外的行还用外键指着这些任务吗（verifier / resolver / 验收候选）。删除前必须先问一遍：
   * tasks.parent_id 与 task_specs.planner_task_id 是「跟着一起删」的关系，这三个方向不是——
   * 引用方自己会活下来，所以外键会拦住删除。返回人话，直接进错误信息。
   */
  referringTasks(taskIds) {
    const ids = taskIds.map(value => id(value));
    const marks = ids.map(() => '?').join(',');
    return [
      ...this.all(`SELECT id FROM tasks WHERE verifies_task_id IN (${marks})`, ...ids).map(row => `verifier #${row.id}`),
      ...this.all(`SELECT id FROM tasks WHERE resolves_task_id IN (${marks})`, ...ids).map(row => `resolver #${row.id}`),
      ...this.all(`SELECT id FROM review_candidates WHERE report_task_id IN (${marks})`, ...ids).map(row => `candidate #${row.id}`),
    ];
  },
  /**
   * 定向删除一组任务行：删掉它们自己与任务级的子行，集合外一行都不动。
   * 这是除 purge 之外唯一一条删 tasks 的路径，调用方（Project#deleteTask）必须已经证明：全部终态、
   * 没有 invocation 还在收尾、磁盘状态已经按 cleanup 的安全门回收完——这里只再断言一次外键引用。
   * 各表的收尾口径：子行（artifacts / agent_runs / messages / notices / events / task_deps）跟着删，
   * 其中 messages 连「被删任务发给别人的」也删（那条消息讲的就是这条任务）；task_specs 只有
   * planner_task_id 有外键，所以只删这批 planner 写的条目。branches.task_id / inputs.task_id /
   * task_specs.task_id / batch_id 刻意没有外键，保持原样：id 不复用，历史指针不会指错，
   * 读模型按「已清空」处理（见 project/branches.js 与 project/inputs.js 的派生口径）。
   * id 与 purge 一样先钉住 meta.task_id_high：删过的 id 永不复用。
   */
  deleteTasks(taskIds) {
    const ids = [...new Set(taskIds.map(value => id(value)))];
    check(ids.length > 0, 'deleteTasks needs at least one task id');
    const marks = ids.map(() => '?').join(',');
    return this.transaction(() => {
      const referrers = this.referringTasks(ids);
      check(referrers.length === 0, `still referenced by ${referrers.join(', ')}`);
      this.setTaskIdHigh(Math.max(this.taskIdHigh(), ...ids));
      // 顺序照 purge：先删子行，再删 tasks。args 按 where 里的占位符个数传，两条 IN 的用同一份 id 写两遍。
      const drop = (table, where, args = ids) => {
        const rows = this.get(`SELECT count(*) AS value FROM ${table} WHERE ${where}`, ...args).value;
        this.run(`DELETE FROM ${table} WHERE ${where}`, ...args);
        return rows;
      };
      const twice = [...ids, ...ids];
      const counts = { tasks: ids.length };
      counts.artifacts = drop('artifacts', `task_id IN (${marks})`);
      counts.agent_runs = drop('agent_runs', `task_id IN (${marks})`);
      counts.messages = drop('messages', `task_id IN (${marks}) OR sender_id IN (${marks})`, twice);
      counts.notices = drop('notices', `task_id IN (${marks})`);
      counts.events = drop('events', `task_id IN (${marks})`);
      counts.task_deps = drop('task_deps', `task_id IN (${marks}) OR depends_on IN (${marks})`, twice);
      counts.task_specs = drop('task_specs', `planner_task_id IN (${marks})`);
      this.run(`DELETE FROM tasks WHERE id IN (${marks})`, ...ids);
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
