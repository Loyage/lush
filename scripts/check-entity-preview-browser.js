// bun run scripts/check-entity-preview-browser.js — isolated Firefox fixture, no daemon/model calls.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/styles.css"></head>
<body style="padding:24px"><div id="links" style="display:flex;gap:24px;flex-wrap:wrap"></div><script type="module">
import { button, el } from '/assets/dom.js';
import { initHelp, hideHelp } from '/assets/help.js';
window.reads=[];window.clicked=0;window.hideHelp=hideHelp;
window.fetch=async url=>{window.reads.push(String(url));return Response.json(String(url).includes('/input/')
  ? {id:203,content:'原始 Order：保持用户输入与后续工作分开 <img onerror=alert(1)>'}
  : {id:376,worker_number:'W203',auto_title:'自动生成的悬停主题',goal:'鼠标停留后展示 Worker 的具体目标，不必打开详情',status:'running'});};
const seeded=button('Worker W203',()=>window.clicked++,'ghost',{worker:{id:376,worker_number:'W203',auto_title:'已加载的自动主题',goal:'已加载的 Worker 简介'}});seeded.id='seeded';
const worker=el('a','Worker 详情');worker.id='worker';worker.href='#worker-376';worker.title='打开详情';
const order=el('a','Order O203');order.id='order';order.href='/p/2222222222222222/#input-input-203';
document.querySelector('#links').append(seeded,worker,order);initHelp();window.ready=true;
</script></body></html>`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/') return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
  if (/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.split('/').at(-1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-entity-preview-')), log = join(temp, 'geckodriver.log');
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
const assert = (condition, message) => { if (!condition) throw Error(message); };
async function move(selector, duration = 0) {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
    { type: 'pointerMove', origin: element, x: 0, y: 0, duration: 0 }, { type: 'pause', duration },
  ] }] });
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw Error('geckodriver exited before startup');
    await Bun.sleep(100);
  }
  assert(ready, 'driver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  assert(await rpc(`/session/${session}/execute/async`, { script: 'const done=arguments[0];let n=0;const check=()=>window.ready?done(true):++n>100?done(false):setTimeout(check,30);check();', args: [] }), 'fixture failed to load');
  assert(await execute('return window.reads.length===0'), 'render prefetched previews');
  await move('#worker', 150);
  assert(await execute('return window.reads.length===0 && !document.querySelector("#help-tip:not([hidden])")'), 'fly-by opened preview');
  await move('#seeded', 1300);
  assert(await execute('return document.querySelector("#help-tip").textContent.includes("已加载的 Worker 简介") && document.querySelector("#help-tip").textContent.includes("已加载的自动主题") && window.reads.length===0'), 'seeded preview missing');
  await move('#worker', 1300);
  assert(await execute('return document.querySelector("#help-tip").textContent.includes("具体目标") && document.querySelector("#help-tip").textContent.includes("自动生成的悬停主题") && window.reads[0]==="/api/worker/376" && !document.querySelector("#worker").hasAttribute("title")'), 'Worker read/preview/native title wrong');
  await move('#order', 1300);
  assert(await execute('return document.querySelector("#help-tip").textContent.includes("原始 Order") && window.reads[1]==="/p/2222222222222222/api/input/input/203" && !document.querySelector("#help-tip img")'), 'Order source or plain-text preview wrong');
  for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    await rpc(`/session/${session}/window/rect`, { width, height: 844 });
    await rpc(`/session/${session}/actions`, { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', origin: 'viewport', x: 2, y: 2, duration: 0 }] }] });
    await execute(`document.documentElement.dataset.theme='${theme}';window.hideHelp();`);
    await move('#seeded', 1300);
    const layout = await execute('const t=document.querySelector("#help-tip"),r=t.getBoundingClientRect();return {hidden:t.hidden,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,described:document.querySelector("#seeded").getAttribute("aria-describedby")===t.id}');
    assert(!layout.hidden && layout.left>=0 && layout.right<=layout.width && layout.top>=0 && layout.bottom<=layout.height && layout.described, `tooltip escaped ${theme} ${width}: ${JSON.stringify(layout)}`);
  }
  await execute('window.hideHelp();');
  assert(await execute('return document.querySelector("#help-tip").hidden && window.clicked===0'), 'hover navigated/clicked');
  console.log('PASS Firefox: delayed Worker/Order previews, no fly-by/render reads, source routing, plain text, both themes/widths, accessibility and no hover actions');
  passed = true;
} catch (error) {
  console.error(`Browser check failed; geckodriver log: ${log}`); throw error;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true });
}
