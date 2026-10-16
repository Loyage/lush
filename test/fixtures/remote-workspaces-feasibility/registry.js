// Experimental test contract only. Not a production Runner protocol.
export const TOOL_REGISTRY = Object.freeze([
  { name: 'read', factory: 'createReadTool', writes: false },
  { name: 'edit', factory: 'createEditTool', writes: true },
  { name: 'write', factory: 'createWriteTool', writes: true },
  { name: 'bash', factory: 'createBashTool', writes: true },
].map(Object.freeze));
export const TOOL_NAMES = Object.freeze(TOOL_REGISTRY.map(tool => tool.name));

export function assertSupportedConfiguration(config) {
  if (config.agent !== 'pi' || config.configMode !== 'lush' || config.transport !== 'fixture-stdio') {
    throw new Error('Unsupported remote configuration; no local fallback');
  }
  for (const resource of ['extensions', 'mcp', 'skills', 'prompts', 'packages', 'themes']) {
    if (!Array.isArray(config[resource]) || config[resource].length) {
      throw new Error(`Unsupported remote resource: ${resource}`);
    }
  }
}
export const CONTROLLED_CONFIGURATION = Object.freeze({ agent: 'pi', configMode: 'lush', transport: 'fixture-stdio',
  extensions: [], mcp: [], skills: [], prompts: [], packages: [], themes: [] });

export function authorize(frame, binding) {
  if (!frame || ['project', 'worker', 'run', 'generation', 'token'].some(key => frame[key] !== binding[key])) {
    throw new Error('Denied: invocation binding');
  }
  if (frame.method === 'tool' && !TOOL_NAMES.includes(frame.name)) throw new Error('Denied: tool not registered');
}

export function createRemoteTools(pi, bridge, logicalCwd) {
  return TOOL_REGISTRY.map(({ name, factory }) => {
    // Only take schema/description, NEVER a local execute function or preview renderer.
    const native = pi[factory](logicalCwd);
    return { name, label: name, description: native.description, parameters: native.parameters,
      execute: (_id, args, signal, onUpdate) => bridge.call('tool', { name, args }, { signal, onUpdate }) };
  });
}
