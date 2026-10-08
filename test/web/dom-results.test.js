import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { renderResults } from '../../src/ui/web/assets/render-results.js';

const run = (id, result) => ({ id, result, ended_at: `2026-09-${String(id).padStart(2, '0')}T12:00:00Z` });
const event = (id, result, runId = id) => ({ id, type: 'invocation.completed', data: { run_id: runId, result }, created_at: run(id, result).ended_at });

test('previous results are visible newest first without nested folds; repeated content and manual collapse are preserved', () => {
  const dom = installDom();
  try {
    const task = { id: 1, result: '**latest**', runs: [run(1, 'same'), run(2, 'same'), run(3, '**latest**')] };
    const panel = renderResults(task, { events: [event(3, '**latest**')] });
    expect(deepText(panel)).toContain('latest'); expect(deepText(panel)).toContain('same');
    const history = panel.querySelector('.result-history'); expect(history.open).toBe(true);
    const entries = panel.querySelectorAll('.result-history-entry');
    expect(entries.map(node => node.dataset.resultKey)).toEqual(['run:2', 'run:1']);
    expect(panel.querySelectorAll('details')).toHaveLength(1);
    for (const entry of entries) {
      expect(entry.tagName).toBe('DIV'); expect(entry.querySelector('summary')).toBeNull();
      expect(deepText(entry)).toContain('same'); expect(entry.querySelector('.result-history-time')).toBeTruthy();
    }
    expect(renderResults(task, { events: [event(3, '**latest**')] }, panel)).toBe(panel);
    expect(panel.querySelectorAll('.result-history-entry')[0]).toBe(entries[0]);
    history.open = false;
    const repeated = renderResults({ ...task, runs: [...task.runs, run(4, '**latest**')] }, { events: [event(4, '**latest**'), event(3, '**latest**')] }, panel);
    expect(repeated).not.toBe(panel);
    expect(repeated.querySelectorAll('.result-history-entry').map(node => node.dataset.resultKey)).toEqual(['run:3', 'run:2', 'run:1']);
    expect(repeated.querySelector('.result-history').open).toBe(false);
    expect(deepText(repeated.querySelector('.result-history-entry'))).toContain('latest');
    expect(renderResults({ id: 1, result: null, runs: [run(1, 'retained after retry')] })).toBeTruthy();
    expect(renderResults({ id: 1, result: null, runs: [] })).toBeNull();
  } finally { dom.restore(); }
});

test('previous results sort by time descending, using invocation identity for equal timestamps', () => {
  const dom = installDom();
  try {
    const panel = renderResults({ id: 1, result: null, runs: [
      run(9, 'oldest'), { ...run(1, 'middle'), ended_at: run(10).ended_at },
      { ...run(2, 'newest'), ended_at: run(10).ended_at },
    ] });
    expect(panel.querySelectorAll('.result-history-entry').map(node => node.dataset.resultKey)).toEqual(['run:2', 'run:1', 'run:9']);
    expect(panel.querySelector('.result-history').open).toBe(true);
  } finally { dom.restore(); }
});

test('history pagination recovers results outside bounded runs, deduplicates by invocation and retries failed pages', async () => {
  const requests = []; let attempts = 0;
  const dom = installDom({ fetch: async url => {
    requests.push(String(url)); attempts++;
    if (attempts === 1) return new Response(JSON.stringify({ error: 'offline' }), { status: 500 });
    if (String(url).includes('/history?')) return new Response(JSON.stringify({ error: 'offline' }), { status: 500 });
    return new Response(JSON.stringify({ events: [event(1, '<script>old</script>'), event(2, 'older')], cursor: 1, truncated: false }));
  } });
  try {
    const panel = renderResults({ id: 7, result: 'latest', runs: [run(2, 'older')] }, { events: [event(3, 'latest')], cursor: 50, truncated: true });
    await findByText(panel, '加载更早结果').onclick(); expect(deepText(panel)).toContain('offline');
    await findByText(panel, '加载更早结果').onclick();
    expect(requests.filter(url => url.includes('before=50'))).toHaveLength(2);
    const entries = panel.querySelectorAll('.result-history-entry');
    expect(entries.map(node => node.dataset.resultKey)).toEqual(['run:2', 'run:1']);
    expect(panel.querySelector('.result-history').open).toBe(true);
    const older = entries[1];
    expect(deepText(older)).toContain('<script>old</script>'); expect(panel.querySelector('script')).toBeNull();
    expect(older.dataset.ref).toBeTruthy(); expect(deepText(panel)).toContain('已读取全部结果历史');
  } finally { dom.restore(); }
});
