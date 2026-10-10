import { test, expect } from 'bun:test';
import { fetch, setup } from './harness.js';

// HTTP 只验证发货与安全契约；交互由 DOM 测试、视觉排版由按需浏览器脚本负责。
const scriptEntries = html => [...html.matchAll(/<script[^>]+src="([^"\n]+)"/g)].map(row => row[1]);
const styleEntries = html => [...html.matchAll(/<link rel="stylesheet" href="([^"\n]+)"/g)].map(row => row[1]);
const staticImports = source => [...source.matchAll(/\b(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)].map(row => row[1]);
const dynamicImports = source => [...source.matchAll(/\bimport\(['"](\.[^'"]+)['"]\)/g)].map(row => row[1]);

test('production startup and lazy module graphs are served with CSP; unknown paths stay closed', async () => {
  const f = await setup();
  try {
    const page = await fetch(f.url), html = await page.text();
    expect(page.headers.get('cache-control')).toBe('no-store');
    const scripts = scriptEntries(html), styles = styleEntries(html);
    expect(scripts).toHaveLength(2); expect(styles).toHaveLength(1);
    const seen = new Map(), pending = [...scripts, ...styles], lazy = new Set();
    const collect = async () => {
      while (pending.length) {
        const file = pending.shift();
        if (seen.has(file)) continue;
        expect(file).toMatch(/^\/web-[a-f0-9]{32}-[A-Za-z0-9._-]+\.(?:js|css)$/);
        const response = await fetch(f.url + file);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-security-policy')).toBe(page.headers.get('content-security-policy'));
        expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
        expect(response.headers.get('content-type')).toBe(file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
        const source = await response.text(); seen.set(file, source);
        if (file.endsWith('.css')) { expect(source).not.toContain('@import'); continue; }
        for (const imported of staticImports(source)) pending.push(new URL(imported, `http://page${file}`).pathname);
        for (const imported of dynamicImports(source)) lazy.add(new URL(imported, `http://page${file}`).pathname);
      }
    };
    await collect();
    const cold = new Set(seen.keys());
    expect(cold.size).toBeLessThan(26);
    const preloads = [...html.matchAll(/<link rel="modulepreload" href="([^"\n]+)"/g)].map(row => row[1]);
    expect(new Set([...scripts, ...styles, ...preloads])).toEqual(cold);
    for (const name of ['render-settings', 'render-agent-status', 'render-versions', 'render-inputs', 'render-model-sources']) {
      const target = [...lazy].find(file => file.includes(`-${name}-`));
      expect(target).toBeTruthy(); expect(cold.has(target)).toBe(false);
    }
    // Follow the actual generated dynamic graph too: no missing late chunk after navigation.
    while ([...lazy].some(file => !seen.has(file))) { pending.push(...lazy); await collect(); }
    expect(seen.size).toBeGreaterThan(cold.size);
    for (const file of ['/live.mjs', '/index.html', '/assets/app.js', '/.secret.js', '/server.js']) {
      const rejected = await fetch(f.url + file);
      expect(rejected.status).toBe(404); expect(rejected.headers.get('cache-control')).toBe('no-store');
    }
    // Pre-bundle HTML and pinned runtime vendors retain their no-store basename paths.
    for (const file of ['/live.js', '/help.js', '/messages.js', '/render-settings.js', '/tree-order.js', '/styles-code.css']) {
      const legacy = await fetch(f.url + file);
      expect(legacy.status).toBe(200); expect(legacy.headers.get('cache-control')).toBe('no-store');
    }
  } finally { await f.close(); }
});

test('HTML ships startup controls, read-only navigation and collapsed composer', async () => {
  const f = await setup();
  try {
    const html = await (await fetch(f.url)).text();
    const appearance = scriptEntries(html).find(file => /-appearance-[A-Za-z0-9]+\.js$/.test(file));
    const app = scriptEntries(html).find(file => /-app-[A-Za-z0-9]+\.js$/.test(file));
    const [stylesheet] = styleEntries(html);
    expect(appearance).toBeTruthy(); expect(app).toBeTruthy(); expect(stylesheet).toBeTruthy();
    expect(html).toContain(`<script src="${appearance}" type="module"></script>`);
    expect(html.indexOf(appearance)).toBeLessThan(html.indexOf(stylesheet));
    expect(html.indexOf(stylesheet)).toBeLessThan(html.indexOf(app));
    for (const id of ['sidebar', 'home', 'project', 'connection', 'theme-toggle', 'sidebar-sort', 'settings-open',
      'notice-banner', 'toast', 'error', 'toast-close', 'modal', 'input-parent', 'draft-commit']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('action="/logout"');
    expect(html).toMatch(/<div id="composer-details"[^>]*hidden/);
    expect(html).toMatch(/id="composer-expand"[^>]*aria-expanded="false"[^>]*aria-controls="composer-details"/);
    expect(html).toMatch(/id="draft-commit"[^>]*class="agent-call">创建 Worker/);
    expect(html).toMatch(/id="composer-mode"[^>]*role="status"[^>]*aria-live="polite"/);
    expect(html).toMatch(/id="input"[^>]*aria-describedby="composer-mode-title composer-mode-target composer-mode-behavior"/);
    expect(html).not.toContain('input-highlight');
    expect(html).not.toContain('id="input-direct"');
  } finally { await f.close(); }
});

test('styles retain Agent-call visibility, both themes and system/application reduced motion', async () => {
  const f = await setup();
  try {
    const html = await (await fetch(f.url)).text();
    const styles = styleEntries(html); expect(styles).toHaveLength(1);
    const css = await (await fetch(f.url + styles[0])).text();
    expect(css).not.toContain('@import');
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toMatch(/\.composer\{[^}]*background:var\(--accent-soft\)/);
    expect(css).toMatch(/\.composer form\{[^}]*margin:0 auto\}/);
    expect(css).toMatch(/#input-form \.composer-input textarea\{[^}]*border:2px solid var\(--accent\)/);
    expect(css).toMatch(/#input-form\[data-mode="append"\] \.composer-input textarea\{[^}]*border-style:dashed/);
    expect(css).toMatch(/#input-form \.composer-input textarea:focus\{[^}]*outline:none;[^}]*border-width:3px/);
    expect(css).toMatch(/#input-form\[data-mode="append"\] \.composer-mode-target\{[^}]*flex-basis:100%;[^}]*font-weight:700/);
    expect(css).not.toContain('--mode-color');
    expect(css).not.toContain('border-left:3px solid var(--queued)');
    expect(css).toContain('.composer-mode-behavior{flex-basis:100%}');
    expect(css).toMatch(/button\.agent-call\s*\{[^}]*var\(--violet-ink\)/);
    expect(css).toMatch(/\.help-host\s*\{[^}]*display:\s*contents/);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*animation:\s*none!important/);
    expect(css).toMatch(/:root\[data-reduced-motion="true"\][^{]*\{[^}]*animation:\s*none!important/);
  } finally { await f.close(); }
});

test('代码高亮资源随代码发布、按扩展名服务并登记版本与哈希', async () => {
  const f = await setup();
  try {
    const asset = await fetch(f.url + '/highlight.min.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await asset.text()).toContain('Highlight.js v11.11.1');
    const module = await fetch(f.url + '/code-highlight.js');
    expect(module.status).toBe(200);
    expect(await module.text()).toContain('export function enhanceCode');
    const license = await Bun.file(new URL('../../src/ui/web/assets/highlight-LICENSE.txt', import.meta.url)).text();
    expect(license).toContain('Highlight.js 11.11.1');
    expect(license).toContain('c4a399dd6f488bc97a3546e3476747b3e714c99c57b9473154c6fb8d259b9381');
  } finally { await f.close(); }
});
