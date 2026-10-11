// Isolated Firefox fixture: source display module + real development renderer, no Host/daemon/Agent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-project-board-browser-'));
const output = path.resolve(process.argv[2] || logs);
fs.mkdirSync(output, { recursive: true });
const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const reads = [], writes = [], apiPaths = [];
let server, driver, session, base, socket, passed = false, sequence = 0;
const pending = new Map();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const ids = Array.from({ length: 10 }, (_, index) => (index + 1).toString(16).repeat(16));
const palette = ['green', 'blue', 'teal', 'amber', 'rose', 'slate'];
const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/assets/styles.css"><link rel="stylesheet" href="/assets/styles-core.css"><link rel="stylesheet" href="/assets/styles-workbench.css"><link rel="stylesheet" href="/assets/styles-project-board.css"><link rel="stylesheet" href="/assets/styles-dashboard-cards.css"><link rel="stylesheet" href="/fixture.css"></head>
<body><main><h1>项目瀑布流</h1><div id="board-slot"></div></main><script type="module" nonce="fixture">
window.browserErrors=[];addEventListener('error',event=>browserErrors.push(event.message));addEventListener('unhandledrejection',event=>browserErrors.push(String(event.reason)));
import {createProjectBoard} from '/assets/project-board.js';import {projectDevelopment} from '/assets/project-development.js';import {renderAccountCard} from '/assets/dashboard-cards.js';
const ids=${JSON.stringify(ids)};
window.rows=ids.map((id,index)=>({id,name:index===0?'超长项目名字与路径 LongUnbrokenProjectName'.repeat(4):'项目 '+(index+1),project:'/tmp/fixture/'+('very-long-path-segment-'.repeat(index+1)),running:index%3!==1,
 summary:{notices:2,development:{workers_total:314,active:5,agents_running:2,awaiting_acceptance:3,parent_confirmation:4,pending_merges:7,merging:1,merge_conflicts:2,
 counts:[{status:'running',count:2},{status:'completed',count:309}],recent_workers:Array.from({length:index%4},(_,i)=>({id:i+1,worker_number:'W199-'+(i+1),goal:'最近 Worker 长标题 '+('long-title-'.repeat(index%3+1)),status:'running',integration:'pending'}))}}}));
