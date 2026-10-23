import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { temp, env, until, gate } from './helpers.js';
import { startTestWeb, fetch, rawFetch } from './web/auth-fixture.js';
import { DeviceSettingsService } from '../src/host/device-settings.js';
import { DeviceValetService } from '../src/device-valet/service.js';
import { DeviceValetClient } from '../src/device-valet/client.js';
import { createDeviceValetRunner } from '../src/device-valet/runner.js';
import { deviceValetHome } from '../src/device-valet/paths.js';
import { DEVICE_VALET_API, DEVICE_VALET_MODE, DEVICE_VALET_SCOPE, DEVICE_VALET_METHODS } from '../src/device-valet/protocol.js';

// New device execution has no existing normal-flow coverage (legacy ADM is retired).
// Keep one representative real password/Provider/bridge/resource/receipt lifecycle.
function controlledPi(root){
  const command=path.join(root,'controlled-pi'),planFile=path.join(root,'device-plan.json');
  fs.writeFileSync(command,`#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(2),plan=JSON.parse(fs.readFileSync(${JSON.stringify(planFile)},'utf8'));
const input=JSON.parse(fs.readFileSync(args.find(a=>a.startsWith('@')).slice(1),'utf8'));
const builtins=['read','bash','write','edit','mcp__shell__exec'],tools=new Map(builtins.map(name=>[name,{name}])),handlers=new Map();let active=[...builtins];
const pi={registerTool(t){tools.set(t.name,t);},on(name,fn){const a=handlers.get(name)||[];a.push(fn);handlers.set(name,a);},setActiveTools(names){active=names.filter(n=>tools.has(n));}};
const emit=async(name,event={})=>Promise.all((handlers.get(name)||[]).map(fn=>fn(event,{})));
for(let i=0;i<args.length;i++)if(args[i]==='--extension')(await import(args[i+1])).default(pi);
const registered=[...tools.keys()].filter(n=>!builtins.includes(n));pi.setActiveTools(args[args.indexOf('--tools')+1].split(','));const cliActive=[...active];await emit('session_start');const sessionActive=[...active];pi.setActiveTools([...active,...builtins]);await emit('before_agent_start');const modelActive=[...active];
const blocked=[];for(const toolName of builtins)blocked.push((await emit('tool_call',{toolName})).some(x=>x?.block));
const replies=[];for(const [index,params] of plan.entries()){try{const response=await tools.get('device_valet').execute('call-'+index,params,new AbortController().signal);replies.push({details:response.details,textMatches:response.content[0].text===JSON.stringify(response.details)});}catch(error){replies.push({error:error.message});}}
console.log(JSON.stringify({registered,cliActive,sessionActive,modelActive,blocked,replies,input,session:args[args.indexOf('--session-id')+1],projectEnvironment:!!process.env.LUSH_PROJECT,ambientSecret:!!process.env.FIXTURE_SECRET,tokenInInput:JSON.stringify(input).includes(process.env.LUSH_DEVICE_VALET_TOKEN)}));
`,{mode:0o755});
  return {command,plan:value=>fs.writeFileSync(planFile,JSON.stringify(value),{mode:0o600})};
}
const call=(method,params={})=>({operation:'call',method,params});

