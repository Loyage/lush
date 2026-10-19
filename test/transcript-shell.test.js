import { expect, test } from 'bun:test';
import { transcriptShell } from '../src/core/transcript-shell.js';

const tool = args => ({ kind: 'tool', tool_name: 'bash', body: JSON.stringify(args) });

test('shell identities include exact commands and arguments, canonicalizing JSON key order', () => {
  const a = transcriptShell(tool({ command: 'bun run test\necho "safe"', timeout: 20, extra: { z: 1, a: ['x', 'y'] } }));
  const b = transcriptShell(tool({ extra: { a: ['x', 'y'], z: 1 }, timeout: 20, command: 'bun run test\necho "safe"' }));
  expect(a.fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(a.fingerprint).toBe(b.fingerprint);
  expect(a.command).toBe('bun run test\necho "safe"'); expect(a.identity_complete).toBe(true);
  expect(transcriptShell(tool({ command: 'bun run test', timeout: 21 })).fingerprint).not.toBe(a.fingerprint);
});
