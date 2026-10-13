import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createStaticAssets } from '../../src/ui/web/static-assets.js';
import { temp } from '../helpers.js';

const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const modules = ['render-settings.js', 'settings-agent.js', 'settings-controls.js', 'settings-environment.js',
  'settings-interface.js', 'settings-packages.js', 'settings-profile.js', 'settings-profile-resources.js', 'settings-system.js'];
const imports = source => [...source.matchAll(/\b(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)].map(row => row[1]);
const dynamicImports = source => [...source.matchAll(/\bimport\(['"](\.[^'"]+)['"]\)/g)].map(row => row[1]);

test('settings entry retains its exports and dedicated editors form an acyclic graph', () => {
  const entry = fs.readFileSync(path.join(assets, 'render-settings.js'), 'utf8');
  expect(new Bun.Transpiler({ loader: 'js' }).scan(entry).exports.sort()).toEqual(['openSettings', 'renderAgentSettings', 'renderSettings']);
  const visited = new Set(), active = new Set();
  function visit(name) {
    expect(active.has(name)).toBe(false);
    if (visited.has(name)) return;
    active.add(name);
    for (const imported of imports(fs.readFileSync(path.join(assets, name), 'utf8'))) {
      const target = path.basename(imported);
      if (modules.includes(target)) visit(target);
    }
    active.delete(name); visited.add(name);
  }
  visit('render-settings.js');
  expect([...visited].sort()).toEqual([...modules].sort());
});

test('all extracted settings modules are auto-discovered legacy assets and the built lazy graph resolves', async () => {
  const root = temp();
  try {
    const bundle = createStaticAssets({ cache: path.join(root, 'cache') });
    const serve = file => bundle.response(file, new Request(`http://fixture${file}`), {});
    for (const name of modules) {
      const response = serve(`/${name}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe(fs.readFileSync(path.join(assets, name), 'utf8'));
    }
    const html = await serve('/').text();
    const pending = [...html.matchAll(/<script[^>]+src="([^"\n]+)"/g)].map(row => row[1]);
    const seen = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const response = serve(file);
      expect(response?.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
      const source = await response.text();
      for (const imported of [...imports(source), ...dynamicImports(source)]) {
        pending.push(new URL(imported, `http://fixture${file}`).pathname);
      }
    }
    expect([...seen].some(file => /-render-settings-/.test(file))).toBe(true);
    expect([...seen].some(file => /-render-agent-status-/.test(file))).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
