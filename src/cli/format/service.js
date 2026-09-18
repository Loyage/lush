/**
 * Human-readable output for the `service` / `task` verbs.
 *
 * `format(args, result)` picks one of these by command (`format/index.js`), and
 * they never decide anything about state — every value they print came from the
 * daemon. The entry point is this barrel; the layers live in the same-named
 * directory, split by what is being rendered:
 *
 *   service/inspect.js  a node: history, inspect, view, list, lifecycle, orphans
 *   service/agents.js   a running agent: show, list, kill, session, argv
 *   service/tasks.js    a task: line, list, tree, inspect, result, call, delete
 */
export * from './service/inspect.js';
export * from './service/agents.js';
export * from './service/tasks.js';
