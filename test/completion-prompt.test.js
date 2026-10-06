import { test, expect } from 'bun:test';
import { PROMPT_PARTS } from '../src/agent/prompts.js';

test('completion automation prompt preserves user-only authorization and default delegator review', () => {
  expect(PROMPT_PARTS.common_cli.content).toContain('最高自动级别（worker completion）');
  expect(PROMPT_PARTS.common_cli.content).toContain('均为用户专属');
  expect(PROMPT_PARTS.agent.content).toContain('Agent 不得操作自动合并开关或最高自动级别');
  expect(PROMPT_PARTS.completion.content).toContain('Worker 默认随后处于 awaiting_acceptance');
  expect(PROMPT_PARTS.completion.content).toContain('级别不继承给后代');
  expect(PROMPT_PARTS.completion.content).toContain('不调用质量评审 Agent');
  expect(PROMPT_PARTS.completion.content).toContain('默认 child 仍须父 Agent 检查确认');
  expect(PROMPT_PARTS.completion.content).toContain('不能借自动链验收其它 Worker 或丢弃工作区');
});
