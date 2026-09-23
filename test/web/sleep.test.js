import { test, expect } from 'bun:test';
import { setup, fetch as httpFetch } from './harness.js';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { sleepSettings, renderSleepBanner } from '../../src/ui/web/assets/sleep-ui.js';
import { initNoticeRecords, loadNoticeRecords, renderNotices } from '../../src/ui/web/assets/render-notices.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';

const settings = { mode: 'recommended', include_existing: false, allow_merge: false, budget_tokens: 10000 };

test('HTTP sleep control requires confirmation and exposes persistent state and paginated audit', async () => {
  const f = await setup();
  const send = (method, params) => httpFetch(f.url + '/api/action', { method: 'POST', headers: { 'content-type': 'application/json', origin: f.url }, body: JSON.stringify({ method, params }) });
  try {
    expect((await send('sleep.start', { options: settings, confirmed: false })).status).toBe(400);
    expect((await send('sleep.start', { options: settings, confirmed: true })).status).toBe(200);
    const state = await (await httpFetch(f.url + '/api/sleep')).json();
    expect(state.enabled).toBe(true); expect(state.warning).toContain('超额');
    expect((await (await httpFetch(f.url + '/api/sleep/choices')).json()).choices).toEqual([]);
    expect((await httpFetch(f.url + '/api/sleep/choices?before=invalid')).status).toBe(400);
    expect((await send('sleep.stop', {})).status).toBe(200);
    expect((await (await httpFetch(f.url + '/api/sleep')).json()).enabled).toBe(false);
  } finally { await f.close(); }
});

test('settings shows risk confirmation before activation; banner gives immediate stop without another confirmation', async () => {
  const calls = []; let state = { enabled: false, paused: false, warning: '测试风险：可能超额，并作出错误选择。' };
  const dom = installDom({ fetch: async (url, options = {}) => {
    const json = value => ({ ok: true, status: 200, json: async () => structuredClone(value) });
    if (url === '/api/sleep') return json(state);
    if (url === '/api/action') {
      const value = JSON.parse(options.body); calls.push(value);
      state = { ...state, ...value.params.options, enabled: value.method === 'sleep.start' }; return json(state);
    }
    throw new Error(url);
  } });
  resetUiState(); ui.lastSnapshot = { status: { sleep: state } };
  const restore = registerNavigation({ refresh: async () => {} });
  try {
    const banner = dom.node('sleep-banner');
    const host = sleepSettings(); dom.node('detail').append(host);
    const budget = host.querySelector('[data-sleep-field="budget"]'); budget.value = '1234';
    host.querySelector('[data-sleep-field="existing"]').checked = true;
    const enabling = findByText(host, '阅读风险并开启…').onclick();
    await until(() => deepText(dom.node('modal')).includes('测试风险'));
    expect(calls).toHaveLength(0);
    await findByText(dom.node('modal'), '取消').onclick(); await enabling;
    expect(calls).toHaveLength(0);
    const confirmed = findByText(host, '阅读风险并开启…').onclick();
    await until(() => deepText(dom.node('modal')).includes('测试风险'));
    await findByText(dom.node('modal'), '我了解风险，授权管家开启').onclick(); await confirmed;
    expect(calls[0].params.options).toMatchObject({ budget_tokens: 1234, include_existing: true, allow_merge: false });
    renderSleepBanner(state);
    expect(banner.hidden).toBe(false); expect(deepText(banner)).toContain('管家正在值守');
    await findByText(banner, '立即关闭睡觉模式').onclick();
    expect(calls.at(-1).method).toBe('sleep.stop'); expect(banner.hidden).toBe(true);
  } finally { restore(); dom.restore(); }
});

test('butler choices are a separate read-only tab with question snapshot, answer, reason and pagination', async () => {
  const choice = id => ({ id, created_at: '2026-01-01T00:00:00Z', mode: 'preferences', notice: { id, task_id: 1, title: '原始问题 <script>', body: '需要什么？', kind: 'question' },
    result: { status: 'applied', decision: { action: 'answer', answer: '采用 A <img>', reason: '依据你以往选择' } } });
  const dom = installDom({ fetch: async url => ({ ok: true, status: 200, json: async () => {
    if (url.startsWith('/api/sleep/choices')) return url.includes('before') ? { choices: [choice(1)], cursor: 1, has_more: false }
      : { choices: [choice(2)], cursor: 2, has_more: true };
    throw new Error(url);
  } }) });
  resetUiState(); initNoticeRecords(); ui.indexOpen = 'notices';
  try {
    await findByText(dom.node('side-notices-body'), '管家选择').onclick();
    expect(deepText(dom.node('notices'))).toContain('采用 A <img>');
    expect(deepText(dom.node('notices'))).toContain('依据你以往选择');
    expect(dom.node('notices').querySelector('script')).toBeNull();
    expect(dom.node('notices').querySelector('textarea')).toBeNull();
    await findByText(dom.node('notice-pagination'), '加载更早选择').onclick();
    renderNotices({ notices: [] }); await loadNoticeRecords({ preserve: true });
    expect(ui.noticeRecords.choices).toHaveLength(2);
    expect(deepText(dom.node('notices'))).toContain('原始问题');
  } finally { ui.noticeRecords = null; dom.restore(); }
});
