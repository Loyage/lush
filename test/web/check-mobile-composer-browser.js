// bun test/web/check-mobile-composer-browser.js — real Firefox layout/input, temporary fixture only.
// Soft keyboard geometry is simulated via VisualViewport; this is not an iOS/Android device test.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const composerOnly = process.argv.includes('--composer-only');
const script = `<script type="module">
import {initComposer,appendToWorker,syncComposer} from '/composer.js';
import {ui} from '/state.js';
import {registerNavigation} from '/navigate.js';
import {initSidebar} from '/sidebar-init.js';
import {toggleMobileNavigation,activateDetailView,setNavCount} from '/sidebar-ui.js';
const nativeMatch=window.matchMedia.bind(window);window.touch=false;
window.matchMedia=q=>q==='(pointer: coarse)'?{matches:window.touch}:nativeMatch(q);
const viewport=new EventTarget();Object.assign(viewport,{height:innerHeight,offsetTop:0,scale:1});
Object.defineProperty(window,'visualViewport',{value:viewport,configurable:true});
window.keyboard=h=>{viewport.height=h;viewport.dispatchEvent(new Event('resize'));};
window.calls=[];window.fail=false;window.defer=false;
window.fetch=async(url,options)=>{if(String(url).endsWith('/api/input-parents'))return Response.json({items:[{id:1,branch:'main'}]});
const body=JSON.parse(options.body);window.calls.push(body);if(window.defer)await new Promise(r=>window.release=r);
if(window.fail)return Response.json({error:'fixture failure'},{status:500});return Response.json(body.method==='draft.add'?{id:4}:{emitted:true,draft_id:4,dispatch:{state:'queued'}});};
registerNavigation({refresh:async()=>{},detail:async()=>{}});ui.view={id:'overview'};
document.documentElement.dataset.lushSpace='project';
document.querySelector('#project').textContent='手机体验项目';
initSidebar();setNavCount('notices',1234);setNavCount('tasks',12345);
document.querySelector('#sidebar-toggle').onclick=()=>toggleMobileNavigation();
window.page=()=>activateDetailView({view:'overview'});
window.menu=()=>toggleMobileNavigation(true);
window.space=value=>{document.documentElement.dataset.lushSpace=value;document.querySelector('#composer-shell').hidden=value==='global';};
for(const id of ['notices','tasks'])document.querySelector('#side-'+id+'-body').innerHTML='<div style="height:1800px">Scrollable resource content</div>';
document.querySelector('#detail').innerHTML='<h1>Long content</h1><div style="height:1800px">Scrollable content</div>';
window.append=()=>{ui.view={id:'task'};ui.selected=8;appendToWorker({id:8,worker_number:'W8',task_kind:'order',status:'waiting',branch:'feature',workspace:'/tmp/fixture',goal:'追加目标'});};
window.frozen=value=>{ui.composerParents=[{id:1,branch:'main',...(value?{freeze:{reason:'fixture freeze'}}:{})}];syncComposer();};
await initComposer();window.ready=true;
</script>`;
const html = (await Bun.file(join(assets,'index.html')).text()).replace(/<script[^>]*src="\/(?:app|appearance)\.js"[^>]*><\/script>/g,'').replace('</body>',script+'</body>');
const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
  const path=new URL(req.url).pathname;
  if(path==='/')return new Response('<html><body style="margin:0"><iframe id="viewport" src="/fixture" style="width:390px;height:844px;border:0"></iframe></body></html>',{headers:{'Content-Type':'text/html'}});
  if(path==='/fixture')return new Response(html,{headers:{'Content-Type':'text/html'}});
  if(/^\/[\w.-]+\.(js|css)$/.test(path))return new Response(Bun.file(join(assets,path.slice(1))));
  return new Response('not found',{status:404});
}});
const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')});const port=reservation.port;reservation.stop(true);
const temp=await mkdtemp(join(tmpdir(),'lush-mobile-browser-')),log=join(temp,'geckodriver.log');
const driver=Bun.spawn(['geckodriver','--host','127.0.0.1','--port',String(port)],{env:{...process.env,MOZ_HEADLESS:'1'},stdout:Bun.file(log),stderr:Bun.file(log)});
let session,passed=false;
async function rpc(path,body,method='POST'){
  const response=await new Promise((resolve,reject)=>{const req=request(`http://127.0.0.1:${port}${path}`,{method,headers:{'Content-Type':'application/json'}},res=>{
    let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,text}));res.on('error',reject);
  });req.on('error',reject);req.setTimeout(60000,()=>req.destroy(Error('WebDriver timeout')));req.end(body===undefined?undefined:JSON.stringify(body));});
  const data=JSON.parse(response.text);if(response.status>=400)throw Error(JSON.stringify(data));return data.value;
}
const execute=script=>rpc(`/session/${session}/execute/sync`,{script,args:[]});
const wait=expression=>rpc(`/session/${session}/execute/async`,{script:`const done=arguments[0];let n=0;const check=()=>(${expression})?done(true):++n>100?done(false):setTimeout(check,20);check();`,args:[]});
function assert(value,message){if(!value)throw Error(message);}
async function click(selector){const e=await rpc(`/session/${session}/element`,{using:'css selector',value:selector});await rpc(`/session/${session}/element/${e['element-6066-11e4-a52e-4f735466cecf']}/click`,{});}
async function keys(values){const actions=values.flatMap(value=>[{type:'keyDown',value},{type:'keyUp',value}]);await rpc(`/session/${session}/actions`,{actions:[{type:'key',id:'keyboard',actions}]});}
async function resize(width,height){await rpc(`/session/${session}/frame`,{id:null});await execute(`const f=document.querySelector('#viewport');f.style.width='${width}px';f.style.height='${height}px';`);
  const frame=await rpc(`/session/${session}/element`,{using:'css selector',value:'#viewport'});await rpc(`/session/${session}/frame`,{id:frame});await execute('window.keyboard(innerHeight)');}
