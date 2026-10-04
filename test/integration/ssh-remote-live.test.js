import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { buildRemotePayload } from '../../scripts/build-remote.js';
import { createSSHManager } from '../../src/ui/desktop/ssh.js';
import { shellQuote } from '../../src/ui/desktop/ssh-scripts.js';
import { env, repo, until } from '../helpers.js';
import { desktopFixture } from '../desktop/runtime-fixture.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const enabled = process.env.LUSH_SSH_LIVE_TEST === '1';
const runtime = process.env.LUSH_REMOTE_TEST_BUN;
const sshd = process.env.LUSH_TEST_SSHD || Bun.which('sshd');
function command(file, args, options = {}) {
  const result = cp.spawnSync(file, args, { encoding: 'utf8', timeout: 30000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(file)} failed: ${result.error?.message || result.stderr}`);
  return result.stdout;
}
function port() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const value = socket.address().port; socket.close(error => error ? reject(error) : resolve(value)); });
  });
}
function request(base, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const req = http.request(url, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', Origin: url.origin } : {} }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.once('error', reject);
      res.once('end', () => { try { if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}: ${text}`); resolve(JSON.parse(text)); } catch (error) { reject(error); } });
    });
    req.once('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

// Opt-in: a temporary loopback sshd, separate keys/config/HOME/project; never touches user services or SSH files.
test.skipIf(!enabled)('desktop IPC and real loopback SSH install a portable payload, start Host and a project daemon, and reconnect without reinstalling', async () => {
  if (!runtime || !sshd) throw new Error('Opt-in live test requires LUSH_REMOTE_TEST_BUN and a usable sshd (or LUSH_TEST_SSHD)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-ssh-live-'));
  const home = path.join(directory, 'remote-home'), tools = path.join(directory, 'tools'), project = path.join(directory, 'project');
  for (const dir of [home, tools, project]) fs.mkdirSync(dir, { mode: 0o700 });
  const remoteEnv = env({ HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') });
  let server, manager, inspection, ui, serverErrors = '', failure;
  const clients = [];
  try {
    await repo(project);
    // Keep existing Bun/Agent CLIs out of the remote PATH, exercising the actual private Bun fallback.
    for (const name of ['sh', 'base64', 'stat', 'id', 'uname', 'head', 'tr', 'git', 'tar', 'gzip', 'sha256sum', 'mkdir', 'cat', 'chmod', 'mv', 'rm', 'rmdir', 'mktemp', 'nohup', 'ps', 'ss', 'lsof']) {
      const file = Bun.which(name); if (file) fs.symlinkSync(fs.realpathSync(file), path.join(tools, name));
    }
    const source = path.join(directory, 'payload');
    buildRemotePayload({ root: ROOT, bun: runtime, out: source });
    const keygen = Bun.which('ssh-keygen'), ssh = Bun.which('ssh');
    if (!keygen || !ssh) throw new Error('OpenSSH client/keygen is required for the opt-in live test');
    const key = path.join(directory, 'client-key'), hostKey = path.join(directory, 'host-key');
    command(keygen, ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    command(keygen, ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
    const sshPort = await port(), user = os.userInfo().username;
    const knownHosts = path.join(directory, 'known-hosts');
    fs.writeFileSync(knownHosts, `[127.0.0.1]:${sshPort} ${fs.readFileSync(`${hostKey}.pub`, 'utf8')}`, { mode: 0o600 });
    const wrapper = path.join(directory, 'remote-shell');
    const libraryEnv = ['NIX_LD', 'NIX_LD_LIBRARY_PATH'].filter(name => remoteEnv[name]).map(name => `export ${name}=${shellQuote(remoteEnv[name])}`).join('\n');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexport HOME=${shellQuote(home)}\nexport PATH=${shellQuote(tools)}\nexport GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null\nexport LUSH_PROVIDER=mock\n${libraryEnv}\nexec ${shellQuote(fs.realpathSync(Bun.which('sh')))} -c "$SSH_ORIGINAL_COMMAND"\n`, { mode: 0o700 });
    // Fixture keys live under owner-only mkdtemp, but OpenSSH StrictModes rejects its /tmp ancestor.
    // This setting belongs only to this temporary test server; client host-key checks remain strict.
    const serverConfig = path.join(directory, 'sshd_config');
    fs.writeFileSync(serverConfig, `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${directory}/sshd.pid\nAuthorizedKeysFile ${key}.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM no\nAllowUsers ${user}\nPermitRootLogin prohibit-password\nAllowTcpForwarding local\nGatewayPorts no\nX11Forwarding no\nAllowAgentForwarding no\nPermitTunnel no\nPermitUserRC no\nSetEnv HOME=${home}\nForceCommand ${wrapper}\nLogLevel VERBOSE\n`);
    command(sshd, ['-t', '-f', serverConfig], { env: remoteEnv });
    server = cp.spawn(sshd, ['-D', '-e', '-f', serverConfig], { env: remoteEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr.on('data', chunk => { serverErrors = (serverErrors + chunk).slice(-16384); });
    await until(async () => {
      if (server.exitCode !== null) throw new Error(`Temporary sshd exited: ${serverErrors}`);
      return new Promise(resolve => { const socket = net.connect(sshPort, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
    });
    const clientConfig = path.join(directory, 'ssh_config');
    fs.writeFileSync(clientConfig, `Host fixture-server\n  HostName 127.0.0.1\n  User ${user}\n  Port ${sshPort}\n  IdentityFile ${key}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${knownHosts}\n  GlobalKnownHostsFile /dev/null\n`);
    manager = createSSHManager({ payloadDir: source, userData: path.join(directory, 'client'), timeoutMs: 60000,
      spawn: (file, args, options) => {
        expect(file).toBe('ssh'); expect(options.env.LUSH_AGENT_TOKEN).toBeUndefined();
        const child = cp.spawn(ssh, ['-F', clientConfig, ...args], options); clients.push(child); return child;
      } });
    ui = desktopFixture('win32', manager); // Real IPC implementation; only Electron windows are simulated.
    await ui.desktop.start(); const chooser = ui.all[0];
    inspection = await ui.invoke('lush:ssh-inspect', chooser, { alias: 'fixture-server' });
    expect(inspection.requiresInstall).toBe(true); expect(inspection.plan.useExistingBun).toBe(false);
    expect(fs.existsSync(path.join(home, '.local'))).toBe(false);
    const authorization = { confirmation: inspection.confirmation, install: true };
    await expect(ui.invoke('lush:ssh-connect', chooser, { ...authorization, alias: 'replacement' })).rejects.toThrow('先预检');
    const connection = await ui.invoke('lush:ssh-connect', chooser, authorization);
    await expect(ui.invoke('lush:ssh-connect', chooser, authorization)).rejects.toThrow('先预检');
    expect(ui.all[1].options.webPreferences.partition).toStartWith('persist:lush-ssh-');
    expect(ui.stats().starts).toBe(0); // Simulated Windows never starts a local backend.
    await expect(ui.invoke('lush:ui-preferences', ui.all[1])).rejects.toThrow('remote');
    await expect(ui.invoke('lush:ui-preferences', chooser)).rejects.toThrow('untrusted');
    expect(await ui.invoke('lush:connections-list', chooser)).toHaveLength(0);
    const host = await request(connection.url, '/api/host');
    expect(host.mode).toBe('host');
    const selected = await request(connection.url, '/api/host/select', { project });
    const summary = await request(connection.url, `/p/${selected.id}/api/snapshot`);
    expect(summary.status.project).toBe(project);
    const privateRuntime = path.join(inspection.plan.installDirectory, 'bun');
    expect(command(privateRuntime, ['--version'], { env: remoteEnv }).trim()).toBe('1.4.2');
    const installed = fs.statSync(inspection.plan.installDirectory).mtimeMs;
    await ui.invoke('lush:ssh-disconnect', chooser, inspection.profile.id);
    await until(() => !manager.list()[0].connected);
    // Wait for the owned tunnel child to exit; do not bypass the manager's old-process exclusion.
    await until(() => clients.every(child => child.exitCode !== null || child.signalCode !== null));
    const again = await ui.invoke('lush:ssh-inspect', chooser, inspection.profile);
    expect(again.ready).toBe(true);
    const reconnected = await ui.invoke('lush:ssh-connect', chooser, { confirmation: again.confirmation, install: false });
    expect(ui.all[2].options.webPreferences.partition).toBe(ui.all[1].options.webPreferences.partition);
    expect(reconnected.url).toBe(connection.url);
    expect((await request(reconnected.url, '/api/host')).pid).toBe(host.pid);
    expect(fs.statSync(inspection.plan.installDirectory).mtimeMs).toBe(installed);
  } catch (error) { failure = error; }
  finally {
    try { ui?.close(); } catch (error) { failure ||= error; }
    manager?.dispose();
    if (inspection) {
      const installed = inspection.plan.installDirectory, bin = path.join(installed, 'bun'), cli = path.join(installed, 'bin/lush');
      if (fs.existsSync(bin)) {
        const commands = [];
        if (fs.existsSync(path.join(project, '.lush/daemon.lock'))) commands.push([[cli, '--project', project, 'daemon', 'stop', '--json'], remoteEnv]);
        if (fs.existsSync(path.join(inspection.plan.hostScope, 'host.state.json'))) commands.push([[cli, 'host', 'stop', '--json'], { ...remoteEnv, LUSH_GLOBAL_CONFIG: inspection.plan.hostScope }]);
        for (const [args, environment] of commands) {
          try { command(bin, args, { env: environment, cwd: installed }); }
          catch (error) { failure ||= error; }
        }
      }
    }
    for (const child of clients) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await until(() => clients.every(child => child.exitCode !== null || child.signalCode !== null)).catch(error => { failure ||= error; });
    if (server && server.exitCode === null && server.signalCode === null) { const closed = new Promise(resolve => server.once('close', resolve)); server.kill('SIGTERM'); await closed; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  if (failure) throw new Error(`${failure.stack}\nTemporary sshd diagnostics:\n${serverErrors}`);
}, 120000);
