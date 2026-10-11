// Isolated real Firefox grid/CSP fixture; no Host, daemon, Agent or real accounts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const output = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'lush-board-grid-')));
fs.mkdirSync(output, { recursive: true });
const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const ids = Array.from({ length: 4 }, (_, index) => String(index + 1).repeat(16));
const accountId = 'account:01234567-89ab-cdef-0123-456789abcdef';
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/assets/styles.css"><link rel="stylesheet" href="/assets/styles-core.css"><link rel="stylesheet" href="/assets/styles-workbench.css"><link rel="stylesheet" href="/assets/styles-project-board.css"><link rel="stylesheet" href="/assets/styles-dashboard-cards.css"><link rel="stylesheet" href="/fixture.css"></head>
<body><main><div id="board-slot"></div></main><script type="module" src="/fixture.js"></script></body></html>`;
const fixture = `
import {createProjectBoard} from '/assets/project-board.js';
import {projectDevelopment} from '/assets/project-development.js';
import {renderAccountCard} from '/assets/dashboard-cards.js';
window.browserErrors=[];window.cspErrors=[];window.edits=[];window.owns=true;
addEventListener('error',e=>browserErrors.push(e.message));addEventListener('unhandledrejection',e=>browserErrors.push(String(e.reason)));
addEventListener('securitypolicyviolation',e=>cspErrors.push(e.violatedDirective+':'+e.blockedURI));
window.rows=${JSON.stringify(ids)}.map((id,i)=>({id,name:'项目 '+i+' '+('long-name-'.repeat(10)),running:true,summary:{development:{workers_total:20,active:2,agents_running:1,awaiting_acceptance:3,parent_confirmation:4,pending_merges:7,merging:1,merge_conflicts:2,counts:[{status:'running',count:2}],recent_workers:[]}}}));
rows.push({id:'${accountId}',type:'account',connection_id:'${accountId.slice(8)}',connection:{label:'账户余额',provider:'deepseek',observation:{status:'available',source:'usage_api',checked_at:'2026-10-01T09:00:00Z',resources:[{id:'cash',label:'账户现金',kind:'balance',scope:'account',unit:'USD',remaining:12.5}]}}});
window.device=rows.map((r,i)=>({id:r.id,x:i%2*6,y:Math.floor(i/2)*12,w:6,h:i===4?10:12}));
function renderCard(row){
 const item=row.type==='account'?renderAccountCard(row,{sections:['quota','balance','reset','observed','details','history','provenance'],refresh:async()=>{}}):document.createElement('li');
 if(row.type==='accounts'){
  item.classList.add('project-item','fixture-accounts');
  const header=document.createElement('header');header.className='dashboard-account-header';const title=document.createElement('h3');title.textContent=row.name;header.append(title);
  const content=document.createElement('div');content.className='fixture-group-content fixture-group-'+row.mode;
  for(let i=0;i<32;i++){const account=document.createElement('article');account.className='fixture-group-account';const label=document.createElement('h4');label.textContent='账号 '+(i+1)+' · '+('long-label-'.repeat(3));const bar=document.createElement('progress');bar.max=100;bar.value=i;bar.setAttribute('aria-label','账号 '+(i+1)+' 额度');const button=document.createElement('button');button.type='button';button.textContent='账号 '+(i+1)+' 操作';button.className='fixture-group-entry';account.append(label,bar,button);content.append(account);}
  item.append(header,content);
 }else if(row.type!=='account'){
  item.classList.add('project-item');
  const link=document.createElement('a');link.className='project-open';link.href='/p/'+row.id+'/';link.target='_blank';
  const title=document.createElement('strong');title.textContent=row.name;link.append(title);item.append(link,projectDevelopment(row));
  for(let i=0;i<20;i++){const p=document.createElement('p');p.textContent='可滚动内容 '+i;item.append(p);}
  const tail=document.createElement('a');tail.className='fixture-tail';tail.href='#tail';tail.textContent='末尾可达入口';item.append(tail);
 }
 const settings=document.createElement('button');settings.className='ghost dashboard-card-settings';settings.textContent='⚙';settings.setAttribute('aria-label','卡片设置');
 const host=document.createElement('span');host.className='help-host dashboard-card-settings-host';host.append(settings);item.prepend(host);return item;
}
window.mount=async(layout=device)=>{window.board=createProjectBoard({renderCard,ownsPage:()=>window.owns,onLayoutChange:layout=>edits.push(layout)});document.querySelector('#board-slot').replaceChildren(board.root);await board.update(rows,{layout});};
await mount();window.ready=true;
`;
const css = 'main{display:block;padding:20px;max-width:1440px;margin:auto}.project-board-content p{margin:12px 0}.fixture-group-content{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}.fixture-group-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.fixture-group-account{min-width:0;padding:8px;border:1px solid var(--line);overflow-wrap:anywhere}.fixture-group-account h4{margin:0 0 8px}.fixture-group-account progress{display:block;width:100%;accent-color:var(--accent)}.fixture-group-entry{min-height:44px;max-width:100%;white-space:normal}@media(max-width:400px){main{padding:12px}}';
let server, driver, session, socket, base, sequence = 0;
const pending = new Map(), reads = [], writes = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function rpc(route, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = http.request(base + route, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() })); res.on('error', reject);
    }); req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('WebDriver timeout'))); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw new Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const asyncExecute = script => rpc(`/session/${session}/execute/async`, { script, args: [] });
function bidi(method, params) {
  const id = ++sequence; return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`BiDi timeout ${method}`)); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function screenshot(name) { fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64')); }
async function key(value, shift = false) {
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keys', actions: [
    ...(shift ? [{ type: 'keyDown', value: '\uE008' }] : []), { type: 'keyDown', value }, { type: 'keyUp', value }, ...(shift ? [{ type: 'keyUp', value: '\uE008' }] : []),
  ] }] }); await rpc(`/session/${session}/actions`, undefined, 'DELETE');
}
async function drag(selector, dx, dy, pointerType = 'mouse') {
  await execute(`document.querySelector('${selector}').scrollIntoView({block:'center'});`);
  const point = await execute(`const r=document.querySelector('${selector}').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'pointer', id: 'pointer', parameters: { pointerType }, actions: [
    { type: 'pointerMove', duration: 0, x: point.x, y: point.y }, { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', duration: 200, x: point.x + dx, y: point.y },
    { type: 'pointerMove', duration: 200, x: point.x + dx, y: point.y + dy }, { type: 'pointerUp', button: 0 },
  ] }] }); await rpc(`/session/${session}/actions`, undefined, 'DELETE');
}
try {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET') { writes.push(url.pathname); return new Response('', { status: 405 }); }
    if (url.pathname === '/') return new Response(html, { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': csp } });
    if (url.pathname === '/fixture.js') return new Response(fixture, { headers: { 'Content-Type': 'text/javascript' } });
    if (url.pathname === '/fixture.css') return new Response(css, { headers: { 'Content-Type': 'text/css' } });
    if (/^\/assets\/[\w.-]+\.(js|css)$/.test(url.pathname)) return new Response(Bun.file(path.join(assets, path.basename(url.pathname))));
    const match = /^\/api\/host\/projects\/([a-f0-9]{16})\/appearance$/.exec(url.pathname);
    if (match && ids.includes(match[1])) { reads.push(match[1]); const index = ids.indexOf(match[1]); return Response.json({ id: match[1], appearance: index === 3 ? null : { version: 1, color: ['green', 'blue', 'rose'][index] } }); }
    if (url.pathname.startsWith('/p/')) return new Response('Independent project fixture');
    return new Response('', { status: 404 });
  } });
  const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }); const port = reserve.port; reserve.stop(true); base = `http://127.0.0.1:${port}`;
  const reserveBidi = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }); const bidiPort = reserveBidi.port; reserveBidi.stop(true);
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port), '--websocket-port', String(bidiPort)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(output, 'driver.log')), stderr: Bun.file(path.join(output, 'driver.log')) });
  let started = false;
  for (let i = 0; i < 100; i++) { try { await rpc('/status', undefined, 'GET'); started = true; break; } catch {} if (driver.exitCode !== null) throw new Error('geckodriver exited'); await Bun.sleep(100); }
  assert(started, 'WebDriver startup timeout');
  const created = await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', webSocketUrl: true, 'moz:firefoxOptions': { args: ['-headless'], prefs: { 'dom.w3c_touch_events.enabled': 1, 'ui.prefersReducedMotion': 1 } } } } });
  session = created.sessionId; socket = new WebSocket(created.capabilities.webSocketUrl);
  socket.onmessage = event => { const data = JSON.parse(event.data), callback = pending.get(data.id); if (callback) { pending.delete(data.id); data.type === 'error' ? callback.reject(new Error(data.message)) : callback.resolve(data.result); } };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 }); const context = await rpc(`/session/${session}/window`, undefined, 'GET');
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  assert(await asyncExecute('const done=arguments[0];let n=0;const check=()=>window.ready?done(true):++n>200?done(false):setTimeout(check,50);check();'), 'fixture startup timeout');
  assert(reads.length === 4 && writes.length === 0, 'initial reads are not project-only GET');
  for (const theme of ['light', 'dark']) for (const width of [320, 390, 1440]) {
    await bidi('browsingContext.setViewport', { context, viewport: { width, height: 900 }, devicePixelRatio: 1 });
    await execute(`document.documentElement.dataset.theme='${theme}';window.scrollTo(0,0);`);
    await asyncExecute('const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));');
    const result = await execute(`const cards=[...board.root.children],rects=cards.map(c=>c.getBoundingClientRect());return {width:innerWidth,overflow:document.documentElement.scrollWidth-innerWidth,columns:getComputedStyle(board.root).getPropertyValue('--board-columns').trim(),bounds:rects.every(r=>r.left>=0&&r.right<=innerWidth+1),height:rects[0].height,ink:getComputedStyle(cards[0]).getPropertyValue('--board-ink').trim(),running:getComputedStyle(cards[0]).getPropertyValue('--running').trim(),agent:getComputedStyle(cards[0]).getPropertyValue('--violet').trim(),saved:JSON.stringify(board.getLayout())===JSON.stringify(device),handles:[...board.root.querySelectorAll('.project-board-handle,.project-board-resize')].every(c=>getComputedStyle(c).display==='none'),scroll:cards[0].querySelector('.project-board-content').scrollHeight>cards[0].querySelector('.project-board-content').clientHeight};`);
    const vertical = await execute(`return [...board.root.children].map(card=>{const r=card.getBoundingClientRect(),content=card.querySelector('.project-board-content'),c=content.getBoundingClientRect(),style=getComputedStyle(card);return {id:card.dataset.projectId,height:r.height,contentHeight:c.height,inside:c.top>=r.top-1&&c.bottom<=r.bottom+1&&c.left>=r.left-1&&c.right<=r.right+1,display:style.display,align:style.alignItems,padding:style.padding};});`);
    assert(vertical.every(card=>card.inside), `vertical container overflow ${theme}/${width}: ${JSON.stringify(vertical)}`);
    assert(result.width === width && result.overflow <= 1 && result.bounds && result.saved && result.handles && result.scroll, `display/scroll/device invariant ${theme}/${width}: ${JSON.stringify(result)}`);
    assert(result.columns === (width === 1440 ? '12' : '1') && Math.abs(result.height - (12 * 24 - 12)) <= 1, `grid CSSOM failed under CSP: ${JSON.stringify(result)}`);
    assert(result.ink === (theme === 'light' ? '#147457' : '#8ddbb4'), 'identity palette changed');
    assert(result.running === (theme === 'light' ? '#287ba6' : '#79c9f0') && result.agent === (theme === 'light' ? '#7955b4' : '#c1a4f3'), 'identity changed semantic colors');
    assert(await execute(`const content=board.root.children[0].querySelector('.project-board-content');content.scrollTop=content.scrollHeight;const r=content.getBoundingClientRect(),tail=content.querySelector('.fixture-tail').getBoundingClientRect();return tail.top>=r.top&&tail.bottom<=r.bottom;`), `tail content is unreachable ${theme}/${width}`);
    await execute('board.setEditing(true);');
    assert(await execute(`return [...board.root.children].every(card=>{const h=card.querySelector('.project-board-handle').getBoundingClientRect(),s=card.querySelector('.dashboard-card-settings').getBoundingClientRect();return h.right<=s.left+.5&&h.width>=44&&s.width>=44;});`), 'editing handle overlaps actual caller settings host');
    assert(await execute(`const card=board.root.lastElementChild,header=card.querySelector('.dashboard-account-header'),name=header.querySelector('h3').getBoundingClientRect(),refresh=header.querySelector('button').getBoundingClientRect(),h=card.querySelector('.project-board-handle').getBoundingClientRect();return name.right<=refresh.left+.5&&refresh.right<=h.left+.5&&refresh.height>=44&&card.querySelector('.project-board-content').clientHeight>0;`), 'account refresh overlaps editing controls or has no scroll viewport');
    await screenshot(`editing-${theme}-${width}`); await execute('board.setEditing(false);');
    await screenshot(`${theme}-${width}`); console.log(`PASS ${theme}/${width}: grid, device coordinates, settings hit areas, scroll reachability`);
  }
  // A genuinely short grid cell must constrain both real project-item renderers
  // and the later account stylesheet, even with all history/details expanded.
  await execute(`window.shortLayout=device.map(cell=>({...cell,h:6}));window.richRows=structuredClone(rows);const account=richRows.at(-1);account.connection.last_success={checked_at:'2026-10-01T09:00:00Z',observation:{...account.connection.observation,resources:Array.from({length:12},(_,i)=>({id:'metric-'+i,label:'长指标名称 '+('name-'.repeat(8)),kind:i%2?'quota':'balance',scope:'account',unit:i%2?'%':'USD',remaining:12.5,total:100,used:87.5,used_percent:87.5,window_seconds:18000,reset_at:'2099-01-01T00:00:00Z',models:['model/'+('long-model-'.repeat(20))]}))}};account.connection.observation={status:'error',source:'usage_api',error_code:'rate_limited',resources:[]};`);
  await asyncExecute('const done=arguments[0];board.update(richRows,{layout:shortLayout}).then(()=>done(true));');
  for (const theme of ['light', 'dark']) for (const width of [320, 390, 1440]) {
    await bidi('browsingContext.setViewport', { context, viewport: { width, height: 900 }, devicePixelRatio: 1 });
    for (const editing of [false, true]) {
    await execute(`document.documentElement.dataset.theme='${theme}';board.setEditing(${editing});board.root.querySelectorAll('details').forEach(details=>details.open=true);window.scrollTo(0,0);`);
    await asyncExecute('const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));');
    const result = await execute(`return [...board.root.children].map(card=>{const content=card.querySelector('.project-board-content');content.scrollTop=0;content.scrollLeft=0;const r=card.getBoundingClientRect(),c=content.getBoundingClientRect(),style=getComputedStyle(card),pastBottom=r.bottom+2<innerHeight?document.elementFromPoint(r.left+r.width/2,r.bottom+2):null;return {id:card.dataset.projectId,height:r.height,contentHeight:c.height,inside:c.top>=r.top&&c.bottom<=r.bottom+.5&&c.left>=r.left&&c.right<=r.right+.5,display:style.display,padding:style.padding,columns:style.gridTemplateColumns.split(' ').length,scrollable:content.scrollHeight>content.clientHeight,paintsOutside:pastBottom!==null&&card.contains(pastBottom),outerOverflow:card.scrollHeight>card.clientHeight+1};});`);
    assert(result.every(card=>Math.abs(card.height-132)<1&&card.inside&&card.scrollable&&card.display==='grid'&&card.padding==='0px'&&card.columns===1&&!card.paintsOutside&&!card.outerOverflow), `short expanded content escaped grid ${theme}/${width}: ${JSON.stringify(result)}`);
    assert(await execute(`return [...board.root.children].every(card=>{const content=card.querySelector('.project-board-content');content.scrollTop=content.scrollHeight;const tail=content.querySelector('.fixture-tail')||content.querySelector('.dashboard-account-old').lastElementChild.lastElementChild.lastElementChild;const r=content.getBoundingClientRect(),t=tail.getBoundingClientRect();return t.bottom>=r.top&&t.bottom<=r.bottom+1&&content.scrollTop>0;});`), `expanded history/project tail unreachable ${theme}/${width}`);
    assert(await execute(`return document.documentElement.scrollWidth<=innerWidth+1&&JSON.stringify(board.getLayout())===JSON.stringify(shortLayout);`), 'short-card overflow or responsive coordinate mutation');
    await screenshot(`short-expanded-${editing ? 'editing' : 'display'}-${theme}-${width}`); console.log(`PASS short/expanded ${theme}/${width}/${editing ? 'editing' : 'display'}: vertical containment, native scroll, all history/details reachable`);
    }
  }
  // Unified identity with a controlled multi-account renderer; actual account
  // list/tiles styling belongs to the account module and is tested by its owner.
  const groupReads = reads.length;
  for (const mode of ['list', 'tiles']) {
    await asyncExecute(`const done=arguments[0];window.groupRow={id:'accounts',type:'accounts',name:'统一额度',mode:'${mode}'};board.setEditing(false);board.update([groupRow],{layout:[{id:'accounts',x:0,y:0,w:6,h:6}]}).then(()=>done(true));`);
    for (const theme of ['light', 'dark']) for (const width of [320, 390, 1440]) {
      await bidi('browsingContext.setViewport', { context, viewport: { width, height: 900 }, devicePixelRatio: 1 });
      await execute(`document.documentElement.dataset.theme='${theme}';window.scrollTo(0,0);`);
      await asyncExecute('const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));');
      for (const editing of [false, true]) {
        await execute(`board.setEditing(${editing});`);
        assert(await execute(`const card=board.root.children[0],content=card.querySelector('.project-board-content'),r=card.getBoundingClientRect(),c=content.getBoundingClientRect();return board.getLayout()[0].id==='accounts'&&Math.abs(r.height-132)<1&&c.top>=r.top&&c.bottom<=r.bottom+.5&&content.scrollHeight>content.clientHeight&&card.scrollHeight<=card.clientHeight+1&&card.scrollWidth<=card.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth+1&&!card.hasAttribute('data-board-color')&&card.querySelector('.project-board-palette').hidden&&[...card.querySelectorAll('.project-board-handle,.project-board-resize')].every(button=>button.hidden===${!editing}&&button.disabled===${!editing});`), `short accounts containment/edit gate failed ${mode}/${theme}/${width}/${editing}`);
        assert(await execute(`const content=board.root.children[0].querySelector('.project-board-content');return [...content.querySelectorAll('.fixture-group-entry')].every(entry=>{entry.scrollIntoView({block:'nearest',inline:'nearest'});const r=content.getBoundingClientRect(),e=entry.getBoundingClientRect();return e.top>=r.top-.5&&e.bottom<=r.bottom+.5&&e.left>=r.left-.5&&e.right<=r.right+.5;});`), `not all 32 account entries reachable ${mode}/${theme}/${width}/${editing}`);
      }
      await screenshot(`accounts-${mode}-${theme}-${width}`); console.log(`PASS accounts ${mode}/${theme}/${width}: 132px containment, all 32 entries reachable, explicit edit gate`);
    }
  }
  assert(reads.length===groupReads, 'reserved accounts requested project appearance');
  await bidi('browsingContext.setViewport', { context, viewport: { width: 1440, height: 900 }, devicePixelRatio: 1 });
  await asyncExecute('const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));');
  await execute(`board.setEditing(false);const content=board.root.children[0].querySelector('.project-board-content');content.scrollTop=0;content.focus();`);
  await key('\uE00F'); assert(await asyncExecute(`const done=arguments[0];setTimeout(()=>done(board.root.children[0].querySelector('.project-board-content').scrollTop>0),200);`), 'group native keyboard scrolling failed');
  await execute(`board.setEditing(true);`); await drag('.project-board-resize', 115, 48);
  await execute(`board.root.children[0].querySelector('.project-board-resize').focus();`); await key('\uE013'); await key('\uE013');
  assert(await execute(`const card=board.root.children[0],content=card.querySelector('.project-board-content'),r=card.getBoundingClientRect(),c=content.getBoundingClientRect();return board.getLayout()[0].id==='accounts'&&board.getLayout()[0].h===6&&Math.abs(r.height-132)<1&&c.bottom<=r.bottom+.5&&card.scrollHeight<=card.clientHeight+1&&edits.at(-1)[0].id==='accounts';`), 'group mouse/keyboard resize broke containment or callback identity');
  await asyncExecute('const done=arguments[0];board.update(rows,{layout:device}).then(()=>{board.setEditing(false);window.edits=[];done(true);});');
  assert(await execute(`return matchMedia('(prefers-reduced-motion: reduce)').matches&&getComputedStyle(board.root.children[0]).transitionDuration==='0s';`), 'OS reduced-motion ignored');
  await execute(`document.documentElement.dataset.reducedMotion='true';`); assert(await execute(`return getComputedStyle(board.root.children[0]).transitionDuration==='0s';`), 'device reduced-motion ignored');
  await bidi('browsingContext.setViewport', { context, viewport: { width: 1440, height: 900 }, devicePixelRatio: 1 });
  await asyncExecute('const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));');
  await execute(`board.setEditing(true);board.root.children[0].querySelector('.project-board-handle').focus();`);
  await key('\uE014'); assert(await execute(`return edits.length===1&&board.getLayout()[0].x===1&&board.getLayout()[1].y===12;`), 'real keyboard move/collision did not save full array');
  await key('\uE015', true); assert(await execute(`return edits.length===2&&board.getLayout()[0].h===13&&edits.at(-1).length===5;`), 'real Shift-key resize failed');
  await asyncExecute('const done=arguments[0];board.update(rows,{layout:device}).then(()=>done(true));');
  await drag('.project-board-handle', 115, 48); assert(await execute(`return edits.length===3&&board.getLayout()[0].x===1&&board.getLayout()[0].y===2;`), 'real mouse grid snap/commit failed');
  await drag('.project-board-resize', 115, 48); assert(await execute(`return edits.length===4&&board.getLayout()[0].w===7&&board.getLayout()[0].h===14;`), 'real corner resize failed');
  await drag('.project-board-handle', 115, 24, 'touch'); assert(await execute(`return edits.length===5;`), 'real sideways touch drag did not commit');
  // Real mouse then keyboard shrinking exercises the same shell after updates,
  // not only freshly mounted cards. Every reduction must keep the viewport bound.
  await drag('.project-board-resize', -115, -144);
  await execute(`board.root.children[0].querySelector('.project-board-resize').focus();`);
  await key('\uE013'); await key('\uE013');
  assert(await execute(`const card=board.root.children[0],content=card.querySelector('.project-board-content'),r=card.getBoundingClientRect(),c=content.getBoundingClientRect();return board.getLayout()[0].h===6&&Math.abs(r.height-132)<1&&c.top>=r.top&&c.bottom<=r.bottom+.5&&content.scrollHeight>content.clientHeight&&card.scrollHeight<=card.clientHeight+1;`), 'real mouse/keyboard shrinking escaped the grid');
  await execute(`board.setEditing(false);const content=board.root.children[0].querySelector('.project-board-content');content.scrollTop=0;content.focus();window.beforeKeyboardScroll=content.scrollTop;`);
  await key('\uE00F');
  assert(await asyncExecute(`const done=arguments[0];setTimeout(()=>done(board.root.children[0].querySelector('.project-board-content').scrollTop>beforeKeyboardScroll),200);`), 'native keyboard PageDown cannot scroll short card');
  await execute('board.setEditing(true);window.saved=board.getLayout();window.count=edits.length;');
  await drag('.project-board-handle', 0, 160, 'touch'); assert(await execute(`return edits.length===count&&JSON.stringify(board.getLayout())===JSON.stringify(saved);`), 'vertical touch saved a drag');
  console.log('LIMIT Firefox WebDriver touch pan may not scroll physically; uncancelled pan-y intent and native inner scroll verified, hardware touch remains untested.');
  // Explicit cancellation events and stale handlers supplement real input coverage.
  for (const cancel of ['pointercancel', 'lostpointercapture', 'pagehide']) {
    await execute(`const h=board.root.children[0].querySelector('.project-board-handle');h.dispatchEvent(new PointerEvent('pointerdown',{pointerId:42,button:0,clientX:20,clientY:20}));h.dispatchEvent(new PointerEvent('pointermove',{pointerId:42,clientX:240,clientY:68,cancelable:true}));${cancel === 'pagehide' ? "dispatchEvent(new Event('pagehide'));" : `h.dispatchEvent(new PointerEvent('${cancel}',{pointerId:42}));`}h.dispatchEvent(new PointerEvent('pointerup',{pointerId:42}));`);
    assert(await execute('return edits.length===count&&JSON.stringify(board.getLayout())===JSON.stringify(saved);'), `cancel ${cancel} saved preview`);
  }
  await execute('window.stale=board.root.children[0].querySelector(".project-board-handle");');
  await asyncExecute('const done=arguments[0];board.update(rows,{layout:device}).then(()=>done(true));');
  assert(await execute(`stale.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown'}));return edits.length===count&&JSON.stringify(board.getLayout())===JSON.stringify(device);`), 'stale generation/device reread failed');
  await asyncExecute('const done=arguments[0];mount(device).then(()=>done(true));');
  assert(await execute(`return JSON.stringify(board.getLayout())===JSON.stringify(device)&&!board.root.lastElementChild.hasAttribute('data-board-color')&&board.root.lastElementChild.textContent.includes('12.5 USD');`), 'remount/account content isolation failed');
  await execute(`board.setEditing(true);window.owns=false;board.root.querySelector('.project-board-handle').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown'}));`);
  assert(await execute('return edits.length===window.count;'), `abandoned page committed: ${JSON.stringify(await execute('return {edits:edits.length,count:window.count,owns:window.owns,last:edits.at(-1)};'))}`);
  assert(writes.length === 0 && reads.every(id => ids.includes(id)), 'unexpected mutation/account appearance');
  assert(await execute('return browserErrors.length===0&&cspErrors.length===0;'), `browser/CSP errors: ${JSON.stringify(await execute('return {browserErrors,cspErrors};'))}`);
  console.log(`PASS real keyboard, mouse move/resize, touch intent, cancellation, device reread, CSP CSSOM. Logs/screenshots: ${output}`);
} catch (error) {
  if (session) await screenshot('failure').catch(() => {}); console.error(`Browser fixture failed; full logs/screenshots: ${output}`); throw error;
} finally {
  socket?.close(); if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  if (driver) { driver.kill(); await driver.exited; } server?.stop(true);
}
