import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { loadRemotePayload } from './ssh-payload.js';
import { probeScript, uploadScript, installScript, hostScript, shellQuote } from './ssh-scripts.js';

// New profiles use the trusted desktop's 32-hex identity; retain early UUID records without reallocating origins.
const ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_OUTPUT = 96 * 1024;
const safeText = value => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const options = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', 'ForwardAgent=no',
  '-o', 'PreferredAuthentications=publickey', '-o', 'PermitLocalCommand=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
  '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no'];
function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function check(value, code, message) { if (!value) throw fail(code, message); }
function sshFailure(stderr, status) {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return fail('SSH_HOST_KEY', 'SSH 主机身份尚未确认或发生变化；请先在终端核对服务器指纹，不能跳过主机校验。');
  if (/Permission denied|authentication failed|sign_and_send_pubkey/i.test(stderr)) return fail('SSH_AUTH', 'SSH 密钥或 ssh-agent 认证未就绪；请先在终端完成登录或解锁密钥。首期不支持界面内密码。');
  if (/Could not resolve hostname/i.test(stderr)) return fail('SSH_HOST', 'SSH 服务器地址无法解析；请检查系统 SSH 配置中的别名。');
  if (/Address already in use|cannot listen|forwarding failed/i.test(stderr)) return fail('PORT_BUSY', 'SSH 转发端口无法绑定；请释放该连接的本地端口。不会复用其它服务器的入口。');
  return fail('SSH_FAILED', `SSH 操作失败（退出 ${status ?? 'signal'}）；请在终端检查该 SSH 别名及远端环境。不会自动重试写操作。`);
}

function freePort(excluded) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({host: '127.0.0.1', port: 0, exclusive: true}, () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : excluded.has(port) ? freePort(excluded).then(resolve, reject) : resolve(port));
    });
  });
}
function assertFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(fail('PORT_BUSY', `此 SSH 连接固定使用本地端口 ${port}，当前被占用；请释放端口，不会静默切换登录身份。`)));
    server.listen({host:'127.0.0.1', port, exclusive:true}, () => server.close(error => error ? reject(error) : resolve()));
  });
}
function requestHost(port, signal) {
  return new Promise((resolve, reject) => {
    const request = http.get({host:'127.0.0.1', port, path:'/api/host', timeout:1000, signal, headers:{'Host':`127.0.0.1:${port}`}}, response => {
      let body = '', size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 96 * 1024) request.destroy(new Error('Host response too large')); else body += chunk; });
      response.on('error', reject);
      response.on('end', () => { try { check(response.statusCode === 200, 'TUNNEL_HOST', '转发入口没有返回受管 Host'); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('timeout', () => request.destroy(new Error('Host probe timeout')));
    request.on('error', reject);
  });
}
async function probeTunnel({port, pid, signal, timeoutMs}) {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const result = await requestHost(port, signal);
      check(result?.mode === 'host' && result.pid === pid, 'TUNNEL_HOST', 'SSH 隧道连接到了非预期的 Host');
      return;
    } catch (error) {
      if (error.code === 'TUNNEL_HOST') throw error;
      if (signal.aborted) break;
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 50); signal.addEventListener('abort', done, {once:true});
      });
    }
  }
  throw fail(signal.aborted ? 'CANCELLED' : 'TUNNEL_TIMEOUT', signal.aborted ? 'SSH 连接已取消。' : 'SSH 隧道启动超时；远端 Host 可能仍在运行，请检查状态后重连。');
}

