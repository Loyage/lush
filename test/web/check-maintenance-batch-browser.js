// Disposable Firefox fixture for the global batch reminder; no daemon, account or model access.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-maintenance-browser-'));
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const pathname = new URL(req.url).pathname;
  if (pathname === '/') return new Response('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/assets/styles.css"><link rel="stylesheet" href="/assets/styles-workbench.css"><div class="project-manager"><main class="workbench-view"></main></div>', { headers: { 'Content-Type': 'text/html' } });
  if (/^\/assets\/[\w.-]+\.(js|css)$/.test(pathname)) return new Response(Bun.file(new URL(pathname.slice(8), assets)));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const bidiReservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const bidiPort = bidiReservation.port; bidiReservation.stop(true);
let driver, session, socket, sequence = 0, passed = false;
const pending = new Map();
async function rpc(route, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', data => chunks.push(data));
      res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()).value })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(20000, () => req.destroy(new Error('WebDriver timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  if (response.status >= 400) throw new Error(JSON.stringify(response));
  return response.value;
}
async function bidi(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('BiDi timeout')); }, 10000);
    pending.set(id, value => { clearTimeout(timer); value.type === 'error' ? reject(new Error(value.message)) : resolve(value.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = script => rpc(`/session/${session}/execute/sync`, { script: `return (${script});`, args: [] });
const assert = (ok, message) => { if (!ok) throw new Error(message); };
try {
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port), '--websocket-port', String(bidiPort)], {
    env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(root, 'driver.log')), stderr: Bun.file(path.join(root, 'driver.log')),
  });
  let online = false;
  for (let n = 0; n < 100; n++) {
    try { await rpc('/status', undefined, 'GET'); online = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited');
    await Bun.sleep(100);
  }
  assert(online, 'geckodriver startup timeout');
  const created = await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', webSocketUrl: true, 'moz:firefoxOptions': { args: ['-headless'] } } } });
  session = created.sessionId; socket = new WebSocket(created.capabilities.webSocketUrl);
  socket.onmessage = event => { const message = JSON.parse(event.data); pending.get(message.id)?.(message); pending.delete(message.id); };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  const context = await rpc(`/session/${session}/window`, undefined, 'GET');
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await bidi('browsingContext.setViewport', { context, viewport: { width, height: 900 }, devicePixelRatio: 1 });
    const result = await rpc(`/session/${session}/execute/async`, { args: [], script: `const done=arguments[0]; (async()=>{
      const {serviceRestartControls}=await import('/assets/service-restart.js');
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const until=async fn=>{for(let n=0;n<100;n++){if(fn())return;await wait(10)}throw new Error('reminder did not settle')};
      document.documentElement.dataset.theme=${JSON.stringify(theme)};
      const A='aaaaaaaaaaaaaaaa',B='bbbbbbbbbbbbbbbb';
      const maintenance=(id,ready=false)=>({paused:true,phase:ready?'paused':'pausing',ready_to_restart:ready,
        batch_id:'00000000-0000-4000-8000-'+(id===A?'000000000001':'000000000002'),completion_state:ready?'completed':'pending',completion_notice_id:ready?7:null});
      const rows=()=>[A,B].map(id=>({id,name:'测试项目',project:'/tmp/'+id,running:true,summary:{maintenance:maintenance(id)}}));
      let state=rows(),calls=[],permissionCalls=0;
      Notification.requestPermission=()=>{permissionCalls++;throw new Error('must not request notification permission')};
      const section=serviceRestartControls({confirm:async()=>true,schedule:(fn,ms)=>setTimeout(fn,ms===0?0:10),request:async(url,opts)=>{
        calls.push({url,method:opts?.method});
        if(url==='/api/host')return {restart_supported:true,pid:1};
        if(url==='/api/host/projects')return {projects:state};
        if(opts?.method==='POST' && url.endsWith('/api/action'))return maintenance(url.includes(A)?A:B);
        throw new Error('unexpected write '+url);
      }});
      const main=document.querySelector('main');main.replaceChildren(section.root);await section.ready;section.updateProjects(state);
      await section.root.querySelector('[data-service-restart="pause"]').onclick();
      await until(()=>section.root.textContent.includes('当前 0/2'));
      if(section.root.querySelector('.maintenance-ready'))throw new Error('ACK was treated as completion');
      state=state.map(row=>({...row,summary:{maintenance:maintenance(row.id,true)}}));
      await until(()=>section.root.querySelector('.maintenance-ready'));
      const reminder=section.root.querySelector('.maintenance-ready'),r=reminder.getBoundingClientRect();
      if(r.left<0||r.right>innerWidth||r.width<100||document.documentElement.scrollWidth>innerWidth)throw new Error('ready reminder clipped');
      if(!reminder.textContent.includes('重启按钮仍会重新检查'))throw new Error('missing live readiness caveat');
      for(const button of section.root.querySelectorAll('button')){const box=button.getBoundingClientRect();if(box.width<44||box.height<44||box.right>innerWidth)throw new Error('control clipped')}
      const resume=section.root.querySelector('[data-service-restart="resume"]');if(!resume.classList.contains('agent-call')||!resume.dataset.help.includes('token'))throw new Error('missing Agent costs');
      resume.focus();if(document.activeElement!==resume)throw new Error('keyboard focus unavailable');
      state[1].summary.maintenance.ready_to_restart=false;await until(()=>!section.root.querySelector('.maintenance-ready'));
      section.dispose();const count=calls.length;await wait(40);
      if(calls.length!==count||calls.filter(c=>c.method==='POST').length!==2||permissionCalls)throw new Error('cleanup or write/permission boundary failed');
      return true;
    })().then(done,error=>done({error:error.message}));` });
    assert(result === true, `Firefox batch ${theme}/${width}: ${JSON.stringify(result)}`);
    console.log(`PASS batch pending → ready → busy, exact scope/no extra writes, cleanup, keyboard, ${theme}/${width}`);
  }
  passed = true;
} finally {
  try { if (session) await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {}
  socket?.close(); driver?.kill(); if (driver) await driver.exited; server.stop(true);
  if (passed) fs.rmSync(root, { recursive: true, force: true }); else console.error(`Browser diagnostic directory: ${root}`);
}
