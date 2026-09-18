/**
 * Entry point of the agent runtime; the layers live in the same-named
 * directory (see `runtime/runner.js` for how the class is assembled):
 *
 *   runtime/runner.js       the runtime object, its slots and its shutdown
 *   runtime/space.js        the agent space / invocation descriptions (read)
 *   runtime/task.js         one task's run, its invocations and its timer
 *   runtime/interactive.js  a run handed to the caller's own terminal
 */
export { AgentRuntime } from './runtime/runner.js';
