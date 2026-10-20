/** Node-safe protocol names shared by Pi extensions and the daemon; no implementation imports. */
import { PROJECT_ADMINISTRATOR_RPC } from '../administrator/project-tool-protocol.js';
export const MANAGER_METHODS = new Set([
  PROJECT_ADMINISTRATOR_RPC,
  'manager.query', 'manager.start', 'manager.retry', 'manager.catalog', 'manager.history', 'manager.call', 'worker.lookup',
]);
