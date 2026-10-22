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
const { openAgentStatus } = await import('../../src/ui/web/assets/render-agent-status.js');
await boot(); await prefs.refreshDevicePreferences();
afterAll(async () => { dom.restore(); await web.stop(true); fs.rmSync(device, { recursive: true, force: true }); });

test('device settings saves real Host preferences and reminders, profiles and environment with feedback and retained drafts', async () => {
  await openSettings();
  const panel = dom.node('detail');
  expect(dom.location.hash).toBe('#settings'); expect(panel.dataset.view).toBe('settings');
  expect(dom.intervalFor(1500)).toBeUndefined();
  const push = panel.querySelector('.push-notification-control');
  expect(push.querySelectorAll('button')).toHaveLength(5);
  expect(push.querySelectorAll('.agent-call')).toHaveLength(0);
  expect(deepText(panel)).toContain('iPhone／iPad 16.4+ 请先添加到主屏幕');
  expect(deepText(panel)).toContain('服务器更新后可重新加载');
  expect(push.querySelector('[data-push-action="enable"]').disabled).toBe(true);
  expect(push.querySelectorAll('.help-host').every(node => node.getAttribute('data-help'))).toBe(true);
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

  // Continue the same device settings workflow into editable Agent defaults and environment.
  await openAgentStatus();
  const profile = panel.querySelector('[data-agent-target="default"]');
  const profileSave = profile.querySelectorAll('button').find(node => node.textContent === '保存配置');
  await profileSave.onclick();
  expect(profile.querySelector('.agent-profile-feedback').hidden).toBe(false); // missing managed source
  const backend = profile.querySelector('[data-agent-field="agent"]'); backend.value = 'codex'; backend.listeners.change[0]();
  const prompt = profile.querySelector('[data-agent-field="append_prompt"]'); prompt.value = 'profile draft';
  let release, reject, pendingMethod = '', count = 0;
  globalThis.fetch = (url, options) => {
    if ((options?.body && JSON.parse(options.body).method === pendingMethod) || String(url).includes(pendingMethod) && pendingMethod === 'agent/environment') {
      count++; return new Promise((resolve, fail) => { release = () => resolve(fetch(url, options)); reject = fail; });
    }
    return fetch(url, options);
  };
  try {
    pendingMethod = 'agent.configure';
    let pending = profileSave.onclick(); await until(() => reject);
    expect(profileSave.textContent).toBe('保存中…'); await profileSave.onclick(); expect(count).toBe(1);
    reject(Error('profile request failure')); await pending;
    expect(profile.querySelector('.agent-profile-feedback').textContent).toContain('profile request failure');
    expect(prompt.value).toBe('profile draft'); expect(profileSave.textContent).toBe('保存配置');
    pending = profileSave.onclick(); prompt.value = 'edited during save'; release(); await pending;
    expect(profile.querySelector('[data-agent-field="append_prompt"]')).toBe(prompt);
    expect(prompt.value).toBe('edited during save'); expect(world.state.agentConfig.default.append_prompt).toBe('profile draft');

    pendingMethod = 'agent/environment';
    let env = panel.querySelector('.agent-env-block'), load = env.querySelector('.agent-env-load');
    pending = load.onclick(); expect(load.textContent).toBe('读取中…'); reject(Error('environment read failure')); await pending;
    expect(env.querySelector('[data-env-error=""]').textContent).toContain('environment read failure');
    pending = load.onclick(); release(); await pending;
    env = panel.querySelector('.agent-env-block');
    const name = env.querySelector('[data-env-name="0"]'), value = env.querySelector('[data-env-value="0"]');
    const envSave = env.querySelector('[data-env-action="save"]');
    name.value = 'INVALID-NAME'; name.listeners.input[0](); await envSave.onclick();
    expect(name.getAttribute('aria-invalid')).toBe('true'); expect(env.querySelector('[data-env-error=""]').hidden).toBe(false);
    expect(name.getAttribute('aria-describedby')).toBe(env.querySelector('[data-env-error=""]').id);
    name.value = 'HTTP_PROXY'; name.listeners.input[0]();
    pendingMethod = 'agent.environment.configure'; pending = envSave.onclick();
    expect(envSave.textContent).toBe('保存中…'); expect(env.querySelector('[data-env-action="add"]').disabled).toBe(true);
    expect(env.querySelector('.module-toggle').disabled).toBe(false);
    reject(Error('environment save failure')); await pending;
    expect(env.querySelector('[data-env-error=""]').textContent).toContain('environment save failure'); expect(value.type).toBe('password');
    pending = envSave.onclick(); value.value = 'draft after request'; value.listeners.input[0](); release(); await pending;
    expect(panel.querySelector('[data-env-value="0"]')).toBe(value); expect(value.value).toBe('draft after request');
    expect(env.querySelector('[data-env-error=""]').textContent).toContain('未保存修改');
  } finally { globalThis.fetch = fetch; }
});
