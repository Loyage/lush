import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AgentCatalog } from '../src/agent/catalog.js';
import {
  AGENT_FALLBACKS, DEFAULT_AGENT_NAME, PURE_PI_FLAGS, ProfileStore, pluginArgs, resolveAgentSpec,
} from '../src/agent/profiles.js';
import { TemplateLoader } from '../src/template_loader.js';
import { buildInvocation } from '../src/agent/invocation.js';
import { agentAdd, agentDefault, agentDelete, agentEdit, agentInspect, agentList, agentPath } from '../src/cli/agent.js';
import { cleanup, expectRejection, permissiveRoot, system, testTemplates, tmpdir } from './helpers.js';

const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const CLI = path.join(ROOT, 'src', 'cli', 'main.js');

// A fake `pi`: records the argv Lush invoked it with, then answers once.
const STUB = `#!/usr/bin/env bun
const argv = process.argv.slice(2);
if (argv.includes('--session-dir')) {
  const dir = argv[argv.indexOf('--session-dir') + 1];
  const id = argv[argv.indexOf('--session-id') + 1];
  await Bun.write(dir + '/2020-01-01T00-00-00-000Z_' + id + '.jsonl', '{}');
}
console.log(JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), sid: process.env.LUSH_SID }));
`;

function writeStub(dir, name = 'pi-stub') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, STUB);
  fs.chmodSync(file, 0o755);
  return file;
}

