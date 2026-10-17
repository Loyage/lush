import { afterEach, expect, test } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { openTranscriptView, closeTranscriptView } from '../../src/ui/web/assets/transcript-view.js';
import { ui, transcriptCache } from '../../src/ui/web/assets/state.js';
import { createPerformanceView } from '../../src/ui/web/assets/performance-view.js';

const at = n => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
const task = { id: 71, worker_number: 'W71', status: 'completed', calls: 2, progress: { items: [
  { key: 'build', label: '实现 <img src=x onerror=alert(1)>', kind: 'step', work_ms: 6000, status: 'completed', started_at: at(20), completed_at: at(26) },
  { key: 'test', label: '专项测试', kind: 'step', work_ms: 3000, status: 'completed', started_at: at(26), completed_at: at(29) },
] } };
function fixture() {
  const reads = []; let intercept = null;
  const steps = [{ seq: 1, kind: 'tool', tool_name: 'bash', file: 'a', call_id: 'x', at: at(21), title: 'bash', body: '{"command":"echo safe"}' },
    { seq: 2, kind: 'result', file: 'a', call_id: 'x', at: at(28), body: 'done' }];
  const fetch = async (route, options) => {
    reads.push(String(route)); const url = new URL(String(route), 'http://test');
    const custom = intercept?.(url, options); if (custom) return custom;
    let data = {};
    if (url.pathname.endsWith('/71')) data = task;
    else if (url.pathname.endsWith('/runs-page')) { const old = url.searchParams.has('before'); data = { items: [{ id: old ? 1 : 2, task_id: 71, attempt: old ? 1 : 2,
      started_at: at(old ? 5 : 20), ended_at: at(old ? 10 : 30), status: 'completed' }], has_more: !old, cursor: old ? 1 : 2 }; }
    else if (url.pathname.endsWith('/reading-page')) data = { events: [{ id: 1, task_id: 71, type: 'worker.phase_changed', created_at: at(10), data: { version: 1, to: 'waiting_children', to_status: 'waiting' } },
      { id: 2, task_id: 71, type: 'invocation.started', created_at: at(20), data: { run_id: 2, call: 2 } }], has_more_events: false, event_cursor: 0 };
    else if (url.pathname.endsWith('/progress-history')) data = { items: [], has_more: false, cursor: null };
    else if (url.pathname.endsWith('/reading-record')) data = { text: '{"to":"waiting_children"}', has_more: false, next_offset: 25 };
    else if (url.pathname.includes('/transcript')) data = { steps, next: 2, oldest: 1, files: ['a'], has_more: false, has_older: false };
    return new Response(JSON.stringify(data));
  };
  return { reads, fetch, intercept: fn => { intercept = fn; } };
}
let dom;
afterEach(() => { closeTranscriptView(); transcriptCache.delete(71); ui.selected = null; dom?.restore(); dom = null; });

test('performance tab loads on demand, highlights longest stages and separates waiting/advanced tools, without executing labels', async () => {
  const f = fixture(); dom = installDom({ fetch: f.fetch }); ui.selected = 71;
  await openTranscriptView(71, undefined, { task });
  expect(f.reads.some(route => /reading-page|runs-page/.test(route))).toBe(false);
  await findByText(ui.transcriptView.panel, '性能分析').onclick();
  const root = ui.transcriptView.panel.querySelector('.performance-view');
  expect(ui.transcriptView.mode).toBe('performance'); expect(root.hidden).toBe(false);
  expect(deepText(root)).toContain('仅分析已读取范围'); expect(root.querySelector('.performance-advanced').open).not.toBe(true);
  expect(root.querySelector('.performance-stages').querySelector('strong').textContent).toContain('实现'); expect(root.querySelector('img')).toBeNull();
  expect(deepText(root.querySelector('.performance-waits'))).toContain('等待子 Worker');
  await findByText(root, '分析全部历史').onclick();
  expect(root.querySelector('.performance-status').textContent).toContain('当前采样范围已扫描完');
  expect(deepText(root.querySelector('.performance-summary'))).toContain('15 秒');
  const reads = f.reads.length, content = root.querySelector('.performance-stages').querySelector('strong'); root.scrollTop = 444; root.querySelector('.performance-advanced').open = true;
  await findByText(ui.transcriptView.panel, '执行记录').onclick();
  expect(root.hidden).toBe(true); await findByText(ui.transcriptView.panel, '性能分析').onclick();
  expect(f.reads.length).toBe(reads); expect(root.scrollTop).toBe(444); expect(root.querySelector('.performance-advanced').open).toBe(true);
  // Returning to a sampled tab preserves data; source evidence remains text, not executable HTML.
  expect(root.querySelector('.performance-stages').querySelector('strong').textContent).toBe(content.textContent);
  await root.querySelector('.performance-stages').querySelector('.performance-source').onclick();
  expect(deepText(root.querySelector('.performance-evidence'))).toContain('work_ms');
  await root.querySelector('.performance-waits').querySelector('.performance-source').onclick();
  expect(deepText(root.querySelector('.performance-evidence'))).toContain('waiting_children');
  await root.querySelector('.performance-tools').querySelector('.performance-source').onclick();
  expect(ui.transcriptView.mode).toBe('transcript'); expect(ui.transcriptView.holder.querySelector('[data-seq="1"]')).toBeTruthy();
});

