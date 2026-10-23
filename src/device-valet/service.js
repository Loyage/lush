import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { check, LushError } from '../core/types.js';
import { DaemonLock } from '../daemon/locking.js';
import { RPCServer } from '../rpc/server.js';
import { PARAMS } from '../rpc/registry.js';
import { DeviceSettingsService } from '../host/device-settings.js';
import { DeviceValetStore } from './store.js';
import { deviceValetHome, deviceValetPaths, ensurePrivateDirectory, assertPrivateFile, readControlSecret, sameSecret, digest, writePrivateJSON } from './paths.js';
import { DEVICE_VALET_SCOPE, DEVICE_VALET_MODE, DEVICE_VALET_RPC, DEVICE_VALET_METHODS, DEVICE_VALET_READ_METHODS, DEVICE_VALET_LIMITS, normalizeDeviceValetDefinition, normalizeDeviceValetProfile, deviceValetIdentifier } from './protocol.js';
import { canonical, encoded, strictFields, userBinding, validateResourceCall, safeResult, safeText, SAFE_FAILURE } from './safety.js';

function page(value={},detail=false) {
  strictFields(value,detail?['id','before','limit']:['before','limit'],detail?['id']:[]);
  const limit=value.limit??DEVICE_VALET_LIMITS.page,before=value.before??null;
  check(Number.isSafeInteger(limit)&&limit>=1&&limit<=DEVICE_VALET_LIMITS.maxPage,'device Valet limit must be 1..100');
  check(before===null||typeof before==='string'&&/^[1-9]\d*$/.test(before)&&Number.isSafeInteger(Number(before)),'invalid device Valet cursor');
  if(detail) check(deviceValetIdentifier(value.id),'device Valet identity required');
  return {...value,before,limit};
}
const parse=value=>value===null||value===undefined?null:JSON.parse(value);