describe('agent profiles: files, validation and resolution', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = tmpdir('lush-agent-profiles-');
    store = new ProfileStore(dir);
  });

  afterEach(() => {
    cleanup(dir);
  });

  test('write / read / list round trip, one file per agent', () => {
    expect(store.exists('demo')).toBe(false);
    const written = store.write('demo', {
      provider: 'pi', command: '/bin/pi', plugins: false, flags: ['--foo'], description: 'd',
    });
    expect(written.path).toBe(path.join(dir, 'agents', 'demo.json'));
    expect(fs.existsSync(written.path)).toBe(true);
    // The file name is the agent name: no `name` field is written.
    expect(Object.keys(JSON.parse(fs.readFileSync(written.path, 'utf8'))))
      .toEqual(['provider', 'command', 'plugins', 'flags', 'description']);

    const layer = store.read('demo');
    expect(layer).toMatchObject({ name: 'demo', source: 'file', present: true });
    expect(layer.declared).toEqual({
      provider: 'pi', command: '/bin/pi', plugins: false, flags: ['--foo'], description: 'd',
    });
    expect(store.list().map((entry) => entry.name)).toEqual(['demo']);
    // The built-in default has no file and never fails to read.
    expect(store.read(DEFAULT_AGENT_NAME)).toMatchObject({ source: 'builtin', present: false, declared: {} });
    // An unknown profile is a not-found, not an empty profile.
    expect(() => store.read('nope')).toThrow(/agent profile not found: nope/);
  });

  test('unknown fields, bad names and bad values are rejected at the boundary', () => {
    for (const name of ['1bad', 'has space', 'a/b', '', 'x.y']) {
      expect(() => store.write(name, { provider: 'pi' })).toThrow(/invalid agent name/);
    }
    expect(() => store.write('bad-field', { provider: 'pi', nope: 1 })).toThrow(/unknown field nope/);
    expect(() => store.write('bad-provider', { provider: 'gemini' })).toThrow(/provider must be one of pi, openai, mock/);
    expect(() => store.write('bad-flags', { provider: 'pi', flags: '--x' })).toThrow(/flags must be a list/);
    expect(() => store.write('bad-flags2', { provider: 'pi', flags: ['--x', ''] })).toThrow(/flags must be a list/);
    expect(() => store.write('bad-plugins', { provider: 'pi', plugins: 'no' })).toThrow(/plugins must be a boolean/);
    expect(() => store.write('bad-model', { provider: 'pi', model: 3 })).toThrow(/model must be a string/);
    expect(() => store.write('bad-command', { provider: 'pi', command: 'x'.repeat(501) })).toThrow(/command must be a string/);

    // A hand-written file with an unknown field fails on read (and so does bad JSON).
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(path.join(store.dir, 'hand.json'), '{"provider":"pi","typo":true}');
    expect(() => store.read('hand')).toThrow(/unknown field typo/);
    fs.writeFileSync(path.join(store.dir, 'broken.json'), 'not json');
    expect(() => store.read('broken')).toThrow(/not valid JSON/);
    // A broken file stays visible in the listing with its error, so `list` is
    // how a hand-written profile is found out.
    const broken = store.list().find((entry) => entry.name === 'broken');
    expect(broken.error).toContain('not valid JSON');
  });

  test('duplicate profiles need --force, and default cannot be deleted', () => {
    store.write('demo', { provider: 'pi' });
    expect(() => store.write('demo', { provider: 'mock' })).toThrow(/already exists/);
    expect(store.write('demo', { provider: 'mock' }, { force: true }).declared).toEqual({ provider: 'mock' });
    expect(store.read('demo').declared.provider).toBe('mock');

    expect(() => store.remove(DEFAULT_AGENT_NAME)).toThrow(/default agent cannot be deleted/);
    // Writing the default's override file is allowed, deleting it is not.
    store.write(DEFAULT_AGENT_NAME, { plugins: true }, { force: true });
    expect(store.read(DEFAULT_AGENT_NAME).declared).toEqual({ plugins: true });
    expect(() => store.remove(DEFAULT_AGENT_NAME)).toThrow(/default agent cannot be deleted/);
    expect(() => store.remove('nope')).toThrow(/not found/);
  });

  test('resolution is field by field: profile > environment > built-in fallback', () => {
    const env = {
      LUSH_PROVIDER: 'mock', LUSH_PI_COMMAND: 'env-pi', LUSH_PI_PROVIDER: 'env-provider', LUSH_PI_MODEL: 'env-model',
    };
    // A profile that declares everything wins over the environment.
    const explicit = resolveAgentSpec({
      source: 'file',
      present: true,
      declared: {
        provider: 'pi', command: 'profile-pi', model: 'profile-model', plugins: true, flags: ['--x'],
      },
    }, { name: 'demo', env });
    expect(explicit).toMatchObject({
      name: 'demo',
      source: 'file',
      provider: 'pi',
      command: 'profile-pi',
      model: 'profile-model',
      pi_provider: 'env-provider',
      plugins: true,
      pure: false,
      flags: ['--x'],
    });
    // Only the declared fields win; the rest still comes from the environment.
    const partial = resolveAgentSpec({ source: 'file', present: true, declared: { plugins: false } }, { name: 'demo', env });
    expect(partial).toMatchObject({
      provider: 'mock', command: 'env-pi', pi_provider: 'env-provider', model: 'env-model', plugins: false,
    });
    // Nothing declared anywhere: the built-in fallbacks are pure pi.
    const fallback = resolveAgentSpec({ source: 'builtin', present: false, declared: {} }, { name: DEFAULT_AGENT_NAME, env: {} });
    expect(fallback).toMatchObject({
      provider: AGENT_FALLBACKS.provider,
      command: AGENT_FALLBACKS.command,
      model: '',
      pi_provider: '',
      plugins: false,
      pure: true,
    });
    expect(fallback.plugin_args).toEqual([...PURE_PI_FLAGS]);
    expect(fallback.argv_args).toEqual([...PURE_PI_FLAGS]);
    expect(fallback.description).toContain('纯净 pi');
    expect(pluginArgs(true)).toEqual([]);
    expect(pluginArgs(false, ['--x'])).toEqual([...PURE_PI_FLAGS, '--x']);
  });
});

