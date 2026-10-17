import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, env } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';
import { HOOK_REGISTER_SCHEMA } from '../../src/core/hook-registration.js';

const bin = path.resolve(import.meta.dir, '../../bin/lush');
test('real user CLI -> strict RPC registration -> fixed-reference mount; retired install and raw attach reject', async () => {
  const f = fixture(); let rpc;
  try {
    const p = f.project; p.kick = () => {}; await repo(f.root); const main = await p.bootstrapMain();
    const dispatcher = new Dispatcher(p, createSignal(), {}); rpc = new RPCServer(f.config.socket, dispatcher); await rpc.start();
    async function cli(...args) {
      const proc = Bun.spawn([process.execPath, bin, '--project', f.root, '--json', ...args], { cwd: f.root,
        env: env(f.config.env), stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, err, value: out.trim() ? JSON.parse(out) : null };
    }
    const file = (name, data) => { const target = path.join(f.config.home, name); fs.writeFileSync(target, JSON.stringify(data), { mode: 0o600 }); return target; };
    const directory = (await cli('hooks', 'list')).value;
    const registration = { command: { name: 'CLI registered shell', command: 'true' },
      hook: { name: 'CLI registered feature', trigger: 'worker.merge_received', mode: 'persistent', enabled: false },
      expected_revisions: { commands: directory.commands.revision, registry: directory.registry.revision }, client_request_id: 'cli-registration' };
    const registrationFile = file('automation.json', registration);
    const registered = await cli('hooks', 'register', '--file', registrationFile);
    expect(registered).toMatchObject({ code: 0, err: '', value: { registered: true, template_version: 1 } });
    expect(p.hooksList().registry.items.find(item => item.id === registered.value.template_id).mount_count).toBe(0);
    expect(await cli('hooks', 'register', '--file', registrationFile)).toEqual(registered);
    const hooks = await cli('worker', 'hooks', String(main.id));
    const reference = { template_id: registered.value.template_id, template_version: registered.value.template_version, enabled: false };
    const mounted = await cli('worker', 'hook', 'attach', String(main.id), '--file', file('mount.json', reference), '--revision', hooks.value.revision);
    expect(mounted).toMatchObject({ code: 0, err: '' });
    expect(mounted.value.mounts.at(-1)).toMatchObject({ registry_id: reference.template_id, registry_version: 1, enabled: false });
    const catalog = await dispatcher.dispatch('cli.catalog', {});
    expect(catalog.commands.flatMap(command => command.rpc).find(method => method.method === 'hooks.register').schema).toEqual(HOOK_REGISTER_SCHEMA);
    const retired = await cli('hooks', 'install', String(main.id), '--file', registrationFile);
    expect(retired.code).not.toBe(0); expect(retired.err).toContain('retired'); expect(retired.err).toContain('hooks register'); expect(retired.err).toContain('worker hook attach');
    const raw = await cli('worker', 'hook', 'attach', String(main.id), '--file', file('raw.json', { ...registration.hook,
      actions: [{ type: 'notify', title: 'raw', body: '' }] }), '--revision', p.taskHooks(main.id).revision);
    expect(raw.code).not.toBe(0);
    expect(p.shortcutCommandHistory().items).toEqual([]);
    const upgraded = await cli('hooks', 'upgrade', '--revision', p.hooksList().registry.upgrade_revision);
    expect(upgraded).toMatchObject({ code: 0, err: '', value: { registry: { legacy_mount_count: 0 } } });
    // Agent configuration calls are still user-only even if they contain valid registered identities.
    await expect(dispatcher.dispatch('hooks.register', { ...registration, _token: 'not-a-user' })).rejects.toThrow();
  } finally { await rpc?.close(); await f.close(); }
});
