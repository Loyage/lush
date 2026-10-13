import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { transcriptContent, transcriptMatch, appendTranscriptSteps } from '../../src/ui/web/assets/render-transcript.js';
import { transcriptCache, ui } from '../../src/ui/web/assets/state.js';
import { resetTranscriptReaders } from '../../src/ui/web/assets/transcript-reader.js';

const call = { seq: 1, kind: 'tool', file: 'a', call_id: 'x', title: 'bash', body: '{"command":"echo ok"}',
  at: '2026-01-01T00:00:00Z', model_duration_ms: 2500 };
const result = { seq: 2, kind: 'result', file: 'a', call_id: 'x', body: 'ok', at: '2026-01-01T00:00:01.250Z' };
const fixture = (taskId, steps, order = 'desc', extra = {}) => {
  ui.selected = taskId;
  transcriptCache.set(taskId, { steps, order, files: ['a'], next: steps.at(-1).seq, oldest: steps[0].seq, ...extra });
  const holder = document.createElement('div'); holder.className = 'transcript';
  holder.append(...transcriptContent(taskId)); document.getElementById('detail').append(holder);
  return holder;
};
const cleanup = taskId => { transcriptCache.delete(taskId); ui.selected = null; resetTranscriptReaders(); ui.stepToggle.clear(); };

test('tool/model duration metadata is visible, shared by reply parts, and reused in search matches', () => {
  const dom = installDom(), taskId = 970;
  try {
    const holder = fixture(taskId, [call, result, { seq: 3, kind: 'thinking', body: 'think', model_duration_ms: 2500 },
      { seq: 4, kind: 'text', body: 'answer', model_duration_ms: 2500 }, { seq: 5, kind: 'text', body: 'legacy' }]);
    expect(holder.querySelector('.step-duration').textContent).toBe('工具用时 ≈ 1.3 秒（估算）');
    expect([...holder.querySelectorAll('.step-model-duration')].map(node => node.textContent)).toEqual([
      '模型回复用时未知', ...Array(3).fill('模型回复用时 ≈ 2.5 秒（估算）'),
    ]);
    const match = transcriptMatch(taskId, result, [call]);
    expect(match.querySelector('.step-duration').textContent).toBe('工具用时 ≈ 1.3 秒（估算）');
    expect(match.querySelector('.step-model-duration').dataset.help).toContain('不能相加');
    expect(match.querySelector('.step-duration').dataset.help).toContain('不是精确执行计时');
    expect(deepText(match)).toContain('ok');
  } finally { cleanup(taskId); dom.restore(); }
});

test('live pairing updates only metadata, keeps node/focus/fold state, and revokes ambiguous estimates', () => {
  for (const order of ['asc', 'desc']) {
    const dom = installDom(), taskId = 971;
    try {
      const steps = [{ ...call }], holder = fixture(taskId, steps, order);
      const item = holder.querySelector('.step'), head = item.querySelector('.step-head');
      const chip = item.querySelector('.step-duration'), body = item.querySelector('.step-body');
      expect(chip.textContent).toBe('工具用时未知');
      head.onclick(); head.focus(); holder.scrollTop = 240;
      steps.push(result); appendTranscriptSteps(taskId, [result]);
      expect(holder.querySelector('.step')).toBe(item); expect(item.querySelector('.step-duration')).toBe(chip);
      expect(item.querySelector('.step-body')).toBe(body); expect(item.classList.contains('open')).toBe(false);
      expect(document.activeElement).toBe(head); expect(holder.scrollTop).toBe(240);
      expect(chip.textContent).toBe('工具用时 ≈ 1.3 秒（估算）');
      const duplicate = { ...call, seq: 3 };
      steps.push(duplicate); appendTranscriptSteps(taskId, [duplicate]);
      expect(chip.textContent).toBe('工具用时未知');
      expect([...holder.querySelectorAll('.step-duration')].every(node => node.textContent === '工具用时未知')).toBe(true);
    } finally { cleanup(taskId); dom.restore(); }
  }
});

test('loading the call from an older page replaces standalone unknown timing with the paired interval', async () => {
  const taskId = 972, dom = installDom({ fetch: async () => Response.json({
    steps: [call], oldest: 1, next: 1, has_older: false, files: ['a'],
  }) });
  try {
    const holder = fixture(taskId, [result], 'desc', { has_older: true });
    expect(holder.querySelector('.step-duration').textContent).toBe('工具用时未知');
    await holder.querySelector('[data-live="transcript-older"]').onclick();
    expect(holder.querySelectorAll('.step')).toHaveLength(1);
    expect(holder.querySelector('.step').dataset.seq).toBe('1');
    expect(holder.querySelector('.step-duration').textContent).toBe('工具用时 ≈ 1.3 秒（估算）');
    expect(holder.querySelector('[data-result-seq="2"]')).toBeTruthy();
  } finally { cleanup(taskId); dom.restore(); }
});

test('missing clocks, mismatched sessions, duplicate results and reversed clocks never show zero seconds', () => {
  const dom = installDom(), taskId = 973;
  try {
    for (const output of [{ ...result, at: undefined }, { ...result, file: 'b' },
      { ...result, at: '2025-12-31T23:59:59Z' }]) {
      const match = transcriptMatch(taskId, call, [output]);
      expect(match.querySelector('.step-duration').textContent).toBe('工具用时未知');
    }
    const match = transcriptMatch(taskId, call, [result, { ...result, seq: 3 }]);
    expect(match.querySelector('.step-duration').textContent).toBe('工具用时未知');
    expect(transcriptMatch(taskId, { ...call, model_duration_ms: -1 }).querySelector('.step-model-duration').textContent).toBe('模型回复用时未知');
  } finally { cleanup(taskId); dom.restore(); }
});
