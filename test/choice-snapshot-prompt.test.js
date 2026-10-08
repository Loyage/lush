import { test, expect } from 'bun:test';
import { PROMPT_PARTS } from '../src/agent/prompts.js';

test('choice snapshots are disabled without authorizing rewinding historical Workers', () => {
  const text = Object.values(PROMPT_PARTS).map(part => part.content).join('\n');
  expect(text).not.toContain('notice answer / dismiss / snapshot / rechoose');
  expect(text).not.toContain('调用实际退出后尝试保存');
  expect(text).toContain('选择快照与重选功能已停用');
  expect(text).toContain('新问卷不保存选择前代码或上下文');
  expect(text).toContain('不得自行回退、复活或操作原 Worker');
  expect(text).toContain('发布 notice 必须是本轮最后一个动作');
});
