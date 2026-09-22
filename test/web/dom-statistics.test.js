import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld();
const queries = [];
let fail = false, deferred = null;
const total = { requests: 2, input: 10, output: 5, cache_read: 20, cache_write: 0, tokens: 35, cost: 0.12, unknown_cost: 1, unknown_tokens: 0 };
const response = { project: '/test', currency: 'USD', estimated: true, timezone: 'UTC', generated_at: '2026-01-02T00:00:00Z', interval: 'day',
  range: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' }, totals: total,
  buckets: [{ start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z', ...total }],
  models: [{ provider: 'vendor', model: '<script>model</script>', ...total }],
  coverage: { files: 1, unreadable_files: 0, malformed_lines: 0, incomplete_files: 0, undated_requests: 0, codex_threads: 0 } };
const dom = installDom({ fetch: async (url, options) => {
  if (String(url).startsWith('/api/usage')) {
    queries.push(new URL(String(url), 'http://localhost'));
    if (deferred) await deferred;
    return Response.json(fail ? { error: 'offline test' } : response, { status: fail ? 400 : 200 });
  }
  return world.fetchImpl(url, options);
} });
// SVG geometry uses attributes, not inline styles, and thus works under the application's CSP.
dom.document.createElementNS = (_namespace, tag) => dom.document.createElement(tag);
const { boot } = await import('../../src/ui/web/assets/app.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { renderStatistics } = await import('../../src/ui/web/assets/render-statistics.js');
await boot();
afterAll(() => dom.restore());
const panel = () => dom.node('detail');
const open = () => dom.node('statistics-open').onclick();
const submit = () => panel().querySelector('form.usage-filters').onsubmit({ preventDefault() {} });

test('statistics entry defaults to all history, renders accessible chart and per-model estimated costs', async () => {
  await open();
  expect(dom.location.hash).toBe('#statistics'); expect(ui.statisticsOpen).toBe(true);
  expect(queries.at(-1).searchParams.has('start')).toBe(false);
  expect(queries.at(-1).searchParams.has('end')).toBe(false);
  expect(queries.at(-1).searchParams.get('interval')).toBe('day');
  expect(panel().querySelector('input').type).toBe('date');
  expect(deepText(panel())).toContain('UTC 时区');
  expect(deepText(panel())).toContain('累计 token'); expect(deepText(panel())).toContain('预计花费（USD）');
  expect(deepText(panel())).toContain('vendor / <script>model</script>');
  expect(panel().querySelector('script')).toBe(null);
  expect(panel().querySelector('svg').getAttribute('aria-label')).toContain('柱状图');
  expect(panel().querySelector('rect').getAttribute('aria-label')).toContain('费用未知');
  expect(deepText(panel())).toContain('未知不等于免费');
  const before = queries.length;
  await dom.intervalFor(1500)();
  expect(panel().dataset.view).toBe('statistics'); expect(queries.length).toBe(before);
});

test('daily shortcuts query immediately, calendar range includes the end date, and errors stay inline', async () => {
  for (const title of ['最近 7 天', '最近 30 天', '本月']) {
    const before = queries.length;
    await findByText(panel(), title).onclick();
    expect(queries.length).toBe(before + 1);
    expect(queries.at(-1).searchParams.get('interval')).toBe('day');
    expect(findByText(panel(), title).getAttribute('aria-pressed')).toBe('true');
  }
  const start = panel().querySelector('input[data-filter="start"]');
  const end = panel().querySelector('input[data-filter="end"]');
  start.value = '2026-01-01'; end.value = '2026-01-02';
  await submit();
  expect(queries.at(-1).searchParams.get('start')).toBe('2026-01-01T00:00:00.000Z');
  expect(queries.at(-1).searchParams.get('end')).toBe('2026-01-03T00:00:00.000Z');
  expect(findByText(panel(), '自定义日期').getAttribute('aria-pressed')).toBe('true');
  const before = queries.length;
  end.value = '2025-01-01'; await submit();
  expect(queries.length).toBe(before); expect(deepText(panel())).toContain('开始日期不能晚于结束日期');
  await findByText(panel(), '全部历史').onclick();
  expect(queries.at(-1).searchParams.has('start')).toBe(false);
  expect(panel().querySelector('input[data-filter="start"]').value).toBe('');
  fail = true; await submit(); expect(deepText(panel())).toContain('offline test');
  fail = false; await submit(); expect(panel().querySelector('svg')).not.toBe(null);
});

test('intraday has its own date and hour range, supports all day and preserves both modes', async () => {
  await findByText(panel(), '最近 7 天').onclick();
  const dailyQuery = queries.at(-1).search;
  await findByText(panel(), '日内 · 按小时').onclick();
  expect(queries.at(-1).searchParams.get('interval')).toBe('hour');
  expect(findByText(panel(), '今天').getAttribute('aria-pressed')).toBe('true');
  await findByText(panel(), '昨天').onclick();
  expect(findByText(panel(), '昨天').getAttribute('aria-pressed')).toBe('true');
  panel().querySelector('input[data-filter="date"]').value = '2026-01-02';
  panel().querySelector('select[data-filter="startHour"]').value = '9';
  panel().querySelector('select[data-filter="endHour"]').value = '18';
  await submit();
  expect(queries.at(-1).searchParams.get('start')).toBe('2026-01-02T09:00:00.000Z');
  expect(queries.at(-1).searchParams.get('end')).toBe('2026-01-02T18:00:00.000Z');
  const hourlyQuery = queries.at(-1).search;
  await findByText(panel(), '日间 · 按天').onclick(); expect(queries.at(-1).search).toBe(dailyQuery);
  await findByText(panel(), '日内 · 按小时').onclick(); expect(queries.at(-1).search).toBe(hourlyQuery);
  const before = queries.length;
  panel().querySelector('select[data-filter="endHour"]').value = '8'; await submit();
  expect(queries.length).toBe(before); expect(deepText(panel())).toContain('开始小时必须早于结束小时');
  await findByText(panel(), '全天').onclick();
  expect(queries.at(-1).searchParams.get('start')).toBe('2026-01-02T00:00:00.000Z');
  expect(queries.at(-1).searchParams.get('end')).toBe('2026-01-03T00:00:00.000Z');
});

test('navigation and stale async responses cannot overwrite another view; direct hash and boot work', async () => {
  let release; deferred = new Promise(resolve => { release = resolve; });
  const inFlight = open();
  dom.location.hash = '#tasks'; await dom.fire('hashchange');
  expect(ui.statisticsOpen).toBe(false); expect(ui.indexOpen).toBe('tasks');
  release(); await inFlight; deferred = null;
  expect(ui.indexOpen).toBe('tasks'); expect(dom.node('detail').hidden).toBe(true);
  dom.location.hash = '#statistics'; await dom.fire('hashchange');
  expect(ui.statisticsOpen).toBe(true); expect(dom.node('detail').hidden).toBe(false);
  await dom.node('home').onclick(); expect(ui.statisticsOpen).toBe(false);
  dom.location.hash = '#statistics'; await boot();
  expect(panel().dataset.view).toBe('statistics'); expect(ui.statisticsOpen).toBe(true);
});

test('chart hover shows values immediately, follows the pointer, and hides on leave, blur, Escape or scroll', () => {
  const root = renderStatistics(response);
  const graph = root.querySelector('svg');
  const column = root.querySelector('.usage-column');
  const bar = root.querySelector('.usage-bar');
  const tooltip = root.querySelector('.usage-tooltip');
  const scroll = root.querySelector('.usage-chart-scroll');
  graph.getScreenCTM = () => ({ a: 1, d: 1, e: 0, f: 0 });
  scroll.getBoundingClientRect = () => ({ left: 0, right: 720 });
  expect(tooltip.getAttribute('visibility')).toBe('hidden');
  column.onmouseenter({ clientX: 100, clientY: 180 });
  expect(tooltip.getAttribute('visibility')).toBe('visible');
  expect(deepText(tooltip)).toContain('$0.120000 + 未知 USD');
  expect(deepText(tooltip)).toContain('35 tokens · 2 条记录');
  expect(deepText(tooltip)).toContain('1 条费用未知');
  expect(deepText(tooltip)).toContain('UTC');
  const before = tooltip.getAttribute('transform');
  column.onmousemove({ clientX: 200, clientY: 180 });
  expect(tooltip.getAttribute('transform')).not.toBe(before);
  column.onmouseleave(); expect(tooltip.getAttribute('visibility')).toBe('hidden');
  bar.onfocus(); expect(tooltip.getAttribute('visibility')).toBe('visible');
  bar.onkeydown({ key: 'Escape' }); expect(tooltip.getAttribute('visibility')).toBe('hidden');
  bar.onfocus(); bar.onblur(); expect(tooltip.getAttribute('visibility')).toBe('hidden');
  column.onmouseenter({ clientX: 100, clientY: 180 });
  scroll.listeners.scroll[0](); expect(tooltip.getAttribute('visibility')).toBe('hidden');
});

test('zero bars have full-height hover targets and tooltip stays inside a narrow scrolled viewport', () => {
  const root = renderStatistics({ ...response, buckets: [{ ...response.buckets[0], cost: 0, unknown_cost: 2 }] });
  const graph = root.querySelector('svg'), scroll = root.querySelector('.usage-chart-scroll');
  graph.getScreenCTM = () => ({ a: 1, d: 1, e: -300, f: 0 });
  scroll.getBoundingClientRect = () => ({ left: 0, right: 250 });
  expect(Number(root.querySelector('.usage-hit').getAttribute('height'))).toBe(185);
  root.querySelector('.usage-column').onmouseenter({ clientX: 249, clientY: 50 });
  const tooltip = root.querySelector('.usage-tooltip');
  const [, x, y, scale] = /translate\(([^ ]+) ([^)]+)\) scale\(([^)]+)\)/.exec(tooltip.getAttribute('transform')).map(Number);
  expect(x).toBeGreaterThanOrEqual(304); expect(x + 300 * scale).toBeLessThanOrEqual(546);
  expect(y).toBeGreaterThanOrEqual(4);
  expect(deepText(tooltip)).toContain('预计花费 未知 USD');
});

test('empty results and wholly unknown prices never pretend to be free', () => {
  const unknown = renderStatistics({ ...response, totals: { ...total, unknown_cost: 2, cost: 0 } });
  expect(deepText(unknown)).toContain('未知');
  const empty = renderStatistics({ ...response, totals: { ...total, requests: 0, tokens: 0, cost: 0, unknown_cost: 0 }, models: [], buckets: [] });
  expect(deepText(empty)).toContain('所选范围内暂无用量记录');
  expect(deepText(empty)).toContain('暂无可绘制');
});
