/** 全部 DDL 与项目绑定校验：schema 与列名是公共面，改动必须同步 docs/engineering/modules.md。 */
export const SCHEMA = `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- flow: 'develop'=要改代码, 'explain'=只了解；NULL 表示 planner 还没判定，按 develop 处理。
      -- anchor_* 为兼容旧库保留名称：它们表示可推进的输入聚合分支 / 初始 commit / worktree / 用户指定父分支。
      -- planner 在该 worktree 解析；普通 worker 以 anchor_commit 为冻结基线，并以 anchor_branch 为直接父分支。
      CREATE TABLE IF NOT EXISTS inputs (
        id INTEGER PRIMARY KEY, content TEXT NOT NULL, task_id INTEGER, flow TEXT,
        anchor_branch TEXT, anchor_commit TEXT, anchor_workspace TEXT, anchor_target_branch TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      -- 用户输入先落成草稿；input_id IS NULL 表示还没提交。提交时整批拼成一条 inputs。
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY, content TEXT NOT NULL, input_id INTEGER REFERENCES inputs(id),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS drafts_open ON drafts(input_id);
      -- 上下文引用是 Input / Draft 的附属元数据，不是独立业务实体。草稿提交时复制到 input_references，
      -- segment 保留批量提交中“哪一段用户输入引用了什么”的关系；payload 是经过 Project 校验的 versioned JSON。
      CREATE TABLE IF NOT EXISTS draft_references (
        draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (draft_id, ordinal));
      CREATE TABLE IF NOT EXISTS input_references (
        input_id INTEGER NOT NULL REFERENCES inputs(id) ON DELETE CASCADE,
        segment INTEGER NOT NULL, ordinal INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (input_id, segment, ordinal));
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES tasks(id), input_id INTEGER REFERENCES inputs(id),
        role TEXT NOT NULL, goal TEXT NOT NULL, name TEXT, status TEXT NOT NULL DEFAULT 'queued',
        result TEXT, error TEXT, calls INTEGER NOT NULL DEFAULT 0,
        agent_wakes INTEGER NOT NULL DEFAULT 0, agent_token_hash TEXT, agent_last_seen_at TEXT,
        workspace TEXT, branch TEXT, base_commit TEXT, head_commit TEXT,
        integration TEXT NOT NULL DEFAULT 'none', target_branch TEXT, integration_error TEXT,
        -- layer: 'intent'（planner 拆解 / scheduler 编排）不进任务树；'work' 才是用户要的开发任务链。
        layer TEXT NOT NULL DEFAULT 'work',
        -- plan_gate: planner 这一轮拆解的审批闸门：NULL=没申请批准（直接编排）/ proposed=等你批准 / approved / rejected。
        plan_gate TEXT,
        -- verifier task: verifies_task_id 指向被检验的 worker；baseline_* 是目标分支的对照检出。
        verifies_task_id INTEGER REFERENCES tasks(id), baseline_workspace TEXT, baseline_commit TEXT,
        -- merger task: resolves_task_id 指向合并冲突的那个 worker。冲突处理不在原任务的子树里
        -- （终态任务不允许有活动后代），所以和 verifier 一样用关联边而不是父子边。
        resolves_task_id INTEGER REFERENCES tasks(id),
        -- candidate verifier: review_candidate_id pins this run to the exact integration commit the user reviews.
        review_candidate_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
      -- 依赖边只在 spawn 时写入，之后不可变。kind: code=从上游分支继续, order=只等它结束。
      CREATE TABLE IF NOT EXISTS task_deps (
        task_id INTEGER NOT NULL REFERENCES tasks(id), depends_on INTEGER NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL CHECK (kind IN ('code','order')), PRIMARY KEY (task_id, depends_on));
      CREATE INDEX IF NOT EXISTS task_deps_reverse ON task_deps(depends_on);
      -- 拆解队列：planner 只往这里写条目，一个 planner 一轮写完（它结束）后，runtime 把它写的全部 pending
      -- 条目收成一个 batch 交给一个 scheduler；批次之间串行，所以批内没有依赖边的条目会同时开工。
      CREATE TABLE IF NOT EXISTS task_specs (
        id INTEGER PRIMARY KEY, input_id INTEGER REFERENCES inputs(id),
        planner_task_id INTEGER NOT NULL REFERENCES tasks(id), batch_id INTEGER,
        seq INTEGER NOT NULL, goal TEXT NOT NULL, role TEXT, name TEXT,
        deps TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending',
        task_id INTEGER, note TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS task_specs_status ON task_specs(status);
      CREATE INDEX IF NOT EXISTS task_specs_batch ON task_specs(batch_id);
      CREATE INDEX IF NOT EXISTS task_specs_planner ON task_specs(planner_task_id);
      -- Branch genealogy: 分支创建时的「从哪条分支拉出来」记录。不是 commit graph、不是 task tree，
      -- 也不是 git ref 的镜像：只回答创建关系。只在分支被创建那一刻写入，之后不可变（除 status）。
      -- task_id 故意不加外键：clear 会清空 tasks，但谱系是历史事实，必须比 task 行活得久。
      -- parent_relation: 'recorded'=runtime 创建时记下 / 'inferred'=import 的启发式推断 / 'unknown'=没有 parent 记录。
      CREATE TABLE IF NOT EXISTS branches (
        branch TEXT PRIMARY KEY, parent TEXT, parent_relation TEXT,
        created_from_commit TEXT, task_id INTEGER, worktree TEXT,
        status TEXT NOT NULL DEFAULT 'active', deleted_at TEXT,
        -- 一句话摘要：分支图上的标题优先用它（人写的简述），没有时才回落输入 / 目标的原文首行。
        summary TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS branches_parent ON branches(parent);
      CREATE INDEX IF NOT EXISTS branches_task ON branches(task_id);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), sender_id INTEGER REFERENCES tasks(id),
        body TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE IF NOT EXISTS notices (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), title TEXT NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', answer TEXT, kind TEXT NOT NULL DEFAULT 'question',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, task_id INTEGER REFERENCES tasks(id), type TEXT NOT NULL, data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, consumed);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
      CREATE INDEX IF NOT EXISTS tasks_agent_token ON tasks(agent_token_hash);
      -- Every provider invocation is a Run. Task remains the compatibility work-item projection while retries/wakes
      -- get their own durable rows instead of being collapsed into tasks.calls.
      CREATE TABLE IF NOT EXISTS agent_runs (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), attempt INTEGER NOT NULL,
        role TEXT NOT NULL, provider TEXT, model TEXT, thinking TEXT,
        status TEXT NOT NULL DEFAULT 'running', result TEXT, error TEXT,
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), ended_at TEXT);
      CREATE INDEX IF NOT EXISTS agent_runs_task ON agent_runs(task_id,id);
      -- Structured outputs from a run. payload/metadata are JSON text so the zero-dependency runtime can evolve
      -- artifact kinds without rewriting the schema.
      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), run_id INTEGER REFERENCES agent_runs(id),
        input_id INTEGER REFERENCES inputs(id), kind TEXT NOT NULL, payload TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts(task_id,id);
      CREATE INDEX IF NOT EXISTS artifacts_input ON artifacts(input_id,id);
      -- A review candidate is the user-facing delivery unit: a frozen commit backed by the intent integration branch.
      CREATE TABLE IF NOT EXISTS review_candidates (
        id INTEGER PRIMARY KEY, input_id INTEGER NOT NULL REFERENCES inputs(id), version INTEGER NOT NULL,
        branch TEXT NOT NULL, commit_hash TEXT NOT NULL, baseline_branch TEXT NOT NULL, baseline_commit TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', summary TEXT, feedback TEXT, report_task_id INTEGER REFERENCES tasks(id),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(input_id,version));
      CREATE INDEX IF NOT EXISTS review_candidates_input ON review_candidates(input_id,id);`;

/** 打开后的验收：库属于别的项目就先 close 再抛错，错误信息与拆分前逐字相同。 */
export function bindProject(db, project) {
  const binding = db.query('SELECT value FROM meta WHERE key=?').get('project');
  if (binding && binding.value !== project) { db.close(); throw new Error('database belongs to another project'); }
  db.query('INSERT OR IGNORE INTO meta VALUES (?,?)').run('project', project);
}
