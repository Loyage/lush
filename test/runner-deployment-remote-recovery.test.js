import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {RunnerStore} from '../src/runner/store.js';
import {remoteRuntime} from '../src/core/runner-deployment-remote-runtime.js';
import {managedLaunchRuntime,managedProgramCommand} from '../src/core/runner-deployment-remote-launch.js';
import {managedRunnerCommand,managedRunnerArguments,managedRecoveryRunnerArguments} from '../src/core/runner-deployment-remote.js';
import {runtimeControl,controlShell} from '../src/core/runner-deployment-remote-control.js';
import {recoveryRuntime} from '../src/core/runner-deployment-remote-recovery.js';
import {remoteFixture,tar,fakeRuntimeEvidence,digest} from './runner-deployment-remote-fixture.js';

async function fixture({native=false,dedicated=true,entry=null}={}) {
  const f=remoteFixture();
  try {
    // A controlled executable forwards to the local Bun only for source-frame
    // bridge tests. It is NOT a production artifact/ABI acceptance claim.
    const marker=path.join(f.root,'uploaded-executed'),runtime=f.artifact(Buffer.from(native?`#!/bin/sh\nprintf executed > '${marker}'\nexec '${process.execPath}' "$@"\n`:`#!/bin/sh\nprintf executed > '${marker}'\n`));
    const files=['bin/lush-runner','src/runner/index.js'],runner=f.artifact(tar(files.map(name=>({name,bytes:entry&&name==='src/runner/index.js'?entry:Buffer.from('fixture, not a real Runner')}))),files);
    const c=await f.plan(undefined,{runtime,runner,files}), e=c.plan.cgroup.evidence;
    if(dedicated){e.unit=`lush-runner-delegate-${process.getuid()}-${c.id}.service`;e.fragment_path='/etc/systemd/system/'+e.unit;e.unit_sha256='e'.repeat(64);e.sleep_path='/usr/bin/sleep';e.systemctl_path='/usr/bin/systemctl';e.parent_dev='1';e.parent_ino='2';c.plan.cgroup.path=e.delegated_parent+'/runner';c.plan.actions=[{id:'cgroup_setup'}];c.plan.system_setup={unit:{name:e.unit,path:e.fragment_path,sha256:e.unit_sha256}};}
    const req={id:c.id,plan_sha256:c.plan_sha256,plan:c.plan};await c.remote.prepare(req);fakeRuntimeEvidence(c);fs.copyFileSync(runtime.file,c.plan.install_root+'/bun');fs.chmodSync(c.plan.install_root+'/bun',0o700);
    const adapter={verifyCgroup:()=>true};const uploaded=await remoteRuntime({...req,operation:'runner',artifact:runner,files},{...adapter,payload:fs.readFileSync(runner.file)});if(!uploaded.ok)throw Error(JSON.stringify(uploaded));
    const node_config={version:1,node_id:randomUUID(),root:c.plan.install_root+'/workspaces',cgroup_root:c.plan.cgroup.path,machine_token_hash:'1'.repeat(64),projects:{fixture:{control_token_hash:'2'.repeat(64)}}};
    // Bound original cgroup stage evidence is a controlled fixture, not a live
    // manager/root/Runner stop attestation. No system command produces it here.
    if(dedicated) fs.writeFileSync(c.plan.install_root+'/stages/cgroup_setup.done',JSON.stringify({id:c.id,plan_sha256:c.plan_sha256,stage:'cgroup_setup',status:'done',result:{cgroup:c.plan.cgroup}}),{mode:0o600});
    const configured=await remoteRuntime({...req,operation:'configure',node_config},adapter);if(!configured.ok)throw Error(JSON.stringify(configured));
    const m=c.remote.describe(c,configured.managed),store=new RunnerStore(m.root),runner_id=store.runner_id;store.close();
    const proof={node_id:m.node_id,runner_id,execution_id:'cmd-'+digest('original'),stopped:true,verified_at:new Date().toISOString()};
    const sealed=await remoteRuntime({...req,operation:'seal',proof},adapter);if(!sealed.ok)throw Error(JSON.stringify(sealed));
    const recovery_id=randomUUID(),unit={name:e.unit,path:e.fragment_path,sha256:e.unit_sha256,active:true,control_group:'/controlled/new.service',main_pid:'123'};
    const state={unit,starts:0,fail:false,populated:false,changed:false};
    const adapters={inactiveEmpty:()=>!state.populated,unit:()=>structuredClone(state.unit),group:(_u,_create,boot_id)=>{if(state.populated)throw Error('not empty');return {path:'/sys/fs/cgroup/controlled/new.service/runner',evidence:{...e,boot_id,dev:'9',ino:state.changed?'11':'10',control_group:'/controlled/new.service',delegated_parent:'/sys/fs/cgroup/controlled/new.service',parent_dev:'7',parent_ino:'8'}};},run:(_cmd,args)=>{if(args.includes('-l'))return {code:0,output:''};state.starts++;if(state.fail)return {code:1,output:''};state.unit.active=true;return {code:0,output:''};}};
    const run=(operation,request={},overrides={})=>recoveryRuntime(m,{operation,recovery_id,...request},{...adapters,...overrides});
    const check=async()=>{const r=await run('check');expect(r.ok).toBe(true);return r.plan;};
    const apply=async(p)=>{p??=await check();return run('apply',{recovery_plan:p,plan_sha256:digest(JSON.stringify(p)+'\n'),approved_actions:p.actions.map(a=>a.id)});};
    const original=()=>Object.fromEntries(['config.json','manifest.json','sealed','bun','runner/src/runner/index.js'].map(n=>[n,digest(fs.readFileSync(m.install_root+'/'+n))]));
    return {...f,c,m,recovery_id,state,adapters,run,check,apply,proof,marker,original,dbfile:m.root+'/runner.db'};
  }catch(e){await f.close();throw e;}
}
function mutateDb(f,fn){const db=new Database(f.dbfile);try{fn(db);}finally{db.close();}}
function insert(f,{state='unknown',stop=0,legacy=false,id='cmd-'+digest(randomUUID())}={}){mutateDb(f,db=>db.query('INSERT INTO executions(execution_id,workspace_key,request_id,identity_json,session_id,state,spec_json,created_at,expires_at,queue_deadline,stop_confirmed,reason,output_complete) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'old-workspace','old-request','{}','old-session',state,JSON.stringify(legacy?{}:{resources_version:1}),1,2,3,stop,stop?'cancelled':null,stop));}
async function activated(f) {
  const p=await f.check(), prepared=await f.apply(p), plan_sha256=digest(JSON.stringify(p)+'\n'); expect(prepared.ok).toBe(true);
  const verifier=await runtimeControl(f.m,{mode:'provisional',recovery_id:f.recovery_id,generation_sha256:prepared.sha256});verifier.close();
  const proof={...f.proof,execution_id:'cmd-'+digest(randomUUID())};insert(f,{id:proof.execution_id,state:'exited',stop:1});
  expect((await f.run('seal',{plan_sha256,proof})).ok).toBe(true);
  const result=await f.run('activate',{plan_sha256,generation_sha256:prepared.sha256,central_publication_id:randomUUID()});expect(result.ok).toBe(true);
  return {...f.m,runtime_generation:result.runtime_generation};
}
function controlledEntry(f) {
  // Change ONLY the kernel observation adapter in the already validated generated
  // program. Do not replace validation, admission/control, file verification,
  // production assembly, refresh, stdin handling or the actual native Bun.
  f.hook(()=>({rewrite(script){const adapted=script.replace('{held_fd:8','{held_fd:8,verifyCgroup:(p,e)=>p==="/sys/fs/cgroup/controlled/new.service/runner"&&e.dev==="9"&&e.ino==="10"');if(adapted===script)throw Error('Controlled cgroup adapter was not installed');return adapted;}}));
}
const input=Buffer.from('{"fixture":"protocol-stdin"}\n');
function assertEntry(text,m){const rows=text.trimEnd().split('\n').map(s=>JSON.parse(s));expect(rows).toEqual([{phase:'entry',node_id:m.node_id,cgroup_root:'/sys/fs/cgroup/controlled/new.service/runner',stdin:input.toString(),bun:Bun.version},{phase:'closed'}]);}
const shell=(m,mode={mode:'normal'})=>spawnSync('/bin/sh',['-c','set -eu\ncd '+JSON.stringify(m.install_root)+'\n'+controlShell(m,mode)+'\nprintf admitted'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});

test('recovery is read-only original evidence: stable checkpointed main copied to readonly memory; no WAL/SHM/schema/slot writes',async()=>{
  const f=await fixture();try{const before=f.original(),bytes=fs.readFileSync(f.dbfile),entries=fs.readdirSync(f.m.root);const p=await f.check();expect(p).toMatchObject({supported:true,runner_id:f.proof.runner_id,epoch:'0',gate:'none',commands:{supported:true,total:0}});expect(p.actions.map(a=>a.id)).toEqual(['bind_runtime_generation']);expect(fs.readFileSync(f.dbfile)).toEqual(bytes);expect(fs.readdirSync(f.m.root)).toEqual(entries);expect(f.original()).toEqual(before);expect(fs.readdirSync(f.m.install_root+'/recoveries')).toEqual([]);}finally{await f.close();}
});

test('queued/running/unknown stop_confirmed=0 and legacy command rows block without clearing slots, old outputs or requests',async()=>{
  for(const state of ['queued','running','unknown']){const f=await fixture();try{insert(f,{state});const before=fs.readFileSync(f.dbfile),p=await f.check();expect(p).toMatchObject({supported:false,blockers:['old_commands_unconfirmed'],commands:{total:1}});expect(p.commands.executions[0].state).toBe(state);expect(fs.readFileSync(f.dbfile)).toEqual(before);expect((await f.apply(p)).ok).toBe(false);expect(fs.readFileSync(f.m.install_root+'/recovery-gate','utf8')).toBe('none\n');}finally{await f.close();}}
  const f=await fixture();try{insert(f,{stop:1,state:'exited',legacy:true});expect((await f.check()).blockers).toContain('database_legacy_commands');}finally{await f.close();}
});

test('nonempty WAL/journal, changed runner identity, missing/unknown schema, copied-main drift and substituted workspace all block without checkpoint/adoption',async()=>{
  for(const kind of ['wal','journal','schema','identity','missing','race','workspace']){const f=await fixture();try{let p;if(kind==='wal'||kind==='journal'){fs.writeFileSync(f.dbfile+'-'+kind,Buffer.alloc(128,23),{mode:0o600});p=await f.check();expect(p.blockers).toContain('database_wal_or_journal_pending');expect(fs.readFileSync(f.dbfile+'-'+kind)).toEqual(Buffer.alloc(128,23));}
      else if(kind==='schema'){mutateDb(f,db=>db.exec('CREATE TABLE unknown_new_schema(x)'));p=await f.check();}
      else if(kind==='identity'){mutateDb(f,db=>db.query("UPDATE node_metadata SET value=? WHERE key='runner_id'").run(randomUUID()));p=await f.check();}
      else if(kind==='missing'){fs.renameSync(f.dbfile,f.dbfile+'.original');p=await f.check();expect(fs.existsSync(f.dbfile)).toBe(false);}
      else if(kind==='race'){p=(await f.run('check',{}, {after_snapshot:()=>{const b=fs.readFileSync(f.dbfile);b[b.length-1]^=1;fs.writeFileSync(f.dbfile,b);}})).plan;}
      else{fs.renameSync(f.m.root,f.m.root+'.old');fs.mkdirSync(f.m.root,{mode:0o700});fs.copyFileSync(f.m.root+'.old/runner.db',f.dbfile);expect((await f.run('check')).ok).toBe(false);continue;}
      expect(p.supported).toBe(false);expect(fs.existsSync(f.dbfile+'-shm')).toBe(false);expect(fs.readFileSync(f.m.install_root+'/recovery-gate','utf8')).toBe('none\n');}finally{await f.close();}}
});

test('shared executions in separate processes exclude recovery; ordinary reconnection advances epoch and invalidates the frozen plan',async()=>{
  const f=await fixture();let child;try{const p=await f.check(),program=`import {runtimeControl} from ${JSON.stringify(new URL('../src/core/runner-deployment-remote-control.js',import.meta.url).pathname)};const c=await runtimeControl(${JSON.stringify(f.m)});console.log('ready');for await(const b of process.stdin){}c.close();`;
    child=spawn(process.execPath,['--no-install','--no-env-file','--config=/dev/null','-e',program],{stdio:['pipe','pipe','pipe']});const closed=new Promise(resolve=>child.once('close',resolve));await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('lease process exited early')));});
    expect(await f.run('check')).toMatchObject({ok:false,code:'busy',unknown:false});child.stdin.end();expect(await closed).toBe(0);child=null;
    expect(await f.apply(p)).toMatchObject({ok:false,code:'stale',unknown:false});expect(fs.readdirSync(f.m.install_root+'/recoveries')).toEqual([]);const updated=await f.check();expect(updated.epoch).toBe('1');
    const ordinary=await runtimeControl(f.m);const second=await runtimeControl(f.m);ordinary.close();second.close();expect((await f.check()).epoch).toBe('3');
  }finally{if(child){const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await closed;}await f.close();}
});

