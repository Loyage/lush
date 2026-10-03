import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createSSHManager } from '../../src/ui/desktop/ssh.js';
import { loadRemotePayload, readRemoteTar } from '../../src/ui/desktop/ssh-payload.js';
import { probeScript, installScript, uploadScript, hostScript, shellQuote } from '../../src/ui/desktop/ssh-scripts.js';

const FP = '0123456789abcdef';
const SHA = bytes => createHash('sha256').update(bytes).digest('hex');
const REMOTE_PORT = 54321;
function archiveEntries(entries) {
  const blocks=[];
  for(const entry of entries) {
    const bytes=Buffer.from(entry.bytes??''),header=Buffer.alloc(512);
    header.write(entry.name,0,100);header.write('0000700\0',100);header.write('0000000\0',108);header.write('0000000\0',116);
    header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);header.write('        ',148);
    header.write(entry.kind??'0',156);if(entry.link)header.write(entry.link,157,100);header.write('ustar\0',257);header.write('00',263);
    let sum=0;for(const byte of header)sum+=byte;header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
    blocks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  blocks.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(blocks));
}
function archiveDirectory(root) {
  const entries=[];
  function walk(relative) {
    const file=path.join(root,relative),stat=fs.lstatSync(file);
    entries.push({name:relative.replaceAll(path.sep,'/'),kind:stat.isDirectory()?'5':'0',bytes:stat.isDirectory()?Buffer.alloc(0):fs.readFileSync(file)});
    if(stat.isDirectory())for(const name of fs.readdirSync(file).sort())walk(path.join(relative,name));
  }
  for(const name of ['bun','bin','src','docs','README.md','package.json','remote.json'])walk(name);
  return archiveEntries(entries);
}
function fixture() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lush-ssh-test-'));
  const source=path.join(dir,'source'), payloadDir=path.join(dir,'payload'), userData=path.join(dir,'client');
  fs.mkdirSync(source); fs.mkdirSync(payloadDir);
  for(const name of ['bin','src/host','docs']) fs.mkdirSync(path.join(source,name),{recursive:true});
  // A tiny trusted test runtime delegates to this test process's actual Bun, without downloading anything.
  const bun=Buffer.from(`#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`);
  fs.writeFileSync(path.join(source,'bun'),bun,{mode:0o700});
  fs.writeFileSync(path.join(source,'src/identity.js'),`export function codeIdentity() {return {fingerprint:'${FP}'}}`);
  fs.writeFileSync(path.join(source,'src/host/control.js'),'export function liveWebState() {return null}');
  for(const name of ['lush-host','lush-host-worker','lushd']) fs.writeFileSync(path.join(source,'bin',name),'// fixture only');
  fs.writeFileSync(path.join(source,'bin/lush'),`console.log(JSON.stringify({running:true,code_match:true,current_code:{fingerprint:'${FP}'},port:${REMOTE_PORT},pid:1234,url:'http://127.0.0.1:${REMOTE_PORT}'}));`);
  fs.writeFileSync(path.join(source,'docs/README.md'),'fixture');
  fs.writeFileSync(path.join(source,'README.md'),'fixture');
  fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({version:'0.2.0',type:'module'}));
  const metadata={version:1,target:'linux-x64',fingerprint:FP,lush_version:'0.2.0',bun_version:Bun.version,bun_sha256:SHA(bun)};
  fs.writeFileSync(path.join(source,'remote.json'),JSON.stringify(metadata));
  const file='lush-remote-linux-x64.tar.gz';
  const archive=archiveDirectory(source);
  fs.writeFileSync(path.join(payloadDir,file),archive);
  const manifest={version:1,lush_version:'0.2.0',fingerprint:FP,targets:{'linux-x64':{file,sha256:SHA(archive),bun_version:Bun.version,bun_sha256:SHA(bun)}}};
  fs.writeFileSync(path.join(payloadDir,'manifest.json'),JSON.stringify(manifest));
  const home=path.join(dir,"remote home ' quoted"); fs.mkdirSync(home);
  return {dir,source,payloadDir,userData,home,manifest,metadata,archive,
    cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
function fields(data) { return 'LUSH_SSH_PROBE\n'+Object.entries(data).map(([key,value])=>`${key}\t${Buffer.from(String(value)).toString('base64')}\n`).join(''); }
const baseProbe = home => ({os:'Linux',arch:'x86_64',home,uid:'1001',identity:'test-machine',bun_path:'/usr/bin/bun',bun_version:'1.4.2',git:'/usr/bin/git',pi:'/usr/bin/pi',codex:'',tar:'/usr/bin/tar',sha256sum:'/usr/bin/sha256sum',metadata:'',installed_bun_sha:'',root_exists:'0'});
function fakeChild(response, {persistent=false, gate=false}={}) {
  const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.killed=false; child.exitCode=null;
  let chunks=[];
  child.stdin=new Writable({write(chunk,_encoding,callback){chunks.push(Buffer.from(chunk));callback();}});
  let ended=false;
  child.finish=(code=0)=> {if(ended)return; ended=true; child.exitCode=code; child.stdout.end();child.stderr.end();child.emit('close',code);};
  child.kill=signal=> {child.killed=true;child.lastSignal=signal;queueMicrotask(()=>child.finish(null));return true;};
  child.stdin.on('finish',()=> {if(gate)return; queueMicrotask(()=> {const result=typeof response==='function' ? response(Buffer.concat(chunks)) : response;
    if(result?.stdout)child.stdout.write(result.stdout);if(result?.stderr)child.stderr.write(result.stderr);if(!persistent)child.finish(result?.code??0);});});
  if(persistent) queueMicrotask(()=> {if(response?.stderr)child.stderr.write(response.stderr);if(response?.code!==undefined)child.finish(response.code);});
  return child;
}
function mock(f, settings={}) {
  const calls=[],tunnels=[];
  let installed=settings.installed??false;
  const probe={...baseProbe('/srv/remote-user'),...settings.probe};
  const spawn=(command,args,options)=> {
    const call={command,args,options,child:null,input:null};calls.push(call);
    if(args.includes('-G')) {
      call.child=fakeChild(settings.configurationResponse??{stdout:settings.config??'hostname server.example\nuser developer\nport 2222\nproxyjump none\n'});return call.child;
    }
    if(args.includes('-N')) {
      call.child=fakeChild(settings.tunnelResponse??{}, {persistent:true}); tunnels.push(call.child);return call.child;
    }
    call.child=fakeChild(input=> {
      call.input=input;
      const command=args.at(-1),script=command==='sh -s' ? input.toString() : command;
      if(script.includes('# lush-ssh:probe')) {
        const current={...probe};
        if(installed && script.includes(`${FP}-linux-x64`)) {current.metadata=JSON.stringify(f.metadata);current.installed_bun_sha=f.metadata.bun_sha256;current.root_exists='1';}
        return settings.response?.(script,current)??{stdout:fields(current)};
      }
      if(script.includes('# lush-ssh:upload'))return {stdout:'LUSH_SSH_UPLOADED\n'};
      if(script.includes('# lush-ssh:install')) {installed=true;return {stdout:'LUSH_SSH_INSTALLED\n'};}
      if(script.includes('# lush-ssh:host'))return {stdout:settings.hostOutput??`LUSH_SSH_HOST {"port":${REMOTE_PORT},"pid":1234}\n`};
      throw new Error('unexpected script');
    },{gate:settings.gate});return call.child;
  };
  const manager=createSSHManager({payloadDir:f.payloadDir,payloadProvider:settings.payloadProvider,userData:f.userData,spawn,choosePort:async excluded=>{let port=14318;while(excluded.has(port))port++;return port;},
    checkPort:settings.checkPort??(async()=>{}),checkTunnel:settings.checkTunnel??(async()=>{}),timeoutMs:settings.timeoutMs??1000,env:{...process.env,LUSH_AGENT_TOKEN:'must-not-leak',OPENAI_API_KEY:'must-not-transfer'}});
  return {manager,calls,tunnels,probe};
}
async function tick() {await new Promise(resolve=>setTimeout(resolve,0));}

test('trusted payload validates identity, Bun hash and regular archive contents',()=> {
  const f=fixture();try {
    const payload=loadRemotePayload(f.payloadDir,'linux-x64');expect(payload.fingerprint).toBe(FP);expect(payload.archiveSha256).toBe(SHA(f.archive));
    expect(readRemoteTar(f.archive).has('src/identity.js')).toBe(true);
    fs.appendFileSync(path.join(f.payloadDir,f.manifest.targets['linux-x64'].file),'tampered');
    expect(()=>loadRemotePayload(f.payloadDir,'linux-x64')).toThrow('SHA-256');
  } finally {f.cleanup();}
});

test('archive paths, links, extra files, duplicate entries and checksums fail closed',()=> {
  const f=fixture();try {
    expect(()=>readRemoteTar(archiveEntries([{name:'src/link',kind:'2',link:'/tmp/escape'}]))).toThrow('链接');
    expect(()=>readRemoteTar(archiveEntries([{name:'credentials',bytes:'extra'}]))).toThrow('未授权');
    expect(()=>readRemoteTar(archiveEntries([{name:'bun',bytes:'one'},{name:'bun',bytes:'two'}]))).toThrow('重复路径');
    const header=Buffer.alloc(512);header.write('../escape');header.write('00000000000\0',124);header.write('        ',148);header.write('0',156);
    let sum=0;for(const byte of header)sum+=byte;header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
    expect(()=>readRemoteTar(gzipSync(Buffer.concat([header,Buffer.alloc(1024)])))).toThrow('不安全路径');
    header[0]=65;expect(()=>readRemoteTar(gzipSync(Buffer.concat([header,Buffer.alloc(1024)])))).toThrow('头校验');
  }finally{f.cleanup();}
});

test.skipIf(process.platform==='win32')('payload rejects symlinks, missing architecture and mismatching metadata',()=> {
  const f=fixture();try {
    expect(()=>loadRemotePayload(f.payloadDir,'linux-arm64')).toThrow('缺少 linux-arm64');
    const file=path.join(f.payloadDir,f.manifest.targets['linux-x64'].file);fs.renameSync(file,file+'.saved');fs.symlinkSync(file+'.saved',file);
    expect(()=>loadRemotePayload(f.payloadDir,'linux-x64')).toThrow('安全的普通文件');
  }finally{f.cleanup();}
});

test('inspection is read-only remotely, bounded and distinct from Agent authentication',async()=> {
  const f=fixture(),m=mock(f,{probe:{git:'',pi:'',bun_path:'',bun_version:''}});try {
    const result=await m.manager.inspect({alias:'my-server'});
    expect(result.requiresInstall).toBe(true);expect(result.plan.target).toBe('linux-x64');expect(result.plan.privateBun).toBe(true);
    expect(result.plan.agentAuthenticationChecked).toBe(false);expect(result.warnings).toHaveLength(3);
    expect(result.profile.url).toBe('http://127.0.0.1:14318/');expect(result.profile.id).toMatch(/^[a-f0-9]{32}$/);
    expect(m.calls).toHaveLength(3);expect(m.calls.every(c=>!c.args.includes('-N'))).toBe(true);
    for(const call of m.calls) {expect(call.command).toBe('ssh');expect(call.options.shell).toBe(false);expect(call.options.env.LUSH_AGENT_TOKEN).toBeUndefined();expect(call.options.env.OPENAI_API_KEY).toBeUndefined();expect(call.args).toContain('BatchMode=yes');expect(call.args).toContain('StrictHostKeyChecking=yes');}
    expect(m.calls.filter(c=>c.input).every(c=>!c.input.toString().includes('prepare_base\nroot='))).toBe(true);
    const saved=JSON.parse(fs.readFileSync(path.join(f.userData,'ssh-connections.json')));expect(saved.profiles[0].alias).toBe('my-server');
    expect(Object.keys(saved.profiles[0]).sort()).toEqual(['alias','id','identity','port']);
  } finally {m.manager.dispose();await tick();f.cleanup();}
});

test('installation needs an unchanged inspected plan and explicit authorization',async()=> {
  const f=fixture(),m=mock(f);try {
    await expect(m.manager.connect({alias:'my-server'})).rejects.toThrow('明确确认');
    await expect(m.manager.connect({alias:'my-server'},{install:true})).rejects.toThrow('重新预检');
    const preview=await m.manager.inspect({alias:'my-server'});
    const result=await m.manager.connect(preview.profile,{install:true});expect(result.url).toBe(preview.profile.url);
    expect(m.calls.some(c=>c.input?.equals(f.archive))).toBe(true);
    const tunnel=m.calls.find(c=>c.args.includes('-N'));expect(tunnel.args).toContain(`127.0.0.1:14318:127.0.0.1:${REMOTE_PORT}`);expect(tunnel.args).toContain('ExitOnForwardFailure=yes');
    const before=m.calls.length;expect((await m.manager.connect(preview.profile)).reused).toBe(true);expect(m.calls).toHaveLength(before);
    m.manager.disconnect(preview.profile.id);await tick();expect(m.tunnels[0].killed).toBe(true);expect(m.manager.list()[0].connected).toBe(false);
    expect(m.calls.every(c=>!c.args.join(' ').includes('host-stop'))).toBe(true);
  } finally {m.manager.dispose();await tick();f.cleanup();}
});

function missingPayload(f, download) {
  const payload=loadRemotePayload(f.payloadDir,'linux-x64');
  return {resolve:()=>({target:payload.target,fingerprint:payload.fingerprint,lushVersion:payload.lushVersion,bunVersion:payload.bunVersion,
    download:{repository:'Loyage/lush',tag:`payload-v0.2.0-${FP}`,releaseURL:`https://github.com/Loyage/lush/releases/tag/payload-v0.2.0-${FP}`,maximumBytes:256*1024*1024}}),
    download:(_target,options)=>download(payload,options)};
}

test('missing payload remains offline until an unchanged plan receives explicit install authorization',async()=> {
  const f=fixture();let downloads=0;
  const p=missingPayload(f,async payload=>{downloads++;return payload;});
  const m=mock(f,{payloadProvider:p});try {
    await expect(m.manager.connect({alias:'server'},{install:true})).rejects.toThrow('重新预检');
    const preview=await m.manager.inspect({alias:'server'});
    expect(preview.requiresInstall).toBe(true);expect(preview.plan.download.repository).toBe('Loyage/lush');
    expect(preview.plan.uploadBytes).toBe(null);expect(downloads).toBe(0);
    await expect(m.manager.connect(preview.profile)).rejects.toThrow('明确确认');expect(downloads).toBe(0);
    await m.manager.connect(preview.profile,{install:true});expect(downloads).toBe(1);
    expect(m.calls.filter(c=>c.input?.toString().includes('# lush-ssh:probe'))).toHaveLength(10);
    expect(m.calls.some(c=>c.input?.equals(f.archive))).toBe(true);
  }finally{m.manager.dispose();await tick();f.cleanup();}
});

test('download failure revokes confirmation and performs no upload, installation or Host call',async()=> {
  const f=fixture();let downloads=0;
  const m=mock(f,{payloadProvider:missingPayload(f,async()=>{downloads++;throw new Error('release missing');})});try {
    const preview=await m.manager.inspect({alias:'server'});
    await expect(m.manager.connect(preview.profile,{install:true})).rejects.toThrow('release missing');
    await expect(m.manager.connect(preview.profile,{install:true})).rejects.toThrow('重新预检');
    expect(downloads).toBe(1);expect(m.calls.every(c=>c.args.includes('-G') || c.input?.toString().includes('# lush-ssh:probe'))).toBe(true);
  }finally{m.manager.dispose();await tick();f.cleanup();}
});

test('cancellation during download prevents late bytes from triggering any remote write',async()=> {
  const f=fixture();let resolve,signal,start;
  const started=new Promise(r=>{start=r;});
  const payload=loadRemotePayload(f.payloadDir,'linux-x64');
  const p=missingPayload(f,(_payload,options)=>new Promise(r=>{signal=options.signal;resolve=r;start();}));
  const m=mock(f,{payloadProvider:p});try {
    const preview=await m.manager.inspect({alias:'server'});
    const pending=m.manager.connect(preview.profile,{install:true});pending.catch(()=>{});await started;
    m.manager.disconnect(preview.profile.id);expect(signal.aborted).toBe(true);resolve(payload);
    await expect(pending).rejects.toThrow('已取消');expect(m.tunnels).toHaveLength(0);
    expect(m.calls.some(c=>c.input?.equals(f.archive))).toBe(false);
  }finally{m.manager.dispose();await tick();f.cleanup();}
});

test('remote identity and architecture are rechecked after download before any upload',async()=> {
  for(const change of [{home:'/srv/different-user'},{arch:'aarch64'}]) {
    const f=fixture();let m;
    const p=missingPayload(f,async payload=>{Object.assign(m.probe,change);return payload;});
    m=mock(f,{payloadProvider:p});try {
      const preview=await m.manager.inspect({alias:'server'});
      await expect(m.manager.connect(preview.profile,{install:true})).rejects.toThrow();
      expect(m.calls.some(c=>c.input?.equals(f.archive))).toBe(false);expect(m.tunnels).toHaveLength(0);
    }finally{m.manager.dispose();await tick();f.cleanup();}
  }
});

test('after acquiring trusted metadata an existing installation is reused without another upload',async()=> {
  const f=fixture();let downloads=0;
  const m=mock(f,{installed:true,payloadProvider:missingPayload(f,async payload=>{downloads++;return payload;})});try {
    const preview=await m.manager.inspect({alias:'server'});expect(preview.ready).toBe(false);
    await m.manager.connect(preview.profile,{install:true});expect(downloads).toBe(1);
    expect(m.calls.some(c=>c.input?.equals(f.archive))).toBe(false);expect(m.tunnels).toHaveLength(1);
  }finally{m.manager.dispose();await tick();f.cleanup();}
});

test('existing installation connects without uploading or reinstalling',async()=> {
  const f=fixture(),m=mock(f,{installed:true});try {
    const preview=await m.manager.inspect({alias:'existing'});expect(preview.ready).toBe(true);
    await m.manager.connect(preview.profile);
    expect(m.calls.every(c=>!c.input?.equals(f.archive))).toBe(true);expect(m.manager.list()[0].connected).toBe(true);
  }finally{m.manager.dispose();await tick();f.cleanup();}
});

test('profile identity and port are stable, and distinct aliases do not share origins',async()=> {
  const f=fixture(),m=mock(f);try {
    const a=await m.manager.inspect({alias:'one'}),b=await m.manager.inspect({alias:'two'});
    expect(a.profile.url).not.toBe(b.profile.url);expect((await m.manager.inspect({alias:'one'})).profile).toEqual(a.profile);
    m.manager.dispose();await tick();
    const restored=mock(f);try{expect(restored.manager.list().map(r=>r.url)).toEqual([a.profile.url,b.profile.url]);expect((await restored.manager.inspect(a.profile)).profile).toEqual(a.profile);}finally{restored.manager.dispose();}
  }finally{m.manager.dispose();await tick();f.cleanup();}
});

test('trusted preallocated 32-hex IDs survive inspect/connect and cannot be rebound',async()=> {
  const f=fixture(),m=mock(f,{installed:true});try {
    const id='a'.repeat(32),input={id,alias:'server'};
    const preview=await m.manager.inspect(input);expect(preview.profile.id).toBe(id);
    const connected=await m.manager.connect(preview.profile);expect(connected.profile.id).toBe(id);expect(connected.profile.alias).toBe('server');
    expect(m.manager.list()[0]).toMatchObject({id,alias:'server',connected:true});
    const before=m.calls.length;
    await expect(m.manager.inspect({id,alias:'other-server'})).rejects.toThrow('ID 不属于');
    await expect(m.manager.inspect({id:'b'.repeat(32),alias:'server'})).rejects.toThrow('已有别名必须复用');
    expect(m.calls).toHaveLength(before);expect(m.manager.list()).toHaveLength(1);
    m.manager.disconnect(id);await tick();expect(m.tunnels[0].killed).toBe(true);
  }finally{m.manager.dispose();await tick();f.cleanup();}
});

test('SSH alias length matches the desktop 253-character limit',async()=> {
  const f=fixture(),m=mock(f);try {
    const alias='a'.repeat(253);
    expect((await m.manager.inspect({alias})).profile.alias).toBe(alias);
    await expect(m.manager.inspect({alias:alias+'b'})).rejects.toThrow('安全 Host');
  }finally{m.manager.dispose();await tick();f.cleanup();}
});

test('asynchronous allocation does not retain a mutable caller profile',async()=> {
  const f=fixture(),m=mock(f);try {
    const id='e'.repeat(32),input={id,alias:'server'},pending=m.manager.inspect(input);
    input.id='../escape';input.alias='server;unexpected-command';
    const result=await pending;expect(result.profile).toMatchObject({id,alias:'server'});expect(m.calls.every(call=>call.args.includes('server'))).toBe(true);
  }finally{m.manager.dispose();await tick();f.cleanup();}
});

test('early UUID connection records retain their original ID and origin',async()=> {
  const f=fixture(),id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';fs.mkdirSync(f.userData);
  fs.writeFileSync(path.join(f.userData,'ssh-connections.json'),JSON.stringify({version:1,profiles:[{id,alias:'early-server',port:14318,identity:null}]}));
  const m=mock(f);try{expect((await m.manager.inspect({id,alias:'early-server'})).profile).toMatchObject({id,url:'http://127.0.0.1:14318/'});}
  finally{m.manager.dispose();await tick();f.cleanup();}
});

test('changed SSH destination refuses reuse of old cookies and unsafe inputs never spawn',async()=> {
  const f=fixture(),m=mock(f);try {
    const a=await m.manager.inspect({alias:'server'});m.manager.dispose();await tick();
    const changed=mock(f,{config:'hostname different.example\nuser developer\nport 2222\n'});
    try {await expect(changed.manager.inspect(a.profile)).rejects.toThrow('身份已变化');}finally{changed.manager.dispose();}
    const clean=mock(f);try {
      for(const alias of ['-oProxyCommand=evil','user@host','server;touch /tmp/escape','ssh://host','a\nb','a b','a$(cmd)',''])await expect(clean.manager.inspect({alias})).rejects.toThrow('安全 Host');
      expect(clean.calls).toHaveLength(0);await expect(clean.manager.inspect({alias:'server',password:'secret'})).rejects.toThrow('安全 Host');
      await expect(clean.manager.inspect({alias:'server',id:'../escape'})).rejects.toThrow('ID');
    }finally{clean.manager.dispose();}
  }finally{m.manager.dispose();await tick();f.cleanup();}
});

test('configured forwards, malformed remote output and non-Linux platforms fail closed',async()=> {
  for(const settings of [
    {config:'hostname server\nuser dev\nport 22\nlocalforward 0.0.0.0:1 somewhere:2\n'},
    {response:()=>({stdout:'welcome banner\n'+fields(baseProbe('/srv/user'))})},
    {probe:{os:'Darwin'}},
    {probe:{home:'/home/user\ninjection'}},
    {hostOutput:'LUSH_SSH_HOST {"port":0,"pid":2}\n'}
  ]) {
    const f=fixture(),m=mock(f,{installed:true,...settings});try {
      if(settings.hostOutput)await expect(m.manager.connect({alias:'server'})).rejects.toThrow('端口或身份');
      else await expect(m.manager.inspect({alias:'server'})).rejects.toThrow();
    }finally{m.manager.dispose();await tick();f.cleanup();}
  }
});

test('output limits, timeout and cancellation terminate only owned SSH children',async()=> {
  for(const scenario of ['output','timeout','cancel']) {
    const f=fixture(),m=mock(f,{gate:scenario!=='output',timeoutMs:20,response:()=>({stdout:'x'.repeat(100*1024)})});try {
      const pending=m.manager.inspect({alias:'server'});pending.catch(()=>{});
      await tick();if(scenario==='cancel')m.manager.disconnect('server');
      await expect(pending).rejects.toThrow(scenario==='output' ? '大小限制' : scenario==='timeout' ? '超时' : '取消');
      await tick();expect(m.calls.at(-1).child.killed).toBe(true);
    }finally{m.manager.dispose();await tick();f.cleanup();}
  }
});

test('parallel calls share inspection/connection work and shutdown cannot reconnect',async()=> {
  const f=fixture(),m=mock(f,{installed:true});try {
    const [a,b]=await Promise.all([m.manager.inspect({alias:'server'}),m.manager.inspect({alias:'server'})]);expect(a.profile).toEqual(b.profile);expect(m.calls).toHaveLength(3);
    await Promise.all([m.manager.connect(a.profile),m.manager.connect(a.profile)]);expect(m.tunnels).toHaveLength(1);
    m.manager.dispose();await tick();expect(m.tunnels[0].killed).toBe(true);await expect(m.manager.inspect(a.profile)).rejects.toThrow('已关闭');
  }finally{m.manager.dispose();await tick();f.cleanup();}
});

test('occupied stable port is refused before remote mutation',async()=> {
  const f=fixture(),m=mock(f,{checkPort:async()=>{throw new Error('occupied stable port');}});try {
    const preview=await m.manager.inspect({alias:'server'});const before=m.calls.length;
    await expect(m.manager.connect(preview.profile,{install:true})).rejects.toThrow('occupied');expect(m.calls).toHaveLength(before);
  }finally{m.manager.dispose();await tick();f.cleanup();}
});

test('real port binding check detects a conflicting listener',async()=> {
  const f=fixture(),server=net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
  const m=createSSHManager({payloadDir:f.payloadDir,userData:f.userData,choosePort:async()=>port,spawn:()=>{throw new Error('must not spawn');}});
  try{await expect(m.connect({alias:'server'})).rejects.toThrow('被占用');}
  finally{m.dispose();await new Promise(resolve=>server.close(resolve));f.cleanup();}
});

test.skipIf(process.platform==='win32')('corrupt or symlinked profile records are not reset',()=> {
  const f=fixture();try {
    fs.mkdirSync(f.userData);const file=path.join(f.userData,'ssh-connections.json');fs.writeFileSync(file,'bad json');
    expect(()=>createSSHManager({userData:f.userData,payloadDir:f.payloadDir})).toThrow('损坏');expect(fs.readFileSync(file,'utf8')).toBe('bad json');
    fs.unlinkSync(file);fs.symlinkSync(path.join(f.dir,'missing'),file);
    expect(()=>createSSHManager({userData:f.userData,payloadDir:f.payloadDir})).toThrow('不安全');
  }finally{f.cleanup();}
});

test('SSH authentication and host trust errors are classified without returning raw stderr',async()=> {
  for(const [stderr,code] of [['Permission denied (publickey). secret-from-proxy','SSH_AUTH'],['Host key verification failed. secret-from-proxy','SSH_HOST_KEY'],['Could not resolve hostname server: secret-from-proxy','SSH_HOST']]) {
    const f=fixture(),m=mock(f,{response:()=>({stderr,code:255})});try {
      let failure;try{await m.manager.inspect({alias:'server'});}catch(error){failure=error;}
      expect(failure.code).toBe(code);expect(failure.message).not.toContain('secret-from-proxy');
    }finally{m.manager.dispose();await tick();f.cleanup();}
  }
});

test('changed installation plan needs a new preview before any upload',async()=> {
  const f=fixture(),m=mock(f);try {
    const preview=await m.manager.inspect({alias:'server'});m.probe.bun_version='1.1.0';
    await expect(m.manager.connect(preview.profile,{install:true})).rejects.toThrow('计划尚未确认或已变化');
    expect(m.calls.some(c=>c.input?.equals(f.archive))).toBe(false);
  }finally{m.manager.dispose();await tick();f.cleanup();}
});

test('cancellation before profile allocation finishes cannot lose the request',async()=> {
  const f=fixture();let allocate;const gate=new Promise(resolve=>{allocate=resolve;});let spawns=0;
  const manager=createSSHManager({payloadDir:f.payloadDir,userData:f.userData,choosePort:()=>gate,spawn:()=>{spawns++;throw new Error('must not spawn');}});
  try {
    const pending=manager.inspect({alias:'server'});pending.catch(()=>{});manager.disconnect('server');allocate(14318);
    await expect(pending).rejects.toThrow('取消');expect(spawns).toBe(0);
  }finally{manager.dispose();await tick();f.cleanup();}
});

test('trusted ID cancellation works before allocation and during an active inspector',async()=> {
  for(const method of ['inspect','connect']) {
    const f=fixture();let allocate;const gate=new Promise(resolve=>{allocate=resolve;});let spawns=0;
    const manager=createSSHManager({payloadDir:f.payloadDir,userData:f.userData,choosePort:()=>gate,spawn:()=>{spawns++;throw new Error('must not spawn');}});
    try {
      const id='c'.repeat(32),pending=manager[method]({id,alias:'server'});pending.catch(()=>{});
      manager.disconnect(id);allocate(14318);
      await expect(pending).rejects.toThrow('取消');expect(spawns).toBe(0);expect(manager.list()[0].id).toBe(id);
    }finally{manager.dispose();await tick();f.cleanup();}
  }
  const f=fixture(),m=mock(f,{gate:true,timeoutMs:1000});try {
    const id='d'.repeat(32),pending=m.manager.inspect({id,alias:'server'});pending.catch(()=>{});await tick();
    m.manager.disconnect(id);await expect(pending).rejects.toThrow('取消');await tick();expect(m.calls.at(-1).child.killed).toBe(true);
  }finally{m.manager.dispose();await tick();f.cleanup();}
});

test('cancelled tunnel readiness aborts probes and terminates its owned tunnel',async()=> {
  const f=fixture();let signal;
  const m=mock(f,{installed:true,checkTunnel:async options=>{signal=options.signal;await new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('probe aborted')),{once:true}));}});
  try {
    const preview=await m.manager.inspect({alias:'server'});
    const pending=m.manager.connect(preview.profile);pending.catch(()=>{});
    await tick();m.manager.disconnect(preview.profile.id);
    await expect(pending).rejects.toThrow('取消');expect(signal.aborted).toBe(true);await tick();expect(m.tunnels[0].killed).toBe(true);
    expect(m.manager.list()[0].connected).toBe(false);
  }finally{m.manager.dispose();await tick();f.cleanup();}
});