describe('agent catalog: pure pi is what pi actually runs', () => {
  let dir;
  let stub;

  beforeEach(() => {
    dir = tmpdir('lush-agent-catalog-');
    stub = writeStub(dir);
  });

  afterEach(() => {
    cleanup(dir);
  });

  test('the default tier runs pi with the pure flag set', () => {
    const catalog = new AgentCatalog({ home: dir, env: { ...process.env, LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: stub } });
    const provider = catalog.defaultProvider();
    expect(provider.name).toBe('pi');
    expect(provider.command).toBe(stub);
    expect(catalog.spec(null)).toMatchObject({ provider: 'pi', pure: true, plugins: false });

    const preview = catalog.preview(catalog.spec(null));
    for (const flag of PURE_PI_FLAGS) expect(preview.argv).toContain(flag);
    expect(preview.argv[1]).toBe('--print');
    expect(preview.argv[preview.argv.length - 1]).toBe('<PROMPT>');
    // The binary does not have to exist for a preview.
    const missing = new AgentCatalog({
      home: dir, env: { ...process.env, LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: 'no-such-pi' },
    });
    expect(missing.preview(missing.spec(null)).argv[0]).toBe('no-such-pi');
  });

  test('a profile that keeps plugins on drops every --no-* flag', () => {
    const store = new ProfileStore(dir);
    store.write('loud', {
      provider: 'pi', command: stub, plugins: true, flags: ['--verbose'],
    });
    const catalog = new AgentCatalog({ home: dir, env: { ...process.env, LUSH_PROVIDER: 'mock' } });
    const spec = catalog.spec('loud');
    expect(spec).toMatchObject({
      provider: 'pi', plugins: true, pure: false, flags: ['--verbose'],
    });
    const preview = catalog.preview(spec);
    for (const flag of PURE_PI_FLAGS) expect(preview.argv).not.toContain(flag);
    expect(preview.argv).toContain('--verbose');
    // Selecting an agent is explicit: it wins over LUSH_PROVIDER=mock.
    expect(catalog.provider(spec).name).toBe('pi');
  });

  test('an unknown profile or provider fails instead of silently using the default', () => {
    const catalog = new AgentCatalog({ home: dir, env: { ...process.env, LUSH_PROVIDER: 'mock' } });
    expect(() => catalog.spec('ghost')).toThrow(/agent profile not found: ghost/);
    const store = new ProfileStore(dir);
    store.write('inproc', { provider: 'mock' });
    const spec = catalog.spec('inproc');
    expect(catalog.provider(spec).name).toBe('mock');
    expect(() => catalog.preview(spec)).toThrow(/in-service/);
  });
});

