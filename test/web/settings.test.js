import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { until, temp, env } from '../helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { startTestWeb, fetch } from './auth-fixture.js';
import { readDevicePreferences } from '../../src/core/device-preferences.js';
import { noticeChannelEnabled } from '../../src/ui/web/assets/notice-kind.js';
import { createNoticeNotifier } from '../../src/ui/web/assets/notice-notifications.js';

const device = temp(), web = startTestWeb(null, 0, { env: env({ LUSH_GLOBAL_CONFIG: device }) });
const base = `http://127.0.0.1:${web.port}`, config = { deviceHome: path.join(device, 'shared') };
const world = makeWorld(), dom = installDom({ fetch: (route, options) => String(route).startsWith('/api/host/preferences')
  ? fetch(base + route, options) : world.fetchImpl(route, options) });
const { boot } = await import('../../src/ui/web/assets/app.js');
const prefs = await import('../../src/ui/web/assets/prefs.js');
const { openSettings } = await import('../../src/ui/web/assets/render-settings.js');
await boot(); await prefs.refreshDevicePreferences();
afterAll(async () => { dom.restore(); await web.stop(true); fs.rmSync(device, { recursive: true, force: true }); });

test('root settings route saves reading and reminder preferences through the real Host', async () => {
  await openSettings();
  const panel = dom.node('detail');
  expect(dom.location.hash).toBe('#settings'); expect(panel.dataset.view).toBe('settings');
  expect(dom.intervalFor(1500)).toBeUndefined();
  const dark = panel.querySelector('input.pref-radio[data-value="dark"]'); dark.checked = true; await dark.listeners.change[0]();
  expect(readDevicePreferences(config).values.theme).toBe('dark'); expect(dom.document.documentElement.dataset.theme).toBe('dark');
  const order = panel.querySelector('select.pref-select[data-pref="transcriptOrder"]');
  order.value = 'asc'; await order.listeners.change[0]();
  expect(readDevicePreferences(config).values.transcriptOrder).toBe('asc'); expect(prefs.readPref('transcriptOrder')).toBe('asc');
  expect(deepText(panel)).toContain('提醒方式'); expect(deepText(panel)).toContain('Worker 待验收');
  expect(panel.querySelectorAll('input').filter(node => node.dataset.noticeType)).toHaveLength(10);
  const reported = panel.querySelectorAll('input').find(node => node.dataset.noticeType === 'reported' && node.dataset.channel === 'banner');
  reported.checked = false; await reported.listeners.change[0]();
  const idle = panel.querySelectorAll('input').find(node => node.dataset.noticeType === 'idle' && node.dataset.channel === 'system');
  idle.checked = false; await idle.listeners.change[0]();
  expect(readDevicePreferences(config).values.noticeChannels).toMatchObject({
    reported: { banner: false, system: true }, idle: { banner: true, system: false } });
  const info = (id, type) => ({ id, task_id: 1, kind: 'info', status: 'sent', source_event_id: id, lifecycle_type: type, created_at: new Date().toISOString() });
  expect(noticeChannelEnabled(info(1, 'reported'), 'banner')).toBe(false);
  expect(noticeChannelEnabled(info(2, 'idle'), 'banner')).toBe(true);
  expect(noticeChannelEnabled(info(3, null), 'banner')).toBe(true);
  const sent = [], notify = createNoticeNotifier({ enabled: () => true, send: row => sent.push(row.id) });
  notify({ status: { project: 'isolated' }, notices: [] });
  notify({ status: { project: 'isolated' }, notices: [info(1, 'reported'), info(2, 'idle'), info(3, null), { id: 4, kind: 'question', status: 'open', created_at: new Date().toISOString() }] });
  await Promise.resolve(); expect(sent).toEqual([1, 3, 4]); // Channels are independent; unknowns and decisions remain visible.
  await panel.querySelector('[data-settings-tab="system"]').onclick();
  expect(panel.querySelector('input[data-runtime-input="result_notice"]')).toBeNull();
  expect(panel.querySelectorAll('a').some(node => node.href === '/#skills')).toBe(true);
  await until(() => panel.querySelector('[data-runtime-input="call_timeout"]'));
  const timeout = panel.querySelector('[data-runtime-input="call_timeout"]'); timeout.value = '180';
  const save = panel.querySelector('.settings-runtime-save'), fetch = globalThis.fetch;
  let rejectSave, writes = 0;
  globalThis.fetch = (url, options) => {
    if (options?.body && JSON.parse(options.body).method === 'system.configure') {
      writes++; return new Promise((_, reject) => { rejectSave = reject; });
    }
    return fetch(url, options);
  };
  try {
    const saving = save.onclick(); await until(() => rejectSave);
    expect(save.textContent).toBe('保存中…'); expect(save.getAttribute('aria-busy')).toBe('true');
    expect(save.getAttribute('aria-disabled')).toBe('true'); await save.onclick(); expect(writes).toBe(1);
    rejectSave(new Error('controlled save failure')); await saving;
    expect(save.textContent).toBe('保存'); expect(save.getAttribute('aria-busy')).toBeNull();
    expect(save.getAttribute('aria-disabled')).toBeNull(); expect(timeout.value).toBe('180');
    expect(panel.querySelector('[data-runtime-error=""]').textContent).toContain('controlled save failure');
  } finally { globalThis.fetch = fetch; }
  await save.onclick(); expect(world.state.runtimeSettings.call_timeout.value).toBe(180);
  dom.location.hash = '#skills'; await dom.fire('hashchange');
  expect(panel.dataset.view).toBe('skills');
  expect(dom.node('skills-open').getAttribute('aria-current')).toBe('page');
  const report = panel.querySelector('input[data-runtime-input="result_notice"]');
  expect(report.checked).toBe(true);
  report.checked = false; await report.onchange();
  expect(world.state.runtimeSettings.result_notice.value).toBe(false);
  expect(world.state.actions.at(-1)).toMatchObject({ method: 'system.configure', params: { settings: { result_notice: false } } });
  expect(deepText(panel)).toContain('与 runtime 自动提醒独立');
  expect(panel.querySelectorAll('.skill-card')).toHaveLength(5);
  expect(panel.querySelectorAll('details').every(node => !node.open)).toBe(true);
  const page = panel.querySelector('.skills-page');
  await dom.fire('hashchange'); expect(panel.querySelector('.skills-page')).toBe(page);
  await panel.querySelector('button[data-capability-reset=""]').onclick();
  expect(world.state.runtimeSettings.result_notice.value).toBe(true);
  expect(report.checked).toBe(true);
  dom.location.hash = ''; await dom.fire('hashchange'); expect(panel.dataset.view).toBe('projects');
});
