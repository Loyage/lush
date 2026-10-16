import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { RunnerError } from '../../src/runner/protocol.js';
import { phaseId } from '../../src/core/workspaces/remote-transfer.js';
import { remoteFixture, command } from './remote-harness.js';

function database(worker) {
  const config = JSON.parse(fs.readFileSync(worker.configFile, 'utf8'));
  const db = new Database(path.join(config.root, 'runner.db'));
  db.exec('PRAGMA busy_timeout=5000'); return db;
}
const cleanupOptions = worker => ({ ...worker.options, request_id: `cleanup-${worker.task.id}`, head_commit: worker.commit, agent_exited: true });

for (const replacement of ['directory', 'symlink']) test(`command home ${replacement} replacement is preserved; explicit cleanup resumes only after the original inode is restored`, async () => {
  const f = await remoteFixture();
  try {
    const worker = await f.worker(), home = await command(worker.client, 'printf owned > "$HOME/cache"; printf %s "$HOME"');
    const original = home + '-original', foreign = path.join(f.root, 'foreign');
    fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'keep'), 'foreign');
    fs.renameSync(home, original);
    if (replacement === 'directory') { fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'keep'), 'replacement'); }
    else fs.symlinkSync(foreign, home);
    const options = cleanupOptions(worker);
    await expect(f.workspaces.cleanupRemoteWorkspace(options)).rejects.toThrow();
    expect(fs.readFileSync(path.join(original, 'cache'), 'utf8')).toBe('owned');
    expect(fs.readFileSync(path.join(foreign, 'keep'), 'utf8')).toBe('foreign');
    expect(f.store.runnerReceipt(options.request_id).state).toBe('removing');
    // Fixture owner restores the original directory; the failed request itself is never replayed.
    if (replacement === 'directory') fs.rmSync(home, { recursive: true }); else fs.unlinkSync(home);
    fs.renameSync(original, home);
    expect((await f.workspaces.cleanupRemoteWorkspace({ ...options, cleanup_attempt: 'after-explicit-restore' })).state).toBe('removed');
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.readFileSync(path.join(foreign, 'keep'), 'utf8')).toBe('foreign');
  } finally { await f.close(); }
});

test('creation receipt missing its inode is unknown even when the command home exists; no directory adoption', async () => {
  const f = await remoteFixture();
  try {
    const worker = await f.worker(), home = await command(worker.client, 'printf owned > "$HOME/cache"; printf %s "$HOME"');
    const db = database(worker);
    try { db.exec("UPDATE command_resources SET phase='preparing',home_state='creating',home_json=json_remove(home_json,'$.dev','$.ino')"); }
    finally { db.close(); }
    const options = cleanupOptions(worker);
    await expect(f.workspaces.cleanupRemoteWorkspace(options)).rejects.toMatchObject({ code: 'UNKNOWN' });
    expect((await worker.client.call('request.status', { request_id: phaseId(options.request_id, 'cleanup') })).state).toBe('unknown');
    await expect(f.workspaces.cleanupRemoteWorkspace({ ...options, cleanup_attempt: 'cannot-bypass-unknown' })).rejects.toThrow('unknown writers');
    expect(fs.readFileSync(path.join(home, 'cache'), 'utf8')).toBe('owned');
  } finally { await f.close(); }
});

test('lost cleanup ACK reconciles the same request without deleting resources twice', async () => {
  const f = await remoteFixture();
  try {
    const worker = await f.worker(), home = await command(worker.client, 'printf cache > "$HOME/cache"; printf %s "$HOME"');
    const options = cleanupOptions(worker), request = worker.client.transport.request.bind(worker.client.transport);
    let cleanupCalls = 0;
    worker.client.transport.request = async (frame, transportOptions) => {
      const result = await request(frame, transportOptions);
      if (frame.method === 'workspace.cleanup') { cleanupCalls++; throw new RunnerError('UNKNOWN', 'fixture drops cleanup ACK'); }
      return result;
    };
    await expect(f.workspaces.cleanupRemoteWorkspace(options)).rejects.toMatchObject({ code: 'UNKNOWN' });
    expect(fs.existsSync(home)).toBe(false);
    expect(f.store.runnerReceipt(options.request_id).state).toBe('removing');
    expect((await f.workspaces.cleanupRemoteWorkspace(options)).state).toBe('removed');
    expect(cleanupCalls).toBe(1);
    const db = database(worker);
    try { expect(db.query('SELECT phase,home_state,cgroup_state FROM command_resources').get())
      .toEqual({ phase: 'removed', home_state: 'removed', cgroup_state: 'removed' }); }
    finally { db.close(); }
  } finally { await f.close(); }
});

