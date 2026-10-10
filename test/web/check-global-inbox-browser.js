// Isolated real Firefox/CSP fixture. No project daemon or user settings are touched.
// Run: bun run test/web/check-global-inbox-browser.js (Firefox + geckodriver).
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb';
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/styles.css"><link rel="stylesheet" href="/assets/styles-workbench.css"><link rel="stylesheet" href="/assets/styles-global-inbox.css"></head><body><div id="fixture-viewport"><main id="detail"></main></div><div id="modal"></div><script type="module" src="/fixture.js"></script></body></html>`;
const fixture = `
import {openGlobalInbox} from '/assets/global-inbox.js';
import {initHelp} from '/assets/help.js';
import {ui} from '/assets/state.js';
window.requests=[];window.writes=[];window.resetDraft=()=>{ui.questionDrafts.clear();sessionStorage.clear();};
const record={project_id:'${B}',project_name:'来源项目 B',project:'/tmp/b',online:true,checked_at:'2026-10-09T10:00:00Z',notice:{id:7,task_id:21,task_worker_number:'W162-1',status:'open',kind:'questionnaire',title:'需要决定',created_at:'2026-10-09T09:00:00Z',sync_identity:'${'1'.repeat(32)}',sync_revision:1,sync_epoch:'${'e'.repeat(32)}',body:JSON.stringify({version:1,questions:[{header:'方案',question:'决定 W162-1 的执行方案？',options:[{label:'方案 A',description:'参考 W162-1 的结果',previewHtml:'<p>来源项目 B 的静态预览</p>'},{label:'方案 B',description:'保持现状'}]}]})}};
const info={...record,notice:{...record.notice,id:8,status:'sent',kind:'info',title:'本轮已结束',body:'告知无需答复',source_event_id:30,read_at:null}};
window.fetch=async (url,options={})=>{
 requests.push(url);if(options.body){writes.push(JSON.parse(options.body));record.notice.status='answered';record.notice.answer=JSON.parse(options.body).answer;record.notice.answer_source='user';record.notice.sync_revision++;return Response.json(record);}
 if(url.includes('/notice?'))return Response.json(url.includes('id=8')?info:record);
 return Response.json({version:1,items:[record,info],cursor:null,has_more:false,complete:record.online,projects:[{id:'${B}',name:'来源项目 B',online:record.online,complete:true,checked_at:record.checked_at,error:record.online?null:'离线'}]});
};
window.paint=async online=>{record.online=online;await openGlobalInbox({projectId:'${B}',noticeId:7,push:false});};
window.paintInfo=()=>openGlobalInbox({projectId:'${B}',noticeId:8,push:false});
window.helpEvents=[];for(const type of ['keydown','focusin','focusout','scroll','pointerover','pointerout','click'])document.addEventListener(type,event=>{helpEvents.push({type,key:event.key,target:event.target.tagName,text:event.target.textContent?.slice(0,32),at:performance.now()});if(helpEvents.length>40)helpEvents.shift()},true);
initHelp();await paint(true);window.ready=true;`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  const headers = { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'" };
  if (path === '/' || path === `/p/${B}/`) return new Response(html, { headers: { ...headers, 'Content-Type': 'text/html' } });
  if (path === '/fixture.js') return new Response(fixture, { headers: { ...headers, 'Content-Type': 'text/javascript' } });
  if (path === `/p/${B}/api/worker/21/notice/7/preview/0/0`) return new Response('<!doctype html><p>来源项目 B 的静态预览</p>', { headers: { ...headers, 'Content-Type': 'text/html' } });
  if (/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.split('/').at(-1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-global-inbox-browser-'));
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
const assert = (value, message) => { if (!value) throw new Error(message); };
const wait = condition => asyncExecute(`const done=arguments[0];let n=0;const check=()=>(${condition})?done(true):++n>100?done(false):setTimeout(check,30);check();`);
// A new tab's about:blank document can disappear during execute/async and settle it with null.
// Poll WebDriver's top-level URL instead; this bounded fixture wait survives that navigation.
async function waitUrl(target) {
  for (let i = 0; i < 100; i++) {
    if (await rpc(`/session/${session}/url`, undefined, 'GET') === target) return true;
    await Bun.sleep(30);
  }
  return false;
}
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
  assert(await wait('window.ready'), 'fixture did not load');
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [390, 844], [320, 844]]) {
    await rpc(`/session/${session}/window/rect`, { width, height });
    await asyncExecute(`const done=arguments[0];document.documentElement.dataset.theme='${theme}';const viewport=document.getElementById('fixture-viewport');viewport.style.width='${width}px';viewport.style.maxWidth='100%';resetDraft();paint(true).then(done);`);
    assert(await execute(`const viewport=document.getElementById('fixture-viewport');return viewport.scrollWidth<=viewport.clientWidth&&document.documentElement.scrollWidth<=innerWidth&&!document.querySelector('button a')&&document.querySelector('iframe').getAttribute('src')==='/p/${B}/api/worker/21/notice/7/preview/0/0'&&document.querySelector('.worker-link').target==='_blank'&&requests.every(url=>url.startsWith('/api/host/'));`), 'layout/source routing/CSP preview/nested control failed');
    assert(await execute(`const rows=document.querySelectorAll('.global-inbox-row'),q=rows[0],i=rows[1];return q.tagName==='A'&&q.getAttribute('href')==='/p/${B}/#notices-7'&&i.getAttribute('href')==='/p/${B}/#notices-8'&&i.target==='_blank'&&getComputedStyle(q.querySelector('.goal')).color!==getComputedStyle(i.querySelector('.goal')).color&&getComputedStyle(q).backgroundColor!==getComputedStyle(i).backgroundColor;`), 'source record links or decision/info colors are indistinguishable');
    const questionColor = await execute(`return getComputedStyle(document.querySelector('.global-inbox-detail')).backgroundColor;`);
    await asyncExecute('const done=arguments[0];paintInfo().then(done);');
    assert(await execute(`return getComputedStyle(document.querySelector('.global-inbox-detail')).backgroundColor!==${JSON.stringify(questionColor)}&&!document.querySelector('textarea')&&writes.length===0;`), 'info detail uses decision color or performs a mutation');
    await asyncExecute('const done=arguments[0];paint(false).then(done);');
    assert(await execute(`return !document.querySelector('iframe')&&detail.textContent.includes('静态预览暂不可读取')&&writes.length===0;`), 'offline preview/mutation guard failed');
    await execute(`const input=document.querySelector('textarea');input.value='离线草稿';input.dispatchEvent(new Event('input',{bubbles:true}));`);
    await execute(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='汇总确认').click();`);
    await execute(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认全部选择并继续 Worker').parentElement.scrollIntoView({block:'center'});`);
    await asyncExecute('const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));');
    await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE004' }, { type: 'keyUp', value: '\uE004' }] }] });
    // Tab may queue native scrolling after focus; scrolling intentionally cancels
    // help dwell. Settle that navigation and place the host before starting dwell.
    await execute(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认全部选择并继续 Worker').parentElement.scrollIntoView({block:'center'});`);
    await asyncExecute('const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));');
    assert(await execute(`const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认全部选择并继续 Worker'),h=b.parentElement,r=h.getBoundingClientRect();h.blur();h.focus({preventScroll:true});return document.getElementById('fixture-viewport').scrollWidth<=document.getElementById('fixture-viewport').clientWidth&&b.disabled&&h===document.activeElement&&r.width>0&&r.height>0&&h.getAttribute('tabindex')==='0';`), 'disabled help must be a real focusable box');
    const helpVisible = await wait(`document.activeElement.getAttribute('aria-describedby')==='help-tip'&&!document.getElementById('help-tip').hidden&&document.getElementById('help-tip').textContent.includes('离线')`);
    if (!helpVisible) console.error(await execute(`return {events:helpEvents,active:document.activeElement.outerHTML,tip:document.getElementById('help-tip')?.outerHTML};`));
    assert(helpVisible, 'keyboard dwell must display accessible offline help');
    await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
    assert(await execute('return writes.length===0;'), 'Enter on disabled help submitted a decision');
    await asyncExecute('const done=arguments[0];paint(true).then(done);');
    assert(await execute(`return detail.textContent.includes('离线草稿')&&Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认全部选择并继续 Worker').classList.contains('agent-call');`), 'source-scoped draft or Agent label was lost');
    console.log(`PASS ${theme} ${width}x${height}: layout, source links/preview, offline guard, accessible help, draft restoration`);
  }
  const original = await rpc(`/session/${session}/window`, undefined, 'GET');
  await click('.global-inbox-row');
  const handles = await rpc(`/session/${session}/window/handles`, undefined, 'GET');
  assert(handles.length === 2, 'Message did not open an independent project tab');
  await rpc(`/session/${session}/window`, { handle: handles.find(handle => handle !== original) });
  assert(await waitUrl(`http://127.0.0.1:${server.port}/p/${B}/#notices-7`), `Message tab did not preserve source project identity: ${await rpc(`/session/${session}/url`, undefined, 'GET')}`);
  await rpc(`/session/${session}/window`, undefined, 'DELETE'); await rpc(`/session/${session}/window`, { handle: original });
  assert(await execute(`return detail.textContent.includes('离线草稿')&&writes.length===0;`), 'opening source Worker destroyed draft or answered a question');
  console.log('PASS source message opens its exact project record in a new tab and preserves original draft');
  await execute(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认全部选择并继续 Worker').click();`);
  assert(await wait(`detail.textContent.includes('用户答复')&&!document.querySelector('textarea')`), 'durable questionnaire ACK was not applied immediately');
  assert(await execute(`return writes.length===1&&writes[0].project_id==='${B}'&&writes[0].id===7&&writes[0].method==='notice.answer'&&writes[0].expected_identity==='${'1'.repeat(32)}';`), 'questionnaire write lost source identity or ran twice');
  console.log('PASS explicit final questionnaire confirmation and ACK/read-only transition');
  passed = true;
} catch (error) { console.error(`Browser failure; geckodriver log: ${log}`); throw error; }
finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  driver.kill(); await driver.exited; server.stop(true); if (passed) await rm(temp, { recursive: true, force: true });
}
