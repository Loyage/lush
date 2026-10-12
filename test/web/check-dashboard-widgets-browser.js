// Isolated Firefox fixed-widget/grid/CSP fixture. No user Host, daemon,
// credentials, provider or model; actual widget composition is verified by W234.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const output = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'lush-fixed-widgets-')));
fs.mkdirSync(output, { recursive: true });
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['styles.css','styles-core.css','styles-workbench.css','styles-project-board.css','styles-dashboard-cards.css'].map(name => `<link rel="stylesheet" href="/assets/${name}">`).join('')}
<link rel="stylesheet" href="/fixture.css"></head><body><main class="workbench-view project-overview"><div id="mount"></div></main><script type="module" src="/fixture.js"></script></body></html>`;
const fixture = `
import {createProjectBoard} from '/assets/project-board.js';
window.errors=[];window.violations=[];window.edits=[];window.geometryChanges=[];window.owns=true;
addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
addEventListener('securitypolicyviolation',e=>violations.push(e.violatedDirective+':'+e.blockedURI));
window.observers=[];
for(const name of ['ResizeObserver','MutationObserver']){const Native=globalThis[name];globalThis[name]=class extends Native{constructor(callback){super(callback);observers.push(this);this.active=false;}observe(...args){this.active=true;super.observe(...args);}disconnect(){this.active=false;super.disconnect();}};}
const make=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
window.rows=['1111111111111111','2222222222222222','3333333333333333'].map((id,i)=>({id,type:'project',name:'项目 '+i+' · '+('长标题'.repeat(80)),state:'empty',count:0}));
rows.push({id:'accounts',type:'accounts',name:'账户额度',state:'empty',count:0});
window.device=rows.map((row,i)=>({id:row.id,x:i%2*6,y:Math.floor(i/2)*24,w:6,h:row.type==='accounts'?16:24}));
function fill(row,geometry,item){
 const body=item.querySelector('.dashboard-widget-body');body.replaceChildren();
 const budget=geometry.h*24-140;
 const capacity=row.type==='accounts'?Math.min(3,Math.max(1,Math.floor((budget+4)/92))):Math.max(0,Math.floor((budget-292)/48));
 item.querySelector('.dashboard-widget-pagination').hidden=row.type==='project'&&!capacity;
 const pages=Math.max(1,Math.ceil((row.type==='accounts'?Math.min(100,row.count):row.count)/Math.max(1,capacity)));row.page=Math.max(1,Math.min(row.page||1,pages));
 item.querySelector('.fixture-count').textContent=row.count?row.page+' / '+pages:'0';
 if(row.type==='accounts'){
  const list=make('ul',undefined,'dashboard-accounts-items');
  for(let i=0;i<capacity;i++){
   const li=make('li',undefined,'dashboard-account-card dashboard-account-embedded dashboard-widget-slot');
   const header=make('header',undefined,'dashboard-account-header'),identity=make('div',undefined,'dashboard-account-identity');
   identity.append(make('h3','账号 '+i+' · '+('长账号'.repeat(60))),make('small','3分钟前','dashboard-account-age'));
   if(['empty','error','offline'].includes(row.state))identity.append(make('small',row.state==='empty'?'未知':row.state+'未确认','dashboard-account-state'));
   header.append(identity);
   for(const text of ['↻','详情']){const button=make('button',text);button.type='button';button.dataset.help=text==='↻'?'只查询本账户的额度':'打开全部资源详情，不调用模型';header.append(button);}
   const metrics=make('div',undefined,'dashboard-account-metrics-bounded');
   for(let j=0;j<2;j++){
    // Match the real metric node: heading (reading + reset) and progress,
    // not an extra wrapper with a second fake value row.
    const metric=make('section',undefined,'dashboard-account-metric dashboard-account-metric-slot');
    const unknown=['empty','error','offline'].includes(row.state);
    const heading=make('h4',unknown?(j?'现金 · 未确认':'5小时 · 未确认'):j?'现金 · $12.50 '+('长币种'.repeat(80)):'5小时 · 已用37%');heading.append(make('small',unknown?'—':'重置 3h','dashboard-account-reset-inline'));metric.append(heading);
    const p=make('progress',undefined,'dashboard-account-progress');p.max=100;if(!unknown)p.value=37;p.setAttribute('aria-label',unknown?'额度未确认':j?'现金余额观测':'套餐已用37%');metric.append(p);metrics.append(metric);
   }
   li.append(header,metrics);list.append(li);
  }
  body.append(list);return;
 }
 const content=make('div',undefined,'project-dashboard-content');
 const unknown=['error','offline'].includes(row.state);
 // Priority is geometry-only: h10 reserves both message rows; additional
 // selected sections are reachable through the footer's full-page entry.
 let remaining=budget-92;
 if(remaining>=98){
  const development=make('section',undefined,'project-development'),metrics=make('div',undefined,'project-development-metrics');
  for(const [label,value,tone] of [['Worker',row.count,'blue'],['调用',row.count?2:0,'violet'],['待验收',row.count?3:0,'violet'],['待决',row.count,'amber'],['失败',row.count?1:0,'amber'],['合并',row.count?4:0,'green']]){
   const metric=make('div',undefined,'project-development-metric tone-'+tone);metric.append(make('span',label,'metric-label'),make('strong',unknown?'—':String(value),'project-development-value'));metrics.append(metric);
  }
  development.append(metrics);remaining-=98;
  if(remaining>=50){const distribution=make('div',undefined,'project-development-distribution');distribution.append(make('span',unknown?'未确认':'运行 2','chip tone-blue'),make('span',unknown?'未确认':'待验收 3','chip tone-violet'));development.append(distribution);remaining-=50;}
  if(remaining>=50){development.append(make('p',unknown?'未确认':'待合并4 · 合并中1 · 冲突1','project-development-delivery'));remaining-=50;}
  content.append(development);
 }
 const messages=make('section',undefined,'project-dashboard-messages'),list=make('ul',undefined,'dashboard-widget-slots');
 for(const kind of ['open','unread']){
  const li=make('li',undefined,'dashboard-widget-slot dashboard-widget-message '+(kind==='open'?'tone-amber':'tone-blue'));
  li.append(make('span',unknown?'—':String(row.count),'dashboard-widget-count'));
  const a=make('a',undefined,'project-dashboard-message');a.href='/source/'+row.id+'/'+kind;
  a.append(make('span',kind==='open'?'D123':'N123','tid'),make('strong',row.state==='empty'?'—':unknown?'来源未确认':('最新标题'.repeat(row.state==='long'?80:3))),make('small','W123-1-1-1-1-1-1'));li.append(a);
  if(kind==='unread'){
   const ack=make('button','已知','dashboard-widget-notice-read');ack.type='button';ack.disabled=unknown||!row.count;
   ack.onclick=()=>{row.count=Math.max(0,row.count-1);fill(row,geometry,item);};
   const host=make('span',undefined,'help-host');if(ack.disabled)host.dataset.help=unknown?'来源尚未确认，不能标记已知':'当前没有未读告知';host.append(ack);li.append(host);
  }
  list.append(li);
 }
 messages.append(list);content.append(messages);
 if(capacity){
  const recent=make('section',undefined,'project-development-recent');
  if(!row.count){const empty=make('p',undefined,'dashboard-widget-empty');empty.append(make('span','—'));recent.append(empty);}
  for(let i=0;i<Math.min(row.count,capacity);i++){
   const worker=make('div',undefined,'project-development-worker dashboard-widget-slot'),link=make('a',undefined,'project-development-worker-link');link.href='/source/'+row.id+'/worker/'+((row.page-1)*capacity+i);link.append(make('span','W123-1-'+(i+1),'tid'),make('span','当前成果 '+('超长Worker'.repeat(60))));worker.append(link,make('span','运行','chip tone-blue'));recent.append(worker);
  }
  content.append(recent);
 }
 body.append(content);
}
function renderCard(row,{geometry}){
 const item=make('li',undefined,'project-item dashboard-widget'+(row.type==='accounts'?' dashboard-accounts-group':''));item.dataset.widgetType=row.type;item.dataset.cardId=row.id;
 item.dashboardReady=async()=>{if(!item.isConnected)throw Error('ready before mount');};
 const head=make('header',undefined,'dashboard-widget-header'+(row.type==='accounts'?' dashboard-accounts-header':''));
 if(row.type==='project'){const a=make('a',undefined,'project-open');a.href='/source/'+row.id;a.append(make('strong',row.name));head.append(a);}else head.append(make('h2',row.name,'dashboard-widget-title'));
 const body=make('div',undefined,'dashboard-widget-body'),foot=make('footer',undefined,'dashboard-widget-footer');
 const pagination=make('nav',undefined,'dashboard-widget-pagination');pagination.setAttribute('aria-label','卡片分页');const count=make('span','0','fixture-count');pagination.append(count);
 for(const text of ['‹','›']){const button=make('button',text);button.type='button';button.dataset.help=text==='‹'?'查看前一页卡片内容':'查看后一页卡片内容';button.onclick=()=>{row.page=(row.page||1)+(text==='‹'?-1:1);fill(row,row.geometry,item);};pagination.append(button);}foot.append(pagination);
 const open=make('a','打开');open.href='/source/'+row.id;foot.append(open);
 const host=make('span',undefined,'help-host dashboard-card-settings-host'),settings=make('button','⚙','dashboard-card-settings');settings.type='button';settings.setAttribute('aria-label','卡片设置');settings.dataset.help='选择卡片显示的信息';host.append(settings);
 item.append(head,body,foot,host);fill(row,geometry,item);return item;
}
window.board=createProjectBoard({renderCard,ownsPage:()=>owns,onLayoutChange:value=>edits.push(value),onGeometryChange:(row,geometry,item)=>{geometryChanges.push(geometry);fill(row,geometry,item);}});
document.querySelector('#mount').append(board.root);await board.update(rows,{layout:device});await Promise.all([...board.root.children].map(item=>item.dashboardReady()));
window.refresh=async(state,count)=>{for(const row of rows){row.state=state;row.count=count;}await board.update(rows);};
window.snapshot=()=>[...board.root.children].map(card=>{const r=card.getBoundingClientRect();return {id:card.dataset.boardId,x:r.x,y:r.y,w:r.width,h:r.height};});
window.check=()=>{
 const problems=[];const rects=[];for(const card of board.root.children){const r=card.getBoundingClientRect();rects.push(r);
  if(r.left<0||r.right>innerWidth+.5)problems.push('card width');
  if(card.scrollWidth>card.clientWidth+1||card.scrollHeight>card.clientHeight+1)problems.push('card overflow '+card.dataset.boardId);
  for(const n of card.querySelectorAll('a,button,progress')){if(n.hidden||getComputedStyle(n).display==='none')continue;const b=n.getBoundingClientRect();
   if(b.width>0&&(b.left<r.left-.5||b.right>r.right+.5||b.top<r.top-.5||b.bottom>r.bottom+.5))problems.push('hidden/outside control '+n.textContent);
   const slot=n.closest('.dashboard-widget-slot,.dashboard-account-metric-slot');
   if(slot){const s=slot.getBoundingClientRect();if(b.left<s.left-.5||b.right>s.right+.5||b.top<s.top-.5||b.bottom>s.bottom+.5)problems.push('control escaped fixed slot '+n.textContent);}
  }
  const body=card.querySelector('.dashboard-widget-body');
  if(Math.abs(body.getBoundingClientRect().height-(Number(card.style.gridRow.split('span ')[1])*24-140))>.5)problems.push('shell budget');
  const expected={'.project-development-metrics':92,'.project-development-distribution':44,'.project-development-delivery':44,'.project-dashboard-messages':92,'.project-development-worker':44};
  for(const [selector,height] of Object.entries(expected))for(const n of body.querySelectorAll(selector))if(Math.abs(n.getBoundingClientRect().height-height)>.5)problems.push('section budget '+selector);
  const metrics=body.querySelector('.project-development-metrics');if(metrics&&metrics.children.length!==6)problems.push('metric count');
  for(const n of body.querySelectorAll('.project-development-metric'))if(Math.abs(n.getBoundingClientRect().height-28)>.5||getComputedStyle(n.querySelector('.project-development-value')).fontSize!=='20px'||getComputedStyle(n.querySelector('.metric-label')).fontSize!=='11px')problems.push('six-metric density');
  if(body.scrollHeight>body.clientHeight+1)problems.push('body slots overflow '+JSON.stringify({height:body.clientHeight,scroll:body.scrollHeight,parts:[...body.firstElementChild.children].map(n=>({class:n.className,height:n.getBoundingClientRect().height}))}));
  const content=card.querySelector('.project-board-content');if(content.scrollTop!==0||content.scrollHeight>content.clientHeight+1)problems.push('inner scroll');
 }
 for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)problems.push('overlap');}
 if(document.documentElement.scrollWidth>innerWidth+1)problems.push('page overflow');return problems;
};window.ready=true;
`;
const css = 'body{margin:0}main{display:block!important}#mount{min-width:0}.dashboard-widget-footer a{flex:none}';
let server, driver, session, socket, base, sequence = 0;
const pending = new Map(), reads = [], unexpected = [];
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
const settle = () => asyncExecute('const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))));');
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
    { type: 'pointerMove', duration: 150, x: point.x + dx, y: point.y },
    { type: 'pointerMove', duration: 150, x: point.x + dx, y: point.y + dy }, { type: 'pointerUp', button: 0 },
  ] }] }); await rpc(`/session/${session}/actions`, undefined, 'DELETE'); await settle();
}
try {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET') { unexpected.push(request.method + ' ' + url.pathname); return new Response('', { status: 405 }); }
    if (url.pathname === '/') return new Response(html, { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': csp } });
    if (url.pathname === '/fixture.js') return new Response(fixture, { headers: { 'Content-Type': 'text/javascript' } });
    if (url.pathname === '/fixture.css') return new Response(css, { headers: { 'Content-Type': 'text/css' } });
    if (/^\/assets\/[\w.-]+\.(js|css)$/.test(url.pathname)) return new Response(Bun.file(path.join(assets, path.basename(url.pathname))));
    const appearance = /^\/api\/host\/projects\/([123]{16})\/appearance$/.exec(url.pathname);
    if (appearance) { reads.push(url.pathname); return Response.json({ id: appearance[1], appearance: { version: 1, color: { '1': 'green', '2': 'blue', '3': 'rose' }[appearance[1][0]] } }); }
    if (url.pathname === '/favicon.ico') return new Response('', { status: 204 });
    unexpected.push(url.pathname); return new Response('', { status: 404 });
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
  const initialReads = reads.length;
  for (const theme of ['light', 'dark']) for (const width of [320, 390, 624, 640, 900, 1024, 1040, 1440]) {
    await bidi('browsingContext.setViewport', { context, viewport: { width, height: 900 }, devicePixelRatio: 1 });
    await execute(`document.documentElement.dataset.theme='${theme}';window.scrollTo(0,0);`); await settle();
    const baseline = await execute('return snapshot();');
    const palette=await execute('const s=getComputedStyle(board.root.children[0]);return {ink:s.getPropertyValue("--board-ink").trim(),running:s.getPropertyValue("--running").trim(),agent:s.getPropertyValue("--violet").trim(),main:getComputedStyle(document.querySelector("main")).backgroundColor};');
    assert(palette.ink===(theme==='light'?'#147457':'#8ddbb4')&&palette.running===(theme==='light'?'#287ba6':'#79c9f0')&&palette.agent===(theme==='light'?'#7955b4':'#c1a4f3')&&palette.main==='rgba(0, 0, 0, 0)', `original identity/semantic/Agent palette ${JSON.stringify(palette)}`);
    const initialGeometryCalls = await execute('return geometryChanges.length;');
    for (const [state, count] of [['empty', 0], ['one', 1], ['many', 100], ['long', 500], ['error', 100], ['offline', 100]]) {
      await asyncExecute(`const done=arguments[0];refresh('${state}',${count}).then(()=>done(true));`); await settle();
      const result = await execute('return {rects:snapshot(),problems:check(),layout:board.getLayout(),calls:geometryChanges.length};');
      assert(JSON.stringify(result.rects) === JSON.stringify(baseline), `content changed geometry ${theme}/${width}/${state}: ${JSON.stringify({ baseline, actual: result.rects })}`);
      assert(!result.problems.length, `${theme}/${width}/${state}: ${JSON.stringify(result.problems)}`);
      assert(JSON.stringify(result.layout) === JSON.stringify(await execute('return device;')), 'responsive projection persisted');
      assert(result.calls === initialGeometryCalls, 'content update fired geometry callback');
      if(state==='many')assert(await execute('return [...board.root.querySelectorAll("[data-widget-type=project]")].every(c=>c.querySelectorAll(".project-development-worker").length===3&&c.querySelector(".project-development-recent").getBoundingClientRect().height===140);'), `h24 three Worker slots ${theme}/${width}`);
      if (state === 'long') await screenshot(`populated-${theme}-${width}`);
    }
    for (const editing of [true, false]) {
      await execute(`board.setEditing(${editing});`); await settle();
      assert(await execute('return check().length===0;'), `editing hidden/overflow controls ${theme}/${width}: ${JSON.stringify(await execute('return check();'))}`);
      assert(await execute(`return [...board.root.querySelectorAll('.project-board-handle,.project-board-resize')].every(b=>b.hidden===${!editing}&&b.disabled===${!editing});`), 'editing gate');
      assert(await execute(`return [...board.root.children].every(c=>getComputedStyle(c).borderRadius==='10px'&&getComputedStyle(c).borderTopWidth==='5px'&&getComputedStyle(c).transitionDuration==='0s');`), 'card radius/reduced motion');
    }
    await screenshot(`${theme}-${width}`);
    await asyncExecute('const done=arguments[0];board.update(rows,{layout:device.map(c=>({...c,w:4,h:8}))}).then(()=>done(true));'); await settle();
    const small=await execute('return snapshot();');
    for(const editing of [false,true]){
      await execute(`board.setEditing(${editing});`);
      for(const [state,count] of [['empty',0],['one',1],['many',100],['long',500],['error',100],['offline',100]]){
        await asyncExecute(`const done=arguments[0];refresh('${state}',${count}).then(()=>done(true));`);await settle();
        const minimum=await execute('return {rects:snapshot(),problems:check(),intact:[...board.root.querySelectorAll("[data-widget-type=project]")].every(c=>c.querySelectorAll(".dashboard-widget-message").length===2&&c.querySelector(".dashboard-widget-footer a").getBoundingClientRect().height===44)};');
        assert(!minimum.problems.length&&minimum.intact&&JSON.stringify(minimum.rects)===JSON.stringify(small), `h10 messages/footer ${theme}/${width}/${editing}/${state}: ${JSON.stringify(minimum.problems)}`);
      }
    }
    await screenshot(`minimum-${theme}-${width}`);
    await execute('board.setEditing(false);');await asyncExecute('const done=arguments[0];board.update(rows,{layout:device}).then(()=>done(true));');await settle();
    console.log(`PASS ${theme}/${width}: h24 six metrics/3 Worker rows, h10 two messages/footer, fixed empty→one→many→long→error/offline, bounded controls and CSP`);
  }
  assert(reads.length === initialReads, 'appearance cache reread on content update');
  await bidi('browsingContext.setViewport', { context, viewport: { width: 1440, height: 900 }, devicePixelRatio: 1 }); await settle();
  await asyncExecute('const done=arguments[0];board.update(rows,{layout:device.map(c=>({...c,w:4,h:8}))}).then(()=>refresh("long",500)).then(()=>done(true));'); await settle();
  for (const editing of [false, true]) {
    await execute(`board.setEditing(${editing});`);
    assert(await execute('return check().length===0&&[...board.root.children].every(c=>c.getBoundingClientRect().height===228&&c.querySelector(".dashboard-widget-footer a").getBoundingClientRect().height===44);'), 'minimum geometry lost accessible controls');
  }
  await asyncExecute('const done=arguments[0];board.update(rows,{layout:device}).then(()=>done(true));'); await settle();
  await execute('board.root.lastElementChild.querySelector(".dashboard-widget-pagination button:last-child").click();window.accountPage=rows.at(-1).page;board.setEditing(true);board.root.children[0].querySelector(".project-board-handle").focus();');
  await key('\uE014'); assert(await execute('return edits.length===1&&board.getLayout()[0].x===1&&board.getLayout()[1].y===24;'), 'keyboard collision');
  await key('\uE015', true); assert(await execute('return edits.length===2&&board.getLayout()[0].h===25;'), 'keyboard fixed resize');
  await asyncExecute('const done=arguments[0];board.update(rows,{layout:device}).then(()=>done(true));');
  await drag('.project-board-handle', 115, 48); assert(await execute('return edits.length===3&&board.getLayout()[0].x===1&&board.getLayout()[0].y===2;'), 'mouse snap');
  await drag('.project-board-resize', 115, 48); assert(await execute('return edits.length===4&&board.getLayout()[0].w===7&&board.getLayout()[0].h===26;'), 'mouse resize');
  await drag('.project-board-handle', 115, 24, 'touch'); assert(await execute('return edits.length===5;'), 'touch horizontal drag');
  assert(await execute('return check().length===0&&rows.at(-1).page===accountPage;'), 'edit collision/containment/page preservation');
  await execute('window.saved=board.getLayout();window.count=edits.length;');
  await drag('.project-board-handle', 0, 160, 'touch'); assert(await execute('return edits.length===count&&JSON.stringify(board.getLayout())===JSON.stringify(saved);'), 'vertical touch committed');
  for (const cancel of ['pointercancel', 'lostpointercapture', 'Escape']) {
    await execute(`const h=board.root.children[0].querySelector('.project-board-handle');h.dispatchEvent(new PointerEvent('pointerdown',{pointerId:42,button:0,clientX:20,clientY:20}));h.dispatchEvent(new PointerEvent('pointermove',{pointerId:42,clientX:240,clientY:68,cancelable:true}));${cancel === 'Escape' ? "h.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));" : `h.dispatchEvent(new PointerEvent('${cancel}',{pointerId:42}));`}h.dispatchEvent(new PointerEvent('pointerup',{pointerId:42}));`);
    assert(await execute('return edits.length===count&&JSON.stringify(board.getLayout())===JSON.stringify(saved);'), `cancel ${cancel} saved`);
  }
  await asyncExecute('const done=arguments[0];board.update(rows,{layout:device}).then(()=>done(true));'); await settle();
  assert(await execute('return JSON.stringify(board.getLayout())===JSON.stringify(device);'), 'device cancel/reread');
  await execute('board.setEditing(false);window.beforeLate=snapshot();window.beforeCalls=geometryChanges.length;const body=board.root.children[0].querySelector(".dashboard-widget-body");const text=document.createElement("span");text.textContent="晚到错误".repeat(100);text.className="fixture-late";text.hidden=true;body.append(text);'); await settle();
  assert(await execute('return JSON.stringify(snapshot())===JSON.stringify(beforeLate)&&geometryChanges.length===beforeCalls;'), 'late mutation resized');
  assert(await execute('return board.root.children[0].querySelector(".dashboard-widget-footer a").getBoundingClientRect().height>=44;'), 'minimum footer missing');
  await execute('window.beforeReads=0;for(const n of board.root.querySelectorAll(".project-board-content")){n.getBoundingClientRect=()=>{beforeReads++;throw Error("intrinsic content measurement");};}'); await settle();
  await execute('board.setEditing(false);'); assert(await execute('return beforeReads===0;'), 'content was measured');
  await execute('dispatchEvent(new Event("pagehide"));window.owns=false;');
  assert(await execute('return observers.every(o=>!o.active);'), 'observer cleanup');
  assert(!unexpected.length, `unexpected requests ${JSON.stringify(unexpected)}`);
  assert(await execute('return errors.length===0&&violations.length===0;'), `browser/CSP errors ${JSON.stringify(await execute('return {errors,violations};'))}`);
  console.log(`PASS real keyboard/mouse/resize/touch intent/cancellation, geometry callback isolation, source cache, strict CSP. Logs/screenshots: ${output}`);
  console.log('LIMIT simulated fixture, not actual widget/controller integration; physical touch pan and Chromium/Safari remain unverified. Final composition/full suite: W234.');
} catch (error) {
  if (session) await screenshot('failure').catch(() => {}); console.error(`Browser fixture failed; full logs/screenshots: ${output}`); throw error;
} finally {
  socket?.close(); if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  if (driver) { driver.kill(); await driver.exited; } server?.stop(true);
}
