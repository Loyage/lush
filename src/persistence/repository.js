/**
 * Entry point of the persistence facade; the layers live in the same-named
 * directory (see `repository/index.js` for how the class is assembled):
 *
 *   repository/rows.js     the process entity and the cross-entity transactions
 *   repository/state.js    Context, state, events and history
 *   repository/calls.js    agent calls and messages
 *   repository/tasks.js    the task rows
 *   repository/removal.js  hard deletion
 */
export { Repository } from './repository/index.js';
