/** Deterministic protocol exercise, deliberately not a language model. */
import { AgentResponse, ToolCall } from './provider.js';
import { jsonDump, jsonLoad } from '../core/types.js';

export class MockAgentProvider {
  constructor() {
    this.name = 'mock';
  }

  async call(messages) {
    const last = messages[messages.length - 1];
    if (last.role === 'tool') {
      const result = jsonLoad(last.content);
      if (Object.hasOwn(result, 'error')) return new AgentResponse(`Mock tool error: ${jsonDump(result.error)}`);
      const value = result.result;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.hasOwn(value, 'pid') && Object.hasOwn(value, 'name')) {
        return new AgentResponse(`已执行工具：${value.name}[${value.pid}]，status=${value.status}。`);
      }
      return new AgentResponse(`Mock tool result: ${jsonDump(value)}`);
    }

    let prompt = '';
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') {
        prompt = messages[index].content;
        break;
      }
    }
    if (prompt.startsWith('/tool ')) {
      const rest = prompt.slice('/tool '.length);
      const space = rest.search(/\s/);
      const name = (space === -1 ? rest : rest.slice(0, space)).replaceAll('.', '_');
      const args = space === -1 ? '{}' : rest.slice(space + 1);
      return this._tool(name, args);
    }

    const lower = prompt.toLowerCase();
    if ((prompt.includes('创建') && (prompt.includes('任务') || prompt.includes('服务')))
      || (['create', 'spawn'].some((word) => lower.includes(word))
        && ['task', 'service'].some((word) => lower.includes(word)))) {
      const service = prompt.includes('服务') || lower.includes('service');
      const research = prompt.includes('研究') || lower.includes('research');
      const template = service ? 'generic-service' : research ? 'research-task' : 'generic-task';
      const name = lower.includes('oauth') && !service ? 'research-oauth' : template;
      return this._tool('process_spawn', jsonDump({ template, name, goal: prompt }));
    }
    if (prompt.includes('子') || lower.includes('children')) {
      return this._tool('process_children', '{}');
    }

    const payload = messages.find((message) => message.role === 'system' && message.content.startsWith('LUSH_CONTEXT\n'));
    const data = jsonLoad(payload.content.slice(payload.content.indexOf('\n') + 1));
    const process = data.process;
    const parent = data.parent;
    const parentLabel = parent === null ? '无（系统根）' : `${parent.name}[${parent.pid}]`;
    const children = data.children.map((child) => `${child.name}[${child.pid}]`).join(', ') || '无';
    const userMessages = messages.filter((message) => message.role === 'user').length;
    return new AgentResponse(
      `[Mock] 我是 ${process.name}，PID = ${process.pid}，type = ${process.type}，`
      + `status = ${process.status}。\nparent = ${parentLabel}\n目标：${process.goal}\n`
      + `children：${children}\nstate：${jsonDump(data.state)}\n`
      + `当前对话用户消息数：${userMessages}`,
    );
  }

  _tool(name, args) {
    // Stable within a response; OpenAI only requires IDs to identify tool results.
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    return new AgentResponse('', [new ToolCall(`mock_${safeName}`, name, args)]);
  }
}
