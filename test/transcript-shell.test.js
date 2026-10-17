import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { transcriptShell } from '../src/core/transcript-shell.js';
import { projectRecord } from '../src/core/transcript.js';
import { searchTranscript } from '../src/core/transcript-reader.js';

const tool = args => ({ kind: 'tool', tool_name: 'bash', body: JSON.stringify(args) });

test('shell identities include complete exact commands and every argument, canonicalizing only JSON key order', () => {
  const a = transcriptShell(tool({ command: 'bun run test\necho "safe"', timeout: 20, extra: { z: 1, a: ['x', 'y'] } }));
  const b = transcriptShell(tool({ extra: { a: ['x', 'y'], z: 1 }, timeout: 20, command: 'bun run test\necho "safe"' }));
  expect(a.fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(a.fingerprint).toBe(b.fingerprint);
  expect(a.command).toBe('bun run test\necho "safe"'); expect(a.identity_complete).toBe(true);
  for (const args of [{ command: 'bun run test ', timeout: 20 }, { command: 'bun run test', timeout: 21 }, { command: 'bun run test', timeout: 20, cwd: '/another' }]) {
    expect(transcriptShell(tool(args)).fingerprint).not.toBe(transcriptShell(tool({ command: 'bun run test', timeout: 20 })).fingerprint);
  }
  expect(transcriptShell({ kind: 'tool', tool_name: 'read', body: '{"command":"ignored"}' })).toBeNull();
  expect(transcriptShell({ ...tool({ command: 'x' }), kind: 'result' })).toBeNull();
});

test('bounded previews never become grouping identities; excessive or malformed arguments explicitly lose identity', () => {
  const prefix = 'echo ' + 'a'.repeat(3000);
  const a = transcriptShell(tool({ command: prefix + 'one' })), b = transcriptShell(tool({ command: prefix + 'two' }));
  expect(a.command).toBe(b.command); expect(a.command_truncated).toBe(true); expect(a.command_length).toBe(prefix.length + 3);
  expect(a.fingerprint).not.toBe(b.fingerprint); expect(a.identity_complete).toBe(true);
  for (const step of [tool({ command: 'echo x', large: 'a'.repeat(300000) }), tool({ command: '' }), tool([]), { ...tool({}), body: '{invalid' }]) {
    expect(transcriptShell(step)).toMatchObject({ identity_complete: false, fingerprint: null });
  }
  let nested = 'value'; for (let i = 0; i < 40; i++) nested = { child: nested };
  expect(transcriptShell(tool({ command: 'echo x', nested }))).toMatchObject({ identity_complete: false, reason: 'analysis_limit' });
});

test('result projection distinguishes explicit failure/success from absent error evidence', () => {
  for (const [flag, known, failed] of [[true, true, true], [false, true, false], [undefined, false, false], [null, false, false], ['false', false, true], [1, false, true]]) {
    const [step] = projectRecord({ type: 'message', message: { role: 'toolResult', toolName: 'bash', toolCallId: 'x', isError: flag, content: [{ type: 'text', text: 'not inferred from FAIL or exit code text' }] } });
    expect(step.error_known).toBe(known); expect(step.is_error).toBe(failed);
  }
});

test('real full transcript search hashes unclipped arguments, emits bounded command metadata and keeps paging/source identities', async () => {
  const f = fixture();
  try {
    const task = f.store.create({ role: 'research', input_id: null, goal: 'shell performance evidence' });
    const dir = path.join(f.config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
    const command = 'echo ' + 'x'.repeat(2200);
    const records = [
      { type: 'message', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [
        { type: 'toolCall', name: 'bash', id: 'a', arguments: { command: command + 'one', timeout: 20 } },
        { type: 'toolCall', name: 'bash', id: 'b', arguments: { command: command + 'two', timeout: 20 } },
      ] } },
      { type: 'message', timestamp: '2026-01-01T00:00:07Z', message: { role: 'toolResult', toolName: 'bash', toolCallId: 'a', isError: true, content: [{ type: 'text', text: 'failed' }] } },
    ];
    const file = path.join(dir, `001_lush-task-${task.id}.jsonl`), text = records.map(value => JSON.stringify(value)).join('\n') + '\n'; fs.writeFileSync(file, text);
    const first = await searchTranscript(f.config, task.id, { limit: 1 });
    const second = await searchTranscript(f.config, task.id, { after: first.next, limit: 1 });
    expect(first.steps[0].body).toBe(second.steps[0].body); expect(first.steps[0].body_truncated).toBe(true);
    expect(first.steps[0].shell.fingerprint).not.toBe(second.steps[0].shell.fingerprint);
    expect(first.steps[0].shell.command).toBe(second.steps[0].shell.command);
    expect(first.has_more).toBe(true); expect(second.steps[0].seq).toBe(2);
    const last = await searchTranscript(f.config, task.id, { after: second.next });
    expect(last.steps[0]).toMatchObject({ kind: 'result', is_error: true, error_known: true, call_id: 'a' });
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  } finally { await f.close(); }
});
