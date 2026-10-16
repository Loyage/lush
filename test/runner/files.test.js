import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { RunnerNode } from '../../src/runner/node.js';
import { createFileService } from '../../src/runner/files.js';
import { LIMITS, hash } from '../../src/runner/protocol.js';

async function fixture(extraServices = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-runner-files-'));
  const identity = { project_id: 'p1', node_id: 'node', worker_id: 1, workspace_id: 'workspace', generation: 1, operation_id: 'control' };
  const machine = hash('files-fixture-machine'), control = hash('files-fixture-control');
  const node = new RunnerNode({ root: path.join(root, 'node'), node_id: 'node', machine_token_hash: hash(machine),
    projects: { p1: { control_token_hash: hash(control) }, p2: { control_token_hash: hash(control) } } },
    { services: { ...createFileService(), ...extraServices }, preflight: async () => {} });
  identity.runner_id = node.runner_id;
  const session = node.openSession();
  const request = (method, params = {}, patch = {}) => ({ version: 1, request_id: randomUUID(), method, params,
    identity, auth: { machine_token: machine, control_token: control }, ...patch });
  const call = (method, params, patch) => node.dispatch(request(method, params, patch), session);
  expect((await call('hello')).result.capabilities).toContain('file.write');
  const registration = await call('workspace.register');
  expect(registration.error).toBeUndefined();
  const directory = registration.result.directory;
  const context = async (target = '', scope = 'path') => {
    const result = await call('file.context', { path: target, scope });
    expect(result.error).toBeUndefined(); return result.result;
  };
  const write = async (target, content, expected_sha256 = null, extra = {}) => call('file.write', {
    path: target, content, expected_sha256, context_ack: (await context(target)).fingerprint, ...extra });
  return { root, node, identity, session, request, call, directory, context, write,
    close: async () => { await node.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('registered/authorized Runner file chain reads, versions, atomically writes and precisely edits original text', async () => {
  const f = await fixture();
  try {
    const first = await f.write('nested/a.txt', 'alpha beta gamma');
    expect(first.result.sha256).toBe(hash('alpha beta gamma'));
    const page = await f.call('file.read', { path: 'nested/a.txt', limit: 5 });
    expect(page.result).toMatchObject({ text: 'alpha', next_offset: 5, truncated: true, complete: false, unit: 'utf16' });
    expect((await f.call('file.read', { path: 'nested/a.txt', offset: 5 })).error.code).toBe('INVALID_REQUEST');
    expect((await f.call('file.read', { path: 'nested/a.txt', offset: 5, expected_sha256: first.result.sha256 })).result.text).toBe(' beta gamma');
    const ack = (await f.context('nested/a.txt')).fingerprint;
    const changed = await f.call('file.edit', { path: 'nested/a.txt', expected_sha256: first.result.sha256, context_ack: ack,
      edits: [{ oldText: 'alpha', newText: 'beta' }, { oldText: 'beta', newText: 'delta' }] });
    expect(changed.result.sha256).toBe(hash('beta delta gamma'));
    expect(fs.readFileSync(path.join(f.directory, 'nested/a.txt'), 'utf8')).toBe('beta delta gamma');
    expect((await f.call('file.read', { path: 'nested/a.txt', expected_sha256: first.result.sha256 })).error.code).toBe('STALE');
    expect((await f.write('nested/a.txt', 'wrong', first.result.sha256)).error.code).toBe('CONFLICT');
    const overlap = await f.call('file.edit', { path: 'nested/a.txt', expected_sha256: changed.result.sha256, context_ack: ack,
      edits: [{ oldText: 'beta delta', newText: 'x' }, { oldText: 'delta', newText: 'y' }] });
    expect(overlap.error.code).toBe('CONFLICT');
    await f.write('repeat.txt', 'aaaa');
    expect((await f.call('file.edit', { path: 'repeat.txt', expected_sha256: hash('aaaa'), context_ack: (await f.context('repeat.txt')).fingerprint,
      edits: [{ oldText: 'aa', newText: 'x' }] })).error.code).toBe('CONFLICT');
    expect((await f.call('file.write', { path: 'nested/a.txt', content: 'bad', context_ack: ack })).error.code).toBe('INVALID_REQUEST');
    expect(fs.readFileSync(path.join(f.directory, 'nested/a.txt'), 'utf8')).toBe('beta delta gamma');
    expect((await f.write('missing-parent/file', 'bad', hash('not-there'))).error.code).toBe('NOT_FOUND');
    expect(fs.existsSync(path.join(f.directory, 'missing-parent'))).toBe(false);
  } finally { await f.close(); }
});

test('root/nested rules precede first mutation, override precedence and stale acknowledgements are enforced', async () => {
  let commandStarts = 0;
  const f = await fixture({ 'command.start': () => { commandStarts++; return { admitted: true }; } });
  try {
    fs.writeFileSync(path.join(f.directory, 'AGENTS.md'), 'root rules');
    fs.mkdirSync(path.join(f.directory, 'nested'));
    fs.writeFileSync(path.join(f.directory, 'nested/AGENTS.md'), 'suppressed');
    fs.writeFileSync(path.join(f.directory, 'nested/AGENTS.override.md'), 'nested override');
    fs.mkdirSync(path.join(f.directory, '.pi'));
    fs.writeFileSync(path.join(f.directory, '.pi/AGENTS.md'), 'rules for editing Pi configuration');
    fs.writeFileSync(path.join(f.directory, '.pi/SYSTEM.md'), 'not loaded');
    fs.mkdirSync(path.join(f.directory, '.pi/extensions'));
    fs.writeFileSync(path.join(f.directory, '.pi/extensions/poison.js'), 'throw new Error("must not execute")');
    const blocked = await f.call('file.write', { path: 'nested/new.txt', content: 'value', expected_sha256: null });
    expect(blocked.error.code).toBe('CONTEXT_REQUIRED');
    expect(blocked.error.details.files.map(file => file.content)).toEqual(['root rules', 'nested override']);
    expect(fs.existsSync(path.join(f.directory, 'nested/new.txt'))).toBe(false);
    const before = blocked.error.details.fingerprint;
    fs.writeFileSync(path.join(f.directory, 'nested/AGENTS.override.md'), 'new rules');
    expect((await f.call('file.write', { path: 'nested/new.txt', content: 'value', expected_sha256: null, context_ack: before })).error.code).toBe('CONTEXT_REQUIRED');
    expect((await f.write('nested/new.txt', 'value')).result.size).toBe(5);
    const all = await f.context('', 'workspace');
    expect(all.files.map(file => file.path)).toEqual(['AGENTS.md', '.pi/AGENTS.md', 'nested/AGENTS.override.md']);
    expect(JSON.stringify(all)).not.toContain('not loaded');
    expect(JSON.stringify(all)).not.toContain('must not execute');
    expect((await f.call('command.start', { context_ack: (await f.context()).fingerprint })).error.code).toBe('CONTEXT_REQUIRED');
    expect(commandStarts).toBe(0);
    // This tests the real file precondition, not a real command/cgroup implementation.
    expect((await f.call('command.start', { context_ack: all.fingerprint })).result.admitted).toBe(true);
    expect(commandStarts).toBe(1);
  } finally { await f.close(); }
});

test('literal path boundary rejects traversal, reserved internals, symlinks and non-regular files', async () => {
  const f = await fixture();
  try {
    fs.mkdirSync(path.join(f.root, 'outside'));
    fs.writeFileSync(path.join(f.root, 'outside/secret'), 'OUTSIDE');
    fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.directory, 'escape'));
    fs.symlinkSync(path.join(f.root, 'outside/secret'), path.join(f.directory, 'link'));
    for (const target of ['../outside/secret', '/etc/passwd', '.git/config', 'a/.LUSH/token', 'a/../b', 'a\\b', 'a\0b']) {
      expect((await f.call('file.read', { path: target })).error).toBeDefined();
    }
    for (const target of ['escape/secret', 'link']) expect((await f.call('file.read', { path: target })).error.code).toBe('UNAUTHORIZED');
    expect((await f.call('file.read', { path: 'escape' })).error.code).toBe('UNAUTHORIZED');
    fs.mkdirSync(path.join(f.directory, 'directory'));
    expect((await f.call('file.read', { path: 'directory' })).error.code).toBe('UNAUTHORIZED');
    execFileSync('/usr/bin/mkfifo', [path.join(f.directory, 'fifo')]);
    expect((await f.call('file.read', { path: 'fifo' })).error.code).toBe('UNAUTHORIZED');
    const writeEscape = await f.call('file.write', { path: 'escape/new', content: 'bad', expected_sha256: null });
    expect(writeEscape.error.code).toBe('UNAUTHORIZED');
    expect(fs.existsSync(path.join(f.root, 'outside/new'))).toBe(false);
    expect((await f.write('literal:[x]*.txt', 'literal')).result.size).toBe(7);
    expect((await f.call('file.read', { path: 'literal:[x]*.txt' })).result.text).toBe('literal');
  } finally { await f.close(); }
});

test('file service rejects cross-identity access through real Runner authorization', async () => {
  const f = await fixture();
  try {
    await f.write('private', 'data');
    for (const change of [{ project_id: 'p2' }, { worker_id: 2 }, { generation: 2 }, { workspace_id: 'other' }]) {
      expect((await f.call('file.read', { path: 'private' }, { identity: { ...f.identity, ...change } })).error.code).toBe('NOT_FOUND');
    }
    expect((await f.call('file.read', { path: 'private' }, { auth: {} })).error.code).toBe('UNAUTHORIZED');
    expect((await f.call('file.read', { path: 'private' }, { identity: { ...f.identity, runner_id: 'other-installation' } })).error.code).toBe('STALE');
    expect((await f.call('file.read', { path: 'private' }, { identity: { ...f.identity, runner_id: undefined } })).error.code).toBe('INVALID_REQUEST');
    f.node.store.db.query('UPDATE workspaces SET busy_request=?').run('active-command');
    expect((await f.write('other', 'data')).error.code).toBe('BUSY');
  } finally { await f.close(); }
});

test('images, binary/text paging and file/context size limits remain bounded', async () => {
  const f = await fixture();
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
    expect((await f.write('picture', png.toString('base64'), null, { encoding: 'base64' })).result.sha256).toBe(hash(png));
    expect((await f.call('file.read', { path: 'picture' })).result).toMatchObject({ encoding: 'base64', data: png.toString('base64'), mime_type: 'image/png', complete: true });
    await f.write('unicode', '😀中a');
    const first = (await f.call('file.read', { path: 'unicode', limit: 1 })).result;
    expect(first.text).toBe('😀'); expect(first.next_offset).toBe(2);
    expect((await f.call('file.read', { path: 'unicode', offset: 1, expected_sha256: first.sha256 })).error.code).toBe('INVALID_REQUEST');
    fs.writeFileSync(path.join(f.directory, 'huge'), Buffer.alloc(LIMITS.file_bytes + 1));
    expect((await f.call('file.read', { path: 'huge' })).error.code).toBe('LIMIT_EXCEEDED');
    expect((await f.write('too-large', 'x'.repeat(LIMITS.file_bytes + 1))).error.code).toBe('LIMIT_EXCEEDED');
    fs.writeFileSync(path.join(f.directory, 'AGENTS.md'), 'x'.repeat(LIMITS.context_bytes + 1));
    expect((await f.call('file.context', {})).error.code).toBe('LIMIT_EXCEEDED');
  } finally { await f.close(); }
});

