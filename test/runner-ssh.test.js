import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSshAliases, RunnerSsh, SSH_LIMITS, sshTrialArguments } from '../src/core/runner-ssh.js';
import { validateRunnerParams, publicRunnerResult } from '../src/rpc/runner-methods.js';
import { managementFixture } from './runner-management-fixture.js';
import { sshFixture } from './runner-ssh-fixture.js';

function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-test-ssh-')); return { root, ...sshFixture(root), close() { fs.rmSync(root, { recursive: true, force: true }); } }; }
test('safe concrete aliases, quoted values, bounded in-directory Includes; discovery never starts a process or exposes body/private keys', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.directory, 'conf.d'), { mode: 0o700 });
    fs.writeFileSync(path.join(f.directory, 'conf.d/a.conf'), 'Host included\n HostName internal.example\nInclude config\n', { mode: 0o600 });
    fs.writeFileSync(path.join(f.directory, 'private'), '-----BEGIN OPENSSH PRIVATE KEY-----\nHost secret-key-material\n-----END OPENSSH PRIVATE KEY-----', { mode: 0o600 });
    f.config('Host alpha beta * !negative wild? unsafe@host -option\nHost "quoted"\n HostName "private-host.example"\n User user\n Port 2222\n IdentityFile ~/.ssh/id_ed25519\nInclude conf.d/*.conf\nInclude private\nMatch exec "touch /never-run"\n HostName secret\nHost final\n');
    const reader = new RunnerSsh(f.options), result = reader.discover();
    // An unsafe Host clause is excluded as a whole, rather than broadening its connection scope.
    expect(result).toEqual({ aliases: ['final', 'included', 'quoted'], status: 'ok', limited: true });
    expect(JSON.stringify(result)).not.toMatch(/private-host|secret|IdentityFile|PRIVATE KEY/);
    expect(f.calls()).toBe(0);
    const snapshot = readSshAliases({ home: f.home });
    expect(snapshot.configuration).toContain('hostname "private-host.example"');
    expect(snapshot.configuration).not.toMatch(/Match|exec|touch|PRIVATE KEY|secret-key/);
    f.config('Host alpha beta * !negative wild?\n');
    expect(reader.discover().aliases).toEqual(['alpha', 'beta']);
  } finally { f.close(); }
});

test('Include escapes, symlinks, writable directories/files, cycles and unsupported glob paths are skipped, never opened as trusted config', () => {
  const f = fixture();
  try {
    const external = path.join(f.root, 'external'); fs.writeFileSync(external, 'Host external-secret\n');
    fs.symlinkSync(external, path.join(f.directory, 'link'));
    fs.mkdirSync(path.join(f.directory, 'writable'), { mode: 0o777 }); fs.chmodSync(path.join(f.directory, 'writable'), 0o777);
    fs.writeFileSync(path.join(f.directory, 'writable/config'), 'Host unsafe-dir\n');
    fs.symlinkSync(f.root, path.join(f.directory, 'dirlink'));
    f.config(`Host safe\nInclude ../external ${external} /etc/ssh/ssh_config ~/.other/* link dirlink/external writable/config */config config\n`);
    expect(new RunnerSsh(f.options).discover()).toEqual({ aliases: ['safe'], status: 'ok', limited: true });
    fs.chmodSync(path.join(f.directory, 'config'), 0o666);
    expect(new RunnerSsh(f.options).discover()).toEqual({ aliases: [], status: 'unavailable', limited: true });
    fs.unlinkSync(path.join(f.directory, 'config')); fs.symlinkSync(external, path.join(f.directory, 'config'));
    expect(new RunnerSsh(f.options).discover().status).toBe('unavailable');
    fs.unlinkSync(path.join(f.directory, 'config')); fs.rmSync(path.join(f.directory, 'writable'), { recursive: true });
    expect(new RunnerSsh(f.options).discover().status).toBe('missing');
    fs.renameSync(f.directory, `${f.directory}-original`); fs.symlinkSync(f.root, f.directory);
    expect(new RunnerSsh(f.options).discover().status).toBe('unavailable');
  } finally { f.close(); }
});

