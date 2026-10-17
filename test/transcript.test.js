import { test, expect } from 'bun:test';
import { sessionFixture as fixture, sessionFile } from './session-fixture.js';
import { readTranscript, readUsage } from '../src/core/transcript.js';

test('transcript reads input, thinking, paired tool output and billed reply with stable pagination', () => {
  const f = fixture();
  const message = (role, content, extra = {}) => ({ type: 'message', timestamp: 1789749049638,
    message: { role, content, ...extra } });
  try {
    sessionFile(f.root, 1, [
      { type: 'session', id: 'lush-task-1', cwd: '/tmp/project' },
      message('user', [{ type: 'text', text: 'read source' }]),
      message('assistant', [{ type: 'thinking', thinking: 'look around' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } }]),
      message('toolResult', [{ type: 'text', text: 'src\nREADME.md' }], { toolCallId: 'call_1', toolName: 'bash', isError: false }),
      message('assistant', [{ type: 'text', text: 'Done.' }], { provider: 'deepseek', model: 'deepseek-chat',
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.001 } } }),
    ]);
    const first = readTranscript(f.config, 1, 0, 3);
    expect(first.steps.map(step => step.kind)).toEqual(['input', 'thinking', 'tool']);
    expect(JSON.parse(first.steps[2].body)).toEqual({ command: 'ls' });
    expect(first.has_more).toBe(true);
    const second = readTranscript(f.config, 1, first.next, 3);
    expect(second.steps.map(step => step.body)).toEqual(['src\nREADME.md', 'Done.']);
    expect(second.has_more).toBe(false);
    expect(readUsage(f.config, 1)).toMatchObject({ requests: 2, context_tokens: 120,
      totals: { input: 100, output: 20, tokens: 120, cost: 0.001 } });
  } finally { f.close(); }
});