test('device password entrance -> isolated Provider/tool bridge -> real shared resources, one-shot append, unknown receipts and true stop ownership',async()=>{
  const root=temp(),cli=controlledPi(root),environment=env({LUSH_GLOBAL_CONFIG:root,LUSH_PI_COMMAND:cli.command,FIXTURE_SECRET:'AMBIENT-SECRET-CANARY'}),settings=new DeviceSettingsService(environment);
  const privateKey='PRIVATE-FIXTURE-KEY-DEVICE',password='synthetic-test-only-password';
  const source=await settings.request('agent.connections.save',{connection:{label:'Device original',provider:'deepseek',auth_type:'api_key',models:['deepseek-chat']},credential:{api_key:privateKey}});
  const profile={agent:'pi',config_mode:'lush',connection_id:source.id,model:'deepseek/deepseek-chat',thinking:'high'};
  await settings.request('agent.configure',{config:{version:1,default:{...profile,append_prompt:'DEVICE-PRIVATE-PROMPT-CANARY',env:{ONLY_SECRET:'DEVICE-PRIVATE-ENV-CANARY'},extensions:['/tmp/do-not-load-device-extension.js']},roles:{}}});
  const started=gate(),release=gate(),counts=new Map(),tokens=[];let service,startCount=0,slow=false,fault=false;
  const factory=()=>{
    const instance=new DeviceSettingsService(environment),request=instance.request.bind(instance);
    instance.request=async(method,params)=>{
      counts.set(method,(counts.get(method)||0)+1);
      if(slow&&method==='agent.registered_models.save'){started.resolve();await release.promise;}
      const value=await request(method,params);
      if(fault&&method==='agent.registered_models.save')throw Error('WRITE-AFTER-SUCCESS-PRIVATE-CANARY');
      return value;
    };return instance;
  };
  const runner=createDeviceValetRunner({env:environment,home:deviceValetHome(environment)});
  const client=new DeviceValetClient({env:environment,startService:async()=>{
    startCount++;service=new DeviceValetService({env:environment,settingsFactory:factory,runner:options=>{tokens.push(options.token);return runner(options);}});await service.start();
  }});
  const web=startTestWeb(null,0,{env:environment,openProject:async()=>{throw Error('device flow must not attach projects');},deviceValetOptions:{client,settingsService:settings}}),base=`http://127.0.0.1:${web.port}`;
  const definition=(instruction,rest={})=>({kind:'create',mode:DEVICE_VALET_MODE,scope:DEVICE_VALET_SCOPE,instruction,client_request_id:randomUUID(),profile,...rest});
  const post=(path,body,headers={})=>fetch(base+DEVICE_VALET_API+'/'+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const send=(value,secret=password)=>post('submit',{definition:value,password:secret,confirm:true});
  const settled=async(id)=>{await until(()=>service&&!service.owners.has(id)&&!['queued','running','stopping'].includes(service.store.worker(id).status),10000);return service.workerView(service.store.worker(id));};
  try{
    const offline=await (await fetch(base+DEVICE_VALET_API+'/list')).json();expect(offline).toMatchObject({online:false,coverage:'device_valet_offline_history_unread'});expect(startCount).toBe(0);expect(fs.existsSync(deviceValetHome(environment))).toBe(false);
    const options=await (await fetch(base+DEVICE_VALET_API+'/options')).json();expect(options.default_profile).toEqual(profile);expect(options.connections[0].id).toBe(source.id);expect(options.truncated).not.toBe(true);expect(options.coverage).toBeUndefined();expect(JSON.stringify(options)).not.toContain(privateKey);expect(startCount).toBe(0);
    const first=definition('Read sources and update their public label');
    expect((await send(first,'wrong-password')).status).toBe(403);expect(startCount).toBe(0);
    expect((await post('submit',{definition:first,password,confirm:true},{'x-lush-agent-token':'forged-project-token'})).status).toBe(400);expect(startCount).toBe(0);
    const anonymous=await rawFetch(base+DEVICE_VALET_API+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({definition:first,password,confirm:true})});expect(anonymous.status).toBe(401);expect(await anonymous.json()).toMatchObject({execution:'not_started'});
    expect((await post('submit',{definition:first,password,confirm:true},{Origin:'https://untrusted.invalid'})).status).toBe(403);expect(startCount).toBe(0);
    expect((await fetch(base+'/p/0000000000000000'+DEVICE_VALET_API+'/options')).status).toBe(404);
    const metadata={id:source.id,label:'Device updated',provider:'deepseek',auth_type:'api_key',models:['deepseek-chat']};
    cli.plan([{operation:'catalog'},call('agent.connections.list'),call('agent.connections.save',{connection:metadata}),call('agent.connections.save',{connection:{models:['deepseek-chat'],auth_type:'api_key',provider:'deepseek',label:'Device updated',id:source.id}}),call('agent.connections.list'),call('agent.config'),call('agent.connections.save',{connection:{...metadata,credential:{api_key:'forbidden'}}})]);
    const accepted=await send(first);expect(accepted.status).toBe(200);const receipt=await accepted.json();expect(receipt).toMatchObject({version:1,found:true,definition:first});expect(startCount).toBe(1);
    const result=await settled(receipt.worker.id);expect(result.status).toBe('succeeded');const output=JSON.parse(result.result);
    for(const key of ['registered','cliActive','sessionActive','modelActive'])expect(output[key]).toEqual(['device_valet']);expect(output.blocked.every(Boolean)).toBe(true);expect(output.projectEnvironment||output.ambientSecret||output.tokenInInput).toBe(false);
    expect(output.replies[0].details.methods.map(m=>m.method)).toEqual([...DEVICE_VALET_METHODS]);expect(output.replies[0].details.methods.find(m=>m.method==='agent.connections.save').parameters).not.toContain('credential');
    expect(output.replies[2].details).toMatchObject({status:'succeeded',effect:'completed'});expect(output.replies[3].details.receipt_id).toBe(output.replies[2].details.receipt_id);expect(counts.get('agent.connections.save')).toBe(1);expect(output.replies[4].details.result.connections[0].label).toBe('Device updated');expect(output.replies[5].error).toBeTruthy();expect(output.replies[6].error).toBeTruthy();
    expect(settings.getManager().config().connections[0].label).toBe('Device updated');expect(service.store.all('SELECT token_hash FROM agent_runs').every(row=>row.token_hash===null)).toBe(true);
    expect(()=>service.authenticate(tokens[0])).toThrow('not active');
    await expect(service.dispatch('device_valet.submit',{control:tokens[0],user_binding:'f'.repeat(64),definition:first})).rejects.toThrow('被拒绝');
    const duplicate=await (await send(first)).json();expect(duplicate.worker.id).toBe(receipt.worker.id);expect(service.store.get('SELECT count(*) AS n FROM workers').n).toBe(1);
    for(const changed of [{...first,instruction:'different'},{...first,profile:{...profile,thinking:'low'}},{...first,profile:{...profile,model:'deepseek/not-allowed'}}])expect((await send(changed)).status).toBe(400);
    const append=definition('New independent instruction',{kind:'append',id:result.id,expected_revision:result.revision});
    expect((await send(append,'')).status).toBe(403);expect(service.store.get('SELECT count(*) AS n FROM messages').n).toBe(1);
    cli.plan([{operation:'catalog'},call('agent.registered_models.list')]);const appended=await (await send(append)).json();expect(appended.worker.id).toBe(result.id);const afterAppend=await settled(result.id);expect(afterAppend.status).toBe('succeeded');const secondOutput=JSON.parse(afterAppend.result);expect(secondOutput.session).not.toBe(output.session);expect(JSON.stringify(secondOutput.input)).not.toContain('Device original');expect(tokens[1]).not.toBe(tokens[0]);
    expect((await send({...append,id:randomUUID()})).status).toBe(400);
    expect((await send(definition('bad physical model',{profile:{...profile,model:'deepseek/out-of-scope'}}))).status).toBe(400);
    fault=true;const unknown=definition('Record a write whose completion handler fails');const model={name:'device fixture registered',connection_id:source.id,model:profile.model};
    cli.plan([call('agent.registered_models.save',{model}),call('agent.registered_models.save',{model})]);const unknownReceipt=await (await send(unknown)).json();const unknownResult=await settled(unknownReceipt.worker.id);expect(unknownResult.status).toBe('unknown');const unknownOutput=JSON.parse(unknownResult.result);expect(unknownOutput.replies[0].details).toMatchObject({status:'unknown',effect:'unknown'});expect(unknownOutput.replies[1].details.receipt_id).toBe(unknownOutput.replies[0].details.receipt_id);expect(counts.get('agent.registered_models.save')).toBe(1);expect((await settings.request('agent.registered_models.list')).models).toHaveLength(1);
    expect((await send(definition('cannot append unknown',{kind:'append',id:unknownResult.id,expected_revision:unknownResult.revision}))).status).toBe(400);fault=false;
    slow=true;cli.plan([call('agent.registered_models.save',{model:{...model,name:'slow fixture registered'}})]);const stopReceipt=await (await send(definition('Stop while a resource handler owns execution'))).json();await started.promise;
    const stop=await (await post('stop',{id:stopReceipt.worker.id})).json();expect(stop.worker.status).toBe('stopping');expect(service.owners.has(stopReceipt.worker.id)).toBe(true);await until(()=>service.owners.get(stopReceipt.worker.id)?.providerReturned);expect(service.workerView(service.store.worker(stopReceipt.worker.id)).status).toBe('stopping');release.resolve();const stopped=await settled(stopReceipt.worker.id);expect(['unknown','stopped']).toContain(stopped.status);expect(stopped.running).toBe(false);
    const query=await (await fetch(base+DEVICE_VALET_API+'/receipt?client_request_id='+unknown.client_request_id)).json();expect(query).toMatchObject({found:true,definition:unknown});
    const listing=await (await fetch(base+DEVICE_VALET_API+'/list?limit=1')).json();expect(listing.items).toHaveLength(1);expect(listing.has_more).toBe(true);const older=await (await fetch(base+DEVICE_VALET_API+'/list?limit=1&before='+listing.next_cursor)).json();expect(older.items[0].id).not.toBe(listing.items[0].id);
    const detail=await (await fetch(base+DEVICE_VALET_API+'/detail?id='+result.id+'&limit=1')).json();expect(detail.events).toHaveLength(1);expect(detail.has_more).toBe(true);expect(detail.history_complete).toBe(false);
    const events=JSON.stringify(service.store.all('SELECT * FROM events')),messages=JSON.stringify(service.store.all('SELECT * FROM messages'));for(const secret of [privateKey,password,'DEVICE-PRIVATE-PROMPT-CANARY','DEVICE-PRIVATE-ENV-CANARY','WRITE-AFTER-SUCCESS-PRIVATE-CANARY',tokens[0]]){expect(events).not.toContain(secret);expect(messages).not.toContain(secret);}
    const stored=service.store.get('SELECT count(*) AS n FROM messages').n;await service.close();service=new DeviceValetService({env:environment,settingsFactory:factory,runner});await service.start();expect(service.owners.size).toBe(0);expect(service.store.get('SELECT count(*) AS n FROM messages').n).toBe(stored);expect(service.store.worker(unknownResult.id).status).toBe('unknown');expect(counts.get('agent.registered_models.save')).toBe(2);
  }finally{release.resolve();await service?.close();await web.stop(true);await settings.stop();fs.rmSync(root,{recursive:true,force:true});}
});
