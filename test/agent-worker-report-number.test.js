import { test, expect } from 'bun:test';
import { builtInPrompt, agentPrompt } from '../src/agent/prompts.js';
import { MockProvider } from '../src/agent/provider.js';

test('user reports prefer explicit Worker numbers in built-in and Pi-default prompts', () => {
  for (const role of ['agent', 'worker', 'research', 'coordinator', 'planner', 'merger', 'verifier']) {
    for (const progressReporting of [true, false]) {
      const text = builtInPrompt(role, { progressReporting });
      expect(text).toContain('统一使用资料中明确给出的 worker_number');
      expect(text).toContain('没有编号时才回退 #内部ID');
      expect(text).toContain('不得从 id 推算 W 编号');
      expect(text).toContain('内部整数 id 仍用于 API、权限、链接与路径');
      expect(text).toContain('原始输入展示为 O<Input ID>');
      expect(text).toContain('question、questionnaire、历史 plan 用 D<Notice ID>');
      expect(text).toContain('info 用 N<Notice ID>');
      expect(text).toContain('kind 未知时保守用 N');
      expect(text).toContain('不把 Worker 追加消息或暂存编号改成 O');
      expect(text).toContain('CLI Notice 参数与路径仍用原整数 ID');
    }
  }
  const config = { project: '/unused-project', home: '/unused-home' };
  expect(agentPrompt(config, 'agent', { config_mode: 'pi' }).text).toContain('统一使用资料中明确给出的 worker_number');
  expect(agentPrompt(config, 'agent', {}, 'analysis').text).toContain('不得从 id 推算 W 编号');
  expect(builtInPrompt('explainer')).toContain('不得推算 W 编号');
});

test('mock report uses W identity without altering task IDs or inventing legacy numbers', async () => {
  const provider = new MockProvider();
  for (const number of ['W119', 'W119-2-1', null, undefined]) {
    const task = { id: 246, role: 'agent', goal: 'report', worker_number: number };
    const result = await provider.run({ task, messages: [], signal: new AbortController().signal });
    expect(result).toBe(`Mock agent ${number ?? '#246'}: report（未调用模型、未修改文件）`);
    expect(task.id).toBe(246);
    expect(task.worker_number).toBe(number);
    expect(result).not.toContain('W246');
  }
});
