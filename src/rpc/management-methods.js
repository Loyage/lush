/** Node-safe protocol names shared by Pi extensions and the daemon; no implementation imports. */
export const MANAGER_METHODS = new Set([
  'manager.query', 'manager.start', 'manager.retry', 'manager.catalog', 'manager.history', 'manager.call', 'worker.lookup',
]);
