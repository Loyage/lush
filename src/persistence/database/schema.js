/**
 * Every DDL statement this project has ever shipped: the current schema plus
 * the migration ladder (`MIGRATION_V2` … `MIGRATION_V10`) that brings an older
 * home up to it.
 *
 * Keeping them in one file makes the "what does a database look like at
 * version N" question answerable by reading top to bottom — `SCHEMA` is what a
 * fresh home gets, each `MIGRATION_Vn` is one in-place step an existing home
 * goes through, and `CALL_TASK_STATUS` is the only interpretive step (how an
 * old call's status maps onto the task status that replaced it).
 *
 * The executing side (`connection.js`) only decides *when* to run which.
 */

/**
 * The current schema.
 *
 * `services` are passive nodes: identity, permissions (`child_templates`),
 * variables and persistent state. They never run an agent themselves — the
 * work happens in `tasks`, each mounted on exactly one service. A `task` owns
 * one agent conversation (`agent_calls` / `messages`, both carrying the
 * `task_id` next to the `pid` they ran on) and may have child tasks, which is
 * what makes a task tree visible while it is being worked through the service
 * tree.
 *
 * Status sets match `core/lifecycle.js`: services are `created / active /
 * stopped`, tasks are `created / running / waiting / awaiting / completed /
 * failed / cancelled`, intensions are `queued / parsing / awaiting / settled /
 * rejected`.
 *
 * An `intension` is raw *user input* before it is any work: the user's own
 * words (`content`), the service they named (`sid`, NULL when they named
 * none), and how far the top-level parser got with it (`status`, `attempts`,
 * `resolution`, `response`). The task that parses it is a normal root task on
 * the parsing node, linked by `parse_task_id`; `blocked_by_task_id` is a user
 * decision to let another task finish first. The other direction of the
 * conflict conversation is `notices.intension_id`.
 *
 * A `notice` is a task's agent reporting to the user: it records who reported
 * (`sid` + `task_id`), what they need (`kind`, `title`, `body`), the answer form
 * they declared (`fields`), whether the reporter is waiting on it (`wait`), and
 * how the user settled it (`status` / `answer` / `note`).
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS services (
    sid INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_sid INTEGER REFERENCES services(sid),
    original_parent_sid INTEGER REFERENCES services(sid),
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('created','active','stopped')),
    template TEXT NOT NULL,
    template_snapshot TEXT NOT NULL,
    goal TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((sid=0 AND parent_sid IS NULL AND original_parent_sid IS NULL)
       OR (sid>0 AND parent_sid IS NOT NULL AND original_parent_sid IS NOT NULL)),
    CHECK(parent_sid IS NULL OR parent_sid != sid)
);
CREATE INDEX IF NOT EXISTS service_parent ON services(parent_sid);
CREATE TABLE IF NOT EXISTS contexts (
    sid INTEGER PRIMARY KEY REFERENCES services(sid),
    system_prompt TEXT NOT NULL,
    state TEXT NOT NULL,
    artifacts TEXT NOT NULL,
    refs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sid INTEGER NOT NULL REFERENCES services(sid),
    parent_task_id INTEGER REFERENCES tasks(id),
    root_task_id INTEGER NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('created','running','waiting','awaiting','completed','failed','cancelled')),
    result TEXT,
    error TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK(parent_task_id IS NULL OR parent_task_id != id)
);
CREATE INDEX IF NOT EXISTS tasks_sid ON tasks(sid, id);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id, id);
CREATE INDEX IF NOT EXISTS tasks_root ON tasks(root_task_id, id);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, id);
CREATE TABLE IF NOT EXISTS agent_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sid INTEGER NOT NULL REFERENCES services(sid),
    task_id INTEGER REFERENCES tasks(id),
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted')),
    output TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS calls_sid ON agent_calls(sid, id);
CREATE INDEX IF NOT EXISTS calls_task ON agent_calls(task_id, id);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sid INTEGER NOT NULL REFERENCES services(sid),
    task_id INTEGER REFERENCES tasks(id),
    call_id INTEGER NOT NULL REFERENCES agent_calls(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_sid ON messages(sid, id);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, id);
CREATE TABLE IF NOT EXISTS service_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sid INTEGER NOT NULL REFERENCES services(sid),
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_sid ON service_events(sid, id);
CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id);
CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sid INTEGER NOT NULL REFERENCES services(sid),
    task_id INTEGER REFERENCES tasks(id),
    intension_id INTEGER REFERENCES intensions(id),
    kind TEXT NOT NULL CHECK(kind IN ('report','decision','blocked')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    fields TEXT NOT NULL,
    wait INTEGER NOT NULL CHECK(wait IN (0,1)),
    status TEXT NOT NULL CHECK(status IN ('open','answered','dismissed')),
    answer TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    answered_at TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notices_status ON notices(status, id);
CREATE INDEX IF NOT EXISTS notices_sid ON notices(sid, id);
CREATE INDEX IF NOT EXISTS notices_task ON notices(task_id, id);
CREATE INDEX IF NOT EXISTS notices_intension ON notices(intension_id, id);
CREATE TABLE IF NOT EXISTS intensions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sid INTEGER REFERENCES services(sid),
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','parsing','awaiting','settled','rejected')),
    parse_task_id INTEGER REFERENCES tasks(id),
    blocked_by_task_id INTEGER REFERENCES tasks(id),
    attempts INTEGER NOT NULL DEFAULT 0,
    resolution TEXT,
    response TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    settled_at TEXT
);
CREATE INDEX IF NOT EXISTS intensions_status ON intensions(status, id);
CREATE INDEX IF NOT EXISTS intensions_blocked ON intensions(blocked_by_task_id);
CREATE INDEX IF NOT EXISTS intensions_parse_task ON intensions(parse_task_id);
CREATE TABLE IF NOT EXISTS task_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_task_id INTEGER NOT NULL REFERENCES tasks(id),
    from_task_id INTEGER REFERENCES tasks(id),
    kind TEXT NOT NULL CHECK(kind IN ('message','child_settled','notice_settled')),
    body TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS task_inbox_to ON task_inbox(to_task_id, id);
-- The chain view ('task.trace') reads the *outbound* side of the same table
-- (who did this task talk to), so it needs the mirror index or every trace
-- walks the whole table.
CREATE INDEX IF NOT EXISTS task_inbox_from ON task_inbox(from_task_id, id);
PRAGMA user_version = 10;
`;

/**
 * v1 → v2: one service kind. Rows become `type='service'`, `cancelled`
 * collapses into `stopped`, and the row-level status CHECK stops depending on
 * the type. SQLite cannot drop a CHECK constraint, so the table is rebuilt in
 * place; foreign keys are switched off around the swap because every sibling
 * table references `services` by name.
 */
