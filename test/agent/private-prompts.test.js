import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from '../helpers.js';
import { agentPrompt, AGENT_ROLES } from '../../src/agent/prompts.js';
import { readPrivatePrompt, PRIVATE_PROMPT_MAX_BYTES, PROMPT_SUPPLEMENT_TARGETS } from '../../src/agent/private-prompts.js';
import { run } from '../../src/cli/commands/agent.js';
import { acquireConfigurationLock } from '../../src/core/device-config.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = temp(); roots.push(root);
  const deviceHome = path.join(root, 'device', 'shared');
  const configs = ['a', 'b'].map(name => {
    const project = path.join(root, name), home = path.join(project, '.lush');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    return { project, home, deviceHome };
  });
  return { root, configs, a: configs[0], b: configs[1], deviceHome };
}
function write(home, relative, body, mode = 0o600) {
  const file = path.join(home, relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, body, { mode }); return file;
}
const init = (config, args = ['worker', '--local'], token = null) => run('agent', ['init', ...args], {
  client: { config, token, request() { throw new Error('init must not call RPC'); } }, json: true,
});
const safeError = (fn, secret = 'PRIVATE-MARKDOWN') => {
  let message;
  try { fn(); } catch (error) { message = error.message; }
  expect(message).toBeString(); expect(message).not.toContain(secret); return message;
};

test('two projects share private device supplements while repository conventions and full Worker prompts stay isolated', () => {
  const f = fixture();
  write(f.a.project, '.lush-agent/common.md', 'REPOSITORY A');
  write(f.b.project, '.lush-agent/common.md', 'REPOSITORY B');
  write(f.deviceHome, 'agent/common.md', 'PERSONAL COMMON');
  write(f.deviceHome, 'agent/worker.md', 'PERSONAL WORKER');
  for (const config of f.configs) write(config.home, 'agent/common.md', 'INACTIVE LEGACY');
  for (const [config, own, other] of [[f.a, 'REPOSITORY A', 'REPOSITORY B'], [f.b, 'REPOSITORY B', 'REPOSITORY A']]) {
    const view = agentPrompt(config, 'worker', { default_prompt: 'WORKER REPLACEMENT', append_prompt: 'WORKER APPEND' });
    expect(view.parts.map(part => part.name)).toEqual(['settings.default_prompt', 'project.common', 'local.common', 'local.worker', 'settings.append_prompt']);
    expect(view.text).toContain(own); expect(view.text).not.toContain(other); expect(view.text).not.toContain('INACTIVE LEGACY');
    for (const text of ['WORKER REPLACEMENT', 'PERSONAL COMMON', 'PERSONAL WORKER', 'WORKER APPEND']) expect(view.text).toContain(text);
    expect(view.customization.local).toEqual(['common.md', 'worker.md'].map(name => path.join(f.deviceHome, 'agent', name)));
  }
  expect(AGENT_ROLES).toEqual(PROMPT_SUPPLEMENT_TARGETS.slice(1));
});

test('missing device supplements do not create a root or fall back to any legacy project files', () => {
  const f = fixture(); write(f.a.home, 'agent/common.md', 'INACTIVE LEGACY', 0o644);
  const before = fs.readFileSync(path.join(f.a.home, 'agent/common.md'));
  expect(agentPrompt(f.a, 'worker').text).not.toContain('INACTIVE LEGACY');
  expect(readPrivatePrompt(f.a, 'common')).toBeNull(); expect(fs.existsSync(f.deviceHome)).toBe(false);
  expect(fs.readFileSync(path.join(f.a.home, 'agent/common.md'))).toEqual(before);
  const legacy = { ...f.a, deviceHome: null };
  expect(agentPrompt(legacy, 'worker').text).toContain('INACTIVE LEGACY');
  expect(agentPrompt(legacy, 'worker').customization.local[0]).toBe(path.join(f.a.home, 'agent/common.md'));
});

test('manager and Pi-default modes never inspect private or repository overlays, even unsafe ones', () => {
  const f = fixture(); fs.symlinkSync(f.a.home, f.deviceHome.replace('/shared', ''));
  write(f.a.project, '.lush-agent/common.md', 'DEVELOPER CONTENT');
  for (const [role, profile, kind] of [['manager', { default_prompt: 'REPLACE', append_prompt: 'APPEND' }, 'management'], ['worker', { config_mode: 'pi', default_prompt: 'REPLACE', append_prompt: 'APPEND' }, null]]) {
    const view = agentPrompt(f.a, role, profile, kind);
    expect(view.customization.local).toEqual([]); expect(view.customization.project).toEqual([]);
    expect(view.parts.every(part => part.source === 'builtin')).toBe(true);
    for (const text of ['REPLACE', 'APPEND', 'DEVELOPER CONTENT']) expect(view.text).not.toContain(text);
  }
  expect(() => agentPrompt(f.a, 'worker')).toThrow('safely read');
});