describe('agent profiles inside services: construct, inspect and the argv of a call', () => {
  let dir;
  let stub;
  let db;
  let manager;
  let runtime;
  let catalog;

  /** The daemon composition root: the catalog's default tier *is* the fallback provider. */
  function setup(env = {}, mutateTemplates = null) {
    dir = tmpdir('lush-agent-proc-');
    stub = writeStub(dir);
    catalog = new AgentCatalog({
      home: dir,
      env: { ...process.env, LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: stub, LUSH_PI_PROVIDER: '', LUSH_PI_MODEL: '', ...env },
    });
    const templates = testTemplates();
    if (mutateTemplates !== null) mutateTemplates(templates);
    ({ database: db, manager, runtime } = system(dir, catalog.defaultProvider(), { catalog, templates }));
    permissiveRoot(manager);
  }

  afterEach(async () => {
    await runtime.shutdown();
    db.close();
    cleanup(dir);
  });

  test('construct --agent records the profile name and the call runs that profile', async () => {
    setup();
    new ProfileStore(dir).write('demo', {
      provider: 'pi', command: stub, plugins: false, model: 'demo-model',
    });
    const child = manager.construct(0, 'generic-task', 'worker', 'work', undefined, 'demo');
    expect(child.agent_profile).toBe('demo');
    expect(manager.repository.context(child.sid).state.agent).toBe('demo');
    expect(manager.inspect(child.sid).agent).toMatchObject({ provider: 'pi', profile: 'demo' });
    expect(manager.inspect(0).agent).toMatchObject({ provider: 'pi', profile: 'default' });

    // The dry run and the real task agree, and both carry the profile's flags.
    const preview = await manager.callDescribe(child.sid, 'hello');
    expect(preview.agent).toBe('pi');
    expect(preview.profile).toBe('demo');
    for (const flag of PURE_PI_FLAGS) expect(preview.argv).toContain(flag);
    expect(preview.argv[preview.argv.indexOf('--model') + 1]).toBe('demo-model');
    const task = await manager.call(child.sid, 'hello');
    const echoed = JSON.parse(task.result).argv;
    // The dry run and the real task are described by the same builder; only the
    // task id (and the session id / name derived from it) differ.
    for (const flag of PURE_PI_FLAGS) expect(echoed).toContain(flag);
    expect(echoed[echoed.indexOf('--model') + 1]).toBe('demo-model');
    expect(echoed[echoed.indexOf('--session-id') + 1]).toBe(`lush-task-${task.id}`);
    expect(preview.argv[preview.argv.indexOf('--session-id') + 1]).toBe('lush-task-preview');
    // Sessions belong to tasks now, and the id names the task.
    expect(manager.session(task.id)).toMatchObject({ agent: 'pi', profile: 'demo', task_id: task.id, sid: child.sid });
    expect(manager.session(task.id).argv).toContain('--no-extensions');
    expect(manager.session(task.id).session_id).toBe(`lush-task-${task.id}`);

    // The invocation handed to the provider also names the profile it runs under.
    const invocation = buildInvocation(runtime, { id: 1, sid: child.sid }, null, 'p', {
      context: { systemPrompt: 'S' }, guide: 'G', data: {},
    });
    expect(invocation).toMatchObject({ task_id: 1, sid: child.sid, agent_profile: 'demo', prompt: 'p' });
    expect(buildInvocation(runtime, { id: 2, sid: 0 }, null, 'p', { context: { systemPrompt: 'S' }, guide: 'G', data: {} }).agent_profile)
      .toBe('default');
  });

  test('--agent overrides the template field, and env still governs the default', async () => {
    setup({ LUSH_PROVIDER: 'mock' }, (loader) => {
      loader.register({
        ...loader.get('generic-task'), name: 'agent-task', singleton: false, agent: 'from-template', child_templates: ['*'],
      });
    });

    const store = new ProfileStore(dir);
    const piProfile = { provider: 'pi', command: stub, plugins: true };
    store.write('from-template', piProfile);
    store.write('explicit', piProfile);

    const fromTemplate = manager.construct(0, 'agent-task', 'a');
    expect(fromTemplate.agent_profile).toBe('from-template');
    const explicit = manager.construct(0, 'agent-task', 'b', undefined, undefined, 'explicit');
    expect(explicit.agent_profile).toBe('explicit');
    // Both are pi profiles even though the daemon's fallback provider is mock.
    expect(manager.inspect(fromTemplate.sid).agent).toMatchObject({ provider: 'pi', profile: 'from-template' });
    expect(manager.inspect(explicit.sid).agent).toMatchObject({ provider: 'pi', profile: 'explicit' });
    // The plugins=true profiles therefore run without any --no-* flag.
    const preview = await manager.callDescribe(explicit.sid, 'hi');
    for (const flag of PURE_PI_FLAGS) expect(preview.argv).not.toContain(flag);
    // No explicit agent: the environment tier (mock) still applies.
    const plain = manager.construct(0, 'generic-task', 'c');
    expect(plain.agent_profile).toBeNull();
    expect(manager.inspect(plain.sid).agent).toMatchObject({ provider: 'mock', profile: 'default' });
  });

  test('construct validates the profile name and its existence', () => {
    setup(null, (loader) => {
      loader.register({
        ...loader.get('generic-task'), name: 'ghost-task', singleton: false, agent: 'ghost', child_templates: ['*'],
      });
    });
    // `default` is built in and usable even though it has no file.
    expect(manager.construct(0, 'generic-task', 'd', undefined, undefined, 'default').agent_profile).toBe('default');
    expect(() => manager.construct(0, 'generic-task', 'x', undefined, undefined, 'ghost')).toThrow(/agent profile not found: ghost/);
    expect(() => manager.construct(0, 'generic-task', 'x', undefined, undefined, 'bad name')).toThrow(/invalid agent name/);
    // A template that names a missing profile fails at construct time too.
    expect(() => manager.construct(0, 'ghost-task', 'x')).toThrow(/agent profile not found: ghost/);
  });

  test('the selected profile is part of the record and cannot be rewritten by update_state', () => {
    setup();
    const child = manager.construct(0, 'generic-task', 'x');
    expect(() => manager.updateState(child.sid, { agent: 'other' })).toThrow(/state.agent records the agent profile/);
    expect(manager.inspect(child.sid).context.state).toEqual({});
    expect(manager.inspect(child.sid).agent.profile).toBe('default');
  });

  test('a profile deleted behind the daemon keeps reads usable and stops the call', async () => {
    setup();
    const store = new ProfileStore(dir);
    store.write('gone', { provider: 'pi', command: stub });
    const child = manager.construct(0, 'generic-task', 'x', undefined, undefined, 'gone');
    store.remove('gone');

    // Reading the service still works and says why the agent cannot be built.
    const info = manager.inspect(child.sid);
    expect(info.agent.profile).toBe('gone');
    expect(info.agent.profile_error).toContain('agent profile not found: gone');
    expect(manager.tree().find((row) => row.sid === child.sid).agent.provider).toBe('pi');
    // Running anything on it cannot work, preview included.
    await expectRejection(manager.call(child.sid, 'hi'), /agent profile not found: gone/);
    await expectRejection(manager.callDescribe(child.sid, 'hi'), /agent profile not found: gone/);
  });
});

