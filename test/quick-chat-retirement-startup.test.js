import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { Config } from '../src/config.js';
import { Store } from '../src/persistence/store.js';
import { createProjectHost } from '../src/host/project-host.js';
import { projectRouteId, writeLauncherState } from '../src/host/registry.js';
import { retireChatProfile, retireProjectChat } from '../src/core/retired-chat.js';
import { seedChat, seedProfile } from './retired-chat-fixture.js';
import { temp, env, repo } from './helpers.js';
import { cli } from './integration/harness.js';

function assertErased(file) {
  const bytes = fs.readFileSync(file);
  for (const text of ['obsolete-content-SENTINEL','obsolete-prompt-SENTINEL','obsolete-response-SENTINEL']) expect(bytes.includes(Buffer.from(text))).toBe(false);
}
test('profile retirement is empty, idempotent, non-initializing and refuses unsafe schema/files/locks', () => {
  for (const kind of ['normal','missing','schema','symlink','hardlink','mode','root','lock']) {
    const root = temp(), home = path.join(root, 'shared'), outside = path.join(root, 'outside');
    fs.writeFileSync(outside, 'outside-kept', { mode: 0o600 });
    try {
      if (kind === 'missing') { expect(retireChatProfile(home)).toEqual({ retired: false }); expect(fs.readdirSync(root)).toEqual(['outside']); continue; }
      const file = seedProfile(home);
      if (kind === 'schema') fs.writeFileSync(file, JSON.stringify({ version: 1, unknown: 'private' }));
      if (kind === 'symlink' || kind === 'hardlink') { fs.unlinkSync(file); kind === 'symlink' ? fs.symlinkSync(outside, file) : fs.linkSync(outside, file); }
      if (kind === 'mode') fs.chmodSync(file, 0o644);
      if (kind === 'root') fs.chmodSync(home, 0o755);
      if (kind === 'lock') fs.mkdirSync(path.join(home, '.settings-write.lock'), { mode: 0o700 });
      const before = fs.readFileSync(file);
      if (kind === 'normal') {
        expect(retireChatProfile(home)).toMatchObject({ retired: true, already_retired: false });
        expect(JSON.parse(fs.readFileSync(file))).toEqual({ version: 2, retired: 'quick-chat' });
        expect(retireChatProfile(home)).toMatchObject({ already_retired: true }); assertErased(file);
      } else { expect(() => retireChatProfile(home)).toThrow('无法安全清除'); expect(fs.readFileSync(file)).toEqual(before); }
      expect(fs.readFileSync(outside, 'utf8')).toBe('outside-kept');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('verified Host binding retires only the bound project and device files, never enumerated projects', async () => {
  const root = temp(), global = path.join(root, 'device'), environment = env({ LUSH_GLOBAL_CONFIG: global });
  const configs = ['a','b'].map(name => { const project = path.join(root, name); fs.mkdirSync(project); const c = new Config({ project, env: environment }); c.prepare(); return c; });
  const files = configs.map(c => seedChat(path.join(c.home, 'quick-chat'))), profiles = configs.map(c => seedProfile(c.home));
  const shared = seedChat(configs[0].deviceHome), sharedProfile = seedProfile(configs[0].deviceHome);
  writeLauncherState(configs[0].project, environment); writeLauncherState(configs[1].project, environment);
  const other = [fs.readFileSync(files[1]), fs.readFileSync(profiles[1])];
  try {
    const host = createProjectHost(null, { env: environment, attachProject: async project => ({ config: configs.find(c => c.project === project), client: {} }) });
    expect(host.chatHome).toBeUndefined(); await host.status();
    expect(fs.readFileSync(files[0]).includes(Buffer.from('obsolete-content-SENTINEL'))).toBe(true);
    await host.openRoute(projectRouteId(configs[0].project));
    for (const file of [files[0], profiles[0], shared, sharedProfile]) assertErased(file);
    expect([fs.readFileSync(files[1]), fs.readFileSync(profiles[1])]).toEqual(other);
    expect(fs.existsSync(path.join(configs[0].home, 'project.db'))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('failed Host retirement is not replayed by polling; explicit start may retry after repair', async () => {
  const root = temp(), environment = env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') });
  const config = new Config({ project: root, env: environment }); config.prepare();
  const file = seedChat(path.join(config.home, 'quick-chat'), { running: true });
  writeLauncherState(root, environment);
  let attaches = 0;
  const bind = async () => { attaches++; return { config, client: {} }; };
  const host = createProjectHost(null, { env: environment, attachProject: bind, openProject: bind });
  try {
    await expect(host.openRoute(projectRouteId(root))).rejects.toThrow('owner');
    const db = new Database(file); db.exec("UPDATE turns SET status='failed',error='interrupted'"); db.close();
    await expect(host.openRoute(projectRouteId(root))).rejects.toThrow('owner'); expect(attaches).toBe(1);
    await host.start(projectRouteId(root)); expect(attaches).toBe(2); assertErased(file);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mismatched project binding refuses attachments and device cleanup', () => {
  const root = temp(), environment = env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') });
  const config = new Config({ project: root, env: environment }); config.prepare();
  const file = seedChat(path.join(config.home, 'quick-chat')), profile = seedProfile(config.deviceHome);
  try {
    fs.writeFileSync(path.join(config.home, 'project.json'), JSON.stringify({ version: 2, path: '/not-this-project' }));
    const before = [fs.readFileSync(file), fs.readFileSync(profile)];
    expect(() => retireProjectChat(config)).toThrow('归属');
    expect([fs.readFileSync(file), fs.readFileSync(profile)]).toEqual(before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('actual daemon startup erases chat resources while preserving Agent credentials, Worker/run/reference history', async () => {
  const root = temp(), global = temp(), settings = { LUSH_GLOBAL_CONFIG: global };
  let started = false;
  try {
    await repo(root);
    const config = new Config({ project: root, env: env(settings) }); config.prepare();
    const store = new Store(path.join(config.home, 'project.db'), root);
    const task = store.create({ role: 'explainer', name: 'old-explainer', goal: 'historical' });
    store.update(task.id, { status: 'completed', result: 'Worker-kept' });
    const run = store.startRun(store.task(task.id)); store.finishRun(run.id, 'completed', { result: 'run-kept' });
    store.event(task.id, 'explanation.requested', { quote: 'reference-kept' });
    const before = ['tasks','agent_runs','events'].map(table => store.all(`SELECT * FROM ${table}`)); store.close();
    const files = [seedChat(path.join(config.home, 'quick-chat')), seedProfile(config.home), seedChat(config.deviceHome), seedProfile(config.deviceHome)];
    const agent = path.join(config.deviceHome, 'agent.json'), credentials = path.join(config.deviceHome, 'credentials', 'agent-connections.json');
    fs.writeFileSync(agent, JSON.stringify({ version: 1, default: { agent: 'pi', model: 'Agent-kept' }, roles: {} }), { mode: 0o600 });
    fs.mkdirSync(path.dirname(credentials), { mode: 0o700 });
    fs.writeFileSync(credentials, JSON.stringify({ version: 1, connections: [] }), { mode: 0o600 });
    const kept = [fs.readFileSync(agent), fs.readFileSync(credentials)];
    try { await cli(root, ['start'], settings); started = true; }
    catch (error) { fs.copyFileSync(path.join(config.home, 'daemon.log'), '/tmp/lush-w235-2-logs/startup-daemon-failure.log'); throw error; }
    for (const file of files) assertErased(file);
    expect([fs.readFileSync(agent), fs.readFileSync(credentials)]).toEqual(kept);
    const db = new Database(path.join(config.home, 'project.db'), { readonly: true });
    try {
      expect(db.query('SELECT * FROM tasks WHERE id=?').get(task.id)).toEqual(before[0][0]);
      expect(db.query('SELECT * FROM agent_runs').all()).toEqual(before[1]);
      expect(db.query("SELECT * FROM events WHERE task_id=1").all()).toEqual(before[2]);
    } finally { db.close(); }
  } finally {
    if (started) await cli(root, ['stop'], settings);
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(global, { recursive: true, force: true });
  }
}, 30000);
