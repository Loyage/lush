import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { scanDirectoryResources, scanPackageResources, discoverAgentResources } from '../../src/agent/resources.js';
import { Config } from '../../src/config.js';
import { env, temp } from '../helpers.js';

function fixture(run) {
  const root = temp();
  const file = (name, content = 'throw new Error("resource discovery must not execute code");') => {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  };
  const manifest = (name, value) => file(name, JSON.stringify(value));
  try { return run({ root, file, manifest }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const paths = rows => rows.map(row => row.id).sort();

test('declared dist directory exposes index, not standalone MCP or helper programs', () => fixture(({ root, file, manifest }) => {
  manifest('package.json', { pi: { extensions: ['./dist'] } });
  const index = file('dist/index.js');
  file('dist/mcp-cli.js'); file('dist/helper.js');
  expect(paths(scanPackageResources(root).extensions)).toEqual([index]);
  expect(paths(scanDirectoryResources(path.join(root, 'dist'), 'extension', 'test'))).toEqual([index]);
}));

test('index.ts takes precedence over index.js and siblings in resource roots', () => fixture(({ root, file }) => {
  const index = file('extensions/index.ts');
  file('extensions/index.js'); file('extensions/cli.js');
  expect(paths(scanDirectoryResources(path.join(root, 'extensions'), 'extension', 'test'))).toEqual([index]);
}));

test('ordinary extension collections preserve multiple files and subdirectory entry points', () => fixture(({ root, file, manifest }) => {
  const first = file('extensions/first.ts'), second = file('extensions/second.js');
  const entry = file('extensions/nested/index.ts'); file('extensions/nested/helper.ts');
  manifest('extensions/pack/package.json', { pi: { extensions: ['./src/tool.ts'] } });
  const packed = file('extensions/pack/src/tool.ts'); file('extensions/pack/cli.js');
  file('extensions/no-entry/helper.ts'); file('extensions/.hidden.ts'); file('extensions/node_modules/tool.ts');
  expect(paths(scanPackageResources(root).extensions)).toEqual([first, second, entry, packed].sort());
}));

test('explicit file and glob manifests remain authoritative, including exclusions and empty lists', () => fixture(({ root, file, manifest }) => {
  const first = file('dist/first.ts'), second = file('dist/second.ts'); file('dist/cli.js');
  file('extensions/accidental.ts');
  manifest('package.json', { pi: { extensions: ['./dist/*.ts', '!dist/second.ts'] } });
  expect(paths(scanPackageResources(root).extensions)).toEqual([first]);
  manifest('package.json', { pi: { extensions: ['./dist/second.ts'] } });
  expect(paths(scanPackageResources(root).extensions)).toEqual([second]);
  for (const extensions of [[], ['./missing.ts'], ['./dist/*.ts', '!dist/*.ts']]) {
    manifest('package.json', { pi: { extensions } });
    expect(scanPackageResources(root).extensions).toEqual([]);
  }
}));

test('declared directories without index still expose their independent extension entries', () => fixture(({ root, file, manifest }) => {
  manifest('package.json', { pi: { extensions: ['./tools'] } });
  const first = file('tools/first.ts'), second = file('tools/second.js');
  expect(paths(scanPackageResources(root).extensions)).toEqual([first, second].sort());
}));

test('cyclic directory manifests are bounded and do not hide other declared entries', () => fixture(({ root, file, manifest }) => {
  manifest('package.json', { pi: { extensions: ['./nested'] } });
  manifest('nested/package.json', { pi: { extensions: ['..', './tool.ts'] } });
  const tool = file('nested/tool.ts');
  expect(paths(scanPackageResources(root).extensions)).toEqual([tool]);
}));

test('legacy resource catalog uses the same package entry resolution without executing plugins', async () => {
  const root = temp();
  try {
    const config = new Config({ project: root, env: env() }); config.prepare();
    const pkg = path.join(root, 'web-access');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ pi: { extensions: ['./dist'] } }));
    const index = path.join(pkg, 'dist/index.js');
    fs.writeFileSync(index, 'throw new Error("never execute");');
    fs.writeFileSync(path.join(pkg, 'dist/mcp-cli.js'), 'process.exit(0);');
    const result = await discoverAgentResources(config, { packages: [{ root: pkg, source: 'npm:example@1.0.0' }] });
    expect(paths(result.extensions)).toEqual([index]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
