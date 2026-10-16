import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { remoteCodeFixture } from './remote-code-fixture.js';
import { git } from '../helpers.js';
import { hash, OPERATIONS } from '../../src/runner/protocol.js';
import { runnerIdentity } from '../../src/core/runner-service.js';

const params = f => ({ kind: 'state', branch: f.task.branch, base_commit: f.base, expected_commit: f.base, options: {} });

test('Project code entry reads independent Runner HEAD and dirty state, not central stale commit or same-name files', async () => {
  const f = await remoteCodeFixture();
  try {
    expect(f.task.workspace).toBeNull(); expect(f.client.capabilities).toContain('workspace.code.read');
    expect(OPERATIONS['workspace.code.read']).toMatchObject({ authority: 'control', observation: true, idle_read: true });
    const clean = await f.state();
    expect(clean).toMatchObject({ availability: 'available', source: 'workspace', base_commit: f.base, head_commit: f.base });
    expect(clean.summary).toMatchObject({ changed_total: 0, pending_total: 0, files_total: 2 });
    f.write('file.txt', 'committed\n'); const head = await f.commit();
    f.store.update(f.task.id, { head_commit: f.base, iteration_base_commit: head });
    f.write('file.txt', 'remote dirty\n'); f.write('new.txt', 'untracked\n');
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'CENTRAL MUST NOT BE READ\n');
    const state = await f.state();
    expect(state.head_commit).toBe(head); expect(state.base_commit).toBe(f.base);
    expect(state.files.find(row => row.path === 'file.txt')).toMatchObject({ unstaged: true, changed: true, status: 'M' });
    expect(state.files.find(row => row.path === 'new.txt')).toMatchObject({ untracked: true, changed: true });
    expect((await f.state({ scope: 'working' })).base_commit).toBe(head);
    expect((await f.state({ scope: 'iteration' })).base_commit).toBe(head);
    expect((await f.file('file.txt', { view: 'content' })).content.text).toBe('remote dirty\n');
    expect((await f.file('file.txt', { view: 'content', side: 'old' })).content.text).toBe('base\n');
    expect((await f.file('file.txt', { view: 'content', side: 'old', scope: 'working' })).content.text).toBe('committed\n');
    // Holding the central mutation queue does not block the read path or its network exchange.
    const independent = await f.project.workspaces.exclusive(() => f.tree());
    expect(independent.availability).toBe('available');
  } finally { await f.close(); }
});

test('remote reader preserves rename/deletion, literal paths, pagination, CR and stale revision semantics', async () => {
  const f = await remoteCodeFixture();
  try {
    const unusual = 'dir/a\tname\n.txt'; fs.mkdirSync(path.join(f.remote, 'dir'));
    await git(f.remote, 'mv', 'file.txt', unusual);
    f.write(':literal[glob]*.txt', 'a\r\nb\r\nlast');
    const state = await f.state();
    expect((await f.file(unusual, { view: 'content', side: 'old' }))).toMatchObject({ previous_path: 'file.txt', content: { text: 'base\n' } });
    const first = await f.tree({ limit: 1 }), second = await f.tree({ limit: 1, after: first.next, revision: first.revision });
    expect(first.has_more).toBe(true); expect(first.entries[0].path).not.toBe(second.entries[0].path);
    expect((await f.tree({ query: 'name' })).entries[0].path).toBe(unusual);
    const a = await f.file(':literal[glob]*.txt', { view: 'content', limit: 4, revision: state.revision });
    const b = await f.file(':literal[glob]*.txt', { view: 'content', offset: a.content.next_offset, limit: 20, revision: state.revision });
    expect(a.content.text + b.content.text).toBe('a\r\nb\r\nlast'); expect(b.content.line_continued).toBe(true);
    f.write(':literal[glob]*.txt', 'changed');
    expect((await f.tree({ revision: first.revision })).availability).toBe('stale');
    expect((await f.file(':literal[glob]*.txt', { revision: state.revision })).availability).toBe('stale');
    fs.unlinkSync(path.join(f.remote, unusual));
    const deleted = await f.file('file.txt');
    expect(deleted.new.exists).toBe(false); expect(deleted.old.exists).toBe(true);
  } finally { await f.close(); }
});