export const MIGRATION_V2 = `
CREATE TABLE processes_v2 (
    pid INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_pid INTEGER REFERENCES processes(pid),
    original_parent_pid INTEGER REFERENCES processes(pid),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type='service'),
    status TEXT NOT NULL CHECK(status IN ('created','running','stopped','failed','completed','reclaimed')),
    template TEXT NOT NULL,
    template_snapshot TEXT NOT NULL,
    goal TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((pid=0 AND parent_pid IS NULL AND original_parent_pid IS NULL AND type='service')
       OR (pid>0 AND parent_pid IS NOT NULL AND original_parent_pid IS NOT NULL)),
    CHECK(parent_pid IS NULL OR parent_pid != pid)
);
INSERT INTO processes_v2
  (pid,parent_pid,original_parent_pid,name,type,status,template,template_snapshot,goal,created_at,updated_at)
  SELECT pid,parent_pid,original_parent_pid,name,'service',
         CASE status WHEN 'cancelled' THEN 'stopped' ELSE status END,
         template,template_snapshot,goal,created_at,updated_at
  FROM processes;
DROP TABLE processes;
ALTER TABLE processes_v2 RENAME TO processes;
CREATE INDEX IF NOT EXISTS process_parent ON processes(parent_pid);
PRAGMA user_version = 2;
`;

/**
 * v2 → v3: the task layer, and processes as passive nodes.
 *
 * `type` disappears (`service` and service are the same thing) and the service
 * status set collapses to created / active / stopped. Every historical agent
 * call becomes a root task, so old work stays readable as a task with the same
 * prompt, output and messages; processes that were completed / failed /
 * reclaimed are simply `stopped` now, because "done" is a fact about a task,
 * not about a node.
 */
