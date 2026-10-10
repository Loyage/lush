import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildAssets } from '../../src/ui/web/build-assets.js';
import { temp } from '../helpers.js';

test('shared chunk folding preserves entry namespaces, live state and lazy side-effect ordering', async () => {
  const root = temp(), marker = `lush-lazy-${randomUUID()}`;
  try {
    const assets = path.join(root, 'assets'), output = path.join(root, 'output');
    fs.mkdirSync(assets); fs.mkdirSync(output);
    const source = (name, text) => fs.writeFileSync(path.join(assets, name), text);
    source('index.html', '<head><script src="/appearance.js" type="module"></script><link rel="stylesheet" href="/styles.css"><script src="/app.js" type="module"></script></head>');
    source('styles.css', 'body{color:inherit}');
    source('state.js', 'export let count=0; export function read(){return count} export function bump(){return ++count}');
    source('app.js', 'export {read as readCount,bump as bumpCount} from "./state.js"; export const open=()=>import("./later.js");');
    source('appearance.js', 'import {bump} from "./state.js"; bump();');
    source('later.js', `import {bump} from "./state.js"; globalThis[${JSON.stringify(marker)}]=true; bump(); export {read as readCount} from "./state.js";`);
    await buildAssets(assets, output, 'b'.repeat(32));
    const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
    const entries = [...html.matchAll(/<script[^>]+src="\/([^"\n]+)"/g)].map(x => x[1]);
    const preloads = [...html.matchAll(/<link rel="modulepreload" href="\/([^"\n]+)"/g)].map(x => x[1]);
    const lazy = fs.readdirSync(output).find(x => x.includes('-later-'));
    expect(lazy).toBeTruthy(); expect(preloads).not.toContain(lazy);
    const load = name => import(pathToFileURL(path.join(output, name)).href);
    const app = await load(entries.find(x => x.includes('-app-')));
    expect(Object.keys(app).sort()).toEqual(['bumpCount', 'open', 'readCount']);
    expect(app.readCount()).toBe(0); expect(globalThis[marker]).toBeUndefined();
    await load(entries.find(x => x.includes('-appearance-')));
    expect(app.readCount()).toBe(1); expect(globalThis[marker]).toBeUndefined();
    const later = await app.open();
    expect(globalThis[marker]).toBe(true); expect(app.readCount()).toBe(2);
    app.bumpCount(); expect(later.readCount()).toBe(3);
    expect(await app.open()).toBe(later); expect(app.readCount()).toBe(3);
  } finally { delete globalThis[marker]; fs.rmSync(root, { recursive: true, force: true }); }
});
