import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AdministratorService } from '../src/administrator/service.js';
import { AdministratorClient, AdministratorInvocationClient } from '../src/administrator/client.js';
import { ADMINISTRATOR_RPC } from '../src/administrator/runtime-protocol.js';
import { startAdministratorProcess } from '../src/administrator/lifecycle.js';
import { RPCClient } from '../src/rpc/client.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const definition = (kind, key, rest) => ({ kind, mode: 'administrator', scope: 'device_user', client_request_id: key, ...rest });

test('device administrator confirms exact user inputs, executes an invocation-only audited chain, stops real owners and never replays crash-unknown work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-administrator-'));
  const home = path.join(root, 'state'), env = { HOME: root, LUSH_GLOBAL_CONFIG: path.join(root, 'device'), PATH: process.env.PATH };
  const user = 'trusted-host-session-one', otherUser = 'trusted-host-session-two';
  let service, restarted, subprocessPid = null, instant = Date.now(), writes = 0, failures = 0;
  const stoppingStarted = deferred(), releaseTool = deferred(), releaseRunner = deferred();
  const tokens = [], runnerInputs = [];
  const executor = {
    catalog: () => [{ name: 'project.query', readOnly: true }, { name: 'project.submit', readOnly: false },
      { name: 'project.slow', readOnly: false }, { name: 'project.fail', readOnly: false }],
    async execute({ operation, params, identity }) {
      expect(Object.keys(identity).sort()).toEqual(['call_id', 'instruction_id', 'service_id', 'worker_id']);
      if (operation === 'project.query') return { source: 'isolated project source', target: { status: 'unknown', effect: 'unknown' }, token: 'must-not-escape', credential: { key: 'must-not-escape' } };
      if (operation === 'project.submit') { writes++; return { submitted: true, action: { status: 'waiting' }, params }; }
      if (operation === 'project.slow') { stoppingStarted.resolve(); await releaseTool.promise; return { submitted: true }; }
      if (operation === 'project.fail') {
        failures++;
        return { version: 1, status: 'unknown', effect: 'unknown', identity,
          error: { name: 'Error', code: 'WRITE_UNCONFIRMED', message: 'original execution failure marker' } };
      }
    },
  };
  const runner = async options => {
    tokens.push(options.token); runnerInputs.push(options.instruction.instruction);
    const invocation = new AdministratorInvocationClient(options.socket, options.token);
    expect((await invocation.catalog()).items.map(item => item.name)).toEqual(executor.catalog().map(item => item.name));
    // The same active model token cannot become a user control identity or inject another input.
    await expect(new RPCClient(options.socket).request(ADMINISTRATOR_RPC.preview, { token: options.token, definition: {} })).rejects.toThrow();
    await expect(new RPCClient(options.socket).request(ADMINISTRATOR_RPC.preview, { control: options.token, definition: {}, user_binding: user })).rejects.toThrow();
    if (options.instruction.instruction === '先读再提交') {
      const read = await invocation.call('project.query', { id: 1 });
      expect(read.result).toEqual({ source: 'isolated project source', target: { status: 'unknown', effect: 'unknown' } });
      const first = await invocation.call('project.submit', { alpha: 1, beta: 2 });
      const repeated = await invocation.call('project.submit', { beta: 2, alpha: 1 });
      expect(repeated.call.id).toBe(first.call.id);
      expect(first.result.action.status).toBe('waiting');
      expect(first.call.effect).toBe('unknown'); // Callback return is not project business completion.
      options.onEvent({ type: 'output', data: { text: '已提交，等待原项目安全点' } });
      return '提交收据已返回，不代表目标工作完成';
    }
    if (options.instruction.instruction === '请求停止') {
      const pending = invocation.call('project.slow', {});
      await releaseRunner.promise;
      await pending;
      return '停止后返回也不能抹除已开始的副作用';
    }
    const failed = await invocation.call('project.fail', {});
    const duplicate = await invocation.call('project.fail', {});
    expect(failed.call.status).toBe('unknown');
    expect(duplicate.call.id).toBe(failed.call.id);
    expect(failed.result.error.message).toBe('original execution failure marker');
    expect(duplicate.result).toEqual(failed.result);
    expect(failed.call.original_failure.detail).toMatchObject({ source: 'executor_receipt', error: { message: 'original execution failure marker' } });
    return '底层请求结果未知';
  };
  try {
    const offline = new AdministratorClient({ env, home });
    expect((await offline.readStatus()).online).toBe(false);
    expect(fs.existsSync(home)).toBe(false);
    service = await new AdministratorService({ home, env, runner, executor, clock: () => instant }).start();
    const client = new AdministratorClient({ env, home });
    expect((await client.readStatus()).online).toBe(true);
    await expect(new AdministratorClient({ env: { ...env, LUSH_AGENT_TOKEN: 'ordinary-worker-token' }, home }).readStatus()).rejects.toThrow();
    await expect(new AdministratorClient({ env: { ...env, LUSH_ADMIN_TOKEN: 'administrator-invocation-token' }, home }).readStatus()).rejects.toThrow();
    await expect(new RPCClient(service.paths.socket).request(ADMINISTRATOR_RPC.commit, { _token: 'ordinary-management-token', body: {}, user_binding: user })).rejects.toThrow();
    const create = definition('create', 'create_one', { name: '隔离管理员' });
    const preview = await client.preview(create, user);
    expect(runnerInputs).toHaveLength(0);
    await expect(client.commit({ confirmation_id: preview.confirmation_id, definition: create, confirm: true }, otherUser)).rejects.toThrow();
    await expect(client.commit({ confirmation_id: preview.confirmation_id, definition: { ...create, name: '换了名称' }, confirm: true }, user)).rejects.toThrow();
    expect((await client.receipt({ client_request_id: create.client_request_id }, user)).found).toBe(false);
    // Deliberately discard the mutation ACK; recover only by its exact read-only receipt.
    await client.commit({ confirmation_id: preview.confirmation_id, definition: create, confirm: true }, user);
    const created = await client.receipt({ client_request_id: create.client_request_id }, user);
    expect(created).toMatchObject({ found: true, definition: create });
    // Re-authentication changes the session, not the device-owner read scope. No grant is renewed.
    expect(await client.receipt({ client_request_id: create.client_request_id }, otherUser)).toMatchObject({ found: true, definition: create, worker: { id: created.worker.id } });
    const workerId = created.worker.id;
    expect(created.worker).toMatchObject({ worker_number: 'ADM1', status: 'ready', can_input: true, mode: 'administrator', scope: 'device_user' });
    expect(runnerInputs).toHaveLength(0);
    expect((await client.commit({ confirmation_id: preview.confirmation_id, definition: create, confirm: true }, user)).worker.id).toBe(workerId);
    const input = definition('input', 'input_one', { id: workerId, instruction: '先读再提交' });
    const inputPreview = await client.preview(input, user);
    await expect(client.commit({ confirmation_id: inputPreview.confirmation_id, definition: { ...input, instruction: '先读再提交 ' }, confirm: true }, user)).rejects.toThrow();
    await expect(client.commit({ confirmation_id: inputPreview.confirmation_id, definition: { ...input, mode: 'management' }, confirm: true }, user)).rejects.toThrow();
    await client.commit({ confirmation_id: inputPreview.confirmation_id, definition: input, confirm: true }, user);
    await service.idle();
    const detail = await client.detail({ id: workerId, limit: 100 });
    expect(detail.worker).toMatchObject({ status: 'ready', can_input: true, result: '提交收据已返回，不代表目标工作完成' });
    expect(detail.events.some(event => event.type === 'tool.returned')).toBe(true);
    expect(detail.events.some(event => event.type === 'agent.output')).toBe(true);
    expect(JSON.stringify(detail)).not.toContain(tokens[0]);
    expect(writes).toBe(1);
    expect(await client.receipt({ client_request_id: input.client_request_id }, user)).toMatchObject({
      found: true, definition: input, worker: { id: workerId, status: 'ready' }, instruction: { instruction: input.instruction, status: 'succeeded' },
    });
    await expect(new AdministratorInvocationClient(service.paths.socket, tokens[0]).catalog()).rejects.toThrow();
    const expired = await client.preview(definition('input', 'expired', { id: workerId, instruction: '过期内容' }), user);
    instant += 300001;
    await expect(client.commit({ confirmation_id: expired.confirmation_id, definition: expired.definition, confirm: true }, user)).rejects.toThrow();
    const stopInput = definition('input', 'input_stop', { id: workerId, instruction: '请求停止' });
    const stopPreview = await client.preview(stopInput, user);
    await client.commit({ confirmation_id: stopPreview.confirmation_id, definition: stopInput, confirm: true }, user);
    await stoppingStarted.promise;
    expect((await client.stop(workerId, user)).worker).toMatchObject({ status: 'stopping', running: true, can_input: false });
    await expect(new AdministratorInvocationClient(service.paths.socket, tokens.at(-1)).call('project.query', {})).rejects.toThrow();
    releaseRunner.resolve(); releaseTool.resolve(); await service.idle();
    expect((await client.detail({ id: workerId })).worker).toMatchObject({ status: 'stopped', running: false, can_input: false, effect: 'unknown' });
    expect((await client.commit({ confirmation_id: stopPreview.confirmation_id, definition: stopInput, confirm: true }, user)).worker.status).toBe('stopped');
    expect((await client.receipt({ client_request_id: stopInput.client_request_id }, user)).worker).toMatchObject({ id: workerId, status: 'stopped', can_input: false });
    const failureCreate = await client.preview(definition('create', 'create_fault', { name: '故障管理员' }), user);
    const failureWorker = (await client.commit({ confirmation_id: failureCreate.confirmation_id, definition: failureCreate.definition, confirm: true }, user)).worker;
    const failureInput = await client.preview(definition('input', 'input_fault', { id: failureWorker.id, instruction: '保留失败' }), user);
    await client.commit({ confirmation_id: failureInput.confirmation_id, definition: failureInput.definition, confirm: true }, user); await service.idle();
    expect(failures).toBe(1);
    const failed = await client.detail({ id: failureWorker.id, limit: 2 });
    expect(failed.worker).toMatchObject({ status: 'unknown', can_input: false, effect: 'unknown',
      original_failure: { stage: 'execution', detail: { source: 'executor_receipt', error: { code: 'WRITE_UNCONFIRMED', message: 'original execution failure marker' } } } });
    await expect(client.preview(definition('input', 'forbidden_after_unknown', { id: failureWorker.id, instruction: '不能静默重放' }), user)).rejects.toThrow();
    expect(failed.has_more).toBe(true);
    const older = await client.detail({ id: failureWorker.id, before: failed.next_cursor, limit: 100 });
    expect(older.events.at(-1).id).toBeLessThan(Number(failed.next_cursor));
    expect((await client.list({ limit: 1 })).has_more).toBe(true);
    await service.close(); service = null;
    restarted = await new AdministratorService({ home, env, runner, executor }).start();
    const recoveredFailure = await new AdministratorClient({ env, home }).detail({ id: failureWorker.id });
    expect(recoveredFailure.worker.status).toBe('unknown');
    expect(recoveredFailure.worker.original_failure).toEqual(failed.worker.original_failure);
    const stoppedFailure = await new AdministratorClient({ env, home }).stop(failureWorker.id, user);
    expect(stoppedFailure.worker.original_failure).toEqual(failed.worker.original_failure);
    expect(failures).toBe(1);
    await restarted.close(); restarted = null;

    // A real killed isolated process releases the kernel service lock; started input/tools remain unknown.
    const crashHome = path.join(root, 'crash-state'), entrypoint = path.join(root, 'crash-entry.js');
    const serviceURL = pathToFileURL(path.resolve('src/administrator/lifecycle.js')).href;
    const clientURL = pathToFileURL(path.resolve('src/administrator/client.js')).href;
    fs.writeFileSync(entrypoint, `import {serveAdministrator} from ${JSON.stringify(serviceURL)};\nimport {AdministratorInvocationClient} from ${JSON.stringify(clientURL)};\nconst executor={catalog:()=>[{name:'project.hang',readOnly:false}],execute:()=>new Promise(()=>{})};\nconst {closed}=await serveAdministrator({executor,runner:async ({socket,token})=>{await new AdministratorInvocationClient(socket,token).call('project.hang',{});return 'unreachable';}});\nawait closed;\n`, { mode: 0o600 });
    const online = await startAdministratorProcess({ env, home: crashHome, entrypoint }); subprocessPid = online.pid;
    const crashClient = new AdministratorClient({ env, home: crashHome });
    const cp = await crashClient.preview(definition('create', 'crash_create', { name: '崩溃现场' }), user);
    const crashWorker = (await crashClient.commit({ confirmation_id: cp.confirmation_id, definition: cp.definition, confirm: true }, user)).worker;
    const ip = await crashClient.preview(definition('input', 'crash_input', { id: crashWorker.id, instruction: '执行一次未知副作用' }), user);
    await crashClient.commit({ confirmation_id: ip.confirmation_id, definition: ip.definition, confirm: true }, user);
    // A read-only invocation barrier observes the durable tool start without sending another instruction.
    let crashDetail;
    for (let i = 0; i < 100; i++) {
      crashDetail = await crashClient.detail({ id: crashWorker.id });
      if (crashDetail.events.some(event => event.type === 'tool.started')) break;
      await Bun.sleep(5);
    }
    expect(crashDetail.events.some(event => event.type === 'tool.started')).toBe(true);
    const exited = new Promise(resolve => {
      const timer = setInterval(() => { try { process.kill(subprocessPid, 0); } catch { clearInterval(timer); resolve(); } }, 5);
    });
    process.kill(subprocessPid, 'SIGKILL'); await exited; subprocessPid = null;
    restarted = await new AdministratorService({ home: crashHome, env, runner, executor }).start();
    const recovered = await new AdministratorClient({ env, home: crashHome }).detail({ id: crashWorker.id });
    expect(recovered.worker).toMatchObject({ status: 'unknown', can_input: false, effect: 'unknown' });
    expect(recovered.events.some(event => event.type === 'tool.recovery_unknown')).toBe(true);
    expect(runnerInputs).toEqual(['先读再提交', '请求停止', '保留失败']);
  } finally {
    releaseRunner.resolve(); releaseTool.resolve();
    await service?.close(); await restarted?.close();
    if (subprocessPid) { try { process.kill(subprocessPid, 'SIGKILL'); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