export const MIGRATION_V3 = `
CREATE TABLE processes_v3 (
    pid INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_pid INTEGER REFERENCES processes(pid),
    original_parent_pid INTEGER REFERENCES processes(pid),
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('created','active','stopped')),
    template TEXT NOT NULL,
    template_snapshot TEXT NOT NULL,
    goal TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((pid=0 AND parent_pid IS NULL AND original_parent_pid IS NULL)
       OR (pid>0 AND parent_pid IS NOT NULL AND original_parent_pid IS NOT NULL)),
    CHECK(parent_pid IS NULL OR parent_pid != pid)
);
INSERT INTO processes_v3
  (pid,parent_pid,original_parent_pid,name,status,template,template_snapshot,goal,created_at,updated_at)
  SELECT pid,parent_pid,original_parent_pid,name,
         CASE status WHEN 'created' THEN 'created' WHEN 'stopped' THEN 'stopped' ELSE 'active' END,
         template,template_snapshot,goal,created_at,updated_at
  FROM processes;
DROP TABLE processes;
ALTER TABLE processes_v3 RENAME TO processes;
CREATE INDEX IF NOT EXISTS process_parent ON processes(parent_pid);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL REFERENCES processes(pid),
    parent_task_id INTEGER REFERENCES tasks(id),
    root_task_id INTEGER NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('created','running','waiting','completed','failed','cancelled')),
    result TEXT,
    error TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK(parent_task_id IS NULL OR parent_task_id != id)
);
CREATE INDEX IF NOT EXISTS tasks_pid ON tasks(pid, id);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id, id);
CREATE INDEX IF NOT EXISTS tasks_root ON tasks(root_task_id, id);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, id);
ALTER TABLE agent_calls ADD COLUMN task_id INTEGER REFERENCES tasks(id);
ALTER TABLE messages ADD COLUMN task_id INTEGER REFERENCES tasks(id);
CREATE INDEX IF NOT EXISTS calls_task ON agent_calls(task_id, id);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, id);
CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id);
PRAGMA user_version = 3;
`;

/** v3 -> v4: rename the logical process tables to service tables. */
export const MIGRATION_V4 = `
ALTER TABLE processes RENAME TO _v4_services;
ALTER TABLE process_events RENAME TO _v4_service_events;
-- The legacy index keeps its name when the table is renamed; free it before rebuilding.
DROP INDEX IF EXISTS events_pid;
CREATE TABLE _v4_contexts AS SELECT * FROM contexts;
CREATE TABLE _v4_tasks AS SELECT * FROM tasks;
CREATE TABLE _v4_agent_calls AS SELECT * FROM agent_calls;
CREATE TABLE _v4_messages AS SELECT * FROM messages;
CREATE TABLE _v4_task_events AS SELECT * FROM task_events;
DROP TABLE messages;
DROP TABLE agent_calls;
DROP TABLE task_events;
DROP TABLE tasks;
DROP TABLE contexts;
CREATE TABLE services (
    pid INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_pid INTEGER REFERENCES services(pid),
    original_parent_pid INTEGER REFERENCES services(pid),
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('created','active','stopped')),
    template TEXT NOT NULL,
    template_snapshot TEXT NOT NULL,
    goal TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((pid=0 AND parent_pid IS NULL AND original_parent_pid IS NULL)
       OR (pid>0 AND parent_pid IS NOT NULL AND original_parent_pid IS NOT NULL)),
    CHECK(parent_pid IS NULL OR parent_pid != pid)
);
INSERT INTO services SELECT pid,parent_pid,original_parent_pid,name,status,template,template_snapshot,goal,created_at,updated_at FROM _v4_services;
CREATE INDEX service_parent ON services(parent_pid);
CREATE TABLE contexts (
    pid INTEGER PRIMARY KEY REFERENCES services(pid),
    system_prompt TEXT NOT NULL, state TEXT NOT NULL, artifacts TEXT NOT NULL, refs TEXT NOT NULL
);
INSERT INTO contexts SELECT * FROM _v4_contexts;
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL REFERENCES services(pid),
    parent_task_id INTEGER REFERENCES tasks(id), root_task_id INTEGER NOT NULL,
    goal TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('created','running','waiting','completed','failed','cancelled')),
    result TEXT, error TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT,
    finished_at TEXT, updated_at TEXT NOT NULL, CHECK(parent_task_id IS NULL OR parent_task_id != id)
);
INSERT INTO tasks SELECT * FROM _v4_tasks;
CREATE INDEX tasks_pid ON tasks(pid,id);
CREATE INDEX tasks_parent ON tasks(parent_task_id,id);
CREATE INDEX tasks_root ON tasks(root_task_id,id);
CREATE INDEX tasks_status ON tasks(status,id);
CREATE TABLE agent_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL REFERENCES services(pid), task_id INTEGER REFERENCES tasks(id),
    prompt TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted')),
    output TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT
);
INSERT INTO agent_calls(id,pid,prompt,status,output,error,started_at,finished_at,task_id)
  SELECT id,pid,prompt,status,output,error,started_at,finished_at,task_id FROM _v4_agent_calls;
CREATE INDEX calls_pid ON agent_calls(pid,id);
CREATE INDEX calls_task ON agent_calls(task_id,id);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL REFERENCES services(pid), task_id INTEGER REFERENCES tasks(id),
    call_id INTEGER NOT NULL REFERENCES agent_calls(id), body TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO messages(id,pid,call_id,body,created_at,task_id)
  SELECT id,pid,call_id,body,created_at,task_id FROM _v4_messages;
CREATE INDEX messages_pid ON messages(pid,id);
CREATE INDEX messages_task ON messages(task_id,id);
CREATE TABLE service_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL REFERENCES services(pid), kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO service_events SELECT * FROM _v4_service_events;
CREATE INDEX events_pid ON service_events(pid,id);
CREATE TABLE task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO task_events SELECT * FROM _v4_task_events;
CREATE INDEX task_events_task ON task_events(task_id,id);
DROP TABLE _v4_services;
DROP TABLE _v4_service_events;
DROP TABLE _v4_contexts;
DROP TABLE _v4_tasks;
DROP TABLE _v4_agent_calls;
DROP TABLE _v4_messages;
DROP TABLE _v4_task_events;
PRAGMA user_version = 4;
`;

