import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { temp, repo, env, git } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { cli, idle } from './harness.js';

test('real daemons: project isolation, duplicate start, immediate input, restart persistence', async () => {
  const a = temp(), b = temp(); await repo(a); await repo(b);
  try {
    const sa = await cli(a,['start']), sb = await cli(b,['start']);
    expect(sa.project).toBe(a); expect(sb.project).toBe(b); expect(sa.pid).not.toBe(sb.pid);
    const ca = new UIClient(Config.fromEnv(env(),a)), cb = new UIClient(Config.fromEnv(env(),b));
    const main = (await ca.request('task.list')).find(task => task.task_kind === 'main');
    expect(main).toMatchObject({ task_kind: 'main', status: 'waiting', input_id: null });
    expect(await ca.request('task.inspect', { id: main.id })).toMatchObject({ branch: 'main', calls: 0 });
    expect((await cb.request('task.list')).find(task => task.task_kind === 'main')).toBeTruthy();
    expect((await ca.request('branch.merge_all', { branch: 'main' })).status).toBe('empty');
    const diagnosis = await cli(a, ['doctor']);
    expect(diagnosis.daemon_code_match).toBe(true);
    expect(diagnosis.identities.current.fingerprint).toBe(diagnosis.identities.daemon.fingerprint);
    expect(diagnosis.daemon_code).toEqual(diagnosis.identities.daemon);
    expect(diagnosis.identities.daemon).toMatchObject({ pid: sa.pid, project: a });
    expect(diagnosis.web_code).toBeNull();
    expect(diagnosis.identities.web).toBeNull();
    expect(diagnosis.web).toMatchObject({ running: false, code_match: null });
    expect(diagnosis.update_hints).toEqual([]);
    expect((await cli(a,['start'])).already_running).toBe(true);
    const input = await cli(a,['say','original input']);
    expect((await idle(ca,input.task.id)).status).toBe('waiting');
    const booked = await ca.request('task.reserve', { id: input.task.id, kind: 'merge' });
    expect(booked.reservation.status).toBe('pending');
    expect(await cb.request('input.list')).toEqual([]);
    const before = await ca.request('task.tree');
    const restarted = await cli(a,['daemon-restart']); expect(restarted.pid).not.toBe(sa.pid);
    const after = await ca.request('task.tree');
    // Recovery may recheck a pending reservation and refresh its task timestamp without changing its meaning.
    before[0].children[0].updated_at = after[0].children[0].updated_at;
    expect(after).toEqual(before);
    expect((await ca.request('task.inspect', { id: input.task.id })).reservation).toEqual(booked.reservation);
    expect((await ca.request('task.unreserve', { id: input.task.id })).changed).toBe(true);
    expect((await ca.request('task.list')).filter(task => task.task_kind === 'main')).toMatchObject([{
      id: main.id, status: 'waiting', input_id: null,
    }]);
    expect(await ca.request('task.inspect', { id: main.id })).toMatchObject({ branch: 'main', calls: 0 });
    expect((await cb.request('system.status')).pid).toBe(sb.pid);
    await expect(ca.request('service.list')).rejects.toThrow('unknown method');
  } finally {
    await cli(a,['stop']).catch(() => {}); await cli(b,['stop']).catch(() => {});
    fs.rmSync(a,{recursive:true,force:true}); fs.rmSync(b,{recursive:true,force:true});
  }
}, 30000);

test('daemon starts without a main ref but new say refuses to invent one', async () => {
  const root = temp(); await repo(root); await git(root, 'branch', '-m', 'trunk');
  try {
    await cli(root, ['start']);
    const client = new UIClient(Config.fromEnv(env(), root));
    expect((await client.request('task.list')).filter(task => task.task_kind === 'main')).toEqual([]);
    await expect(client.request('say.submit', { content: 'write a thing', branch: 'trunk' }))
      .rejects.toThrow('explicitly bound Task');
    await expect(client.request('say.submit', { content: 'write a thing', branch: 'main' }))
      .rejects.toThrow('local main branch');
    expect(await client.request('input.list')).toEqual([]);
  } finally { await cli(root, ['stop']).catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
}, 30000);
