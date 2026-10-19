import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, env } from '../helpers.js';
import { acceptanceFixture } from '../acceptance-fixture.js';
import { RPCServer } from '../../src/rpc/server.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { createSignal } from '../../src/signal.js';

const bin = path.resolve(import.meta.dir, '../../bin/lush');

test('real user CLI preflight and explicit forced acceptance reclaim resources while preserving terminal receipts', async () => {
  let calls = 0;
  const f = fixture({ async run() { calls++; throw Error('must not run Agent'); } });
  let rpc;
  try {
    const { parent, child, leaf, signal } = await acceptanceFixture(f);
    rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await rpc.start();
    const cli = async (...args) => {
      const proc = Bun.spawn([process.execPath, bin, 'worker', ...args, '--json'], { cwd: f.root,
        env: env({ ...f.config.env, LUSH_PROJECT: f.root, LUSH_HOME: f.config.home }), stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code, `${err} ${out}`).toBe(0); const value = JSON.parse(out); expect(value.version).toBe(1); return value.data;
    };
    const plan = await cli('accept-preview', parent.worker_number);
    expect(plan).toMatchObject({ id: parent.id, can_force: true, notifications: [{ message_id: signal.id, worker_id: child.id, signal_type: 'child.cancelled' }] });
    expect(plan.resources.worktrees).toHaveLength(3);
    expect(await cli('accept', String(parent.id), '--force', '--confirm', '--revision', plan.revision)).toMatchObject({ id: parent.id, status: 'completed', workspace: null });
    for (const row of [parent, child, leaf]) {
      expect(fs.existsSync(row.workspace)).toBe(false); expect(f.store.branch(row.branch).status).toBe('archived');
    }
    expect(f.store.get('SELECT consumed FROM messages WHERE id=?', signal.id).consumed).toBe(0);
    const audit = JSON.parse(f.store.get("SELECT data FROM events WHERE task_id=? AND type='task.acceptance_forced'", parent.id).data);
    expect(audit).toMatchObject({ revision: plan.revision, accepted_by: 'user', skipped_messages: [{ id: signal.id, consumed: 0 }] });
    expect(calls).toBe(0);
  } finally { await rpc?.close(); await f.close(); }
});
