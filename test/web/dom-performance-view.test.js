import { afterEach, expect, test } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { transcriptShell } from '../../src/core/transcript-shell.js';
import { openTranscriptView, closeTranscriptView } from '../../src/ui/web/assets/transcript-view.js';
import { ui, transcriptCache } from '../../src/ui/web/assets/state.js';
import { createPerformanceView } from '../../src/ui/web/assets/performance-view.js';

const at = n => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
const task = { id: 71, worker_number: 'W71', status: 'completed', calls: 2, progress: { items: [{ key: 'wrong', label: '不要展示的计划', work_ms: 999999 }] } };
function fixture() {
  const reads = []; let intercept = null;
  const steps = [];
  for (const [seq, command, timeout, start, end, failed] of [
    [1, 'bun run test test/slow.test.js', 20, 0, 8, true], [3, 'bun run test test/slow.test.js', 20, 10, 16, true],
    [5, 'bun run test test/slow.test.js', 20, 20, 22, false], [7, 'bun run build', 20, 25, 36, false],
    [9, 'bun run test test/slow.test.js', 30, 37, 40, true],
  ]) {
    const call = { seq, kind: 'tool', tool_name: 'bash', title: 'bash', file: 'a', call_id: `x${seq}`, at: at(start), body: JSON.stringify({ command, timeout }) };
    call.shell = transcriptShell(call); steps.push(call, { seq: seq + 1, kind: 'result', file: 'a', call_id: call.call_id, at: at(end), body: failed ? 'failure output' : 'success output', is_error: failed, error_known: true });
  }
  steps.push({ seq: 11, kind: 'tool', tool_name: 'read', file: 'a', call_id: 'read', at: at(41), body: '{"path":"not-a-shell-command"}' },
    { seq: 12, kind: 'result', file: 'a', call_id: 'read', at: at(42), body: 'read failed', is_error: true, error_known: true });
  const fetch = async (route, options) => {
    reads.push(String(route)); const url = new URL(String(route), 'http://test');
    const custom = intercept?.(url, options); if (custom) return custom;
    let data = {};
    if (url.pathname.endsWith('/71')) data = task;
    else if (url.pathname.endsWith('/transcript-search')) {
      const after = Number(url.searchParams.get('after')); data = { steps: after ? steps.slice(4) : steps.slice(0, 4), next: after ? 12 : 4, files: ['a'], has_more: !after };
    } else if (url.pathname.includes('/transcript')) data = { steps, next: 12, oldest: 1, files: ['a'], has_more: false, has_older: false };
    return new Response(JSON.stringify(data));
  };
  return { reads, fetch, steps, intercept: fn => { intercept = fn; } };
}
let dom;
afterEach(() => { closeTranscriptView(); transcriptCache.delete(71); ui.selected = null; dom?.restore(); dom = null; });

test('Shell analysis prioritizes slow actual commands and repeated failures, supports both sorts and original output navigation', async () => {
  const f = fixture(); dom = installDom({ fetch: f.fetch }); ui.selected = 71;
  await openTranscriptView(71, undefined, { task });
  expect(f.reads.some(route => /transcript-search|reading-page|runs-page/.test(route))).toBe(false);
  await findByText(ui.transcriptView.panel, '性能分析').onclick();
  const root = ui.transcriptView.panel.querySelector('.performance-view');
  expect(ui.transcriptView.mode).toBe('performance'); expect(deepText(root)).toContain('仅分析已读取范围');
  expect(root.querySelector('.performance-advanced').open).not.toBe(true); expect(deepText(root)).not.toContain('不要展示的计划');
  expect(f.reads.some(route => /reading-page|runs-page|progress-history/.test(route))).toBe(false);
  expect(root.querySelector('.performance-retries').querySelectorAll('.performance-command-row')).toHaveLength(1);
  await findByText(root, '分析全部历史').onclick();
  expect(root.querySelector('.performance-status').textContent).toContain('当前采样范围已扫描完');
  const slow = root.querySelector('.performance-slow'), retries = root.querySelector('.performance-retries');
  expect(slow.querySelectorAll('.performance-command-row')).toHaveLength(3);
  expect(slow.querySelector('.performance-command').textContent).toBe('bun run build');
  expect(retries.querySelectorAll('.performance-command-row')).toHaveLength(1);
  expect(deepText(retries)).toContain('明确成功'); expect(deepText(retries)).toContain('14 秒');
  const order = root.querySelector('[aria-label="慢指令排序"]'); order.value = 'total_ms'; order.onchange();
  expect(slow.querySelector('.performance-command').textContent).toBe('bun run test test/slow.test.js');
  const row = slow.querySelector('.performance-command-row'); expect(deepText(row)).toContain('{"timeout":20}');
  const before = f.reads.length, first = row.querySelector('.performance-command'); root.scrollTop = 444;
  await findByText(ui.transcriptView.panel, '执行记录').onclick(); await findByText(ui.transcriptView.panel, '性能分析').onclick();
  expect(f.reads).toHaveLength(before); expect(root.scrollTop).toBe(444); expect(slow.querySelector('.performance-command')).toBe(first); expect(order.value).toBe('total_ms');
  const attempts = row.querySelector('.performance-attempts'); attempts.open = true;
  expect(attempts.querySelectorAll('.performance-attempt').map(node => node.dataset.attemptSeq)).toEqual(['1', '3', '5']);
  expect(deepText(attempts)).toContain('明确失败'); expect(deepText(attempts)).toContain('明确成功');
  await attempts.querySelector('.performance-source').onclick();
  expect(ui.transcriptView.mode).toBe('transcript'); expect(ui.transcriptView.holder.querySelector('[data-seq="1"]')).toBeTruthy();
  expect(deepText(ui.transcriptView.holder)).toContain('failure output');
});

