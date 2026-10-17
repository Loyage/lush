import { test, expect } from 'bun:test';
import { fetch, setup } from './harness.js';

const scriptEntries = html => [...html.matchAll(/<script[^>]+src="([^"\n]+)"/g)].map(row => row[1]);
const styleEntries = html => [...html.matchAll(/<link rel="stylesheet" href="([^"\n]+)"/g)].map(row => row[1]);
const staticImports = source => [...source.matchAll(/\b(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)].map(row => row[1]);
const dynamicImports = source => [...source.matchAll(/\bimport\(['"](\.[^'"]+)['"]\)/g)].map(row => row[1]);

test('production startup and complete lazy module graph are served within the cold asset budget', async () => {
  const f = await setup();
  try {
    const page = await fetch(f.url), html = await page.text();
    const scripts = scriptEntries(html), styles = styleEntries(html);
    expect(scripts).toHaveLength(2); expect(styles).toHaveLength(1);
    const seen = new Map(), pending = [...scripts, ...styles], lazy = new Set();
    const collect = async () => {
      while (pending.length) {
        const file = pending.shift(); if (seen.has(file)) continue;
        const response = await fetch(f.url + file); expect(response.status).toBe(200);
        const source = await response.text(); seen.set(file, source);
        if (file.endsWith('.css')) { expect(source).not.toContain('@import'); continue; }
        for (const imported of staticImports(source)) pending.push(new URL(imported, `http://page${file}`).pathname);
        for (const imported of dynamicImports(source)) lazy.add(new URL(imported, `http://page${file}`).pathname);
      }
    };
    await collect(); const cold = new Set(seen.keys());
    expect(cold.size).toBeLessThan(26);
    const coldJs = [...cold].filter(file => file.endsWith('.js'));
    const native = new Set(), nativePending = ['/app.js', '/appearance.js'];
    while (nativePending.length) {
      const file = nativePending.shift(); if (native.has(file)) continue;
      native.add(file); const source = await (await fetch(f.url + file)).text();
      for (const imported of staticImports(source)) nativePending.push(new URL(imported, `http://page${file}`).pathname);
    }
    // Preserve the existing absolute 24-JS cap and 4x native-graph comparison.
    expect(native.size).toBeGreaterThan(50); expect(coldJs.length).toBeLessThan(25);
    expect(coldJs.length).toBeLessThan(native.size / 4);
    const preloads = [...html.matchAll(/<link rel="modulepreload" href="([^"\n]+)"/g)].map(row => row[1]);
    expect(new Set([...scripts, ...styles, ...preloads])).toEqual(cold);
    for (const name of ['render-settings', 'render-agent-status', 'render-inputs', 'render-model-sources', 'render-runners', 'render-project-automation', 'render-valet-settings', 'management-profile-form']) {
      const target = [...lazy].find(file => file.includes(`-${name}-`));
      expect(target).toBeTruthy(); expect(cold.has(target)).toBe(false);
    }
    while ([...lazy].some(file => !seen.has(file))) { pending.push(...lazy); await collect(); }
    expect(seen.size).toBeGreaterThan(cold.size);
    const feature = [...seen.keys()].find(file => file.includes('-automation-feature-pages-'));
    expect(feature).toBeTruthy(); expect(cold.has(feature)).toBe(false);
  } finally { await f.close(); }
});
