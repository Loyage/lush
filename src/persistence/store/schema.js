/** 全部 DDL 与项目绑定校验：schema 与列名是公共面，改动必须同步 docs/engineering/modules.md。 */
export const SCHEMA = `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      -- Keep schema creation atomic and avoid an fsync for each CREATE on a new project.
      BEGIN;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Managed connections have independent observations and config revisions; never migrate legacy usage.
      CREATE TABLE IF NOT EXISTS agent_connection_state (
        connection_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision TEXT NOT NULL,
        account_key TEXT, source_key TEXT);
      CREATE TABLE IF NOT EXISTS agent_connection_queries (
        id INTEGER PRIMARY KEY, query_key TEXT NOT NULL UNIQUE,
        connection_id TEXT NOT NULL, revision TEXT, provider TEXT NOT NULL,
        account_key TEXT NOT NULL, source_key TEXT NOT NULL,
        checked_at TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT, source TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_connection_queries_current
        ON agent_connection_queries(connection_id,revision,account_key,source_key,checked_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS agent_connection_queries_success
        ON agent_connection_queries(connection_id,account_key,source_key,checked_at DESC,id DESC)
        WHERE status IN ('available','partial');
      CREATE INDEX IF NOT EXISTS agent_connection_queries_time ON agent_connection_queries(checked_at);
      CREATE TABLE IF NOT EXISTS agent_connection_series (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, provider TEXT NOT NULL,
        account_key TEXT NOT NULL, source_key TEXT NOT NULL, metric_id TEXT NOT NULL,
        kind TEXT, scope TEXT NOT NULL, label TEXT NOT NULL, unit TEXT, window_seconds INTEGER,
        models TEXT NOT NULL, last_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_connection_series_account
        ON agent_connection_series(connection_id,account_key,source_key,last_at DESC);
      CREATE TABLE IF NOT EXISTS agent_connection_points (
        series_id TEXT NOT NULL REFERENCES agent_connection_series(id) ON DELETE CASCADE,
        query_id INTEGER NOT NULL REFERENCES agent_connection_queries(id) ON DELETE CASCADE,
        checked_at TEXT NOT NULL, remaining REAL, total REAL, used REAL, used_percent REAL,
        status TEXT NOT NULL, reset_at TEXT, error_code TEXT, source TEXT NOT NULL,
        PRIMARY KEY (series_id,query_id));
      CREATE INDEX IF NOT EXISTS agent_connection_points_time
        ON agent_connection_points(series_id,checked_at DESC,query_id DESC);
      CREATE INDEX IF NOT EXISTS agent_connection_points_query ON agent_connection_points(query_id);
      -- Sanitized project-local account observations; technical cache, not task facts.
      CREATE TABLE IF NOT EXISTS agent_usage_queries (
        id INTEGER PRIMARY KEY, query_key TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL, account_key TEXT NOT NULL, source_key TEXT NOT NULL,
        checked_at TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_usage_queries_account_time
        ON agent_usage_queries(provider,account_key,source_key,checked_at DESC);
      CREATE INDEX IF NOT EXISTS agent_usage_queries_time ON agent_usage_queries(checked_at);
      CREATE INDEX IF NOT EXISTS agent_usage_queries_success ON agent_usage_queries(provider,account_key,source_key,checked_at DESC)
        WHERE status='available';
      CREATE TABLE IF NOT EXISTS agent_usage_series (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, account_key TEXT NOT NULL, source_key TEXT NOT NULL,
        metric_id TEXT NOT NULL, kind TEXT, label TEXT NOT NULL, unit TEXT, window_seconds INTEGER,
        last_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_usage_series_account
        ON agent_usage_series(provider,account_key,source_key,last_at DESC);
      CREATE INDEX IF NOT EXISTS agent_usage_series_time ON agent_usage_series(last_at DESC);
      CREATE TABLE IF NOT EXISTS agent_usage_points (
        series_id TEXT NOT NULL REFERENCES agent_usage_series(id) ON DELETE CASCADE,
        query_id INTEGER NOT NULL REFERENCES agent_usage_queries(id) ON DELETE CASCADE,
        checked_at TEXT NOT NULL, remaining REAL, total REAL, used REAL, used_percent REAL,
        status TEXT NOT NULL, reset_at TEXT, error_code TEXT,
        PRIMARY KEY (series_id,query_id));
      CREATE INDEX IF NOT EXISTS agent_usage_points_time ON agent_usage_points(series_id,checked_at DESC,query_id DESC);
      CREATE INDEX IF NOT EXISTS agent_usage_points_query ON agent_usage_points(query_id);
      -- anchor_* 为兼容旧库保留名称：它们表示可推进的输入聚合分支 / 初始 commit / worktree / 用户指定父分支。
      -- planner 在该 worktree 解析；普通 worker 以 anchor_commit 为冻结基线，并以 anchor_branch 为直接父分支。
      CREATE TABLE IF NOT EXISTS inputs (
        id INTEGER PRIMARY KEY, content TEXT NOT NULL, task_id INTEGER,
        anchor_branch TEXT, anchor_commit TEXT, anchor_workspace TEXT, anchor_target_branch TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      -- 用户输入先落成草稿；input_id IS NULL 表示还没提交。提交时整批拼成一条 inputs。
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY, content TEXT NOT NULL, input_id INTEGER REFERENCES inputs(id),
        parent_id INTEGER, revision INTEGER,
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
        role TEXT NOT NULL, goal TEXT NOT NULL, name TEXT, display_title TEXT, status TEXT NOT NULL DEFAULT 'queued',
        result TEXT, error TEXT, calls INTEGER NOT NULL DEFAULT 0,
        agent_wakes INTEGER NOT NULL DEFAULT 0, agent_token_hash TEXT, agent_last_seen_at TEXT,
        workspace TEXT, branch TEXT, base_commit TEXT, head_commit TEXT,
        -- Current delivery baseline; original fork base_commit remains immutable.
        iteration_base_commit TEXT,
        integration TEXT NOT NULL DEFAULT 'none', target_branch TEXT, integration_error TEXT,
        -- layer: 'intent'（planner 拆解 / scheduler 编排）不进任务树；'work' 才是用户要的开发任务链。
        layer TEXT NOT NULL DEFAULT 'work',
        -- NULL/legacy=旧任务；main/owner 是静息根；order 直接管理输入；历史专用节点只保留记录。
        task_kind TEXT,
        -- Immutable public number; historical Workers retain NULL and their integer identity.
        worker_number TEXT,
        -- order/child 的合并预约；versioned JSON，NULL 表示未预约，历史其它预约只保留记录。
        reservation TEXT,
        auto_merge TEXT,
        hooks TEXT,
        -- 管理 Worker 的显式绑定、信号与受控操作收据；NULL 历史行不授予新权限。
        management TEXT,
        -- plan_gate: planner 这一轮拆解的审批闸门：NULL=没申请批准（直接编排）/ proposed=等你批准 / approved / rejected。
        plan_gate TEXT,
        -- verifier task: verifies_task_id 指向被检验的 worker；baseline_* 是目标分支的对照检出。
        verifies_task_id INTEGER REFERENCES tasks(id), baseline_workspace TEXT, baseline_commit TEXT,
        -- merger task: resolves_task_id 指向合并冲突的那个 worker。冲突处理不在原任务的子树里
        -- （终态任务不允许有活动后代），所以和 verifier 一样用关联边而不是父子边。
        resolves_task_id INTEGER REFERENCES tasks(id),
        -- candidate verifier: review_candidate_id pins this run to the exact integration commit the user reviews.
        review_candidate_id INTEGER,
        -- Agent 汇报的执行里程碑；versioned JSON，属于 task 附属元数据而非新实体。
        progress_plan TEXT,
        -- 历史展示快照：兼容旧库，只读保留，不再创建展示 Task。
        showcase TEXT,
        -- 完整且已校验的 task-local Agent profile；只在一次显式重试到下次终态之间生效。
        retry_profile TEXT,
        interrupt_state TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      -- A commit identifies the Pi context present when an agent made it. External commits
      -- deliberately have no row; task creation then starts with an empty conversation.
      CREATE TABLE IF NOT EXISTS commit_contexts (
        commit_hash TEXT PRIMARY KEY, task_id INTEGER NOT NULL,
        session_path TEXT NOT NULL, entry_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS tasks_layer_status ON tasks(layer,status,id);
      CREATE INDEX IF NOT EXISTS tasks_layer_id_status ON tasks(layer,id DESC,status);
      CREATE INDEX IF NOT EXISTS tasks_integration_resolver ON tasks(integration,resolves_task_id,id);
      CREATE INDEX IF NOT EXISTS tasks_resolver ON tasks(resolves_task_id,id);
      CREATE INDEX IF NOT EXISTS tasks_input_role_status ON tasks(input_id,role,status,id);
      CREATE INDEX IF NOT EXISTS tasks_role_plan_gate ON tasks(role,plan_gate);
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
      CREATE INDEX IF NOT EXISTS task_specs_input_status ON task_specs(input_id,status);
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
        -- 历史分支展示预约：只读保留，不再写入、启动或清除。
        showcase_reservation TEXT,
        -- 一键合并运行：目标分支附属的可空 versioned JSON（status/order/index/done/skipped/waiting_task_id）。
        -- 它不是独立业务实体，只记录这条分支当前正在收拢哪些后代、合并到哪里了；终态后清空。
        merge_run TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS branches_parent ON branches(parent);
      CREATE INDEX IF NOT EXISTS branches_task ON branches(task_id);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), sender_id INTEGER REFERENCES tasks(id),
        body TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
        signal_type TEXT, signal_key TEXT, delivery_hold TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE IF NOT EXISTS notices (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), title TEXT NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', answer TEXT, kind TEXT NOT NULL DEFAULT 'question',
        source_event_id INTEGER, read_at TEXT, answer_source TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      -- Derived, bounded Notice synchronization metadata. The Notice row remains authoritative.
      -- Record identities survive updates and differ even when SQLite reuses an integer ID.
      CREATE TABLE IF NOT EXISTS notice_sync_records (
        notice_id INTEGER PRIMARY KEY, identity TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS notice_sync_changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, notice_id INTEGER NOT NULL,
        identity TEXT NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)));
      -- Seed only the derived identity index on first installation, never rewrite historical Notices.
      INSERT OR IGNORE INTO notice_sync_records(notice_id,identity)
        SELECT id,lower(hex(randomblob(16))) FROM notices
        WHERE NOT EXISTS(SELECT 1 FROM meta WHERE key='notice_sync_epoch');
      INSERT OR IGNORE INTO meta(key,value) VALUES ('notice_sync_epoch',lower(hex(randomblob(16))));
      CREATE TRIGGER IF NOT EXISTS notice_sync_insert AFTER INSERT ON notices BEGIN
        INSERT OR REPLACE INTO notice_sync_records(notice_id,identity) VALUES(NEW.id,lower(hex(randomblob(16))));
        INSERT INTO notice_sync_changes(notice_id,identity,deleted)
          SELECT NEW.id,identity,0 FROM notice_sync_records WHERE notice_id=NEW.id;
        UPDATE notice_sync_records SET revision=last_insert_rowid() WHERE notice_id=NEW.id;
        DELETE FROM notice_sync_changes WHERE seq <= (SELECT MAX(seq)-10000 FROM notice_sync_changes);
      END;
      CREATE TRIGGER IF NOT EXISTS notice_sync_update AFTER UPDATE ON notices BEGIN
        INSERT INTO notice_sync_changes(notice_id,identity,deleted)
          SELECT NEW.id,identity,0 FROM notice_sync_records WHERE notice_id=NEW.id;
        UPDATE notice_sync_records SET revision=last_insert_rowid() WHERE notice_id=NEW.id;
        DELETE FROM notice_sync_changes WHERE seq <= (SELECT MAX(seq)-10000 FROM notice_sync_changes);
      END;
      CREATE TRIGGER IF NOT EXISTS notice_sync_delete AFTER DELETE ON notices BEGIN
        INSERT INTO notice_sync_changes(notice_id,identity,deleted)
          SELECT OLD.id,identity,1 FROM notice_sync_records WHERE notice_id=OLD.id;
        DELETE FROM notice_sync_records WHERE notice_id=OLD.id;
        DELETE FROM notice_sync_changes WHERE seq <= (SELECT MAX(seq)-10000 FROM notice_sync_changes);
      END;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, task_id INTEGER REFERENCES tasks(id), type TEXT NOT NULL, data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS notices_task_status_kind ON notices(task_id,status,kind,id);
      CREATE INDEX IF NOT EXISTS notices_status_kind ON notices(status,kind,id);
      -- Notice-owned checkpoints and idempotent fork receipts, not new business entities.
      CREATE TABLE IF NOT EXISTS choice_snapshots (
        notice_id INTEGER PRIMARY KEY REFERENCES notices(id), task_id INTEGER NOT NULL REFERENCES tasks(id),
        status TEXT NOT NULL, revision TEXT NOT NULL, reason TEXT, run_id INTEGER,
        parent_id INTEGER, target_branch TEXT, source_branch TEXT, source_workspace TEXT,
        profile TEXT, pointer TEXT, rule TEXT, commit_hash TEXT, context_digest TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS choice_snapshots_task ON choice_snapshots(task_id,status);
      CREATE TABLE IF NOT EXISTS choice_rechoices (
        request_id TEXT PRIMARY KEY, notice_id INTEGER NOT NULL REFERENCES notices(id),
        revision TEXT NOT NULL, answer TEXT NOT NULL, status TEXT NOT NULL,
        task_id INTEGER REFERENCES tasks(id), context_digest TEXT, error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS choice_rechoices_task ON choice_rechoices(task_id);
      CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, consumed);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
      CREATE INDEX IF NOT EXISTS events_task_type_id ON events(task_id, type, id);
      CREATE INDEX IF NOT EXISTS events_type_id ON events(type, id);
      -- 「快速介绍」记录：选中任意页面文字后直连 OpenAI 兼容 API 的只读结果。它不是 Task（没有分支、
      -- 没有 worktree、不参与调度），只是为「解释历史」保留的一份带来源快照的模型输出。task_id 可空，
      -- 只用于把发生在某个任务详情页上的记录归到该任务的历史里，不加外键：删任务不连带删这条阅读记录。
      CREATE TABLE IF NOT EXISTS introductions (
        id INTEGER PRIMARY KEY, task_id INTEGER, quote TEXT NOT NULL, location TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running', result TEXT, error TEXT,
        base_url TEXT, model TEXT, source_snapshot TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS introductions_task ON introductions(task_id, id);
      -- 快捷解释的追问轮次：同一条解释下的多轮问答，沿用原解释固定的来源与 Prompt 快照。
      -- 每行是一次追问（question）与模型回答（answer）；status 与 introductions 一致。
      -- context_truncated 记录本轮因上下文上限被截断掉了更早的追问，供界面如实提示。
      CREATE TABLE IF NOT EXISTS explanation_followups (
        id INTEGER PRIMARY KEY, introduction_id INTEGER NOT NULL,
        question TEXT NOT NULL, answer TEXT, status TEXT NOT NULL DEFAULT 'running', error TEXT,
        context_truncated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS explanation_followups_intro ON explanation_followups(introduction_id, id);
      CREATE INDEX IF NOT EXISTS sleep_choice_notice ON events(json_extract(data,'$.notice.id'),json_extract(data,'$.notice.task_id')) WHERE type='sleep.choice.started';
      CREATE INDEX IF NOT EXISTS sleep_choice_result ON events(json_extract(data,'$.choice_id')) WHERE type='sleep.choice.finished';
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
      CREATE INDEX IF NOT EXISTS review_candidates_input ON review_candidates(input_id,id);

      -- O(1) homepage invalidation cursor and exact task counters. Opening an old database seeds
      -- the technical aggregate once; triggers keep it current without changing task semantics.
      CREATE TABLE IF NOT EXISTS overview_task_counts (
        layer TEXT NOT NULL, status TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(layer,status));
      DELETE FROM overview_task_counts;
      INSERT INTO overview_task_counts(layer,status,count) SELECT layer,status,count(*) FROM tasks GROUP BY layer,status;
      INSERT OR IGNORE INTO meta(key,value) VALUES ('overview_revision','0');
      CREATE TRIGGER IF NOT EXISTS overview_tasks_insert AFTER INSERT ON tasks BEGIN
        UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision';
        INSERT INTO overview_task_counts(layer,status,count) VALUES (NEW.layer,NEW.status,1)
          ON CONFLICT(layer,status) DO UPDATE SET count=count+1;
      END;
      CREATE TRIGGER IF NOT EXISTS overview_tasks_update AFTER UPDATE ON tasks BEGIN
        UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision';
        UPDATE overview_task_counts SET count=count-1 WHERE layer=OLD.layer AND status=OLD.status;
        INSERT INTO overview_task_counts(layer,status,count) VALUES (NEW.layer,NEW.status,1)
          ON CONFLICT(layer,status) DO UPDATE SET count=count+1;
      END;
      CREATE TRIGGER IF NOT EXISTS overview_tasks_delete AFTER DELETE ON tasks BEGIN
        UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision';
        UPDATE overview_task_counts SET count=count-1 WHERE layer=OLD.layer AND status=OLD.status;
      END;
      CREATE TRIGGER IF NOT EXISTS overview_events_insert AFTER INSERT ON events BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_events_update AFTER UPDATE ON events BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_events_delete AFTER DELETE ON events BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_inputs_insert AFTER INSERT ON inputs BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_inputs_update AFTER UPDATE ON inputs BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_inputs_delete AFTER DELETE ON inputs BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_drafts_insert AFTER INSERT ON drafts BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_drafts_update AFTER UPDATE ON drafts BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_drafts_delete AFTER DELETE ON drafts BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_draft_refs_insert AFTER INSERT ON draft_references BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_draft_refs_update AFTER UPDATE ON draft_references BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_draft_refs_delete AFTER DELETE ON draft_references BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_notices_insert AFTER INSERT ON notices BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_notices_update AFTER UPDATE ON notices BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_notices_delete AFTER DELETE ON notices BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_specs_insert AFTER INSERT ON task_specs BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_specs_update AFTER UPDATE ON task_specs BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_specs_delete AFTER DELETE ON task_specs BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_candidates_insert AFTER INSERT ON review_candidates BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_candidates_update AFTER UPDATE ON review_candidates BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      CREATE TRIGGER IF NOT EXISTS overview_candidates_delete AFTER DELETE ON review_candidates BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='overview_revision'; END;
      COMMIT;`;

/** 打开后的验收：库属于别的项目就先 close 再抛错，错误信息与拆分前逐字相同。 */
export function bindProject(db, project) {
  const binding = db.query('SELECT value FROM meta WHERE key=?').get('project');
  if (binding && binding.value !== project) { db.close(); throw new Error('database belongs to another project'); }
  db.query('INSERT OR IGNORE INTO meta VALUES (?,?)').run('project', project);
}
