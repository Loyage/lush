// Standalone real-browser regression: bun test/web/check-notice-banner-browser.js
// Temporary HTTP fixture only; Firefox + geckodriver, no daemon or model calls.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/styles.css"></head><body>
<section id="notice-banner" class="notice-banner" role="status" aria-live="polite" hidden></section>
<div id="notice-count"></div><div id="notices" hidden></div><div id="notice-record-detail" hidden></div>
<div id="toast" hidden><span id="error"></span><button id="toast-close">关闭</button></div>
<script type="module">
import { renderNoticeBanner } from '/assets/notice-banner.js';
import { renderNotices } from '/assets/render-notices.js';
import { ui, resetUiState } from '/assets/state.js';
import { registerNavigation } from '/assets/navigate.js';
import { setPref, readPref, normalizeNoticeChannels } from '/assets/prefs.js';
import { initHelp } from '/assets/help.js';
window.acks=[];window.opened=[];window.failRead=false;window.deferRead=false;window.pointerLog=[];
for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])document.addEventListener(type,e=>window.pointerLog.push({type:e.type,pointerType:e.pointerType,x:e.clientX,y:e.clientY,target:e.target.className,selection:getSelection().toString()}),true);
window.setRows=(ids)=>{resetUiState();window.acks=[];window.opened=[];window.data={notices:ids.map(id=>({id,task_id:4,kind:'info',status:'sent',source_event_id:id+100,read_at:null,lifecycle_type:'idle',title:'Worker 本轮结束 '+id+' · '+ '长告知标题测试截断'.repeat(30),created_at:'2026-10-01T00:00:00Z'}))};ui.lastSnapshot=window.data;window.paint();};
window.paint=()=>{renderNotices(window.data);renderNoticeBanner(window.data);};
window.fetch=async(url,opts)=>{const body=JSON.parse(opts.body);if(body.method!=='notice.read')return Response.json({error:'unexpected method'},{status:500});
if(window.deferRead)await new Promise(resolve=>window.releaseRead=resolve);
if(window.failRead)return Response.json({error:'fixture ACK failure'},{status:500});
const row=window.data.notices.find(n=>n.id===body.params.id);row.read_at='2026-10-02T00:00:00Z';window.acks.push(row.id);return Response.json(row);};
registerNavigation({refresh:async()=>window.paint(),detail:async id=>{window.opened.push(id);ui.selected=id;return true;}});
window.setChannels=value=>setPref('noticeChannels',value);window.setMotion=value=>{setPref('reduceMotion',value);document.documentElement.dataset.reducedMotion=String(value);};
initHelp();setPref('noticeChannels',normalizeNoticeChannels());window.setRows([1,2]);window.ready=true;
</script></body></html>`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/') return new Response('<!doctype html><html><body style="margin:0"><iframe id="viewport" src="/fixture" style="width:1440px;height:900px;border:0"></iframe></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (path === '/fixture') return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
  if (/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.split('/').at(-1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-notice-browser-')), log = join(temp, 'geckodriver.log');
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log),
});
let session, passed = false;
async function rpc(path, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('WebDriver request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text);
  if (response.status >= 400) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = script => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0];let n=0;const check=()=>(${script})?done(true):++n>100?done(false):setTimeout(check,20);check();`, args: [] });
