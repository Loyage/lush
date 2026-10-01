// Real CSS/layout regression check. Requires Firefox and geckodriver on PATH.
// No daemon, project state or model calls; browser and HTTP fixtures are cleaned up.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/styles.css"></head>
<body><div id="project-app"><div id="detail"></div></div><div id="context-menu"></div>
<script type="module">
import { openTranscriptView } from '/assets/transcript-view.js';
import { ui, transcriptCache } from '/assets/state.js';
const step = seq => ({seq, kind:'text', title:'回答', file:'fixture', body:'needle body '+seq+'\\n'+('long readable line\\n').repeat(40), excerpt:'needle excerpt '+seq});
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
transcriptCache.set(101, {order:'desc', steps:[step(1)], files:['fixture'], next:1, oldest:1});
window.readerReady = openTranscriptView(101);
window.readerState = ui;
</script></body></html>`;

const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/') return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
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
  await rpc(`/session/${session}/execute/async`, { script: 'const done=arguments[0]; window.readerReady.then(()=>done(true),e=>done(String(e)));', args: [] });
  for (const [width, height] of [[1440, 900], [900, 700], [390, 844]]) {
    await rpc(`/session/${session}/window/rect`, { width, height });
    const box = await execute(`
      const rect = selector => { const r=document.querySelector(selector).getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}; };
      return {sidebar:rect('.transcript-sidebar'),body:rect('.transcript-viewport'),query:rect('.transcript-query-row'),dialog:rect('.transcript-dialog'),width:innerWidth,height:innerHeight,area:getComputedStyle(document.querySelector('.transcript-sidebar')).gridArea};`);
    assert(box.area.startsWith('search'), 'sidebar must not inherit app navigation grid-area');
    assert(box.sidebar.w > 0 && box.body.w > 0 && box.body.h > 80, `empty reading area at ${width}: ${JSON.stringify(box)}`);
    if (box.width > 760) {
      assert(box.sidebar.right <= box.body.x + 1 && Math.abs(box.sidebar.y - box.body.y) < 1, `columns swapped or displaced: ${JSON.stringify(box)}`);
      assert(box.body.w > box.sidebar.w, 'body should be the wider column');
    } else assert(box.sidebar.bottom <= box.body.y + 1, 'mobile search must sit above body');
    assert(box.query.x >= box.sidebar.x && box.query.right <= box.sidebar.right + 1, 'query escaped sidebar');
    assert(await execute(`return document.querySelector('input[type=checkbox]').getBoundingClientRect().width < 24;`), 'failure checkbox inherited text input flex sizing');
    assert(box.body.right <= box.width + 1 && box.body.bottom <= box.height + 1, 'body escaped viewport');
    console.log(`PASS layout ${width}x${height}`);
  }
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
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
  for (const theme of ['light', 'dark']) {
    await execute(`document.documentElement.dataset.theme='${theme}';`);
    await rpc(`/session/${session}/window/rect`, { width: 390, height: 844 });
    assert(await execute(`const view=document.querySelector('.transcript-viewport').getBoundingClientRect(); const form=document.querySelector('.transcript-search').getBoundingClientRect(); const side=document.querySelector('.transcript-sidebar').getBoundingClientRect(); return view.height>80 && form.bottom<=side.bottom && side.bottom<=view.y+1;`), `mobile search/body clipped in ${theme} theme`);
  }
  await execute(`document.documentElement.dataset.theme='light';`);
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  // Let theme transitions settle before capturing the final light-theme view.
  await rpc(`/session/${session}/execute/async`, { script: 'setTimeout(arguments[0], 250);', args: [] });
  const screenshot = await rpc(`/session/${session}/screenshot`, undefined, 'GET');
  const screenshotPath = process.argv[2] || '/tmp/lush-transcript-layout.png';
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