/** v4 -> v5: rename service identifiers from PID terminology to SID terminology. */
export const MIGRATION_V5 = `
CREATE TABLE _v5_services AS SELECT * FROM services;
CREATE TABLE _v5_contexts AS SELECT * FROM contexts;
CREATE TABLE _v5_tasks AS SELECT * FROM tasks;
CREATE TABLE _v5_agent_calls AS SELECT * FROM agent_calls;
CREATE TABLE _v5_messages AS SELECT * FROM messages;
CREATE TABLE _v5_service_events AS SELECT * FROM service_events;
CREATE TABLE _v5_task_events AS SELECT * FROM task_events;
DROP TABLE messages;
DROP TABLE agent_calls;
DROP TABLE service_events;
DROP TABLE task_events;
DROP TABLE tasks;
DROP TABLE contexts;
DROP TABLE services;
CREATE TABLE services (
    sid INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_sid INTEGER REFERENCES services(sid), original_parent_sid INTEGER REFERENCES services(sid),
    name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('created','active','stopped')),
    template TEXT NOT NULL, template_snapshot TEXT NOT NULL, goal TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK((sid=0 AND parent_sid IS NULL AND original_parent_sid IS NULL)
       OR (sid>0 AND parent_sid IS NOT NULL AND original_parent_sid IS NOT NULL)),
    CHECK(parent_sid IS NULL OR parent_sid != sid)
);
INSERT INTO services SELECT pid,parent_pid,original_parent_pid,name,status,template,template_snapshot,goal,created_at,updated_at FROM _v5_services;
CREATE INDEX service_parent ON services(parent_sid);
CREATE TABLE contexts (sid INTEGER PRIMARY KEY REFERENCES services(sid), system_prompt TEXT NOT NULL, state TEXT NOT NULL, artifacts TEXT NOT NULL, refs TEXT NOT NULL);
INSERT INTO contexts SELECT pid,system_prompt,state,artifacts,refs FROM _v5_contexts;
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sid INTEGER NOT NULL REFERENCES services(sid),
    parent_task_id INTEGER REFERENCES tasks(id), root_task_id INTEGER NOT NULL, goal TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('created','running','waiting','completed','failed','cancelled')),
    result TEXT, error TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT,
    finished_at TEXT, updated_at TEXT NOT NULL, CHECK(parent_task_id IS NULL OR parent_task_id != id)
);
INSERT INTO tasks SELECT id,pid,parent_task_id,root_task_id,goal,status,result,error,state,created_at,started_at,finished_at,updated_at FROM _v5_tasks;
CREATE INDEX tasks_sid ON tasks(sid,id); CREATE INDEX tasks_parent ON tasks(parent_task_id,id); CREATE INDEX tasks_root ON tasks(root_task_id,id); CREATE INDEX tasks_status ON tasks(status,id);
CREATE TABLE agent_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sid INTEGER NOT NULL REFERENCES services(sid), task_id INTEGER REFERENCES tasks(id),
    prompt TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted')),
    output TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT
);
INSERT INTO agent_calls SELECT id,pid,task_id,prompt,status,output,error,started_at,finished_at FROM _v5_agent_calls;
CREATE INDEX calls_sid ON agent_calls(sid,id); CREATE INDEX calls_task ON agent_calls(task_id,id);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sid INTEGER NOT NULL REFERENCES services(sid), task_id INTEGER REFERENCES tasks(id),
    call_id INTEGER NOT NULL REFERENCES agent_calls(id), body TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO messages SELECT id,pid,task_id,call_id,body,created_at FROM _v5_messages;
CREATE INDEX messages_sid ON messages(sid,id); CREATE INDEX messages_task ON messages(task_id,id);
CREATE TABLE service_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sid INTEGER NOT NULL REFERENCES services(sid), kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO service_events SELECT id,pid,kind,data,created_at FROM _v5_service_events;
CREATE INDEX events_sid ON service_events(sid,id);
CREATE TABLE task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO task_events SELECT * FROM _v5_task_events;
CREATE INDEX task_events_task ON task_events(task_id,id);
DROP TABLE _v5_services; DROP TABLE _v5_contexts; DROP TABLE _v5_tasks; DROP TABLE _v5_agent_calls;
DROP TABLE _v5_messages; DROP TABLE _v5_service_events; DROP TABLE _v5_task_events;
PRAGMA user_version = 5;
`;

