/** Reviewed, credential-free Agent resource capabilities.
 * Shared by project Valet admission and the separate device Valet tool catalogue.
 * These lists describe an upper bound, not an authorization grant: callers must
 * still validate their real invocation, parameters and current policy.
 */
export const AGENT_RESOURCE_READ_METHODS = Object.freeze([
  'agent.status', 'agent.models', 'agent.resources', 'agent.selection.resources',
  'agent.connections.list', 'agent.connections.history', 'agent.connections.models',
  'agent.registered_models.list', 'agent.registered_models.resolve',
  'agent.usage.config', 'agent.usage.history', 'agent.packages.list',
]);

// The device runtime uses the existing device settings adapter, not a project
// daemon. Project-owned usage/consumer history is deliberately not in this set.
export const DEVICE_VALET_READ_METHODS = Object.freeze([
  'agent.status', 'agent.models', 'agent.resources', 'agent.selection.resources',
  'agent.connections.list', 'agent.connections.models',
  'agent.registered_models.list', 'agent.registered_models.resolve',
]);

// Refreshes make network requests and change shared caches, so they are writes.
// Connection saves may update public metadata only; credentials, authentication,
// environment, private prompts, packages and arbitrary execution stay excluded.
export const DEVICE_VALET_WRITE_METHODS = Object.freeze([
  'agent.configure', 'agent.connections.save', 'agent.connections.remove',
  'agent.connections.sampling', 'agent.connections.query', 'agent.connections.models.refresh',
  'agent.registered_models.save', 'agent.registered_models.remove',
]);

export const DEVICE_VALET_METHODS = Object.freeze([
  ...DEVICE_VALET_READ_METHODS, ...DEVICE_VALET_WRITE_METHODS,
]);