function renderCard(row){if(row.type==='account')return renderAccountCard(row);const item=document.createElement('li'),link=document.createElement('a');item.className='project-item';link.className='project-open';link.href='/p/'+row.id+'/';link.target='_blank';link.rel='noopener';const name=document.createElement('strong'),dir=document.createElement('small');name.textContent=row.name;dir.textContent=row.project;link.append(name,dir);const status=document.createElement('span');status.className='project-status';status.textContent=row.running?'运行中 · PID 1234':'后台未运行或不可达';item.append(link,status,projectDevelopment(row));return item;}
window.mount=async()=>{window.board=createProjectBoard({renderCard});document.querySelector('#board-slot').replaceChildren(board.root);await board.update(rows);};
await mount();window.ready=true;
</script></body></html>`;
async function rpc(route, body, method = 'POST') {
  // Loopback WebDriver must not inherit outbound proxies.
  const response = await new Promise((resolve, reject) => {
    const request = http.request(base + route, { method, headers: { 'Content-Type': 'application/json' } }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) request.destroy(new Error('WebDriver response too large')); else chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(30000, () => request.destroy(new Error('WebDriver timeout')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text);
  if (response.status >= 400) throw new Error(JSON.stringify(data));
  return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const asyncExecute = script => rpc(`/session/${session}/execute/async`, { script, args: [] });
function bidi(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`BiDi timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
const order = () => execute('return [...board.root.children].map(item=>item.dataset.projectId)');
async function screenshot(name) {
  fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
}
async function pointerDrag(source, target, pointerType = 'mouse') {
  await execute(`document.querySelectorAll('.project-board-handle')[${source}].scrollIntoView({block:'center'});`);
  const points = await execute(`const a=document.querySelectorAll('.project-board-handle')[${source}].getBoundingClientRect(),b=board.root.children[${target}].getBoundingClientRect();return {x:Math.round(a.left+a.width/2),y:Math.round(a.top+a.height/2),tx:Math.round(b.left+b.width/2),ty:Math.round(b.top+b.height*.51)};`);
  assert(points.ty > 0 && points.ty < 900, `drag target outside viewport: ${JSON.stringify(points)}`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'pointer', id: 'board-pointer', parameters: { pointerType }, actions: [
    { type: 'pointerMove', duration: 0, x: points.x, y: points.y }, { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', duration: 150, x: points.x - 30, y: points.y },
    { type: 'pointerMove', duration: 200, x: points.tx, y: points.ty }, { type: 'pointerUp', button: 0 },
  ] }] });
  await rpc(`/session/${session}/actions`, undefined, 'DELETE');
}
try {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) apiPaths.push(url.pathname);
    if (request.method !== 'GET') { writes.push({ method: request.method, path: url.pathname }); return new Response('no mutations', { status: 405 }); }
    if (url.pathname === '/') return new Response(html, { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'nonce-fixture'; style-src 'self'; img-src 'self' data:" } });
    if (url.pathname === '/fixture.css') return new Response('main{display:block;padding:20px;max-width:1500px;margin:auto}h1{margin-bottom:24px}@media(max-width:360px){main{padding:12px}}', { headers: { 'Content-Type': 'text/css' } });
    if (/^\/assets\/[\w.-]+\.(js|css)$/.test(url.pathname)) return new Response(Bun.file(path.join(assets, path.basename(url.pathname))));
    const match = /^\/api\/host\/projects\/([a-f0-9]{16})\/appearance$/.exec(url.pathname);
    if (match && ids.includes(match[1])) {
      const index = ids.indexOf(match[1]); reads.push(match[1]);
      return index === 7 ? Response.json({ error: 'fixture offline' }, { status: 503 }) : Response.json({ id: match[1], appearance: index === 6 ? null : { version: 1, color: palette[index % palette.length], revision: 'fixture' } });
    }
    if (url.pathname.startsWith('/p/')) return new Response('Independent read-only project link fixture');
    return new Response('not found', { status: 404 });
  } });
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = reservation.port; reservation.stop(true); base = `http://127.0.0.1:${port}`;
  const bidiReservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const bidiPort = bidiReservation.port; bidiReservation.stop(true);
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port), '--websocket-port', String(bidiPort)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(logs, 'driver.log')), stderr: Bun.file(path.join(logs, 'driver.log')) });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited during startup');
    await Bun.sleep(100);
  }
  assert(ready, 'WebDriver startup timeout');
  const created = await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', webSocketUrl: true,
    'moz:firefoxOptions': { args: ['-headless'], prefs: { 'dom.w3c_touch_events.enabled': 1 } } } } });
  session = created.sessionId;
  socket = new WebSocket(created.capabilities.webSocketUrl);
  socket.onmessage = event => {
    const message = JSON.parse(event.data), callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); message.type === 'error' ? callback.reject(new Error(message.message)) : callback.resolve(message.result); }
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  const context = await rpc(`/session/${session}/window`, undefined, 'GET');
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  assert(await asyncExecute('const done=arguments[0];let n=0;const check=()=>{if(window.ready)return done(true);if(++n>200)return done(false);setTimeout(check,50)};check();'), 'board startup timeout');
  assert(reads.length === 10 && writes.length === 0, 'initial appearance fetch is not read-only');
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 320]) {
    // Actual viewport, not Firefox's minimum desktop window width.
    await bidi('browsingContext.setViewport', { context, viewport: { width, height: 900 }, devicePixelRatio: 1 });
    await execute(`document.documentElement.dataset.theme='${theme}';window.scrollTo(0,0);`);
    const layout = await execute(`const cards=[...board.root.children],rects=cards.map(c=>c.getBoundingClientRect());return {width:innerWidth,overflow:document.documentElement.scrollWidth-innerWidth,cardOverflow:cards.some(c=>c.scrollWidth>c.clientWidth+1),cols:new Set(rects.map(r=>Math.round(r.left))).size,heights:new Set(rects.map(r=>Math.round(r.height))).size,bounds:rects.every(r=>r.left>=0&&r.right<=innerWidth+1),gap:rects.slice(1).some((r,i)=>Math.abs(r.top-rects[i].top)>40),ink:getComputedStyle(cards[0]).getPropertyValue('--board-ink').trim(),status:getComputedStyle(cards[0]).getPropertyValue('--running').trim(),agent:getComputedStyle(cards[0]).getPropertyValue('--violet').trim()};`);
    assert(layout.width === width && layout.overflow <= 1 && !layout.cardOverflow && layout.bounds, `layout overflow ${theme}/${width}: ${JSON.stringify(layout)}`);
    assert(layout.cols === (width === 320 ? 1 : width === 900 ? 2 : 4) && layout.heights >= 3 && layout.gap, `not variable-height masonry: ${JSON.stringify(layout)}`);
    assert(layout.ink === (theme === 'light' ? '#147457' : '#8ddbb4'), 'palette does not match existing identity values');
    assert(layout.status === (theme === 'light' ? '#287ba6' : '#79c9f0') && layout.agent === (theme === 'light' ? '#7955b4' : '#c1a4f3'), 'identity palette changed semantic colors');
    assert(await execute(`return board.root.children[6].querySelector('.project-board-palette').textContent==='尚未设置辨识色'&&board.root.children[7].querySelector('.project-board-palette').textContent==='配色未确认'`), 'missing/failed palette is not explicit');
    await screenshot(`${theme}-${width}`); console.log(`PASS project board layout ${theme}/${width}: ${layout.cols} columns, ${layout.heights} heights`);
  }
  await execute(`document.documentElement.dataset.reducedMotion='true';`);
  assert(await execute(`return getComputedStyle(board.root.children[0]).transitionDuration==='0s'`), 'device reduced-motion ignored');
  await bidi('browsingContext.setViewport', { context, viewport: { width: 1440, height: 900 }, devicePixelRatio: 1 });
  await execute(`document.querySelector('.project-board-handle').focus();`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE010' }, { type: 'keyUp', value: '\uE010' }] }] });
  assert((await order()).at(-1) === ids[0], 'real keyboard End did not reorder');
  assert(await execute(`return document.activeElement===board.root.lastElementChild.querySelector('button')&&board.root.lastElementChild.querySelector('[aria-live]').textContent.includes('第 10 / 10 项')`), 'keyboard focus or announcement lost');
  await asyncExecute('const done=arguments[0];mount().then(()=>done(true));');
  assert((await order()).at(-1) === ids[0], 'remount did not restore saved browser order');
  await pointerDrag(0, 1);
  const mouseOrder = await order(); assert(mouseOrder[1] === ids[1], 'real mouse handle drag did not reorder');
  await pointerDrag(0, 1, 'touch');
  const touchOrder = await order(); assert(touchOrder[1] === mouseOrder[0], 'real touch handle drag did not reorder');
  // Vertical touch pan on a handle must scroll without reordering; card links have no gesture handlers.
  await bidi('browsingContext.setViewport', { context, viewport: { width: 320, height: 900 }, devicePixelRatio: 1 });
  await execute(`board.root.children[2].querySelector('.project-board-handle').scrollIntoView({block:'center'});`);
  const baseline = await execute('return scrollY');
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'pointer', id: 'neutral-pan', parameters: { pointerType: 'touch' }, actions: [
    { type: 'pointerMove', duration: 0, x: 5, y: 450 }, { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', duration: 300, x: 5, y: 270 }, { type: 'pointerUp', button: 0 },
  ] }] });
  const nativePanSupported = await execute(`return scrollY>${baseline}+50`);
  await execute(`window.panPrevented=false;document.addEventListener('pointermove',event=>{if(event.pointerType==='touch'&&event.defaultPrevented)window.panPrevented=true;});board.root.children[2].querySelector('.project-board-handle').scrollIntoView({block:'center'});`);
  const location = await execute(`const r=board.root.children[2].querySelector('.project-board-handle').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),scroll:scrollY};`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'pointer', id: 'touch-scroll', parameters: { pointerType: 'touch' }, actions: [
    { type: 'pointerMove', duration: 0, x: location.x, y: location.y }, { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', duration: 300, x: location.x, y: location.y - 180 }, { type: 'pointerUp', button: 0 },
  ] }] });
  assert(JSON.stringify(await order()) === JSON.stringify(touchOrder), 'vertical touch pan reordered cards');
  assert(await execute('return !window.panPrevented'), 'vertical touch pan was prevented');
  if (nativePanSupported) assert(await execute(`return scrollY>${location.scroll}+50`), 'vertical touch pan did not scroll the page');
  else console.log('LIMIT Firefox WebDriver touch actions do not scroll even the neutral page margin; verified uncancelled vertical gestures + pan-y, physical-device scrolling remains untested.');
  assert(await execute(`return getComputedStyle(document.querySelector('.project-board-handle')).touchAction==='pan-y'&&document.querySelector('.project-open').onpointerdown===null&&document.querySelector('.project-open').target==='_blank'`), 'native scroll/link gestures overridden');
  await asyncExecute('const done=arguments[0];board.update(rows.slice(0,8).reverse()).then(()=>done(true));');
  assert((await order()).length === 8 && (await order())[0] === touchOrder[0], 'refresh lost order/removal reconciliation');
  // Native project links still reserve/open an independent tab without touching the display layout.
  const originalWindow = await rpc(`/session/${session}/window`, undefined, 'GET');
  const link = await rpc(`/session/${session}/element`, { using: 'css selector', value: '.project-open' });
  await rpc(`/session/${session}/element/${link['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
  const handles = await rpc(`/session/${session}/window/handles`, undefined, 'GET');
  assert(handles.length === 2, 'native project link did not open an independent tab');
  await rpc(`/session/${session}/window`, { handle: handles.find(handle => handle !== originalWindow) });
  let linked = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await rpc(`/session/${session}/url`, undefined, 'GET')).includes('/p/')) { linked = true; break; }
    await Bun.sleep(20);
  }
  assert(linked, 'project link lost its fixed destination');
  await rpc(`/session/${session}/window`, undefined, 'DELETE');
  await rpc(`/session/${session}/window`, { handle: originalWindow });
  const beforeMixedReads = reads.length;
  await asyncExecute(`const done=arguments[0];rows.push({id:'account:01234567-89ab-cdef-0123-456789abcdef',type:'account',connection_id:'01234567-89ab-cdef-0123-456789abcdef',connection:{label:'账户余额卡片（隔离夹具）'.repeat(6),provider:'deepseek',endpoint:'https://fixture.invalid',enabled:true,observation:{status:'available',source:'usage_api',checked_at:'2026-10-01T09:00:00Z',resources:[{id:'fixture-cash',label:'账户现金',kind:'balance',scope:'account',unit:'USD',remaining:12.5}]}}});board.update([...rows.slice(0,8),rows.at(-1)]).then(()=>done(true));`);
  assert(reads.length === beforeMixedReads + 8, 'mixed board fetched more than its eight projects');
  assert(await execute(`return board.root.lastElementChild.querySelector('.project-board-palette').hidden`), 'account card is requesting project color');
  await execute(`board.root.lastElementChild.querySelector('.project-board-handle').focus();`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'mixed-keyboard', actions: [{ type: 'keyDown', value: '\uE011' }, { type: 'keyUp', value: '\uE011' }] }] });
  assert((await order())[0].startsWith('account:'), 'account could not move through project cards');
  await asyncExecute('const done=arguments[0];mount().then(()=>done(true));');
  assert((await order())[0].startsWith('account:') && (await order()).length === 11, 'mixed order did not survive remount with additions');
  await bidi('browsingContext.setViewport', { context, viewport: { width: 1440, height: 900 }, devicePixelRatio: 1 });
  await execute('window.scrollTo(0,0)'); await screenshot('mixed-cards');
  for (const theme of ['light', 'dark']) for (const width of [1440, 320]) {
    await bidi('browsingContext.setViewport', { context, viewport: { width, height: 900 }, devicePixelRatio: 1 });
    await execute(`document.documentElement.dataset.theme='${theme}';window.scrollTo(0,0);`);
    assert(await execute(`const card=board.root.children[0],name=card.querySelector('.dashboard-account-header h3').getBoundingClientRect(),handle=card.querySelector('button').getBoundingClientRect();return card.textContent.includes('12.5 USD')&&card.scrollWidth<=card.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth&&name.right<=handle.left;`), `real account renderer overlaps handle/overflows at ${theme}/${width}`);
    await screenshot(`mixed-${theme}-${width}`);
  }
  assert(apiPaths.every(url => ids.some(id => url === `/api/host/projects/${id}/appearance`)), 'non-project card requested an API');
  assert(writes.length === 0, 'fixture received a mutation');
  assert(await execute('return browserErrors.length===0'), 'browser emitted exceptions');
  passed = true; console.log(`PASS keyboard, focus, persisted mixed-card order, real mouse/touch drag, vertical pan safety, project-only read-only palettes. Screenshots/logs: ${output}`);
} catch (error) {
  if (session) await screenshot('failure').catch(() => {});
  console.error(`Project board browser failure; full logs: ${logs}`); throw error;
} finally {
  socket?.close();
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  if (driver) { driver.kill(); await driver.exited; }
  server?.stop(true);
  if (passed) fs.rmSync(path.join(logs, 'driver.log'), { force: true });
}
