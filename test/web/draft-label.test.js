import { test, expect } from 'bun:test';
import { draftLabel } from '../../src/ui/web/assets/draft-label.js';
import { emissionAcknowledgement } from '../../src/ui/web/assets/emission-form.js';

test('draft display labels use only an explicit valid number, with legacy internal identities clearly distinguished', () => {
  expect(draftLabel({ id: 90, draft_number: 1 })).toBe('草稿 #1');
  for (const draft_number of [null, undefined, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])
    expect(draftLabel({ id: 90, draft_number })).toBe('草稿记录 #90');
  expect(draftLabel({ draft_id: 90, draft_number: 7 })).toBe('草稿 #7');
  expect(draftLabel({ draft_id: 90, draft_number: null })).toBe('草稿记录 #90');
  expect(draftLabel({})).toBe('草稿记录（编号未知）');
  expect(emissionAcknowledgement({ draft_id: 90, draft_number: 7 })).toContain('草稿 #7');
  expect(emissionAcknowledgement({ draft_id: 90, draft_number: 7 })).not.toContain('草稿 #90');
  expect(emissionAcknowledgement({ draft_id: 90, draft_number: null })).toContain('草稿记录 #90');
  expect(emissionAcknowledgement({ draft_id: 90, draft_number: 7 }, true, true)).toContain('首条工作指令 · 草稿 #7');
  expect(emissionAcknowledgement({ draft_id: 90, draft_number: null }, true, true)).toContain('草稿记录 #90');
  expect(emissionAcknowledgement({ draft_id: 90, draft_number: 7, dispatch: { input_id: 2 } }, true, true)).toContain('原始输入 O2');
});
