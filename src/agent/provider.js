/** Provider-neutral messages + tool results (Chat Completions-compatible shapes). */
export class ToolCall {
  constructor(id, name, args) {
    this.id = id;
    this.name = name;
    /** JSON string; invalid arguments become a recoverable tool error. */
    this.arguments = args;
  }

  asDict() {
    return { id: this.id, type: 'function', function: { name: this.name, arguments: this.arguments } };
  }
}

export class AgentResponse {
  constructor(content = '', toolCalls = []) {
    this.content = content;
    this.toolCalls = toolCalls;
  }

  asMessage() {
    const result = { role: 'assistant', content: this.content };
    if (this.toolCalls.length) result.tool_calls = this.toolCalls.map((tool) => tool.asDict());
    return result;
  }
}

/**
 * The fallback-tier provider: environment variables over the built-in `default`
 * profile (pi with the pure flag set). A process that selects its own agent
 * profile goes through `AgentCatalog` instead; see `catalog.js`.
 *
 * `profile` accepts an already resolved spec (`AgentCatalog.spec`), which is how
 * the daemon hands a specific agent to this factory.
 */
export async function configuredProvider(env = process.env, { home, profile = null } = {}) {
  const { AgentCatalog } = await import('./catalog.js');
  const catalog = new AgentCatalog({ home, env });
  return catalog.provider(profile === null ? catalog.spec(null) : profile);
}