function shell(script,f,input) {
  const result=cp.spawnSync('sh',['-c',script],{env:{...process.env,HOME:f.home},input,encoding:'utf8',timeout:20000,maxBuffer:128*1024});
  if(result.error)throw result.error;return result;
}

test.skipIf(process.platform!=='linux')('manager orchestrates real isolated shell inspection, upload and installation without touching projects',async()=> {
  const f=fixture();let ownedTunnel;
  const manager=createSSHManager({payloadDir:f.payloadDir,userData:f.userData,checkTunnel:async()=>{},spawn:(_command,args,options)=> {
    if(args.includes('-G'))return fakeChild({stdout:'hostname test.example\nuser test\nport 2222\n'});
    if(args.includes('-N')){ownedTunnel=fakeChild({}, {persistent:true});return ownedTunnel;}
    return cp.spawn('sh',['-c',args.at(-1)],{...options,env:{...options.env,HOME:f.home}});
  }});
  try {
    const preview=await manager.inspect({alias:'isolated'});expect(preview.requiresInstall).toBe(true);expect(fs.readdirSync(f.home)).toEqual([]);
    const result=await manager.connect(preview.profile,{install:true});expect(result.url).toBe(preview.profile.url);
    const root=path.join(f.home,'.local/share/lush/remote/versions',`${FP}-linux-x64`);expect(fs.existsSync(path.join(root,'remote.json'))).toBe(true);
    const again=await manager.inspect(preview.profile);expect(again.ready).toBe(true);
    manager.disconnect(preview.profile.id);await tick();expect(ownedTunnel.killed).toBe(true);expect(fs.existsSync(root)).toBe(true);
  }finally{manager.dispose();await tick();f.cleanup();}
});

