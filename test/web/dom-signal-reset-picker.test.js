import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';

const json = value => ({ ok: true, json: async () => structuredClone(value) });
const resetAt = '2030-02-02T18:20:00.123Z';
const quota = (extra = {}) => ({ id: 'five', kind: 'quota', scope: 'account', label: '主要窗口',
  reset_at: resetAt, window_seconds: 18000, ...extra });
const connection = (extra = {}) => ({ id: 'account-a', label: '我的 Codex', enabled: true,
  observation: { status: 'available', checked_at: '2026-10-01T12:00:00Z', resources: [quota(), quota({ id: 'week', label: '周额度', window_seconds: 604800, reset_at: '2030-02-09T18:20:00Z' })] }, ...extra });
const catalogue = { version: 1, revision: 'templates', templates: [], triggers: [], actions: [],
  signals: { version: 1, revision: 'signals', items: [] }, management_workers: [] };
let connections, reads, actions, intercept;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) actions.push(body); else reads.push(path);
  const result = intercept?.(path, body); if (result) return result;
  if (path.endsWith('/api/agent/connections')) return json({ version: 1, connections });
  if (path.endsWith('/api/hooks') || body?.method === 'hooks.signal_save') return json(catalogue);
  throw new Error(`Unexpected request ${path}`);
} });
const { createSignalForm } = await import('../../src/ui/web/assets/hook-signals.js');
const { openHooks } = await import('../../src/ui/web/assets/render-hooks.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const root = () => dom.node('detail');
const input = (label, node = root()) => node.querySelector(`[aria-label="${label}"]`);
const btn = (label, node = root()) => node.querySelectorAll('button').find(item => item.textContent === label);
const choose = (form, index = '0') => { const select = input('订阅额度刷新时间', form.node); select.value = index; select.onchange(); };
async function formWithCache(initial = {}) {
  const form = createSignalForm(initial); root().replaceChildren(form.node);
  input('信号名称').value = '额度到点'; input('信号时区（IANA）').value = 'Asia/Kathmandu';
  await form.loadResetTimes(); return form;
}
beforeEach(() => { connections = [connection()]; reads = []; actions = []; intercept = null;
  dom.location.pathname = '/'; ui.hooksPage = null; activateDetailView({ view: 'overview' }); });
afterAll(() => dom.restore());

test('automation navigation keeps #hooks; source cache loads only when opening the signal editor and saves a plain exact once schedule', async () => {
  await openHooks(); expect(dom.location.hash).toBe('#hooks'); expect(root().querySelector('h1').textContent).toBe('自动化');
  expect(dom.node('view-title').textContent).toBe('自动化'); expect(reads).toEqual(['/api/hooks']);
  await btn('新建时间信号').onclick();
  await until(() => !input('订阅额度刷新时间').disabled);
  input('信号名称').value = '额度到点'; input('信号时区（IANA）').value = 'Asia/Kathmandu';
  choose({ node: root() });
  expect(input('信号日期与时间').value).toBe('2030-02-03T00:05:00');
  expect(reads).toEqual(['/api/hooks', '/api/agent/connections']); expect(actions).toHaveLength(0);
  await btn('保存时间信号').onclick();
  expect(actions).toEqual([{ method: 'hooks.signal_save', params: { expected_revision: 'signals',
    signal: { name: '额度到点', enabled: true, schedule: { kind: 'once', at: resetAt, timezone: 'Asia/Kathmandu' } } } }]);
});

test('subscription picker distinguishes accounts and windows, shows cache time and copies only selected instant without changing name or timezone', async () => {
  connections.push(connection({ id: 'account-b', label: '另一订阅', enabled: false }));
  const form = await formWithCache();
  const options = input('订阅额度刷新时间').children;
  expect(options).toHaveLength(5); expect(options[1].textContent).toContain('我的 Codex');
  expect(options[1].textContent).toContain('5 小时窗口'); expect(options[2].textContent).toContain('7 天（周）窗口');
  expect(options[3].textContent).toContain('另一订阅'); expect(options[3].textContent).toContain('来源已停用');
  choose(form); expect(form.collect().schedule).toEqual({ kind: 'once', at: resetAt, timezone: 'Asia/Kathmandu' });
  expect(input('信号名称').value).toBe('额度到点'); expect(input('信号时区（IANA）').value).toBe('Asia/Kathmandu');
  expect(deepText(form.node)).toContain('缓存观测：'); expect(deepText(form.node)).toContain('不跟踪后续额度变化');
  expect(deepText(form.node)).toContain('时间已到不证明额度恢复'); expect(form.validate()).toBe('');
  choose(form, '1'); expect(form.collect().schedule.at).toBe('2030-02-09T18:20:00.000Z'); expect(actions).toHaveLength(0);
});

test('selection changes daily schedule to once and keeps manual editing available', async () => {
  const form = await formWithCache({ name: '每日', schedule: { kind: 'daily', time: '01:02', timezone: 'Asia/Kathmandu' } });
  choose(form); expect(input('信号周期').value).toBe('once');
  expect(input('信号每日时间').parentNode.hidden).toBe(true); expect(input('信号日期与时间').parentNode.hidden).toBe(false);
  input('信号日期与时间').value = '2030-02-04T00:05:00';
  expect(form.collect().schedule.at).toBe('2030-02-03T18:20:00.000Z');
  input('信号周期').value = 'daily'; input('信号周期').onchange();
  expect(form.collect().schedule).toEqual({ kind: 'daily', time: '01:02', timezone: 'Asia/Kathmandu' });
});

test('only current successful account quota observations qualify; missing, invalid and past dates are disabled; failed last_success and non-subscription limits never leak in', async () => {
  connections = [connection({ observation: { status: 'partial', checked_at: null, resources: [
    quota({ reset_at: null }), quota({ reset_at: 'bad' }), quota({ reset_at: '2000-01-01T00:00:00Z' }),
    quota({ kind: 'balance' }), quota({ scope: 'key' }), quota({ scope: 'model' }), quota(),
  ] } }), connection({ id: 'failed', label: '失败来源', observation: { status: 'error', resources: [quota()] }, last_success: connection().observation }),
  connection({ id: 'unknown', observation: { status: 'unknown', resources: [quota()] } })];
  const form = await formWithCache(); const select = input('订阅额度刷新时间');
  expect(select.children).toHaveLength(5); expect(select.children.slice(1, 4).every(option => option.disabled)).toBe(true);
  expect(select.children[4].disabled).toBe(false); expect(deepText(form.node)).not.toContain('失败来源');
  choose(form, '3'); expect(deepText(form.node)).toContain('部分观测'); expect(deepText(form.node)).toContain('缓存观测：时间未知');
});

test('absent or failed source cache keeps manual input working and a read-only retry never overwrites dates', async () => {
  connections = []; const form = await formWithCache();
  expect(input('订阅额度刷新时间').disabled).toBe(true); expect(deepText(form.node)).toContain('暂无可填入');
  input('信号日期与时间').value = '2030-02-03T00:05:00';
  intercept = path => path.endsWith('/api/agent/connections') ? { ok: false, json: async () => ({ error: '本地读取失败' }) } : null;
  await btn('重新读取订阅缓存').onclick(); expect(deepText(form.node)).toContain('读取订阅缓存失败'); expect(form.validate()).toBe('');
  intercept = null; connections = [connection()]; await btn('重新读取订阅缓存').onclick();
  expect(input('信号日期与时间').value).toBe('2030-02-03T00:05:00'); expect(actions).toHaveLength(0);
  expect(btn('重新读取订阅缓存').classList.contains('agent-call')).toBe(false);
});

test('invalid timezone does not change schedule; explicitly supplied DST-overlap instant preserves milliseconds without reverse-conversion ambiguity', async () => {
  connections = [connection({ observation: { status: 'available', resources: [quota({ reset_at: '2030-11-03T06:30:00.123Z' })] } })];
  const form = await formWithCache();
  input('信号日期与时间').value = '2030-02-03T00:05'; input('信号时区（IANA）').value = 'Invalid/Zone';
  choose(form); expect(input('信号日期与时间').value).toBe('2030-02-03T00:05'); expect(deepText(form.node)).toContain('未改动时间');
  input('信号时区（IANA）').value = 'America/New_York'; choose(form);
  expect(input('信号日期与时间').value).toBe('2030-11-03T01:30:00'); expect(form.validate()).toBe('');
  expect(form.collect().schedule.at).toBe('2030-11-03T06:30:00.123Z');
  input('信号日期与时间').value = '2030-11-03T01:31:00'; expect(form.validate()).toContain('出现两次');
});

test('datetime-local browser normalization does not lose the precise cached instant', async () => {
  const form = await formWithCache(); const date = input('信号日期与时间');
  let value = date.value;
  Object.defineProperty(date, 'value', { configurable: true, get: () => value,
    set: next => { value = next.replace(/:00$/, ''); } });
  choose(form); expect(date.value).toBe('2030-02-03T00:05');
  expect(form.collect().schedule.at).toBe(resetAt); expect(form.validate()).toBe('');
});

test('clock expiry between cache load and selection is rechecked without inferring a later reset', async () => {
  const originalNow = Date.now;
  try {
    const form = await formWithCache(); input('信号日期与时间').value = '2031-02-03T00:05';
    Date.now = () => Date.parse('2031-01-01T00:00:00Z'); choose(form);
    expect(input('信号日期与时间').value).toBe('2031-02-03T00:05'); expect(deepText(form.node)).toContain('刷新时间已到');
    expect(input('订阅额度刷新时间').disabled).toBe(true); expect(actions).toHaveLength(0);
  } finally { Date.now = originalNow; }
});

test('busy signal save disables picker even when a cache read finishes; late old-form callbacks never alter the new page', async () => {
  let resolve, owns = true;
  intercept = path => path.endsWith('/api/agent/connections') ? new Promise(done => { resolve = done; }) : null;
  const form = createSignalForm({}, { ownsPage: () => owns }); root().replaceChildren(form.node);
  const loading = form.loadResetTimes(); form.setBusy(true);
  resolve(json({ connections: [connection()] })); await loading;
  expect(input('订阅额度刷新时间').disabled).toBe(true); expect(btn('重新读取订阅缓存').disabled).toBe(true);
  expect(btn('重新读取订阅缓存').parentNode.getAttribute('data-help')).toContain('正在保存');
  form.setBusy(false); expect(input('订阅额度刷新时间').disabled).toBe(false);
  const secondLoad = form.loadResetTimes(); owns = false; const replacement = createSignalForm(); root().replaceChildren(replacement.node);
  const before = deepText(replacement.node); resolve(json({ connections: [connection({ label: '旧项目订阅' })] })); await secondLoad;
  choose(form); expect(deepText(replacement.node)).toBe(before); expect(input('信号日期与时间', form.node).value || '').toBe('');
});

test('cache response from a previous project cannot fill or repaint the new project editor', async () => {
  let resolve;
  dom.location.pathname = '/p/1111111111111111/'; await openHooks();
  intercept = path => path === '/p/1111111111111111/api/agent/connections' ? new Promise(done => { resolve = done; }) : null;
  await btn('新建时间信号').onclick(); await until(() => resolve);
  const old = root().querySelector('.signal-form');
  dom.location.pathname = '/p/2222222222222222/'; await openHooks(); await btn('新建时间信号').onclick();
  await until(() => !input('订阅额度刷新时间').disabled); const replacement = root().querySelector('.signal-form');
  resolve(json({ connections: [connection({ label: '旧项目订阅' })] })); await Promise.resolve(); await Promise.resolve();
  expect(root().querySelector('.signal-form')).toBe(replacement); expect(deepText(root())).not.toContain('旧项目订阅');
  choose({ node: old }); expect(input('信号日期与时间').value || '').toBe(''); expect(actions).toHaveLength(0);
});

test('automation navigation exits explicit Worker append mode; filling a signal preserves independent-Worker composer draft and destination', async () => {
  const { syncComposer, appendToWorker } = await import('../../src/ui/web/assets/composer.js');
  const previousSync = ui.syncComposer;
  try {
    ui.syncComposer = syncComposer;
    dom.node('input-parent').value = 'main'; dom.node('input').value = '未发送的开发指令';
    activateDetailView({ view: 'task', key: 'task-99' }); ui.selected = 99;
    appendToWorker({ id: 99, worker_number: 'W99', task_kind: 'order', status: 'running', goal: '开发目标', branch: 'feature', workspace: '/tmp/work' });
    expect(dom.node('input-form').dataset.mode).toBe('append');
    await openHooks();
    expect(ui.composerAppendTarget).toBeNull(); expect(dom.node('input-form').dataset.mode).toBe('create');
    expect(dom.node('input').disabled).toBe(false); expect(dom.node('composer-reset').hidden).toBe(true);
    await btn('新建时间信号').onclick(); await until(() => !input('订阅额度刷新时间').disabled);
    choose({ node: root() });
    expect(dom.node('input').value).toBe('未发送的开发指令'); expect(dom.node('input-parent').value).toBe('main');
    expect(dom.node('input-form').dataset.mode).toBe('create'); expect(actions).toHaveLength(0);
  } finally { ui.syncComposer = previousSync; }
});