describe('lush agent: the CLI group works without a daemon', () => {
  let home;
  let env;

  async function cli(args, { check = true, extraEnv = {} } = {}) {
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
      cwd: ROOT,
      env: { ...env, ...extraEnv },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (check) expect(code, `${args.join(' ')}: ${stderr}\n${stdout}`).toBe(0);
    return { code, stdout, stderr };
  }

  async function data(...args) {
    const { stdout } = await cli(['--json', ...args]);
    return JSON.parse(stdout);
  }

  beforeEach(() => {
    home = tmpdir('lush-agent-cli-');
    env = {
      ...process.env, LUSH_HOME: home, LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: '/bin/echo',
    };
  });

  afterEach(() => {
    cleanup(home);
  });

  test('list / path / help need no daemon and describe the built-in default', async () => {
    // No daemon was ever started here: there is no socket to connect to.
    expect(fs.existsSync(path.join(home, 'lush.sock'))).toBe(false);
    const listed = await data('agent', 'list');
    expect(listed.default_agent).toBe('default');
    expect(listed.dir).toBe(path.join(home, 'agents'));
    expect(listed.agents).toEqual([expect.objectContaining({
      name: 'default', provider: 'pi', command: '/bin/echo', plugins: false, pure: true, default: true, source: 'builtin', valid: true,
    })]);
    const text = (await cli(['agent', 'list'])).stdout;
    expect(text).toContain('NAME');
    expect(text).toContain('pure');

    expect(await data('agent', 'path')).toMatchObject({ dir: path.join(home, 'agents') });
    expect((await cli(['agent', 'path'])).stdout.trim()).toBe(path.join(home, 'agents'));

    // Help works at every layer and agrees between spellings.
    const help = (await cli(['agent', 'help'])).stdout;
    expect(help).toContain('lush agent —');
    expect(help).toContain('inspect');
    expect((await cli(['agent', 'add', '-h'])).stdout).toContain('lush agent add —');
    expect((await cli(['agent', 'add', '--help'])).stdout).toBe((await cli(['agent', 'add', '-h'])).stdout);
    expect(JSON.parse((await cli(['--json', 'help', 'agent'])).stdout).subcommands.map((child) => child.name))
      .toContain('delete');
    // Missing subcommand is a usage error.
    expect((await cli(['agent'], { check: false })).code).toBe(2);
  });

  test('add / inspect / edit / delete round trip, with the argv preview', async () => {
    const added = await data('agent', 'add', 'demo', '--no-plugins', '--model', 'm1', '--flag', '--verbose');
    expect(added).toMatchObject({ action: 'add', name: 'demo', overwrote: false });
    expect(JSON.parse(fs.readFileSync(added.path, 'utf8'))).toEqual({
      provider: 'pi', model: 'm1', plugins: false, flags: ['--verbose'],
    });

    const inspected = await data('agent', 'inspect', 'demo');
    expect(inspected).toMatchObject({
      name: 'demo',
      default: false,
      source: 'file',
      valid: true,
      provider: 'pi',
      command: '/bin/echo',
      plugins: false,
      pure: true,
      flags: ['--verbose'],
      declared: {
        provider: 'pi', model: 'm1', plugins: false, flags: ['--verbose'],
      },
    });
    expect(inspected.plugin_flags).toEqual([...PURE_PI_FLAGS]);
    expect(inspected.argv_flags).toEqual([...PURE_PI_FLAGS, '--verbose']);
    expect(inspected.preview.argv.slice(0, 3)).toEqual(['/bin/echo', '--print', '--no-extensions']);
    for (const flag of PURE_PI_FLAGS) expect(inspected.preview.argv).toContain(flag);
    expect(inspected.preview.argv).toContain('--model');
    expect((await cli(['agent', 'inspect', 'demo'])).stdout).toContain('--no-extensions');

    // Duplicate refused, --force overwrites, edit is incremental.
    const dup = await cli(['agent', 'add', 'demo', '--plugins'], { check: false });
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain('already exists');
    expect(await data('agent', 'add', 'demo', '--plugins', '--force')).toMatchObject({ overwrote: true });
    expect((await data('agent', 'inspect', 'demo')).plugins).toBe(true);
    expect(await data('agent', 'edit', 'demo', '--no-plugins', '--command', '/bin/true'))
      .toMatchObject({ action: 'edit', created: false, profile: { provider: 'pi', command: '/bin/true', plugins: false } });
    expect((await data('agent', 'inspect', 'demo')).plugins).toBe(false);
    // -32602 (a rejected usage) exits 2, like a parse error: see the `lush agent`
    // command contract in src/cli/main.js. Other codes (e.g. -32010 duplicates,
    // -32004 missing profiles) keep exiting 1.
    expect((await cli(['agent', 'edit', 'demo'], { check: false })).code).toBe(2);
    // `edit` on a missing profile creates it; `delete` then removes it.
    expect((await cli(['agent', 'edit', 'ghost', '--plugins'])).code).toBe(0);
    expect(await data('agent', 'delete', 'ghost')).toMatchObject({ action: 'delete', name: 'ghost' });

    // A hand-written broken file is listed and inspectable, but not silently fixed.
    fs.writeFileSync(path.join(home, 'agents', 'broken.json'), '{"provider":"pi","typo":1}');
    const listed = await data('agent', 'list');
    expect(listed.agents.find((row) => row.name === 'broken')).toMatchObject({ valid: false });
    expect((await data('agent', 'inspect', 'broken')).errors[0]).toContain('unknown field typo');

    expect(await data('agent', 'delete', 'demo')).toMatchObject({ name: 'demo' });
    expect(fs.existsSync(path.join(home, 'agents', 'demo.json'))).toBe(false);
    expect((await cli(['agent', 'delete', 'demo'], { check: false })).code).toBe(1);
  });

  test('default is always available, cannot be deleted, and can be overridden', async () => {
    const refused = await cli(['agent', 'delete', 'default'], { check: false });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('default agent cannot be deleted');

    await cli(['agent', 'add', 'demo', '--plugins', '--model', 'm']);
    const selected = await data('agent', 'default', 'demo');
    expect(selected).toMatchObject({
      action: 'default', copied_from: 'demo', name: 'default', source: 'file', plugins: true, model: 'm',
    });
    expect(JSON.parse(fs.readFileSync(path.join(home, 'agents', 'default.json'), 'utf8')))
      .toEqual({ provider: 'pi', model: 'm', plugins: true });
    const listed = await data('agent', 'list');
    expect(listed.agents[0]).toMatchObject({ name: 'default', source: 'file', plugins: true });
    // `agent default` with no name is a read-only view of the effective default.
    expect(await data('agent', 'default')).toMatchObject({ copied_from: null, name: 'default', provider: 'pi' });
    // Deleting the source profile leaves the default override in place.
    await data('agent', 'delete', 'demo');
    expect((await data('agent', 'inspect', 'default')).plugins).toBe(true);
  });

  test('the group rejects unknown names, fields and subcommands', async () => {
    for (const name of ['1bad', 'a b', 'a/b']) {
      const result = await cli(['agent', 'add', name], { check: false });
      // An invalid name is a usage error (-32602), which exits 2.
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('invalid agent name');
    }
    expect((await cli(['agent', 'add', 'ok', '--provider', 'gemini'], { check: false })).stderr)
      .toContain('provider must be one of pi, openai, mock');
    expect((await cli(['agent', 'add', 'ok', '--nope'], { check: false })).code).toBe(2);
    expect((await cli(['agent', 'inspect', 'ghost'], { check: false })).stderr).toContain('agent profile not found: ghost');
    expect((await cli(['agent', 'nope'], { check: false })).code).toBe(2);
  });
});