test('configuration total/per-file/alias/file/depth/directory budgets are bounded and explicitly limited', () => {
  const f = fixture();
  try {
    f.config('Host huge\n' + '#'.repeat(SSH_LIMITS.file_bytes));
    expect(new RunnerSsh(f.options).discover().aliases).toEqual([]);
    f.config(Array.from({ length: 300 }, (_, i) => `Host node${i}`).join('\n'));
    expect(new RunnerSsh(f.options).discover()).toMatchObject({ limited: true, status: 'ok' });
    expect(new RunnerSsh(f.options).discover().aliases).toHaveLength(SSH_LIMITS.aliases);
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(f.directory, `c${i}`), `Host n${i}\nInclude c${i + 1}\n`, { mode: 0o600 });
    f.config('Include c0\n'); expect(new RunnerSsh(f.options).discover().aliases).toHaveLength(4);
    f.config('Include c*\n'); expect(new RunnerSsh(f.options).discover().aliases.length).toBeLessThanOrEqual(31);
    expect(new RunnerSsh(f.options).discover().limited).toBe(true);
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(f.directory, `b${i}`), '# padding\n'.repeat(5000) + `Host b${i}\n`, { mode: 0o600 });
    f.config('Include b*\n'); expect(new RunnerSsh(f.options).discover().aliases).toHaveLength(2);
    expect(new RunnerSsh(f.options).discover().limited).toBe(true);
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(f.directory, `entry${i}`), '', { mode: 0o600 });
    f.config('Include entry*\n'); expect(new RunnerSsh(f.options).discover().limited).toBe(true);
  } finally { f.close(); }
});

test('explicit SSH trial launches fixed strict argv and sanitized snapshot once, no credential/save dependency; failure/output/deadline bounded and sanitized', async () => {
  const f = fixture();
  try {
    f.config('Host fixture\n HostName localhost\n LocalCommand touch /never-run\n ProxyCommand private-command\n ProxyJump private-jump\nMatch exec "touch /never-run"\n');
    const reader = new RunnerSsh(f.options);
    expect(reader.discover().aliases).toEqual(['fixture']); expect(f.calls()).toBe(0);
    expect(await reader.test('fixture')).toMatchObject({ ok: false, reason: 'config_unsupported' }); expect(f.calls()).toBe(0);
    f.config('Host fixture\n HostName localhost\n');
    expect(await reader.test('fixture')).toMatchObject({ ok: true, reason: 'connected' });
    const record = f.records()[0];
    expect(record.config).toBe('Host fixture\nhostname "localhost"\n'); expect(record.mode).toBe(0o600);
    expect(record.args.slice(-3)).toEqual(['--', 'fixture', 'true']);
    for (const flag of ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'UpdateHostKeys=no', 'PermitLocalCommand=no', 'ClearAllForwardings=yes', 'ForwardAgent=no', 'ProxyCommand=none', 'KnownHostsCommand=none', 'ControlPath=none', 'CanonicalizeHostname=no', 'PKCS11Provider=none', 'SecurityKeyProvider=none']) expect(record.args).toContain(flag);
    expect(record.args).not.toContain('-G'); expect(record.env).not.toContain('LUSH_AGENT_TOKEN');
    expect(fs.existsSync(record.args[record.args.indexOf('-F') + 1])).toBe(false);
    expect(await reader.test('fail')).toMatchObject({ ok: false, reason: 'not_confirmed' });
    expect(await reader.test('flood')).toMatchObject({ ok: false, reason: 'output_limit' });
    const short = new RunnerSsh({ ...f.options, timeout_ms: 100 });
    const hanging = short.test('hang'); await expect(short.test('fixture')).rejects.toThrow('progress');
    expect(await hanging).toMatchObject({ ok: false, reason: 'timeout' });
    expect(f.calls()).toBe(4);
    for (const value of ['-oX', 'user@host', 'a;true', 'a\nb', '*', '../x']) {
      await expect(reader.test(value)).rejects.toThrow(); expect(() => sshTrialArguments(value, '/tmp/config')).toThrow();
    }
    expect(f.calls()).toBe(4);
    fs.chmodSync(path.join(f.directory, 'config'), 0o666);
    expect(await reader.test('fixture')).toMatchObject({ ok: false, reason: 'config_unavailable' });
    expect(f.calls()).toBe(4);
  } finally { f.close(); }
});

test('unsupported routing/authentication/Match/escape and incomplete Include never launch SSH, even for another alias or manual input', async () => {
  const f = fixture(), reader = new RunnerSsh(f.options);
  try {
    const unsupported = ['ProxyJump bastion', 'ProxyCommand private-command', 'Match exec "private-command"',
      'CanonicalizeHostname yes', 'PKCS11Provider /private-library', 'SecurityKeyProvider /private-provider',
      'HostName target\\\\suffix', 'HostName "target\\\\\"suffix"', "HostName 'single-quoted'", 'HostName target""', 'HostName "target"suffix', 'User %r', 'User "escaped\\\\ user"',
      'Port %p', 'Port "\\\\2222"', 'IdentityFile ~/.ssh/id_%h', 'IdentityFile ~/.ssh/key\\\\ name', 'Include missing.conf', 'Include /external/config'];
    for (const clause of unsupported) {
      f.config(`Host fixture\n HostName intended.example\nHost unrelated\n ${clause}\n`);
      expect(await reader.test('fixture')).toMatchObject({ ok: false, reason: 'config_unsupported' });
      expect(await reader.test('manual')).toMatchObject({ ok: false, reason: 'config_unsupported' });
    }
    fs.writeFileSync(path.join(f.directory, 'conditional.conf'), 'Host fixture\n HostName wrong.example\n', { mode: 0o600 });
    f.config('Host unrelated\nInclude conditional.conf\nHost fixture\n HostName intended.example\n');
    expect(reader.discover()).toMatchObject({ aliases: ['fixture', 'unrelated'], limited: true });
    expect(await reader.test('fixture')).toMatchObject({ ok: false, reason: 'config_unsupported' });
    f.config('Host fixture\n' + '#'.repeat(SSH_LIMITS.file_bytes));
    expect(await reader.test('fixture')).toMatchObject({ ok: false, reason: 'config_unsupported' });
    expect(f.calls()).toBe(0); expect(f.records()).toEqual([]);
  } finally { f.close(); }
});