/**
 * v5 → v6: the notice channel. A new table only — nothing existing changes, so
 * an older home is brought forward by creating it and stamping the version.
 */
export const MIGRATION_V6 = `
CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sid INTEGER NOT NULL REFERENCES services(sid),
    task_id INTEGER REFERENCES tasks(id),
    kind TEXT NOT NULL CHECK(kind IN ('report','decision','blocked')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    fields TEXT NOT NULL,
    wait INTEGER NOT NULL CHECK(wait IN (0,1)),
    status TEXT NOT NULL CHECK(status IN ('open','answered','dismissed')),
    answer TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    answered_at TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notices_status ON notices(status, id);
CREATE INDEX IF NOT EXISTS notices_sid ON notices(sid, id);
CREATE INDEX IF NOT EXISTS notices_task ON notices(task_id, id);
PRAGMA user_version = 6;
`;

/**
 * v6 → v7: the task inbox. A new table only — messages between direct parent /
 * child tasks plus the report that a child settled. An older home just gets the
 * table created and the version stamped.
 */
export const MIGRATION_V7 = `
CREATE TABLE IF NOT EXISTS task_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_task_id INTEGER NOT NULL REFERENCES tasks(id),
    from_task_id INTEGER REFERENCES tasks(id),
    kind TEXT NOT NULL CHECK(kind IN ('message','child_settled')),
    body TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS task_inbox_to ON task_inbox(to_task_id, id);
PRAGMA user_version = 7;
`;

/**
 * v7 → v8: the outbound edge of the task inbox. The chain read model
 * (`task.trace`) asks "what did this task send", which is `from_task_id` — the
 * column the v7 table left unindexed. An index only; no row changes.
 */
export const MIGRATION_V8 = `
CREATE INDEX IF NOT EXISTS task_inbox_from ON task_inbox(from_task_id, id);
PRAGMA user_version = 8;
`;

