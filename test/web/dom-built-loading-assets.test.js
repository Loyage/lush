import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildAssets } from '../../src/ui/web/build-assets.js';
import { installDom } from '../dom-stub.js';
import { installDom as installProjectDom } from './project-dom.js';
import { makeWorld } from './dom-world.js';
import { temp, until } from '../helpers.js';
import { cliCatalog } from '../../src/rpc/cli-catalog.js';
import { MANAGEMENT_GROUPS, managementPermissionMethods } from '../../src/rpc/management-policy.js';
const root = temp(), assets = fileURLToPath(new URL('../../src/ui/web/assets/', import.meta.url));
await buildAssets(assets, root, 'a'.repeat(32));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = html.match(/src="\/([^"\n]+-app-[^"\n]+\.js)"/)[1];
const world = makeWorld(), preferenceWrites = [];
const dom = installDom({ fetch: (url, options = {}) => {
  if (url === '/api/host/preferences' && options.method === 'POST') preferenceWrites.push(JSON.parse(options.body));
  return world.fetchImpl(url, options);
} });
const { boot } = await import(pathToFileURL(path.join(root, app)).href);
afterAll(() => { dom.restore(); fs.rmSync(root, { recursive: true, force: true }); });

test('Bun browser build boots a root workbench and all global chunks share navigation state', async () => {
  expect(dom.node('detail').dataset.view).toBe('projects');
  for (const [view, hash] of [['settings', 'settings'], ['agent-status', 'agent-status'], ['model-sources', 'model-sources'], ['automation', 'automation'], ['global-inbox', 'notices']]) {
    await dom.node(`${view}-open`).onclick();
    expect(dom.node('detail').dataset.view).toBe(view); expect(dom.location.hash).toBe(`#${hash}`);
    expect(dom.node(`${view}-open`).getAttribute('aria-current')).toBe('page');
  }
  await dom.node('projects-open').onclick(); expect(dom.node('detail').dataset.view).toBe('projects'); expect(dom.location.hash).toBe('#projects');
});

test('compiled root boot is repeatable, awaits deep links and has no project polling', async () => {
  dom.location.hash = '#settings'; await boot(); await boot();
  expect(dom.node('detail').dataset.view).toBe('settings'); expect(dom.node('detail').querySelector('button.settings-tab')).toBeTruthy();
  expect(dom.intervalFor(1500)).toBeUndefined(); expect(typeof dom.intervalFor(3000)).toBe('function');
});

test('compiled lazy settings and appearance entry share live authoritative prefs across repeated boot', async () => {
  await dom.node('settings-open').onclick();
  const dark = dom.node('detail').querySelector('input[data-value="dark"]'); dark.checked = true;
  await dark.listeners.change[0]();
  expect(world.state.devicePreferences.values.theme).toBe('dark'); expect(dom.document.documentElement.dataset.theme).toBe('dark');
  const toggle = dom.node('detail').querySelector('.notice-notification-control').querySelector('button');
  await toggle.onclick();
  expect(world.state.devicePreferences.values.noticeNotifications).toBe(true); expect(toggle.textContent).toBe('关闭系统提醒');
  const writes = preferenceWrites.length;
  await boot(); await boot(); await dom.node('settings-open').onclick();
  expect(preferenceWrites).toHaveLength(writes);
  expect(dom.node('detail').querySelector('input[data-value="dark"]').checked).toBe(true);
  expect(dom.node('detail').querySelector('.notice-notification-control').querySelector('button').textContent).toBe('关闭系统提醒');
  await dom.node('theme-toggle').onclick();
  expect(world.state.devicePreferences.values.theme).toBe('light'); expect(dom.document.documentElement.dataset.theme).toBe('light');
  await dom.node('settings-open').onclick();
  expect(dom.node('detail').querySelector('input[data-value="light"]').checked).toBe(true);
  await dom.node('detail').querySelector('.notice-notification-control').querySelector('button').onclick();
  expect(world.state.devicePreferences.values.noticeNotifications).toBe(false);
});