test('early shell gate and flock reject normal Bun execution throughout pending/unknown recovery; one original system start only, no UUID bypass/replay',async()=>{
  const f=await fixture();try{f.state.unit.active=false;f.state.fail=true;const p=await f.check();expect(p.supported).toBe(true);expect(p.actions.map(a=>a.id)).toEqual(['bind_runtime_generation','start_original_unit']);expect(await f.apply(p)).toMatchObject({ok:false,unknown:true});expect(f.state.starts).toBe(1);const frozen=digest(JSON.stringify(p)+'\n');expect(await f.run('apply',{recovery_plan:p,plan_sha256:frozen,approved_actions:p.actions.map(a=>a.id)})).toMatchObject({ok:false,code:'stage_already_started'});expect(f.state.starts).toBe(1);
    const command=spawnSync('/bin/sh',['-c',managedRunnerCommand(f.m)],{encoding:'utf8'});expect(command.status).not.toBe(0);expect(fs.existsSync(f.marker)).toBe(false);expect((await f.run('check',{recovery_id:randomUUID()})).ok).toBe(false);
    expect(await f.run('inspect',{plan_sha256:frozen})).toMatchObject({ok:true,status:'unknown',generation:null});expect(f.state.starts).toBe(1);expect(f.original().sealed).toBe(digest(fs.readFileSync(f.m.install_root+'/sealed')));
  }finally{await f.close();}
});