test('the raw private file limit precedes trimming, and the total assembled limit is unchanged', () => {
  const f = fixture(); write(f.deviceHome, 'agent/common.md', ' '.repeat(PRIVATE_PROMPT_MAX_BYTES + 1));
  expect(() => agentPrompt(f.a, 'worker')).toThrow('safely read');
  write(f.deviceHome, 'agent/common.md', 'x'.repeat(40000)); write(f.deviceHome, 'agent/worker.md', 'y'.repeat(40000));
  expect(() => agentPrompt(f.a, 'worker')).toThrow('assembled worker prompt exceeds 65536');
  write(f.deviceHome, 'agent/common.md', 'PERSONAL PLANNER'); write(f.deviceHome, 'agent/planner.md', 'PLANNER ROLE');
  expect(agentPrompt(f.a, 'scheduler').text).toContain('PLANNER ROLE');
});

test('user init --local creates only private device files under the shared settings lock and never overwrites', async () => {
  const f = fixture();
  const first = await init(f.a);
  expect(first).toMatchObject({ scope: 'device', role: 'worker', existing: [], directory: path.join(f.deviceHome, 'agent') });
  expect(first.created).toEqual(['common.md', 'worker.md'].map(name => path.join(f.deviceHome, 'agent', name)));
  for (const dir of [f.deviceHome, first.directory]) expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  for (const name of ['common.md', 'worker.md', 'README.md']) expect(fs.statSync(path.join(first.directory, name)).mode & 0o777).toBe(0o600);
  const common = write(f.deviceHome, 'agent/common.md', 'PRIVATE-MARKDOWN'), before = fs.statSync(common);
  const second = await init(f.b);
  expect(second.created).toEqual([]); expect(second.existing).toEqual(first.created);
  expect(fs.readFileSync(common, 'utf8')).toBe('PRIVATE-MARKDOWN'); expect(fs.statSync(common).ino).toBe(before.ino);
  expect(fs.existsSync(path.join(f.a.home, 'agent'))).toBe(false); expect(fs.existsSync(path.join(f.b.home, 'agent'))).toBe(false);
  expect(fs.existsSync(path.join(f.deviceHome, '.settings-write.lock'))).toBe(false);
  const lock = acquireConfigurationLock(f.a, 'device');
  try { await expect(init(f.b, ['research', '--local'])).rejects.toThrow('busy'); lock.assert(); }
  finally { lock.release(); }
  expect(fs.existsSync(path.join(f.deviceHome, 'agent/research.md'))).toBe(false);
});

test('CLI init remains user-only and repository init remains project-local', async () => {
  const f = fixture();
  for (const args of [['worker', '--local'], ['worker']]) await expect(init(f.a, args, 'invocation-token')).rejects.toThrow('agents cannot');
  expect(fs.existsSync(f.deviceHome)).toBe(false); expect(fs.existsSync(path.join(f.a.project, '.lush-agent'))).toBe(false);
  await init(f.a, ['worker']);
  expect(fs.existsSync(path.join(f.a.project, '.lush-agent/worker.md'))).toBe(true); expect(fs.existsSync(f.deviceHome)).toBe(false);
  await expect(init(f.a, ['../worker', '--local'])).rejects.toThrow('role must');
});

