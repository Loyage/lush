import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';

const command = argv => ({ name: 'lush_cli', params: { argv } });
async function harness() {
  const f = fixture(); await repo(f.root); f.project.kick = () => {};
  const cli = managementToolCLI(f.root, 'node'); f.config.env.LUSH_PI_COMMAND = cli.command;
  f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
  const dispatcher = new Dispatcher(f.project, createSignal(), {}), rpc = new RPCServer(f.config.socket, dispatcher); await rpc.start();
  return { ...f, dispatcher, async invoke(plan) {
    cli.plan(plan);
    const manager = f.project.submitManagementInstruction({ instruction: '管理当前项目', profile: { agent: 'pi', config_mode: 'pi' } }).task;
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const task = f.store.task(manager.id), result = JSON.parse(task.result);
    for (const key of ['registered','cliActive','sessionActive','modelActive']) expect(result[key]).toEqual(['lush_cli']);
    expect(result.blocked.every(Boolean)).toBe(true);
    return { ...result, task, values: result.replies.map(reply => reply.response?.details.result) };
  }, async close() { await rpc.close(); await f.close(); } };
}

test('Provider -> only lush_cli -> real help/parser -> permissions/execution -> safe CLI audit', async () => {
  const f = await harness();
  try {
    const target = (await f.project.order('paused target', 'main', [], null, false)).task;
    const result = await f.invoke([
      command(['help','worker','inspect']), command(['worker','inspect',target.worker_number]),
      command(['worker','message',target.worker_number,'PRIVATE-CLI-MESSAGE']),
      command(['valet','query',target.worker_number]), command(['valet','history','--worker',target.worker_number,'--limit','1']),
    ]);
    expect(result.replies.every(reply => !reply.error)).toBe(true);
    expect(result.values[0].help).toContain('worker inspect');
    expect(result.values[1]).toMatchObject({ id: target.id, coverage: 'worker_metadata_only' });
    expect(result.values[2]).toMatchObject({ status: 'succeeded', method: 'worker.message' });
    expect(result.values[3].id).toBe(target.id);
    expect(result.values[4].scope).toBe('current_project');
    expect(f.store.unread(target.id).some(row => row.sender_id === result.task.id && row.body === 'PRIVATE-CLI-MESSAGE')).toBe(true);
    const audit = await f.dispatcher.dispatch('worker.management_calls', { id: result.task.id, after: 0 });
    expect(audit.items.filter(item => item.phase === 'finished').map(item => item.method)).toEqual([
      'worker.lookup','worker.inspect','worker.lookup','worker.message','worker.lookup','manager.query','worker.lookup','manager.history',
    ]);
    expect(audit.items.every(item => item.cli_command && !item.cli_command.includes('PRIVATE'))).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('PRIVATE-CLI-MESSAGE');
  } finally { await f.close(); }
});

test('worker rename reaches automatic, exact-confirmation and denied backend paths', async () => {
  const f = await harness();
  try {
    const target = (await f.project.order('rename target','main',[],null,false)).task;
    const first = await f.invoke([command(['worker','rename',target.worker_number,'CLI automatic title'])]);
    expect(first.values[0]).toMatchObject({ method:'worker.rename',status:'succeeded' });
    expect(f.store.task(target.id).display_title).toBe('CLI automatic title');
    let permission = f.project.managementPermissionGet('worker.rename','device'); f.project.managementPermissionSet(permission.method,'confirmation',permission.revision,'device');
    const second = await f.invoke([command(['worker','rename',target.worker_number,'CLI confirmed title'])]);
    const receipt = second.values[0]; expect(receipt.status).toBe('pending_confirmation');
    expect(f.store.task(target.id).display_title).toBe('CLI automatic title');
    f.project.answer(receipt.notice_id,{ answers:[{ selected:[1],custom:'' }] });
    await until(() => f.store.task(target.id).display_title === 'CLI confirmed title'); await Promise.all([...f.project.managementControlJobs]);
    permission = f.project.managementPermissionGet('worker.rename','device'); f.project.managementPermissionSet(permission.method,'unavailable',permission.revision,'device');
    const denied = await f.invoke([command(['worker','rename',target.worker_number,'must not apply'])]);
    expect(JSON.parse(denied.replies[0].error).diagnostic).toMatchObject({ code:'permission_denied',effect:'not_started' });
    expect(f.store.task(target.id).display_title).toBe('CLI confirmed title');
  } finally { await f.close(); }
});

test('real CLI registration then separate fixed-version mount executes the pinned hook', async () => {
  const f = await harness();
  try {
    const main = await f.project.bootstrapMain(), output = path.join(f.root, '.lush', 'cli-pinned-hook');
    const directory = f.project.hooksList(), registration = { command: { name: 'CLI pinned effect', command: `printf pinned >> '${output}'` },
      hook: { name: 'CLI feature', trigger: 'worker.merge_received', mode: 'persistent', enabled: true },
      expected_revisions: { commands: directory.commands.revision, registry: directory.registry.revision }, client_request_id: 'cli-register' };
    const first = await f.invoke([command(['hooks','register','--data',JSON.stringify(registration)])]);
    const registered = first.values[0];
    expect(registered).toMatchObject({ method: 'hooks.register', status: 'succeeded' });
    const identity = { template_id: registered.result.template_id, template_version: registered.result.template_version };
    expect(f.project.hooksList().registry.items.find(item => item.id === identity.template_id).mount_count).toBe(0);
    const second = await f.invoke([command(['worker','hook','attach',String(main.id),'--data',JSON.stringify(identity),'--revision',f.project.taskHooks(main.id).revision])]);
    expect(second.values[0]).toMatchObject({ method: 'worker.hook_attach', status: 'succeeded', result: { worker_id: main.id } });
    expect(fs.existsSync(output)).toBe(false);
    f.project.emitTaskHook(main.id, 'worker.merge_received', f.store.event(main.id, 'test.cli_merge', {})); await f.project.hookQueue;
    expect(fs.readFileSync(output,'utf8')).toBe('pinned');
  } finally { await f.close(); }
});
