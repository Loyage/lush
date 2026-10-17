import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { fixture, repo, env, gate } from '../helpers.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { Dispatcher, HANDLERS } from '../../src/rpc/dispatcher.js';
import { PARAMS, USER_ONLY } from '../../src/rpc/registry.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';
import { readDeviceManagementPermissions, saveDeviceManagementPermissions } from '../../src/core/management-permissions.js';
import { managementPolicy, validateManagementCall } from '../../src/rpc/management-policy.js';
import { managementState } from '../../src/core/project/management-data.js';
import { settleNoticeAnswer } from '../../src/core/project/messages.js';

const filename = f => path.join(f.config.deviceHome || f.config.home, 'management-permissions-v2.json');
const single = (f, method = 'worker.cancel') => f.project.managementPermissionGet(method, 'device');
const set = (f, method, access, revision = single(f).revision) => f.project.managementPermissionSet(method, access, revision, 'device');
const drain = async f => { while (f.project.managementControlJobs?.size) await Promise.all([...f.project.managementControlJobs]); };
const approve = { answers: [{ selected: [1] }] };

async function manager(f, plan, instruction = '修改设备全局管家权限') {
  const cli = managementToolCLI(f.root, 'node');
  cli.plan(plan);
  f.config.env.LUSH_PI_COMMAND = cli.command;
  f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
  const task = f.project.submitManagementInstruction({ instruction, profile: { agent: 'pi', config_mode: 'pi' } }).task;
  f.project.pump();
  await Promise.all([...f.project.running.values()].map(run => run.promise));
  return { task: f.store.task(task.id), replies: JSON.parse(f.store.task(task.id).result).replies };
}