for (const problem of ['root-mode', 'agent-mode', 'root-symlink', 'agent-symlink', 'dangling-ancestor', 'file-mode', 'symlink', 'hardlink', 'oversize', 'foreign-root', 'foreign-file', 'utf8']) {
  test(`private Prompt read/init reject ${problem} without repairing, overwriting or leaking contents`, async () => {
    const f = fixture(); const file = write(f.deviceHome, 'agent/common.md', 'PRIVATE-MARKDOWN');
    let restore = () => {};
    if (problem === 'root-mode') fs.chmodSync(f.deviceHome, 0o755);
    if (problem === 'agent-mode') fs.chmodSync(path.dirname(file), 0o755);
    if (problem === 'root-symlink' || problem === 'agent-symlink') {
      const original = problem === 'root-symlink' ? f.deviceHome : path.dirname(file);
      fs.renameSync(original, original + '-real'); fs.symlinkSync(original + '-real', original);
    }
    if (problem === 'dangling-ancestor') {
      fs.rmSync(path.dirname(f.deviceHome), { recursive: true }); fs.symlinkSync(path.join(f.root, 'absent'), path.dirname(f.deviceHome));
    }
    if (problem === 'file-mode') fs.chmodSync(file, 0o644);
    if (problem === 'symlink') { fs.renameSync(file, file + '-real'); fs.symlinkSync(file + '-real', file); }
    if (problem === 'hardlink') fs.linkSync(file, file + '-alias');
    if (problem === 'oversize') fs.writeFileSync(file, 'PRIVATE-MARKDOWN'.repeat(5000));
    if (problem === 'utf8') fs.writeFileSync(file, Buffer.from([0xff]));
    if (problem.startsWith('foreign-')) {
      const original = fs.lstatSync, selected = problem === 'foreign-root' ? f.deviceHome : file;
      fs.lstatSync = function (name, ...args) {
        const stat = original.call(this, name, ...args);
        return name === selected ? new Proxy(stat, { get(target, key) { return key === 'uid' ? process.getuid() + 1 : Reflect.get(target, key); } }) : stat;
      };
      restore = () => { fs.lstatSync = original; };
    }
    try {
      expect(safeError(() => readPrivatePrompt(f.a, 'common'))).toContain('safely read');
      await expect(init(f.b)).rejects.toThrow(problem === 'root-mode' || problem === 'root-symlink' || problem === 'dangling-ancestor' || problem === 'foreign-root' ? 'configuration' : 'Prompt');
      expect(fs.existsSync(path.join(f.deviceHome, 'agent/worker.md'))).toBe(false);
    } finally { restore(); }
  });
}

for (const mutation of ['file', 'directory', 'hardlink']) {
  test(`bounded private reader rejects a late ${mutation} identity change`, () => {
    const f = fixture(), file = write(f.deviceHome, 'agent/common.md', 'PRIVATE-MARKDOWN');
    const original = fs.readSync; let fired = false;
    fs.readSync = function (...args) {
      const result = original.apply(this, args);
      if (!fired) {
        fired = true;
        if (mutation === 'file') { fs.renameSync(file, file + '-old'); write(f.deviceHome, 'agent/common.md', 'PRIVATE-MARKDOWN'); }
        if (mutation === 'directory') { fs.renameSync(path.dirname(file), path.dirname(file) + '-old'); write(f.deviceHome, 'agent/common.md', 'PRIVATE-MARKDOWN'); }
        if (mutation === 'hardlink') fs.linkSync(file, file + '-alias');
      }
      return result;
    };
    try { expect(safeError(() => readPrivatePrompt(f.a, 'common'))).toContain('safely read'); expect(fired).toBe(true); }
    finally { fs.readSync = original; }
  });
}

test('CLI rechecks every created file at completion, not just the last opened fd', async () => {
  const f = fixture(), common = path.join(f.deviceHome, 'agent/common.md'), original = fs.writeFileSync; let fired = false;
  fs.writeFileSync = function (file, body, ...args) {
    const result = original.call(this, file, body, ...args);
    if (!fired && typeof body === 'string' && body.startsWith('# Lush agent customization')) {
      fired = true; fs.renameSync(common, common + '-old'); original.call(this, common, 'PRIVATE-MARKDOWN replacement', { mode: 0o600 });
    }
    return result;
  };
  try { await expect(init(f.a)).rejects.toThrow('Prompt initialization'); expect(fired).toBe(true); }
  finally { fs.writeFileSync = original; }
  expect(fs.readFileSync(common, 'utf8')).toBe('PRIVATE-MARKDOWN replacement');
});

for (const mutation of ['file', 'directory']) {
  test(`create-only CLI rejects a late ${mutation} replacement without writing the replacement`, async () => {
    const f = fixture(), file = path.join(f.deviceHome, 'agent/common.md');
    const original = fs.openSync; let fired = false;
    fs.openSync = function (name, ...args) {
      const fd = original.call(this, name, ...args);
      if (!fired && name === file) {
        fired = true;
        if (mutation === 'file') { fs.renameSync(file, file + '-old'); write(f.deviceHome, 'agent/common.md', 'PRIVATE-MARKDOWN'); }
        else { fs.renameSync(path.dirname(file), path.dirname(file) + '-old'); write(f.deviceHome, 'agent/common.md', 'PRIVATE-MARKDOWN'); }
      }
      return fd;
    };
    try { await expect(init(f.a)).rejects.toThrow('Prompt initialization'); expect(fired).toBe(true); }
    finally { fs.openSync = original; }
    expect(fs.readFileSync(file, 'utf8')).toBe('PRIVATE-MARKDOWN');
    expect(fs.existsSync(path.join(f.deviceHome, '.settings-write.lock'))).toBe(false);
  });
}