test.skipIf(process.platform!=='linux')('real shell upload, hash verification and atomic install are repeatable with quoted HOME',()=> {
  const f=fixture();try {
    const payload=loadRemotePayload(f.payloadDir,'linux-x64'),name='trusted.tar.gz';
    expect(shell(uploadScript(name),f,payload.archive).stdout).toBe('LUSH_SSH_UPLOADED\n');
    const result=shell(installScript(payload,name),f);expect(result.stderr).toBe('');expect(result.status).toBe(0);expect(result.stdout).toBe('LUSH_SSH_INSTALLED\n');
    const installed=path.join(f.home,'.local/share/lush/remote/versions',`${FP}-linux-x64`);expect(fs.readFileSync(path.join(installed,'remote.json'),'utf8')).toBe(JSON.stringify(f.metadata));
    const before=fs.statSync(installed).ino;
    expect(shell(uploadScript(name),f,payload.archive).status).toBe(0);expect(shell(installScript(payload,name),f).status).toBe(0);expect(fs.statSync(installed).ino).toBe(before);
    const probe=shell(probeScript(payload),f);expect(probe.status).toBe(0);expect(probe.stdout).toContain('root_exists\tMQ==');
    const profile={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',port:14318};
    const started=shell(hostScript(payload,profile,{bun_path:process.execPath,bun_version:Bun.version}),f);expect(started.stderr).toBe('');expect(started.status).toBe(0);expect(started.stdout).toBe(`LUSH_SSH_HOST {"port":${REMOTE_PORT},"pid":1234}\n`);
    const changed=shell(hostScript(payload,{...profile,port:14319},{bun_path:process.execPath,bun_version:Bun.version}),f);expect(changed.status).not.toBe(0);expect(changed.stdout).toContain('HOST_START');
  }finally{f.cleanup();}
});

test.skipIf(process.platform!=='linux')('failed extraction or identity checks leave no installed version and do not overwrite old data',()=> {
  const f=fixture();try {
    const payload=loadRemotePayload(f.payloadDir,'linux-x64'),name='trusted.tar.gz';
    shell(uploadScript(name),f,Buffer.from('truncated'));
    const bad=shell(installScript(payload,name),f);expect(bad.status).not.toBe(0);expect(bad.stdout).toContain('ARCHIVE_HASH');
    const versions=path.join(f.home,'.local/share/lush/remote/versions');expect(fs.readdirSync(versions)).toEqual([]);
    const truncated=Buffer.from('truncated archive');
    fs.writeFileSync(path.join(f.home,'.local/share/lush/remote/uploads',name),truncated);
    const broken=shell(installScript({...payload,archiveSha256:SHA(truncated)},name),f);expect(broken.stdout).toContain('EXTRACT_FAILED');expect(fs.readdirSync(versions)).toEqual([]);
    fs.writeFileSync(path.join(f.home,'.local/share/lush/remote/uploads',name),payload.archive);
    const mismatch=shell(installScript({...payload,bunSha256:'0'.repeat(64)},name),f);expect(mismatch.stdout).toContain('BUN_HASH');expect(fs.readdirSync(versions)).toEqual([]);
    const root=path.join(versions,`${FP}-linux-x64`);fs.mkdirSync(root);fs.writeFileSync(path.join(root,'valuable'),'retain');
    const old=shell(installScript(payload,name),f);expect(old.status).not.toBe(0);expect(fs.readFileSync(path.join(root,'valuable'),'utf8')).toBe('retain');
  }finally{f.cleanup();}
});

test.skipIf(process.platform!=='linux')('interrupted real installation cleans its staging area without committing a version',async()=> {
  const f=fixture();let child,watcher,timer;try {
    const runtime=Buffer.from(`#!/bin/sh\nif [ "\${1:-}" = -e ]; then printf ready > "$HOME/verification.started"; sleep 30; fi\nexec ${shellQuote(process.execPath)} "$@"\n`);
    fs.writeFileSync(path.join(f.source,'bun'),runtime);
    const metadata={...f.metadata,bun_sha256:SHA(runtime)};fs.writeFileSync(path.join(f.source,'remote.json'),JSON.stringify(metadata));
    const archive=archiveDirectory(f.source);const payload={...loadRemotePayload(f.payloadDir,'linux-x64'),archive,bunSha256:SHA(runtime),archiveSha256:SHA(archive)};
    expect(shell(uploadScript('interrupt.tar.gz'),f,archive).status).toBe(0);
    const started=new Promise((resolve,reject)=> {
      watcher=fs.watch(f.home,(_event,name)=>{if(String(name)==='verification.started'){clearTimeout(timer);resolve();}});
      timer=setTimeout(()=>reject(new Error('install verification did not start')),3000);
    });
    child=cp.spawn('sh',['-c',installScript(payload,'interrupt.tar.gz')],{env:{...process.env,HOME:f.home},detached:true,stdio:['ignore','ignore','ignore']});
    const closed=new Promise(resolve=>child.once('close',resolve));
    await started;watcher.close();process.kill(-child.pid,'SIGTERM');await closed;
    const versions=path.join(f.home,'.local/share/lush/remote/versions');expect(fs.readdirSync(versions)).toEqual([]);
    expect(fs.existsSync(path.join(f.home,'.local/share/lush/remote/uploads/interrupt.tar.gz'))).toBe(true);
  }finally{clearTimeout(timer);watcher?.close();if(child?.exitCode===null){try{process.kill(-child.pid,'SIGKILL');}catch{}}f.cleanup();}
});

test.skipIf(process.platform!=='linux')('symlinked remote installation ancestors and active install locks are refused',()=> {
  const f=fixture();try {
    const outside=path.join(f.dir,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(f.home,'.local'));
    const result=shell(uploadScript('trusted.tar.gz'),f,Buffer.from('data'));expect(result.stdout).toContain('UNSAFE_DIRECTORY');expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(path.join(f.home,'.local'));
    const payload=loadRemotePayload(f.payloadDir,'linux-x64');shell(uploadScript('trusted.tar.gz'),f,payload.archive);
    const versions=path.join(f.home,'.local/share/lush/remote/versions');fs.mkdirSync(path.join(versions,`.lock-${FP}-linux-x64`));
    const locked=shell(installScript(payload,'trusted.tar.gz'),f);expect(locked.stdout).toContain('INSTALL_BUSY');expect(fs.existsSync(path.join(versions,`.lock-${FP}-linux-x64`))).toBe(true);
  }finally{f.cleanup();}
});
