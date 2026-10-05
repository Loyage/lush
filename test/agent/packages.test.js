import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../../src/config.js';
import {
  AgentPackages, PackageCommandError, classifyPackageSource, normalizePackageSource,
  packageEnvironment, parseInstalledPackages, spawnPackageCommand,
} from '../../src/agent/packages.js';
import { env, gate, temp, until } from '../helpers.js';

function fixture(extra = {}) {
  const root = temp(), config = new Config({ project: root, env: env(extra) }); config.prepare();
  return { root, config, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

function privatePi(config, settings) {
  const dir = path.join(config.home, 'pi');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  if (settings !== undefined) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
  return dir;
}

function fakeRun(handler) {
  const calls = [];
  const run = async options => { calls.push(options); return handler(options); };
  return { calls, run };
}

function localPackage(root, name = 'lush-test-pkg') {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'skills', 'hello'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '3.1.4', keywords: ['pi-package'], pi: { extensions: ['./ext.ts'], skills: ['./skills'] } }));
  fs.writeFileSync(path.join(dir, 'ext.ts'), 'export default {};\n');
  fs.writeFileSync(path.join(dir, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: says hello\n---\nbody\n');
  return dir;
}

test('package sources require pinned npm versions and pinned git refs', () => {
  expect(classifyPackageSource('npm:left-pad@1.2.3')).toMatchObject({ kind: 'npm', name: 'left-pad', version: '1.2.3', requested: '1.2.3' });
  expect(classifyPackageSource('npm:@scope/tools@0.4.0-rc.1')).toMatchObject({ kind: 'npm', name: '@scope/tools', requested: '0.4.0-rc.1' });
  for (const bad of ['npm:left-pad', 'npm:left-pad@^1.0.0', 'npm:left-pad@latest', 'npm:@scope/tools@1.x']) {
    expect(() => classifyPackageSource(bad)).toThrow('pin an exact version');
  }
  expect(classifyPackageSource('git:github.com/owner/repo@v1.2.0')).toMatchObject({ kind: 'git', ref: 'v1.2.0' });
  expect(classifyPackageSource('https://github.com/owner/repo@abc1234')).toMatchObject({ kind: 'git', ref: 'abc1234' });
  expect(classifyPackageSource('git:github.com/owner/repo#v2')).toMatchObject({ kind: 'git', ref: 'v2' });
  for (const bad of ['git:github.com/owner/repo', 'https://github.com/owner/repo', 'git:github.com/owner/repo@']) {
    expect(() => classifyPackageSource(bad)).toThrow('explicit ref');
  }
  for (const bad of ['github:owner/repo', 'left-pad', 'weird source!!', 'git@github.com:owner/repo', 'npm:', '  ', 'a\u0000b']) {
    expect(() => classifyPackageSource(bad)).toThrow();
  }
});

test('local package paths resolve to an existing absolute directory', () => {
  const f = fixture();
  try {
    const dir = localPackage(f.root);
    expect(normalizePackageSource('./lush-test-pkg', { project: f.root })).toMatchObject({ kind: 'local', source: fs.realpathSync(dir), install: fs.realpathSync(dir) });
    expect(() => normalizePackageSource('./missing-package', { project: f.root })).toThrow('does not exist');
    const file = path.join(dir, 'package.json');
    expect(() => normalizePackageSource(file, { project: f.root })).toThrow('must be a directory');
  } finally { f.close(); }
});

test('pi list output maps configured sources to installed roots', () => {
  const output = ['User packages:', '  npm:@scope/tools@1.0.0', '    /x/pi/npm/node_modules/@scope/tools',
    '  ../local-pkg', '    /x/local-pkg', '  npm:uninstalled@2.0.0 (filtered)', '', 'No project packages.'].join('\n');
  expect(parseInstalledPackages(output)).toEqual([
    { source: 'npm:@scope/tools@1.0.0', root: '/x/pi/npm/node_modules/@scope/tools' },
    { source: '../local-pkg', root: '/x/local-pkg' },
    { source: 'npm:uninstalled@2.0.0', root: null },
  ]);
  expect(parseInstalledPackages('No packages installed.')).toEqual([]);
});

test('package command environment is private, credential-free and never offline', () => {
  const f = fixture({ OPENAI_API_KEY: 'sk-secret', PI_PACKAGE_DIR: '/somewhere/else', PI_OFFLINE: '1', HTTPS_PROXY: 'http://proxy.example:8080' });
  try {
    const dir = privatePi(f.config);
    const value = packageEnvironment(f.config);
    expect(value.PI_CODING_AGENT_DIR).toBe(dir);
    expect(value.OPENAI_API_KEY).toBeUndefined();
    expect(value.PI_OFFLINE).toBeUndefined();
    expect(value.PI_PACKAGE_DIR).toBeUndefined();
    expect(value.PI_TELEMETRY).toBe('0');
    expect(value.PI_SKIP_VERSION_CHECK).toBe('1');
  } finally { f.close(); }
});

test('list reads config declarations plus installed package resources without a model call', async () => {
  const f = fixture();
  try {
    const dir = privatePi(f.config, { packages: ['npm:@scope/tools@1.0.0', './lush-test-pkg',
      { source: 'git:github.com/owner/repo@v1', skills: [] }] });
    const local = localPackage(f.root);
    const npmRoot = path.join(dir, 'npm', 'node_modules', '@scope', 'tools');
    fs.mkdirSync(path.join(npmRoot, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({ name: '@scope/tools', version: '1.0.0' }));
    fs.writeFileSync(path.join(npmRoot, 'extensions', 'tool.ts'), 'export default {};\n');
    const runner = fakeRun(() => ['User packages:', '  npm:@scope/tools@1.0.0', `    ${npmRoot}`,
      '  ./lush-test-pkg', `    ${local}`, '  git:github.com/owner/repo@v1'].join('\n'));
    const manager = new AgentPackages(f.config, { run: runner.run });
    const view = await manager.list();
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].args).toEqual(['list', '--no-approve']);
    expect(runner.calls[0].env.PI_OFFLINE).toBe('1');
    expect(view.version).toBe(1);
    expect(view.packages.map(pkg => pkg.source)).toEqual(['npm:@scope/tools@1.0.0', local, 'git:github.com/owner/repo@v1']);
    expect(view.packages[0]).toMatchObject({ kind: 'npm', installed: true, root: npmRoot, requested: '1.0.0', version: '1.0.0', autoload: true, filtered: false });
    expect(view.packages[1]).toMatchObject({ kind: 'local', installed: true, root: fs.realpathSync(local), version: '3.1.4', resource_counts: { extensions: 1, skills: 1 } });
    expect(view.packages[2]).toMatchObject({ kind: 'git', installed: false, root: path.join(dir, 'git', 'github.com', 'owner', 'repo'), requested: 'v1', filtered: true, autoload: true });
    expect(view.resources.extensions.map(row => row.path)).toContain(path.join(npmRoot, 'extensions', 'tool.ts'));
    const skill = view.resources.skills.find(row => row.path.endsWith('SKILL.md'));
    expect(skill).toMatchObject({ name: 'hello', kind: 'skill', description: 'says hello', package_id: view.packages[1].id });
    expect(view.resources.extensions.find(row => row.path.endsWith('ext.ts')).name).toBe('ext.ts');
    // Stable ids across calls and no directory mutation on read.
    const again = await manager.list();
    expect(again.packages.map(pkg => pkg.id)).toEqual(view.packages.map(pkg => pkg.id));
    expect(view.truncated).toBe(false);
  } finally { f.close(); }
});