function parseProbe(output) {
  const lines = output.split('\n').filter(line => line !== '');
  check(lines.shift() === 'LUSH_SSH_PROBE', 'REMOTE_OUTPUT', '远端预检输出无效；请移除非交互 SSH 登录脚本中的额外 stdout。');
  const keys = ['os','arch','home','uid','identity','bun_path','bun_version','git','pi','codex','tar','sha256sum','metadata','installed_bun_sha','root_exists'];
  const result = {};
  for (const line of lines) {
    const pair = line.split('\t');
    check(pair.length === 2 && keys.includes(pair[0]) && !Object.hasOwn(result,pair[0]) && /^[A-Za-z0-9+/]*={0,2}$/.test(pair[1]), 'REMOTE_OUTPUT', '远端预检字段无效');
    const bytes = Buffer.from(pair[1], 'base64');
    check(bytes.toString('base64') === pair[1] && bytes.length <= (pair[0] === 'metadata' ? 32768 : 8192), 'REMOTE_OUTPUT', '远端预检字段过长或编码无效');
    result[pair[0]] = bytes.toString('utf8');
  }
  check(keys.every(key => Object.hasOwn(result,key)), 'REMOTE_OUTPUT', '远端预检字段不完整');
  check(result.os === 'Linux' && ['x86_64','aarch64','arm64'].includes(result.arch), 'UNSUPPORTED_PLATFORM', '首期 SSH 自动部署只支持 Linux x64 / ARM64。');
  check(result.home.startsWith('/') && result.home !== '/' && safeText(result.home) && /^\d+$/.test(result.uid)
    && safeText(result.identity) && result.identity.length > 0, 'REMOTE_OUTPUT', '远端用户身份或 HOME 无效');
  for (const key of ['bun_path','git','pi','codex','tar','sha256sum']) check(!result[key] || result[key].startsWith('/') && safeText(result[key]), 'REMOTE_OUTPUT', '远端工具路径无效');
  check(!result.bun_version || /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(result.bun_version), 'REMOTE_OUTPUT', '远端 Bun 版本输出无效');
  check(['0','1'].includes(result.root_exists) && (!result.installed_bun_sha || HASH.test(result.installed_bun_sha)), 'REMOTE_OUTPUT', '远端安装状态无效');
  return result;
}
function compatibleBun(probe) { const match = /^1\.(\d+)\./.exec(probe.bun_version); return Boolean(probe.bun_path && match && Number(match[1]) >= 2); }

