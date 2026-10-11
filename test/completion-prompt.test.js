import { test, expect } from 'bun:test';
import { PROMPT_PARTS, builtInPrompt } from '../src/agent/prompts.js';

test('completion automation prompt preserves user-only authorization and default delegator review', () => {
  expect(PROMPT_PARTS.common_cli.content).toContain('最高自动级别（worker completion）');
  expect(PROMPT_PARTS.common_cli.content).toContain('均为用户专属');
  expect(PROMPT_PARTS.agent.content).toContain('Agent 不得操作自动合并开关或最高自动级别');
  expect(PROMPT_PARTS.completion.content).toContain('Worker 默认随后处于 awaiting_acceptance');
  expect(PROMPT_PARTS.completion.content).toContain('级别不继承给后代');
  expect(PROMPT_PARTS.completion.content).toContain('不调用质量评审 Agent');
  expect(PROMPT_PARTS.completion.content).toContain('默认 child 仍须父 Agent 检查成果，但检查不等于验收回收');
  expect(PROMPT_PARTS.completion.content).toContain('不能借自动链验收其它 Worker 或丢弃工作区');
});

test('delegator reviews delivery but preserves children for revisions until parent acceptance', () => {
  const prompt = builtInPrompt('agent');
  expect(prompt).toContain('成果检查通过不等于验收');
  expect(prompt).toContain('默认保留已交付 child 的 awaiting_acceptance、worktree、分支与会话');
  expect(prompt).toContain('同一个 child');
  expect(prompt).toContain('父 Worker 收口前完成成果检查与集成验证，不要求先逐个验收 child');
  expect(prompt).toContain('只有用户明确要求提前回收');
  expect(prompt).toContain('有疑问就保留');
  expect(prompt).toContain('不能把指令 Worker、自己、兄弟或间接后代作为验收目标');
  expect(prompt).toContain('批量验收不能连带确认用户独立创建的指令');
  expect(prompt).not.toContain('父 Worker 收口前确认自己的派生 Worker');
  expect(prompt).not.toContain('成果符合委派目标且状态为 awaiting_acceptance 时，用 lush worker accept ID');
  expect(prompt).not.toContain('检查 child 成果后 lush worker accept 确认完成');
});