test('two-phase seal/CAS/explicit activation binds exact generation, retains original bytes and exposes no credential hashes or override field',async()=>{
  const f=await fixture();try{const before=f.original(),p=await f.check(),plan_sha256=digest(JSON.stringify(p)+'\n'),a=await f.apply(p);expect(a.ok).toBe(true);expect(a.generation).toMatchObject({id:f.recovery_id,deployment_id:f.m.deployment_id,runner_id:f.proof.runner_id,previous_generation_sha256:null,epoch:'0'});expect(f.original()).toEqual(before);
    expect(shell(f.m).status).not.toBe(0);let seen=0;const args=managedRecoveryRunnerArguments({managed:f.m,recovery_id:f.recovery_id,generation_sha256:a.sha256,ssh_alias:'fixture',ssh_configuration_file:path.join(f.c.remote.directory,'config')});expect(args).toContain('StdinNull=no');expect(args.join(' ')).not.toContain('1'.repeat(64));expect(args.join(' ')).not.toContain('2'.repeat(64));
    expect(await managedLaunchRuntime(f.m,{provisional:{recovery_id:f.recovery_id,generation_sha256:a.sha256},verifyCgroup:(cg,e)=>{expect(cg).toBe(a.generation.cgroup.path);expect(e.ino).toBe('10');return true;},start:()=>++seen})).toBe(1);
    await expect(managedLaunchRuntime(f.m,{provisional:{recovery_id:f.recovery_id,generation_sha256:a.sha256},verifyCgroup:()=>true,start:()=>++seen})).rejects.toThrow();expect(seen).toBe(1);
    const proof={...f.proof,execution_id:'cmd-'+digest('recovery')};expect(await f.run('seal',{plan_sha256,proof:{...proof,runner_id:randomUUID()}})).toMatchObject({ok:false,code:'config_invalid'});
    // A local fixture row stands in ONLY for storage-shape validation. Parent
    // still owns the actual hello/live command/output/cancel/whole-tree proof.
    expect(await f.run('seal',{plan_sha256,proof})).toMatchObject({ok:false,code:'config_invalid'});insert(f,{id:proof.execution_id,state:'exited',stop:1});
    expect(await f.run('seal',{plan_sha256,proof})).toMatchObject({ok:true,sha256:a.sha256});expect(shell({...f.m,runtime_generation:{recovery_id:f.recovery_id,sha256:a.sha256,publication_id:randomUUID(),generation:a.generation}}).status).not.toBe(0);
    const central_publication_id=randomUUID(),activated=await f.run('activate',{plan_sha256,generation_sha256:a.sha256,central_publication_id});expect(activated.ok).toBe(true);const active={...f.m,runtime_generation:activated.runtime_generation};
    expect(shell(active).status).toBe(0);expect(shell(f.m).status).not.toBe(0);expect(shell({...active,runtime_generation:{...active.runtime_generation,publication_id:randomUUID()}}).status).not.toBe(0);
    expect(await managedLaunchRuntime(active,{verifyCgroup:()=>true,start:()=>++seen})).toBe(2);expect(f.original()).toEqual(before);
    const inspect=await f.run('inspect',{plan_sha256});expect(inspect).toMatchObject({ok:true,status:'activated',sha256:a.sha256});
    fs.appendFileSync(f.m.config_file,' ');await expect(managedLaunchRuntime(active,{verifyCgroup:()=>true,start:()=>++seen})).rejects.toThrow();expect(seen).toBe(2);
  }finally{await f.close();}
});