for (const exit of ['switch', 'close', 'cancel']) test(`Shell ${exit} aborts a full scan and ignores late evidence`, async () => {
  const f = fixture(); dom = installDom({ fetch: f.fetch }); await openTranscriptView(71, undefined, { task, mode: 'performance' });
  const root = ui.transcriptView.panel.querySelector('.performance-view'); let finish, signal;
  f.intercept((url, options) => url.pathname.endsWith('/transcript-search') && Number(url.searchParams.get('after')) > 0 ? new Promise(resolve => {
    signal = options.signal; finish = () => resolve(new Response(JSON.stringify({ steps: [], has_more: false, next: 4 })));
  }) : null);
  const scanning = findByText(root, '分析全部历史').onclick(); await until(() => Boolean(finish));
  if (exit === 'close') closeTranscriptView(); else if (exit === 'switch') await findByText(ui.transcriptView.panel, '执行记录').onclick(); else await findByText(root, '取消读取').onclick();
  const before = deepText(root); expect(signal.aborted).toBe(true); finish(); await scanning; expect(deepText(root)).toBe(before);
  if (exit === 'switch') { await findByText(ui.transcriptView.panel, '性能分析').onclick(); expect(deepText(root)).toContain('读取已暂停'); }
});

test('failed scans retry without pretending completeness; keyboard includes performance and preserves records navigation', async () => {
  const f = fixture(); let failing = true;
  f.intercept(url => failing && url.pathname.endsWith('/transcript-search') ? Promise.resolve(new Response(JSON.stringify({ error: 'offline' }), { status: 503 })) : null);
  dom = installDom({ fetch: f.fetch }); await openTranscriptView(71, undefined, { task });
  const tabs = ui.transcriptView.panel.querySelectorAll('[role="tab"]'); expect(tabs.map(tab => tab.textContent)).toEqual(['执行记录', '代码与改动', '性能分析']);
  tabs[0].onkeydown({ key: 'End', preventDefault() {} }); await until(() => ui.transcriptView.panel.querySelector('.performance-status')?.textContent.includes('offline'));
  const root = ui.transcriptView.panel.querySelector('.performance-view'); expect(deepText(root)).toContain('尚非全部历史');
  failing = false; await findByText(root, '分析全部历史').onclick(); expect(deepText(root)).toContain('当前采样范围已扫描完');
  tabs[2].onkeydown({ key: 'Home', preventDefault() {} }); await until(() => ui.transcriptView.mode === 'transcript'); expect(dom.document.activeElement).toBe(tabs[0]);
});

test('long/malicious command previews are text; absent results and unverified identities never become repeated failures', async () => {
  const f = fixture(), command = '<img src=x onerror=alert(1)>\n' + 'x'.repeat(500), call = { ...f.steps[0], shell: { command, identity_complete: false } };
  f.intercept(url => url.pathname.endsWith('/transcript-search') ? Promise.resolve(new Response(JSON.stringify({ steps: [call], has_more: false, next: 1 }))) : null);
  dom = installDom({ fetch: f.fetch }); await openTranscriptView(71, undefined, { task, mode: 'performance' });
  const root = ui.transcriptView.panel.querySelector('.performance-view'); expect(root.querySelector('img')).toBeNull();
  expect(deepText(root)).toContain('完整参数身份不可核验'); expect(deepText(root)).toContain('结果未知');
  expect(root.querySelector('.performance-retries').querySelector('.performance-command-row')).toBeNull();
  await findByText(root, '展开命令预览').onclick(); expect(root.querySelector('.performance-command').textContent).toBe(command);
});

test('constructing inactive Shell analysis never reads a project or starts a timer', async () => {
  const f = fixture(); dom = installDom({ fetch: f.fetch }); const view = createPerformanceView(71);
  expect(f.reads).toHaveLength(0); expect(dom.intervals).toHaveLength(0); view.dispose(); await view.setActive(true); expect(f.reads).toHaveLength(0);
});
