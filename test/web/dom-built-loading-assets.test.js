import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildAssets } from '../../src/ui/web/build-assets.js';
import { installDom } from '../dom-stub.js';
import { installDom as installProjectDom } from './project-dom.js';
import { makeWorld } from './dom-world.js';
import { temp } from '../helpers.js';
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

test('compiled explicit project owns work chunks while global links preserve its input and reading position', async () => {
  const project = installProjectDom({ fetch: world.fetchImpl });
  try {
    await boot(); expect(project.node('detail').dataset.view).toBe('overview');
    for (const view of ['versions', 'inputs', 'hooks']) {
      await project.node(`${view}-open`).onclick(); expect(project.node('detail').dataset.view).toBe(view);
    }
    project.node('input').value = 'unsent'; project.node('detail').scrollTop = 120;
    const before = project.node('detail').dataset.view;
    await project.node('settings-open').onclick();
    expect(project.node('settings-open').href).toBe('/#settings'); expect(project.node('settings-open').target).toBe('_blank');
    expect(project.node('detail').dataset.view).toBe(before); expect(project.node('input').value).toBe('unsent'); expect(project.node('detail').scrollTop).toBe(120);
  } finally { project.restore(); await boot(); }
});