test('seal refuses changed cgroup/boot, active verification lease, or new unknown command; no unknown state is cleared',async()=>{
  const f=await fixture();try{const p=await f.check(),plan_sha256=digest(JSON.stringify(p)+'\n'),a=await f.apply(p);expect(a.ok).toBe(true);const verifier=await runtimeControl(f.m,{mode:'provisional',recovery_id:f.recovery_id,generation_sha256:a.sha256});expect(await f.run('seal',{plan_sha256,proof:f.proof})).toMatchObject({ok:false,code:'busy'});verifier.close();
    f.state.changed=true;expect((await f.run('seal',{plan_sha256,proof:f.proof})).ok).toBe(false);f.state.changed=false;
    expect((await f.run('seal',{plan_sha256,proof:f.proof},{boot_id:()=>digest('changed boot')})).ok).toBe(false);
    insert(f);const before=fs.readFileSync(f.dbfile);expect((await f.run('seal',{plan_sha256,proof:f.proof})).ok).toBe(false);expect(fs.readFileSync(f.dbfile)).toEqual(before);expect(fs.existsSync(f.m.install_root+`/recoveries/${f.recovery_id}/sealed`)).toBe(false);
  }finally{await f.close();}
});

test('root preparation only starts the original fixed inactive unit after separate approval and read-only sudo observation',async()=>{
  const f=await fixture();try{f.state.unit.active=false;const denied=await f.run('check',{}, {run:()=>({code:1,output:'private suppressed'})});expect(denied.plan).toMatchObject({supported:false,blockers:['privilege_denied']});const p=await f.check(),hash=digest(JSON.stringify(p)+'\n');expect(await f.run('apply',{recovery_plan:p,plan_sha256:hash,approved_actions:['bind_runtime_generation']})).toMatchObject({ok:false,code:'config_invalid',unknown:false});expect(f.state.starts).toBe(0);const a=await f.apply(p);expect(a.ok).toBe(true);expect(f.state.starts).toBe(1);expect(f.original()['manifest.json']).toBe(a.generation.original_manifest_sha256);
  }finally{await f.close();}
});

