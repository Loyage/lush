import { test, expect } from 'bun:test';
import { PROMPT_PARTS } from '../src/agent/prompts.js';

test('choice reselect is user-only and checkpoint never authorizes rewinding old Workers', () => {
  const text = Object.values(PROMPT_PARTS).map(part => part.content).join('\n');
  expect(text).toContain('notice answer / dismiss / snapshot / rechoose');
  expect(text).toContain('调用实际退出后尝试保存');
  expect(text).toContain('不得自行回退、复活或操作原 Worker');
  expect(text).toContain('发布 notice 必须是本轮最后一个动作');
});
