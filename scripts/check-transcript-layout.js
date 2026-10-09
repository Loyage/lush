// Real CSS/layout regression check. Requires Firefox and geckodriver on PATH.
// No daemon, project state or model calls; browser and HTTP fixtures are cleaned up.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/styles.css"></head>
<body><div id="project-app"><div id="detail"></div></div><div id="context-menu"></div>
<script type="module">
import { openTranscriptView } from '/assets/transcript-view.js';
import { ui, transcriptCache } from '/assets/state.js';
const step = seq => ({seq, kind:'text', title:'回答', file:'fixture', body:'needle body '+seq+'\\n'+('long readable line\\n').repeat(40), excerpt:'needle excerpt '+seq});
const call={seq:2,kind:'tool',tool_name:'functions.bash',file:'fixture',call_id:'fixture-call',at:new Date().toISOString(),body:JSON.stringify({command:'bun run test test/web/dom-transcript-view.test.js'}),tokens:{first:true,exact:true,total:128456}};
const output={seq:3,kind:'result',file:'fixture',call_id:'fixture-call',is_error:true,body:'error: fixture failure\\nExpected: readable output\\nReceived: failure text',at:new Date().toISOString()};
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
ui.selected = 101;
ui.lastSnapshot={tasks:[{id:101,worker_number:'W165-1-1',status:'running'}]};
transcriptCache.set(101, {order:'desc', steps:[step(1),call,output], files:['fixture'], next:3, oldest:1});
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
      return {sidebar:rect('.transcript-sidebar'),body:rect('.transcript-viewport'),query:rect('.transcript-query-row'),dialog:rect('.transcript-dialog'),width:innerWidth,height:innerHeight,area:getComputedStyle(document.querySelector('.transcript-sidebar')).gridArea};`);
    assert(box.width === width && box.height === height, `wrong test viewport: ${JSON.stringify(box)}`);
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
    console.log(`PASS layout ${width}x${height}`);
  }
  await resize(1440, 900);
  const query = await rpc(`/session/${session}/element`, { using: 'css selector', value: '.transcript-query-row input' });
  const id = query['element-6066-11e4-a52e-4f735466cecf'];
  await rpc(`/session/${session}/element/${id}/value`, { text: 'needle' });
  assert(await execute('return window.searchCalls === 0'), 'typing must not search');
  await rpc(`/session/${session}/element/${id}/value`, { text: '\uE007' });
  await rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0]; let tries=0; const check=()=>{if(document.querySelectorAll('.transcript-match [data-seq]').length===12)done(true);else if(++tries>100)done(false);else setTimeout(check,50);}; check();`, args: [] }).then(ready => assert(ready, 'Enter search did not hydrate match bodies'));
  assert(await execute(`return window.searchCalls===1 && document.querySelectorAll('.search-hit').length===12 && document.querySelectorAll('dialog[open]').length===1 && !document.querySelector('.transcript-sidebar .step');`), 'search must stay in one dialog with bodies only in main column');
  assert(await execute(`const hits=document.querySelectorAll('.search-hit'); hits[5].querySelector('button').click(); return document.querySelectorAll('.step-located').length===1 && document.querySelector('[data-match-seq="15"]').classList.contains('step-located');`), 'hit navigation did not locate corresponding body');
  const queryTop = await execute(`return document.querySelector('.transcript-query-row').getBoundingClientRect().y;`);
  await execute(`document.querySelector('.transcript-search-results').scrollTop=200; document.querySelector('.transcript-viewport').scrollTop=300;`);
  assert(await execute(`return document.querySelector('.transcript-query-row').getBoundingClientRect().y === ${queryTop};`), 'search controls moved while scrolling results/body');
  await execute(`document.querySelector('.transcript-query-row button').click();`);
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
    assert(await execute(`return getComputedStyle(document.querySelector('.transcript-sidebar')).display==='none' && document.querySelector('.transcript-viewport').getBoundingClientRect().height>innerHeight*.7;`), `mobile search must start closed in ${theme}`);
    await capture('-mobile-' + theme);
    await execute(`document.querySelector('.transcript-search-toggle').click();`);
    assert(await execute(`const view=document.querySelector('.transcript-viewport').getBoundingClientRect(); const form=document.querySelector('.transcript-search').getBoundingClientRect(); const side=document.querySelector('.transcript-sidebar').getBoundingClientRect(); return view.height>innerHeight*.3 && form.bottom<=side.bottom && side.bottom<=view.y+1 && document.activeElement.type==='search';`), `mobile search/body clipped in ${theme} theme`);
    assert(await execute(`return document.querySelector('input[type=checkbox]').getBoundingClientRect().width<24;`), 'failure checkbox inherited text input flex sizing');
    await capture('-mobile-' + theme + '-search');
    assert(await execute(`document.querySelectorAll('.search-hit')[5].querySelector('button').click(); const card=document.querySelector('[data-match-seq="15"]');const view=document.querySelector('.transcript-viewport');return getComputedStyle(document.querySelector('.transcript-sidebar')).display==='none' && document.activeElement===view && card.getBoundingClientRect().top>=view.getBoundingClientRect().top-1 && document.querySelector('.transcript-query-row input').value==='needle';`), 'mobile hit did not close search, focus reader and locate body');
    await execute(`document.querySelector('.transcript-search-toggle').click();`);
    await resize(600, 400);
    assert(await execute(`const side=document.querySelector('.transcript-sidebar'),body=document.querySelector('.transcript-viewport');return body.getBoundingClientRect().height>80&&side.scrollWidth<=innerWidth&&document.querySelector('.transcript-reader').scrollHeight>=document.querySelector('.transcript-reader').clientHeight;`), 'short mobile search must remain scrollable without overflowing body');
    await execute(`document.querySelector('.transcript-search-toggle').click();`);
    console.log('PASS mobile search collapse, hit focus/location and short viewport ' + theme);
  }
  await execute(`const button=[...document.querySelectorAll('button')].find(n=>n.textContent==='返回全部记录');button.click();`);
  await resize(390, 844);
  assert(await execute(`const step=document.querySelector('.step-failed');return step?.textContent.includes('fixture failure')&&step.querySelector('.step-meta').textContent.includes('#2')&&step.querySelector('.step-call-status').textContent==='失败'&&document.querySelector('.transcript-viewport').scrollWidth<=innerWidth;`), 'failure command/output or step metadata lost/overflowed');
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
