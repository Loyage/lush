import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { sessionFixture, sessionFile } from './session-fixture.js';
import { projectRecord, readTranscript, readTranscriptLatest } from '../src/core/transcript.js';
import { searchTranscript, transcriptStep, transcriptPage } from '../src/core/transcript-reader.js';
import { groupSteps, toolDurationMs, stepDurationText } from '../src/ui/web/assets/transcript-model.js';

const reply = (started = 1000, ended = 3500) => ({ type: 'message', timestamp: ended,
  message: { role: 'assistant', timestamp: started, content: [
    { type: 'thinking', thinking: 'consider' }, { type: 'text', text: 'answer' },
    { type: 'toolCall', name: 'bash', id: 'call', arguments: { command: 'echo ok' } },
  ] } });

test('all parts share the model response interval; invalid/missing clocks stay unknown', () => {
  expect(projectRecord(reply()).map(step => step.model_duration_ms)).toEqual([2500, 2500, 2500]);
  expect(projectRecord(reply('1970-01-01T00:00:01Z', '1970-01-01T00:00:03.500Z'))[0].model_duration_ms).toBe(2500);
  expect(projectRecord(reply(1000, 1000))[0].model_duration_ms).toBe(0);
  for (const [start, end] of [[null, 3500], ['bad', 3500], [4000, 3500], [1e20, 3500], [1000, null], [1000, 1e20]]) {
    expect(projectRecord(reply(start, end)).every(step => step.model_duration_ms === undefined)).toBe(true);
  }
  const record = reply(); delete record.message.timestamp;
  expect(projectRecord(record)[0].model_duration_ms).toBeUndefined();
});

test('model timing survives every read path and pagination without changing the session', async () => {
  const f = sessionFixture();
  try {
    const file = sessionFile(f.root, 1, [reply(), { type: 'message', timestamp: 4500,
      message: { role: 'toolResult', toolCallId: 'call', toolName: 'bash', content: [{ type: 'text', text: 'ok' }] } }]);
    const original = fs.readFileSync(file, 'utf8');
    for (const page of [readTranscript(f.config, 1), await readTranscriptLatest(f.config, 1),
      await searchTranscript(f.config, 1), await transcriptPage(f.config, 1)]) {
      expect(page.steps.slice(0, 3).map(step => step.model_duration_ms)).toEqual([2500, 2500, 2500]);
      expect(page.steps[3].model_duration_ms).toBeUndefined();
      expect(toolDurationMs(groupSteps(page.steps).find(step => step.kind === 'tool'))).toBe(1000);
    }
    expect((await readTranscriptLatest(f.config, 1, { limit: 2 })).steps[0].model_duration_ms).toBe(2500);
    expect(readTranscript(f.config, 1, 1, 1).steps[0].model_duration_ms).toBe(2500);
    const detail = await transcriptStep(f.config, 1, 3);
    expect(detail.step.model_duration_ms).toBe(2500);
    expect(toolDurationMs(detail.step, detail.related)).toBe(1000);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  } finally { f.close(); }
});

test('tool intervals require a unique session/call result and valid ordered timestamps', () => {
  const call = { seq: 1, file: 'a', kind: 'tool', call_id: 'x', at: '2026-01-01T00:00:00Z' };
  const result = { seq: 3, file: 'a', kind: 'result', call_id: 'x', at: '2026-01-01T00:00:01.250Z' };
  expect(toolDurationMs(call, [result])).toBe(1250);
  expect(toolDurationMs(call, [{ ...result, at: call.at }])).toBe(0);
  for (const values of [[], [result, result], [{ ...result, file: 'b' }], [{ ...result, call_id: 'y' }],
    [{ ...result, seq: 0 }], [{ ...result, at: 'bad' }], [{ ...result, at: '2025-12-31T23:59:59Z' }]]) {
    expect(toolDurationMs(call, values)).toBeNull();
  }
  expect(toolDurationMs({ ...call, at: undefined }, [result])).toBeNull();
  expect(toolDurationMs({ ...call, call_id: undefined }, [result])).toBeNull();
  const duplicate = groupSteps([call, { ...call, seq: 2 }, result]);
  expect(duplicate.filter(step => step.kind === 'tool').map(step => toolDurationMs(step))).toEqual([null, null]);
  const other = { ...call, seq: 2, call_id: 'other' };
  const groups = groupSteps([call, other, { ...result, call_id: 'other' }, { ...result, seq: 4, at: '2026-01-01T00:00:02Z' }]);
  expect(groups.map(step => toolDurationMs(step))).toEqual([2000, 1250]);
});

test('duration text covers subsecond, seconds, minutes, hours and unknown values', () => {
  expect([0, 1, 125, 1000, 1250, 60000, 65000, 3600000, 5400000, 90000000].map(stepDurationText)).toEqual([
    '0s', '0.001s', '0.125s', '1s', '1.3s', '1m', '1.1m', '1h', '1.5h', '25h',
  ]);
  expect([null, undefined, NaN, Infinity, -1].map(stepDurationText)).toEqual(Array(5).fill(''));
});
