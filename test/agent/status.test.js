import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverAgentStatus } from '../../src/agent/status.js';

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-software-status-test-'));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const config = { project: root, home: path.join(root, '.lush'), env: { PATH: bin } };
  const command = (name, code) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!${process.execPath}\n${code}`, { mode: 0o755 }); return file;
  };
  command('pi', "console.log('9.1.2');"); command('codex', "console.log('codex-cli 1.2.3');");
  return { root, bin, config, command, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

test('software status version 2 always diagnoses both backends, independent of profile and installation metadata', async () => {
  const f = world();
  try {
    const value = await discoverAgentStatus(f.config, { agent: 'codex', model: 'secret/model' });
    expect(Object.keys(value).sort()).toEqual(['checked_at', 'scope', 'software', 'version', 'warnings']);
    expect(value.version).toBe(2); expect(Number.isNaN(Date.parse(value.checked_at))).toBe(false);
    expect(value.scope.project).toBe(f.root); expect(value.scope.note).toContain('仅执行 --version');
    expect(value.warnings).toEqual([]);
    expect(value.software).toEqual(['pi', 'codex'].map((agent, index) => ({ agent, command: agent,
      executable: path.join(f.bin, agent), real_path: path.join(f.bin, agent),
      version: index ? '1.2.3' : '9.1.2', status: 'available', warning: null })));
    expect(JSON.stringify(value)).not.toContain('secret/model');
  } finally { f.close(); }
});

test('daemon command overrides PATH; relative commands and symlinks resolve without inspecting packages', async () => {
  const f = world();
  try {
    const real = f.command('real-pi', "console.log('pi 2.0.0-beta.1+build');");
    const link = path.join(f.root, 'selected-pi'); fs.symlinkSync(real, link);
    f.config.env.LUSH_PI_COMMAND = './selected-pi';
    f.config.env.LUSH_CODEX_COMMAND = f.command('chosen-codex', "console.log('codex 3.4.5');");
    f.config.env.PI_PACKAGE_DIR = path.join(f.root, 'never-read');
    const result = await discoverAgentStatus(f.config, { env: { LUSH_PI_COMMAND: 'wrong' } });
    expect(result.software[0]).toMatchObject({ command: './selected-pi', executable: link, real_path: real, version: '2.0.0-beta.1+build' });
    expect(result.software[1].version).toBe('3.4.5');
    f.config.env.LUSH_PI_COMMAND = './missing';
    const missing = await discoverAgentStatus(f.config);
    expect(missing.software[0]).toMatchObject({ command: './missing', executable: null, real_path: null, version: null, status: 'unavailable' });
    expect(missing.software[1].status).toBe('available');
  } finally { f.close(); }
});

test('diagnostics neither read credential/config/resource files nor query network, refresh OAuth or expose ambient secrets', async () => {
  const f = world(); const originalRead = fs.readFileSync;
  try {
    const privateDir = path.join(f.config.home, 'pi'); fs.mkdirSync(privateDir, { recursive: true });
    const files = ['auth.json', 'models.json', 'settings.json'].map(name => path.join(privateDir, name));
    files.forEach(file => fs.writeFileSync(file, '{"DO_NOT_READ_SECRET":true}', { mode: 0o600 }));
    const envDir = path.join(f.config.home, 'agent'); fs.mkdirSync(envDir);
    const envFile = path.join(envDir, 'agent.env'); fs.writeFileSync(envFile, 'INVALID_SECRET');
    files.push(envFile);
    const before = files.map(file => ({ data: originalRead(file, 'utf8'), stat: fs.statSync(file) }));
    const guarded = new Set(files); let privateReads = 0;
    fs.readFileSync = function(file, ...args) {
      if (guarded.has(String(file))) { privateReads++; throw new Error('diagnostics attempted private config read'); }
      return originalRead.call(this, file, ...args);
    };
    Object.assign(f.config.env, { HOME: f.root, CODEX_HOME: privateDir, PI_CODING_AGENT_DIR: privateDir,
      LUSH_AGENT_TOKEN: 'SECRET', PI_SESSION_FILE: 'SECRET', OPENAI_API_KEY: 'SECRET', DEEPSEEK_API_KEY: 'SECRET' });
    const script = `import fs from 'node:fs';