const cliBin = path.resolve(import.meta.dir, '../../bin/lush');
async function userCLI(f, ...args) {
  const proc = Bun.spawn([process.execPath, cliBin, ...args, '--json'], { cwd: f.root,
    env: env({ ...f.config.env, LUSH_PROJECT: f.root, LUSH_HOME: f.config.home }), stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err, value: code === 0 ? JSON.parse(out) : null };
}

test('built-in defaults are active without saving; old device/project restrictions remain untouched history', async () => {
  const f = fixture(); const other = fixture(undefined, { LUSH_GLOBAL_CONFIG: path.dirname(f.config.deviceHome) });
  try {
    f.project.kick = other.project.kick = () => {};
    const legacy = JSON.stringify({ version: 1, generation: 9, permissions: { 'worker.cancel': 'unavailable' } });
    const oldFile = path.join(f.config.deviceHome, 'management-permissions.json');
    fs.mkdirSync(f.config.deviceHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(oldFile, legacy, { mode: 0o600 });
    for (const item of [f, other]) item.store.run('INSERT INTO meta(key,value) VALUES (?,?)', 'management_permissions', legacy);
    const view = readDeviceManagementPermissions(f.config);
    expect(Object.keys(view).sort()).toEqual(['version','scope','configured','revision','groups','methods','permissions'].sort());
    expect(view).toMatchObject({ version: 1, scope: 'device', configured: false });
    for (const method of ['worker.cancel','worker.reserve','worker.accept','worker.delete','hooks.install','system.stop','hooks.command_save'])
      expect(view.permissions[method]).toBe('automatic');
    expect(other.project.managementPermissions()).toEqual(view);
    expect(f.project.managementPermissions()).toEqual(view);
    expect(fs.existsSync(filename(f))).toBe(false);
    const saved = set(f, 'worker.cancel', 'confirmation');
    expect(saved).toMatchObject({ method: 'worker.cancel', access: 'confirmation' });
    expect(saved.revision).not.toBe(view.revision);
    expect(other.project.managementPermissions().permissions['worker.cancel']).toBe('confirmation');
    expect(fs.readFileSync(oldFile, 'utf8')).toBe(legacy);
    for (const item of [f, other]) expect(item.store.get('SELECT value FROM meta WHERE key=?', 'management_permissions').value).toBe(legacy);
    expect(() => f.project.setManagementPermissions(view.permissions, saved.revision)).toThrow('historical');
    expect(() => set(f, 'draft.add', 'unavailable', view.revision)).toThrow('revision changed');
  } finally { await other.close(); await f.close(); }
});

test('fixture without deviceHome uses the same new defaults and never authorizes historical meta', async () => {
  const f = fixture();
  try {
    f.project.kick = () => {}; f.config.deviceHome = null;
    const legacy = '{"version":1,"generation":8,"permissions":{"draft.add":"unavailable"}}';
    f.store.run('INSERT INTO meta(key,value) VALUES (?,?)', 'management_permissions', legacy);
    const initial = f.project.managementPermissions();
    expect(initial).toMatchObject({ scope: 'device', configured: false, permissions: { 'draft.add': 'automatic' } });
    f.project.setManagementPermissions({ ...initial.permissions, 'draft.add': 'confirmation' }, initial.revision);
    expect(f.project.managementPermissions()).toMatchObject({ scope: 'device', configured: true, permissions: { 'draft.add': 'confirmation' } });
    expect(f.store.get('SELECT value FROM meta WHERE key=?', 'management_permissions').value).toBe(legacy);
    expect(fs.existsSync(filename(f))).toBe(true);
  } finally { await f.close(); }
});

for (const unsafe of ['corrupt','mode','symlink']) test(`new ${unsafe} storage fails closed, never falling back to defaults or legacy`, async () => {
  const f = fixture();
  try {
    f.project.kick = () => {};
    const view = f.project.managementPermissions();
    saveDeviceManagementPermissions(f.config, view.permissions, view.revision);
    if (unsafe === 'corrupt') fs.writeFileSync(filename(f), '{broken');
    if (unsafe === 'mode') fs.chmodSync(filename(f), 0o644);
    if (unsafe === 'symlink') {
      const target = path.join(f.config.deviceHome, 'private-target');
      fs.renameSync(filename(f), target); fs.symlinkSync(target, filename(f));
    }
    expect(() => f.project.managementPermissions()).toThrow('cannot be safely read');
    expect(() => set(f, 'worker.cancel', 'automatic', view.revision)).toThrow('cannot be safely read');
  } finally { await f.close(); }
});

test('single-item policy preserves isolation, mandatory review and explicit device instruction/scope', async () => {
  const f = fixture();
  try {
    f.project.kick = () => {};
    const snapshot = f.project.managementPermissionsSnapshot();
    for (const method of ['agent.connections.save','agent.connections.login.start','worker.transcript_page','worker.code_file','management.create','management.permissions_update']) {
      expect(managementPolicy(method).access).toBe('unavailable');
      expect(() => set(f, method, 'automatic')).toThrow('elevated');
    }
    expect(single(f, 'management.permission_set').allowed_access).toEqual(['confirmation','unavailable']);
    expect(single(f, 'manager.catalog').allowed_access).toEqual(['read']);
    expect(() => set(f, 'management.permission_set', 'automatic')).toThrow('elevated');
    expect(() => set(f, 'manager.catalog', 'unavailable')).toThrow('elevated');
    expect(() => f.project.managementPermissionGet('worker.cancel', 'project')).toThrow('device scope');
    expect(() => validateManagementCall('management.permission_get', { method: 'worker.cancel', scope: 'device' }, '查看权限', snapshot)).toThrow('explicitly requested');
    expect(() => validateManagementCall('management.permission_get', { method: 'worker.cancel' }, '查看设备权限', snapshot)).toThrow('explicit scope');
    expect(() => validateManagementCall('management.permission_set', { method: 'worker.cancel', scope: 'project' }, '修改设备权限', snapshot)).toThrow('device scope');
    for (const method of ['management.permission_get','management.permission_set']) {
      expect(USER_ONLY.has(method)).toBe(true);
      expect(Object.hasOwn(PARAMS, method)).toBe(true);
      expect(typeof HANDLERS[method]).toBe('function');
    }
  } finally { await f.close(); }
});

test('ordinary real development invocation cannot directly call either permission RPC', async () => {
  const f = fixture(); let checked = false;
  try {
    f.project.kick = () => {}; await repo(f.root);
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    f.project.provider = { async run({ token }) {
      for (const method of ['management.permission_get','management.permission_set'])
        await expect(dispatcher.dispatch(method, { method: 'worker.cancel', scope: 'device', _token: token })).rejects.toThrow('requires user approval');
      checked = true; return 'permission isolation checked';
    } };
    const task = (await f.project.order('verify isolation', 'main', [], null, false)).task;
    f.store.update(task.id, { status: 'queued' }); f.project.pump();
    await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(checked).toBe(true);
    expect(f.store.task(task.id).status).toBe('waiting');
    expect(fs.existsSync(filename(f))).toBe(false);
  } finally { await f.close(); }
});

for (const outcome of ['approve','automatic-answer','stale-revision','self-restriction']) test(`real Provider/tools/bridge -> permission CAS (${outcome}) -> narrow receipt`, async () => {
  const f = fixture(); let rpc;
  try {
    f.project.kick = () => {};
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    rpc = new RPCServer(f.config.socket, dispatcher); await rpc.start();
    const initial = single(f, outcome === 'self-restriction' ? 'management.permission_set' : 'worker.cancel');
    const access = outcome === 'self-restriction' ? 'unavailable' : 'confirmation';
    const request = { method: 'management.permission_set', params: {
      method: initial.method, access, expected_revision: initial.revision, scope: 'device' } };
    const { task, replies } = await manager(f, [
      { name: 'manager_catalog', params: {} },
      { name: 'manager_call', params: { method: 'management.permission_get', params: { method: initial.method, scope: 'device' } } },
      { name: 'manager_call', params: request, callId: 'fixed-permission-change' },
    ]);
    for (const reply of replies) expect(reply.error).toBeUndefined();
    expect(replies[0].response.details.methods.find(item => item.method === request.method)).toMatchObject({ access: 'confirmation', allowed_access: ['confirmation','unavailable'] });
    expect(replies[1].response.details).toMatchObject({ status: 'succeeded', result: { method: initial.method, access: initial.access, revision: initial.revision } });
    const pending = replies[2].response.details;
    expect(pending.status).toBe('pending_confirmation');
    expect(fs.existsSync(filename(f))).toBe(false);
    const notice = f.store.get('SELECT * FROM notices WHERE id=?', pending.notice_id);
    for (const text of ['old_access',initial.access,'new_access',access,initial.revision,'同设备用户所有项目']) expect(notice.body).toContain(text);
    // Real automatic-choice machinery must leave this management authorization open.
    f.project.setDaemonAutoSelect(true, f.project.hooksList().daemon_hooks.revision);
    expect(f.project.autoAnswerNotice(notice.id)).toBe(false);
    expect(f.store.get('SELECT status FROM notices WHERE id=?', notice.id).status).toBe('open');
    if (outcome === 'stale-revision') set(f, 'draft.add', 'unavailable', initial.revision);
    if (outcome === 'automatic-answer') settleNoticeAnswer(f.project, notice.id, approve, false, 'lush');
    else await dispatcher.dispatch('notice.answer', { id: notice.id, answer: approve });
    await drain(f);
    const call = managementState(f.store.task(task.id)).control_calls.find(call => call.receipt_id === pending.receipt_id);
    if (outcome === 'approve' || outcome === 'self-restriction') {
      expect(call.status).toBe('succeeded');
      expect(call.result).toEqual({ submitted: true, method: initial.method, access, revision: single(f).revision });
      expect(single(f, initial.method).access).toBe(access);
      expect(single(f).revision).not.toBe(initial.revision);
    } else {
      expect(call.status).toBe(outcome === 'automatic-answer' ? 'rejected' : 'failed');
      expect(single(f).access).toBe('automatic');
      if (outcome === 'automatic-answer') expect(fs.existsSync(filename(f))).toBe(false);
      else expect(single(f, 'draft.add').access).toBe('unavailable');
    }
    // Resolving/pumping again cannot replay a terminal receipt or overwrite a newer policy.
    const after = f.project.managementPermissions();
    f.project.resolveManagementConfirmation(notice.id); await drain(f);
    expect(f.project.managementPermissions()).toEqual(after);
  } finally { await rpc?.close(); await f.close(); }
});

test('real bridge executes controlled cancellation/install by default; later tightening governs new calls', async () => {
  const f = fixture(); let rpc;
  try {
    f.project.kick = () => {}; await repo(f.root);
    const target = (await f.project.order('default cancel target', 'main', [], null, false)).task;
    const reviewed = (await f.project.order('later review target', 'main', [], null, false)).task;
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    rpc = new RPCServer(f.config.socket, dispatcher); await rpc.start();
    const main = f.store.all("SELECT * FROM tasks WHERE task_kind='main'")[0];
    const hooks = f.project.taskHooks(main.id);
    const installed = { method: 'hooks.install', params: { id: main.id,
      command: { name: 'fixture never executed', kind: 'shell', command: 'echo fixture-only' },
      hook: { name: 'disabled fixture hook', trigger: 'worker.merge_received', mode: 'persistent', enabled: false },
      expected_revisions: { commands: f.project.hooksList().commands.revision, worker_hooks: hooks.revision },
      client_request_id: 'automatic-install' } };
    const first = await manager(f, [
      { name: 'manager_call', params: { method: 'worker.cancel', params: { id: target.id } } },
      { name: 'manager_call', params: installed, callId: 'install-automation' },
    ], '取消指定工作并安装停用的测试自动化');
    for (const [index, reply] of first.replies.entries()) expect(reply.error,
      `call ${index}: ${JSON.stringify(managementState(f.store.task(first.task.id)).control_calls)}`).toBeUndefined();
    expect(first.replies[0].response.details.status).toBe('succeeded');
    expect(f.store.task(target.id).status).toBe('cancelled');
    expect(first.replies[1].response.details).toMatchObject({ status: 'succeeded', result: { installed: true, worker_id: main.id } });
    expect(f.store.get('SELECT count(*) AS n FROM notices WHERE task_id=?', first.task.id).n).toBe(0);
    set(f, 'worker.cancel', 'confirmation');
    const second = await manager(f, [{ name: 'manager_call', params: { method: 'worker.cancel', params: { id: reviewed.id } } }], '取消指定工作');
    expect(second.replies[0].error).toBeUndefined();
    const pending = second.replies[0].response.details;
    expect(pending.status).toBe('pending_confirmation');
    expect(f.store.task(reviewed.id).status).toBe('paused');
    await dispatcher.dispatch('notice.answer', { id: pending.notice_id, answer: approve }); await drain(f);
    expect(f.store.task(reviewed.id).status).toBe('cancelled');
    set(f, 'worker.cancel', 'unavailable');
    const last = await manager(f, [{ name: 'manager_call', params: { method: 'worker.cancel', params: { id: reviewed.id } } }], '取消指定工作');
    expect(last.replies[0].response).toBeUndefined();
    expect(last.replies[0].error).toContain('管理请求被拒绝或未确认完成');
    expect(managementState(f.store.task(last.task.id)).control_calls ?? []).toHaveLength(0);
  } finally { await rpc?.close(); await f.close(); }
});

test('started real bridge operation retains fixed authority after device tightening and does not replay', async () => {
  const f = fixture(); let rpc; const entered = gate(), release = gate(); let invocation;
  try {
    f.project.kick = () => {}; await repo(f.root);
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    rpc = new RPCServer(f.config.socket, dispatcher); await rpc.start();
    const dispatch = f.project.managementDispatch;
    f.project.managementDispatch = async (...args) => {
      if (args[0] === 'draft.add') { entered.resolve(); await release.promise; }
      return dispatch(...args);
    };
    invocation = manager(f, [{ name: 'manager_call', callId: 'started-draft',
      params: { method: 'draft.add', params: { content: 'started under automatic authority', branch: 'main' } } }], '保存草稿');
    await entered.promise;
    set(f, 'draft.add', 'unavailable');
    release.resolve();
    const result = await invocation;
    expect(result.replies[0].error).toBeUndefined();
    expect(result.replies[0].response.details.status).toBe('succeeded');
    expect(f.store.draftCount()).toBe(1);
    expect(single(f, 'draft.add').access).toBe('unavailable');
    f.project.refreshManagementPermissions(); await drain(f);
    expect(f.store.draftCount()).toBe(1);
  } finally { release.resolve(); await invocation?.catch(() => {}); await rpc?.close(); await f.close(); }
});

test('real user CLI permission-get/set uses global CAS and retired full project writer stays retired', async () => {
  const f = fixture(); let rpc;
  try {
    f.project.kick = () => {};
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    rpc = new RPCServer(f.config.socket, dispatcher); await rpc.start();
    const read = await userCLI(f, 'hooks', 'management', 'permission-get', 'worker.cancel', '--scope', 'device');
    expect(read.code, read.err).toBe(0);
    expect(read.value).toMatchObject({ scope: 'device', configured: false, method: 'worker.cancel', access: 'automatic' });
    const saved = await userCLI(f, 'hooks', 'management', 'permission-set', 'worker.cancel', 'unavailable', '--revision', read.value.revision, '--scope', 'device');
    expect(saved.code, saved.err).toBe(0);
    expect(saved.value).toEqual({ method: 'worker.cancel', access: 'unavailable', revision: single(f).revision });
    const stale = await userCLI(f, 'hooks', 'management', 'permission-set', 'draft.add', 'unavailable', '--revision', read.value.revision, '--scope', 'device');
    expect(stale.code).not.toBe(0); expect(stale.err).toContain('revision changed');
    expect((await userCLI(f, 'hooks', 'management', 'permission-get', 'worker.cancel')).code).not.toBe(0);
    expect((await userCLI(f, 'hooks', 'management', 'permission-set', 'management.permission_set', 'automatic', '--revision', saved.value.revision, '--scope', 'device')).code).not.toBe(0);
    await expect(dispatcher.dispatch('management.permissions_update', { permissions: f.project.managementPermissions().permissions, expected_revision: single(f).revision })).rejects.toThrow('retired');
  } finally { await rpc?.close(); await f.close(); }
});
