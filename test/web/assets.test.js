import { test, expect } from 'bun:test';
import { fetch, setup } from './harness.js';

// HTTP 只验证发货与安全契约；交互由 DOM 测试、视觉排版由按需浏览器脚本负责。
test('startup module graph and imported styles are served with CSP; unknown extensions stay closed', async () => {
  const f = await setup();
  try {
    const seen = new Set(), pending = ['/app.js', '/appearance.js', '/styles.css'];
    while (pending.length) {
      const file = pending.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      const response = await fetch(f.url + file);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
      const source = await response.text();
      const imports = file.endsWith('.css') ? /@import\s+url\(['"]?(\.[^'"\)]+)['"]?\)/g
        : /(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g;
      for (const match of source.matchAll(imports)) pending.push(new URL(match[1], `http://page${file}`).pathname);
    }
    for (const file of ['/live.js', '/help.js', '/messages.js', '/render-settings.js', '/tree-order.js', '/styles-code.css']) {
      expect(seen.has(file)).toBe(true);
    }
    expect((await fetch(f.url + '/live.mjs')).status).toBe(404);
  } finally { await f.close(); }
});

test('HTML ships startup controls, read-only navigation and collapsed composer', async () => {
  const f = await setup();
  try {
    const html = await (await fetch(f.url)).text();
    expect(html).toMatch(/<script src="\/appearance\.js" type="module"><\/script>/);
    expect(html.indexOf('/appearance.js')).toBeLessThan(html.indexOf('/styles.css'));
    for (const id of ['sidebar', 'home', 'project', 'connection', 'theme-toggle', 'sidebar-sort', 'settings-open',
      'notice-banner', 'toast', 'error', 'toast-close', 'modal', 'input-parent', 'draft-commit']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('action="/logout"');
    expect(html).toMatch(/<div id="composer-details"[^>]*hidden/);
    expect(html).toMatch(/id="composer-expand"[^>]*aria-expanded="false"[^>]*aria-controls="composer-details"/);
    expect(html).toMatch(/id="draft-commit"[^>]*class="agent-call"/);
    expect(html).not.toContain('input-highlight');
    expect(html).not.toContain('id="input-direct"');
  } finally { await f.close(); }
});

test('styles retain Agent-call visibility, both themes and system/application reduced motion', async () => {
  const f = await setup();
  try {
    const css = await (await fetch(f.url + '/styles.css')).text();
    expect(css).toContain(':root[data-theme="dark"]');
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
