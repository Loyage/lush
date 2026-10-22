import { test, expect } from 'bun:test';
import { fetch, setup } from './harness.js';
import { projectRouteId } from '../../src/host/registry.js';
import { WEB_PUSH_PATHS } from '../../src/shared/web-push-protocol.js';

const scriptEntries = html => [...html.matchAll(/<script[^>]+src="([^"\n]+)"/g)].map(row => row[1]);
const styleEntries = html => [...html.matchAll(/<link rel="stylesheet" href="([^"\n]+)"/g)].map(row => row[1]);
const staticImports = source => [...source.matchAll(/\b(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)].map(row => row[1]);
const dynamicImports = source => [...source.matchAll(/\bimport\(['"](\.[^'"]+)['"]\)/g)].map(row => row[1]);

test('production startup and complete lazy module graph are served within the cold asset budget', async () => {
  const f = await setup();
  try {
    const page = await fetch(f.url), html = await page.text();
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("worker-src 'self'");
    expect(page.headers.get('content-security-policy')).toContain("manifest-src 'self'");
    const manifestLink = `<link rel="manifest" href="${WEB_PUSH_PATHS.manifest}">`;
    expect(html).toContain(manifestLink);
    expect(html).toContain('<link rel="apple-touch-icon" href="/pwa/apple-touch-icon.png">');
    const projectPage = await fetch(`${f.url}/p/${projectRouteId(f.config.project)}/`);
    expect(projectPage.status).toBe(200); expect(await projectPage.text()).toContain(manifestLink);
    // Only these fixed, data-free install assets stay available after login expires.
    const manifestResponse = await fetch(f.url + WEB_PUSH_PATHS.manifest, { anonymous: true });
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get('content-type')).toContain('application/manifest+json');
    const manifest = await manifestResponse.json();
    expect([manifest.id, manifest.start_url, manifest.scope]).toEqual(['/', '/', '/']);
    expect(manifest.display).toBe('standalone'); expect(manifest.name).toBe('Lush');
    for (const [file, size] of [...manifest.icons.map(icon => [icon.src, Number(icon.sizes.split('x')[0])]), ['/pwa/apple-touch-icon.png', 180]]) {
      const response = await fetch(f.url + file, { anonymous: true });
      expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/png');
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([size, size]);
    }
    const workerResponse = await fetch(f.url + WEB_PUSH_PATHS.worker, { anonymous: true });
    expect(workerResponse.status).toBe(200);
    expect(workerResponse.headers.get('content-type')).toContain('text/javascript');
    expect(workerResponse.headers.get('cache-control')).toBe('no-store');
    expect(workerResponse.headers.get('service-worker-allowed')).toBe('/');
    const worker = await workerResponse.text();
    expect(worker).toMatch(/addEventListener\(['"]push['"]/); expect(worker).toMatch(/addEventListener\(['"]notificationclick['"]/);
    expect(worker).not.toMatch(/addEventListener\(['"]fetch['"]/); expect(worker).not.toContain('caches.');
    const workerHead = await fetch(f.url + WEB_PUSH_PATHS.worker, { method: 'HEAD', anonymous: true });
    expect(workerHead.status).toBe(200); expect(await workerHead.text()).toBe('');
    expect(Number(workerHead.headers.get('content-length'))).toBe(Buffer.byteLength(worker));
    for (const route of ['/', '/app.js', `/p/${projectRouteId(f.config.project)}/sw.js`, '/pwa/unknown.png']) {
      expect((await fetch(f.url + route, { anonymous: true })).status).toBe(303);
    }
    expect((await fetch(f.url + WEB_PUSH_PATHS.config, { anonymous: true })).status).toBe(401);
    expect((await fetch(f.url + WEB_PUSH_PATHS.worker, { method: 'POST', anonymous: true })).status).toBe(303);
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
    // Keep the shared project-pane sticky edge in the compiled CSS too. Actual geometry
    // (including the global/document fallback) is checked by check-detail-preview-browser.js.
    const css = seen.get(styles[0]);
    expect(css).toContain('--control-height:32px');
    expect(css).toContain('--control-height:44px');
    expect(css).toContain('.section-title>.module-actions');
    expect(css).toContain('--module-mobile-sticky-top:-14px');
    expect(css).toContain('html[data-lush-space="project"] .project-banners { position:static; }');
    expect(css).toContain('top:var(--module-mobile-sticky-top,var(--mobile-header-height))');
    expect(css).toContain('top:calc(var(--module-mobile-sticky-top,var(--mobile-header-height)) + var(--detail-heading-height,48px))');
    expect(css).toContain('top:var(--module-mobile-sticky-top,calc(var(--mobile-header-height,53px) + var(--versions-banner-height,0px)))');
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
    for (const name of ['render-settings', 'render-skills', 'render-agent-status', 'render-inputs', 'render-model-sources', 'render-project-automation', 'render-valet-settings', 'administrator-page', 'management-profile-form']) {
      const target = [...lazy].find(file => file.includes(`-${name}-`));
      expect(target).toBeTruthy(); expect(cold.has(target)).toBe(false);
    }
    while ([...lazy].some(file => !seen.has(file))) { pending.push(...lazy); await collect(); }
    expect(seen.size).toBeGreaterThan(cold.size);
    const feature = [...seen.keys()].find(file => file.includes('-automation-feature-pages-'));
    expect(feature).toBeTruthy(); expect(cold.has(feature)).toBe(false);
  } finally { await f.close(); }
});
