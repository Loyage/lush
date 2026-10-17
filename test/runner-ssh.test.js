import { test, expect } from 'bun:test';
import { managementFixture } from './runner-management-fixture.js';
import { sshFixture } from './runner-ssh-fixture.js';

test('user CLI -> Unix RPC -> controlled SSH trial returns its result without saving Runner credentials', async () => {
  const f = await managementFixture(), ssh = sshFixture(f.root);
  f.project.runnerOptions = { ...f.runnerOptions, ssh: ssh.options };
  try {
    ssh.config('Host fixture\n HostName private.example\n');
    const discovered = await f.cli(['runner', 'ssh', 'discover']);
    expect(discovered).toMatchObject({ code: 0, err: '' });
    expect(JSON.parse(discovered.out)).toMatchObject({ aliases: ['fixture'] });
    expect(ssh.calls()).toBe(0);
    const trial = await f.cli(['runner', 'ssh', 'test', 'fixture']);
    expect(trial).toMatchObject({ code: 0, err: '' });
    expect(JSON.parse(trial.out)).toMatchObject({ ok: true, reason: 'connected' });
    expect(ssh.calls()).toBe(1);
    expect(ssh.records()[0].args.slice(-3)).toEqual(['--', 'fixture', 'true']);
    expect(f.project.runners.readNodes().nodes).toEqual([]);
    expect(f.project.runners.readCredentials().nodes).toEqual([]); expect(f.connections()).toBe(0);
  } finally { await f.close(); }
});
