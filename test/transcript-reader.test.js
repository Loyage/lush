import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { searchTranscript, transcriptStep } from '../src/core/transcript-reader.js';
import { readTranscript } from '../src/core/transcript.js';
import { groupSteps, stepSummary } from '../src/ui/web/assets/transcript-model.js';

const row = message => ({ type: 'message', timestamp: '2026-01-01T00:00:00Z', message });
const assistant = content => row({ role: 'assistant', content });
function session(f, name, records) {
  const file = path.join(f.config.home, 'sessions', `${name}_lush-task-1.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(value => JSON.stringify(value)).join('\n') + '\n'); return file;
}

test('full transcript search reaches beyond 8 MiB and clipped bodies, with filters and stable pagination', async () => {
  const f = fixture();
  try {
    const large = '填'.repeat(4000);
    session(f, '001', Array.from({ length: 750 }, () => assistant([{ type: 'thinking', thinking: large }])));
    session(f, '002', [assistant([{ type: 'toolCall', id: 'a', name: 'bash', arguments: { command: 'echo hello' } }]),
      row({ role: 'toolResult', toolCallId: 'a', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'x'.repeat(30000) + 'needle-tail' }] }),
      assistant([{ type: 'text', text: 'needle-final' }])]);
    expect(readTranscript(f.config, 1).truncated).toBe(true);
    const page = await searchTranscript(f.config, 1, { query: 'needle', limit: 1 });
    expect(page.steps[0].seq).toBe(752); expect(page.steps[0].excerpt).toContain('needle-tail'); expect(page.has_more).toBe(true);
    const next = await searchTranscript(f.config, 1, { query: 'needle', after: page.next, limit: 1 });
    expect(next.steps[0].seq).toBe(753); expect(next.has_more).toBe(false);
    const errors = await searchTranscript(f.config, 1, { tool: 'bash', errors: true, kind: 'result' });
    expect(errors.steps.map(step => step.seq)).toEqual([752]);
    const detail = await transcriptStep(f.config, 1, 752);
    expect(detail.has_more).toBe(true); expect(detail.step.body.length).toBe(24000);
    expect(detail.related[0].seq).toBe(751); expect(detail.related[0].body).toContain('echo hello');
    const tail = await transcriptStep(f.config, 1, 752, detail.next_offset);
    expect(tail.step.body).toEndWith('needle-tail'); expect(tail.has_more).toBe(false);
  } finally { await f.close(); }
});

test('pairing uses session + call identity, not proximity or tool name; summaries carry content', () => {
  const steps = [
    { seq: 1, file: 'a', kind: 'tool', call_id: 'x', title: 'bash', body: '{"command":"git status"}' },
    { seq: 2, file: 'a', kind: 'tool', call_id: 'y', title: 'bash', body: '{}' },
    { seq: 3, file: 'a', kind: 'result', call_id: 'y', body: 'second' },
    { seq: 4, file: 'b', kind: 'result', call_id: 'x', body: 'unrelated session' },
    { seq: 5, file: 'a', kind: 'result', call_id: 'x', body: 'first' },
    { seq: 6, file: 'a', kind: 'result', body: 'legacy' },
  ];
  const groups = groupSteps(steps);
  expect(groups.map(step => step.seq)).toEqual([1, 2, 4, 6]);
  expect(groups[0].results[0].seq).toBe(5); expect(groups[1].results[0].seq).toBe(3);
  expect(stepSummary(steps[0])).toContain('git status');
  expect(stepSummary({ kind: 'thinking', title: '思考', body: '**先检查**\n现有代码' })).toBe('思考 · 先检查 现有代码');
  expect(groupSteps([...steps, { ...steps[0], seq: 7 }]).find(step => step.seq === 5)).toBeTruthy();
});

test('reader rejects malformed filters, unsafe files and oversized records explicitly', async () => {
  const f = fixture();
  try {
    await expect(searchTranscript(f.config, 1, { kind: 'oops' })).rejects.toThrow('kind');
    await expect(searchTranscript(f.config, 1, { errors: 'true' })).rejects.toThrow('boolean');
    await expect(transcriptStep(f.config, 1, -1)).rejects.toThrow('seq');
    const file = session(f, '001', [assistant([{ type: 'text', text: 'ok' }])]);
    fs.appendFileSync(file, '{bad}\n' + JSON.stringify(assistant([{ type: 'text', text: 'unfinished' }])));
    expect((await searchTranscript(f.config, 1)).steps.length).toBe(1);
    fs.writeFileSync(file, 'x'.repeat(16 * 1024 * 1024 + 1));
    await expect(searchTranscript(f.config, 1)).rejects.toThrow('超过 16 MiB');
    fs.unlinkSync(file); fs.symlinkSync(path.join(f.config.home, 'project.db'), file);
    await expect(searchTranscript(f.config, 1)).rejects.toThrow();
  } finally { await f.close(); }
});