test('list falls back to declarations with a safe warning when pi cannot list', async () => {
  const f = fixture();
  try {
    const local = localPackage(f.root);
    const settingsSource = path.relative(path.join(f.config.home, 'pi'), fs.realpathSync(local));
    privatePi(f.config, { packages: [settingsSource] });
    const runner = fakeRun(() => { throw new PackageCommandError('unavailable'); });
    const manager = new AgentPackages(f.config, { run: runner.run });
    const view = await manager.list();
    expect(view.warning).toContain('无法读取');
    expect(view.packages[0]).toMatchObject({ kind: 'local', root: fs.realpathSync(local), installed: true });
    expect(view.resources.skills.map(row => row.name)).toEqual(['hello']);
  } finally { f.close(); }
});

test('list stays empty without a private Pi directory and does not create one', async () => {
  const f = fixture();
  try {
    const runner = fakeRun(() => { throw new Error('must not run'); });
    const view = await new AgentPackages(f.config, { run: runner.run }).list();
    expect(view).toMatchObject({ version: 1, packages: [], resources: { extensions: [], skills: [] } });
    expect(runner.calls).toHaveLength(0);
    expect(fs.existsSync(path.join(f.config.home, 'pi'))).toBe(false);
  } finally { f.close(); }
});

test('install pins the exact source, prepares the private directory and refreshes the view', async () => {
  const f = fixture();
  try {
    const local = localPackage(f.root);
    const dir = path.join(f.config.home, 'pi');
    const runner = fakeRun(options => {
      if (options.args[0] === 'install') {
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ packages: ['./lush-test-pkg'] }), { mode: 0o600 });
        return 'Installed ./lush-test-pkg';
      }
      return ['User packages:', '  ./lush-test-pkg', `    ${fs.realpathSync(local)}`].join('\n');
    });
    const manager = new AgentPackages(f.config, { run: runner.run });
    const view = await manager.install('./lush-test-pkg');
    expect(runner.calls[0].args).toEqual(['install', fs.realpathSync(local), '--no-approve']);
    expect(runner.calls[0].cwd).toBe(f.config.project);
    expect(runner.calls[0].env.PI_CODING_AGENT_DIR).toBe(dir);
    expect(runner.calls[0].env.PI_OFFLINE).toBeUndefined();
    expect(fs.statSync(path.join(dir, 'settings.json')).mode & 0o777).toBe(0o600);
    expect(view).toMatchObject({ version: 1, action: 'install' });
    expect(view.packages[0]).toMatchObject({ kind: 'local', installed: true });
  } finally { f.close(); }
});