describe('agent CLI helpers are usable as a library', () => {
  let home;

  beforeEach(() => {
    home = tmpdir('lush-agent-lib-');
  });

  afterEach(() => {
    cleanup(home);
  });

  test('add / list / inspect / default / path over a plain config object', () => {
    const config = { home };
    const added = agentAdd(config, { name: 'demo', provider: 'mock', plugins: false });
    expect(added).toMatchObject({ action: 'add', name: 'demo', overwrote: false });
    expect(agentList(config).agents.map((row) => row.name)).toEqual(['default', 'demo']);
    expect(agentInspect(config, { name: 'demo' })).toMatchObject({ provider: 'mock', preview: null });
    expect(agentInspect(config, { name: 'demo' }).preview_error).toContain('in-service');
    expect(agentInspect(config, { name: 'default' }).valid).toBe(true);
    expect(agentEdit(config, { name: 'default', plugins: true })).toMatchObject({ created: true });
    expect(agentDefault(config, { name: 'demo' }).copied_from).toBe('demo');
    expect(agentPath(config).dir).toBe(path.join(home, 'agents'));
    expect(agentDelete(config, { name: 'demo' }).name).toBe('demo');
    expect(() => agentDelete(config, { name: 'default' })).toThrow(/cannot be deleted/);
    expect(() => agentInspect(config, { name: 'ghost' })).toThrow(/not found/);
    expect(() => agentAdd(config, { name: 'demo2', provider: 'nope' })).toThrow(/provider must be one of/);
  });
});