/** System SSH only; the remote page never receives this manager or an arbitrary execution capability. */
export function createSSHManager({payloadDir, payloadProvider, userData, spawn = cp.spawn, env = process.env, timeoutMs = 30000,
  tunnelTimeoutMs = 15000, choosePort = freePort, checkPort = assertFree, checkTunnel = probeTunnel, onState = () => {}} = {}) {
  const records = new Map(), operations = new Map(), tunnels = new Map(), children = new Set(), previews = new Map(), cancellations = new Map();
  let disposed = false, allocation = Promise.resolve();
  check(typeof userData === 'string' && userData, 'CONFIG', 'SSH 连接记录目录未配置');
  fs.mkdirSync(userData, {recursive:true, mode:0o700});
  const directory = fs.lstatSync(userData);
  check(directory.isDirectory() && !directory.isSymbolicLink() && (typeof process.getuid !== 'function' || directory.uid === process.getuid()), 'CONFIG', 'SSH 连接记录目录不安全');
  const store = path.join(userData, 'ssh-connections.json');
  const storedStat = fs.lstatSync(store, {throwIfNoEntry:false});
  if (storedStat) {
    const stat = storedStat;
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 128 * 1024 && (typeof process.getuid !== 'function' || stat.uid === process.getuid()), 'CONFIG', 'SSH 连接记录文件不安全');
    let state;
    try { state = JSON.parse(fs.readFileSync(store,'utf8')); } catch { throw fail('CONFIG', 'SSH 连接记录损坏；不会重置记录或复用旧登录端口。'); }
    check(state?.version === 1 && Array.isArray(state.profiles) && state.profiles.length <= 256, 'CONFIG', 'SSH 连接记录格式无效');
    const aliases = new Set(), ports = new Set();
    for (const item of state.profiles) {
      check(item && typeof item.id==='string' && ID.test(item.id) && typeof item.alias==='string' && ALIAS.test(item.alias) && Number.isInteger(item.port) && item.port >= 1024 && item.port <= 65535
        && (!item.identity || HASH.test(item.identity)) && !records.has(item.id) && !aliases.has(item.alias) && !ports.has(item.port), 'CONFIG', 'SSH 连接身份或端口记录无效');
      records.set(item.id, {id:item.id,alias:item.alias,port:item.port,identity:item.identity || null}); aliases.add(item.alias); ports.add(item.port);
    }
  }
  function persist() {
    check(!fs.lstatSync(store, {throwIfNoEntry:false})?.isSymbolicLink() && !fs.lstatSync(userData).isSymbolicLink(), 'CONFIG', 'SSH 连接记录不可为符号链接');
    const temporary = `${store}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify({version:1,profiles:[...records.values()]})+'\n', {mode:0o600,flag:'wx'}); fs.renameSync(temporary,store); }
    finally { fs.rmSync(temporary,{force:true}); }
  }
  const publicProfile = row => ({id:row.id,alias:row.alias,port:row.port,url:`http://127.0.0.1:${row.port}/`});
  function list() { return [...records.values()].map(row => ({...publicProfile(row),connected:tunnels.has(row.id),busy:operations.has(row.id)})); }
  function live() { check(!disposed,'DISPOSED','SSH 管理器已关闭'); }
  async function profile(input) {
    live();
    check(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => ['id','alias','port','url'].includes(key))
      && typeof input.alias === 'string' && ALIAS.test(input.alias), 'PROFILE', '请输入系统 SSH 配置中的安全 Host 别名；不接受命令、URL、密码或附加 SSH 参数。');
    check(input.id === undefined || typeof input.id==='string' && ID.test(input.id),'PROFILE','SSH 连接 ID 无效');
    input = {id:input.id,alias:input.alias}; // Never retain a mutable caller object across asynchronous allocation.
    const allocate = async () => {
      live();
      const existing = (input.id && records.get(input.id)) || [...records.values()].find(row => row.alias === input.alias);
      if (existing) {
        check(existing.alias === input.alias && (!input.id || existing.id === input.id), 'PROFILE', 'SSH 连接 ID 不属于此服务器；已有别名必须复用原连接 ID');
        return existing;
      }
      check(records.size < 256,'PROFILE','SSH 连接记录达到上限；不会复用其它服务器的端口');
      const port = await choosePort(new Set([...records.values()].map(row => row.port)));
      live(); check(Number.isInteger(port) && port >= 1024 && port <= 65535 && ![...records.values()].some(row => row.port === port), 'PORT_BUSY', '无法分配独立 SSH 转发端口');
      const item = {id:input.id || randomUUID().replaceAll('-',''),alias:input.alias,port,identity:null}; records.set(item.id,item); persist(); return item;
    };
    const result = allocation.then(allocate); allocation = result.catch(()=>{}); return result;
  }
  function notify(id,status,errorCode = null) { try { onState({id,status,errorCode}); } catch { /* client presentation cannot interfere with process ownership */ } }
  function terminate(child) {
    if (!children.has(child)) return;
    try { child.kill('SIGTERM'); } catch { /* close/error path still owns tracking */ }
    const timer = setTimeout(() => { if (children.has(child)) { try { child.kill('SIGKILL'); } catch { /* exited */ } } },1000);
    timer.unref?.(); child.once('close',()=>clearTimeout(timer));
  }
  function own(child,op) {
    children.add(child); child._lushSSHProfile = op.id;
    child.once('close',()=>children.delete(child));
    return child;
  }
  function childEnv() {
    // SendEnv in a user's SSH config must not accidentally transfer model credentials or invocation capabilities.
    const allowed = new Set(['PATH','HOME','USER','LOGNAME','SHELL','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA',
      'SYSTEMROOT','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','TMPDIR','SSH_AUTH_SOCK','SSH_AGENT_PID','LANG','LC_ALL','LC_CTYPE']);
    return {...Object.fromEntries(Object.entries(env).filter(([key])=>allowed.has(key))),SSH_ASKPASS_REQUIRE:'never'};
  }
  function run(op,args,input) {
    check(!op.controller.signal.aborted,'CANCELLED','SSH 操作已取消');
    return new Promise((resolve,reject) => {
      let child, stdout = '', stderr = '', size = 0, finished = false;
      const finish = (error, value) => { if (finished) return; finished=true; clearTimeout(timer); op.controller.signal.removeEventListener('abort',abort); if (error && child) terminate(child); error ? reject(error) : resolve(value); };
      const abort = () => finish(fail('CANCELLED','SSH 操作已取消；远端写操作可能已开始，请重新预检状态后操作。'));
      const timer = setTimeout(()=>finish(fail('SSH_TIMEOUT','SSH 操作超时；远端操作可能已执行，请先检查状态，不会自动重发。')),timeoutMs);
      op.controller.signal.addEventListener('abort',abort,{once:true});
      try { child=own(spawn('ssh',args,{env:childEnv(),stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false}),op); }
      catch (error) { finish(fail('SSH_EXEC',`无法启动系统 SSH：${error.code || 'spawn failed'}。请安装并配置系统 OpenSSH。`)); return; }
      child.stdout.on('data',chunk=> { size+=chunk.length; if (size>MAX_OUTPUT) finish(fail('SSH_OUTPUT','SSH 输出超过安全大小限制')); else stdout+=chunk; });
      child.stderr.on('data',chunk=> { size+=chunk.length; if (size>MAX_OUTPUT) finish(fail('SSH_OUTPUT','SSH 输出超过安全大小限制')); else stderr+=chunk; });
      child.once('error',error=>finish(fail('SSH_EXEC',`无法启动系统 SSH：${error.code || 'process error'}。`)));
      child.once('close',code=> {
        if (code !== 0) {
          const remote = /^LUSH_SSH_ERROR ([A-Z_]+)\n?$/.exec(stdout);
          finish(remote ? fail(remote[1],`远端受控步骤拒绝执行（${remote[1]}）；请检查安装目录、依赖或 profile 的 host.log。不会覆盖现有数据或自动重试。`) : sshFailure(stderr,code));
        } else finish(null,stdout);
      });
      child.stdin.on('error',()=> { /* early SSH auth failure may close stdin; close event classifies it */ });
      if (op.controller.signal.aborted) terminate(child);
      child.stdin.end(input);
    });
  }
  function script(op,row,text,input) {
    return run(op,[...options,'-o','ClearAllForwardings=yes','--',row.alias,input === undefined ? 'sh -s' : `sh -c ${shellQuote(text)}`],input === undefined ? text : input);
  }
  async function configuration(op,row) {
    const output = await run(op,['-G',...options,'--',row.alias]);
    const selected = {};
    for (const line of output.split('\n').filter(Boolean)) {
      const space = line.indexOf(' '); check(space>0 && safeText(line),'SSH_CONFIG','系统 SSH 配置输出无效');
      const key=line.slice(0,space), value=line.slice(space+1);
      check(!['localforward','remoteforward','dynamicforward'].includes(key),'SSH_CONFIG','请为 Lush 使用不预设端口转发的 SSH 别名；转发由桌面独立管理。');
      if (['hostname','user','port','proxyjump','proxycommand','hostkeyalias'].includes(key)) selected[key]=value;
    }
    check(selected.hostname && selected.user && /^\d+$/.test(selected.port),'SSH_CONFIG','SSH 别名缺少有效的主机、用户或端口配置');
    return hash(JSON.stringify(Object.entries(selected).sort(([a],[b])=>a.localeCompare(b))));
  }
  function bind(row,probe,configHash) {
    const identity=hash(JSON.stringify([configHash,probe.identity,probe.uid,probe.home]));
    check(!row.identity || row.identity===identity,'REMOTE_CHANGED','此 SSH 别名的目标或用户身份已变化；请使用新的 SSH 别名和连接记录，不能复用旧登录入口。');
    if (!row.identity) { row.identity=identity; persist(); }
  }
  async function preflight(op,row,fixedPayload = null) {
    const configHash=await configuration(op,row);
    const initial=parseProbe(await script(op,row,probeScript(null))); bind(row,initial,configHash);
    const target=initial.arch==='x86_64' ? 'linux-x64' : 'linux-arm64';
    const payload=fixedPayload || (payloadProvider ? payloadProvider.resolve(target) : loadRemotePayload(payloadDir,target));
    check(payload.target===target,'PREVIEW_REQUIRED','下载期间远端架构发生变化，请重新预检');
    const probe=parseProbe(await script(op,row,probeScript(payload))); bind(row,probe,configHash);
    check(probe.arch===initial.arch,'REMOTE_CHANGED','远端平台在预检期间发生变化，请重新连接');
    check(probe.tar && probe.sha256sum,'MISSING_TOOLS','远端缺少 tar 或 sha256sum，请先准备基础工具；不会安装系统软件。');
    let installed=false;
    if (probe.root_exists==='1' && !payload.download) {
      let metadata; try { metadata=JSON.parse(probe.metadata); } catch { throw fail('INSTALL_IDENTITY','远端版本目录已存在但元数据无效；不会覆盖或删除它。'); }
      check(metadata && typeof metadata==='object' && metadata.version===1 && metadata.target===target && metadata.fingerprint===payload.fingerprint && metadata.lush_version===payload.lushVersion
        && metadata.bun_version===payload.bunVersion && metadata.bun_sha256===payload.bunSha256 && probe.installed_bun_sha===payload.bunSha256,
      'INSTALL_IDENTITY','远端版本目录或私有 Bun 身份不匹配；不会覆盖或删除它。'); installed=true;
    }
    const warnings=[];
    if (!probe.git) warnings.push('远端未发现 Git：连接界面不代表项目已具备开发条件。');
    if (!probe.pi && !probe.codex) warnings.push('远端未发现 Pi/Codex：请另行安装并认证 Agent，不会复制本地凭证。');
    warnings.push('仅检测工具是否存在，未验证 Agent 登录或调用模型。');
    if (payload.download) warnings.push('本机缺少匹配运行包：确认安装后才从固定 GitHub Release 下载并校验；发布不存在或下载失败时不安装。远端已有目录也须在下载后重新校验。');
    const plan={alias:row.alias,target,remoteHome:probe.home,installDirectory:`${probe.home}/.local/share/lush/remote/versions/${payload.fingerprint}-${target}`,
      version:payload.lushVersion,fingerprint:payload.fingerprint,bunVersion:compatibleBun(probe) ? probe.bun_version : payload.bunVersion,
      privateBun:true,useExistingBun:compatibleBun(probe),privateBunVersion:payload.bunVersion,uploadBytes:payload.archive?.length ?? null,hostScope:`${probe.home}/.local/share/lush/remote/profiles/${row.id}`,
      origin:`http://127.0.0.1:${row.port}`,...(payload.download ? {download:payload.download} : {}),
      operations:installed ? ['复用匹配版本','启动或连接回环 Host','建立 SSH 隧道'] : [...(payload.download ? ['从固定 GitHub Release 下载并校验','重新预检远端安装状态'] : []),'上传并校验运行包（已安装则复用）','原子安装用户级 Lush 与私有 Bun','启动回环 Host','建立 SSH 隧道'],
      agentAuthenticationChecked:false};
    return {public:{profile:publicProfile(row),ready:installed,requiresInstall:!installed,plan,warnings},payload,probe,signature:hash(JSON.stringify([row.identity,plan,payload.archiveSha256]))};
  }
  async function operation(row,kind,action) {
    live();
    const current=operations.get(row.id);
    if (current) { check(current.kind===kind,'BUSY','此 SSH 连接正在执行其它步骤，请等待或取消'); return current.promise; }
    check(![...children].some(child=>child._lushSSHProfile===row.id && ![...tunnels.values()].some(t=>t.child===child)), 'BUSY','前一个 SSH 子进程尚未退出，暂不启动新的操作');
    const op={id:row.id,kind,controller:new AbortController(),promise:null};
    op.promise=Promise.resolve().then(()=>action(op)).finally(()=> { if (operations.get(row.id)===op) operations.delete(row.id); });
    operations.set(row.id,op); return op.promise;
  }
  async function inspect(input) {
    if (input && typeof input==='object' && !Array.isArray(input)) input={...input};
    const generation=cancellations.get(input?.alias) || 0, idGeneration=cancellations.get(input?.id) || 0;
    const row=await profile(input);
    check((cancellations.get(row.alias) || 0)===generation && (!input.id || (cancellations.get(row.id) || 0)===idGeneration),'CANCELLED','SSH 操作已取消');
    return operation(row,'inspect',async op=> { const result=await preflight(op,row); previews.set(row.id,result.signature); return result.public; });
  }
  function tunnel(op,row,host) {
    live(); check(!op.controller.signal.aborted,'CANCELLED','SSH 连接已取消');
    return new Promise((resolve,reject)=> {
      let child, stderr='', size=0, ready=false, settled=false;
      const probeController=new AbortController();
      const finish=error=> { if (settled) return; settled=true; clearTimeout(timer); op.controller.signal.removeEventListener('abort',abort); if (error) { probeController.abort(); if(child) terminate(child); reject(error); } else { ready=true; tunnels.set(row.id,{child,port:row.port,pid:host.pid}); notify(row.id,'connected'); resolve({url:`http://127.0.0.1:${row.port}/`,profile:publicProfile(row)}); } };
      const timer=setTimeout(()=>finish(fail('TUNNEL_TIMEOUT','SSH 隧道启动超时；远端 Host 可能仍在运行，请检查状态后重连。')),tunnelTimeoutMs);
      const abort=()=>finish(fail('CANCELLED','SSH 隧道已取消；远端 Host / daemon 不会被停止。'));
      op.controller.signal.addEventListener('abort',abort,{once:true});
      try { child=own(spawn('ssh',[...options,'-N','-o','ExitOnForwardFailure=yes','-L',`127.0.0.1:${row.port}:127.0.0.1:${host.port}`,'--',row.alias],
        {env:childEnv(),stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false}),op); }
      catch(error) { finish(fail('SSH_EXEC',`无法启动系统 SSH：${error.code || 'spawn failed'}。`)); return; }
      const data=(chunk,isError)=> { size+=chunk.length; if(size>MAX_OUTPUT) { if(ready) terminate(child); else finish(fail('SSH_OUTPUT','SSH 隧道输出超过安全大小限制')); } else if(isError) stderr+=chunk; };
      child.stdout.on('data',chunk=>data(chunk,false)); child.stderr.on('data',chunk=>data(chunk,true));
      child.once('error',()=>finish(fail('SSH_EXEC','无法启动系统 SSH 隧道。')));
      child.once('close',code=> { if(ready) { if(tunnels.get(row.id)?.child===child) tunnels.delete(row.id); notify(row.id,'disconnected','SSH_DISCONNECTED'); } else finish(sshFailure(stderr,code)); });
      Promise.resolve().then(()=>checkTunnel({port:row.port,pid:host.pid,signal:probeController.signal,timeoutMs:tunnelTimeoutMs})).then(()=>finish(),finish);
    });
  }
  async function connect(input,{install=false}={}) {
    check(typeof install==='boolean','PROFILE','安装授权必须为布尔值');
    if (input && typeof input==='object' && !Array.isArray(input)) input={...input};
    const generation=cancellations.get(input?.alias) || 0, idGeneration=cancellations.get(input?.id) || 0;
    const row=await profile(input);
    check((cancellations.get(row.alias) || 0)===generation && (!input.id || (cancellations.get(row.id) || 0)===idGeneration),'CANCELLED','SSH 操作已取消');
    return operation(row,'connect',async op=> {
      if(tunnels.has(row.id)) return {url:`http://127.0.0.1:${row.port}/`,profile:publicProfile(row),reused:true};
      await checkPort(row.port);
      let result=await preflight(op,row);
      if(result.public.requiresInstall) {
        check(install,'INSTALL_REQUIRED','需要首次安装远端 Lush；请先预检并明确确认安装计划。');
        check(previews.get(row.id)===result.signature,'PREVIEW_REQUIRED','安装计划尚未确认或已变化，请重新预检后确认。');
        previews.delete(row.id);
        if(result.payload.download) {
          const confirmed=result;
          const payload=await payloadProvider.download(result.payload.target,{signal:op.controller.signal});
          check(!op.controller.signal.aborted,'CANCELLED','SSH 下载已取消，不会上传或安装');
          check(!payload.download && payload.fingerprint===confirmed.payload.fingerprint && payload.lushVersion===confirmed.payload.lushVersion
            && payload.bunVersion===confirmed.payload.bunVersion,'PAYLOAD_INVALID','下载运行包与已确认计划不一致');
          result=await preflight(op,row,payload);
          const stablePlan=plan=>Object.fromEntries(Object.entries(plan).filter(([key])=>!['download','operations','uploadBytes'].includes(key)));
          check(JSON.stringify(stablePlan(result.public.plan))===JSON.stringify(stablePlan(confirmed.public.plan)),
            'PREVIEW_REQUIRED','下载期间服务器或安装计划发生变化，请重新预检后确认');
        }
      }
      if(result.public.requiresInstall) {
        const upload=`${row.id}-${randomUUID()}.tar.gz`;
        check(await script(op,row,uploadScript(upload),result.payload.archive)==='LUSH_SSH_UPLOADED\n','REMOTE_OUTPUT','运行包上传返回值无效');
        check(await script(op,row,installScript(result.payload,upload))==='LUSH_SSH_INSTALLED\n','REMOTE_OUTPUT','运行包安装返回值无效');
        previews.delete(row.id);
      }
      const output=await script(op,row,hostScript(result.payload,row,result.probe));
      const match=/^LUSH_SSH_HOST (\{[^\n]*\})\n?$/.exec(output); check(match,'REMOTE_OUTPUT','远端 Host 启动输出无效');
      let host; try { host=JSON.parse(match[1]); } catch { throw fail('REMOTE_OUTPUT','远端 Host 输出不是 JSON'); }
      check(Number.isInteger(host.port) && host.port>0 && host.port<=65535 && Number.isSafeInteger(host.pid) && host.pid>0
        && Object.keys(host).every(key=>['port','pid'].includes(key)),'REMOTE_OUTPUT','远端 Host 端口或身份无效');
      return {...await tunnel(op,row,host),warnings:result.public.warnings};
    });
  }
  function disconnect(id) {
    const row=records.get(id) || [...records.values()].find(item=>item.alias===id);
    if(!row) { if (typeof id==='string' && ALIAS.test(id)) { cancellations.set(id,(cancellations.get(id)||0)+1); return true; } return false; }
    cancellations.set(row.alias,(cancellations.get(row.alias)||0)+1);
    cancellations.set(row.id,(cancellations.get(row.id)||0)+1);
    previews.delete(row.id);
    operations.get(row.id)?.controller.abort();
    const ownTunnel=tunnels.get(row.id); if(ownTunnel) { tunnels.delete(row.id); terminate(ownTunnel.child); }
    for(const child of children) if(child._lushSSHProfile===row.id) terminate(child);
    notify(row.id,'disconnected'); return true;
  }
  function dispose() { if(disposed) return; disposed=true; for(const row of records.values()) disconnect(row.id); }
  return {list,inspect,connect,disconnect,dispose};
}
