/**
 * The task layer: one unit of work mounted on a process.
 *
 * A process is passive — identity, permissions, variables, state. Work arrives
 * as a **task**: the user's `call` opens a root task on a process, and that
 * task's agent gets the job done by opening child tasks on the process's own
 * children (`task_spawn`) and collecting them (`task_wait`). Tasks therefore
 * form a tree that grows along the process tree, which is exactly what
 * `lush task tree` shows: how one piece of work was solved by cooperation
 * between processes.
 *
 * This file is the layer's entry point only; the rules live one level down, in
 * the same-named directory (`tasks/` plus the sibling `tasks/` folder is the
 * layout the templates use too):
 *
 *   tasks/internal.js  two guards and the in-memory waiter registry, shared
 *   tasks/rules.js     which work may be opened, and every status transition
 *   tasks/read.js      the wire shape, list / tree / inspect, state and delete
 *
 * Everything operates on the `ProcessManager` passed in; the class in
 * `process_manager.js` is the only caller.
 */
export * from './tasks/rules.js';
export * from './tasks/read.js';
