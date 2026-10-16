import { managedLaunchRuntime, managedProgramCommand, managedProgramArguments, validateManagedDescription } from './runner-deployment-remote-launch.js';
import { runtimeControl } from './runner-deployment-remote-control.js';
import { deploymentAbiScript } from './runner-deployment-remote-abi.js';

// Internal fixed program; adapters never originate in JSON/browser parameters.
export async function recoveryRuntime(m, request, adapters = {}, launch = managedLaunchRuntime, control_runtime = runtimeControl, abi_script = deploymentAbiScript) {
  const fs=await import('node:fs'),crypto=await import('node:crypto'),cp=await import('node:child_process');
  const stable=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v);
  const hash=b=>crypto.createHash('sha256').update(b).digest('hex'), ident=s=>`${s.dev}:${s.ino}`;
  const assert=(v,code='identity_changed')=>{if(!v)throw Object.assign(new Error('Original installation recovery refused'),{code});};
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v), hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  const {operation,recovery_id}=request;assert(['check','apply','inspect','seal','activate'].includes(operation)&&uuid(recovery_id),'config_invalid');
  let control, started=false;
  try {
    control=await control_runtime(m,{mode:operation,held_fd:adapters.held_fd??null,recovery_id});
    if(m.runtime_generation){const g=m.runtime_generation,bytes=control.read(`runtime-generations/${g.recovery_id}.json`);assert(hash(bytes)===g.sha256&&stable(JSON.parse(bytes))===stable(g.generation));if(g.recovery_id!==recovery_id)assert(control.read(`recoveries/${g.recovery_id}/activated`).toString()===`${g.recovery_id}:${g.sha256}:${g.publication_id}\n`);}
    return await launch(m,{control,recover:async ({manifest,boot_id:observedBoot})=>{
      const boot_id=adapters.boot_id?await adapters.boot_id():observedBoot, prefix=`recoveries/${recovery_id}/`, encode=v=>JSON.stringify(v)+'\n';
      const originalRead=(name,limit=4096)=>{const fd=fs.openSync(`/proc/self/fd/${control.root}/${name}`,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);assert(s.isFile()&&s.uid===m.target.uid&&(s.mode&0o7777)===0o600&&s.nlink===1&&s.size<=limit);const b=fs.readFileSync(fd);assert(b.length===s.size);return b;}finally{fs.closeSync(fd);}};
      const sealedBytes=originalRead('sealed'), seal=JSON.parse(sealedBytes);
      assert(seal.version===1&&seal.id===m.deployment_id&&seal.plan_sha256===m.plan_sha256&&seal.node_id===m.node_id&&uuid(seal.runner_id)&&/^cmd-[a-f0-9]{64}$/.test(seal.execution_id)&&seal.stopped===true);
      const configRow=manifest.files.find(row=>row.path==='config.json');assert(configRow&&hex(configRow.sha256));
      const immutable={deployment_id:m.deployment_id,node_id:m.node_id,runner_id:seal.runner_id,original_manifest_sha256:m.manifest_sha256,original_config_sha256:configRow.sha256,original_seal_sha256:hash(sealedBytes)};
      const run=async(command,args)=>{
        if(adapters.run)return await adapters.run(command,args);
        return await new Promise((resolve,reject)=>{const child=cp.spawn(command,args,{env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LC_ALL:'C',LANG:'C'},stdio:['ignore','pipe','pipe']});let size=0,err=0,failed=false;const chunks=[];const t=setTimeout(()=>{failed=true;child.kill('SIGKILL');},10000);child.stdout.on('data',b=>{size+=b.length;if(size>16384){failed=true;child.kill('SIGKILL');}else chunks.push(b);});child.stderr.on('data',b=>{err+=b.length;if(err>16384){failed=true;child.kill('SIGKILL');}});child.on('error',()=>{failed=true;});child.on('close',code=>{clearTimeout(t);if(failed)reject(Object.assign(new Error('Recovery system result unknown'),{code:'not_confirmed'}));else resolve({code,output:Buffer.concat(chunks).toString()});});});
      };
      const unit=async()=>{
        const e=m.cgroup_evidence, expected=`lush-runner-delegate-${m.target.uid}-${m.deployment_id}.service`;
        assert(e.unit===expected&&e.fragment_path==='/etc/systemd/system/'+expected&&hex(e.unit_sha256),'original_unit_unverifiable');
        if(adapters.unit)return await adapters.unit();
        const fd=fs.openSync(e.fragment_path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);assert(s.isFile()&&s.uid===0&&(s.mode&0o7777)===0o644&&s.nlink===1&&s.size<=4096&&hash(fs.readFileSync(fd))===e.unit_sha256);}finally{fs.closeSync(fd);}
        const tool=e.systemctl_path;assert(['/usr/bin/systemctl','/bin/systemctl','/run/current-system/sw/bin/systemctl'].includes(tool));const trusted=fs.statSync(tool);assert(trusted.isFile()&&trusted.uid===0&&(trusted.mode&0o022)===0);
        const result=await run(tool,['show',expected,'--no-pager','--property=LoadState,ActiveState,SubState,FragmentPath,User,Delegate,DelegateSubgroup,ControlGroup,MainPID,DropInPaths,ExecStart']);assert(result.code===0);
        const p={};for(const line of result.output.trim().split('\n')){const i=line.indexOf('=');assert(i>0&&!Object.hasOwn(p,line.slice(0,i)));p[line.slice(0,i)]=line.slice(i+1);}
        assert(p.LoadState==='loaded'&&p.FragmentPath===e.fragment_path&&p.User===String(m.target.uid)&&p.Delegate==='yes'&&p.DelegateSubgroup==='supervisor'&&!p.DropInPaths&&p.ExecStart.includes('path='+e.sleep_path+' ;')&&p.ExecStart.includes('argv[]='+e.sleep_path+' infinity ;'));
        assert(['active','inactive'].includes(p.ActiveState)&&((p.ActiveState==='active'&&p.SubState==='running'&&/^\/[A-Za-z0-9_./:@-]+$/.test(p.ControlGroup)&&!p.ControlGroup.includes('..'))||(p.ActiveState==='inactive'&&p.SubState==='dead'&&p.MainPID==='0')));
        return {name:expected,path:e.fragment_path,sha256:e.unit_sha256,active:p.ActiveState==='active',control_group:p.ControlGroup,main_pid:p.MainPID};
      };
      // Never instantiate RunnerStore or open the original database with SQLite.
      // No WAL replay/checkpoint/slot cleanup; only stable checkpointed main bytes.
      const commands=async()=>{
        if(adapters.commands)return await adapters.commands();
        const file=m.root+'/runner.db', missing=()=>({supported:false,reason:'database_unverifiable',total:0,executions:[]}); let fd;
        try{
          for(const suffix of ['-wal','-journal'])try{const s=fs.lstatSync(file+suffix);if(!s.isFile()||s.isSymbolicLink()||s.size>0)return {...missing(),reason:'database_wal_or_journal_pending'};}catch(e){if(e.code!=='ENOENT')throw e;}
          fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd);assert(s.isFile()&&s.uid===m.target.uid&&(s.mode&0o7777)===0o600&&s.nlink===1&&s.size>=512&&s.size<=64*1024*1024);
          const bytes=fs.readFileSync(fd), fingerprint=hash(bytes), after=fs.fstatSync(fd);assert(bytes.length===s.size&&ident(s)===ident(after)&&s.mtimeMs===after.mtimeMs&&s.ctimeMs===after.ctimeMs&&ident(fs.lstatSync(file))===ident(s));
          assert(bytes.subarray(0,16).toString()==='SQLite format 3\0'&&[1,2].includes(bytes[18])&&[1,2].includes(bytes[19]));
          // Documented sqlite3_deserialize workaround, ONLY in the isolated copy
          // after refusing nonempty WAL. Never alter/replay any original bytes.
          if(adapters.after_snapshot) await adapters.after_snapshot();
          const snapshot=Buffer.from(bytes);snapshot[18]=snapshot[19]=1;
          const {Database}=await import('bun:sqlite'),db=Database.deserialize(snapshot,{readonly:true});
          try{
            assert(db.query('PRAGMA quick_check').get().quick_check==='ok');
            const tables=db.query("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all(), map=new Map(tables.map(r=>[r.name,r]));
            for(const name of ['node_metadata','executions','workspaces','leases','requests','command_resources','output_chunks','artifacts'])assert(map.get(name)?.type==='table'&&!/\bVIRTUAL\b/i.test(map.get(name).sql));
            const columns={node_metadata:'key,value',workspaces:'workspace_key,project_id,node_id,worker_id,workspace_id,generation,directory,dev,ino,state,busy_request,last_run_id,created_at',leases:'lease_id,workspace_key,run_id,token_hash,session_id,expires_at,revoked',requests:'project_id,request_id,workspace_key,identity_json,method,fingerprint,state,result_json,error_json,session_id,created_at,updated_at',executions:'execution_id,workspace_key,request_id,identity_json,session_id,lease_id,state,spec_json,cgroup_name,created_at,started_at,ended_at,expires_at,queue_deadline,exit_code,reason,stop_confirmed,output_bytes,output_seen,output_seq,truncated,output_complete,error_json',command_resources:'execution_id,workspace_key,runner_id,phase,home_state,cgroup_state,home_json,containment_json',output_chunks:'execution_id,seq,stream,data',artifacts:'artifact_id,workspace_key,relative_path,digest,size,expires_at'};
            assert(tables.every(t=>t.type==='table'?Object.hasOwn(columns,t.name):t.type==='index'&&['workspace_owner','execution_workspace','lease_workspace'].includes(t.name)));
            for(const [table,want]of Object.entries(columns)) assert(db.query(`PRAGMA table_info(${table})`).all().map(c=>c.name).join()===want);
            assert(db.query("SELECT value FROM node_metadata WHERE key='runner_id'").get()?.value===seal.runner_id);
            if(db.query("SELECT count(*) n FROM executions WHERE state NOT IN ('queued','starting','running','stopping','unknown','exited') OR stop_confirmed NOT IN (0,1) OR json_valid(spec_json)=0 OR json_extract(spec_json,'$.resources_version') IS NOT 1").get().n) return {...missing(),reason:'database_legacy_commands'};
            const total=db.query('SELECT count(*) n FROM executions WHERE stop_confirmed != 1 OR stop_confirmed IS NULL').get().n;
            const executions=db.query('SELECT execution_id,state FROM executions WHERE stop_confirmed != 1 OR stop_confirmed IS NULL ORDER BY execution_id LIMIT 32').all();
            assert(executions.every(r=>/^cmd-[a-f0-9]{64}$/.test(r.execution_id)&&['queued','starting','running','stopping','unknown','exited'].includes(r.state)));
            for(const suffix of ['-wal','-journal'])try{assert(fs.lstatSync(file+suffix).size===0);}catch(e){if(e.code!=='ENOENT')throw e;}
            const last=fs.fstatSync(fd);assert(last.size===s.size&&last.mtimeMs===s.mtimeMs&&last.ctimeMs===s.ctimeMs&&ident(fs.lstatSync(file))===ident(s)&&hash(fs.readFileSync(file))===fingerprint);
            const last_rowid=db.query('SELECT coalesce(max(rowid),0) n FROM executions').get().n;assert(Number.isSafeInteger(last_rowid)&&last_rowid>=0);
            const proof=request.proof?.execution_id,proof_execution=operation==='seal'&&/^cmd-[a-f0-9]{64}$/.test(proof)?db.query('SELECT rowid ordinal,execution_id,state,reason,stop_confirmed,output_complete,truncated FROM executions WHERE execution_id=?').get(proof):null;
            return {supported:true,total,executions,truncated:total>32,sha256:fingerprint,last_rowid,proof_execution};
          }finally{db.close();}
        }catch{return missing();}finally{if(fd!==undefined)fs.closeSync(fd);}
      };
      const group=async(u,create=false)=>{
        if(adapters.group)return await adapters.group(u,create,boot_id);
        assert(u.active&&u.control_group&&u.control_group!=='/'&&!u.control_group.includes('..'));
        const parent='/sys/fs/cgroup'+u.control_group;assert(fs.realpathSync(parent)===parent);const s=fs.statSync(parent);assert(s.isDirectory()&&s.uid===m.target.uid&&Number(fs.statfsSync(parent).type)===0x63677270&&fs.readFileSync(parent+'/cgroup.type','utf8').trim()==='domain'&&fs.readFileSync(parent+'/cgroup.procs','utf8').trim()==='');
        assert(fs.readFileSync(parent+'/supervisor/cgroup.procs','utf8').trim()===u.main_pid&&fs.realpathSync('/proc/'+u.main_pid+'/exe')===fs.realpathSync(m.cgroup_evidence.sleep_path));
        const root=parent+'/runner';if(!fs.existsSync(root)){if(!create)return {missing:true};fs.mkdirSync(root,{mode:0o700});}
        assert(fs.realpathSync(root)===root);const child=fs.lstatSync(root);assert(child.isDirectory()&&!child.isSymbolicLink()&&child.uid===m.target.uid&&fs.readFileSync(root+'/cgroup.type','utf8').trim()==='domain'&&fs.readFileSync(root+'/cgroup.procs','utf8').trim()===''&&/^populated 0$/m.test(fs.readFileSync(root+'/cgroup.events','utf8')));
        for(const n of ['cgroup.procs','cgroup.kill'])fs.accessSync(root+'/'+n,fs.constants.W_OK);
        return {path:root,evidence:{...m.cgroup_evidence,boot_id,control_group:u.control_group,delegated_parent:parent,parent_dev:String(s.dev),parent_ino:String(s.ino),dev:String(child.dev),ino:String(child.ino)}};
      };
      const observe=async()=>{
        const blockers=[],history=await commands();if(!history.supported)blockers.push(history.reason);else if(history.total)blockers.push('old_commands_unconfirmed');
        let u=null,cg=null;try{u=await unit();if(u.active)cg=await group(u);}catch(e){blockers.push(e.code==='original_unit_unverifiable'?e.code:'original_unit_or_cgroup_changed');}
        if(u&&!u.active){try{if(adapters.inactiveEmpty)assert(await adapters.inactiveEmpty());else for(const path of new Set([m.cgroup_evidence.delegated_parent,...(u.control_group?['/sys/fs/cgroup'+u.control_group]:[])])){assert(path.startsWith('/sys/fs/cgroup/')&&!path.includes('..'));let s;try{s=fs.lstatSync(path);}catch(e){if(e.code==='ENOENT')continue;throw e;}assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===m.target.uid&&fs.realpathSync(path)===path&&Number(fs.statfsSync(path).type)===0x63677270&&/^populated 0$/m.test(fs.readFileSync(path+'/cgroup.events','utf8')));}}catch{blockers.push('original_unit_containment_not_empty');}}
        const actions=[{id:'bind_runtime_generation',privileged:false,effect:'Exclusively bind a new immutable boot/cgroup generation; create only the dedicated empty runner child if absent; preserve original configuration, workspaces and command slots'}];
        if(u&&!u.active){const permission=await run('/usr/bin/sudo',['-n','-l','--',m.cgroup_evidence.systemctl_path,'start','--',u.name]);if(permission.code!==0)blockers.push('privilege_denied');actions.push({id:'start_original_unit',privileged:true,unit_path:u.path,unit_sha256:u.sha256,unit_summary:'Start only the original verified dedicated delegation unit once',effect:'Start the existing unit; do not create, overwrite, enable, restart or retry it'});}
        return {version:1,recovery_id,...immutable,previous_generation_sha256:m.runtime_generation?.sha256||null,boot_id,epoch:control.epoch(),gate:control.gate,unit:u,cgroup:cg,commands:history,actions,blockers,supported:blockers.length===0};
      };
      if(operation==='check'){const plan=await observe();return {ok:true,plan,plan_sha256:hash(encode(plan))};}
      if(operation==='inspect'){
        const initial=control.optional(prefix+'apply.started');assert(initial,'not_found');const record=JSON.parse(initial);assert(record.plan_sha256===request.plan_sha256&&record.plan.recovery_id===recovery_id&&record.plan.original_seal_sha256===immutable.original_seal_sha256);
        const candidate=control.optional(prefix+'candidate.json'),activated=control.optional(prefix+'activated');
        return {ok:true,recovery_id,status:activated?'activated':control.optional(prefix+'sealed')?'sealed':candidate?'prepared':'unknown',verification_started:!!control.optional(prefix+'verification.started'),generation:candidate?JSON.parse(candidate):null,sha256:candidate?hash(candidate):null,publication:activated?activated.toString().trimEnd():null,commands:await commands()};
      }
      assert(hex(request.plan_sha256),'config_invalid');
      if(operation==='apply'){
        const p=request.recovery_plan;assert(p?.supported===true&&p.recovery_id===recovery_id&&hash(encode(p))===request.plan_sha256,'config_invalid');
        assert(JSON.stringify(request.approved_actions)===JSON.stringify(p.actions.map(a=>a.id)),'config_invalid');
        assert(!control.optional(prefix+'apply.started'),'stage_already_started');assert(control.gate===p.gate&&control.epoch()===p.epoch,'stale');
        const current=await observe();assert(current.supported&&JSON.stringify(current)===JSON.stringify(p),'stale');
        control.mkdir(recovery_id);control.write(prefix+'apply.started',encode({plan_sha256:request.plan_sha256,plan:p}));control.setGate(recovery_id);started=true;
        control.checkpoint();let u=current.unit;if(!u.active){control.write(prefix+'unit_start.started',encode({recovery_id,plan_sha256:request.plan_sha256,unit:u.name}));const result=await run('/usr/bin/sudo',['-n',m.cgroup_evidence.systemctl_path,'start','--',u.name]);assert(result.code===0,'not_confirmed');u=await unit();assert(u.active,'not_confirmed');control.write(prefix+'unit_start.done',encode({unit:u.name}));}
        const cg=await group(u,true);assert(cg?.path&&cg.evidence.boot_id===boot_id);
        const generation={version:1,id:recovery_id,...immutable,previous_generation_sha256:p.previous_generation_sha256,boot_id,cgroup:cg,unit:{name:u.name,path:u.path,sha256:u.sha256},epoch:p.epoch};
        const bytes=encode(generation);control.write(prefix+'candidate.json',bytes);return {ok:true,generation,sha256:hash(bytes)};
      }
      const intent=JSON.parse(control.read(prefix+'apply.started'));assert(intent.plan_sha256===request.plan_sha256&&control.gate===recovery_id);
      const bytes=control.read(prefix+'candidate.json'),g=JSON.parse(bytes);assert(g.boot_id===boot_id&&Object.entries(immutable).every(([k,v])=>g[k]===v)&&g.epoch===control.epoch());
      const current=await observe();assert(current.supported&&current.unit.active&&JSON.stringify(current.cgroup)===JSON.stringify(g.cgroup));
      if(operation==='seal'){
        assert(control.optional(prefix+'verification.started')&&!control.optional(prefix+'sealed'),'stage_already_started');const p=request.proof;
        assert(p&&Object.keys(p).sort().join()===['node_id','runner_id','execution_id','stopped','verified_at'].sort().join()&&p.node_id===m.node_id&&p.runner_id===seal.runner_id&&/^cmd-[a-f0-9]{64}$/.test(p.execution_id)&&p.execution_id!==seal.execution_id&&p.stopped===true&&/^\d{4}-\d\d-\d\dT[0-9:.]+Z$/.test(p.verified_at),'config_invalid');
        assert(current.commands.proof_execution?.execution_id===p.execution_id&&current.commands.proof_execution.stop_confirmed===1&&current.commands.proof_execution.state==='exited'&&current.commands.proof_execution.reason==='cancelled'&&current.commands.proof_execution.output_complete===1&&current.commands.proof_execution.truncated===0&&current.commands.proof_execution.ordinal>intent.plan.commands.last_rowid,'config_invalid');
        control.write(prefix+'seal.started',encode({recovery_id,proof:p}));started=true;control.write(`runtime-generations/${recovery_id}.json`,bytes);control.write(prefix+'sealed',encode({sha256:hash(bytes),proof:p}));return {ok:true,generation:g,sha256:hash(bytes)};
      }
      assert(control.optional(prefix+'sealed')&&!control.optional(prefix+'activated'),'stage_already_started');assert(uuid(request.central_publication_id)&&request.generation_sha256===hash(bytes),'config_invalid');
      control.write(prefix+'activate.started',encode({publication_id:request.central_publication_id,sha256:hash(bytes)}));started=true;
      control.write(prefix+'activated',`${recovery_id}:${hash(bytes)}:${request.central_publication_id}\n`);return {ok:true,runtime_generation:{recovery_id,sha256:hash(bytes),publication_id:request.central_publication_id,generation:g}};
    }},abi_script,control_runtime);
  }catch(e){return {ok:false,code:['busy','stale','stage_already_started','config_invalid','not_found','original_unit_unverifiable','recovery_blocked'].includes(e.code)?e.code:'not_confirmed',unknown:started||!['busy','stale','config_invalid','stage_already_started'].includes(e.code)};}
  finally{control?.close();}
}

export function managedRecoveryRunnerArguments({managed,recovery_id,generation_sha256,...ssh}) {
  validateManagedDescription(managed);
  const admission={mode:'provisional',recovery_id,generation_sha256};
  const program=`(${managedLaunchRuntime.toString()})(${JSON.stringify(managed)},{held_fd:8,provisional:${JSON.stringify(admission)}},${deploymentAbiScript.toString()},${runtimeControl.toString()}).catch(()=>{process.stderr.write('Recovery verification failed\\n');process.exitCode=1;});`;
  return managedProgramArguments({...ssh,managed},managedProgramCommand(managed,program,admission));
}
