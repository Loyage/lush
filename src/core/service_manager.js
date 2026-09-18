/**
 * Entry point of the service manager; the layers live in the same-named
 * directory (see `service_manager/index.js` for how the class is assembled):
 *
 *   service_manager/read.js    SID 0 setup, read models, variables
 *   service_manager/nodes.js   construct, the transition machine, orphans, removal
 *   service_manager/agents.js  profile resolution and the agent verbs
 *   service_manager/tasks.js   the task verbs
 */
export { ServiceManager } from './service_manager/index.js';
