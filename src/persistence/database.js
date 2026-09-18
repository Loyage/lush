/**
 * SQLite persistence: schema, migrations and the two synchronous helpers
 * (`script`, `transaction`) every other persistence module builds on.
 *
 * Entry point only — the layers live in the same-named directory:
 *
 *   database/schema.js      every DDL statement and how v1 → v3 relate
 *   database/connection.js  the connection, which migration runs when, and the
 *                           one data-shaped step (old calls become root tasks)
 */
export { Database } from './database/connection.js';
export { CALL_TASK_STATUS, MIGRATION_V2, MIGRATION_V3, SCHEMA } from './database/schema.js';