test('durable request replay returns original receipt without applying write/edit twice', async () => {
  const f = await fixture();
  try {
    const params = { path: 'once', content: 'once', expected_sha256: null, context_ack: (await f.context('once')).fingerprint };
    const req = f.request('file.write', params);
    const first = await f.node.dispatch(req, f.session);
    expect(first.error).toBeUndefined();
    fs.writeFileSync(path.join(f.directory, 'once'), 'external modification');
    expect(await f.node.dispatch(req, f.session)).toEqual(first);
    expect(fs.readFileSync(path.join(f.directory, 'once'), 'utf8')).toBe('external modification');
    expect((await f.node.dispatch({ ...req, params: { ...params, content: 'twice' } }, f.session)).error.code).toBe('CONFLICT');
  } finally { await f.close(); }
});

test('descriptor write refuses a swapped ancestor without touching symlink target', async () => {
  const f = await fixture(); let spy;
  try {
    await f.write('dir/value', 'before');
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'value'), 'OUTSIDE');
    const ack = (await f.context('dir/value')).fingerprint;
    const original = fs.fsyncSync; let swapped = false;
    spy = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (!swapped && fs.fstatSync(fd).isFile()) {
        swapped = true; fs.renameSync(path.join(f.directory, 'dir'), path.join(f.directory, 'moved'));
        fs.symlinkSync(outside, path.join(f.directory, 'dir'));
      }
      return original(fd);
    });
    const result = await f.call('file.write', { path: 'dir/value', content: 'after', expected_sha256: hash('before'), context_ack: ack });
    expect(result.error.code).toBe('UNAUTHORIZED');
    expect(fs.readFileSync(path.join(outside, 'value'), 'utf8')).toBe('OUTSIDE');
    expect(fs.readFileSync(path.join(f.directory, 'moved/value'), 'utf8')).toBe('before');
    expect(fs.readdirSync(path.join(f.directory, 'moved'))).toEqual(['value']);
  } finally { spy?.mockRestore(); await f.close(); }
});

