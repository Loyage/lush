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
const world = makeWorld(), dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import(pathToFileURL(path.join(root, app)).href);
afterAll(() => { dom.restore(); fs.rmSync(root, { recursive: true, force: true }); });

test('compiled root workbench loads global lazy pages with shared navigation state', async () => {
  expect(dom.node('detail').dataset.view).toBe('projects');
  for (const [view, hash] of [['settings', 'settings'], ['agent-status', 'agent-status'], ['model-sources', 'model-sources'], ['automation', 'automation'], ['global-inbox', 'notices']]) {
    await dom.node(`${view}-open`).onclick();
    expect(dom.node('detail').dataset.view).toBe(view); expect(dom.location.hash).toBe(`#${hash}`);
    expect(dom.node(`${view}-open`).getAttribute('aria-current')).toBe('page');
  }
  await dom.node('projects-open').onclick(); expect(dom.node('detail').dataset.view).toBe('projects');
});

test('compiled project boot owns work pages and opens device settings separately', async () => {
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
    project.node('input').value = 'unsent'; project.node('detail').scrollTop = 120;
    await project.node('settings-open').onclick();
    expect(project.node('settings-open').href).toBe('/#settings'); expect(project.node('settings-open').target).toBe('_blank');
    expect(project.node('input').value).toBe('unsent'); expect(project.node('detail').scrollTop).toBe(120);
  } finally { project.restore(); await boot(); }
});