test('install rejects unpinned remote sources before running anything', async () => {
  const f = fixture();
  try {
    const runner = fakeRun(() => 'nope');
    const manager = new AgentPackages(f.config, { run: runner.run });
    await expect(manager.install('npm:left-pad')).rejects.toThrow('pin an exact version');
    await expect(manager.install('git:github.com/owner/repo')).rejects.toThrow('explicit ref');
    expect(runner.calls).toHaveLength(0);
  } finally { f.close(); }
});

test('remove resolves an id to an absolute local path and to the configured npm source', async () => {
  const f = fixture();
  try {
    const local = localPackage(f.root);
    privatePi(f.config, { packages: ['./lush-test-pkg', 'npm:@scope/tools@1.0.0'] });
    const output = ['User packages:', '  ./lush-test-pkg', `    ${fs.realpathSync(local)}`, '  npm:@scope/tools@1.0.0'].join('\n');
    const runner = fakeRun(options => options.args[0] === 'remove' ? 'Removed' : output);
    const manager = new AgentPackages(f.config, { run: runner.run });
    const listed = await manager.list();
    const localPackageRecord = listed.packages.find(pkg => pkg.kind === 'local');
    const npmPackageRecord = listed.packages.find(pkg => pkg.kind === 'npm');
    await manager.remove(localPackageRecord.id);
    expect(runner.calls.find(call => call.args[0] === 'remove').args).toEqual(['remove', fs.realpathSync(local), '--no-approve']);
    await manager.remove(npmPackageRecord.id);
    expect(runner.calls.filter(call => call.args[0] === 'remove').at(-1).args).toEqual(['remove', 'npm:@scope/tools@1.0.0', '--no-approve']);
    await expect(manager.remove('pkg-0000000000000000')).rejects.toThrow('package not found');
    await expect(manager.remove('not-an-id')).rejects.toThrow('invalid package id');
  } finally { f.close(); }
});

test('update refuses to move an unpinned configured source and never upgrades implicitly', async () => {
  const f = fixture();
  try {
    privatePi(f.config, { packages: ['npm:left-pad'] });
    const runner = fakeRun(options => options.args[0] === 'update' ? 'Updated' : ['User packages:', '  npm:left-pad'].join('\n'));
    const manager = new AgentPackages(f.config, { run: runner.run });
    const [record] = (await manager.list()).packages;
    await expect(manager.update(record.id)).rejects.toThrow('pin an exact version');
    expect(runner.calls.filter(call => call.args[0] === 'update')).toHaveLength(0);
  } finally { f.close(); }
});

test('cancelling stop aborts an in-flight package command without leaking diagnostics', async () => {
  const f = fixture();
  try {
    privatePi(f.config, { packages: ['./lush-test-pkg'] });
    localPackage(f.root);
    let seenSignal = null;
    const runner = fakeRun(options => new Promise((resolve, reject) => {
      seenSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(new PackageCommandError('cancelled')), { once: true });
    }));
    const manager = new AgentPackages(f.config, { run: runner.run });
    const pending = manager.install('./lush-test-pkg');
    await Bun.sleep(5);
    await manager.stop();
    await expect(pending).rejects.toThrow('cancelled');
    expect(seenSignal.aborted).toBe(true);
  } finally { f.close(); }
});