test('post-publication uncertainty remains unknown and retains workspace lock instead of retrying', async () => {
  const f = await fixture(); let spy;
  try {
    const params = { path: 'uncertain', content: 'published', expected_sha256: null, context_ack: (await f.context('uncertain')).fingerprint };
    const req = f.request('file.write', params), original = fs.fsyncSync;
    spy = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' });
      return original(fd);
    });
    expect((await f.node.dispatch(req, f.session)).error.code).toBe('UNKNOWN');
    spy.mockRestore(); spy = null;
    expect(fs.readFileSync(path.join(f.directory, 'uncertain'), 'utf8')).toBe('published');
    expect((await f.node.dispatch(req, f.session)).error.code).toBe('UNKNOWN');
    expect((await f.call('workspace.barrier')).result.stopped).toBe(false);
    expect((await f.write('next', 'no')).error.code).toBe('BUSY');
  } finally { spy?.mockRestore(); await f.close(); }
});

test('read detects a swapped file link and never returns its outside target', async () => {
  const f = await fixture(); let spy;
  try {
    await f.write('value', 'inside');
    fs.writeFileSync(path.join(f.root, 'outside-value'), 'SECRET_OUTSIDE');
    const original = fs.readSync; let swapped = false;
    spy = spyOn(fs, 'readSync').mockImplementation((fd, ...args) => {
      const result = original(fd, ...args);
      if (!swapped && fs.fstatSync(fd).size === 6) {
        swapped = true;
        fs.renameSync(path.join(f.directory, 'value'), path.join(f.directory, 'old-value'));
        fs.symlinkSync(path.join(f.root, 'outside-value'), path.join(f.directory, 'value'));
      }
      return result;
    });
    const result = await f.call('file.read', { path: 'value' });
    // Renaming changes the opened inode ctime; implementations may detect that
    // before encountering the now-symlinked name. Both paths must fail closed.
    expect(['STALE', 'UNAUTHORIZED']).toContain(result.error.code);
    expect(JSON.stringify(result)).not.toContain('SECRET_OUTSIDE');
  } finally { spy?.mockRestore(); await f.close(); }
});

