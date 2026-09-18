/**
 * Human-readable output for the `process` / `task` verbs.
 *
 * `format(args, result)` picks one of these by command (`format/index.js`), and
 * they never decide anything about state — every value they print came from the
 * daemon. The entry point is this barrel; the layers live in the same-named
 * directory, split by what is being rendered:
 *
 *   process/inspect.js  a node: history, inspect, view, list, lifecycle, orphans
 *   process/agents.js   a running agent: show, list, kill, session, dry-run
 *   process/tasks.js    a task: line, list, tree, inspect, result, call, delete
 */
export * from './process/inspect.js';
export * from './process/agents.js';
export * from './process/tasks.js';
