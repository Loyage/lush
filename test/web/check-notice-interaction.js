// Real Firefox DOM/CSS/keyboard regression; isolated fixture, no user daemon.
// Run: bun test/web/check-notice-interaction.js (Firefox + geckodriver on PATH).
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/styles.css"></head><body>
<section id="notice-banner" class="notice-banner" role="status" aria-live="polite"></section>
<span id="notice-count"></span><div id="notices" hidden></div><div id="notice-record-detail" hidden></div><div id="error"></div>
<div id="detail">Scroll fixture</div><script type="module" src="/fixture.js"></script></body></html>`;
const fixture = `
import {renderNoticeBanner} from '/assets/notice-banner.js';
import {renderNotices,readNotice} from '/assets/render-notices.js';
import {ui} from '/assets/state.js';
import {setPref,normalizeNoticeChannels} from '/assets/prefs.js';
import {registerNavigation} from '/assets/navigate.js';
window.requests=[]; window.opened=[]; window.failRead=false; window.hold=false;
window.info=id=>({id,task_id:4,kind:'info',status:'sent',lifecycle_type:'idle',source_event_id:id,read_at:null,title:'Worker '+id+' '+('长标题确认截断 '.repeat(20)),created_at:'2026-10-02T12:00:00Z'});
window.paint=()=>{ui.lastSnapshot={notices:window.rows,status:{project:'/tmp/browser-notice'}};renderNotices(ui.lastSnapshot);renderNoticeBanner(ui.lastSnapshot);};
window.reset=()=>{ui.noticeReadRows=new Map();ui.noticeReadPending=new Map();window.rows=[info(1),info(2)];window.requests=[];window.opened=[];window.failRead=false;window.hold=false;setPref('noticeChannels',normalizeNoticeChannels());paint();};
registerNavigation({refresh:async()=>paint(),detail:async id=>{window.opened.push(id);return false;}});
window.fetch=async(url,options)=>{
  const {method,params}=JSON.parse(options.body);window.requests.push({method,params});
  if(window.hold)await new Promise(resolve=>window.release=resolve);
  if(window.failRead)return Response.json({error:'fixture ACK failure'},{status:500});
  const row=window.rows.find(row=>row.id===params.id);row.read_at='2026-10-02T13:00:00Z';return Response.json(row);
};
window.pointer=(type,x,y=20)=>document.querySelector('.notice-banner-row').dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'touch',isPrimary:true,clientX:x,clientY:y}));
window.setChannels=value=>setPref('noticeChannels',value);
window.setReduced=()=>document.documentElement.dataset.reducedMotion='true';
reset();window.ready=true;`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  const headers = { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'" };
  if (path === '/') return new Response(html, { headers: { ...headers, 'Content-Type': 'text/html' } });
  if (path === '/fixture.js') return new Response(fixture, { headers: { ...headers, 'Content-Type': 'text/javascript' } });
  if (/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.split('/').at(-1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-notice-browser-'));
const log = join(temp, 'geckodriver.log');
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
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('WebDriver timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw new Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const asyncExecute = script => rpc(`/session/${session}/execute/async`, { script, args: [] });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function click(selector) {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited'); await Bun.sleep(100);
  }
  assert(ready, 'geckodriver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  assert(await asyncExecute('const done=arguments[0];let n=0;const check=()=>window.ready?done(true):++n>100?done(false):setTimeout(check,30);check();'), 'fixture did not load');
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [390, 844]]) {
    await rpc(`/session/${session}/window/rect`, { width, height }); await execute(`reset();document.documentElement.dataset.theme='${theme}';`);
    const layout = await execute(`const row=document.querySelector('.notice-banner-row'),known=row.querySelector('.notice-banner-known'),r=known.getBoundingClientRect();return {viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,width:r.width,height:r.height,right:r.right,visible:getComputedStyle(known).display!=='none',touch:getComputedStyle(row).touchAction,live:document.querySelector('#notice-banner').getAttribute('aria-live')};`);
    assert(!layout.overflow && layout.visible && layout.width >= 44 && layout.height >= 44 && layout.right <= layout.viewport && layout.touch.includes('pan-y') && layout.live === 'polite', `invalid layout ${JSON.stringify(layout)}`);
    await click('.notice-banner-known');
    await asyncExecute('const done=arguments[0];setTimeout(()=>done(true),30);');
    assert(await execute(`return requests.length===1&&requests[0].method==='notice.read'&&requests[0].params.id===2&&opened.length===0&&document.querySelector('.notice-banner-row').dataset.noticeId==='1'&&rows.length===2;`), 'known navigation/scope/history violation');
    console.log(`PASS real layout/ACK ${theme} requested=${width}x${height} viewport=${layout.viewport}`);
  }
  await execute('reset();document.querySelector(".notice-banner-known").focus();');
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: ' ' }, { type: 'keyUp', value: ' ' }] }] });
  await asyncExecute('const done=arguments[0];setTimeout(()=>done(true),30);');
  assert(await execute(`return requests.length===1&&requests[0].params.id===2&&document.activeElement===document.querySelector('.notice-banner-known');`), 'Space ACK/focus failed');
  await execute('reset();window.failRead=true;'); await click('.notice-banner-known');
  const retry = await asyncExecute(`const done=arguments[0];setTimeout(()=>done({unread:rows.every(row=>!row.read_at),id:document.querySelector('.notice-banner-row')?.dataset.noticeId,disabled:document.querySelector('.notice-banner-known')?.disabled,error:document.querySelector('#error').textContent,requests}),30);`);
  assert(retry.unread && retry.id === '2' && !retry.disabled && retry.error.includes('fixture ACK failure'), `failure did not preserve/re-enable banner: ${JSON.stringify(retry)}`);
  // Real DOM PointerEvents with capture/cancel/selection; no physical device emulation.
  assert(await asyncExecute(`const done=arguments[0];reset();window.hold=true;pointer('pointerdown',180);pointer('pointermove',50);const original=document.querySelector('.notice-banner-row');rows.push(info(3));paint();const preserved=original===document.querySelector('.notice-banner-row');pointer('pointerup',50);setTimeout(()=>{release();setTimeout(()=>{document.querySelector('.notice-banner-info').dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,cancelable:true}));done(preserved&&requests.length===1&&requests[0].params.id===2&&opened.length===0&&!rows.find(row=>row.id===3).read_at);},20);},20);`), 'swipe polling/synthetic click protection failed');
  assert(await asyncExecute(`const done=arguments[0];reset();pointer('pointerdown',20);pointer('pointermove',23,100);pointer('pointerup',120,110);pointer('pointerdown',20);pointer('pointermove',45);pointer('pointerup',45);pointer('pointerdown',20);pointer('pointermove',140);pointer('pointercancel',140);const title=document.querySelector('.notice-banner-title');const range=document.createRange();range.selectNodeContents(title);getSelection().addRange(range);pointer('pointerdown',20);pointer('pointermove',140);pointer('pointerup',140);getSelection().removeAllRanges();setTimeout(()=>done(requests.length===0),20);`), 'vertical/short/cancel/selection triggered ACK');
  await execute(`reset();setChannels({idle:{banner:false}});`);
  assert(await execute(`return document.querySelector('#notice-banner').hidden&&document.querySelector('#notice-count').textContent.includes('2 告知')&&requests.length===0;`), 'channel filtering changed unread facts');
  await execute(`reset();setReduced();`);
  assert(await execute(`return getComputedStyle(document.querySelector('.notice-banner-dot')).animationName==='none';`), 'reduced motion failed');
  console.log('PASS keyboard/focus, failure retry, PointerEvents/polling/selection/click guards, preferences and reduced motion under CSP');
  passed = true;
} catch (error) { console.error(`Browser failure; geckodriver log: ${log}`); throw error; }
finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  driver.kill(); await driver.exited; server.stop(true); if (passed) await rm(temp, { recursive: true, force: true });
}
