/** Deterministic protocol exercise, deliberately not a language model. */
import { AgentResponse, ToolCall } from './provider.js';
import { jsonDump, jsonLoad } from '../core/types.js';
import { LUSH_CONTEXT_PREFIX } from '../context/context.js';

export class MockAgentProvider {
  constructor() {
    this.name = 'mock';
    /** In-service runtime: Lush exposes task_* / service_* tools to this agent. */
    this.contextMode = 'tools';
  }

  async call(messages) {
    const last = messages[messages.length - 1];
    if (last.role === 'tool') {
      const result = jsonLoad(last.content);
      if (Object.hasOwn(result, 'error')) return new AgentResponse(`Mock tool error: ${jsonDump(result.error)}`);
      const value = result.result;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.hasOwn(value, 'sid') && Object.hasOwn(value, 'name')) {
        return new AgentResponse(`已执行工具：${value.name}[${value.sid}]，status=${value.status}。`);
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.hasOwn(value, 'id') && Object.hasOwn(value, 'status')) {
        return new AgentResponse(`已执行工具：task#${value.id}，status=${value.status}。`);
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
    const payload = messages.find((message) => message.role === 'system' && message.content.startsWith(LUSH_CONTEXT_PREFIX));
    const data = jsonLoad(payload.content.slice(LUSH_CONTEXT_PREFIX.length));

    // The runtime wakes a task whose children settled with this prompt: report
    // the outcome and finish, which is exactly what a real agent is asked to do.
    if (prompt.startsWith('[Lush]')) {
      const kids = (data.task?.id === null || data.task?.id === undefined)
        ? []
        : data.task.children ?? [];
      const summary = kids.length
        ? kids.map((child) => `#${child.id}=${child.status}`).join(' ')
        : 'children settled';
      return this._tool('task_complete', jsonDump({ result: `woken: ${summary}` }));
    }

    // Delegation first: that is how work moves down the service tree.
    if (prompt.includes('派') || prompt.includes('委托') || lower.includes('delegate') || lower.includes('task_construct')) {
      const target = data.children[0];
      if (target !== undefined) return this._tool('task_construct', jsonDump({ sid: target.sid, goal: prompt }));
    }
    const createWord = prompt.includes('创建') || prompt.includes('研究') || prompt.includes('服务')
      || ['create', 'construct'].some((word) => lower.includes(word));
    if (createWord
      && ['任务', '服务', '服务', 'service', 'task', 'service', 'template'].some((word) => prompt.includes(word) || lower.includes(word))) {
      const service = prompt.includes('服务') || lower.includes('service');
      const research = prompt.includes('研究') || lower.includes('research');
      const template = service ? 'generic-service' : research ? 'research-task' : 'generic-task';
      const name = lower.includes('oauth') && !service ? 'research-oauth' : template;
      return this._tool('service_construct', jsonDump({ template, name, goal: prompt }));
    }
    if (prompt.includes('子') || lower.includes('children')) {
      return this._tool('task_children', '{}');
    }

    const service = data.service;
    const task = data.task;
    const parent = data.parent;
    const parentLabel = parent === null ? '无（系统根）' : `${parent.name}[${parent.sid}]`;
    const children = data.children.map((child) => `${child.name}[${child.sid}]`).join(', ') || '无';
    const userMessages = messages.filter((message) => message.role === 'user').length;
    const taskLabel = task === null
      ? '无（预览）'
      : `#${task.id}（status=${task.status}，父 task=${task.parent_task_id ?? '无'}）`;
    return new AgentResponse(
      `[Mock] 我是 ${service.name}，SID = ${service.sid}，status = ${service.status}。\n`
      + `task = ${taskLabel}\n`
      + `parent = ${parentLabel}\n目标：${service.goal}\n`
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