/** Owns device-only Workers and invocation owners. Host never owns or schedules these facts. */
export class DeviceValetService {
  constructor({env=process.env,home=deviceValetHome(env),runner,settingsFactory=()=>new DeviceSettingsService(env),clock=Date.now}={}) {
    this.env=env;this.paths=deviceValetPaths(home);this.clock=clock;this.runner=runner;this.settingsFactory=settingsFactory;
    this.owners=new Map();this.closed=false;this.closing=null;this.server=null;
    ensurePrivateDirectory(this.paths.home);ensurePrivateDirectory(this.paths.socketDir);assertPrivateFile(`${this.paths.home}/daemon.lock`,{missing:true});
    this.lock=new DaemonLock(this.paths.home);this.lock.acquire();
    try { this.control=readControlSecret(this.paths,true);this.store=new DeviceValetStore(this.paths.database);this.settings=settingsFactory();this.recover(); }
    catch(error) {this.store?.close();this.lock.release();throw error;}
  }
  now(){return new Date(this.clock()).toISOString();}
  event(w,i,type,data={}){return this.store.event(w,i,type,data,this.now());}
  recover(){
    this.store.transaction(()=>{
      for(const call of this.store.all("SELECT * FROM tool_calls WHERE status='running'")) {
        const effect=DEVICE_VALET_READ_METHODS.includes(call.method)?'not_applicable':'unknown';
        this.store.run("UPDATE tool_calls SET status='unknown',effect=?,error=?,finished_at=? WHERE id=?",effect,SAFE_FAILURE,this.now(),call.id);
        this.event(call.worker_id,call.instruction_id,'tool.recovery_unknown',{call_id:call.id,method:call.method,effect});
      }
      for(const input of this.store.all("SELECT * FROM messages WHERE status IN ('queued','running')")) {
        const unstarted=input.status==='queued',status=unstarted?'cancelled':'unknown',effect=unstarted?'not_started':'unknown';
        this.store.run('UPDATE messages SET status=?,effect=?,error=?,finished_at=? WHERE id=?',status,effect,SAFE_FAILURE,this.now(),input.id);
        this.store.run('UPDATE workers SET status=?,error=?,updated_at=?,revision=revision+1 WHERE id=?',status,SAFE_FAILURE,this.now(),input.worker_id);
        this.event(input.worker_id,input.id,'instruction.recovery',{status,effect,replayed:false});
      }
      this.store.run("UPDATE agent_runs SET status='unknown',token_hash=NULL,finished_at=?,error=? WHERE status='running'",this.now(),SAFE_FAILURE);
      this.store.run("UPDATE workers SET status='stopped',updated_at=? WHERE status='stopping'",this.now());
    });
  }
  validateProfile(value){
    const profile=normalizeDeviceValetProfile(value),source=this.settings.getManager().config().connections.find(row=>row.id===profile.connection_id);
    check(source?.enabled&&source.credential?.status!=='unconfigured','device Valet model source unavailable');
    const prefix=`${source.provider}/`;check(profile.model.startsWith(prefix)&&profile.model.length>prefix.length,'device Valet model/source mismatch');
    check(!source.models.length||source.models.includes(profile.model.slice(prefix.length)),'device Valet model outside source scope');
    return profile;
  }
  hasUnresolved(workerId){return Boolean(this.store.get("SELECT id FROM tool_calls WHERE worker_id=? AND effect='unknown' LIMIT 1",workerId));}
  workerView(row){
    const active=this.owners.has(row.id),blocked=this.hasUnresolved(row.id);
    const canAppend=!this.closing&&!active&&row.status==='succeeded'&&!row.stopped_at&&!blocked;
    const storedResult=parse(row.result),resultTruncated=typeof storedResult==='string'&&storedResult.length>16000;
    return {id:row.id,worker_number:row.worker_number,task_kind:DEVICE_VALET_MODE,role:DEVICE_VALET_MODE,mode:DEVICE_VALET_MODE,scope:DEVICE_VALET_SCOPE,
      name:this.store.get('SELECT instruction FROM messages WHERE worker_id=? ORDER BY rowid LIMIT 1',row.id)?.instruction.slice(0,80)??'设备管家',
      status:row.status,revision:row.revision,model_selection:parse(row.profile),created_at:row.created_at,updated_at:row.updated_at,
      result:resultTruncated?storedResult.slice(0,16000):storedResult,result_truncated:resultTruncated,error:row.error,running:active,can_append:canAppend,append_reason:canAppend?null:active?'上一条指令或操作尚未实际退出。':blocked?'存在未知副作用，不能追加或重放。':'仅正常成功收口的设备管家可追加；每条均需重新验证 Web 密码。',
      can_stop:active,stopped_at:row.stopped_at};
  }
  instructionView(row){return {id:row.id,worker_id:row.worker_id,instruction:row.instruction,profile:parse(row.profile),status:row.status,effect:row.effect,
    created_at:row.created_at,started_at:row.started_at,finished_at:row.finished_at,result:parse(row.result),error:row.error};}
  submissionReceipt(input){return {version:1,found:true,definition:parse(input.definition),worker:this.workerView(this.store.worker(input.worker_id)),instruction:this.instructionView(input)};}
  status(){return {version:1,online:true,active:this.owners.size,scope:DEVICE_VALET_SCOPE,service_id:this.store.serviceId,stopping:Boolean(this.closing)};}
  list(options={}){
    const {before,limit}=page(options),rows=this.store.all(`SELECT rowid AS cursor,* FROM workers ${before?'WHERE rowid<?':''} ORDER BY rowid DESC LIMIT ?`,...(before?[Number(before)]:[]),limit+1);
    const items=[];let bytes=0;
    for(const row of rows.slice(0,limit)) { const value=this.workerView(row);delete value.result;const size=Buffer.byteLength(JSON.stringify(value));if(bytes+size>DEVICE_VALET_LIMITS.resultBytes)break;items.push({cursor:row.cursor,value});bytes+=size; }
    return {version:1,online:true,items:items.map(i=>i.value),next_cursor:items.length?String(items.at(-1).cursor):null,has_more:rows.length>items.length,coverage:'device_valet_workers_only'};
  }
  detail(options){
    const {id,before,limit}=page(options,true),worker=this.workerView(this.store.worker(id));
    const rows=this.store.all(`SELECT * FROM events WHERE worker_id=? ${before?'AND id<?':''} ORDER BY id DESC LIMIT ?`,id,...(before?[Number(before)]:[]),limit+1);
    const events=[],instructions=new Map();
    const linkedInput=row=>({...this.instructionView(row),result:null,result_available_on_worker:row.result!==null});
    if(!before){const input=this.store.get('SELECT * FROM messages WHERE worker_id=? ORDER BY rowid DESC LIMIT 1',id);if(input)instructions.set(input.id,linkedInput(input));}
    // The global page consumes the page-level flag as well as worker metadata.
    let truncated=worker.result_truncated;
    for(const row of rows.slice(0,limit)){
      const event={id:row.id,type:row.type,instruction_id:row.instruction_id,created_at:row.created_at,data:parse(row.data)};
      const input=row.type==='instruction.authorized'&&!instructions.has(row.instruction_id)?linkedInput(this.store.instruction(row.instruction_id)):null;
      if(Buffer.byteLength(JSON.stringify({worker,events:[...events,event],instructions:[...instructions.values(),...(input?[input]:[])]}))>DEVICE_VALET_LIMITS.resultBytes){truncated=true;break;}
      if(input)instructions.set(input.id,input);events.push(event);
    }
    return {version:1,worker,instructions:[...instructions.values()],events:events.reverse(),next_cursor:events.length?String(Math.min(...events.map(e=>e.id))):null,
      has_more:rows.length>events.length,truncated,history_complete:false,coverage:'device_valet_event_page_with_linked_instructions'};
  }
  receipt(options,binding){strictFields(options,['client_request_id'],['client_request_id']);userBinding(binding);check(deviceValetIdentifier(options.client_request_id),'device Valet request identity required');
    const input=this.store.get('SELECT * FROM messages WHERE client_request_id=?',options.client_request_id);return input?this.submissionReceipt(input):{version:1,found:false};}
  submit(value,binding){
    userBinding(binding);check(!this.closing&&!this.closed,'device Valet service stopping');
    const definition=normalizeDeviceValetDefinition(value),text=encoded(definition),fingerprint=digest(text);
    const old=this.store.get('SELECT * FROM messages WHERE client_request_id=?',definition.client_request_id);
    if(old){check(old.definition_hash===fingerprint&&old.definition===text,'device Valet request identity refers to a different definition');return this.submissionReceipt(old);}
    this.validateProfile(definition.profile);
    const now=this.now(),inputId=randomUUID();let workerId=definition.id;
    this.store.transaction(()=>{
      if(definition.kind==='create'){
        workerId=randomUUID();this.store.run("INSERT INTO workers(id,worker_number,status,profile,created_at,updated_at) VALUES (?,?,'queued',?,?,?)",workerId,this.store.nextNumber(),encoded(definition.profile),now,now);
      }else{
        const worker=this.store.worker(workerId);check(worker.revision===definition.expected_revision,'device Valet append revision changed');check(this.workerView(worker).can_append,'device Valet cannot accept a new instruction');
        this.store.run("UPDATE workers SET status='queued',revision=revision+1,profile=?,updated_at=?,result=NULL,error=NULL WHERE id=?",encoded(definition.profile),now,workerId);
      }
      this.store.run("INSERT INTO messages(id,worker_id,client_request_id,definition,definition_hash,binding_hash,instruction,profile,status,created_at) VALUES (?,?,?,?,?,?,?,?,'queued',?)",inputId,workerId,definition.client_request_id,text,fingerprint,digest(binding),definition.instruction,encoded(definition.profile),now);
      this.event(workerId,inputId,'instruction.authorized',{definition_hash:fingerprint,profile:definition.profile,scope:DEVICE_VALET_SCOPE,authorization:'web_password',input_kind:definition.kind});
    });
    const result=this.submissionReceipt(this.store.instruction(inputId));queueMicrotask(()=>this.begin(workerId,inputId));return result;
  }
  begin(workerId,inputId){
    if(this.closing||this.closed||this.owners.has(workerId))return;
    const worker=this.store.worker(workerId),input=this.store.instruction(inputId);
    if(worker.status!=='queued'||input.status!=='queued')return;
    const token=randomBytes(32).toString('base64url'),runId=randomUUID(),controller=new AbortController();
    const owner={workerId,inputId,runId,controller,tokenHash:digest(token),jobs:new Set(),settings:this.settingsFactory(),promise:null};
    this.store.transaction(()=>{
      this.store.run("UPDATE messages SET status='running',started_at=? WHERE id=?",this.now(),inputId);
      this.store.run("UPDATE workers SET status='running',updated_at=?,revision=revision+1 WHERE id=?",this.now(),workerId);
      this.store.run("INSERT INTO agent_runs(id,worker_id,instruction_id,status,token_hash,started_at) VALUES (?,?,?,'running',?,?)",runId,workerId,inputId,owner.tokenHash,this.now());
      this.event(workerId,inputId,'invocation.started',{run_id:runId});
    });
    this.owners.set(workerId,owner);
    owner.promise=this.run(owner,token).catch(()=>{/* The durable start is retained if storage completion itself fails. */});
  }
  async run(owner,token){
    let result=null,error=null;
    try{
      check(typeof this.runner==='function','device Valet runner unavailable');
      result=await this.runner({worker:this.workerView(this.store.worker(owner.workerId)),instruction:this.instructionView(this.store.instruction(owner.inputId)),token,socket:this.paths.socket,signal:owner.controller.signal,
        onEvent:event=>{if(event.type==='provider.started')this.event(owner.workerId,owner.inputId,'provider.started',{backend:'pi',model:parse(this.store.instruction(owner.inputId).profile).model});}});
      result=safeText(typeof result==='string'?result:JSON.stringify(result),[token]);
      check(Buffer.byteLength(result)<=DEVICE_VALET_LIMITS.resultBytes,'device Valet output exceeds budget');
    }catch{error=SAFE_FAILURE;}
    finally{
      // Model return/abort is not completion of independent resource-control owners.
      // Reject new tool calls immediately, then await all already admitted handlers.
      owner.providerReturned=true;
      await Promise.allSettled([...owner.jobs]);
      await owner.settings.stop();
      const stopped=owner.controller.signal.aborted,unknown=this.hasUnresolved(owner.workerId),status=unknown?'unknown':stopped?'stopped':error?'failed':'succeeded';
      const effect=unknown?'unknown':error?'unknown':'completed';
      this.store.transaction(()=>{
        this.store.run('UPDATE messages SET status=?,effect=?,result=?,error=?,finished_at=? WHERE id=?',status,effect,result===null?null:JSON.stringify(result),error,this.now(),owner.inputId);
        this.store.run('UPDATE workers SET status=?,result=?,error=?,updated_at=?,revision=revision+1 WHERE id=?',status,result===null?null:JSON.stringify(result),error,this.now(),owner.workerId);
        this.store.run('UPDATE agent_runs SET status=?,token_hash=NULL,error=?,finished_at=? WHERE id=?',status,error,this.now(),owner.runId);
        this.event(owner.workerId,owner.inputId,'invocation.finished',{run_id:owner.runId,status,effect});
      });
      this.owners.delete(owner.workerId);
    }
  }
  authenticate(token){
    check(typeof token==='string'&&token.length>=32,'device Valet invocation required');
    const hash=digest(token),run=this.store.get("SELECT * FROM agent_runs WHERE token_hash=? AND status='running'",hash);
    const owner=run&&this.owners.get(run.worker_id),input=run&&this.store.instruction(run.instruction_id);
    check(owner&&owner.runId===run.id&&!owner.providerReturned&&!owner.controller.signal.aborted&&owner.tokenHash===hash&&input.status==='running'&&this.store.worker(run.worker_id).status==='running','device Valet invocation is not active');
    const definition=normalizeDeviceValetDefinition(parse(input.definition));
    check(input.definition_hash===digest(encoded(definition))&&definition.instruction===input.instruction&&encoded(definition.profile)===input.profile&&definition.scope===DEVICE_VALET_SCOPE&&/^[a-f0-9]{64}$/.test(input.binding_hash),'device Valet instruction authorization mismatch');
    return owner;
  }
  catalog(token){this.authenticate(token);return {version:1,scope:DEVICE_VALET_SCOPE,methods:DEVICE_VALET_METHODS.map(method=>({method,access:DEVICE_VALET_READ_METHODS.includes(method)?'read':'write',parameters:PARAMS[method].filter(key=>key!=='credential')})),limitations:['No credentials, private configuration, prompts, environment or executable resources','No project, Host, Shell or new authorization entrance','Network refreshes are writes; unknown effects are not replayed']};}
  call(token,value){
    const owner=this.authenticate(token),tool=validateResourceCall(value);
    if(tool.operation==='catalog')return Promise.resolve(this.catalog(token));
    const write=!DEVICE_VALET_READ_METHODS.includes(tool.method),params=canonical({...tool.params,...(PARAMS[tool.method].includes('scope')?{scope:'device'}:{})});
    const fingerprint=digest(encoded({method:tool.method,params})),key=write?fingerprint:`${fingerprint}:${randomUUID()}`;
    const previous=write&&this.store.get('SELECT * FROM tool_calls WHERE instruction_id=? AND request_key=?',owner.inputId,key);
    if(previous)return Promise.resolve(this.callView(previous));
    // Admission is synchronous: no second request can pass between durable start and owner publication.
    this.authenticate(token);validateResourceCall({operation:'call',method:tool.method,params});
    check(this.store.get('SELECT count(*) AS n FROM tool_calls WHERE instruction_id=?',owner.inputId).n<100,'device Valet per-instruction tool budget reached');
    const callId=Number(this.store.run("INSERT INTO tool_calls(worker_id,instruction_id,run_id,request_key,method,params,status,effect,created_at) VALUES (?,?,?,?,?,?,'running',?,?)",owner.workerId,owner.inputId,owner.runId,key,tool.method,encoded(params),write?'unknown':'not_applicable',this.now()).lastInsertRowid);
    this.event(owner.workerId,owner.inputId,'tool.started',{call_id:callId,method:tool.method,access:write?'write':'read'});
    const job=this.execute(owner,callId,tool.method,params,write);owner.jobs.add(job);job.finally(()=>owner.jobs.delete(job)).catch(()=>{});return job;
  }
  callView(row){return {version:1,receipt_id:row.id,method:row.method,status:row.status,effect:row.effect,...(row.result!==null?{result:parse(row.result)}:{}),...(row.error?{error:row.error}:{})};}
  async execute(owner,callId,method,params,write){
    try{
      const raw=await owner.settings.request(method,params),limits={},result=safeResult(raw,limits);
      check(Buffer.byteLength(JSON.stringify(result))<=100000,'device Valet result exceeds safe limit');
      const wrapped=limits.truncated?{result,truncated:true,coverage:'bounded_device_resource_projection'}:result;
      this.store.transaction(()=>{
        this.store.run("UPDATE tool_calls SET status='succeeded',effect=?,result=?,finished_at=? WHERE id=?",write?'completed':'not_applicable',JSON.stringify(wrapped),this.now(),callId);
        this.event(owner.workerId,owner.inputId,'tool.finished',{call_id:callId,method,status:'succeeded',effect:write?'completed':'not_applicable'});
      });
    }catch{
      this.store.transaction(()=>{
        this.store.run('UPDATE tool_calls SET status=?,effect=?,error=?,finished_at=? WHERE id=?',write?'unknown':'failed',write?'unknown':'not_applicable',SAFE_FAILURE,this.now(),callId);
        this.event(owner.workerId,owner.inputId,'tool.finished',{call_id:callId,method,status:write?'unknown':'failed',effect:write?'unknown':'not_applicable'});
      });
    }
    return this.callView(this.store.get('SELECT * FROM tool_calls WHERE id=?',callId));
  }
  stop(id,binding){
    userBinding(binding);check(deviceValetIdentifier(id),'device Valet identity required');const worker=this.store.worker(id),owner=this.owners.get(id);
    if(owner){
      this.store.transaction(()=>{this.store.run("UPDATE workers SET status='stopping',stopped_at=COALESCE(stopped_at,?),updated_at=?,revision=revision+1 WHERE id=?",this.now(),this.now(),id);this.event(id,owner.inputId,'stop.requested',{owner_present:true});});
      owner.controller.abort();owner.settings.stop().catch(()=>{});
    }else if(worker.status==='queued'){
      this.store.transaction(()=>{this.store.run("UPDATE workers SET status='stopped',stopped_at=?,updated_at=?,revision=revision+1 WHERE id=?",this.now(),this.now(),id);this.store.run("UPDATE messages SET status='cancelled',effect='not_started',finished_at=? WHERE worker_id=? AND status='queued'",this.now(),id);this.event(id,null,'stop.requested',{owner_present:false,effect:'not_started'});});
    }
    return {version:1,worker:this.workerView(this.store.worker(id))};
  }
  async dispatch(method,params={}){
    try{
      check(!this.closed,'device Valet service closed');
      if(method===DEVICE_VALET_RPC.catalog){strictFields(params,['token'],['token']);return this.catalog(params.token);}
      if(method===DEVICE_VALET_RPC.call){strictFields(params,['token','tool'],['token','tool']);return await this.call(params.token,params.tool);}
      const allowed={ [DEVICE_VALET_RPC.status]:[],[DEVICE_VALET_RPC.list]:['options'],[DEVICE_VALET_RPC.detail]:['options'],[DEVICE_VALET_RPC.submit]:['definition','user_binding'],[DEVICE_VALET_RPC.receipt]:['options','user_binding'],[DEVICE_VALET_RPC.stop]:['id','user_binding'],[DEVICE_VALET_RPC.shutdown]:['user_binding'] };
      check(Object.hasOwn(allowed,method),'unknown device Valet method');strictFields(params,['control',...allowed[method]],['control',...allowed[method]]);check(sameSecret(params.control,this.control),'device Valet user control required');
      switch(method){case DEVICE_VALET_RPC.status:return this.status();case DEVICE_VALET_RPC.list:return this.list(params.options);case DEVICE_VALET_RPC.detail:return this.detail(params.options);case DEVICE_VALET_RPC.submit:return this.submit(params.definition,params.user_binding);case DEVICE_VALET_RPC.receipt:return this.receipt(params.options,params.user_binding);case DEVICE_VALET_RPC.stop:return this.stop(params.id,params.user_binding);case DEVICE_VALET_RPC.shutdown:userBinding(params.user_binding);setTimeout(()=>this.close(),25).unref();return {version:1,stopping:true};}
    }catch{throw new LushError('设备管家请求被拒绝或结果未确认；核对权限、参数与原收据，不要自动重放。',-32070);}
  }
  async start(){check(!this.server&&!this.closed,'device Valet already started');assertPrivateFile(this.paths.socket,{missing:true,socket:true});fs.rmSync(this.paths.socket,{force:true});this.server=new RPCServer(this.paths.socket,{dispatch:(m,p)=>this.dispatch(m,p),stopping:{isRequested:()=>false,set(){}}});await this.server.start();writePrivateJSON(this.paths.descriptor,{version:1,pid:process.pid,service_id:this.store.serviceId,scope:DEVICE_VALET_SCOPE});return this;}
  close(){
    if(this.closing)return this.closing;
    this.closing=Promise.resolve().then(async()=>{
      for(const owner of this.owners.values()){owner.controller.abort();owner.settings.stop().catch(()=>{});}
      await Promise.allSettled([...this.owners.values()].map(owner=>owner.promise));
      await this.settings.stop();await this.server?.close();this.closed=true;
      if(assertPrivateFile(this.paths.socket,{missing:true,socket:true}))fs.unlinkSync(this.paths.socket);
      this.store.close();this.lock.release();this.onClosed?.();
    });return this.closing;
  }
}
