import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildAssets } from '../../src/ui/web/build-assets.js';
import { installDom } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { temp } from '../helpers.js';

const root = temp(), assets = fileURLToPath(new URL('../../src/ui/web/assets/', import.meta.url));
await buildAssets(assets, root, 'a'.repeat(32));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = html.match(/src="\/([^"\n]+-app-[^"\n]+\.js)"/)[1];
const dom = installDom({ fetch: makeWorld().fetchImpl });
const { boot } = await import(pathToFileURL(path.join(root, app)).href);
afterAll(() => { dom.restore(); fs.rmSync(root, { recursive: true, force: true }); });

test('actual Bun browser output boots and lazy chunks share the same UI/navigation state', async () => {
  expect(dom.node('detail').dataset.view).toBe('overview');
  for (const view of ['settings', 'agent-status', 'versions', 'inputs', 'hooks', 'model-sources']) {
    await dom.node(`${view}-open`).onclick();
    expect(dom.node('detail').dataset.view).toBe(view);
    expect(dom.location.hash).toBe(`#${view}`);
    expect(dom.node(`${view}-open`).getAttribute('aria-current')).toBe('page');
  }
  await dom.node('overview-open').onclick();
  expect(dom.node('detail').dataset.view).toBe('overview');
  expect(dom.location.hash).toBe('');
});

test('compiled boot export remains repeatable and settles dynamic deep links', async () => {
  dom.location.hash = '#settings';
  await boot(); await boot();
  expect(dom.node('detail').dataset.view).toBe('settings');
  expect(dom.node('detail').querySelector('button.settings-tab')).toBeTruthy();
  expect(typeof dom.intervalFor(1500)).toBe('function');
  expect(typeof dom.intervalFor(3000)).toBe('function');
});
