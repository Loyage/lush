import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../../src/config.js';
import { PiProvider } from '../../src/agent/provider.js';
import { createRuntimeConnection } from '../../src/agent/connection-runtime.js';
import { ensurePiConfiguration, piConfigDirectory, isolatedPiEnvironment } from '../../src/agent/pi-config.js';
import { discoverAgentResources } from '../../src/agent/resources.js';
import { managedPiRun } from './managed-runtime-fixture.js';
import { env, temp } from '../helpers.js';

function fixture(extra = {}) {
  const root = temp(), config = new Config({ project: root, env: env({ ...extra, LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) }); config.prepare();
  return { root, config, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });

function options(f, task = { id: 31, role: 'agent', goal: 'isolated' }) {
  return managedPiRun({ task, context: {}, messages: [], cwd: f.root, token: 'invocation-token',
    signal: new AbortController().signal, onSpawn() {}, agent: { agent: 'pi', extensions: [], skills: [] } });
}

test('Lush Pi baseline is device-owned, private, create-only and ignores environment directory overrides', () => {
  const f = fixture({ PI_CODING_AGENT_DIR: '/must-not-read', HOME: '/must-not-import' });
  try {
    expect(piConfigDirectory(f.config)).toBe(path.join(f.config.deviceHome, 'pi'));
    expect(fs.existsSync(piConfigDirectory(f.config))).toBe(false);
    const a = ensurePiConfiguration(f.config), file = path.join(a.dir, 'settings.json');
    expect(a.settings).toMatchObject({ defaultProjectTrust: 'never', enableInstallTelemetry: false, cacheWarming: 'off' });
    expect(fs.statSync(a.dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    json(file, { transport: 'sse', compaction: { enabled: false }, packages: ['do-not-load'], httpProxy: 'http://do-not-override-network', defaultProjectTrust: 'always' });
    const before = fs.readFileSync(file, 'utf8'), b = ensurePiConfiguration(f.config);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(b.settings).toMatchObject({ transport: 'sse', compaction: { enabled: false }, defaultProjectTrust: 'never' });
    expect(b.settings.packages).toBeUndefined(); expect(b.settings.httpProxy).toBeUndefined();
    expect(fs.readdirSync(a.dir)).toEqual(['settings.json']);
  } finally { f.close(); }
});

test('unsafe baseline directory, settings/models symlinks, permissions and damaged JSON fail without repair', () => {
  for (const kind of ['directory-link', 'directory-mode', 'settings-link', 'settings-mode', 'models-link', 'damaged', 'oversized']) {
    const f = fixture(), external = path.join(f.root, 'external'); fs.mkdirSync(external, { mode: 0o700 });
    const original = path.join(external, 'settings.json'); json(original, { secret: 'DO-NOT-IMPORT' });
    try {
      fs.mkdirSync(f.config.deviceHome, { recursive: true, mode: 0o700 });
      const directory = path.join(f.config.deviceHome, 'pi');
      if (kind === 'directory-link') fs.symlinkSync(external, directory);
      else {
        const baseline = ensurePiConfiguration(f.config), file = path.join(baseline.dir, 'settings.json');
        if (kind === 'directory-mode') fs.chmodSync(directory, 0o755);
        if (kind === 'settings-mode') fs.chmodSync(file, 0o644);
        if (kind === 'settings-link') { fs.unlinkSync(file); fs.symlinkSync(original, file); }
        if (kind === 'models-link') fs.symlinkSync(original, path.join(directory, 'models.json'));
        if (kind === 'damaged') fs.writeFileSync(file, '{SECRET invalid');
        if (kind === 'oversized') fs.writeFileSync(file, 'x'.repeat(262145));
      }
      expect(() => ensurePiConfiguration(f.config)).toThrow('Lush Pi configuration');
      expect(fs.readFileSync(original, 'utf8')).toBe(JSON.stringify({ secret: 'DO-NOT-IMPORT' }));
    } finally { f.close(); }
  }
});

test('unbound Pi including no-tools roles fails before spawning, creating session files or importing external config', async () => {
  const f = fixture({ LUSH_PI_COMMAND: '/never-execute', PI_CODING_AGENT_DIR: '/never-read' });
  try {
    for (const role of ['agent', 'explainer', 'butler']) {
      let spawned = false;
      await expect(new PiProvider(f.config).run({ ...options(f), task: { id: 30, role },
        agent: { agent: 'pi' }, connectionRuntime: null, onSpawn() { spawned = true; } })).rejects.toThrow('select a source');
      expect(spawned).toBe(false);
    }
    expect(fs.existsSync(path.join(f.config.home, 'sessions'))).toBe(false);
    expect(fs.existsSync(path.join(f.config.home, 'agent-runtime'))).toBe(false);
    expect(fs.existsSync(path.join(f.config.deviceHome, 'pi'))).toBe(false);
  } finally { f.close(); }
});

test('settings snapshots remain frozen across baseline changes and simultaneous model-source preparation', () => {
  const f = fixture();
  try {
    const baseline = ensurePiConfiguration(f.config), file = path.join(baseline.dir, 'settings.json');
    json(file, { transport: 'sse' });
    const first = options(f), a = createRuntimeConnection(f.config, first.agent, first.connectionRuntime);
    json(file, { transport: 'websocket' });
    const second = options(f); second.connectionRuntime.credential.key = 'SECOND-SOURCE-KEY';
    const b = createRuntimeConnection(f.config, second.agent, second.connectionRuntime);
    expect(a.dir).not.toBe(b.dir);
    expect(JSON.parse(fs.readFileSync(path.join(a.dir, 'settings.json'))).transport).toBe('sse');
    expect(JSON.parse(fs.readFileSync(path.join(b.dir, 'settings.json'))).transport).toBe('websocket');
    expect(fs.readFileSync(path.join(a.dir, 'auth.json'), 'utf8')).not.toContain('SECOND-SOURCE-KEY');
    expect(fs.readFileSync(path.join(b.dir, 'auth.json'), 'utf8')).toContain('SECOND-SOURCE-KEY');
    expect(fs.existsSync(path.join(baseline.dir, 'auth.json'))).toBe(false);
  } finally { f.close(); }
});

test('Pi process gets a frozen private directory and no ambient authentication regardless of daemon/role/Worker overrides', async () => {
  const f = fixture({ DEEPSEEK_API_KEY: 'DAEMON-KEY', OPENAI_API_KEY: 'OTHER-KEY', AWS_PROFILE: 'external', PI_CODING_AGENT_DIR: '/daemon-pi' });
  const fake = path.join(f.root, 'fake-pi');
  fs.writeFileSync(fake, `#!${process.execPath}\nimport fs from 'node:fs'; import path from 'node:path';
const directory=process.env.PI_CODING_AGENT_DIR;
const auth=JSON.parse(fs.readFileSync(path.join(directory,'auth.json')));
const keys=['DEEPSEEK_API_KEY','OPENAI_API_KEY','AWS_PROFILE','AWS_SHARED_CREDENTIALS_FILE','PI_SESSION_FILE','PI_CODING_AGENT_SESSION_DIR'];
console.log(JSON.stringify({ directory, files:fs.readdirSync(directory), ambient:keys.filter(k=>process.env[k]), args:process.argv.slice(2), custom:process.env.TOOL_SERVICE_KEY, keyMatches:auth.deepseek.key==='FIXTURE-MANAGED-API-KEY', telemetry:process.env.PI_TELEMETRY }));`, { mode: 0o700 });
  f.config.env.LUSH_PI_COMMAND = fake;
  fs.mkdirSync(path.join(f.config.deviceHome, 'agent'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(f.config.deviceHome, 'agent', 'agent.env'), 'PI_CODING_AGENT_DIR=/role-pi\nDEEPSEEK_API_KEY=ROLE-KEY\n');
  try {
    const run = options(f); run.agent.env = { PI_CODING_AGENT_DIR: '/worker-pi', DEEPSEEK_API_KEY: 'WORKER-KEY',
      AWS_SHARED_CREDENTIALS_FILE: '/external-cloud', PI_SESSION_FILE: '/wrong-session', TOOL_SERVICE_KEY: 'explicit-tool-value' };
    const result = JSON.parse(await new PiProvider(f.config).run(run));
    expect(result.directory.startsWith(path.join(f.config.home, 'agent-runtime') + path.sep)).toBe(true);
    expect(result.ambient).toEqual([]); expect(result.keyMatches).toBe(true); expect(result.custom).toBe('explicit-tool-value');
    expect(result.telemetry).toBe('0'); expect(result.args).toContain('--no-approve');
    expect(result.args).not.toContain('--no-context-files');
    expect(result.files.sort()).toEqual(['auth.json', 'models.json', 'settings.json']);
    expect(fs.existsSync(result.directory)).toBe(false);
    expect(fs.readFileSync(path.join(f.config.home, 'sessions/task-31-input.md'), 'utf8')).not.toContain('WORKER-KEY');
    expect(isolatedPiEnvironment(f.config).DEEPSEEK_API_KEY).toBeUndefined();
  } finally { f.close(); }
});

test('resource discovery excludes default Pi and HOME .agents resources but preserves explicitly selected paths', async () => {
  const f = fixture();
  const external = path.join(f.root, 'user-pi'), userHome = path.join(f.root, 'user-home');
  fs.mkdirSync(path.join(external, 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(userHome, '.agents/skills/outside'), { recursive: true });
  const extension = path.join(external, 'extensions', 'external.ts'), skill = path.join(userHome, '.agents/skills/outside/SKILL.md');
  fs.writeFileSync(extension, 'throw new Error("never execute");');
  fs.writeFileSync(skill, '---\nname: outside\ndescription: Explicit only.\n---\n');
  f.config.env.PI_CODING_AGENT_DIR = external; f.config.env.HOME = userHome;
  try {
    const absent = await discoverAgentResources(f.config, { packages: [] });
    expect(absent.extensions).toEqual([]); expect(absent.skills).toEqual([]);
    const selected = await discoverAgentResources(f.config, { packages: [], extensions: [extension], skills: [skill] });
    expect(selected.extensions.map(row => row.id)).toEqual([extension]);
    expect(selected.skills.map(row => row.id)).toEqual([skill]);
  } finally { f.close(); }
});