const assert = (condition, message) => { if (!condition) throw Error(message); };
async function click(selector) {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function key(value) {
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }] });
}
async function enterViewport() {
  const frame = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' });
  await rpc(`/session/${session}/frame`, { id: frame });
}
async function resizeViewport(width, height) {
  await rpc(`/session/${session}/frame`, { id: null });
  await rpc(`/session/${session}/window/rect`, { width: Math.max(600, width + 50), height: height + 100 });
  await execute(`const frame=document.querySelector('#viewport');frame.style.width='${width}px';frame.style.height='${height}px';`);
  await enterViewport();
  assert(await execute(`return innerWidth===${width}`), 'fixture viewport width was not exact');
}
async function touch(dx, dy = 0) {
  const start = await execute(`const r=document.querySelector('.notice-banner-main').getBoundingClientRect();return {x:Math.round(r.x+r.width*.5),y:Math.round(r.y+r.height*.5)};`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: [
    { type: 'pointerMove', duration: 0, x: start.x, y: start.y }, { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', duration: 200, x: start.x + dx, y: start.y + dy }, { type: 'pointerUp', button: 0 },
  ] }] });
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw Error('geckodriver exited before startup'); await Bun.sleep(100);
  }
  assert(ready, 'geckodriver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1000 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  await enterViewport();
  assert(await wait('window.ready'), 'fixture did not load');
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1440,900],[390,844]]) {
    await resizeViewport(width, height);
    await execute(`document.documentElement.dataset.theme='${theme}';window.setRows([1,2]);`);
    assert(await execute(`const b=document.querySelector('.notice-banner-known'),r=b.getBoundingClientRect();return r.width>=44&&r.height>=44&&r.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth&&getComputedStyle(b).display!=='none';`), `clipped known button ${theme} ${width}`);
    await click('.notice-banner-known'); assert(await wait('window.acks.length===1'), 'known did not ACK');
    assert(await execute(`return window.acks[0]===2&&window.opened.length===0&&document.querySelector('.notice-banner-row').dataset.noticeId==='1';`), 'known did more than ACK latest');
    console.log(`PASS visible known button / latest-only ACK ${theme} ${width}x${height}`);
  }
  await execute(`window.setRows([10,11]);document.querySelector('.notice-banner-known').focus();`);
  await key('\uE007'); assert(await wait('window.acks.length===1'), 'Enter did not acknowledge');
  assert(await execute(`return document.activeElement.classList.contains('notice-banner-known')&&window.acks[0]===11;`), 'keyboard focus lost');
  await key(' '); assert(await wait('window.acks.length===2'), 'Space did not acknowledge next');
  await execute(`window.setRows([20]);window.failRead=true;`); await click('.notice-banner-known');
  assert(await wait(`document.querySelector('#error').textContent.includes('fixture ACK failure')`), 'ACK failure not reported');
  assert(await execute(`return !document.querySelector('.notice-banner-known').disabled&&window.acks.length===0&&document.querySelector('.notice-banner-row').dataset.noticeId==='20';`), 'ACK failure removed/disabled notice');
  await execute('window.failRead=false'); await click('.notice-banner-known'); assert(await wait('window.acks.length===1'), 'retry failed');
  await execute(`window.setRows([30,31]);window.deferRead=true;`); await click('.notice-banner-known');
  assert(await wait('!!window.releaseRead'), 'deferred ACK not entered');
  assert(await execute(`window.paint();return document.querySelector('.notice-banner-known').disabled;`), 'polling re-enabled ACK');
  await execute('window.deferRead=false;window.releaseRead()'); assert(await wait('window.acks.length===1'), 'deferred ACK failed');
  await execute(`window.setRows([40,41]);`); await touch(130);
  assert(await wait('window.acks.length===1'), 'real touch swipe did not ACK: '+JSON.stringify(await execute('return {events:window.pointerLog.slice(-30),error:document.querySelector("#error").textContent,opened:window.opened}')));
  assert(await execute(`return window.acks[0]===41&&window.opened.length===0;`), 'swipe opened Worker / wrong ACK');
  await execute(`document.querySelector('.notice-banner-main').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1}));`);
  assert(await execute('return window.opened.length===0'), 'synthetic click opened next Worker');
  await touch(-130); assert(await wait('window.acks.length===2'), 'left swipe failed');
  await execute(`window.setRows([50]);`); await touch(30); await touch(4,80);
  assert(await execute('return window.acks.length===0'), 'short/vertical touch ACKed');
  // Cancellation and text-selection guards use real DOM PointerEvents, not a stub.
  assert(await execute(`const row=document.querySelector('.notice-banner-row');const emit=(type,x)=>row.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:9,pointerType:'touch',isPrimary:true,clientX:x,clientY:10}));emit('pointerdown',20);emit('pointermove',150);emit('pointercancel',150);const title=row.querySelector('.notice-banner-title');const range=document.createRange();range.selectNodeContents(title);getSelection().removeAllRanges();getSelection().addRange(range);emit('pointerdown',20);emit('pointermove',150);emit('pointerup',150);getSelection().removeAllRanges();return window.acks.length===0;`), 'cancel/selection guard failed');
  await execute(`window.setMotion(true);window.setRows([60]);`);
  assert(await execute(`return getComputedStyle(document.querySelector('.notice-banner-dot')).animationName==='none'&&document.querySelector('#notice-banner').getAttribute('aria-live')==='polite'&&!!document.querySelector('.notice-banner-known').getAttribute('data-help');`), 'reduced-motion/accessibility missing');
  await execute(`window.setChannels({idle:{banner:false}});`);
  assert(await execute(`return document.querySelector('#notice-banner').hidden&&document.querySelector('#notice-count').textContent.includes('1 告知');`), 'channel setting altered unread count');
  console.log('PASS keyboard/focus, retry, single-flight, real touch left/right, synthetic-click, short/vertical/cancel/selection, reduced-motion, channel filtering');
  passed = true;
} catch (error) { console.error(`Browser check failed; geckodriver log: ${log}`); throw error; }
finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true });
}
