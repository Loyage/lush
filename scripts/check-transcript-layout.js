// Real CSS/layout regression check. Requires Firefox and geckodriver on PATH.
// No daemon, project state or model calls; browser and HTTP fixtures are cleaned up.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/styles.css"><link rel="stylesheet" href="/assets/styles-search-field.css"></head>
<body><div id="project-app"><div id="detail"></div></div><div id="context-menu"></div>
<script type="module">
import { openTranscriptView } from '/assets/transcript-view.js';
import { ui, transcriptCache } from '/assets/state.js';
const step = seq => ({seq, kind:'text', title:'回答', file:'fixture', at:new Date().toISOString(), model_duration_ms:2500, body:'needle body '+seq+'\\n'+('long readable line\\n').repeat(40), excerpt:'needle excerpt '+seq});
const call={seq:2,kind:'tool',tool_name:'functions.bash',file:'fixture',call_id:'fixture-call',model_duration_ms:2500,at:'2026-01-01T00:00:00Z',body:JSON.stringify({command:'bun run test test/web/dom-transcript-view.test.js'}),tokens:{first:true,exact:true,total:128456}};
const output={seq:3,kind:'result',file:'fixture',call_id:'fixture-call',is_error:true,body:'error: fixture failure\\nExpected: readable output\\nReceived: failure text',at:'2026-01-01T00:00:01.250Z'};
window.searchCalls = 0;
const originalFetch = window.fetch;
window.fetch = async (url, opts) => {
  if (String(url).includes('/transcript-search')) {
    window.searchCalls++;
    return Response.json({steps:Array.from({length:12}, (_,i)=>step(i+10)), files:['fixture'], has_more:false});
  }
  if (String(url).includes('/transcript-step')) return Response.json({step:step(Number(new URL(url, location.href).searchParams.get('seq'))), related:[]});
  return originalFetch(url, opts);
};
// A direct management-page entry need not select a Worker detail first.
ui.selected = null;
ui.lastSnapshot={tasks:[{id:101,worker_number:'W165-1-1',status:'running'}]};
transcriptCache.set(101, {order:'desc', steps:[step(1),call,output,
  {...call,seq:4,call_id:'long',tool_name:'functions.a_very_long_tool_name_that_must_wrap_without_moving_metadata',tokens:undefined},
  {...output,seq:5,call_id:'long',is_error:false,at:'2026-01-01T01:30:00Z'},
  {...call,seq:6,call_id:'short',tokens:{first:true,exact:true,total:64000}},
  {...output,seq:7,call_id:'short',is_error:false,at:'2026-01-01T00:00:00.043Z'}], files:['fixture'], next:7, oldest:1});
