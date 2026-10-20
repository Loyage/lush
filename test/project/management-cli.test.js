import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { Store } from '../../src/persistence/store.js';
import { Project } from '../../src/core/project.js';
import { goalInputSource } from '../../src/persistence/store/input-sources.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';
import { callDiagnosticReport, diagnosticSummaryLines } from '../../src/ui/web/assets/management-diagnostic-model.js';

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
    return { ...result, task, values: result.replies.map(reply => {
      const value = reply.response?.details.result;
      return value?.version === 1 && Object.hasOwn(value, 'data') ? value.data : value;
    }) };
  }, async close() { await rpc.close(); await f.close(); } };
}

test('Provider -> only lush_cli -> real help/parser -> permissions/execution -> safe CLI audit', async () => {
  const f = await harness();
  try {
    const target = (await f.project.order('paused target', 'main', [], null, false)).task;
    const result = await f.invoke([
      command(['help','worker','message']), command(['help','worker','message','--json']),
      command(['help','--search','条件','--json']), command(['help','workflow','conditional-input','--json']),
      command(['worker','show',target.worker_number]), command(['worker','message',target.worker_number,'PRIVATE-CLI-MESSAGE']),
      command(['valet','context','show',target.worker_number]), command(['valet','context','history','--worker',target.worker_number,'--limit','1']),
      command(['worker','message',target.worker_number,'--','--file']),
    ]);
    expect(result.replies.every(reply => !reply.error)).toBe(true);
    expect(result.values[0].help).toContain('worker message');
    expect(result.values[0].help).toContain('CLI 参数');
    expect(result.values[1]).toMatchObject({ kind: 'command', view: 'valet', path: 'worker message' });
    expect(result.values[1].catalog_version).toBeTruthy();
    expect(result.values[2].items.some(item => item.kind === 'workflow')).toBe(true);
    expect(result.values[3].steps.some(step => step.command_id === 'input.draft.show')).toBe(true);
    expect(result.values[4]).toMatchObject({ id: target.id, coverage: 'worker_metadata_only' });
    expect(result.values[5]).toMatchObject({ status: 'succeeded', method: 'worker.message' });
    expect(result.values[6].id).toBe(target.id);
    expect(result.values[7].scope).toBe('current_project');
    expect(f.store.unread(target.id).some(row => row.sender_id === result.task.id && row.body === 'PRIVATE-CLI-MESSAGE')).toBe(true);
    expect(f.store.unread(target.id).some(row => row.sender_id === result.task.id && row.body === '--file')).toBe(true);
    const ordinary = (await f.dispatcher.dispatch('worker.reading_page', { id: target.id })).messages.find(row => row.body === 'PRIVATE-CLI-MESSAGE');
    expect(ordinary.input_source).toEqual({ kind: 'valet', worker_id: result.task.id, worker_number: result.task.worker_number });
    const audit = await f.dispatcher.dispatch('worker.management_calls', { id: result.task.id, after: 0 });
    expect(audit.items.filter(item => item.phase === 'finished').map(item => item.method)).toEqual([
      'worker.lookup','worker.inspect','worker.lookup','worker.message','worker.lookup','manager.query','worker.lookup','manager.history','worker.lookup','worker.message',
    ]);
    expect(audit.items.every(item => item.cli_command && !item.cli_command.includes('PRIVATE'))).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('PRIVATE-CLI-MESSAGE');
    const rejected = await f.invoke([
      command(['worker','watch',target.worker_number]), command(['worker','accept',target.worker_number,'--force']),
      command(['branch','integrate','preview','main']), command(['agent','package','list']),
      command(['valet','submit','must not create']), command(['automation','upgrade','--revision','REV']),
      command(['automation','register','--file','must-not-open']),
    ]);
    expect(rejected.replies.every(reply => Boolean(reply.error))).toBe(true);
    for (const reply of rejected.replies) expect(JSON.parse(reply.error)).toMatchObject({ kind: 'invalid_parameters', execution: 'not_started' });
    expect((await f.dispatcher.dispatch('worker.management_calls', { id: rejected.task.id, after: 0 })).items).toHaveLength(0);
    const condition = (await f.project.order('condition Worker', 'main', [], null, false)).task;
    const empty = (await f.dispatcher.dispatch('worker.create', { mode: 'spawn' })).task;
    const emptyDraft = await f.dispatcher.dispatch('draft.add', { content: 'must not authorize the first user input', mode: 'append', target_id: empty.id,
      conditions: [{ kind: 'worker_settled', worker_id: condition.id }] });
    const appendDraft = await f.dispatcher.dispatch('draft.add', { content: 'Valet authorized saved append', mode: 'append', target_id: target.id,
      conditions: [{ kind: 'worker_settled', worker_id: condition.id }] });
    const inline = await f.invoke([
      command(['order','conditional inline profile','--after-merged',target.worker_number, '--data','{"agent":"pi","config_mode":"pi"}']),
      command(['order','Valet mounted goal','--after-settled',condition.worker_number]),
      command(['input','draft','submit',String(appendDraft.id),'--revision','1']),
      command(['worker','spawn','Valet delegated goal','--parent',target.worker_number]),
      command(['input','draft','submit',String(emptyDraft.id),'--revision','1']),
    ]);
    expect(inline.replies.every(reply => !reply.error)).toBe(true);
    expect(inline.values[0]).toMatchObject({ method: 'input.emit', status: 'succeeded' });
    const source = { kind: 'valet', worker_id: inline.task.id, worker_number: inline.task.worker_number };
    expect(f.project.inspect(inline.values[3].result.id).goal_input_source).toEqual(source);
    const draftId = inline.values[1].result.draft_id;
    expect(JSON.parse(f.store.draft(draftId).emission).input_source).toEqual(source);
    expect(f.project.inputEmissionResult(draftId).dispatch.state).toBe('waiting_conditions');
    // Actual fresh Store/Project reads the durable mount after the original runtime exits.
    await f.project.shutdown();
    const store = new Store(path.join(f.config.home, 'project.db'), f.root), resumed = new Project(f.config, store);
    resumed.kick = () => {};
    const rpc = new Dispatcher(resumed);
    try {
      resumed.recoverInputEmissions();
      store.update(condition.id, { status: 'waiting' }); store.event(condition.id, 'task.idle', {});
      await resumed.drainInputEmissions();
      await until(() => resumed.inputEmissionResult(draftId).dispatch.state === 'succeeded');
      const dispatched = resumed.inputEmissionResult(draftId).dispatch;
      expect((await rpc.dispatch('worker.inspect', { id: dispatched.worker_id })).goal_input_source).toEqual(source);
      const queries = [], probe = { get: store.get.bind(store), all(sql, ...args) { queries.push(sql); return store.all(sql, ...args); } };
      expect(goalInputSource(probe, store.task(dispatched.worker_id))).toEqual(source);
      expect(queries.some(sql => sql.includes('management.capability_started') || sql.includes('json_each'))).toBe(false);
      const append = resumed.inputEmissionResult(appendDraft.id).dispatch;
      expect(append.state).toBe('succeeded'); expect(append.append_number).toBeNull();
      expect(resumed.inputEmissionResult(emptyDraft.id).dispatch.state).toBe('failed');
      expect(store.task(empty.id)).toMatchObject({ input_id: null, goal: '', status: 'paused' });
      const reading = await rpc.dispatch('worker.reading_page', { id: target.id });
      expect(reading.messages.find(row => row.id === append.message_id).input_source).toEqual(source);
      expect(reading.events.find(row => row.type === 'message' && row.data.message_id === append.message_id).data.input_source).toEqual(source);
      expect(store.get('SELECT sender_id FROM messages WHERE id=?', append.message_id).sender_id).toBeNull();
      expect(JSON.stringify(await rpc.dispatch('worker.inspect', { id: dispatched.worker_id }))).not.toContain('control_calls');
      // Recreate an old record without the new attachments: exact management
      // receipts restore the author read-only; absence of that proof stays unknown.
      for (const event of store.all("SELECT id,data FROM events WHERE (task_id=? AND type='input.anchor') OR (type='input.emitted' AND json_extract(data,'$.draft_id')=?)", dispatched.worker_id, draftId)) {
        const data = JSON.parse(event.data); delete data.input_source;
        store.run('UPDATE events SET data=? WHERE id=?', JSON.stringify(data), event.id);
      }
      const before = store.all('SELECT id,data FROM events ORDER BY id');
      expect((await rpc.dispatch('worker.inspect', { id: dispatched.worker_id })).goal_input_source).toEqual(source);
      expect(store.all('SELECT id,data FROM events ORDER BY id')).toEqual(before);
      store.update(inline.task.id, { management: null });
      expect((await rpc.dispatch('worker.inspect', { id: dispatched.worker_id })).goal_input_source).toEqual({ kind: 'unknown', worker_id: null, worker_number: null });
    } finally { await resumed.shutdown(); store.close(); }
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

// Existing permission/rename tests never enter conditional graph validation. This
// representative chain covers its typed rejection through the real model bridge.
test('conditional merge cycle keeps its safe business reason through CLI, receipt and browser projection', async () => {
  const f = await harness();
  try {
    const a = (await f.project.order('A','main',[],null,false)).task;
    const b = (await f.project.order('B','main',[],null,false)).task;
    f.project.scheduleMergeConditions = () => {};
    f.project.mergeTaskAfter(b.id, [{ kind: 'worker_merged', worker_id: a.id }], f.project.taskMergeConditions(b.id).revision);
    const revision = f.project.taskMergeConditions(a.id).revision;
    const request = command(['worker','merge','request',a.worker_number,'--after-merged',b.worker_number,'--revision',revision]);
    const result = await f.invoke([request]);
    const call = result.values[0];
    expect(call).toMatchObject({ method: 'worker.merge_after', status: 'failed', diagnostic: {
      code: 'merge_dependency_cycle', stage: 'execution', effect: 'not_started', evidence: 'trusted_pre_effect_rejection',
      original_failure: { code: 'merge_dependency_cycle', effect: 'not_started' }, retry: 'not_automatic',
    } });
    expect(f.project.taskMergeConditions(a.id)).toMatchObject({ state: 'idle', revision });
    expect(f.store.task(a.id).reservation).toBeNull();
    const receipt = await f.dispatcher.dispatch('management.receipt', { receipt_id: call.receipt_id });
    expect(receipt.diagnostic.original_failure).toEqual(call.diagnostic.original_failure);
    const lines = diagnosticSummaryLines(callDiagnosticReport({ ...call, call_id: call.diagnostic.correlation.call_id }, result.task, receipt)).join('\n');
    expect(lines).toContain('阶段依赖环或父子收口死锁'); expect(lines).toContain('配置未保存');
    expect(lines).not.toContain('底层原因未知');
    // Matching text/code is NOT proof of no side effects. Unclassified handler
    // errors must stay unknown, retain privacy and never become replayable.
    const dispatch = f.project.managementDispatch.bind(f.project);
    f.project.managementDispatch = (method, ...args) => {
      if (method === 'worker.merge_after') throw Object.assign(new Error('merge conditions create a cycle or parent/child closure deadlock PRIVATE'), { code: -32602 });
      return dispatch(method, ...args);
    };
    const unknown = (await f.invoke([request])).values[0];
    expect(unknown).toMatchObject({ status: 'unknown', diagnostic: { code: 'execution_failed', effect: 'unknown', retry: 'not_automatic' } });
    expect(JSON.stringify(unknown)).not.toContain('PRIVATE');
  } finally { await f.close(); }
});

test('real CLI registration then separate fixed-version mount executes the pinned hook', async () => {
  const f = await harness();
  try {
    const main = await f.project.bootstrapMain(), output = path.join(f.root, '.lush', 'cli-pinned-hook');
    const read = await f.invoke([command(['help','workflow','register-and-attach']), command(['automation','list']),
      command(['worker','automation','show',String(main.id)])]);
    expect(read.replies.every(reply => !reply.error)).toBe(true);
    expect(read.values[0].help).toContain('固定');
    const directory = read.values[1], mountRevision = read.values[2].revision;
    const registration = { command: { name: 'CLI pinned effect', command: `printf pinned >> '${output}'` },
      hook: { name: 'CLI feature', trigger: 'worker.merge_received', mode: 'persistent', enabled: true },
      expected_revisions: { commands: directory.commands.revision, registry: directory.registry.revision }, client_request_id: 'cli-register' };
    const first = await f.invoke([command(['automation','register','--data',JSON.stringify(registration)])]);
    const registered = first.values[0];
    expect(registered).toMatchObject({ method: 'hooks.register', status: 'succeeded' });
    const identity = { template_id: registered.result.template_id, template_version: registered.result.template_version };
    expect(f.project.hooksList().registry.items.find(item => item.id === identity.template_id).mount_count).toBe(0);
    const second = await f.invoke([command(['worker','automation','attach',String(main.id),'--data',JSON.stringify(identity),'--revision',mountRevision])]);
    expect(second.values[0]).toMatchObject({ method: 'worker.hook_attach', status: 'succeeded', result: { worker_id: main.id } });
    expect(fs.existsSync(output)).toBe(false);
    f.project.emitTaskHook(main.id, 'worker.merge_received', f.store.event(main.id, 'test.cli_merge', {})); await f.project.hookQueue;
    expect(fs.readFileSync(output,'utf8')).toBe('pinned');
  } finally { await f.close(); }
});