for (const exit of ['switch', 'close', 'cancel']) test(`performance ${exit} aborts a scan and ignores late evidence`, async () => {
  const f = fixture(); dom = installDom({ fetch: f.fetch });
  await openTranscriptView(71, undefined, { task, mode: 'performance' });
  const root = ui.transcriptView.panel.querySelector('.performance-view'); let finish, signal;
  f.intercept((url, options) => url.pathname.endsWith('/runs-page') && url.searchParams.has('before') ? new Promise(resolve => {
    signal = options.signal; finish = () => resolve(new Response(JSON.stringify({ items: [], has_more: false, cursor: null })));
  }) : null);
  const scanning = findByText(root, '分析全部历史').onclick(); await until(() => Boolean(finish));
  if (exit === 'close') closeTranscriptView();
  else if (exit === 'switch') await findByText(ui.transcriptView.panel, '执行记录').onclick();
  else await findByText(root, '取消读取').onclick();
  const before = deepText(root); expect(signal.aborted).toBe(true); finish(); await scanning;
  expect(deepText(root)).toBe(before);
  if (exit === 'switch') { await findByText(ui.transcriptView.panel, '性能分析').onclick(); expect(deepText(root)).toContain('读取已暂停'); }
});

test('failed evidence never looks complete and can be retried; arrows include performance, Home returns records', async () => {
  const f = fixture(); let failing = true;
  f.intercept(url => failing && url.pathname.endsWith('/reading-page') ? Promise.resolve(new Response(JSON.stringify({ error: 'offline' }), { status: 503 })) : null);
  dom = installDom({ fetch: f.fetch }); await openTranscriptView(71, undefined, { task });
  const tabs = ui.transcriptView.panel.querySelectorAll('[role="tab"]'); expect(tabs.map(tab => tab.textContent)).toEqual(['执行记录', '代码与改动', '性能分析']);
  tabs[0].onkeydown({ key: 'End', preventDefault() {} });
  await until(() => ui.transcriptView.panel.querySelector('.performance-status')?.textContent.includes('offline'));
  const root = ui.transcriptView.panel.querySelector('.performance-view'); expect(deepText(root)).toContain('未读全');
  failing = false; await findByText(root, '分析全部历史').onclick(); expect(deepText(root)).toContain('当前采样范围已扫描完');
  tabs[2].onkeydown({ key: 'Home', preventDefault() {} }); await until(() => ui.transcriptView.mode === 'transcript'); expect(dom.document.activeElement).toBe(tabs[0]);
});

test('constructing an inactive analysis never reads any project or starts a timer', async () => {
  const f = fixture(); dom = installDom({ fetch: f.fetch }); const view = createPerformanceView(71);
  expect(f.reads).toHaveLength(0); expect(dom.intervals).toHaveLength(0); view.dispose(); await view.setActive(true); expect(f.reads).toHaveLength(0);
});
