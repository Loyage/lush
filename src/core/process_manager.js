/**
 * Entry point of the process manager; the layers live in the same-named
 * directory (see `process_manager/index.js` for how the class is assembled):
 *
 *   process_manager/read.js    PID 0 setup, read models, variables
 *   process_manager/nodes.js   spawn, the transition machine, orphans, removal
 *   process_manager/agents.js  profile resolution and the agent verbs
 *   process_manager/tasks.js   the task verbs
 */
export { ProcessManager } from './process_manager/index.js';