test('controlled SSH stdio executes pinned recovery source frame through the early exclusive shell gate without invoking any real system action',async()=>{
  const f=await fixture({native:true});try{const result=await f.c.remote.recoveryCheck({managed:f.m,recovery_id:f.recovery_id});expect(result).toMatchObject({ok:true,plan:{supported:false,commands:{supported:true,total:0}}});expect(result.plan.blockers).toContain('original_unit_or_cgroup_changed');expect(JSON.stringify(result)).not.toContain('ENOENT');expect(fs.readdirSync(f.m.install_root+'/recoveries')).toEqual([]);
    f.hook(()=>({tamper_program:true}));await expect(f.c.remote.recoveryCheck({managed:f.m,recovery_id:f.recovery_id})).rejects.toThrow('not confirmed');expect(fs.readdirSync(f.m.install_root+'/recoveries')).toEqual([]);
  }finally{await f.close();}
});

test('the real shell FD shared lease spans uploaded executable lifetime; exclusive admission precedes any Bun instruction',async()=>{
  const f=await fixture({native:true});let child;try{const p=await f.check();
    const command=managedProgramCommand(f.m,`process.stdout.write('ready');process.stdin.resume();await new Promise(resolve=>process.stdin.once('end',resolve));`);
    child=spawn('/bin/sh',['-c',command],{stdio:['pipe','pipe','pipe']});const closed=new Promise(resolve=>child.once('close',resolve));await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('managed shell exited early')));});
    expect(await f.run('check')).toMatchObject({ok:false,code:'busy'});expect(await f.apply(p)).toMatchObject({ok:false,code:'busy'});
    child.stdin.end();expect(await closed).toBe(0);child=null;expect((await f.check()).epoch).toBe('1');
  }finally{if(child){const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await closed;}await f.close();}
});