try{
  let ready=false;for(let i=0;i<100;i++){try{await rpc('/status',undefined,'GET');ready=true;break;}catch{}if(driver.exitCode!==null)throw Error('geckodriver exited');await Bun.sleep(100);}assert(ready,'driver startup timeout');
  session=(await rpc('/session',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{args:['-headless']}}}})).sessionId;
  await rpc(`/session/${session}/window/rect`,{width:1600,height:1100});await rpc(`/session/${session}/url`,{url:`http://127.0.0.1:${server.port}/`});
  await resize(390,844);assert(await wait('window.ready'),'fixture load failed');
  for(const theme of ['light','dark'])for(const [width,height]of [[320,700],[390,844],[760,700],[1440,900]]){
    await resize(width,height);await execute(`document.documentElement.dataset.theme='${theme}';document.documentElement.dataset.projectColor='blue';window.touch=${width<=760};document.querySelector('#input').focus();`);
    assert(await wait(`document.querySelector('#input').getBoundingClientRect().bottom<=innerHeight+1`),'focus did not expose input');
    assert(await execute(`return document.querySelector('#composer-editor-tools').hidden&&document.querySelector('.text-editor-undo').getClientRects().length===0;`),`editor controls visible by default ${width} ${theme}`);
    assert(await execute(`const visible=Array.from(document.querySelectorAll('.composer-actions button')).filter(b=>b.getClientRects().length);const r=visible.map(b=>b.getBoundingClientRect());return innerWidth>760||visible.length===4&&r.every(b=>Math.abs(b.top-r[0].top)<1&&b.height===36&&b.left>=0&&b.right<=innerWidth);`),`default actions not one compact row ${width} ${theme}`);
    assert(await execute(`return document.querySelector('#composer-runner-choice .runner-input-choice').getClientRects().length===0;`),`environment visible before More ${width} ${theme}`);
    await click('#composer-expand');
    assert(await execute(`return document.querySelector('#composer-runner-choice .runner-input-choice').getClientRects().length>0;`),`environment missing after More ${width} ${theme}`);
    assert(await execute(`return !document.querySelector('#composer-editor-tools').hidden&&document.querySelector('.text-editor-undo').getClientRects().length>0&&document.querySelector('#input-history').getClientRects().length>0&&document.querySelector('#input-drafts').getClientRects().length>0&&!document.querySelector('#composer-chat-open,#composer-chat-controls,#quick-chat-open');`),`editor controls not expanded or retired chat entry present ${width} ${theme}`);
    assert(await execute(`return document.documentElement.scrollWidth<=innerWidth&&Array.from(document.querySelectorAll('.composer-actions button,.text-editor-controls button')).filter(b=>b.getClientRects().length).every(b=>{const r=b.getBoundingClientRect();return r.right<=innerWidth+1&&(innerWidth>760||r.height>=36)});`),`clipped/small controls ${width} ${theme}`);
    await click('#composer-expand');
    console.log(`PASS focus, compact default/expanded controls, themes ${theme} ${width}x${height}`);
    if(width<=760){
      await execute('window.frozen(true);');
      assert(await execute(`const r=Array.from(document.querySelectorAll('.composer-actions button')).filter(b=>b.getClientRects().length).map(b=>b.getBoundingClientRect());return r.length===4&&r.every(b=>Math.abs(b.top-r[0].top)<1&&b.left>=0&&b.right<=innerWidth);`),`frozen buttons wrap/overflow ${width}`);
      await execute('window.frozen(false);');
    }
    if(width<=760 && !composerOnly){
      await execute('document.querySelector("#input").blur();window.scrollTo(0,700);');
      assert(await execute(`const r=document.querySelector('.rail-heading').getBoundingClientRect();return Math.abs(document.querySelector('#sidebar').getBoundingClientRect().top)<1&&r.height===52&&document.querySelector('#sidebar-toggle').getBoundingClientRect().right<=innerWidth;`),`header not pinned ${width} ${theme}`);
      await click('#sidebar-toggle');
      assert(await execute(`const buttons=Array.from(document.querySelectorAll('#navigation-menu .workspace-link,#navigation-menu .nav-item')).filter(b=>b.getClientRects().length);return document.querySelector('#sidebar-toggle').getAttribute('aria-expanded')==='true'&&buttons.length===8&&buttons.some(b=>b.id==='drafts-open')&&buttons.some(b=>b.id==='inputs-open')&&buttons.every(b=>{const r=b.getBoundingClientRect();return r.height===44&&r.width<=innerWidth/2&&r.left>=0&&r.right<=innerWidth;});`),`inconsistent navigation cards ${width} ${theme}`);
      await execute(`const r=document.querySelector('#navigation-menu').getBoundingClientRect(),header=document.querySelector('#sidebar').getBoundingClientRect();if(Math.abs(r.top-header.bottom)>1)throw Error('menu overlaps project header');`);
      if(width===390)await Bun.write(`/tmp/w206-mobile-nav-${theme}.png`,Buffer.from(await rpc(`/session/${session}/screenshot`,undefined,'GET'),'base64'));
      for(const id of ['notices','tasks']){
        await click('[data-side="'+id+'"].nav-item');
        assert(await execute(`return document.querySelector('#sidebar-toggle').getAttribute('aria-expanded')==='false'&&!document.querySelector('#side-${id}').hidden&&document.querySelector('#mobile-view-title').textContent===document.querySelector('#view-title').textContent;`),`resource navigation did not close/update header ${id}`);
        await execute('window.scrollTo(0,700)');await click('#sidebar-toggle');
        assert(await execute(`return Math.abs(document.querySelector('#sidebar').getBoundingClientRect().top)<1;`),`resource header disappeared ${id}`);
      }
      await resize(width,320);
      await execute('window.page();window.space("global");window.menu();');
      const menuGeometry=await execute(`const m=document.querySelector('#navigation-menu');m.scrollTop=m.scrollHeight;return {scroll:m.scrollHeight,height:m.clientHeight,bottom:m.getBoundingClientRect().bottom,viewport:innerHeight,links:Array.from(m.querySelectorAll('.workspace-link')).filter(b=>b.getClientRects().length).length,top:document.querySelector('#sidebar').getBoundingClientRect().top};`);
      assert(menuGeometry.scroll>menuGeometry.height&&menuGeometry.bottom<=menuGeometry.viewport+1&&menuGeometry.links===10&&Math.abs(menuGeometry.top)<1,`global menu not independently scrollable ${width}: ${JSON.stringify(menuGeometry)}`);
      await execute('window.space("project");window.page();window.scrollTo(0,0);');
      await resize(width,height);
      console.log(`PASS pinned header, equal navigation cards, resource jumps, global scrollable menu ${theme} ${width}`);
    }
  }
  await resize(390,844);await execute(`window.touch=true;document.querySelector('#input').focus();`);
  await keys(['a','b','\uE007','c']);
  assert(await execute(`return document.querySelector('#input').value==='ab\\nc'&&window.calls.length===0`),'touch Enter did not insert native newline');
  await click('#composer-expand');
  await click('.text-editor-undo');assert(await execute(`return document.querySelector('#input').value==='ab\\n'&&window.calls.length===0`),'undo submitted or restored wrong text');
  await click('.text-editor-redo');assert(await execute(`return document.querySelector('#input').value==='ab\\nc'`),'redo failed');
  await execute(`window.keyboard(420);document.querySelector('#input').focus();`);
  assert(await wait(`document.querySelector('#input').getBoundingClientRect().bottom<=420&&document.querySelector('#draft-commit').getBoundingClientRect().bottom<=420`),'overlay keyboard hides input/actions');
  console.log('PASS touch native newline, undo/redo, simulated overlay keyboard');
  assert(await execute(`return !document.querySelector('#input-start,.emission-conditions')`),'composer contains conditional controls');
  await click('#draft-commit');assert(await wait(`document.querySelector('#input').value===''`),'emit did not release text');
  assert(await execute(`return window.calls.length===1&&window.calls[0].method==='input.emit'&&!window.calls[0].params.conditions&&document.querySelector('.text-editor-undo').disabled`),'emit mode or history cleanup failed');
  await execute(`window.keyboard(innerHeight);window.frozen(true);document.querySelector('#input').focus();`);await keys(['x']);await click('#draft-commit');
  assert(await wait(`window.calls.length===2`),'frozen input not submitted');assert(await execute(`return window.calls[1].method==='input.emit'&&!('start' in window.calls[1].params)&&!('defer' in window.calls[1].params)`),'frozen input bypasses reliable emission');
  await click('#composer-expand');
  await execute(`window.frozen(false);window.append();`);
  await click('#composer-expand');
  assert(await execute(`return !document.querySelector('#composer-editor-tools').hidden&&document.querySelector('#composer-details').hidden&&document.querySelector('#composer-runner-choice .runner-input-choice').getClientRects().length===0;`),'append more does not expose editor or exposes parent');
  await execute(`document.querySelector('#input').focus();`);await keys(['z','\uE007']);
  assert(await execute(`return window.calls.length===2&&!document.querySelector('#input-start')`),'append enter sends or conditional entry remains');await click('#draft-commit');
  assert(await wait(`window.calls.length===3`),'append not submitted');assert(await execute(`return window.calls[2].method==='input.emit'&&window.calls[2].params.mode==='append'&&window.calls[2].params.target_id===8`),'append created worker');
  console.log('PASS direct reliable emission, frozen waiting, append mode and consumed undo history');
  await resize(1440,900);
  for(const appendMode of [false,true]){
    await execute(`window.touch=false;${appendMode?'window.append();':''}document.querySelector('#input').focus();`);await keys(['s']);
    await rpc(`/session/${session}/actions`,{actions:[{type:'key',id:'keyboard',actions:[{type:'keyDown',value:'\uE009'},{type:'keyDown',value:'\uE008'},{type:'keyDown',value:'\uE007'},{type:'keyUp',value:'\uE007'},{type:'keyUp',value:'\uE008'},{type:'keyUp',value:'\uE009'}]}]});
    assert(await wait(`document.querySelector('#input').value===''`),'Ctrl+Shift+Enter did not emit');
    assert(await execute(`return window.calls.at(-1).method==='input.emit'&&Boolean(window.calls.at(-1).params.mode==='append')===${appendMode}&&!window.calls.at(-1).params.conditions&&!document.querySelector('.emission-conditions');`),'shifted shortcut opened conditions or changed destination');
  }
  console.log('PASS native Ctrl+Shift+Enter directly emits both new and append inputs');
  passed=true;
}finally{
  if(session)await rpc(`/session/${session}`,undefined,'DELETE').catch(()=>{});driver.kill();await driver.exited;server.stop(true);
  if(passed)await rm(temp,{recursive:true,force:true});else console.error('Browser failure log:',log);
}
