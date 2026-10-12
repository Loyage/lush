import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { projectHistoryEvent } from '../../src/persistence/store/reading.js';
import { previewHistoryEvent } from '../../src/ui/web/assets/reading-projection.js';

const scan = (store, id, query) => {
  const events = []; let before_event = null;
  do {
    const page = store.readingPage(id, { query, before_event, before_message: 0, limit: 10 });
    events.push(...page.events); before_event = page.event_cursor;
  } while (before_event !== 0);
  return events;
};

test('timeline full-history query searches safe type/key/value metadata beyond its preview, never private configuration', async () => {
  const f = fixture(), worker = f.store.create({ role: 'agent', goal: 'timeline' });
  try {
    const raw = { commit: 'PublicCommit', error: 'x'.repeat(50000) + '\nErrorTailNeedle', path: 'src/TimelineFile.js',
      nested: { allowed: 'AllowedMeta', hooks: { credential: 'SecretHookNeedle' } }, retry_profile: 'SecretProfileNeedle',
      auto_merge: { value: 'SecretMergeNeedle' }, management: { value: 'SecretManagerNeedle' } };
    const target = f.store.event(worker.id, 'merge.failed', raw);
    for (let i = 0; i < 125; i++) f.store.event(worker.id, 'progress.completed', { key: String(i) });
    for (const query of ['merge.failed','publiccommit','errortailneedle','allowedmeta','timelinefile.js','path']) {
      expect(scan(f.store, worker.id, query).map(event => event.id)).toEqual([target]);
    }
    for (const query of ['SecretHookNeedle','SecretProfileNeedle','SecretMergeNeedle','SecretManagerNeedle','retry_profile','auto_merge','management']) {
      expect(scan(f.store, worker.id, query)).toEqual([]);
    }
    const projection = projectHistoryEvent(f.store, worker.id, target);
    const remote = f.store.readingPage(worker.id, { before_event: target + 1, before_message: 0, limit: 1 }).events[0];
    expect(projection).toEqual(remote);
    expect(JSON.stringify(projection)).not.toContain('Secret');
    expect(projection.data.error.length).toBeLessThanOrEqual(2048); expect(projection.text_truncated).toBe(true);
    expect(projection.limitations).toContain('event_metadata_bounded');
    const local = previewHistoryEvent({ id: target, task_id: worker.id, type: 'merge.failed', created_at: remote.created_at, data: raw });
    expect(local.data).toEqual(remote.data); expect(local.reading_text).toBe(remote.reading_text); expect(local.total_chars).toBe(remote.total_chars);
    let offset = 0, text = '', part;
    do {
      part = f.store.readingRecord(worker.id, { kind: 'event', record_id: target, offset });
      expect(part.text.length).toBeLessThanOrEqual(24000); text += part.text; offset = part.next_offset;
    } while (part.has_more);
    expect(text).toContain('ErrorTailNeedle'); expect(text).not.toContain('Secret');
    expect(JSON.parse(text)).toMatchObject({ commit: 'PublicCommit', nested: { allowed: 'AllowedMeta' } });
    expect(JSON.parse(text).nested.hooks).toBeUndefined();
  } finally { await f.close(); }
});

test('structured answers remain authoritative text even when users use configuration-like field names', async () => {
  const f = fixture(), worker = f.store.create({ role: 'agent', goal: 'timeline' });
  try {
    const id = f.store.event(worker.id, 'notice.answered', { answer: { text: 'PublicAnswer', hooks: { secret: 'SecretAnswerNeedle' } } });
    expect(scan(f.store, worker.id, 'SecretAnswerNeedle').map(event => event.id)).toEqual([id]);
    const event = scan(f.store, worker.id, 'PublicAnswer')[0]; expect(event.id).toBe(id);
    const original = '{"text":"PublicAnswer","hooks":{"secret":"SecretAnswerNeedle"}}';
    expect(event.data.answer).toBe(original);
    expect(f.store.readingRecord(worker.id, { kind: 'event', record_id: id }).text).toBe(original);
  } finally { await f.close(); }
});
