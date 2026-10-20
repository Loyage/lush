import fs from 'node:fs';
import path from 'node:path';
import { test,expect } from 'bun:test';
import { fixture,repo,until } from '../helpers.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { RPCClient } from '../../src/rpc/client.js';
import { startTestWeb, fetch } from '../web/auth-fixture.js';
import { projectRouteId } from '../../src/host/registry.js';
import { PROJECT_ELEVATION_RPC } from '../../src/administrator/project-protocol.js';
import { createSignal } from '../../src/signal.js';
import { managementState } from '../../src/core/project/management-data.js';
import { projectAdministratorMethods } from '../../src/administrator/project-execution.js';
import { PROJECT_ADMINISTRATOR_RPC } from '../../src/administrator/project-tool-protocol.js';
import { sessionFiles } from '../../src/core/transcript.js';
import { workerFiles } from '../../src/core/deletion-resources.js';

const tool=(operation,params)=>({name:'administrator',params:{operation,params}});
// One real vertical slice: authenticated password -> signed native intake -> Provider/bridge -> handler.
test('Web password -> native elevated Valet -> isolated Provider/bridge -> handler and next ordinary occurrence',async()=>{
  const f=fixture();await repo(f.root);f.project.kick=()=>{};
  const cli=managementToolCLI(f.root,'node');f.config.env.LUSH_PI_COMMAND=cli.command;
  fs.writeFileSync(cli.command,fs.readFileSync(cli.command,'utf8').replace('console.log(JSON.stringify({ runtime:','console.log(JSON.stringify({ startup: input, argv: args, runtime:'));
  f.project.provider=new AgentProvider(f.config,f.project.agentSettings);
  const dispatcher=new Dispatcher(f.project,createSignal(),{}),rpc=new RPCServer(f.config.socket,dispatcher);await rpc.start();
  const routeId=projectRouteId(f.root),client=new RPCClient(f.config.socket),forwarded=[];
  const request=client.request.bind(client);
  client.request=(method,params)=>{forwarded.push({method,params});return request(method,params);};
  const host={launcher:true,hasRoute:id=>id===routeId,async openRoute(id){if(id!==routeId)throw Error('unknown fixture project');return{config:f.config,client};},async projects(){return[];},async status(){return{mode:'host',projects:[]};}};
  const web=startTestWeb(null,0,{env:f.config.env,projectHost:host}),base=`http://127.0.0.1:${web.port}/p/${routeId}`;
  const password='synthetic-test-only-password';
  const post=(definition,value=password)=>fetch(base+'/api/management/elevate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({definition,password:value,confirm:true})});
  async function elevate(definition){const response=await post(definition);expect(response.status).toBe(200);return response.json();}
  let ordinaryRejected=false,ordinaryPathBlocked=false;
  const run=f.project.provider.run.bind(f.project.provider);
  f.project.provider.run=async options=>{
    if(options.context.management.authorization.mode==='administrator'){
      await expect(dispatcher.dispatch('manager.query',{_token:options.token})).rejects.toThrow();ordinaryPathBlocked=true;
    }else{
      await expect(dispatcher.dispatch(PROJECT_ADMINISTRATOR_RPC,{operation:'catalog',params:{},_token:options.token})).rejects.toThrow();ordinaryRejected=true;
    }
    return run(options);
  };
  async function pump(plan){cli.plan(plan);f.project.pump();await Promise.all([...f.project.running.values()].map(item=>item.promise));await Promise.all([...f.project.managementControlJobs]);}
  try{
    const target=(await f.project.order('project target','main',[],null,false)).task;
    const empty=(await dispatcher.dispatch('worker.create',{mode:'spawn'})).task;
    const permission=f.project.managementPermissionGet('worker.rename','device');f.project.managementPermissionSet('worker.rename','confirmation',permission.revision,'device');
    fs.mkdirSync(path.join(f.root,'src'));fs.writeFileSync(path.join(f.root,'src','app.js'),'export const answer = 42;\nconst api_key = "PRIVATE-SOURCE-CANARY";\n');
    // User-owned Shell registrations must not become an elevated execution back door.
    const marker=path.join(f.config.home,'forbidden-shell-effect'),directory=f.project.hooksList();
    const shellDefinition={command:{name:'existing user Shell',command:`printf forbidden > '${marker}'`},
      hook:{name:'existing user feature',trigger:'worker.merge_received',mode:'persistent',enabled:true},
      expected_revisions:{commands:directory.commands.revision,registry:directory.registry.revision},client_request_id:'fixture-shell'};
    const registered=f.project.registerCommandHook(shellDefinition);
    const mounted=f.project.attachTaskHook(target.id,{template_id:registered.template_id,template_version:registered.template_version,enabled:false},f.project.taskHooks(target.id).revision);
    const shellMount=mounted.mounts.find(item=>item.registry_id===registered.template_id),registryRevision=f.project.hooksList().registry.revision,commandsRevision=f.project.shortcutCommands().revision;
    const forbiddenRegistration={...shellDefinition,client_request_id:'must-not-register',expected_revisions:{commands:commandsRevision,registry:registryRevision}};
    const definition={kind:'submit',mode:'administrator',scope:'current_project',client_request_id:'native-high-1',instruction:' PRIOR-HIGH-GOAL-CANARY\n ',profile:{agent:'pi',config_mode:'pi'}};
    const before=f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='management'").n;
    const wrong=await post(definition,'incorrect-password');expect(wrong.status).toBe(403);expect(await wrong.json()).toMatchObject({code:'elevation_password_rejected',execution:'not_started'});
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='management'").n).toBe(before);expect(forwarded).toEqual([]);
    const accepted=await elevate(definition),manager=accepted.task;expect(accepted.instruction).toBe(definition.instruction);
    expect(forwarded[0].method).toBe(PROJECT_ELEVATION_RPC.submit);expect(JSON.stringify(forwarded)).not.toContain(password);
    const proof=structuredClone(forwarded[0].params.proof);proof.request.definition.instruction+='edited';
    await expect(dispatcher.dispatch(PROJECT_ELEVATION_RPC.submit,{proof})).rejects.toThrow();
    const receipt=await fetch(base+'/api/management/elevation-receipt?client_request_id=native-high-1');
    expect(await receipt.json()).toMatchObject({found:true,definition,task:{id:manager.id},instruction:definition.instruction});
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='management.elevation_accepted'").n).toBe(1);
    const rename=tool('project.call',{method:'worker.rename',params:{id:target.id,title:'native elevated title'}});
    const sourcePlan=[
      tool('project.call',{method:'order.submit',params:{content:'native Valet order source'}}),
      tool('project.call',{method:'input.emit',params:{content:'native Valet emission source'}}),
      tool('project.call',{method:'worker.message',params:{id:target.id,body:'native Valet follow-up source'}}),
      tool('project.call',{method:'worker.spawn',params:{parent:target.id,goal:'native Valet delegated source'}}),
      tool('project.call',{method:'input.emit',params:{content:'not a first user input',mode:'append',target_id:empty.id}}),
    ];
    await pump([tool('catalog',{}),rename,rename,tool('source.read',{path:'src/app.js'}),tool('project.call',{method:'worker.inspect',params:{id:target.id}}),
      tool('project.call',{method:'system.configure',params:{settings:{}}}),tool('project.call',{method:'agent.config',params:{}}),
      tool('source.read',{project:'/different/project',path:'src/app.js'}),tool('project.call',{method:'notice.post',params:{title:'new instruction?',body:'must reject',kind:'question'}}),
      tool('project.call',{method:'hooks.register',params:forbiddenRegistration}),
      tool('project.call',{method:'worker.hook_attach',params:{id:target.id,hook:{template_id:registered.template_id,template_version:registered.template_version},expected_revision:mounted.revision}}),
      tool('project.call',{method:'worker.hook_update',params:{id:target.id,hook_id:shellMount.id,enabled:true,expected_revision:mounted.revision}}),
      tool('project.call',{method:'input.emit',params:{content:'spoofed user',input_source:{kind:'user'}}}),
      tool('project.call',{method:'worker.auto_merge',params:{id:target.id,enabled:false}}),...sourcePlan]);
    const high=JSON.parse(f.store.task(manager.id).result);
    expect(high.registered).toEqual(['administrator']);expect(high.cliActive).toEqual(['administrator']);expect(high.modelActive).toEqual(['administrator']);expect(high.blocked.every(Boolean)).toBe(true);
    expect(high.startup.management.instruction).toBe(definition.instruction);expect(JSON.stringify(high)).not.toContain(password);expect(JSON.stringify(high)).not.toContain(forwarded[0].params.proof.signature);
    expect(JSON.stringify(f.store.all('SELECT data FROM events'))).not.toContain(password);
    expect(high.replies.slice(0,5).every(item=>!item.error)).toBe(true);
    expect(high.replies.slice(5,-sourcePlan.length-1).every(item=>item.error)).toBe(true);
    expect(high.replies.at(-sourcePlan.length-1).response.details.status).toBe('succeeded');
    const sourceReplies=high.replies.slice(-sourcePlan.length);
    expect(sourceReplies.every(item=>!item.error&&item.response.details.status==='succeeded')).toBe(true);
    const source={kind:'valet',worker_id:manager.id,worker_number:manager.worker_number};
    for(const reply of sourceReplies.slice(0,2)){
      const draftId=reply.response.details.result.draft_id;
      await until(()=>f.project.inputEmissionResult(draftId).dispatch.state==='succeeded');
      const created=f.project.inputEmissionResult(draftId).dispatch;
      expect((await dispatcher.dispatch('worker.inspect',{id:created.worker_id})).goal_input_source).toEqual(source);
      const reading=await dispatcher.dispatch('worker.reading_page',{id:created.worker_id});
      expect(reading.events.find(event=>event.type==='input.anchor').input_source).toEqual(source);
      f.store.update(created.worker_id,{status:'paused'}); // No development model call in this management-only fixture.
    }
    const reading=await dispatcher.dispatch('worker.reading_page',{id:target.id});
    expect(reading.messages.find(message=>message.body==='native Valet follow-up source')).toMatchObject({input_source:source,append_number:null});
    const spawned=sourceReplies[3].response.details.result.id;
    expect((await dispatcher.dispatch('worker.inspect',{id:spawned})).goal_input_source).toEqual(source);
    f.store.update(spawned,{status:'paused'});
    const emptyDraft=sourceReplies.at(-1).response.details.result.draft_id;
    await until(()=>f.project.inputEmissionResult(emptyDraft).dispatch.state==='failed');
    expect(f.store.task(empty.id)).toMatchObject({input_id:null,goal:'',status:'paused'});
    expect(['hooks.register','hooks.save','hooks.command_save','hooks.command_import','hooks.command_remove','worker.hook_attach','worker.hook_update','worker.hook_remove'].some(method=>projectAdministratorMethods().includes(method))).toBe(false);
    expect(f.project.hooksList().registry.revision).toBe(registryRevision);expect(f.project.shortcutCommands().revision).toBe(commandsRevision);
    expect(f.project.taskHooks(target.id).mounts.find(item=>item.id===shellMount.id).enabled).toBe(false);expect(fs.existsSync(marker)).toBe(false);
    expect(high.replies[1].response.details.receipt_id).toBe(high.replies[2].response.details.receipt_id);
    expect(high.replies[1].response.details).toMatchObject({status:'succeeded',effect:'applied'});
    expect(high.replies[3].response.details.result.content).toContain('answer = 42');
    expect(JSON.stringify(high)).not.toContain('PRIVATE-SOURCE-CANARY');
    expect(high.replies[4].response.details.result.coverage).not.toBe('worker_metadata_only');
    expect(f.store.task(target.id).display_title).toBe('native elevated title');expect(f.store.get("SELECT count(*) AS n FROM notices WHERE kind IN ('question','questionnaire')").n).toBe(0);
    const calls=managementState(f.store.task(manager.id)).last_execution.control_calls;
    expect(calls.every(call=>call.authorization_mode==='project_administrator'&&call.source_event_id>0)).toBe(true);
    expect(f.store.get("SELECT id FROM events WHERE task_id=? AND type='management.capability_completed'",manager.id)).toBeTruthy();
    const highSession=high.argv[high.argv.indexOf('--session-id')+1];expect(highSession).toContain('-administrator-');
    f.store.update(manager.id,{result:'HIGH-RESULT-CANARY',error:'HIGH-ERROR-CANARY'});
    await dispatcher.dispatch('worker.message',{id:manager.id,body:'normal next instruction'});
    await pump([{name:'lush_cli',params:{argv:['help','worker','show']}}]);
    const normal=JSON.parse(f.store.task(manager.id).result);
    expect(normal.registered).toEqual(['lush_cli']);expect(ordinaryRejected&&ordinaryPathBlocked).toBe(true);
    expect(JSON.stringify(normal.startup)).not.toContain('HIGH-RESULT-CANARY');expect(JSON.stringify(normal.startup)).not.toContain('HIGH-ERROR-CANARY');expect(JSON.stringify(normal.startup)).not.toContain('PRIOR-HIGH-GOAL-CANARY');
    expect(normal.startup.task.goal).toBe('normal next instruction');expect(normal.startup.management.management).toBeUndefined();expect(normal.startup.messages).toEqual([]);
    const normalSession=normal.argv[normal.argv.indexOf('--session-id')+1];expect(normalSession).not.toBe(highSession);expect(normalSession).toContain('-ordinary-');
    const highInput=high.argv.find(arg=>arg.startsWith('@')).slice(1),normalInput=normal.argv.find(arg=>arg.startsWith('@')).slice(1);
    const highSystem=high.argv[high.argv.indexOf('--system-prompt')+1],normalSystem=normal.argv[normal.argv.indexOf('--system-prompt')+1];
    expect(normalInput).not.toBe(highInput);expect(normalSystem).not.toBe(highSystem);
    expect(fs.readFileSync(normalInput,'utf8')).not.toContain('PRIOR-HIGH-GOAL-CANARY');
    expect(workerFiles(f.config,[f.store.task(manager.id)],[])).toEqual(expect.arrayContaining([highInput,normalInput,highSystem,normalSystem]));
    const nativeFile=`2026-01-01T00-00-00Z_${highSession}.jsonl`;fs.writeFileSync(path.join(f.config.home,'sessions',nativeFile),'');
    expect(sessionFiles(f.config,manager.id)).toContain(nativeFile);expect(workerFiles(f.config,[f.store.task(manager.id)],[])).toContain(path.join(f.config.home,'sessions',nativeFile));
    // Actual async control ownership persists until the handler completes; explicit unknown never becomes ready/success.
    let effects=0;const renameTask=f.project.renameTask.bind(f.project);
    f.project.renameTask=(id,title)=>{if(title==='unknown write'){effects++;renameTask(id,title);return Promise.resolve().then(()=>{
      expect(f.project.managementControlOwners.has(manager.id)).toBe(true);expect(f.project.managementControlBusy.size).toBeGreaterThan(0);
      return{status:'unknown',effect:'unknown',original_failure:'safe original failure'};
    });}return renameTask(id,title);};
    const peer=(await f.project.order('merge dependency peer','main',[],null,false)).task;
    f.project.scheduleMergeConditions=()=>{};
    f.project.mergeTaskAfter(peer.id,[{kind:'worker_merged',worker_id:target.id}],f.project.taskMergeConditions(peer.id).revision);
    const revision=f.project.taskMergeConditions(target.id).revision;
    const cycle=tool('project.call',{method:'worker.merge_after',params:{id:target.id,conditions:[{kind:'worker_merged',worker_id:peer.id}],expected_revision:revision}});
    const mergeAfter=f.project.mergeTaskAfter.bind(f.project);
    f.project.mergeTaskAfter=(id,conditions,revision)=>{
      if(conditions[0]?.kind==='worker_settled')throw Object.assign(new Error('merge conditions create a cycle or parent/child closure deadlock'),{code:-32602});
      return mergeAfter(id,conditions,revision);
    };
    const forgedCycle=tool('project.call',{method:'worker.merge_after',params:{id:target.id,conditions:[{kind:'worker_settled',worker_id:peer.id}],expected_revision:revision}});
    const append={kind:'append',mode:'administrator',scope:'current_project',client_request_id:'native-high-2',id:manager.id,instruction:'new explicit high instruction'};
    const wrongAppend=await post(append,'incorrect-again');expect(wrongAppend.status).toBe(403);expect(managementState(f.store.task(manager.id)).pending_signal).toBeNull();
    expect((await elevate(append)).instruction).toBe(append.instruction);
    const unknown=tool('project.call',{method:'worker.rename',params:{id:target.id,title:'unknown write'}});
    await pump([cycle,forgedCycle,unknown,unknown]);
    const failed=JSON.parse(f.store.task(manager.id).result),rejected=failed.replies[0].response.details;
    expect(rejected).toMatchObject({status:'failed',effect:'not_started',diagnostic:{code:'merge_dependency_cycle',stage:'execution',
      evidence:'trusted_pre_effect_rejection',original_failure:{code:'merge_dependency_cycle',effect:'not_started'},retry:'not_automatic'}});
    expect(f.project.taskMergeConditions(target.id)).toMatchObject({state:'idle',revision});expect(f.store.task(target.id).reservation).toBeNull();
    expect(f.store.get("SELECT id FROM events WHERE task_id=? AND type='management.capability_completed' AND json_extract(data,'$.receipt_id')=?",manager.id,rejected.receipt_id)).toBeNull();
    expect(failed.replies[1].response.details).toMatchObject({status:'unknown',effect:'unknown',diagnostic:{code:'execution_failed',effect:'unknown'}});
    expect(failed.replies[2].response.details.status).toBe('unknown');expect(failed.replies[3].response.details.status).toBe('unknown');expect(effects).toBe(1);
    const failedState=managementState(f.store.task(manager.id)),failedCalls=failedState.last_execution?.control_calls??failedState.control_calls;
    expect(failedCalls.find(call=>call.method==='worker.rename').result.original_failure).toBe('safe original failure');
    expect(f.project.inspect(manager.id).management.first_failure.detail).toContain('merge conditions create a cycle');
    expect(f.project.managementControlJobs.size).toBe(0);expect(f.project.managementControlBusy.size).toBe(0);
  }finally{await web.stop(true);await rpc.close();await f.close();}
});