test('remote reader enforces safe literal paths, internal/ignored filtering, link metadata and byte limits', async () => {
  const f = await remoteCodeFixture();
  try {
    f.write('.gitignore', '.lush/\nsecret*\n'); f.write('secret.txt', 'DO NOT EXPOSE');
    f.write('.LUSH/private', 'INTERNAL'); f.write('.lush/private', 'INTERNAL');
    fs.symlinkSync('/etc/passwd', path.join(f.remote, 'link'));
    fs.symlinkSync(f.root, path.join(f.remote, 'outside'));
    f.write('huge.bin', Buffer.alloc(8 * 1024 * 1024 + 1));
    f.write('image.png', Buffer.from([137, 80, 78, 71, 0, 255]));
    const paths = (await f.tree()).entries.map(row => row.path);
    expect(paths).not.toContain('secret.txt'); expect(paths).not.toContain('.lush'); expect(paths).not.toContain('.LUSH');
    const link = await f.file('link', { view: 'content' });
    expect(link.new.kind).toBe('symlink'); expect(link.content.text).toBe('/etc/passwd');
    expect((await f.file('image.png', { view: 'content' })).new.kind).toBe('binary');
    const huge = await f.file('huge.bin', { view: 'content' });
    expect(huge.new.size).toBe(8 * 1024 * 1024 + 1); expect(huge.truncated).toBe(true); expect(huge.file_revision).toBeNull();
    for (const name of ['../file.txt', '/etc/passwd', '.git/config', '.LUSH/private'])
      await expect(f.file(name)).rejects.toThrow('invalid project-relative');
    await expect(f.client.call('workspace.code.read', { ...params(f), options: { path: '../secret' } })).rejects.toThrow('Invalid code path');
    await expect(f.file('outside/file.txt', { view: 'content' })).rejects.toThrow('Invalid remote code path');
    await expect(f.file('secret.txt', { view: 'content' })).rejects.toThrow('Invalid remote code path');
    // No external diff, textconv, clean filter or fsmonitor runs even with hostile repository configuration.
    const marker = path.join(f.nodeRoot, 'executed');
    await git(f.remote, 'config', 'filter.evil.clean', `touch ${marker}`);
    await git(f.remote, 'config', 'diff.evil.textconv', `touch ${marker}`);
    await git(f.remote, 'config', 'core.fsmonitor', `touch ${marker}`);
    f.write('.gitattributes', '*.txt filter=evil diff=evil\n'); f.write('file.txt', 'safe\n');
    expect((await f.file('file.txt')).availability).toBe('available'); expect(fs.existsSync(marker)).toBe(false);
  } finally { await f.close(); }
});

test('offline and unknown Runner never downgrade to archived commit; confirmed cleanup alone permits archival', async () => {
  const f = await remoteCodeFixture();
  try {
    f.store.update(f.task.id, { head_commit: f.base });
    const transport = f.service.transport_factory;
    f.service.transport_factory = () => { throw new Error('SECRET connection diagnostics'); };
    const offline = await f.file('file.txt', { view: 'content' });
    expect(offline).toMatchObject({ availability: 'unavailable', source: 'none', head_commit: null });
    expect(JSON.stringify(offline)).not.toContain('SECRET');
    f.service.transport_factory = transport;
    const view = f.service.readNodes();
    await f.service.saveNodes({ nodes: [{ ...view.nodes[0], enabled: false }] }, view.revision);
    expect((await f.state()).availability).toBe('available'); // observation survives device disable
    await f.service.saveNodes({ nodes: [{ ...view.nodes[0], enabled: true }] }, f.service.readNodes().revision);
    const nodeConfig = JSON.parse(fs.readFileSync(f.nodeFile, 'utf8'));
    nodeConfig.projects[f.policy.project_id].enabled = false;
    fs.writeFileSync(f.nodeFile, JSON.stringify(nodeConfig));
    expect((await f.state()).availability).toBe('available'); // node-side revoked development authority also retains observation
    await expect(f.client.call('file.context', { scope: 'workspace' })).rejects.toThrow('disabled');
    const binding = f.store.runnerBinding(f.task.id);
    f.store.markRunnerWorkspaceUnknown(runnerIdentity(binding), binding.revision);
    const unknown = await f.state(); expect(unknown.availability).toBe('unavailable'); expect(unknown.source).toBe('none');
  } finally { await f.close(); }
  const archived = await remoteCodeFixture();
  try {
    archived.store.update(archived.task.id, { head_commit: archived.base });
    await archived.project.workspaces.cleanupRemoteWorkspace({ ...archived.options, request_id: 'archive-reader',
      head_commit: archived.base, agent_exited: true });
    expect(archived.store.runnerBinding(archived.task.id).state).toBe('removed');
    const count = archived.connects();
    expect((await archived.file('file.txt', { view: 'content' }))).toMatchObject({ source: 'commit', availability: 'available', content: { text: 'base\n' } });
    expect((await archived.state({ scope: 'working' })).availability).toBe('unavailable');
    expect(archived.connects()).toBe(count);
  } finally { await archived.close(); }
});

