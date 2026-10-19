import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, until } from '../helpers.js';
import { managementLegacyRPCProvider as managementToolCLI } from '../agent/management-legacy-rpc-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { MANAGEMENT_TOOL_NAMES } from '../../src/agent/pi-management.js';
import { Dispatcher, HANDLERS } from '../../src/rpc/dispatcher.js';
import { PARAMS } from '../../src/rpc/registry.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';
import { managementPolicy } from '../../src/rpc/management-policy.js';
import { HOOK_REGISTER_SCHEMA } from '../../src/core/hook-registration.js';

const sorted = values => [...values].sort();
const call = (method, params, callId) => ({ name: 'manager_call', params: { method, params }, callId });

for (const access of ['automatic', 'confirmation']) test(`real Provider/tools/bridge: ${access} registration precedes separate fixed mount; execute pinned Shell and return receipt`, async () => {
  const f = fixture(); let rpc;
  try {
    const p = f.project; p.kick = () => {}; await repo(f.root); const main = await p.bootstrapMain();
    const cli = managementToolCLI(f.root, 'node'); f.config.env.LUSH_PI_COMMAND = cli.command;
    p.provider = new AgentProvider(f.config, p.agentSettings);
    const dispatcher = new Dispatcher(p, createSignal(), {});
    rpc = new RPCServer(f.config.socket, dispatcher); await rpc.start();
    const output = path.join(f.root, '.lush', 'registered-bridge-output');
    if (access === 'confirmation') for (const method of ['hooks.register', 'worker.hook_attach']) {
      const policy = p.managementPermissionGet(method, 'device');
      p.managementPermissionSet(method, access, policy.revision, 'device');
    }
    const directory = p.hooksList(), register = { command: { name: 'bridge shell', command: `printf pinned >> '${output}'` },
      hook: { name: 'bridge merge feature', trigger: 'worker.merge_received', mode: 'persistent', enabled: true },
      expected_revisions: { commands: directory.commands.revision, registry: directory.registry.revision }, client_request_id: 'real-bridge-registration' };
    async function invoke(plan) {
      cli.plan(plan);
      const manager = p.submitManagementInstruction({ instruction: '先注册项目自动化，成功后独立请求 main 挂载，遵守当前设备权限；禁止立即执行',
        profile: { agent: 'pi', config_mode: 'pi' } }).task;
      p.pump();
      await until(() => p.running.has(manager.id));
      await p.running.get(manager.id).promise;
      const result = JSON.parse(f.store.task(manager.id).result);
      for (const key of ['registered','cliActive','sessionActive','modelActive']) expect(result[key]).toEqual([...MANAGEMENT_TOOL_NAMES]);
      return { manager, result };
    }
    async function approve(manager, receipt) {
      const answered = p.answer(receipt.notice_id, { answers: [{ selected: [1], custom: '' }] });
      expect(answered.answer_source).toBe('user');
      await until(() => {
        const state = JSON.parse(f.store.task(manager.id).management);
        return state.control_calls.find(item => item.receipt_id === receipt.receipt_id)?.status === 'succeeded';
      });
      await Promise.all([...p.managementControlJobs]);
      return JSON.parse(f.store.task(manager.id).management).control_calls.find(item => item.receipt_id === receipt.receipt_id);
    }
    const first = await invoke([
      { name: 'manager_catalog', params: {} },
      call('hooks.install', {}, 'retired-install'),
      call('worker.hook_attach', { id: main.id, hook: { ...register.hook, actions: [{ type: 'command', command_id: '00000000-0000-0000-0000-000000000000' }] }, expected_revision: p.taskHooks(main.id).revision }, 'raw-mount'),
      call('hooks.register', register, 'register-step'),
    ]);
    const catalog = first.result.replies[0].response.details;
    expect(sorted(catalog.methods.map(item => item.method))).toEqual(sorted(Object.keys(PARAMS)));
    expect(sorted(Object.keys(PARAMS))).toEqual(sorted(Object.keys(HANDLERS)));
    expect(catalog.methods.find(item => item.method === 'hooks.register')).toMatchObject({ access, schema: HOOK_REGISTER_SCHEMA });
    expect(catalog.methods.find(item => item.method === 'worker.hook_attach').access).toBe(access);
    expect(managementPolicy('hooks.register').access).toBe('automatic');
    expect(managementPolicy('worker.hook_attach').access).toBe('automatic');
    expect(managementPolicy('hooks.install').access).toBe('unavailable');
    for (const index of [1, 2]) expect(first.result.replies[index].error).toContain('管理请求被拒绝或未确认完成');
    const request = first.result.replies[3].response.details;
    expect(request).toMatchObject({ method: 'hooks.register', status: access === 'confirmation' ? 'pending_confirmation' : 'succeeded' });
    expect(p.hooksList().registry.items.some(item => item.name === register.hook.name)).toBe(access === 'automatic');
    expect(fs.existsSync(output)).toBe(false);
    const registered = access === 'confirmation' ? await approve(first.manager, request) : request;
    expect(registered.result).toMatchObject({ submitted: true, registered: true, template_version: 1 });
    const identity = { template_id: registered.result.template_id, template_version: registered.result.template_version };
    expect(p.hooksList().registry.items.find(item => item.id === identity.template_id)).toMatchObject({ mount_count: 0, version: 1 });
    expect(fs.existsSync(output)).toBe(false);
    expect(p.registerCommandHook(register)).toEqual({ registered: true, command_id: registered.result.command_id, ...identity });
    const second = await invoke([call('worker.hook_attach', { id: main.id, hook: identity, expected_revision: p.taskHooks(main.id).revision }, 'mount-step')]);
    const mountRequest = second.result.replies[0].response.details;
    expect(mountRequest).toMatchObject({ method: 'worker.hook_attach', status: access === 'confirmation' ? 'pending_confirmation' : 'succeeded' });
    if (access === 'confirmation') expect(mountRequest.notice_id).not.toBe(request.notice_id);
    else for (const owner of [first.manager, second.manager]) expect(f.store.get('SELECT count(*) AS n FROM notices WHERE task_id=?', owner.id).n).toBe(0);
    expect(p.hooksList().registry.items.find(item => item.id === identity.template_id).mount_count).toBe(access === 'confirmation' ? 0 : 1);
    const mounted = access === 'confirmation' ? await approve(second.manager, mountRequest) : mountRequest;
    expect(mounted.result).toMatchObject({ submitted: true, worker_id: main.id });
    expect(typeof mounted.result.hook_id).toBe('string');
    expect(fs.existsSync(output)).toBe(false);
    p.emitTaskHook(main.id, 'worker.merge_received', f.store.event(main.id, 'test.bridge_merge', {})); await p.hookQueue;
    expect(fs.readFileSync(output, 'utf8')).toBe('pinned');
    const history = await dispatcher.dispatch('hooks.command_history', {});
    expect(history.items[0]).toMatchObject({ command_id: registered.result.command_id, command_version: 1, worker_id: main.id, status: 'succeeded' });
    expect(p.taskHooks(main.id).mounts.find(item => item.id === mounted.result.hook_id)).toMatchObject({ state: 'succeeded', registry_version: 1 });
    for (const method of ['hooks.register', 'worker.hook_attach']) {
      const policy = p.managementPermissionGet(method, 'device');
      p.managementPermissionSet(method, 'unavailable', policy.revision, 'device');
    }
    const before = p.hooksList();
    const denied = await invoke([
      call('hooks.register', { ...register, client_request_id: 'denied-registration' }, 'denied-register'),
      call('worker.hook_attach', { id: main.id, hook: identity, expected_revision: p.taskHooks(main.id).revision }, 'denied-mount'),
    ]);
    for (const reply of denied.result.replies) expect(reply.error).toContain('管理请求被拒绝或未确认完成');
    const after = p.hooksList();
    for (const key of ['registry', 'templates', 'commands']) expect(after[key]).toEqual(before[key]);
    expect(fs.readFileSync(output, 'utf8')).toBe('pinned');
  } finally { await rpc?.close(); await f.close(); }
});