test('lease revocation across the dispatcher await is rechecked before file publication', async () => {
  const real = createFileService();
  const f = await fixture({ check_context: (ctx, params) => {
    const result = real.check_context(ctx, params);
    if (ctx.lease) ctx.store.db.query('UPDATE leases SET revoked=1 WHERE lease_id=?').run(ctx.lease.lease_id);
    return result;
  } });
  try {
    const runToken = hash('files-fixture-run');
    await f.call('lease.grant', { run_id: 1, run_token: runToken });
    const { operation_id, ...identity } = f.identity;
    const patch = { identity: { ...identity, run_id: 1 }, auth: { machine_token: hash('files-fixture-machine'), run_token: runToken } };
    const ack = (await f.call('file.context', { path: 'denied' }, patch)).result.fingerprint;
    const result = await f.call('file.write', { path: 'denied', content: 'no', expected_sha256: null, context_ack: ack }, patch);
    expect(result.error.code).toBe('UNAUTHORIZED');
    expect(fs.existsSync(path.join(f.directory, 'denied'))).toBe(false);
    expect(fs.readdirSync(f.directory)).toEqual([]);
  } finally { await f.close(); }
});

test('concurrent mutation admission shares the persistent workspace mutex', async () => {
  const f = await fixture();
  try {
    const params = { path: 'concurrent', content: 'once', expected_sha256: null, context_ack: (await f.context('concurrent')).fingerprint };
    const responses = await Promise.all([f.call('file.write', params), f.call('file.write', params)]);
    expect(responses.filter(result => result.result).length).toBe(1);
    expect(responses.filter(result => result.error?.code === 'BUSY').length).toBe(1);
    expect(fs.readFileSync(path.join(f.directory, 'concurrent'), 'utf8')).toBe('once');
  } finally { await f.close(); }
});