if (process.argv.slice(2).join(' ') !== '--version') throw new Error('extra operation');
for (const name of ['LUSH_AGENT_TOKEN','PI_SESSION_FILE','OPENAI_API_KEY','DEEPSEEK_API_KEY']) if (process.env[name]) throw new Error('secret env');
if (process.env.HOME === ${JSON.stringify(f.root)} || process.cwd() === ${JSON.stringify(f.root)}) throw new Error('real context');
if (process.env.PI_CODING_AGENT_DIR !== process.env.HOME || process.env.CODEX_HOME !== process.env.HOME) throw new Error('real config');
if (fs.readdirSync(process.env.HOME).length) throw new Error('not empty');
console.log('1.0.0');`;
    f.command('pi', script); f.command('codex', script);
    let queries = 0;
    const value = await discoverAgentStatus(f.config, { env: { HOME: f.root }, extensions: ['throw-secret'], skills: ['secret'] }, {
      fetch() { queries++; throw new Error('network'); }, authFetch() { queries++; throw new Error('refresh'); },
    });
    expect(value.software.every(item => item.status === 'available')).toBe(true); expect(queries).toBe(0); expect(privateReads).toBe(0);
    expect(JSON.stringify(value)).not.toContain('SECRET');
    fs.readFileSync = originalRead;
    files.forEach((file, index) => {
      expect(originalRead(file, 'utf8')).toBe(before[index].data);
      expect(fs.statSync(file).mtimeMs).toBe(before[index].stat.mtimeMs);
    });
    expect(fs.readdirSync(privateDir).sort()).toEqual(['auth.json', 'models.json', 'settings.json']);
  } finally { fs.readFileSync = originalRead; f.close(); }
});

test('unavailable versions are bounded and never expose stdout or stderr', async () => {
  const f = world();
  try {
    for (const code of ["console.log('STDOUT_SECRET'); console.error('STDERR_SECRET'); process.exit(1);",
      "console.log('1.2.3\\nSTDOUT_SECRET');", "console.log('SECRET'.repeat(10000));", 'setInterval(() => {}, 1000);']) {
      f.command('pi', code);
      const result = await discoverAgentStatus(f.config, null, { timeout: 100 });
      expect(result.software[0]).toMatchObject({ status: 'unavailable', version: null });
      expect(result.software[0].warning).toContain('版本诊断失败');
      expect(result.software[1].status).toBe('available'); expect(JSON.stringify(result)).not.toContain('SECRET');
    }
    fs.chmodSync(path.join(f.bin, 'pi'), 0o600);
    expect((await discoverAgentStatus(f.config)).software[0].executable).toBeNull();
  } finally { f.close(); }
});

test('concurrent identical diagnostics are single-flight; explicit recheck and daemon command changes execute again', async () => {
  const f = world();
  try {
    const count = path.join(f.root, 'count');
    const code = `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(count)}, 'x'); await new Promise(r => setTimeout(r, 40)); console.log('1.2.3');`;
    f.command('pi', code); f.command('codex', code);
    const first = discoverAgentStatus(f.config), same = discoverAgentStatus(f.config, { agent: 'pi' });
    expect(first).toBe(same); await first; expect(fs.readFileSync(count, 'utf8')).toBe('xx');
    const next = discoverAgentStatus(f.config); expect(next).not.toBe(first); await next;
    expect(fs.readFileSync(count, 'utf8')).toBe('xxxx');
    const pending = discoverAgentStatus(f.config);
    f.config.env.LUSH_CODEX_COMMAND = './missing';
    const changed = discoverAgentStatus(f.config); expect(changed).not.toBe(pending);
    const [a, b] = await Promise.all([pending, changed]);
    expect(a.software[1].status).toBe('available'); expect(b.software[1].status).toBe('unavailable');
  } finally { f.close(); }
});