test('new boot is bound only by an explicitly approved immutable generation; no installed bytes/old commands are rewritten',async()=>{
  const f=await fixture();try{const before=f.original(),boot_id=digest('new controlled boot'),p=(await f.run('check',{}, {boot_id:()=>boot_id})).plan;expect(p.supported).toBe(true);expect(p.boot_id).not.toBe(f.m.remote.boot_id);
    const a=await f.run('apply',{recovery_plan:p,plan_sha256:digest(JSON.stringify(p)+'\n'),approved_actions:p.actions.map(a=>a.id)},{boot_id:()=>boot_id});expect(a).toMatchObject({ok:true,generation:{boot_id,cgroup:{evidence:{boot_id}}}});expect(f.original()).toEqual(before);
    expect(shell(f.m).status).not.toBe(0);await expect(managedLaunchRuntime(f.m,{provisional:{recovery_id:f.recovery_id,generation_sha256:a.sha256},verifyCgroup:()=>true,start:()=>true})).rejects.toThrow();
    expect((await f.run('inspect',{plan_sha256:digest(JSON.stringify(p)+'\n')})).status).toBe('prepared');
  }finally{await f.close();}
});

test('missing original fixed unit evidence, populated containment, altered lease/workspace identities are barriers, never adopted or reset',async()=>{
  const existing=await fixture({dedicated:false});try{expect((await existing.check()).blockers).toContain('original_unit_unverifiable');}finally{await existing.close();}
  for(const name of ['connection-lease','activity-lock','activity-epoch','recovery-gate','config.json']){const f=await fixture();try{const file=f.m.install_root+'/'+name;fs.renameSync(file,file+'.original');fs.copyFileSync(file+'.original',file);fs.chmodSync(file,0o600);expect((await f.run('check')).ok).toBe(false);expect(shell(f.m).status).not.toBe(0);expect(fs.existsSync(f.marker)).toBe(false);}finally{await f.close();}}
  const f=await fixture();try{f.state.populated=true;expect((await f.check()).supported).toBe(false);f.state.unit.active=false;expect((await f.check()).blockers).toContain('original_unit_containment_not_empty');expect(f.state.starts).toBe(0);}finally{await f.close();}
});