test('registered artifacts are workspace-bound, digest-checked, expiring and paged by ID only', async () => {
  const f = await fixture();
  try {
    const data = Buffer.from('artifact-data');
    fs.writeFileSync(path.join(f.directory, 'bundle'), data);
    const key = f.node.store.workspace(f.identity).workspace_key;
    f.node.store.db.query('INSERT INTO artifacts VALUES (?,?,?,?,?,?)').run('bundle-id', key, 'bundle', hash(data), data.length, Date.now() + 60000);
    const page = await f.call('artifact.read', { artifact_id: 'bundle-id', limit: 4 });
    expect(Buffer.from(page.result.data, 'base64').toString()).toBe('arti');
    expect(page.result).toMatchObject({ next_offset: 4, truncated: true, sha256: hash(data) });
    expect((await f.call('artifact.read', { artifact_id: 'bundle-id', offset: 4, expected_sha256: hash(data) })).result.complete).toBe(false);
    expect((await f.call('artifact.read', { artifact_id: 'bundle-id', path: '/etc/passwd' })).error.code).toBe('INVALID_REQUEST');
    expect((await f.call('artifact.read', { artifact_id: 'missing' })).error.code).toBe('NOT_FOUND');
    const other = { identity: { ...f.identity, worker_id: 2, workspace_id: 'other-workspace' } };
    expect((await f.call('workspace.register', {}, other)).error).toBeUndefined();
    expect((await f.call('artifact.read', { artifact_id: 'bundle-id' }, other)).error.code).toBe('NOT_FOUND');
    fs.writeFileSync(path.join(f.directory, 'bundle'), 'changed--data');
    expect((await f.call('artifact.read', { artifact_id: 'bundle-id' })).error.code).toBe('STALE');
    f.node.store.db.query('UPDATE artifacts SET expires_at=0').run();
    expect((await f.call('artifact.read', { artifact_id: 'bundle-id' })).error.code).toBe('NOT_FOUND');
  } finally { await f.close(); }
});
