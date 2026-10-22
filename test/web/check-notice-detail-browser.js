// Isolated Firefox regression: real page shell/modules, no daemon, account or Agent calls.
// Run: bun run test/web/check-notice-detail-browser.js
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const html = (await Bun.file(join(assets, 'index.html')).text())
  .replace('<script src="/appearance.js" type="module"></script>', '')
  .replace('src="/app.js"', 'src="/fixture.js"');
const fixture = `
import {initSidebar} from '/sidebar-init.js';
import {initNoticeRecords,renderNotices,openNotice} from '/render-notices.js';
import {openResource,activateDetailView,toggleMobileNavigation} from '/sidebar-ui.js';
import {registerNavigation} from '/navigate.js';
import {ui} from '/state.js';
window.ui=ui;window.writes=[];window.failRead=false;
const body=JSON.stringify({version:1,questions:[{header:'布局',question:'选择哪种布局？',options:[{label:'独立页面',description:'完整问卷与记录'},{label:'内联展开',description:'保留旧布局'}]}]});
const rows=[{id:9,task_id:1,task_worker_number:'W238',kind:'question',status:'open',title:'独立决策详情 · '+ '较长标题'.repeat(20),body:'原始问题正文，请明确答复。',created_at:'2026-01-01T00:00:00Z'},
{id:8,task_id:1,task_worker_number:'W238',kind:'questionnaire',status:'answered',answer_source:'user',title:'历史问卷',body,answer:JSON.stringify({answers:[{selected:[0],custom:''}]}),created_at:'2026-01-01T00:00:00Z'}];
const snapshot=()=>({revision:1,notices:structuredClone(rows)});
window.fetch=async(url,options={})=>{const path=new URL(url,location.origin);
if(path.pathname==='/api/worker/1')return Response.json({id:1,worker_number:'W238'});
if(path.pathname==='/api/notices'){if(failRead)return Response.json({error:'fixture read failure'},{status:500});const before=Number(path.searchParams.get('before')||Infinity);const status=path.searchParams.get('status')||'all';const matching=rows.filter(row=>row.id<before&&(status==='all'||row.status===status));return Response.json({notices:matching.slice(0,Number(path.searchParams.get('limit')||30)),cursor:null,has_more:false});}
if(path.pathname==='/api/action'){const {method,params}=JSON.parse(options.body);writes.push({method,params});const row=rows.find(row=>row.id===params.id);row.status='answered';row.answer=params.answer;row.answer_source='user';return Response.json(row);}
return Response.json({error:'unexpected fixture request '+url},{status:500});};
registerNavigation({refresh:async()=>renderNotices(snapshot()),detail:async id=>{activateDetailView({view:'task',key:'task-'+id,hash:'#worker-'+id});document.querySelector('#detail').textContent='Worker 上下文 W238';return true;}});
initSidebar();initNoticeRecords();renderNotices(snapshot());
async function route(){const id=/^#notices-([1-9]\\d*)$/.exec(location.hash)?.[1];if(id)await openNotice(Number(id),{record:true,push:false});else openResource('notices',{push:false});}
addEventListener('hashchange',route);document.querySelector('#view-back').onclick=()=>history.back();
document.querySelector('#sidebar-toggle').onclick=()=>toggleMobileNavigation();
window.poll=()=>renderNotices(snapshot());await route();window.ready=true;
`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/') {
    const url = new URL(req.url), record = /^[1-9]\d*$/.test(url.searchParams.get('record') || '') ? `-${url.searchParams.get('record')}` : '';
    return new Response(`<!doctype html><html><body style="margin:0"><iframe id="viewport" src="/fixture${url.search}#notices${record}" style="width:1440px;height:900px;border:0"></iframe></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  }
  if (path === '/fixture' || path === '/full') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  if (path === '/fixture.js') return new Response(fixture, { headers: { 'Content-Type': 'text/javascript' } });
  if (path === '/administrator/project-protocol.js') return new Response(Bun.file(new URL('../../src/administrator/project-protocol.js', import.meta.url)));
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-notice-detail-browser-')), log = join(temp, 'geckodriver.log');
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
async function wait(condition) {
  for (let n = 0; n < 100; n++) {
    try { if (await execute(`return Boolean(window.ready&&(${condition}));`)) return true; }
    catch (error) { if (!error.message.includes('Document was unloaded')) throw error; }
    await Bun.sleep(30);
  }
  return false;
}
const assert = (value, message) => { if (!value) throw new Error(message); };
async function click(selector) {
  await execute(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});`);
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function enterViewport(width, height) {
  await execute(`const frame=document.querySelector('#viewport');frame.style.width='${width}px';frame.style.height='${height}px';`);
  const frame = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' });
  await rpc(`/session/${session}/frame`, { id: frame });
  assert(await wait('window.ready'), 'fixture did not load');
  assert(await execute(`return innerWidth===${width}`), 'viewport width was not exact');
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited'); await Bun.sleep(100);
  }
  assert(ready, 'geckodriver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [390, 844], [320, 780]]) {
    await rpc(`/session/${session}/frame`, { id: null });
    await rpc(`/session/${session}/window/rect`, { width: Math.max(600, width + 50), height: height + 100 });
    const mobile = width < 500;
    await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/${mobile ? '' : 'full'}?case=${theme}-${width}${mobile ? '' : '#notices'}` });
    if (mobile) await enterViewport(width, height);
    assert(await wait('document.querySelector("#notices a")'), 'list did not load');
    await execute(`document.documentElement.dataset.theme='${theme}';`);
    await click('#notices a[href="#notices-9"]');
    assert(await wait('document.querySelector("#notice-record-detail textarea")'), 'record did not open');
    const layout = await execute(`return {view:ui.view.id,hash:location.hash,listHidden:document.querySelector('#resource-panels').hidden,detailHidden:document.querySelector('#detail').hidden,inline:!!document.querySelector('#side-notices #notice-record-detail'),writes:writes.length,width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,10).map(e=>({tag:e.tagName,class:e.className,right:e.getBoundingClientRect().right}))};`);
    assert(layout.view === 'notice' && layout.hash === '#notices-9' && layout.listHidden && !layout.detailHidden && !layout.inline && layout.writes === 0 && layout.scroll <= layout.width, 'detail navigation/layout failed: '+JSON.stringify(layout));
    await execute(`window.reply=document.querySelector('#notice-record-detail textarea');reply.value='保留未提交答复';poll();`);
    assert(await execute(`return document.querySelector('#notice-record-detail textarea')===reply&&reply.value==='保留未提交答复';`), 'poll erased the reply');
    if (theme==='light'&&width===1440) {
      await execute(`window.noticeFetch=window.fetch;window.noticeReads=0;window.refreshRecord=[...document.querySelectorAll('.notice-detail-page button')].find(n=>n.textContent==='刷新记录');
        window.fetch=(url,options)=>String(url).startsWith('/api/notices?')?new Promise(resolve=>{window.noticeReads++;window.failNoticeRefresh=()=>resolve(Response.json({error:'controlled notice failure'},{status:500}));}):window.noticeFetch(url,options);
        window.refreshRecord.click();window.refreshRecord.click();`);
      assert(await execute(`return window.noticeReads===1&&window.refreshRecord.textContent==='刷新中…'&&window.refreshRecord.getAttribute('aria-busy')==='true'&&document.querySelector('#notice-record-detail textarea')===reply;`),'notice refresh missing busy state or duplicate read');
      await execute(`window.failNoticeRefresh();window.fetch=window.noticeFetch;`);
      assert(await wait(`document.querySelector('.notice-detail-page').textContent.includes('controlled notice failure')&&!window.refreshRecord.hasAttribute('aria-busy')`),'notice failure must restore control');
      assert(await execute(`return document.querySelector('#notice-record-detail textarea')===reply&&reply.value==='保留未提交答复';`),'notice failure erased existing reply');
    }
    if (mobile) await click('.notice-detail-page a[href="#notices"]');
    else await rpc(`/session/${session}/back`, {});
    assert(await wait('ui.view.id==="notices"&&!document.querySelector("#resource-panels").hidden'), 'return/back did not restore list');
    // Keyboard activation of the real native list anchor.
    await execute(`document.querySelector('#notices a[href="#notices-9"]').focus();`);
    await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
    assert(await wait('ui.view.id==="notice"&&document.querySelector("#notice-record-detail textarea")'), 'Enter did not activate record');
    await rpc(`/session/${session}/frame`, { id: null });
    await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/${mobile ? '' : 'full'}?case=${theme}-${width}&record=9${mobile ? '' : '#notices-9'}` });
    if (!mobile) await rpc(`/session/${session}/refresh`, {});
    if (mobile) await enterViewport(width, height);
    assert(await wait('ui.view.id==="notice"&&document.querySelector("#notice-record-detail textarea")'), 'deep link reload failed');
    await execute(`document.documentElement.dataset.theme='${theme}';`);
    await execute(`document.querySelector('#notice-record-detail textarea').value='明确选择独立页面';Array.from(document.querySelectorAll('#notice-record-detail button')).find(b=>b.textContent==='回复并继续 Worker').click();`);
    assert(await wait('window.writes?.length===1&&!document.querySelector("#notice-record-detail textarea")'), 'answer did not settle');
    assert(await execute(`return location.hash==='#notices-9'&&document.querySelector('#notice-record-detail').textContent.includes('明确选择独立页面');`), 'settlement left the record');
    await execute(`location.hash='#notices-8';`);
    assert(await wait('document.querySelector("#notice-record-detail")?.textContent.includes("历史问卷")'), 'historical detail not loaded');
    assert(await execute(`const p=document.querySelector('#notice-record-detail');return p.textContent.includes('独立页面')&&p.textContent.includes('内联展开')&&p.textContent.includes('用户答复')&&!p.querySelector('textarea')&&writes.length===1&&document.documentElement.scrollWidth<=innerWidth;`), 'history is incomplete, writable or overflowing');
    await click('.notice-detail-page a[href="#worker-1"]');
    assert(await wait('ui.view.id==="task"'), 'Worker context navigation failed');
    console.log(`PASS ${theme} ${width}x${height}: standalone record, Enter/${mobile ? 'return/deep link' : 'back/reload'}, answer stays, read-only history, Worker context, no overflow`);
  }
  passed = true;
} catch (error) { console.error(`Browser failure; geckodriver log: ${log}`); throw error; }
finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  driver.kill(); await driver.exited; server.stop(true); if (passed) await rm(temp, { recursive: true, force: true });
}