test('supported double-quoted literals and wildcard/negative Host inheritance retain original order without key reads', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.directory, 'hosts.conf'), 'Host lab-* !lab-excluded\n User "inherited"\n Port "2222"\n IdentityFile "~/.ssh/key with spaces"\n', { mode: 0o600 });
    f.config('# user\'s comment may contain $ and \\\\ without affecting config\nInclude hosts.conf\nHost lab-one\n HostName "intended.example" # quoted literal\n User specific\n Port 2200\n IdentitiesOnly yes\nHost *\n User fallback\n Port 22\n');
    const reader = new RunnerSsh(f.options);
    expect(reader.discover()).toEqual({ aliases: ['lab-one'], status: 'ok', limited: false });
    expect(await reader.test('lab-one')).toMatchObject({ ok: true, reason: 'connected' });
    // SSH receives all matching clauses in original order: first scalar wins and IdentityFile remains additive.
    expect(f.records()[0].config).toBe(`Host lab-* !lab-excluded\nuser "inherited"\nport "2222"\nidentityfile "${f.home}/.ssh/key with spaces"\nHost lab-one\nhostname "intended.example"\nuser "specific"\nport "2200"\nidentitiesonly "yes"\nHost *\nuser "fallback"\nport "22"\n`);
    expect(fs.existsSync(path.join(f.directory, 'key with spaces'))).toBe(false);
  } finally { f.close(); }
});

test('SSH schemas reject paths/options and public projection never emits configuration or transport diagnostics', () => {
  for (const [method, params] of [['runner.ssh.discover', { path: '/etc/passwd' }], ['runner.ssh.test', {}], ['runner.ssh.test', { ssh_alias: 'x', command: 'whoami' }], ['runner.ssh.test', { ssh_alias: 'u@h' }]]) expect(() => validateRunnerParams(method, params)).toThrow();
  expect(publicRunnerResult({ aliases: ['safe', 'u@h'], status: 'ok', limited: true, configuration: 'secret' }, 'runner.ssh.discover')).toEqual({ aliases: ['safe'], status: 'ok', limited: true });
  expect(publicRunnerResult({ ok: false, reason: 'secret', stderr: 'secret' }, 'runner.ssh.test')).toEqual({ ok: false, reason: 'not_confirmed' });
});

test('real user CLI → Unix RPC → registration/permissions → controlled SSH child → projected result without saving node or Runner credentials', async () => {
  const f = await managementFixture(), ssh = sshFixture(f.root); f.project.runnerOptions = { ...f.runnerOptions, ssh: ssh.options };
  try {
    ssh.config('Host fixture\n HostName private.example\nMatch exec "never-run"\n');
    const result = await f.cli(['runner', 'ssh', 'discover']);
    expect(result.code).toBe(0); expect(result.err).toBe(''); expect(JSON.parse(result.out)).toMatchObject({ aliases: ['fixture'] });
    expect(ssh.calls()).toBe(0); expect(result.out).not.toContain('private.example');
    const unsupported = await f.cli(['runner', 'ssh', 'test', 'fixture']);
    expect(unsupported.code).toBe(0); expect(JSON.parse(unsupported.out)).toMatchObject({ ok: false, reason: 'config_unsupported' }); expect(ssh.calls()).toBe(0);
    ssh.config('Host fixture\n HostName private.example\n');
    const trial = await f.cli(['runner', 'ssh', 'test', 'fixture']);
    expect(trial.code).toBe(0); expect(JSON.parse(trial.out)).toMatchObject({ ok: true, reason: 'connected' });
    expect(trial.out + trial.err).not.toContain('raw-private'); expect(ssh.calls()).toBe(1);
    expect(f.project.runners.readNodes().nodes).toEqual([]); expect(f.project.runners.readCredentials().nodes).toEqual([]);
    expect(f.connections()).toBe(0);
    expect((await f.cli(['runner', 'ssh', 'test', 'fixture', '--command', 'true'])).code).toBe(1);
    for (const method of ['runner.ssh.discover', 'runner.ssh.test']) await expect(f.dispatcher.project.managementDispatch(method, {}, 1)).rejects.toThrow();
    expect(ssh.calls()).toBe(1);
  } finally { await f.close(); }
});
