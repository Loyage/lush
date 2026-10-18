import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';
import { INPUT_EMIT_SCHEMA, INPUT_EMIT_CAPABILITY } from '../../src/core/input-emission-protocol.js';
import { managementReceipt } from '../../src/core/project/management-receipt.js';

test('ordinary Valet discovers the real input schema, gets a locatable safe pre-dispatch refusal, then mounts one exact request through the trusted bridge', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  const dispatcher = new Dispatcher(f.project, createSignal(), {}), rpc = new RPCServer(f.config.socket, dispatcher);
  await rpc.start();
  try {
    f.project.scheduleInputEmissions = () => {};
    const cli = managementToolCLI(f.root, 'node', { compactCatalog: true });
    f.config.env.LUSH_PI_COMMAND = cli.command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    const request = { content: 'PRIVATE-EMISSION-TEXT', client_request_id: 'PRIVATE-EMISSION-KEY', conditions: [{ kind: 'parent_quiet' }] };
    cli.plan([
      { name: 'manager_catalog', params: {} },
      { name: 'manager_call', params: { method: 'input.emit', params: { draft_id: 1, content: 'PRIVATE-INVALID' } } },
      { name: 'manager_call', params: { method: 'input.emit', params: request, request_id: 'PRIVATE-RECEIPT-KEY' } },
      { name: 'manager_call', params: { method: 'input.emit', params: request, request_id: 'PRIVATE-RECEIPT-KEY' } },
    ]);
    const task = f.project.submitManagementInstruction({ instruction: '按公开协议只挂载当前项目输入，不探测或重放其他操作', profile: { agent: 'pi', config_mode: 'pi' } }).task;
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const result = f.store.task(task.id);
    expect(result.status).toBe('completed');
    const replies = JSON.parse(result.result).replies;
    const catalog = replies[0].response.details.methods.find(item => item.method === 'input.emit');
    expect(catalog).toMatchObject({ access: 'automatic', schema: INPUT_EMIT_SCHEMA, examples: INPUT_EMIT_CAPABILITY.examples, authorization: INPUT_EMIT_CAPABILITY.authorization });
    const rejected = JSON.parse(replies[1].error).diagnostic;
    expect(rejected).toMatchObject({ stage: 'parameters', code: 'invalid_parameters', effect: 'not_started', evidence: 'trusted_pre_dispatch' });
    const refusal = managementReceipt(f.project, { receipt_id: rejected.correlation.request_event_id });
    expect(refusal.diagnostic).toMatchObject({ code: 'invalid_parameters', effect: 'not_started' });
    expect(refusal.capability_receipt_id).toBeNull();
    const mounted = replies[2].response.details;
    expect(mounted).toMatchObject({ status: 'succeeded', result: { emitted: true }, diagnostic: { effect: 'applied' } });
    expect(replies[3].response.details.receipt_id).toBe(mounted.receipt_id);
    expect(f.store.draftCount()).toBe(1);
    expect(f.store.all("SELECT id FROM events WHERE type='input.emitted'")).toHaveLength(1);
    expect(f.store.all('SELECT id FROM inputs')).toHaveLength(0);
    const read = managementReceipt(f.project, { receipt_id: mounted.receipt_id });
    expect(read.input_emit).toMatchObject({ mount: 'confirmed', dispatch: 'not_started', input_id: null, worker_id: null, worker_started: 'unknown', revision: 1 });
    expect(JSON.stringify({ read, refusal })).not.toContain('PRIVATE');
  } finally { await rpc.close(); await f.close(); }
});
