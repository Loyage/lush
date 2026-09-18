/**
 * Persistence operations. No Agent, RPC or CLI dependencies.
 *
 * This class is the only way the rest of Lush reaches the database. It is
 * assembled here from the layers in the same-named directory, all merged onto
 * one prototype so callers keep seeing a single flat object:
 *
 *   repository/rows.js     the service entity and the cross-entity transactions
 *   repository/state.js    Context, state, events and history
 *   repository/calls.js    agent calls and messages
 *   repository/tasks.js    the task rows
 *   repository/removal.js  hard deletion
 *
 * Each layer is a method group forwarding to the statement module it belongs to
 * (`repository_state.js`, `repository_calls.js`, `repository_tasks.js`,
 * `repository_removal.js`), so the call sites keep their signatures.
 */
import { callMethods } from './calls.js';
import { removalMethods } from './removal.js';
import { rows } from './rows.js';
import { state } from './state.js';
import { taskMethods } from './tasks.js';

export class Repository {
  constructor(database) {
    this.database = database;
    this.db = database.connection;
  }
}

Object.assign(Repository.prototype, rows, state, callMethods, taskMethods, removalMethods);