window.readerReady = openTranscriptView(101);
window.readerState = ui;
</script></body></html>`;

const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  // An explicitly sized browsing context avoids Firefox's desktop minimum window width.
  if (path === '/') return new Response('<!doctype html><body style="margin:0"><iframe src="/reader" style="border:0;display:block;width:1440px;height:900px"></iframe>', { headers: { 'Content-Type': 'text/html' } });
  if (path === '/reader') return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
  if (/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.split('/').at(-1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-layout-'));
const log = join(temp, 'geckodriver.log');
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log),
});
let session, passed = false;
const base = `http://127.0.0.1:${port}`;
async function rpc(path, body, method = 'POST') {
  const response = await fetch(base + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function resize(width, height) {
  await rpc(`/session/${session}/window/rect`, { width: Math.max(540, width + 40), height: height + 200 });
  await execute(`const frame=parent.document.querySelector('iframe');frame.style.width='${width}px';frame.style.height='${height}px';parent.scrollTo(0,0);`);
}
async function checkCompactMetadata(width) {
  const problem = await execute(`
    for(const step of document.querySelectorAll('.step')){
      const head=step.querySelector('.step-head'), meta=step.querySelector('.step-meta');
      const heading=step.querySelector('.step-title').getBoundingClientRect();
      if(getComputedStyle(meta).display!=='flex') return 'metadata must be a compact group';
      if(step.querySelector('.step-title').textContent && heading.width<70) return 'metadata squeezed the tool name into a vertical strip';
      if(head.scrollWidth>head.clientWidth+1) return 'heading overflow';
      if(innerWidth>=1440 && ['2','6'].includes(step.dataset.seq)){
        const r=meta.getBoundingClientRect();
        if(r.top>=heading.bottom || r.bottom<=heading.top) return 'metadata forced onto a new row';
      }
      let previous;
      for(const name of ['step-number','step-tokens','step-duration','when']){
        const cell=meta.querySelector('.'+name);
        if(!cell || cell.hidden) continue;
        const r=cell.getBoundingClientRect();
        if(previous && Math.abs(previous.y-r.y)<1 && Math.abs(r.x-previous.right-8)>1) return name+' is spaced out or overlaps';
        if(cell.scrollWidth>cell.clientWidth+1) return name+' text overflow';
        previous=r;
      }
    }
    return '';`);
  assert(!problem, `compact metadata at ${width}: ${problem}`);
}
async function readerScreenshot() {
  await rpc(`/session/${session}/frame`, { id: null });
  const frame = await rpc(`/session/${session}/element`, { using: 'css selector', value: 'iframe' });
  try { return await rpc(`/session/${session}/element/${frame['element-6066-11e4-a52e-4f735466cecf']}/screenshot`, undefined, 'GET'); }
  finally { await rpc(`/session/${session}/frame`, { id: 0 }); }
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited before startup');
    await Bun.sleep(100);
  }
  assert(ready, 'geckodriver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  await rpc(`/session/${session}/frame`, { id: 0 });
  await rpc(`/session/${session}/execute/async`, { script: 'const done=arguments[0]; window.readerReady.then(()=>done(true),e=>done(String(e)));', args: [] });
  for (const [width, height] of [[1440, 900], [900, 700], [390, 844], [320, 568], [600, 400]]) {
    await resize(width, height);
    const box = await execute(`
      const rect = selector => { const r=document.querySelector(selector).getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}; };
      return {sidebar:rect('.transcript-sidebar'),body:rect('.transcript-viewport'),query:rect('.search-field-row'),dialog:rect('.transcript-dialog'),width:innerWidth,height:innerHeight,area:getComputedStyle(document.querySelector('.transcript-sidebar')).gridArea};`);
    assert(box.width === width && box.height === height, `wrong test viewport: ${JSON.stringify(box)}`);
    assert(await execute(`const group=document.querySelector('.transcript-order'),buttons=[...group.querySelectorAll('button')];return group.getAttribute('role')==='group'&&group.getAttribute('aria-label')==='执行过程排序'&&buttons.map(n=>n.textContent).join(',')==='正序,逆序'&&buttons.map(n=>n.getAttribute('aria-pressed')).join(',')==='false,true'&&buttons.every(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.x>=0&&r.right<=innerWidth&&r.bottom<=document.querySelector('.execution-navigation').getBoundingClientRect().bottom;})&&!document.querySelector('.transcript-reading-tools select');`), `sort buttons missing, clipped or incorrectly selected at ${width}`);
    assert(box.area.startsWith('search'), 'sidebar must not inherit app navigation grid-area');
    assert(box.body.w > 0 && box.body.h > 80, `empty reading area at ${width}: ${JSON.stringify(box)}`);
    if (box.width > 760) {
      assert(box.sidebar.right <= box.body.x + 1 && Math.abs(box.sidebar.y - box.body.y) < 1, `columns swapped or displaced: ${JSON.stringify(box)}`);
      assert(box.body.w > box.sidebar.w, 'body should be the wider column');
      assert(box.query.x >= box.sidebar.x && box.query.right <= box.sidebar.right + 1, 'query escaped sidebar');
    } else {
      assert(box.sidebar.h === 0 && box.body.h > box.height * .7, `default mobile reading must reclaim search space: ${JSON.stringify(box)}`);
      assert(await execute(`return document.querySelector('.transcript-search-toggle').getAttribute('aria-expanded')==='false' && document.querySelector('.execution-navigation').scrollWidth<=innerWidth && document.querySelector('.transcript-toolbar').scrollWidth<=innerWidth;`), 'mobile toolbar overflow or search opened without request');
    }
    assert(box.body.right <= box.width + 1 && box.body.bottom <= box.height + 1, 'body escaped viewport');
    assert(await execute(`const call=document.querySelector('[data-seq="2"]');return call.querySelector('.step-duration').textContent==='time≈1.3s' && !document.querySelector('.step-model-duration') && call.querySelector('.step-head').scrollWidth<=call.clientWidth && document.querySelector('.transcript-viewport').scrollWidth<=innerWidth;`), `duration metadata missing or overflowing at ${width}`);
    assert(await execute(`return document.querySelector('[data-seq="4"] .step-duration').textContent==='time≈5400s' && document.querySelector('[data-seq="6"] .step-duration').textContent==='time<1s';`), `seconds-only timing failed at ${width}`);
    await checkCompactMetadata(width);
    console.log(`PASS layout, seconds-only timing and compact metadata ${width}x${height}`);
  }
  await resize(1440, 900);
  const query = await rpc(`/session/${session}/element`, { using: 'css selector', value: '.search-field-row input' });
  const id = query['element-6066-11e4-a52e-4f735466cecf'];
  await rpc(`/session/${session}/element/${id}/value`, { text: 'needle' });
  assert(await execute('return window.searchCalls === 0'), 'typing must not search');
  await rpc(`/session/${session}/element/${id}/value`, { text: '\uE007' });
  await rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0]; let tries=0; const check=()=>{if(document.querySelectorAll('.transcript-match [data-seq]').length===12)done(true);else if(++tries>100)done(false);else setTimeout(check,50);}; check();`, args: [] }).then(ready => assert(ready, 'Enter search did not hydrate match bodies'));
  assert(await execute(`return window.searchCalls===1 && document.querySelectorAll('.search-hit').length===12 && document.querySelectorAll('dialog[open]').length===1 && !document.querySelector('.transcript-sidebar .step');`), 'search must stay in one dialog with bodies only in main column');
  await checkCompactMetadata(1440);
  assert(await execute(`return [...document.querySelectorAll('.transcript-order button')].every(n=>n.disabled)&&document.querySelector('.transcript-order').parentNode.dataset.help.includes('搜索结果按步骤编号排列');`), 'search must disable both sort buttons with an explanation');
  assert(await execute(`const hits=document.querySelectorAll('.search-hit'); hits[5].querySelector('button').click(); return document.querySelectorAll('.step-located').length===1 && document.querySelector('[data-match-seq="15"]').classList.contains('step-located');`), 'hit navigation did not locate corresponding body');
  const queryTop = await execute(`return document.querySelector('.search-field-row').getBoundingClientRect().y;`);
  await execute(`document.querySelector('.transcript-search-results').scrollTop=200; document.querySelector('.transcript-viewport').scrollTop=300;`);
  assert(await execute(`return document.querySelector('.search-field-row').getBoundingClientRect().y === ${queryTop};`), 'search controls moved while scrolling results/body');
  await execute(`document.querySelector('.search-field-submit').click();`);
  assert(await execute('return window.searchCalls===2'), 'native search button must submit');
  await rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0]; let tries=0; const check=()=>{if(document.querySelector('.transcript-reader').getAttribute('aria-busy')==='false')done(true);else if(++tries>100)done(false);else setTimeout(check,50);}; check();`, args: [] }).then(ready => assert(ready, 'native search button left reader busy'));
  const screenshotPath = process.argv[2] || '/tmp/lush-transcript-layout.png';
  async function capture(suffix) {
    const screenshot = await readerScreenshot();
    await Bun.write(screenshotPath.replace(/\.png$/, '') + suffix + '.png', Buffer.from(screenshot, 'base64'));
  }
  for (const theme of ['light', 'dark']) {
    await execute(`document.documentElement.dataset.theme='${theme}';`);
    await resize(390, 844);
    assert(await execute(`const [asc,desc]=document.querySelectorAll('.transcript-order button');return getComputedStyle(asc).backgroundColor!==getComputedStyle(desc).backgroundColor&&desc.getAttribute('aria-pressed')==='true';`), `sort selection not distinguishable in ${theme} theme`);
    assert(await execute(`return getComputedStyle(document.querySelector('.transcript-sidebar')).display==='none' && document.querySelector('.transcript-viewport').getBoundingClientRect().height>innerHeight*.7;`), `mobile search must start closed in ${theme}`);
    await capture('-mobile-' + theme);
    await execute(`document.querySelector('.transcript-search-toggle').click();`);
    assert(await execute(`const view=document.querySelector('.transcript-viewport').getBoundingClientRect(); const form=document.querySelector('.transcript-search').getBoundingClientRect(); const side=document.querySelector('.transcript-sidebar').getBoundingClientRect(); return view.height>innerHeight*.3 && form.bottom<=side.bottom && side.bottom<=view.y+1 && document.activeElement.type==='search';`), `mobile search/body clipped in ${theme} theme`);
    assert(await execute(`return document.querySelector('input[type=checkbox]').getBoundingClientRect().width<24;`), 'failure checkbox inherited text input flex sizing');
    await capture('-mobile-' + theme + '-search');
    assert(await execute(`document.querySelectorAll('.search-hit')[5].querySelector('button').click(); const card=document.querySelector('[data-match-seq="15"]');const view=document.querySelector('.transcript-viewport');return getComputedStyle(document.querySelector('.transcript-sidebar')).display==='none' && document.activeElement===view && card.getBoundingClientRect().top>=view.getBoundingClientRect().top-1 && document.querySelector('.search-field-input').value==='needle';`), 'mobile hit did not close search, focus reader and locate body');
    await execute(`document.querySelector('.transcript-search-toggle').click();`);
    await resize(600, 400);
    assert(await execute(`const side=document.querySelector('.transcript-sidebar'),body=document.querySelector('.transcript-viewport');return body.getBoundingClientRect().height>80&&side.scrollWidth<=innerWidth&&document.querySelector('.transcript-reader').scrollHeight>=document.querySelector('.transcript-reader').clientHeight;`), 'short mobile search must remain scrollable without overflowing body');
    await execute(`document.querySelector('.transcript-search-toggle').click();`);
    await resize(320, 568);
    await execute(`document.querySelector('.transcript-search-toggle').click();`);
    const narrowSearch = await execute(`const side=document.querySelector('.transcript-sidebar').getBoundingClientRect(),form=document.querySelector('.transcript-search').getBoundingClientRect();return {formBottom:form.bottom,sideBottom:side.bottom,sideWidth:side.width,scrollWidth:document.querySelector('.transcript-sidebar').scrollWidth,bodyHeight:document.querySelector('.transcript-viewport').getBoundingClientRect().height};`);
    assert(narrowSearch.formBottom<=narrowSearch.sideBottom+1 && narrowSearch.scrollWidth<=narrowSearch.sideWidth+1 && narrowSearch.bodyHeight>80, '320px shared controls clipped or overflowed: ' + JSON.stringify(narrowSearch));
    assert(await execute(`const input=document.querySelector('.search-field-input');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return getComputedStyle(document.querySelector('.transcript-sidebar')).display==='none' && input.value==='needle';`), 'reader Escape must collapse search without clearing its applied query');
    console.log('PASS mobile search collapse, hit focus/location, 320px controls and short viewport ' + theme);
  }
  await execute(`const button=[...document.querySelectorAll('button')].find(n=>n.textContent==='返回全部记录');button.click();`);
  await resize(390, 844);
  assert(await execute(`const step=document.querySelector('.step-failed');return step?.textContent.includes('fixture failure')&&step.querySelector('.step-meta').textContent.includes('#2')&&step.querySelector('.step-call-status').textContent==='失败'&&document.querySelector('.transcript-viewport').scrollWidth<=innerWidth;`), 'failure command/output or step metadata lost/overflowed');
  await checkCompactMetadata(390);
  await capture('-mobile-steps');
  await execute(`document.documentElement.dataset.theme='light';`);
  await resize(1440, 900);
  // Let theme transitions settle before capturing the final light-theme view.
  await rpc(`/session/${session}/execute/async`, { script: 'setTimeout(arguments[0], 250);', args: [] });
  const screenshot = await readerScreenshot();
  await Bun.write(screenshotPath, Buffer.from(screenshot, 'base64'));
  console.log(`PASS Enter, native search button, hit navigation, independent scrolling; screenshot: ${screenshotPath}`);
  passed = true;
} catch (error) {
  console.error(`Browser check failed; geckodriver log: ${log}`); throw error;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true);
  // Retain the log on failure for diagnosis.
  if (passed) await rm(temp, { recursive: true, force: true });
}