/**
 * v8 → v9: notices stop blocking and start being answered asynchronously. A
 * reporter that asks for an answer now parks in the new `awaiting` task status,
 * and the settled notice is handed back to it as one more piece of inbox input
 * (`kind='notice_settled'`). Both are CHECK constraints, which SQLite cannot
 * alter in place, so `tasks` and `task_inbox` are rebuilt with the wider sets.
 *
 * Each table is renamed *out of the way*, the new one is created, the rows are
 * copied and the old one dropped. That order matters twice: sibling tables keep
 * pointing at `tasks` (they reference it by name and the old one must be gone
 * before the name comes back), and `tasks.parent_task_id` references `tasks`
 * itself — the one clause SQLite will *not* rewrite when a table is renamed.
 * `legacy_alter_table` is what turns that rewriting off, so the names in
 * existing FKs stay exactly as they were; `PRAGMA foreign_keys = OFF` (in
 * `script()`) is what makes the drop legal while siblings still point at it.
 *
 * Rows are copied by `SELECT *`, so the new status starts out unused and old
 * homes keep their data; the dropped tables' indexes are recreated by hand.
 */
export const MIGRATION_V9 = `
PRAGMA legacy_alter_table = ON;
ALTER TABLE tasks RENAME TO tasks_v9;
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sid INTEGER NOT NULL REFERENCES services(sid),
    parent_task_id INTEGER REFERENCES tasks(id),
    root_task_id INTEGER NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('created','running','waiting','awaiting','completed','failed','cancelled')),
    result TEXT,
    error TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK(parent_task_id IS NULL OR parent_task_id != id)
);
INSERT INTO tasks SELECT * FROM tasks_v9;
DROP TABLE tasks_v9;
CREATE INDEX IF NOT EXISTS tasks_sid ON tasks(sid, id);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id, id);
CREATE INDEX IF NOT EXISTS tasks_root ON tasks(root_task_id, id);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, id);
ALTER TABLE task_inbox RENAME TO task_inbox_v9;
CREATE TABLE task_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_task_id INTEGER NOT NULL REFERENCES tasks(id),
    from_task_id INTEGER REFERENCES tasks(id),
    kind TEXT NOT NULL CHECK(kind IN ('message','child_settled','notice_settled')),
    body TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT
);
INSERT INTO task_inbox SELECT * FROM task_inbox_v9;
DROP TABLE task_inbox_v9;
CREATE INDEX IF NOT EXISTS task_inbox_to ON task_inbox(to_task_id, id);
CREATE INDEX IF NOT EXISTS task_inbox_from ON task_inbox(from_task_id, id);
PRAGMA legacy_alter_table = OFF;
PRAGMA user_version = 9;
`;

/**
 * v9 → v10: the intension queue. Raw user input becomes a row of its own
 * (`intensions`) instead of arriving as a root task on whatever service the
 * user named, and a conflict notice can point back at the input it is about
 * (`notices.intension_id`).
 *
 * The new column is the only change to an existing table and SQLite can add it
 * in place, so nothing is rebuilt: an older home gets the table, the column,
 * the indexes and the version stamp. The new table's foreign keys are resolved
 * at DML time, so its `tasks` / `services` references are fine even though it
 * is created after them.
 */
export const MIGRATION_V10 = `
CREATE TABLE IF NOT EXISTS intensions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sid INTEGER REFERENCES services(sid),
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','parsing','awaiting','settled','rejected')),
    parse_task_id INTEGER REFERENCES tasks(id),
    blocked_by_task_id INTEGER REFERENCES tasks(id),
    attempts INTEGER NOT NULL DEFAULT 0,
    resolution TEXT,
    response TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    settled_at TEXT
);
CREATE INDEX IF NOT EXISTS intensions_status ON intensions(status, id);
CREATE INDEX IF NOT EXISTS intensions_blocked ON intensions(blocked_by_task_id);
CREATE INDEX IF NOT EXISTS intensions_parse_task ON intensions(parse_task_id);
ALTER TABLE notices ADD COLUMN intension_id INTEGER REFERENCES intensions(id);
CREATE INDEX IF NOT EXISTS notices_intension ON notices(intension_id, id);
PRAGMA user_version = 10;
`;

/** One historical call → the root task it becomes in v3. */
export const CALL_TASK_STATUS = {
  succeeded: 'completed', failed: 'failed', interrupted: 'cancelled', running: 'failed',
};
