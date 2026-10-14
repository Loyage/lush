import { test, expect } from 'bun:test';
import { builtInPrompt } from '../src/agent/prompts.js';
import { AGENT_CAPABILITIES, capabilityGuide } from '../src/agent/capabilities.js';

const retiredDevelopmentCLI = /\blush (?:skills|progress|worker (?:spawn|auto-title|message|accept)|notice (?:post|example|check))\b/;

test('active development prompts and built-in guides consistently use lushc without retired CLI aliases', () => {
  for (const taskKind of ['order', 'child', 'analysis', 'integration']) {
    const prompt = builtInPrompt('agent', { taskKind });
    expect(prompt).not.toMatch(retiredDevelopmentCLI);
    expect(prompt).toContain('lushc 是 daemon 当前代码所固定的开发协作 CLI');
    expect(prompt).toContain('不可借它绕过开发权限');
  }
  const prompt = builtInPrompt('agent', { taskKind: 'order' });
  expect(prompt).toContain('lushc worker message');
  expect(prompt).toContain('lushc notice post');
  for (const entry of AGENT_CAPABILITIES) {
    const guide = capabilityGuide(entry.id).content;
    expect(guide).not.toMatch(retiredDevelopmentCLI);
    expect(guide).toContain('lushc ');
  }
});

test('Valet instructions explain reviewed project-wide lushc access without development workspaces or unsafe authority', () => {
  const prompt = builtInPrompt('manager');
  for (const text of ['默认开放全部 lushc RPC 能力', '不能挂在 Valet 下', '可信 bridge',
    '已有 Valet 不随新默认扩权', '同一 occurrence 等待用户答复', 'context.management.decisions', 'worker_metadata_only', '可续读元数据投影', '根据 coverage', 'steps_truncated/events_truncated', '不能按请求 limit 推算', 'goal_truncated/goal_length', 'worker.spawn', 'worker.message', 'worker.auto_title', 'notice.post',
    'worker.accept 必须先持久预检', '真实用户确认精确目标', '没有 read/bash/write/edit']) expect(prompt).toContain(text);
  expect(prompt).not.toContain('lushc worker spawn');
  expect(prompt).not.toContain('可选 Agent 能力');
});