test('exclusive recovery lease and one-use verification marker gate fake uploaded bytes before execution, not after Runner startup',async()=>{
  const f=await fixture();try{const control=await runtimeControl(f.m,{mode:'inspect'});try{expect(spawnSync('/bin/sh',['-c',managedRunnerCommand(f.m)]).status).not.toBe(0);expect(fs.existsSync(f.marker)).toBe(false);}finally{control.close();}
    expect(spawnSync('/bin/sh',['-c',managedRunnerCommand(f.m)]).status).toBe(0);expect(fs.readFileSync(f.marker,'utf8')).toBe('executed');fs.unlinkSync(f.marker);
    const p=await f.check(),a=await f.apply(p),options={managed:f.m,recovery_id:f.recovery_id,generation_sha256:a.sha256,ssh_alias:'fixture',ssh_configuration_file:path.join(f.c.remote.directory,'config')};
    const command=managedRecoveryRunnerArguments(options).at(-1);expect(spawnSync('/bin/sh',['-c',command]).status).toBe(0);expect(fs.existsSync(f.marker)).toBe(true);fs.unlinkSync(f.marker);
    expect(spawnSync('/bin/sh',['-c',command],{stdio:'ignore'}).status).not.toBe(0);expect(fs.existsSync(f.marker)).toBe(false);expect(()=>managedRecoveryRunnerArguments({...options,recovery_id:'../outside'})).toThrow();
  }finally{await f.close();}
});

test('successive explicitly activated generations append to the same installation and retain the exact previous publication chain',async()=>{
  const f=await fixture();try{let managed=f.m,previous=null;const before=f.original();
    for(let i=0;i<2;i++){const recovery_id=randomUUID(),run=(operation,r={})=>recoveryRuntime(managed,{operation,recovery_id,...r},f.adapters),checked=await run('check');expect(checked.plan.supported).toBe(true);expect(checked.plan.previous_generation_sha256).toBe(previous);const plan_sha256=checked.plan_sha256;
      const prepared=await run('apply',{recovery_plan:checked.plan,plan_sha256,approved_actions:checked.plan.actions.map(a=>a.id)});expect(prepared.ok).toBe(true);
      const verifier=await runtimeControl(managed,{mode:'provisional',recovery_id,generation_sha256:prepared.sha256});verifier.close();const proof={...f.proof,execution_id:'cmd-'+digest(randomUUID())};insert(f,{id:proof.execution_id,state:'exited',stop:1});
      expect((await run('seal',{plan_sha256,proof})).ok).toBe(true);const activated=await run('activate',{plan_sha256,generation_sha256:prepared.sha256,central_publication_id:randomUUID()});expect(activated.ok).toBe(true);expect(shell(managed).status).not.toBe(0);managed={...managed,runtime_generation:activated.runtime_generation};expect(shell(managed).status).toBe(0);previous=prepared.sha256;
    }
    expect(fs.readdirSync(f.m.install_root+'/runtime-generations')).toHaveLength(2);expect(f.original()).toEqual(before);expect(managed.deployment_id).toBe(f.m.deployment_id);
  }finally{await f.close();}
});

test('exported activated managed command and SSH arguments reach native Bun, generation assembly, refresh and untouched stdio',async()=>{
  const entry=fs.readFileSync(new URL('./runner-deployment-remote-entry-fixture.js',import.meta.url)),f=await fixture({native:true,entry});
  try{const m=await activated(f),before=f.original();controlledEntry(f);
    // These are the actual exported constructors, NOT direct controlShell or
    // managedLaunchRuntime calls. A missing validator binding must fail here.
    const command=managedRunnerCommand(m);assertEntry(await f.c.remote.run(command,{input}),m);
    const args=managedRunnerArguments({managed:m,ssh_alias:'fixture',ssh_configuration_file:path.join(f.c.remote.directory,'config')});expect(args.at(-1)).toBe(command);expect(args).toContain('StdinNull=no');
    assertEntry(await f.c.remote.run(args.at(-1),{input}),m);expect(f.records.at(-1).args).toEqual(args);expect(f.original()).toEqual(before);
    expect(args.join(' ')).not.toContain('1'.repeat(64));expect(args.join(' ')).not.toContain('2'.repeat(64));
    const g=m.runtime_generation,wrong_id=randomUUID(),wrong_hash=(g.sha256[0]==='a'?'b':'a')+g.sha256.slice(1);
    for(const runtime_generation of [{...g,publication_id:randomUUID()},{...g,sha256:wrong_hash},{...g,recovery_id:wrong_id,generation:{...g.generation,id:wrong_id}}]){
      const changed={...m,runtime_generation};fs.unlinkSync(f.marker);
      const rejected=managedRunnerArguments({managed:changed,ssh_alias:'fixture',ssh_configuration_file:path.join(f.c.remote.directory,'config')});
      await expect(f.c.remote.run(rejected.at(-1),{input})).rejects.toThrow('not confirmed');expect(fs.existsSync(f.marker)).toBe(false);
      // The next case starts from another successful native execution, making
      // the no-Bun marker assertion non-vacuous each time.
      assertEntry(await f.c.remote.run(command,{input}),m);
    }
  }finally{await f.close();}
});

