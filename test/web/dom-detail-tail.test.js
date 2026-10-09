import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';
const json = value => ({ ok: true, json: async () => value });
const bad = () => ({ ok: false, json: async () => ({ error: 'usage unavailable' }) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const drain = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
let handler, status, requests;
const dom = installDom({ fetch: (url, options = {}) => {
  url = String(url); requests.push({ url, options });
  return handler?.(url, options) ?? json(url === '/api/worker/7'
    ? { id: 7, worker_number: 'W159-3', role: 'agent', task_kind: 'order', status, calls: 1, goal: '尾读回归', result: '结果',
      created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' }
    : url.endsWith('/connections') ? { connections: [] } : url.endsWith('/usage') ? { files: [] } : { events: [] });
} });
const { ui, resetUiState, transcriptOpen, transcriptCache } = await import('../../src/ui/web/assets/state.js');
const { loadDetail, disposeDetailRequests } = await import('../../src/ui/web/assets/detail.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { liveTick } = await import('../../src/ui/web/assets/live.js');
const { writePref } = await import('../../src/ui/web/assets/prefs.js');
const tails = () => requests.filter(row => row.url.includes('/transcript'));
const cache = (extra = {}) => {
  const value = { steps: [], next: 0, order: 'asc', settled: false, ...extra };
  transcriptOpen.add(7); transcriptCache.set(7, value); return value;
};
beforeEach(() => {
  disposeDetailRequests(); resetUiState(); dom.node('detail').replaceChildren(); delete dom.node('detail').dataset.taskId;
  dom.document.activeElement = null; dom.location.pathname = '/'; status = 'completed'; handler = null; requests = [];
  writePref('transcriptOrder', 'asc');
});
afterAll(() => { disposeDetailRequests(); resetUiState(); writePref('transcriptOrder', 'desc'); dom.restore(); });

test('asc 终态尾记录逐页继续，只有成功接受 !has_more 的最终页才 settled；usage 失败不阻断', async () => {
  const state = cache();
  handler = url => url.endsWith('/usage') ? bad() : url.includes('/transcript?') ? (() => {
    const after = Number(new URL(url, 'http://fixture').searchParams.get('after'));
    return json({ steps: [{ seq: after + 1, kind: 'text', body: `记录 ${after + 1}` }], next: after + 1, has_more: after < 2 });
  })() : null;
  for (let i = 1; i <= 3; i++) {
    expect(await loadDetail(7)).toBe(true); await drain();
    expect(state.next).toBe(i); expect(state.steps).toHaveLength(i); expect(state.settled).toBe(i === 3);
    expect(state.has_more).toBe(i < 3);
  }
  await loadDetail(7); await drain(); expect(tails()).toHaveLength(3);
});

test('首次打开的已有阅读器独立于失败的 usage；初始窗口有更多历史时不能提前 settled', async () => {
  transcriptOpen.add(7);
  handler = url => url.endsWith('/usage') ? bad() : url.includes('/transcript?') ? (() => {
    const after = Number(new URL(url, 'http://fixture').searchParams.get('after'));
    return json({ steps: [{ seq: after + 1, kind: 'text', body: `初始 ${after + 1}` }], next: after + 1, files: ['session'], has_more: after < 2 });
  })() : null;
  await loadDetail(7); await drain();
  const state = transcriptCache.get(7); expect(state.error).toBeUndefined(); expect(state.next).toBe(2);
  expect(state.steps.map(step => step.seq)).toEqual([1, 2]); expect(state.settled).toBe(false);
  await loadDetail(7); await drain(); expect(state.next).toBe(3); expect(state.settled).toBe(true);
});

test('detail 与 liveTick 并发时丢弃旧游标响应，不能伪造 settled 或重复追加', async () => {
  const state = cache({ next: 1 }), delayed = deferred();
  handler = url => url.includes('/transcript?') ? delayed.promise : null;
  await loadDetail(7); await drain(); expect(tails()).toHaveLength(1);
  await liveTick({ task: { id: 7, status: 'running' }, transcript: state, current: () => true,
    fetchUsage: async () => null, fetchTranscript: async () => ({ steps: [{ seq: 2, kind: 'text', body: 'live 已读' }], next: 2, has_more: false }) });
  delayed.resolve(json({ steps: [{ seq: 2, kind: 'text', body: 'detail 过期' }], next: 2, has_more: false })); await drain();
  expect(state.steps.map(step => step.body)).toEqual(['live 已读']); expect(state.next).toBe(2); expect(state.settled).toBe(false);
  handler = url => url.includes('/transcript?') ? json({ steps: [], next: 2, has_more: false }) : null;
  await loadDetail(7); await drain(); expect(tails().at(-1).url).toContain('after=2'); expect(state.settled).toBe(true);
});

test('详情尾读与父侧 liveTick 一致：重复/旧服务端记录只追加一次，游标不因滞后 page.next 回退', async () => {
  const state = cache({ next: 1, steps: [{ seq: 1, body: '已有' }] });
  handler = url => url.includes('/transcript?') ? json({ steps: [{ seq: 1, body: '重复旧记录' },
    { seq: 2, body: '新记录' }, { seq: 2, body: '重复新记录' }], next: 0, has_more: false }) : null;
  await loadDetail(7); await drain();
  expect(state.steps.map(step => step.body)).toEqual(['已有', '新记录']); expect(state.next).toBe(2); expect(state.settled).toBe(true);
});

for (const change of ['cache', 'order', 'closed', 'page']) test(`终态尾读在 ${change} 身份变化后不能标记旧缓存 settled`, async () => {
  const state = cache({ next: 1 }), delayed = deferred();
  handler = url => url.includes('/transcript?') ? delayed.promise : null;
  await loadDetail(7); await drain();
  if (change === 'cache') transcriptCache.set(7, { ...state, steps: [] });
  if (change === 'order') state.order = 'desc';
  if (change === 'closed') transcriptOpen.delete(7);
  if (change === 'page') activateDetailView({ view: 'settings' });
  delayed.resolve(json({ steps: [{ seq: 2, body: '迟到' }], next: 2, has_more: false })); await drain();
  expect(state.settled).toBe(false); expect(state.steps).toEqual([]); expect(state.next).toBe(1);
});

for (const ending of ['completed', 'failed', 'paused', 'awaiting_acceptance']) test(`${ending} 非 liveTarget 状态必须收尾（不受 HOT 更大集合或 usage 失败影响）`, async () => {
  status = ending; const state = cache();
  handler = url => url.endsWith('/usage') ? bad() : url.includes('/transcript?') ? json({ steps: [{ seq: 1, body: '最终记录' }], next: 1, has_more: false }) : null;
  await loadDetail(7); await drain(); expect(tails()).toHaveLength(1); expect(state.next).toBe(1); expect(state.settled).toBe(true);
});

for (const running of ['running', 'awaiting', 'waiting', 'queued']) test(`${running} liveTarget 保持未 settled，增量读取仍交给 live 路径`, async () => {
  status = running; const state = cache({ settled: true });
  await loadDetail(7); await drain(); expect(tails()).toHaveLength(0); expect(state.settled).toBe(false);
});

test('尾读失败可重试；desc 增量收尾不改向旧翻页边界', async () => {
  writePref('transcriptOrder', 'desc'); const state = cache({ order: 'desc', has_older: true, oldest: 1, next: 10 });
  handler = url => url.includes('/transcript-latest') ? bad() : null;
  await loadDetail(7); await drain(); expect(state.settled).toBe(false); expect(state.next).toBe(10);
  handler = url => url.includes('/transcript-latest') ? json({ steps: [{ seq: 11, body: '尾部' }], next: 11, has_older: false }) : null;
  await loadDetail(7); await drain(); expect(state.settled).toBe(true); expect(state.next).toBe(11);
  expect(state.has_older).toBe(true); expect(state.oldest).toBe(1);
});
