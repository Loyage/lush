import { test, expect } from 'bun:test';
import { sessionFixture as fixture, sessionFile } from './session-fixture.js';
import { searchTranscript, transcriptStep, transcriptPage } from '../src/core/transcript-reader.js';
import { groupSteps } from '../src/ui/web/assets/transcript-model.js';

test('reader searches saved sessions, pages results and pairs tools by their call identity', async () => {
  const f = fixture();
  const row = message => ({ type: 'message', timestamp: '2026-01-01T00:00:00Z', message });
  try {
    sessionFile(f.root, 1, [
      row({ role: 'assistant', content: [{ type: 'text', text: 'needle introduction' }] }),
      row({ role: 'assistant', content: [{ type: 'toolCall', id: 'call-a', name: 'bash', arguments: { command: 'git status' } }] }),
      row({ role: 'toolResult', toolCallId: 'call-a', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'needle output' }] }),
      row({ role: 'assistant', content: [{ type: 'text', text: 'finished' }] }),
    ]);
    const first = await searchTranscript(f.config, 1, { query: 'needle', limit: 1 });
    expect(first.steps.map(step => step.seq)).toEqual([1]); expect(first.has_more).toBe(true);
    const next = await searchTranscript(f.config, 1, { query: 'needle', after: first.next, limit: 1 });
    expect(next.steps.map(step => step.seq)).toEqual([3]); expect(next.has_more).toBe(false);
    const detail = await transcriptStep(f.config, 1, 3);
    expect(detail.step.body).toBe('needle output');
    expect(detail.related[0].body).toContain('git status');
    const page = await transcriptPage(f.config, 1, 1);
    expect(page.steps.map(step => step.seq)).toEqual([1, 2, 3, 4]);
    expect(groupSteps(page.steps).find(step => step.seq === 2).results[0].seq).toBe(3);
    expect(page).toMatchObject({ next_seq: 5, next_offset: 0, has_more: false });
  } finally { await f.close(); }
});