test('subprocess helper bounds output, reports safe codes and never returns stderr', async () => {
  const exec = process.execPath;
  const run = (script, options = {}) => spawnPackageCommand({ command: exec, args: ['-e', script], env: env(), cwd: temp(), signal: options.signal, timeoutMs: options.timeoutMs ?? 5000, maxBytes: options.maxBytes });
  expect(await run('process.stdout.write("ok")')).toBe('ok');
  await expect(run('process.stdout.write("private diagnostic"); process.stderr.write("SECRET-TOKEN"); process.exit(3)')).rejects.toThrow('failed');
  await expect(run('process.stdout.write("SECRET-TOKEN")', { maxBytes: 4 })).rejects.toThrow('output_too_large');
  await expect(run('setTimeout(()=>{}, 5000)', { timeoutMs: 60 })).rejects.toThrow('timeout');
  const controller = new AbortController();
  const pending = run('setTimeout(()=>{}, 5000)', { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await expect(pending).rejects.toThrow('cancelled');
  const aborted = new AbortController(); aborted.abort();
  await expect(run('process.stdout.write("x")', { signal: aborted.signal })).rejects.toThrow('cancelled');
  await expect(spawnPackageCommand({ command: path.join(temp(), 'no-such-command'), args: [], env: env(), cwd: temp(), timeoutMs: 500 })).rejects.toThrow('unavailable');
});

function controlledRunner() {
  const calls = [], gates = [];
  const run = options => {
    calls.push(options);
    if (['install', 'remove', 'update'].includes(options.args[0])) {
      const waiter = gate();
      gates.push(waiter);
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new PackageCommandError('cancelled')), { once: true });
        waiter.promise.then(() => resolve('ok'));
      });
    }
    return Promise.resolve('User packages:');
  };
  return { calls, gates, run };
}

test('mutations are serialized so one package change cannot overlap another', async () => {
  const f = fixture();
  try {
    const runner = controlledRunner();
    const manager = new AgentPackages(f.config, { run: runner.run });
    const first = manager.install('npm:@scope/tools@1.0.0');
    await until(() => runner.calls.filter(call => call.args[0] === 'install').length === 1);
    const second = manager.install('npm:@scope/other@2.0.0');
    await Bun.sleep(10);
    expect(runner.calls.filter(call => call.args[0] === 'install')).toHaveLength(1);
    runner.gates[0].resolve();
    await first;
    await until(() => runner.calls.filter(call => call.args[0] === 'install').length === 2);
    runner.gates[1].resolve();
    await expect(second).resolves.toMatchObject({ action: 'install' });
  } finally { f.close(); }
});

test('the mutation queue is bounded and rejects overflow instead of piling up', async () => {
  const f = fixture();
  try {
    const runner = controlledRunner();
    const manager = new AgentPackages(f.config, { run: runner.run, maxMutations: 2 });
    const pending = [
      manager.install('npm:first@1.0.0'),
      manager.install('npm:second@1.0.0'),
      manager.install('npm:third@1.0.0'),
    ];
    await until(() => runner.calls.length >= 1);
    await expect(manager.install('npm:fourth@1.0.0')).rejects.toThrow('too many pending package operations');
    await manager.stop();
    await Promise.allSettled(pending);
    expect(runner.calls.filter(call => call.args[0] === 'install')).toHaveLength(1);
  } finally { f.close(); }
});

test('stop closes the manager, aborts the running change and cancels queued work', async () => {
  const f = fixture();
  try {
    const runner = controlledRunner();
    const manager = new AgentPackages(f.config, { run: runner.run });
    const first = manager.install('npm:@scope/tools@1.0.0');
    await until(() => runner.calls.filter(call => call.args[0] === 'install').length === 1);
    const second = manager.install('npm:@scope/other@2.0.0');
    await manager.stop();
    await expect(first).rejects.toThrow('cancelled');
    await expect(second).rejects.toThrow('cancelled');
    expect(runner.calls.filter(call => call.args[0] === 'install')).toHaveLength(1);
    await expect(manager.list()).rejects.toThrow('stopping');
    await expect(manager.install('npm:@scope/third@3.0.0')).rejects.toThrow('stopping');
    await expect(manager.stop()).resolves.toBeUndefined();
  } finally { f.close(); }
});

test('an already aborted caller signal never queues or starts a change', async () => {
  const f = fixture();
  try {
    const runner = controlledRunner();
    const manager = new AgentPackages(f.config, { run: runner.run });
    const controller = new AbortController(); controller.abort();
    await expect(manager.install('npm:@scope/tools@1.0.0', { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(runner.calls).toHaveLength(0);
  } finally { f.close(); }
});