test('exported second-generation recoveryCheck and provisional arguments validate the activated envelope before the native entry',async()=>{
  const entry=fs.readFileSync(new URL('./runner-deployment-remote-entry-fixture.js',import.meta.url)),f=await fixture({native:true,entry});
  try{const m=await activated(f),recovery_id=randomUUID();
    const observed=await f.c.remote.recoveryCheck({managed:m,recovery_id});expect(observed).toMatchObject({ok:true,plan:{recovery_id,previous_generation_sha256:m.runtime_generation.sha256,commands:{supported:true,total:0}}});
    // No real host unit exists. The unmodified native observation reports this
    // honestly; it is NOT a claim that the target is ready for recovery.
    expect(observed.plan.blockers).toContain('original_unit_or_cgroup_changed');expect(observed.plan.supported).toBe(false);
    const run=(operation,r={})=>recoveryRuntime(m,{operation,recovery_id,...r},f.adapters),checked=await run('check');expect(checked.plan.supported).toBe(true);
    const prepared=await run('apply',{recovery_plan:checked.plan,plan_sha256:checked.plan_sha256,approved_actions:checked.plan.actions.map(a=>a.id)});expect(prepared.ok).toBe(true);expect(prepared.generation.previous_generation_sha256).toBe(m.runtime_generation.sha256);
    const args=managedRecoveryRunnerArguments({managed:m,recovery_id,generation_sha256:prepared.sha256,ssh_alias:'fixture',ssh_configuration_file:path.join(f.c.remote.directory,'config')});controlledEntry(f);
    assertEntry(await f.c.remote.run(args.at(-1),{input}),m);expect(f.records.at(-1).args).toEqual(args);expect(fs.existsSync(f.m.install_root+`/recoveries/${recovery_id}/verification.started`)).toBe(true);
    fs.unlinkSync(f.marker);await expect(f.c.remote.run(args.at(-1),{input})).rejects.toThrow('not confirmed');expect(fs.existsSync(f.marker)).toBe(false);
  }finally{await f.close();}
});

test('exported generation validation rejects wrong or missing request/hash/publication bindings without a ReferenceError or any SSH spawn',async()=>{
  const f=await fixture();try{const m=await activated(f),file=path.join(f.c.remote.directory,'config'),count=f.records.length;
    const invalid=[];for(const key of ['recovery_id','sha256','publication_id'])for(const value of [undefined,null,'','../outside','A'.repeat(64)])invalid.push({...m.runtime_generation,[key]:value});
    invalid.push({...m.runtime_generation,generation:undefined},{...m.runtime_generation,generation:{...m.runtime_generation.generation,id:randomUUID()}});
    for(const runtime_generation of invalid){const managed={...m,runtime_generation},options={managed,ssh_alias:'fixture',ssh_configuration_file:file};
      expect(()=>managedRunnerCommand(managed)).toThrow('Managed Runner installation changed or is invalid');expect(()=>managedRunnerArguments(options)).toThrow('Managed Runner installation changed or is invalid');
      expect(()=>managedRecoveryRunnerArguments({...options,recovery_id:randomUUID(),generation_sha256:'b'.repeat(64)})).toThrow('Managed Runner installation changed or is invalid');
      await expect(f.c.remote.recoveryCheck({managed,recovery_id:randomUUID()})).rejects.toThrow('Managed Runner installation changed or is invalid');
    }expect(f.records).toHaveLength(count);
  }finally{await f.close();}
});
