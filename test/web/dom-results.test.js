import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { renderResults } from '../../src/ui/web/assets/render-results.js';

const run = (id, result) => ({ id, result, ended_at: `2026-09-${String(id).padStart(2, '0')}T12:00:00Z` });
const event = (id, result, runId = id) => ({ id, type: 'invocation.completed', data: { run_id: runId, result }, created_at: run(id, result).ended_at });

test('latest result is visible, previous results are lazy folds, repeated content stays distinct and redraw preserves expansion', () => {
  const dom = installDom();
  try {
    const task = { id: 1, result: '**latest**', runs: [run(1, 'same'), run(2, 'same'), run(3, '**latest**')] };
    const panel = renderResults(task, { events: [event(3, '**latest**')] });
    expect(deepText(panel)).toContain('latest'); expect(deepText(panel)).not.toContain('same');
    const history = panel.querySelector('.result-history'); expect(history.open).not.toBe(true);
    const entries = panel.querySelectorAll('.result-history-entry'); expect(entries).toHaveLength(2);
    entries[0].open = true; entries[0].listeners.toggle[0](); expect(deepText(entries[0])).toContain('same');
    expect(renderResults(task, { events: [event(3, '**latest**')] }, panel)).toBe(panel); expect(entries[0].open).toBe(true);
    const repeated = renderResults({ ...task, runs: [...task.runs, run(4, '**latest**')] }, { events: [event(4, '**latest**'), event(3, '**latest**')] }, panel);
    expect(repeated).not.toBe(panel); expect(repeated.querySelectorAll('.result-history-entry')).toHaveLength(3);
    expect(renderResults({ id: 1, result: null, runs: [run(1, 'retained after retry')] })).toBeTruthy();
    expect(renderResults({ id: 1, result: null, runs: [] })).toBeNull();
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
    const entries = panel.querySelectorAll('.result-history-entry'); expect(entries).toHaveLength(2);
    const older = [...entries].find(node => node.dataset.resultKey === 'run:1'); older.open = true; older.listeners.toggle[0]();
    expect(deepText(older)).toContain('<script>old</script>'); expect(panel.querySelector('script')).toBeNull();
    expect(older.dataset.ref).toBeTruthy(); expect(deepText(panel)).toContain('已读取全部结果历史');
  } finally { dom.restore(); }
});
