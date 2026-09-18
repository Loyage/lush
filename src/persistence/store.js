import { Database } from 'bun:sqlite';
import { check, id, bounded } from '../core/types.js';

export class Store {
  constructor(file, project) {
    this.db = new Database(file, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- flow: 'develop'=要改代码, 'explain'=只了解；NULL 表示 planner 还没判定，按 develop 处理。
      CREATE TABLE IF NOT EXISTS inputs (
        id INTEGER PRIMARY KEY, content TEXT NOT NULL, task_id INTEGER, flow TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      -- 用户输入先落成草稿；input_id IS NULL 表示还没提交。提交时整批拼成一条 inputs。
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY, content TEXT NOT NULL, input_id INTEGER REFERENCES inputs(id),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS drafts_open ON drafts(input_id);
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES tasks(id), input_id INTEGER REFERENCES inputs(id),
        role TEXT NOT NULL, goal TEXT NOT NULL, name TEXT, status TEXT NOT NULL DEFAULT 'queued',
        result TEXT, error TEXT, calls INTEGER NOT NULL DEFAULT 0,
        agent_wakes INTEGER NOT NULL DEFAULT 0, agent_token_hash TEXT, agent_last_seen_at TEXT,
        workspace TEXT, branch TEXT, base_commit TEXT, head_commit TEXT,
        integration TEXT NOT NULL DEFAULT 'none', target_branch TEXT, integration_error TEXT,
        -- verifier task: verifies_task_id 指向被检验的 worker；baseline_* 是目标分支的对照检出。
        verifies_task_id INTEGER REFERENCES tasks(id), baseline_workspace TEXT, baseline_commit TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
      -- 依赖边只在 spawn 时写入，之后不可变。kind: code=从上游分支继续, order=只等它结束。
      CREATE TABLE IF NOT EXISTS task_deps (
        task_id INTEGER NOT NULL REFERENCES tasks(id), depends_on INTEGER NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL CHECK (kind IN ('code','order')), PRIMARY KEY (task_id, depends_on));
      CREATE INDEX IF NOT EXISTS task_deps_reverse ON task_deps(depends_on);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), sender_id INTEGER REFERENCES tasks(id),
        body TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE IF NOT EXISTS notices (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), title TEXT NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', answer TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, task_id INTEGER REFERENCES tasks(id), type TEXT NOT NULL, data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, consumed);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);`);
    // Agent identity columns arrived after the first release; an existing project.db predates them.
    // The index over agent_token_hash must wait for the columns it references.
    const columns = new Set(this.all('PRAGMA table_info(tasks)').map(row => row.name));
    for (const [name, type] of [['name', 'TEXT'], ['agent_wakes', 'INTEGER NOT NULL DEFAULT 0'], ['agent_token_hash', 'TEXT'], ['agent_last_seen_at', 'TEXT'],
      ['verifies_task_id', 'INTEGER REFERENCES tasks(id)'], ['baseline_workspace', 'TEXT'], ['baseline_commit', 'TEXT']]) {
      if (!columns.has(name)) this.run(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    }
    this.run('CREATE INDEX IF NOT EXISTS tasks_agent_token ON tasks(agent_token_hash)');
    // 两类输入的判定列晚于首个 release；既有库需要补列。
    const inputColumns = new Set(this.all('PRAGMA table_info(inputs)').map(row => row.name));
    if (!inputColumns.has('flow')) this.run('ALTER TABLE inputs ADD COLUMN flow TEXT');
    const binding = this.get('SELECT value FROM meta WHERE key=?', 'project');
    if (binding && binding.value !== project) { this.close(); throw new Error('database belongs to another project'); }
    this.run('INSERT OR IGNORE INTO meta VALUES (?,?)', 'project', project);
  }
  run(sql, ...params) { return this.db.query(sql).run(...params); }
  get(sql, ...params) { return this.db.query(sql).get(...params); }
  all(sql, ...params) { return this.db.query(sql).all(...params); }
  transaction(fn) { return this.db.transaction(fn)(); }
  close() { this.db.close(); }
  /** Highest task id ever handed out, kept in meta so a cleared project never reuses an id. */
  taskIdHigh() { return Number(this.get("SELECT value FROM meta WHERE key='task_id_high'")?.value ?? 0); }
  setTaskIdHigh(value) {
    this.run("INSERT INTO meta(key,value) VALUES ('task_id_high',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(value));
  }
  /** Ids are never recycled: worktree directories, branches and pi sessions outlive the rows that named them. */
  nextTaskId() {
    const next = Math.max(this.taskIdHigh(), this.get('SELECT COALESCE(MAX(id),0) AS value FROM tasks').value) + 1;
    this.setTaskIdHigh(next);
    return next;
  }
  task(taskId) {
    const task = this.get('SELECT * FROM tasks WHERE id=?', id(taskId));
    check(task, `task ${taskId} not found`);
    return task;
  }
  tasks() { return this.all('SELECT * FROM tasks ORDER BY id'); }
  summaries() {
    return this.all(`SELECT id,parent_id,input_id,role,substr(goal,1,200) AS goal,status,integration,updated_at,
      agent_wakes,agent_last_seen_at,verifies_task_id FROM tasks ORDER BY id`);
  }
  /** 一个 worker 收到过的检验记录，最新的在前。 */
  verifications(taskId) {
    return this.all(`SELECT id,status,result,error,baseline_commit,created_at,updated_at
      FROM tasks WHERE verifies_task_id=? ORDER BY id DESC`, taskId);
  }
  /** 同一任务同时只允许一次检验：还在跑的会占住这个名额。 */
  activeVerification(taskId) {
    return this.get(`SELECT id,status FROM tasks WHERE verifies_task_id=? AND status NOT IN ('completed','failed','cancelled') ORDER BY id DESC`, taskId);
  }
  /** Tasks the scheduler may still touch: a clear has to wait for all of them. */
  activeTasks() {
    return this.all("SELECT id,status FROM tasks WHERE status NOT IN ('completed','failed','cancelled') ORDER BY id");
  }
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
      // Children of tasks/inputs go first; foreign keys are on, so the order is not decorative.
      for (const table of ['messages','notices','task_deps','events','tasks','drafts','inputs']) {
        counts[table] = this.get(`SELECT count(*) AS value FROM ${table}`).value;
        this.run(`DELETE FROM ${table}`);
      }
      return counts;
    });
  }
  /** Credentials exist only while their invocation runs; Project#actor is the only reader. */
  armAgent(taskId, hash) { this.run('UPDATE tasks SET agent_token_hash=? WHERE id=?', hash, taskId); }
  /** Last authenticated agent contact; deliberately does not touch updated_at, so it never reorders the tree. */
  touchAgent(taskId) { this.run("UPDATE tasks SET agent_last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", taskId); }
  agentByToken(hash) { return this.get('SELECT * FROM tasks WHERE agent_token_hash=?', hash); }
  children(taskId) { return this.all('SELECT * FROM tasks WHERE parent_id=? ORDER BY id', taskId); }
  addDraft(content) {
    const row = this.run('INSERT INTO drafts(content) VALUES (?)', content);
    return this.get('SELECT * FROM drafts WHERE id=?', Number(row.lastInsertRowid));
  }
  draft(draftId) {
    const draft = this.get('SELECT * FROM drafts WHERE id=?', id(draftId));
    check(draft, `draft ${draftId} not found`);
    return draft;
  }
  /** Buffered drafts in input order; submitted ones keep their input_id as the audit link. */
  openDrafts() { return this.all('SELECT * FROM drafts WHERE input_id IS NULL ORDER BY id'); }
  draftCount() { return this.get('SELECT count(*) AS n FROM drafts WHERE input_id IS NULL').n; }
  addDep(taskId, dependsOn, kind) {
    this.run('INSERT INTO task_deps(task_id,depends_on,kind) VALUES (?,?,?)', taskId, dependsOn, kind);
  }
  deps(taskId) { return this.all('SELECT depends_on, kind FROM task_deps WHERE task_id=? ORDER BY depends_on', taskId); }
  dependents(taskId) { return this.all('SELECT task_id, kind FROM task_deps WHERE depends_on=? ORDER BY task_id', taskId); }
  depsDetail(taskId) {
    return this.all(`SELECT d.depends_on AS id, d.kind, t.role, t.status, t.integration, substr(t.goal,1,200) AS goal
      FROM task_deps d JOIN tasks t ON t.id=d.depends_on WHERE d.task_id=? ORDER BY d.depends_on`, taskId);
  }
  dependentsDetail(taskId) {
    return this.all(`SELECT d.task_id AS id, d.kind, t.role, t.status, substr(t.goal,1,200) AS goal
      FROM task_deps d JOIN tasks t ON t.id=d.task_id WHERE d.depends_on=? ORDER BY d.task_id`, taskId);
  }
  /** 时间轴原料：最近 limit 个任务，按 id 升序（画图从左到右）。 */
  timelineTasks(limit) {
    return this.all(`SELECT id,parent_id,input_id,role,name,status,integration,created_at,updated_at
      FROM (SELECT * FROM tasks ORDER BY id DESC LIMIT ?) ORDER BY id`, limit);
  }
  /** 这些任务的依赖边：时间轴与合并阶梯都要画"在等谁"。 */
  edgesOf(taskIds) {
    if (!taskIds.length) return [];
    const holes = taskIds.map(() => '?').join(',');
    return this.all(`SELECT task_id, depends_on, kind FROM task_deps WHERE task_id IN (${holes}) ORDER BY task_id, depends_on`, ...taskIds);
  }
  /** 这些任务的生命周期事件：invocation.started→invocation.completed 就是"真的在跑"的区间。 */
  lifecycleEvents(taskIds) {
    if (!taskIds.length) return [];
    const holes = taskIds.map(() => '?').join(',');
    return this.all(`SELECT task_id, type, created_at FROM events
      WHERE task_id IN (${holes}) AND type IN ('invocation.started','invocation.completed','completed','failed','cancelled')
      ORDER BY task_id, id`, ...taskIds);
  }
  /** 这些任务的子任务存活区间：父任务停着不动时，可能是在等子任务，而不是在等槽。 */
  childSpans(taskIds) {
    if (!taskIds.length) return [];
    const holes = taskIds.map(() => '?').join(',');
    return this.all(`SELECT parent_id, id, created_at,
        (SELECT MAX(e.created_at) FROM events e WHERE e.task_id=tasks.id AND e.type IN ('completed','failed','cancelled')) AS terminal_at
      FROM tasks WHERE parent_id IN (${holes}) ORDER BY id`, ...taskIds);
  }
  /** One query for the whole read model: task id -> edges carrying the upstream status. */
  depMap() {
    const map = new Map();
    for (const row of this.all(`SELECT d.task_id, d.depends_on AS id, d.kind, t.status
      FROM task_deps d JOIN tasks t ON t.id=d.depends_on ORDER BY d.task_id, d.depends_on`)) {
      if (!map.has(row.task_id)) map.set(row.task_id, []);
      map.get(row.task_id).push({ id: row.id, kind: row.kind, status: row.status });
    }
    return map;
  }
  /** Does `from` depend transitively on `target`? Walks depends_on edges. */
  reaches(from, target) {
    const seen = new Set(); const queue = [from];
    while (queue.length) {
      const current = queue.shift();
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const edge of this.deps(current)) queue.push(edge.depends_on);
    }
    return false;
  }
  /** Bump the visible timestamp without touching status; used when a verification starts or settles. */
  touch(taskId) { this.run("UPDATE tasks SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", taskId); }
  update(taskId, patch) {
    const allowed = ['status','result','error','calls','agent_wakes','workspace','branch','base_commit','head_commit','integration','target_branch','integration_error','baseline_workspace','baseline_commit'];
    check(Object.keys(patch).every(key => allowed.includes(key)), 'invalid task patch');
    this.run(`UPDATE tasks SET ${Object.keys(patch).map(key => `${key}=?`).join(',')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`, ...Object.values(patch), taskId);
    return this.task(taskId);
  }
  /** name is the task's own short slug; it is written once at spawn and never edited, so a worktree keeps its name. */
  create({ parent_id = null, input_id, role, goal, name = null, verifies_task_id = null }) {
    const taskId = this.nextTaskId();
    this.run('INSERT INTO tasks(id,parent_id,input_id,role,goal,name,verifies_task_id) VALUES (?,?,?,?,?,?,?)',
      taskId, parent_id, input_id, role, goal, name, verifies_task_id);
    const task = this.task(taskId);
    this.event(task.id, 'created', { parent_id, role, goal, name, verifies_task_id });
    return task;
  }
  event(taskId, type, data) { this.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', taskId, type, JSON.stringify(data)); }
  message(taskId, body, sender = null) { this.run('INSERT INTO messages(task_id,sender_id,body) VALUES (?,?,?)', taskId, sender, body); }
  unread(taskId) { return this.all('SELECT * FROM messages WHERE task_id=? AND consumed=0 ORDER BY id', taskId); }
  history(taskId, after = 0) {
    return bounded(this.all('SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id LIMIT 100', taskId, after).map(row => ({ ...row, data: JSON.parse(row.data) })), 900000);
  }
}