test('unconfirmed stop blocks home and repository cleanup even with matching resource identities', async () => {
  const f = await remoteFixture();
  try {
    const worker = await f.worker(), home = await command(worker.client, 'printf %s "$HOME"');
    const db = database(worker);
    try { db.exec("UPDATE executions SET stop_confirmed=0,state='unknown'"); } finally { db.close(); }
    await expect(f.workspaces.cleanupRemoteWorkspace(cleanupOptions(worker))).rejects.toThrow('unknown writers');
    expect(fs.existsSync(home)).toBe(true);
    expect((await worker.client.call('workspace.inspect')).state).toBe('ready');
  } finally { await f.close(); }
});

test('guard exit checks the registered home identity and retains unknown after a command replaces its own home', async () => {
  const f = await remoteFixture();
  try {
    const worker = await f.worker(), context = await worker.client.call('file.context', { scope: 'workspace' });
    const started = await worker.client.call('command.start', {
      script: 'mv "$HOME" "$HOME.original"; mkdir "$HOME"; printf replacement > "$HOME/keep"', context_ack: context.fingerprint,
    });
    const deadline = Date.now() + 4000;
    while (true) {
      const status = await worker.client.call('command.status', { execution_id: started.execution_id });
      if (status.state === 'unknown') { expect(status.stop_confirmed).toBe(false); break; }
      if (Date.now() > deadline) throw new Error('fixture guard did not report changed home');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const db = database(worker); let home;
    try { home = JSON.parse(db.query('SELECT home_json FROM command_resources WHERE execution_id=?').get(started.execution_id).home_json).directory; }
    finally { db.close(); }
    await expect(f.workspaces.cleanupRemoteWorkspace(cleanupOptions(worker))).rejects.toThrow('unknown writers');
    expect(fs.readFileSync(path.join(home, 'keep'), 'utf8')).toBe('replacement');
    expect(fs.existsSync(home + '.original')).toBe(true);
  } finally { await f.close(); }
});

test('lost command-start ACK uses its original execution receipt and still permits verified resource reclamation', async () => {
  const f = await remoteFixture();
  try {
    const worker = await f.worker(), request = worker.client.transport.request.bind(worker.client.transport);
    let starts = 0;
    worker.client.transport.request = async (frame, options) => {
      const result = await request(frame, options);
      if (frame.method === 'command.start') { starts++; throw new RunnerError('UNKNOWN', 'fixture drops start ACK'); }
      return result;
    };
    const context = await worker.client.call('file.context', { scope: 'workspace' });
    await expect(worker.client.call('command.start', { script: 'printf cache > "$HOME/cache"', context_ack: context.fingerprint },
      { request_id: 'lost-start' })).rejects.toMatchObject({ code: 'UNKNOWN' });
    const receipt = await worker.client.call('request.status', { request_id: 'lost-start' });
    expect(receipt.state).toBe('completed');
    const deadline = Date.now() + 4000;
    while (true) {
      const status = await worker.client.call('command.status', { execution_id: receipt.result.execution_id });
      if (status.stop_confirmed) { expect(status.exit_code).toBe(0); break; }
      if (Date.now() > deadline) throw new Error('fixture command did not stop');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect((await f.workspaces.cleanupRemoteWorkspace(cleanupOptions(worker))).state).toBe('removed');
    expect(starts).toBe(1);
  } finally { await f.close(); }
});