test('Runner code operation denies Run authority, unknown writers, cross-worker identities and foreign baseline', async () => {
  const f = await remoteCodeFixture();
  try {
    await f.client.call('lease.grant', { run_id: 1, run_token: hash('reader-run') });
    const run = f.client.forRun({ run_id: 1, run_token: hash('reader-run') });
    await expect(run.call('workspace.code.read', params(f))).rejects.toThrow('different authority');
    expect((await f.state()).availability).toBe('available'); // idle lease does not prohibit user observation
    const context = await run.call('file.context', { scope: 'workspace' });
    const command = await run.call('command.start', { script: 'printf READY; sleep 4', context_ack: context.fingerprint });
    // This test covers a running writer; starting->cancel recovery is a separate lifecycle concern.
    const deadline = Date.now() + 3000;
    while (true) {
      const output = await run.call('command.output', { execution_id: command.execution_id });
      if (output.chunks.some(chunk => Buffer.from(chunk.data, 'base64').toString().includes('READY'))) break;
      if (Date.now() >= deadline) throw new Error('fixture writer did not become ready');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const busy = await f.state(); expect(busy.availability).toBe('unavailable'); expect(busy.reason).toContain('活动或未知写入');
    expect((await run.call('command.cancel', { execution_id: command.execution_id })).stop_confirmed).toBe(true);
    await f.client.call('lease.release');
    // An explicitly retained unknown file-write receipt blocks observation, not a cue to ignore its lock.
    const { Database } = await import('bun:sqlite');
    const db = new Database(path.join(f.nodeRoot, 'runner', 'runner.db'));
    try {
      db.query("UPDATE workspaces SET busy_request='unknown-write' WHERE worker_id=?").run(f.task.id);
      expect((await f.state()).availability).toBe('unavailable');
      db.query('UPDATE workspaces SET busy_request=NULL WHERE worker_id=?').run(f.task.id);
    } finally { db.close(); }
    await expect(f.client.call('workspace.code.read', { ...params(f), branch: 'lush/0000000000/another' })).resolves.toMatchObject({ availability: 'stale' });
    const tree = await git(f.remote, 'rev-parse', 'HEAD^{tree}');
    const foreign = await git(f.remote, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-m', 'unrelated');
    expect((await f.client.call('workspace.code.read', { ...params(f), base_commit: foreign })).availability).toBe('unavailable');
    await expect(f.client.call('workspace.code.read', { ...params(f), cwd: '/tmp' })).rejects.toThrow('Unknown code read parameter');
    const { RunnerClient } = await import('../../src/runner/index.js');
    const other = new RunnerClient({ transport: f.client.transport, identity: { ...f.identity, worker_id: f.task.id + 1 },
      auth: f.service.credentials.snapshot(f.node.id, f.policy.project_id), expected_runner_id: f.identity.runner_id });
    await other.handshake();
    await expect(other.call('workspace.code.read', params(f))).rejects.toThrow('not registered');
  } finally { await f.close(); }
});

test('remote SHA-256 and packed refs retain stable revisions and reject metadata symlinks', async () => {
  const f = await remoteCodeFixture({ sha256: true });
  try {
    expect(f.base).toHaveLength(64);
    await git(f.remote, 'pack-refs', '--all');
    const state = await f.state(); expect(state.availability).toBe('available'); expect((await f.state()).revision).toBe(state.revision);
    expect((await f.file('file.txt', { view: 'content' })).content.text).toBe('base\n');
    fs.symlinkSync(f.root, path.join(f.remote, '.git', 'objects', 'foreign'));
    const unsafe = await f.state(); expect(unsafe.availability).toBe('unavailable'); expect(unsafe.reason).toContain('链接');
  } finally { await f.close(); }
});

test('central fixed baseline is rechecked after network reads and long paths stay byte-paged over protocol', async () => {
  const f = await remoteCodeFixture();
  try {
    const prefix = Array.from({ length: 13 }, () => 'x'.repeat(170) + '\t'.repeat(20)).join('/');
    for (let i = 0; i < 200; i++) f.write(`${prefix}/file-${String(i).padStart(3, '0')}`, 'x');
    const first = await f.tree({ query: 'file-', limit: 200 });
    expect(first.availability).toBe('available'); expect(first.has_more).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(512 * 1024);
    const next = await f.tree({ query: 'file-', limit: 200, after: first.next, revision: first.revision });
    expect(first.entries.length + next.entries.length).toBe(200); expect(next.has_more).toBe(false);
    const factory = f.service.transport_factory;
    f.service.transport_factory = node => {
      const transport = factory(node), request = transport.request.bind(transport);
      transport.request = async (frame, options) => {
        const response = await request(frame, options);
        if (frame.method === 'workspace.code.read') f.store.update(f.task.id, { iteration_base_commit: f.base });
        return response;
      };
      return transport;
    };
    expect((await f.state()).availability).toBe('stale');
  } finally { await f.close(); }
});