test('compiled Valet profile loads on demand, preserves shared composer state and discards a stale mode', async () => {
  const project = installProjectDom({ fetch: world.fetchImpl });
  const writes = world.state.actions.length;
  try {
    await boot();
    const toggle = project.node('composer-shell').querySelector('.composer-management');
    const settings = project.node('composer-shell').querySelector('.composer-run-settings');
    await toggle.onclick();
    const stale = settings.onclick(); await toggle.onclick(); await stale;
    expect(project.node('modal').querySelector('[role="dialog"]')).toBeNull();
    expect(settings.textContent).toBe('运行设置：项目默认');
    expect(world.state.actions).toHaveLength(writes);

    await toggle.onclick(); const opening = settings.onclick();
    await until(() => project.node('modal').querySelector('.management-profile-form'));
    const modal = project.node('modal');
    expect(modal.querySelector('[data-retry-field="default_prompt"]')).toBeNull();
    const mode = modal.querySelector('[aria-label="Valet 配置模式"]'); mode.value = 'pi'; mode.onchange();
    await modal.querySelectorAll('button').find(node => node.textContent === '使用这份管理设置').onclick();
    await opening;
    expect(settings.textContent).toBe('管理运行设置：本条已选择');
    expect(world.state.actions).toHaveLength(writes);
    project.node('input').value = '检查项目管理状态'; project.node('input').oninput();
    await project.node('input-form').onsubmit({ preventDefault() {} });
    const sent = world.state.actions.findLast(row => row.method === 'management.submit');
    expect(sent.params.profile).toEqual({ agent: 'pi', config_mode: 'pi' });
    expect(sent.params).not.toHaveProperty('env'); expect(sent.params).not.toHaveProperty('default_prompt');
  } finally { project.restore(); await boot(); }
});

test('compiled Valet lazy page shares navigation and preserves its draft through project refresh and repeat entry', async () => {
  const methods = managementPermissionMethods(), writes = [];
  let settings = { version: 1, scope: 'project', revision: 'r1', groups: MANAGEMENT_GROUPS, methods,
    permissions: Object.fromEntries(methods.map(item => [item.method, item.access])) };
  const project = installProjectDom({ fetch: (url, options = {}) => {
    if (String(url).endsWith('/cli/catalog')) return Response.json(cliCatalog());
    if (String(url).endsWith('/api/management/permissions')) return Response.json(settings);
    const body = options.body && JSON.parse(options.body);
    if (body?.method === 'management.permissions_update') {
      writes.push(body); settings = { ...settings, revision: 'r2', permissions: body.params.permissions,
        methods: settings.methods.map(item => ({ ...item, access: body.params.permissions[item.method] })) };
      return Response.json(settings);
    }
    return world.fetchImpl(url, options);
  } });
  try {
    await boot(); await project.node('cli-interfaces-open').onclick();
    expect(project.node('detail').dataset.view).toBe('cli-interfaces');
    const root = project.node('detail').querySelector('.cli-interfaces-page');
    await root.querySelectorAll('button').find(node => node.textContent === '读取项目权限').onclick();
    root.querySelector('button[data-operation="write"]').onclick();
    const input = root.querySelector('input'); input.value = 'order'; input.oninput({}); root.querySelector('.cli-command-link').onclick();
    const details = root.querySelector('details'); details.open = true;
    const choice = root.querySelectorAll('.cli-permission-method').find(node => node.dataset.method === 'draft.add').querySelector('select');
    choice.value = 'confirmation'; choice.onchange();
    await project.node('cli-interfaces-open').onclick(); expect(project.node('detail').querySelector('.cli-interfaces-page')).toBe(root);
    expect(choice.value).toBe('confirmation'); expect(details.open).toBe(true);
    await root.querySelectorAll('button').find(node => node.textContent === '保存管家默认权限').onclick();
    expect(writes).toHaveLength(1); expect(writes[0].params.expected_revision).toBe('r1');
    expect(writes[0].params.permissions['draft.add']).toBe('confirmation');
    await project.node('side-nav').querySelector('[data-side="valets"]').onclick(); expect(project.node('detail').dataset.view).toBe('valets');
  } finally { project.restore(); await boot(); }
});

test('compiled explicit project owns work chunks while global links preserve its input and reading position', async () => {
  const project = installProjectDom({ fetch: world.fetchImpl });
  try {
    await boot(); expect(project.node('detail').dataset.view).toBe('overview');
    for (const view of ['task-graph', 'inputs', 'hooks']) {
      await project.node(`${view}-open`).onclick(); expect(project.node('detail').dataset.view).toBe(view);
    }
    for (const view of ['tasks', 'valets']) {
      await project.node('side-nav').querySelector(`[data-side="${view}"]`).onclick();
      expect(project.node('detail').dataset.view).toBe(view);
    }
    expect(project.node('versions-open').onclick).toBeUndefined();
    project.node('input').value = 'unsent'; project.node('detail').scrollTop = 120;
    const before = project.node('detail').dataset.view;
    await project.node('settings-open').onclick();
    expect(project.node('settings-open').href).toBe('/#settings'); expect(project.node('settings-open').target).toBe('_blank');
    expect(project.node('detail').dataset.view).toBe(before); expect(project.node('input').value).toBe('unsent'); expect(project.node('detail').scrollTop).toBe(120);
  } finally { project.restore(); await boot(); }
});
