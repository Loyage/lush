import { test, expect, afterAll, afterEach } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
const dom = installDom();
const { createDiagnosticsController, renderDiagnosticsCard, validateDiagnostics, diagnosticsRate, diagnosticsTrend } = await import('../../src/ui/web/assets/dashboard-diagnostics.js');
const { readDashboardConfig } = await import('../../src/ui/web/assets/dashboard-cards.js');
const { setPref } = await import('../../src/ui/web/assets/prefs.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const controllers = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); closeDialog(); dom.document.visibilityState = 'visible'; dom.node('detail').replaceChildren(); });
afterAll(() => dom.restore());
const snapshot = () => ({ version: 1, generated_at: '2026-10-12T12:00:00Z', currency: 'USD', estimated: true,
  windows: [60, 300].map(seconds => ({ seconds, input: 600, output: 120, cost: 0.1, requests: 2, input_per_second: 10, output_per_second: 2, cost_per_minute: 0.1,
    unknown_tokens: 0, unknown_cost: 0, complete: true })),
  buckets: Array.from({ length: 60 }, (_, i) => ({ at: new Date(Date.parse('2026-10-12T11:50:00Z') + i * 10000).toISOString(), input: i * 10, output: i, cost: i / 1000, unknown_tokens: 0, unknown_cost: 0 })),
  coverage: { projects_total: 1, projects_online: 1, projects_reporting: 1, complete: true },
  projects: [{ id: 'aaaaaaaaaaaaaaaa', name: '项目A', state: 'online', generated_at: '2026-10-12T12:00:00Z' }] });
function fixture(request = async () => snapshot()) {
  const scheduled = new Map(); let serial = 0, current = true, changes = 0;
  const timers = { setTimeout(fn, ms) { scheduled.set(++serial, { fn, ms }); return serial; }, clearTimeout(id) { scheduled.delete(id); } };
  const controller = createDiagnosticsController({ ownsPage: () => current, request, timers, onChange: () => { changes++; } }); controllers.push(controller);
  return { controller, scheduled, changes: () => changes, leave: () => { current = false; }, tick: async () => { const [id, value] = [...scheduled][0]; scheduled.delete(id); value.fn(); await controller.refresh(); } };
}
const visibility = state => { dom.document.visibilityState = state; for (const fn of dom.documentListeners.visibilitychange || []) fn(); };
test('polling only while enabled/visible, device preference reschedule, manual read coalescing and destroy cleanup', async () => {
  const calls = [], f = fixture(async (url, options) => { calls.push({ url, options }); return snapshot(); });
  setPref('polling', 'standard'); await f.controller.refresh(); expect(calls).toHaveLength(0); expect(f.scheduled.size).toBe(0);
  f.controller.setEnabled(true); await f.controller.refresh(); expect(calls.map(call => call.url)).toEqual(['/api/host/diagnostics']);
  expect([...f.scheduled.values()][0].ms).toBe(10000);
  setPref('polling', 'power'); expect([...f.scheduled.values()][0].ms).toBe(30000); await f.tick(); expect(calls).toHaveLength(2);
  visibility('hidden'); expect(f.scheduled.size).toBe(0); await f.controller.refresh(); expect(calls).toHaveLength(2);
  visibility('visible'); await f.controller.refresh(); expect(calls).toHaveLength(3);
  f.controller.setEnabled(false); expect(f.scheduled.size).toBe(0); await f.controller.refresh(); expect(calls).toHaveLength(3);
  f.controller.setEnabled(true); await f.controller.refresh(); f.controller.dispose(); expect(f.scheduled.size).toBe(0);
  setPref('polling', 'fast'); visibility('visible'); expect(f.scheduled.size).toBe(0); expect(calls).toHaveLength(4);
});
test('hidden/re-enabled late snapshot cannot overwrite newer generation and remains physically single flight', async () => {
  const resolvers = [], signals = [], f = fixture((_, options) => { signals.push(options.signal); return new Promise(resolve => resolvers.push(resolve)); });
  f.controller.setEnabled(true); const first = f.controller.refresh(); expect(f.controller.refresh()).toBe(first); await Promise.resolve();
  expect(resolvers).toHaveLength(1); visibility('hidden'); expect(signals[0].aborted).toBe(true); visibility('visible');
  expect(f.controller.refresh()).toBe(first); const late = snapshot(); late.generated_at = '2026-10-12T10:00:00Z'; resolvers[0](late); await first;
  expect(f.controller.state().snapshot).toBeNull(); await Promise.resolve(); expect(resolvers).toHaveLength(2);
  resolvers[1](snapshot()); await f.controller.refresh(); expect(f.controller.state().snapshot.generated_at).toBe('2026-10-12T12:00:00Z');
});
test('departure and pagehide cancel pending work and do not apply late data or restart timer', async () => {
  let resolve; const f = fixture(() => new Promise(done => { resolve = done; })); f.controller.setEnabled(true); const pending = f.controller.refresh(); await Promise.resolve();
  f.leave(); resolve(snapshot()); await pending; expect(f.controller.state().snapshot).toBeNull(); expect(f.scheduled.size).toBe(0);
  const second = fixture(); second.controller.setEnabled(true); await second.controller.refresh(); await dom.fire('pagehide', { persisted: true });
  expect(second.scheduled.size).toBe(0); await second.controller.refresh(); await dom.fire('pageshow'); await second.controller.refresh(); expect(second.scheduled.size).toBe(1);
});
test('rates/trends show unknown, independent scales and missing cost without inventing zero; malformed snapshot rejected', () => {
  const data = snapshot(); data.windows[0].unknown_cost = 1; data.windows[0].complete = false;
  data.windows[0].cost_per_minute = 0; data.buckets[1].unknown_cost = 1; data.buckets[2].unknown_tokens = 1;
  expect(diagnosticsRate(data.windows[0], 'cost', data.coverage)).toBe('未知'); expect(diagnosticsRate(data.windows[0], 'input', data.coverage)).toBe('≥10');
  expect(diagnosticsTrend(data, 'cost')[1]).toBeNull(); expect(diagnosticsTrend(data, 'input')[2]).toBeNull(); expect(diagnosticsTrend(data, 'output')[3]).toBeCloseTo(0.3);
  data.coverage.projects_reporting = 0; expect(diagnosticsRate(data.windows[1], 'input', data.coverage)).toBe('未知'); expect(diagnosticsTrend(data, 'input').every(value => value === null)).toBe(true);
  for (const invalid of [{}, { ...snapshot(), estimated: false }, { ...snapshot(), buckets: [] }, { ...snapshot(), coverage: {} }]) expect(() => validateDiagnostics(invalid)).toThrow('响应无效');
});
test('card keeps controls, focus, LI and geometry through reads/resizes; small card summary and complete details', async () => {
  let state = { snapshot: snapshot(), error: null, pending: false }; let reads = 0;
  const card = renderDiagnosticsCard({ id: 'widget:diagnostics' }, { geometry: { h: 18 }, state: () => state, refresh: () => { reads++; } });
  dom.node('detail').append(card); const refresh = card.querySelector('.dashboard-diagnostics-refresh'), details = card.querySelector('.dashboard-diagnostics-details');
  refresh.focus(); expect(card.querySelectorAll('.diagnostics-trend')).toHaveLength(3); expect(card.querySelectorAll('.diagnostics-trend-slot')).toHaveLength(180);
  state = { ...state, pending: true }; card.dashboardDiagnosticsChange(); expect(refresh.disabled).toBe(false); expect(refresh.getAttribute('aria-disabled')).toBe('true'); await refresh.onclick(); expect(reads).toBe(0); expect(refresh.parentNode.dataset.help).toContain('不会重复');
  expect(dom.document.activeElement).toBe(refresh); expect(card.querySelector('.dashboard-diagnostics-refresh')).toBe(refresh);
  state = { ...state, pending: false, error: '受控错误' }; card.dashboardDiagnosticsChange(); expect(deepText(card)).toContain('更新失败，旧值');
  card.dashboardGeometryChange({ h: 10 }); expect(card.querySelector('.diagnostics-trends')).toBeNull(); expect(card.querySelectorAll('.diagnostics-rate')).toHaveLength(6);
  await refresh.onclick(); expect(reads).toBe(1); await details.onclick(); const text = deepText(dom.node('modal'));
  expect(text).toContain('估算费用不是账单'); expect(text).toContain('输入包含缓存'); expect(text).toContain('未知用量项'); expect(text).toContain('贡献项计数'); expect(text).toContain('项目A');
});
test('online partial sources retain known subtotal but never imply an offline state or missing token quantity', async () => {
  const data = snapshot(); data.coverage.complete = false;
  for (const window of data.windows) { window.complete = false; window.unknown_tokens = 2; window.unknown_cost = 3; }
  const card = renderDiagnosticsCard({ id: 'widget:diagnostics' }, { state: () => ({ snapshot: data }), refresh() {} }); dom.node('detail').append(card);
  expect(deepText(card)).toContain('来源或用量未确认'); expect(deepText(card)).not.toContain('离线');
  expect(deepText(card.querySelector('.diagnostics-rate'))).toContain('≥10');
  await card.querySelector('.dashboard-diagnostics-details').onclick(); const text = deepText(dom.node('modal'));
  expect(text).toContain('未知用量项 2'); expect(text).toContain('未知费用项 3'); expect(text).toContain('不是缺失 token 数或金额');
  expect(text).toContain('在线来源也可能报告不完整'); expect(text).toContain('项目A · 在线');
});
test('real Host projection fits the frontend contract and preserves partial subtotals and contributor counts', async () => {
  const { HostRuntimeDiagnostics } = await import('../../src/host/runtime-diagnostics.js');
  const { emptyDiagnostics } = await import('../../src/core/runtime-diagnostics.js');
  const now = Date.parse('2026-10-12T12:00:00Z'), report = emptyDiagnostics(now);
  for (const window of report.windows) Object.assign(window, { input: 600, output: 60, cost: 0.1, requests: 1, unknown_cost: 1,
    input_per_second: 600 / window.seconds, output_per_second: 60 / window.seconds, cost_per_minute: 0.1 * 60 / window.seconds });
  const host = new HostRuntimeDiagnostics(() => [{ id: 'aaaaaaaaaaaaaaaa', name: '在线部分来源', read: async () => report },
    { id: 'bbbbbbbbbbbbbbbb', name: '离线来源', read: async () => null }], { now: () => now });
  const data = validateDiagnostics(await host.read());
  expect(data.coverage).toEqual({ projects_total: 2, projects_online: 1, projects_reporting: 1, complete: false });
  expect(data.windows[0]).toMatchObject({ input: 600, cost: 0.1, unknown_tokens: 1, unknown_cost: 2, complete: false });
  expect(diagnosticsRate(data.windows[0], 'input', data.coverage)).toBe('≥10');
  const card = renderDiagnosticsCard({ id: 'widget:diagnostics' }, { state: () => ({ snapshot: data }), refresh() {} }); dom.node('detail').append(card);
  expect(deepText(card)).toContain('覆盖 1/2 项目'); expect(deepText(card)).toContain('不完整（离线）');
  await card.querySelector('.dashboard-diagnostics-details').onclick(); const text = deepText(dom.node('modal'));
  expect(text).toContain('未知用量项 1'); expect(text).toContain('未知费用项 2'); expect(text).toContain('在线部分来源 · 在线');
});
test('no projects is explicit unknown, not complete zeros; v5 ACK requires boolean while v1-v4 retain read-only default', async () => {
  const data = snapshot(); data.projects = []; data.coverage = { projects_total: 0, projects_online: 0, projects_reporting: 0, complete: false };
  const card = renderDiagnosticsCard({ id: 'widget:diagnostics' }, { state: () => ({ snapshot: data }), refresh() {} }); expect(deepText(card)).toContain('无登记项目，流量未知');
  expect(card.querySelectorAll('.diagnostics-rate').every(rate => deepText(rate).includes('未知'))).toBe(true);
  const base = { revision: 'r', cards: [], hidden_projects: [], layout: [], content: [], account_view: 'list', widgets: [] };
  for (const version of [1, 2, 3, 4]) expect((await readDashboardConfig({ value: { ...base, version } })).diagnostics).toBe(true);
  expect((await readDashboardConfig({ value: { ...base, version: 5, diagnostics: false } })).widgets).toEqual([]);
  await expect(readDashboardConfig({ value: { ...base, version: 5 } })).rejects.toThrow('响应无效');
});
