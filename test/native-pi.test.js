import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadNativePi, resolveNativePi } from '../src/cli/native-pi.js';

function installation({ compatible = true, incomplete = false, layout = 'global' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-native-pi-'));
  const pkg = layout === 'adjacent' ? path.join(root, 'bin', 'node_modules', '@earendil-works', 'pi-coding-agent')
    : path.join(root, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const write = (filename, text) => { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, text); };
  write(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', type: 'module',
    exports: { '.': { import: './dist/index.js' } }, dependencies: { '@earendil-works/pi-tui': '1', ...(incomplete ? { 'missing-required': '1' } : {}) } }));
  const names = ['Read', 'Bash', 'Edit', 'Write', 'Grep', 'Find', 'Ls'];
  write(path.join(pkg, 'dist/index.js'), compatible ? `
    export class AssistantMessageComponent {} export class UserMessageComponent {} export class ToolExecutionComponent {}
    export function initTheme(name, watcher) { if(name !== 'system' || watcher) throw Error('unsafe theme'); }
    export function createAgentSession() { throw Error('viewer cannot create Agent'); }
    ${names.map(name => `export function create${name}ToolDefinition() { return {
      execute() { throw Error('viewer cannot execute'); }, renderShell: 'default',
      renderCall(args, theme, context) { if (context.argsComplete) throw Error('live file preview'); return {render:()=>['native ${name}']}; },
      renderResult() { return {render:()=>['native result']}; }
    }; }`).join('\n')}
  ` : 'export const obsolete = true;');
  const tui = path.join(pkg, 'node_modules', '@earendil-works', 'pi-tui');
  write(path.join(tui, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-tui', type: 'module', main: 'index.js' }));
  write(path.join(tui, 'index.js'), `
    export class ProcessTerminal {} export class TuiMainScreen {}
    export class Text { constructor(text){this.text=text;} render(){return [this.text];} }
    export class Container { constructor(){this.children=[];} addChild(c){this.children.push(c);} render(w){return this.children.flatMap(c=>c.render(w));} }
    export function matchesKey() {} export function truncateToWidth() {} export function visibleWidth() {}
  `);
  write(path.join(pkg, 'dist/bundle/cli.js'), '#!/bin/sh\nexit 99\n'); fs.chmodSync(path.join(pkg, 'dist/bundle/cli.js'), 0o755);
  const bin = path.join(root, 'bin/pi'); fs.mkdirSync(path.dirname(bin), { recursive: true });
  if (layout === 'adjacent') { write(bin, '#!/bin/sh\nexit 99\n'); fs.chmodSync(bin, 0o755); }
  else fs.symlinkSync(path.relative(path.dirname(bin), path.join(pkg, 'dist/bundle/cli.js')), bin);
  return { root, pkg, bin, env: { PATH: path.dirname(bin) }, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('offline symlink/npm global and import-only public export discovery', async () => {
  const f = installation();
  try {
    expect(resolveNativePi(f.env)).toBe(path.join(f.pkg, 'dist/index.js'));
    const runtime = await loadNativePi(f.env);
    expect(runtime.pi.createAgentSession).toBeFunction();
    expect([...runtime.renderers.keys()]).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
    for (const renderer of runtime.renderers.values()) {
      expect(Object.keys(renderer).sort()).toEqual(['renderCall', 'renderResult', 'renderShell']);
      expect(renderer.execute).toBeUndefined();
    }
    const context = { argsComplete: true, state: {}, lastComponent: undefined };
    expect(runtime.renderers.get('edit').renderCall({ path: 'no-live-file', edits: [] }, {}, context).render(80).join('\n')).toContain('native Edit');
    expect(runtime.renderers.get('edit').renderResult({ content: [{ text: 'historical output' }] }).render()).toEqual(['historical output']);
    expect(fs.existsSync(path.join(f.root, '.pi'))).toBe(false);
  } finally { f.dispose(); }
});

test('configured executable and bundle-adjacent node_modules discovery without running binary', async () => {
  const f = installation({ layout: 'adjacent' });
  try {
    const runtime = await loadNativePi({ PATH: '', LUSH_PI_COMMAND: f.bin });
    expect(runtime.entry).toBe(path.join(f.pkg, 'dist/index.js'));
  } finally { f.dispose(); }
});

test('missing executable/module and standalone binary give friendly offline errors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-native-missing-'));
  try {
    const bin = path.join(root, 'pi'); fs.writeFileSync(bin, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    for (const env of [{ PATH: '' }, { PATH: '', LUSH_PI_COMMAND: bin }, { PATH: '', LUSH_PI_COMMAND: 'custom-command --probe; touch marker' }]) {
      await expect(loadNativePi(env)).rejects.toThrow('可导入的 Pi npm');
    }
    expect(fs.readdirSync(root)).toEqual(['pi']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('incompatible or incomplete installations are refused without importing unknown execution code', async () => {
  for (const args of [{ compatible: false }, { incomplete: true }]) {
    const f = installation(args);
    try { await expect(loadNativePi(f.env)).rejects.toThrow('不兼容'); }
    finally { f.dispose(); }
  }
});
