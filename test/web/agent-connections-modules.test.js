import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStaticAssets } from '../../src/ui/web/static-assets.js';

const assets = new URL('../../src/ui/web/assets/', import.meta.url);
const modules = ['connection-view-common.js', 'connection-resources.js', 'connection-directory.js',
  'connection-reminders.js', 'connection-archive.js', 'connection-editor.js', 'connection-login.js'];
const imports = source => [...source.matchAll(/\b(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)].map(match => match[1]);

test('connection-specific modules form an acyclic graph with no imports back into the page coordinator', () => {
  const visited = new Set(), stack = new Set();
  function visit(name) {
    expect(stack.has(name)).toBe(false);
    if (visited.has(name)) return;
    stack.add(name);
    const source = fs.readFileSync(new URL(name, assets), 'utf8');
    for (const specifier of imports(source)) {
      const target = path.basename(specifier);
      if (!modules.includes(name)) continue;
      expect(target).not.toBe('render-agent-connections.js');
      expect(target).not.toBe('render-model-sources.js');
      if (modules.includes(target)) visit(target);
    }
    stack.delete(name); visited.add(name);
  }
  for (const name of modules) visit(name);
  expect(visited.size).toBe(modules.length);
});

test('automatic asset discovery ships every new legacy module and the built model-sources lazy graph', async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-connections-assets-'));
  try {
    const delivery = createStaticAssets({ cache });
    const response = name => delivery.response(name, new Request(`http://localhost${name}`), {});
    for (const name of modules) {
      const shipped = response(`/${name}`);
      expect(shipped?.status).toBe(200);
      expect(shipped.headers.get('cache-control')).toBe('no-store');
      expect(await shipped.text()).toBe(fs.readFileSync(new URL(name, assets), 'utf8'));
    }
    const html = await response('/').text(), pending = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
    const seen = new Map(); let modelSources = '';
    while (pending.length) {
      const name = pending.pop(); if (seen.has(name)) continue;
      const shipped = response(name); expect(shipped?.status).toBe(200);
      const source = await shipped.text(); seen.set(name, source);
      for (const specifier of [...imports(source), ...[...source.matchAll(/\bimport\(['"](\.[^'"]+)['"]\)/g)].map(match => match[1])]) {
        const target = new URL(specifier, `http://localhost${name}`).pathname;
        if (target.includes('-render-model-sources-')) modelSources = target;
        pending.push(target);
      }
    }
    expect(modelSources).not.toBe('');
    // Follow just the lazy page's static closure, not unrelated pages with similar copy.
    const closure = new Set(), chunks = [], queue = [modelSources];
    while (queue.length) {
      const name = queue.pop(); if (closure.has(name)) continue;
      closure.add(name); const source = seen.get(name); expect(source).toBeString(); chunks.push(source);
      for (const specifier of imports(source)) queue.push(new URL(specifier, `http://localhost${name}`).pathname);
    }
    expect(chunks.join('\n')).toContain('device_login_invalid_response');
    expect(chunks.join('\n')).toContain('已到重置时间，待刷新');
    expect(response('/assets/connection-login.js')).toBeNull();
  } finally { fs.rmSync(cache, { recursive: true, force: true }); }
});
