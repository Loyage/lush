import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { temp, repo, env } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { cli, done } from './harness.js';

test('real daemons: project isolation, duplicate start, immediate input, restart persistence', async () => {
  const a = temp(), b = temp(); await repo(a); await repo(b);
  try {
    const sa = await cli(a,['start']), sb = await cli(b,['start']);
    expect(sa.project).toBe(a); expect(sb.project).toBe(b); expect(sa.pid).not.toBe(sb.pid);
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
    const ca = new UIClient(Config.fromEnv(env(),a)), cb = new UIClient(Config.fromEnv(env(),b));
    expect((await done(ca,input.task.id)).status).toBe('completed');
    expect(await cb.request('input.list')).toEqual([]);
    const before = await ca.request('task.tree');
    const restarted = await cli(a,['daemon-restart']); expect(restarted.pid).not.toBe(sa.pid);
    expect(await ca.request('task.tree')).toEqual(before);
    expect((await cb.request('system.status')).pid).toBe(sb.pid);
    await expect(ca.request('service.list')).rejects.toThrow('unknown method');
  } finally {
    await cli(a,['stop']).catch(() => {}); await cli(b,['stop']).catch(() => {});
    fs.rmSync(a,{recursive:true,force:true}); fs.rmSync(b,{recursive:true,force:true});
  }
}, 30000);
