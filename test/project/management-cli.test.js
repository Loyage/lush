import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { fixture, repo, until, gate } from '../helpers.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { AgentPackages, spawnPackageCommand } from '../../src/agent/packages.js';
import { managementCLIRequest, MANAGEMENT_TOOL_NAMES, registerManagementTools } from '../../src/agent/pi-management.js';
import { runManagementCLI } from '../../src/agent/management-cli.js';
import { CLI_COMMANDS, cliHelp, managementCLICommandPolicy } from '../../src/cli/catalog.js';
import { managementPermissionMethods, RETIRED_MANAGEMENT_METHODS } from '../../src/rpc/management-policy.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';

const command = (argv, callId) => ({ name: 'lush_cli', params: { argv }, ...(callId ? { callId } : {}) });
async function harness(runtime = 'node') {
  const f = fixture(); await repo(f.root); f.project.kick = () => {};
  const cli = managementToolCLI(f.root, runtime); f.config.env.LUSH_PI_COMMAND = cli.command;
  const provider = new AgentProvider(f.config, f.project.agentSettings), original = provider.run.bind(provider);
  provider.run = options => {
    f.env = { ...process.env, LUSH_PROJECT: f.config.project, LUSH_HOME: f.config.home, LUSH_TASK_ID: String(options.task.id),
      LUSH_AGENT_TOKEN: options.token, LUSH_MANAGER_RPC_SOCKET: f.config.socket, LUSH_MANAGER_BUN: process.execPath,
      LUSH_RUNTIME_CONTEXT: JSON.stringify({ ...options.context.invocation, task_kind: 'management', management_occurrence_id: options.context.management.signal.id }) };
    return original(options).then(result => { f.lastProviderResult = result; return result; });
  };
  f.project.provider = provider;
  const dispatcher = new Dispatcher(f.project, createSignal(), {}), rpc = new RPCServer(f.config.socket, dispatcher); await rpc.start();
  return { ...f, dispatcher, get env() { return f.env; }, async invoke(plan, instruction = '管理当前项目', existing = null) {
    cli.plan(plan); f.lastProviderResult = undefined;
    const manager = existing ?? f.project.submitManagementInstruction({ instruction, profile: { agent: 'pi', config_mode: 'pi' } }).task;
    if (existing) f.project.message(manager.id, instruction);
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const task = f.store.task(manager.id);
    expect(task.result).toBeTruthy();
    if (f.lastProviderResult === undefined) return { task }; // own decision intentionally preempts the Provider before its final stdout
    const result = JSON.parse(f.lastProviderResult);
    for (const key of ['registered','cliActive','sessionActive','modelActive']) expect(result[key]).toEqual(['lush_cli']);
    expect(result.blocked.every(Boolean)).toBe(true);
    return { ...result, task, values: result.replies.map(reply => reply.response?.details.result) };
  }, async close() { await rpc.close(); await f.close(); } };
}

for (const runtime of ['node','bun']) test(`${runtime}: Provider -> only lush_cli -> real help/parser -> permissions/execution -> safe CLI audit`, async () => {
  const f = await harness(runtime);
  try {
    const target = (await f.project.order('paused target', 'main', [], null, false)).task;
    const result = await f.invoke([
      command(['help','worker','inspect']), command(['worker','inspect',target.worker_number]),
      command(['worker','message',target.worker_number,'PRIVATE-CLI-MESSAGE']),
      command(['valet','query',target.worker_number]), command(['valet','history','--worker',target.worker_number,'--limit','1']),
      command(['worker','graph','--details','false','--scope','tree']), command(['system','diagnostics']),
    ]);
    expect(result.replies.every(reply => !reply.error)).toBe(true);
    expect(result.values[0].help).toContain('worker inspect');
    expect(result.values[1]).toMatchObject({ id: target.id, coverage: 'worker_metadata_only' });
    expect(result.values[2]).toMatchObject({ status: 'succeeded', method: 'worker.message' });
    expect(result.values[3].id).toBe(target.id);
    expect(result.values[4].scope).toBe('current_project');
    expect(result.values[5].coverage).toBe('worker_metadata_only');
    expect(f.store.unread(target.id).some(row => row.sender_id === result.task.id && row.body === 'PRIVATE-CLI-MESSAGE')).toBe(true);
    const audit = await f.dispatcher.dispatch('worker.management_calls', { id: result.task.id, after: 0 });
    expect(audit.items.filter(item => item.phase === 'finished').map(item => item.method)).toEqual([
      'worker.lookup','worker.inspect','worker.lookup','worker.message','worker.lookup','manager.query','worker.lookup','manager.history','worker.graph','system.diagnostics',
    ]);
    expect(audit.items.every(item => item.cli_command && !item.cli_command.includes('PRIVATE'))).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('PRIVATE-CLI-MESSAGE');
  } finally { await f.close(); }
});

