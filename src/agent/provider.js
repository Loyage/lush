/** Provider-neutral messages + tool results (Chat Completions-compatible shapes). */
import { LushError } from '../core/types.js';

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

export async function configuredProvider(env = process.env) {
  const provider = env.LUSH_PROVIDER || 'mock';
  if (provider === 'mock') {
    const { MockAgentProvider } = await import('./mock.js');
    return new MockAgentProvider();
  }
  if (provider === 'openai') {
    const { OpenAICompatibleProvider } = await import('./openai.js');
    return OpenAICompatibleProvider.fromEnv(env);
  }
  throw new LushError(`unknown LUSH_PROVIDER: ${provider}`, -32602);
}