test('worker rename reaches automatic, exact-confirmation and denied backend paths without expanding developer identity', async () => {
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

test('reviewed package CLI reads/manages a real isolated library, confirms exact removal and never loads its extension into Valet', async () => {
  const f = await harness();
  try {
    const source = path.join(f.root,'package-source'), marker = path.join(f.root,'extension-must-not-load'), log = path.join(f.root,'package-commands.jsonl');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({ name:'isolated-package',version:'1.0.0',pi:{ extensions:['./index.js'] } }));
    fs.writeFileSync(path.join(source,'index.js'),`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'loaded'); export default function(pi){pi.registerTool({name:'must_not_register'});}`);
    const executable = path.join(f.root,'controlled-package-cli');
    fs.writeFileSync(executable,`#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const [verb,source] = process.argv.slice(2), file = path.join(process.env.PI_CODING_AGENT_DIR,'settings.json');
let value; try { value = JSON.parse(fs.readFileSync(file,'utf8')); } catch { value = {}; }
const packages = value.packages ?? [];
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({verb,source})+'\\n');
if(verb === 'list') process.stdout.write('User packages:\\n'+packages.map(item=>'  '+item+'\\n    '+item+'\\n').join(''));
else if(verb === 'install' || verb === 'remove') { value.packages = verb === 'install' ? [...new Set([...packages,source])] : packages.filter(item=>item!==source); fs.writeFileSync(file,JSON.stringify(value),{mode:0o600}); }
else if(verb !== 'update') throw Error('unsupported controlled package operation');
`,{ mode:0o755 });
    await f.project.agentPackageManager.stop();
    f.project.agentPackageManager = new AgentPackages(f.config,{ run:spec => spawnPackageCommand({ ...spec,command:executable }) });
    const first = await f.invoke([
      command(['agent','packages','list']), command(['agent','packages','list','--scope','device']),
      command(['agent','packages','install',source,'--scope','device']), command(['agent','packages','list','--scope','device']),
    ],'明确管理设备全局安装库，不加载插件到管家');
    expect(JSON.parse(first.replies[0].error)).toMatchObject({ kind:'invalid_parameters',execution:'not_started' });
    expect(first.values[1].packages).toEqual([]);
    expect(first.values[2]).toMatchObject({ method:'agent.packages.install',status:'succeeded' });
    const installed = first.values[3].packages[0]; expect(installed).toMatchObject({ kind:'local',installed:true });
    expect(first.values[3].resources.extensions[0].package_id).toBe(installed.id);
    const permission = f.project.managementPermissionGet('agent.packages.remove','device'); f.project.managementPermissionSet(permission.method,'confirmation',permission.revision,'device');
    const second = await f.invoke([command(['agent','packages','update',installed.id,'--scope','device']),command(['agent','packages','remove',installed.id,'--scope','device'])],'明确更新并移除设备全局此安装包');
    expect(second.values[0]).toMatchObject({ method:'agent.packages.update',status:'succeeded' });
    const receipt = second.values[1]; expect(receipt.status).toBe('pending_confirmation');
    expect((await f.project.agentPackages('device')).packages).toHaveLength(1);
    f.project.answer(receipt.notice_id,{ answers:[{ selected:[1],custom:'' }] });
    await until(() => JSON.parse(f.store.task(second.task.id).management).control_calls.find(call=>call.receipt_id===receipt.receipt_id)?.status === 'succeeded');
    await Promise.all([...f.project.managementControlJobs]); expect((await f.project.agentPackages('device')).packages).toEqual([]);
    for(const method of ['agent.packages.list','agent.packages.install']) { const current = f.project.managementPermissionGet(method,'device'); f.project.managementPermissionSet(method,'unavailable',current.revision,'device'); }
    const before = fs.readFileSync(log,'utf8');
    const denied = await f.invoke([command(['agent','packages','list','--scope','device']),command(['agent','packages','install',source,'--scope','device'])],'再次明确管理设备全局安装库');
    for(const reply of denied.replies) expect(JSON.parse(reply.error).diagnostic).toMatchObject({ code:'permission_denied',effect:'not_started' });
    expect(fs.readFileSync(log,'utf8')).toBe(before); expect(fs.existsSync(marker)).toBe(false);
    expect(before.trim().split('\n').map(line=>JSON.parse(line)).filter(call=>call.verb!=='list').map(call=>call.verb)).toEqual(['install','update','remove']);
  } finally { await f.close(); }
});

test('direct explicit Agent configuration and Worker profile JSON avoid an unavailable private read but still reject private payloads', async () => {
  const f = await harness();
  try {
    const target = (await f.project.order('profile target','main',[],null,false)).task;
    const config = { version:1,default:{ agent:'pi',config_mode:'pi' },roles:{} }, profile = { agent:'pi',config_mode:'pi' };
    const result = await f.invoke([
      command(['agent','configure','--data',JSON.stringify(config),'--scope','device']),
      command(['worker','configure',target.worker_number,'--profile-json',JSON.stringify(profile)]),
      command(['worker','configure',target.worker_number,'--profile-json',JSON.stringify({ ...profile,env:{ PRIVATE_FORBIDDEN_ENV:'must not apply' } })]),
    ],'明确保存设备全局 Agent 配置及暂停工作的下一次设置');
    expect(result.values[0]).toMatchObject({ method:'agent.configure',status:'succeeded' });
    expect(result.values[1]).toMatchObject({ method:'worker.configure',status:'succeeded' });
    expect(JSON.parse(result.replies[2].error).diagnostic).toMatchObject({ code:'invalid_parameters',effect:'not_started' });
    expect(f.project.agentSettings.get().default).toMatchObject(profile);
    expect(f.store.task(target.id).retry_profile).not.toContain('PRIVATE_FORBIDDEN_ENV');
  } finally { await f.close(); }
});

test('real CLI keeps wrapper truncation and trusted correlation when adapting read results for ordinary handlers', async () => {
  const f = await harness();
  try {
    const dispatch = f.project.managementDispatch.bind(f.project);
    f.project.managementDispatch = (method,...args) => method === 'system.summary' ? { summary:'x'.repeat(4500) } : dispatch(method,...args);
    const result = await f.invoke([command(['system','summary'])]);
    expect(result.replies[0].response.details).toMatchObject({ exit_code:0,truncated:true,coverage:'bounded_management_projection',diagnostic:{ effect:'not_applicable',correlation:{ actor_id:result.task.id } } });
    expect(result.values[0].summary.length).toBe(4000);
  } finally { await f.close(); }
});

test('CLI help/contracts, registration, active tools and supported capability coverage agree; retired methods are not revived', () => {
  expect(MANAGEMENT_TOOL_NAMES).toEqual(['lush_cli']);
  const tools = [], events = new Map();
  registerManagementTools({ registerTool: tool => tools.push(tool), on: (key, callback) => events.set(key, callback), setActiveTools() {} });
  expect(tools.map(tool => tool.name)).toEqual(['lush_cli']);
  for (const name of ['manager_query','manager_call','manager_catalog','bash','read','mcp__exec']) expect(events.get('tool_call')({ toolName: name }).block).toBe(true);
  const mapped = new Set(CLI_COMMANDS.filter(entry => managementCLICommandPolicy(entry).available).flatMap(entry => entry.rpc));
  expect(managementPermissionMethods().filter(item => item.access !== 'unavailable' && !mapped.has(item.method)).map(item => item.method)).toEqual(['manager.catalog']);
  for (const method of RETIRED_MANAGEMENT_METHODS) expect(managementPermissionMethods().find(item => item.method === method).access).toBe('unavailable');
  const help = cliHelp('lush','hooks register'); expect(help).toContain('--data JSON'); expect(help).toContain('expected_revisions');
  expect(cliHelp('lush','worker graph')).toContain('hidden_statuses');
  expect(cliHelp('lush')).not.toContain('manager_catalog');
});

for (const access of ['automatic','confirmation']) test(`real CLI ${access} registration then separate fixed-version mount and real pinned hook effect`, async () => {
  const f = await harness();
  try {
    const main = await f.project.bootstrapMain(), output = path.join(f.root, '.lush', 'cli-pinned-hook');
    if (access === 'confirmation') for (const method of ['hooks.register','worker.hook_attach']) {
      const policy = f.project.managementPermissionGet(method, 'device'); f.project.managementPermissionSet(method, access, policy.revision, 'device');
    }
    const directory = f.project.hooksList(), registration = { command: { name: 'CLI pinned effect', command: `printf pinned >> '${output}'` },
      hook: { name: 'CLI feature', trigger: 'worker.merge_received', mode: 'persistent', enabled: true },
      expected_revisions: { commands: directory.commands.revision, registry: directory.registry.revision }, client_request_id: 'cli-register' };
    const first = await f.invoke([command(['help','hooks','register']), command(['hooks','register','--data',JSON.stringify(registration)])]);
    let registered = first.values[1];
    expect(registered).toMatchObject({ method: 'hooks.register', status: access === 'confirmation' ? 'pending_confirmation' : 'succeeded' });
    expect(fs.existsSync(output)).toBe(false);
    async function approve(receipt, task) {
      f.project.answer(receipt.notice_id, { answers: [{ selected: [1], custom: '' }] });
      await until(() => JSON.parse(f.store.task(task.id).management).control_calls.some(item => item.receipt_id === receipt.receipt_id && item.status === 'succeeded'));
      await Promise.all([...f.project.managementControlJobs]);
      return JSON.parse(f.store.task(task.id).management).control_calls.find(item => item.receipt_id === receipt.receipt_id);
    }
    if (access === 'confirmation') registered = await approve(registered, first.task);
    const identity = { template_id: registered.result.template_id, template_version: registered.result.template_version };
    expect(f.project.hooksList().registry.items.find(item => item.id === identity.template_id).mount_count).toBe(0);
    const second = await f.invoke([command(['worker','hook','attach',String(main.id),'--data',JSON.stringify(identity),'--revision',f.project.taskHooks(main.id).revision])]);
    let mounted = second.values[0];
    expect(mounted).toMatchObject({ method: 'worker.hook_attach', status: access === 'confirmation' ? 'pending_confirmation' : 'succeeded' });
    if (access === 'confirmation') mounted = await approve(mounted, second.task);
    expect(mounted.result.worker_id).toBe(main.id);
    expect(fs.existsSync(output)).toBe(false);
    f.project.emitTaskHook(main.id, 'worker.merge_received', f.store.event(main.id, 'test.cli_merge', {})); await f.project.hookQueue;
    expect(fs.readFileSync(output,'utf8')).toBe('pinned');
  } finally { await f.close(); }
});

test('real CLI denies local resources, cross-project options, auth, foreign context and expired identity without user-client fallback', async () => {
  const f = await harness(); const other = fixture();
  const otherRPC = new RPCServer(other.config.socket,new Dispatcher(other.project,createSignal(),{})); await otherRPC.start();
  try {
    const policy = f.project.managementPermissionGet('worker.inspect','device'); f.project.managementPermissionSet(policy.method,'unavailable',policy.revision,'device');
    const plans = [ ['help','--project',other.root], ['status','--project='+other.root], ['host','start'], ['daemon','start'], ['agent','init'],
      ['agent','prompt','agent'], ['agent','env','agent'], ['agent','sources','login','anything'], ['skills','get','context'],
      ['hooks','register','--file',path.join(f.root,'private.json')], ['worker','inspect','1'], ['worker','graph','--scope','development'], ['self','inspect'], ['rpc','system.status'],
    ];
    const result = await f.invoke([command(['help','worker','delete']), ...plans.map(argv => command(argv))]);
    expect(result.values[0].help).toContain('worker delete');
    for (const reply of result.replies.slice(1)) expect(reply.error).toBeTruthy();
    const permission = JSON.parse(result.replies[11].error);
    expect(permission.diagnostic).toMatchObject({ code: 'permission_denied', effect: 'not_started' });
    const scope = JSON.parse(result.replies[12].error); expect(scope).toMatchObject({ kind: 'invalid_parameters', execution: 'not_started' });
    expect(fs.existsSync(path.join(f.root,'.lush-agent'))).toBe(false);
    const audit = await f.dispatcher.dispatch('worker.management_calls', { id: result.task.id, after: 0 });
    expect(audit.items.filter(item => item.phase === 'finished').map(item => item.method)).toEqual(['worker.inspect','worker.graph']);
    const before = audit.items.length;
    await expect(managementCLIRequest(['status'],'expired',null,f.env)).rejects.toThrow('管理请求被拒绝');
    const foreign = { ...f.env, LUSH_PROJECT: other.config.project, LUSH_HOME: other.config.home, LUSH_MANAGER_RPC_SOCKET: other.config.socket };
    await expect(managementCLIRequest(['status'],'foreign',null,foreign)).rejects.toThrow('管理请求被拒绝');
    expect((await f.dispatcher.dispatch('worker.management_calls', { id: result.task.id, after: 0 })).items).toHaveLength(before);
    await expect(runManagementCLI(['status'],'forged',{ ...f.env, LUSH_RUNTIME_CONTEXT: '{}' })).rejects.toThrow('current management');
  } finally { await otherRPC.close(); await other.close(); await f.close(); }
});

test('a real developer token cannot forge the management CLI identity or fall back to user permissions', async () => {
  const f = fixture(); let rpc, rejected;
  try {
    await repo(f.root); f.project.kick = () => {};
    rpc = new RPCServer(f.config.socket,new Dispatcher(f.project,createSignal(),{})); await rpc.start();
    f.project.provider = { async run(options) {
      const env = { ...process.env,LUSH_PROJECT:f.config.project,LUSH_HOME:f.config.home,LUSH_TASK_ID:String(options.task.id),LUSH_AGENT_TOKEN:options.token,
        LUSH_MANAGER_RPC_SOCKET:f.config.socket,LUSH_MANAGER_BUN:process.execPath,LUSH_RUNTIME_CONTEXT:JSON.stringify({ task_id:options.task.id,run_id:options.context.invocation.run_id,role:'manager',task_kind:'management',management_occurrence_id:1 }) };
      try { await managementCLIRequest(['system','summary'],'forged-dev',null,env); } catch(error) { rejected = error.message; }
      return 'developer probe finished';
    } };
    await f.project.order('developer token probe'); f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(rejected).toContain('管理请求被拒绝');
    expect(f.store.all("SELECT id FROM events WHERE type='management.call_started'")).toHaveLength(0);
  } finally { await rpc?.close(); await f.close(); }
});

test('real CLI preserves dynamic device authorization, precise permission confirmation and fresh user append occurrence', async () => {
  const f = await harness();
  try {
    const initial = f.project.managementPermissionGet('draft.add','device');
    const denied = await f.invoke([command(['hooks','management','permission-get','draft.add','--scope','device'])], '只查看项目');
    expect(JSON.parse(denied.replies[0].error)).toMatchObject({ kind: 'authorization_required', execution: 'not_started' });
    const second = await f.invoke([command(['hooks','management','permission-get','draft.add','--scope','device']),
      command(['hooks','auto-select','off','--scope','device','--revision',f.project.hooksList().daemon_hooks.revision]),
      command(['hooks','management','permission-set','draft.add','confirmation','--revision',initial.revision,'--scope','device'])], '明确查询并修改设备全局权限', denied.task);
    expect(second.values[0]).toMatchObject({ method:'draft.add', access:'automatic' });
    expect(second.values[1]).toMatchObject({ method:'hooks.auto_select',status:'succeeded' });
    const receipt = second.values[2]; expect(receipt.status).toBe('pending_confirmation');
    expect(f.project.managementPermissionGet('draft.add','device').access).toBe('automatic');
    f.project.answer(receipt.notice_id,{ answers:[{ selected:[1],custom:'' }] });
    await until(() => f.project.managementPermissionGet('draft.add','device').access === 'confirmation'); await Promise.all([...f.project.managementControlJobs]);
    const third = await f.invoke([command(['order','PRIVATE-BUFFER','--buffer'])], '新增项目缓冲', second.task);
    expect(third.values[0]).toMatchObject({ method:'draft.add',status:'pending_confirmation' });
    expect(f.store.draftCount()).toBe(0);
    expect(new Set(f.store.all("SELECT data FROM events WHERE task_id=? AND type='management.call_started'", third.task.id).map(row => JSON.parse(row.data).occurrence_id)).size).toBe(3);
  } finally { await f.close(); }
});

test('real CLI lifecycle, cross-tree collaboration, safe history/transcript and self-only metadata/Notice use reviewed engine', async () => {
  const f = await harness();
  try {
    const paused = (await f.project.order('paused CLI target','main',[],null,false)).task;
    const failed = (await f.project.order('failed CLI target','main',[],null,false)).task; f.store.update(failed.id,{ status:'failed' });
    const result = await f.invoke([
      command(['worker','resume',paused.worker_number]), command(['worker','retry',failed.worker_number]),
      command(['worker','spawn','CLI child goal','--parent',paused.worker_number,'--name','cli-child']),
      command(['worker','history',paused.worker_number]), command(['worker','transcript',paused.worker_number]),
      command(['valet','progress','plan','inspect:核验']), command(['valet','progress','complete','inspect']),
      command(['valet','auto-title','CLI 管家']), command(['valet','notice','post','CLI 告知','--body','已核验','--kind','info']),
    ]);
    expect(result.replies.map((reply,index) => reply.error ? { index,error:reply.error } : null).filter(Boolean)).toEqual([]);
    for (const [index,method] of [[0,'worker.resume'],[1,'worker.retry']]) expect(result.values[index]).toMatchObject({ method,status:'succeeded',result:{ action:{ status:'succeeded' } } });
    const child = f.store.task(result.values[2].result.id); expect(child.parent_id).toBe(paused.id); expect(child.task_kind).toBe('child');
    expect(result.values[3].coverage).toBe('event_metadata_only'); expect(result.values[4].coverage).toBe('step_metadata_only');
    expect(f.project.inspect(result.task.id)).toMatchObject({ auto_title:'CLI 管家',progress:{ items:[{ key:'inspect',status:'completed' }] } });
    expect(f.store.all('SELECT kind,title FROM notices WHERE task_id=?',result.task.id).some(row => row.kind === 'info' && row.title === 'CLI 告知')).toBe(true);
  } finally { await f.close(); }
});

test('real CLI inline questionnaire posts only its own decision and safely suspends the same occurrence', async () => {
  const f = await harness();
  try {
    const result = await f.invoke([command(['valet','notice','post','CLI 决策','--body','请选择','--questions-json',JSON.stringify({ questions:[{ header:'方案',question:'本次采取哪个合法方案？',options:[{ label:'方案一',description:'保留边界。' },{ label:'方案二',description:'暂停处理。' }],multiSelect:false }] })])]);
    expect(result.task.status).toBe('awaiting');
    expect(f.store.all('SELECT kind,title FROM notices WHERE task_id=?',result.task.id).some(row => row.kind === 'questionnaire' && row.title === 'CLI 决策')).toBe(true);
  } finally { await f.close(); }
});

test('real CLI buffered input revision/edit/emission and receipt reading use real input handlers without creating a Worker early', async () => {
  const f = await harness();
  try {
    const dependency = (await f.project.order('unsettled dependency','main',[],null,false)).task;
    const first = await f.invoke([command(['order','CLI buffered content','--buffer']), command(['input','history','--view','drafts'])]);
    expect(first.values[0]).toMatchObject({ method:'draft.add',status:'succeeded' });
    const draft = f.project.drafts()[0];
    const second = await f.invoke([command(['input','buffer','update',String(draft.id),'CLI revised content','--revision',String(draft.revision),'--conditions',JSON.stringify([{kind:'worker_settled',worker_id:dependency.id}])]), command(['input','get','draft',String(draft.id)])]);
    expect(second.values[0]).toMatchObject({ method:'draft.update',status:'succeeded' });
    const latest = f.project.drafts()[0]; expect(latest.revision).toBeGreaterThan(draft.revision);
    const before = f.store.tasks().length;
    const third = await f.invoke([command(['input','emit',String(draft.id),'--revision',String(latest.revision)])]);
    expect(third.values[0]).toMatchObject({ method:'input.emit',status:'succeeded',result:{ emitted:true,draft_id:draft.id } });
    expect(f.store.tasks().length).toBe(before+1); // only the new Valet, not a development Worker
    const fourth = await f.invoke([command(['hooks','management','receipt',String(third.values[0].receipt_id)])]);
    expect(fourth.values[0]).toMatchObject({ method:'input.emit',input_emit:{ mount:'confirmed' } });
  } finally { await f.close(); }
});

test('same fresh emission in a new explicit user occurrence gets a new input identity, not a replay of the old one', async () => {
  const f = await harness();
  try {
    const dependency = (await f.project.order('not yet settled','main',[],null,false)).task;
    const argv = ['order','same explicitly requested input','--after-settled',dependency.worker_number];
    const first = await f.invoke([command(argv)],'安排此输入');
    const second = await f.invoke([command(argv)],'明确再次安排相同输入',first.task);
    expect(first.values[0].result.emitted).toBe(true); expect(second.values[0].result.emitted).toBe(true);
    expect(first.values[0].result.draft_id).not.toBe(second.values[0].result.draft_id);
    expect(f.store.draftCount()).toBe(2);
  } finally { await f.close(); }
});

test('real CLI unknown effects deduplicate the same tool invocation; receipt CLI and existing diagnostics retain first failure', async () => {
  const f = await harness();
  try {
    const dispatch = f.project.managementDispatch.bind(f.project); let effects = 0;
    f.project.managementDispatch = async (method,...args) => { const value = await dispatch(method,...args); if (method === 'draft.add') { effects++; throw Error('PRIVATE-CLI-FAILURE'); } return value; };
    const result = await f.invoke([command(['order','PRIVATE-UNKNOWN-BUFFER','--buffer'],'same-cli-call'),command(['--json','order','--buffer','PRIVATE-UNKNOWN-BUFFER'],'different-cli-call')]);
    expect(effects).toBe(1); expect(f.store.draftCount()).toBe(1);
    expect(result.values[0]).toMatchObject({ status:'unknown', diagnostic:{ code:'execution_failed',effect:'unknown' } });
    expect(result.values[1].receipt_id).toBe(result.values[0].receipt_id);
    const receipt = await f.dispatcher.dispatch('management.receipt',{ receipt_id:result.values[0].receipt_id });
    expect(receipt.diagnostic).toMatchObject({ original_failure:{ code:'execution_failed' },retry:'not_automatic' });
    const audit = await f.dispatcher.dispatch('worker.management_calls',{ id:result.task.id,after:0 });
    const text = JSON.stringify({ receipt,audit }); for (const privateText of ['PRIVATE-CLI-FAILURE','PRIVATE-UNKNOWN-BUFFER','same-cli-call','different-cli-call']) expect(text).not.toContain(privateText);
  } finally { await f.close(); }
});

for (const mode of ['abort','timeout']) test(`actual Bun CLI bridge ${mode} after a real effect preserves completion proof and cannot replay with another tool-call ID`, async () => {
  const f = fixture(); let rpc, observed, effects = 0, entered = false; const release = gate();
  try {
    await repo(f.root); f.project.kick = () => {};
    rpc = new RPCServer(f.config.socket,new Dispatcher(f.project,createSignal(),{})); await rpc.start();
    const dispatch = f.project.managementDispatch.bind(f.project);
    f.project.managementDispatch = async (method,...args) => { const value = await dispatch(method,...args); if (method === 'draft.add') { effects++; entered = true; await release.promise; } return value; };
    f.project.provider = { async run(options) {
      const env = { ...process.env,LUSH_PROJECT:f.config.project,LUSH_HOME:f.config.home,LUSH_TASK_ID:String(options.task.id),LUSH_AGENT_TOKEN:options.token,
        LUSH_MANAGER_RPC_SOCKET:f.config.socket,LUSH_MANAGER_BUN:process.execPath,LUSH_RUNTIME_CONTEXT:JSON.stringify({ task_id:options.task.id,run_id:options.context.invocation.run_id,role:'manager',task_kind:'management',management_occurrence_id:options.context.management.signal.id }) };
      const controller = new AbortController();
      const outcome = managementCLIRequest(['order','bounded real effect','--buffer'],'first-call',controller.signal,env,{ timeoutMs:mode === 'timeout' ? 500 : 30000 }).then(() => null,error => error);
      await until(() => entered); if (mode === 'abort') controller.abort();
      const error = await outcome; expect(error.message).toContain('不能换身份或自动重试'); release.resolve();
      await until(() => JSON.parse(f.store.task(options.task.id).management).control_calls[0]?.status === 'succeeded');
      observed = await managementCLIRequest(['--json','order','--buffer','bounded real effect'],'another-call-id',null,env);
      return 'bounded bridge probe completed';
    } };
    const manager = f.project.submitManagementInstruction({ instruction:'只保存隔离测试缓冲' }).task;
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(effects).toBe(1); expect(f.store.draftCount()).toBe(1);
    expect(observed.result).toMatchObject({ method:'draft.add',status:'succeeded',diagnostic:{ effect:'applied' } });
    expect(f.store.task(manager.id).status).toBe('completed');
  } finally { release.resolve(); await rpc?.close(); await f.close(); }
});

test('fixed bridge cancellation, timeout and output budget kill and reap only their own process; stderr never leaks', async () => {
  const f = fixture();
  try {
    const env = { ...process.env, LUSH_PROJECT:f.config.project,LUSH_HOME:f.config.home,LUSH_TASK_ID:'123',LUSH_AGENT_TOKEN:'test-bound-token',
      LUSH_RUNTIME_CONTEXT:JSON.stringify({ task_id:123,run_id:1,role:'manager',task_kind:'management' }),LUSH_MANAGER_RPC_SOCKET:f.config.socket };
    for (const mode of ['abort','timeout','output']) {
      const pidFile = path.join(f.root,`pid-${mode}`), executable = path.join(f.root,`bounded-${mode}`);
      fs.writeFileSync(executable,`#!/usr/bin/env node\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); process.stderr.write('PRIVATE-STDERR'); ${mode === 'output' ? "process.stdout.write('x'.repeat(300000));" : ''} setInterval(()=>{},1000);`,{ mode:0o755 });
      const controller = new AbortController();
      const request = managementCLIRequest(['help'],mode,controller.signal,{ ...env,LUSH_MANAGER_BUN:executable },{ timeoutMs:mode === 'timeout' ? 200 : 2000 });
      // Attach immediately, so a short timeout cannot become an unhandled rejection.
      const outcome = request.then(() => null,error => error);
      if (mode === 'abort') { await until(() => fs.existsSync(pidFile)); controller.abort(); }
      const error = await outcome; expect(error.message).toContain('不能换身份或自动重试'); expect(error.message).not.toContain('PRIVATE-STDERR');
      const pid = Number(fs.readFileSync(pidFile,'utf8')); expect(() => process.kill(pid,0)).toThrow();
    }
  } finally { await f.close(); }
});
