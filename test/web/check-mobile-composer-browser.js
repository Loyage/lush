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
import {valetLifecycleControls} from '/valet-actions.js';
import {ui} from '/state.js';
import {openComposer,resumeComposerDraft,selectComposerMode} from '/composer-workspace.js';
window.openComposer=openComposer;window.resumeDraft=resumeComposerDraft;window.selectComposer=selectComposerMode;
window.compact=()=>{ui.composerExpanded=false;syncComposer();};
import {registerNavigation} from '/navigate.js';
import {initSidebar} from '/sidebar-init.js';
import {toggleMobileNavigation,activateDetailView,setNavCount} from '/sidebar-ui.js';
const nativeMatch=window.matchMedia.bind(window);window.touch=false;
window.matchMedia=q=>q==='(pointer: coarse)'?{matches:window.touch}:nativeMatch(q);
const viewport=new EventTarget();Object.assign(viewport,{height:innerHeight,offsetTop:0,scale:1});
Object.defineProperty(window,'visualViewport',{value:viewport,configurable:true});
window.keyboard=h=>{viewport.height=h;viewport.dispatchEvent(new Event('resize'));};
window.calls=[];window.fail=false;window.defer=false;window.fixtureDraft={kind:'draft',id:40,draft_number:7,mode:'order',parent_id:1,branch:'main',content:'可续写暂存',references:[],revision:3,status:'draft',conditions:[{kind:'parent_quiet'}],exclusive:true};
window.fetch=async(url,options)=>{if(String(url).endsWith('/api/input-parents'))return Response.json({items:[{id:1,branch:'main'}]});
if(String(url).includes('/api/inputs?'))return Response.json({items:[window.fixtureDraft],next_cursor:null});
if(String(url).endsWith('/api/input/draft/40'))return Response.json(window.fixtureDraft);
if(String(url).endsWith('/api/worker/8'))return Response.json({id:8,worker_number:'W8',task_kind:'order',status:'waiting',branch:'feature',workspace:'/tmp/fixture',goal:'追加目标'});
if(String(url).endsWith('/api/worker/9'))return Response.json(window.valetTask);
const body=JSON.parse(options.body);window.calls.push(body);if(window.defer)await new Promise(r=>window.release=r);
if(window.fail)return Response.json({error:'fixture failure'},{status:500});
if(body.method==='draft.update'){Object.assign(window.fixtureDraft,body.params,{revision:window.fixtureDraft.revision+1});return Response.json(window.fixtureDraft);}
if(body.method==='draft.remove'){window.fixtureDraft=null;return Response.json({id:body.params.id});}
if(body.method==='worker.message')return Response.json({...window.valetTask,status:'queued'});
return Response.json(body.method==='draft.add'?{id:4}:{emitted:true,draft_id:body.params.draft_id||4,dispatch:{state:'queued'}});};
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
window.append=(change={})=>{ui.view={id:'task'};ui.selected=8;appendToWorker({id:8,worker_number:'W8',task_kind:'order',status:'waiting',branch:'feature',workspace:'/tmp/fixture',goal:'追加目标',...change});};
window.valetTask={id:9,worker_number:'V3',role:'manager',task_kind:'management',status:'completed',goal:'管家原始需求',management:{version:1,can_append:true,state:'idle'}};
window.valet=()=>{ui.view={id:'task'};ui.selected=9;ui.composerTask=window.valetTask;const host=document.createElement('div');host.id='valet-controls';host.append(valetLifecycleControls(window.valetTask));document.querySelector('#valet-controls')?.remove();document.querySelector('#detail').prepend(host);};
window.frozen=value=>{ui.composerParents=[{id:1,branch:'main',...(value?{freeze:{reason:'fixture freeze'}}:{})}];syncComposer();};
await initComposer();window.ready=true;
</script>`;
const html = (await Bun.file(join(assets,'index.html')).text()).replace(/<script[^>]*src="\/(?:app|appearance)\.js"[^>]*><\/script>/g,'').replace('</body>',script+'</body>');
const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
  const path=new URL(req.url).pathname;
  if(path==='/')return new Response('<html><body style="margin:0"><iframe id="viewport" src="/fixture" style="width:390px;height:844px;border:0"></iframe></body></html>',{headers:{'Content-Type':'text/html'}});
  if(path==='/fixture')return new Response(html,{headers:{'Content-Type':'text/html'}});
  if(path==='/administrator/project-protocol.js')return new Response(Bun.file(new URL('../../src/administrator/project-protocol.js',import.meta.url)));
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
  const frame=await rpc(`/session/${session}/element`,{using:'css selector',value:'#viewport'});await rpc(`/session/${session}/frame`,{id:frame});assert(await wait('window.ready'),'fixture module startup failed');await execute('window.keyboard(innerHeight)');}
try{
  let ready=false;for(let i=0;i<100;i++){try{await rpc('/status',undefined,'GET');ready=true;break;}catch{}if(driver.exitCode!==null)throw Error('geckodriver exited');await Bun.sleep(100);}assert(ready,'driver startup timeout');
  session=(await rpc('/session',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{args:['-headless']}}}})).sessionId;
  await rpc(`/session/${session}/window/rect`,{width:1600,height:1100});await rpc(`/session/${session}/url`,{url:`http://127.0.0.1:${server.port}/`});
  await resize(390,844);assert(await wait('window.ready'),'fixture load failed');
  assert(await execute(`return document.querySelector('#input-form').hidden&&document.querySelector('#composer-shell').getBoundingClientRect().height===0;`),'form is not collapsed by default');
  await click('#composer-launcher');
  assert(await execute(`return !document.querySelector('#composer-menu').hidden&&document.querySelector('#composer-menu-append').hidden&&window.calls.length===0;`),'first click did not open explicit menu or offered targetless append');
  await click('#composer-menu-order');
  assert(await execute(`return !document.querySelector('#input-form').hidden&&!document.querySelector('#composer-launcher').classList.contains('agent-call');`),'second click did not open non-authorizing editor');
  for(const theme of ['light','dark'])for(const [width,height]of [[320,700],[390,844],[760,700],[1440,900]]){
    await resize(width,height);await execute(`document.documentElement.dataset.theme='${theme}';document.documentElement.dataset.projectColor='blue';window.touch=${width<=760};window.openComposer();document.querySelector('#input').focus();`);
    assert(await wait(`document.querySelector('#input').getBoundingClientRect().bottom<=innerHeight+1`),'focus did not expose input');
    assert(await execute(`return document.querySelector('#composer-editor-tools').hidden&&document.querySelector('.text-editor-undo').getClientRects().length===0;`),`editor controls visible by default ${width} ${theme}`);
    assert(await execute(`const visible=Array.from(document.querySelectorAll('.composer-actions button')).filter(b=>b.getClientRects().length);const r=visible.map(b=>b.getBoundingClientRect());return visible.length===5&&r.every(b=>b.height>=(innerWidth<=760?44:32)&&b.left>=0&&b.right<=innerWidth)&&['composer-resume','composer-choose-draft'].every(id=>{const b=document.getElementById(id);return b.parentElement.classList.contains('composer-actions')&&b.getBoundingClientRect().top>=document.querySelector('#input').getBoundingClientRect().bottom;});`),`default draft actions not in bottom tool flow ${width} ${theme}`);
    assert(await execute(`return !document.querySelector('#composer-runner-choice,.runner-input-choice');`),`retired environment present before More ${width} ${theme}`);
    await click('#composer-expand');
    assert(await execute(`return !document.querySelector('#composer-runner-choice,.runner-input-choice');`),`retired environment present after More ${width} ${theme}`);
    assert(await execute(`return !document.querySelector('#composer-editor-tools').hidden&&document.querySelector('.text-editor-undo').getClientRects().length>0&&document.querySelector('#input-history').getClientRects().length>0&&document.querySelector('#input-drafts').getClientRects().length>0&&!document.querySelector('#composer-chat-open,#composer-chat-controls,#quick-chat-open');`),`editor controls not expanded or retired chat entry present ${width} ${theme}`);
    assert(await execute(`return document.documentElement.scrollWidth<=innerWidth&&Array.from(document.querySelectorAll('.composer-actions button,.text-editor-controls button')).filter(b=>b.getClientRects().length).every(b=>{const r=b.getBoundingClientRect();return r.right<=innerWidth+1&&r.height>=(innerWidth<=760?44:32)});`),`clipped/small controls ${width} ${theme}`);
    await click('#composer-expand');
    const dock=await execute(`const s=document.querySelector('#composer-shell').getBoundingClientRect(),c=document.querySelector('.content-shell').getBoundingClientRect();return {top:s.top,bottom:c.bottom,reading:c.height};`);
    assert(dock.bottom<=dock.top+1&&dock.reading>80,`dock overlays reading pane ${width}: ${JSON.stringify(dock)}`);
    await click('#composer-launcher'); await click('#composer-launcher');
    assert(await execute(`return Array.from(document.querySelectorAll('#composer-menu button')).filter(n=>n.getClientRects().length).every(n=>{const r=n.getBoundingClientRect();return r.height>=44&&r.left>=0&&r.right<=innerWidth});`),`menu clips on ${width}`);
    await click('#composer-menu-order');
    assert(await execute(`return !document.querySelector('#composer-large,#composer-switch')&&document.querySelector('#input').getBoundingClientRect().height>=innerHeight*.25&&document.querySelector('.content-shell').getBoundingClientRect().height>0;`),'editor is not large by default or removed reading pane');
    await execute(`const d=document.querySelector('#detail');d.scrollTop=150;window.readingTop=d.scrollTop;const i=document.querySelector('#input');i.value='保留编辑';i.dispatchEvent(new Event('input'));i.scrollTop=12;`);
    await click('#composer-launcher');
    assert(await execute(`return document.querySelector('#input-form').hidden&&document.querySelector('#composer-shell').getBoundingClientRect().height===0&&document.querySelector('#detail').scrollTop===window.readingTop&&document.activeElement===document.querySelector('#composer-launcher');`),`collapse lost reading position ${width}`);
    await click('#composer-launcher'); await click('#composer-menu-order'); assert(await execute(`return document.querySelector('#input').value==='保留编辑'&&!document.querySelector('#input-form').hidden&&!document.querySelector('.text-editor-undo').disabled;`),`category auto-resume failed ${width}`);
    await execute(`const i=document.querySelector('#input');i.value='';i.dispatchEvent(new Event('input'));`);
    console.log(`PASS focus, dock reservation, menu, default large editor, collapse/auto-resume, themes ${theme} ${width}x${height}`);
    if(width<=760){
      await execute('window.frozen(true);');
      assert(await execute(`const r=Array.from(document.querySelectorAll('.composer-actions button')).filter(b=>b.getClientRects().length).map(b=>b.getBoundingClientRect());return r.length===5&&r.every(b=>b.height>=44&&b.left>=0&&b.right<=innerWidth);`),`frozen buttons wrap/overflow ${width}`);
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
  await resize(390,844);await execute(`window.touch=true;window.openComposer();document.querySelector('#input').focus();`);
  await keys(['a','b','\uE007','c']);
  assert(await execute(`return document.querySelector('#input').value==='ab\\nc'&&window.calls.length===0`),'touch Enter did not insert native newline');
  await click('#composer-expand');
  await click('.text-editor-undo');assert(await execute(`return document.querySelector('#input').value==='ab\\n'&&window.calls.length===0`),'undo submitted or restored wrong text');
  await click('.text-editor-redo');assert(await execute(`return document.querySelector('#input').value==='ab\\nc'`),'redo failed');
  await execute(`window.keyboard(420);document.querySelector('#input').focus();`);
  const keyboardFits=await wait(`document.querySelector('#composer-mode-target').getBoundingClientRect().top>=0&&document.querySelector('#composer-mode-target').getBoundingClientRect().bottom<=document.querySelector('#input').getBoundingClientRect().top&&document.querySelector('#input').getBoundingClientRect().top>=0&&document.querySelector('#input').getBoundingClientRect().bottom<=420&&document.querySelector('#draft-commit').getBoundingClientRect().bottom<=420`);
  if(!keyboardFits)console.error('Keyboard layout:',await execute(`return Object.fromEntries(['.app','#composer-shell','#input','#draft-commit','#composer-mode-target'].map(s=>{const n=document.querySelector(s);return [s,{rect:n.getBoundingClientRect().toJSON(),scroll:n.scrollTop,height:n.scrollHeight,style:n.style.cssText}]}));`));
  assert(keyboardFits,'overlay keyboard hides input/actions');
  console.log('PASS touch native newline, undo/redo, simulated overlay keyboard');
  assert(await execute(`return !document.querySelector('#input-start,.emission-conditions')`),'composer contains conditional controls');
  await click('#draft-commit');assert(await wait(`document.querySelector('#input').value===''`),'emit did not release text');
  assert(await execute(`return window.calls.length===1&&window.calls[0].method==='input.emit'&&!window.calls[0].params.conditions&&document.querySelector('.text-editor-undo').disabled`),'emit mode or history cleanup failed');
  await execute(`window.keyboard(innerHeight);window.frozen(true);document.querySelector('#input').focus();`);await keys(['x']);await click('#draft-commit');
  assert(await wait(`window.calls.length===2`),'frozen input not submitted');assert(await execute(`return window.calls[1].method==='input.emit'&&!('start' in window.calls[1].params)&&!('defer' in window.calls[1].params)`),'frozen input bypasses reliable emission');
  await click('#composer-expand');
  await execute(`window.frozen(false);window.append();`);
  await click('#composer-expand');
  assert(await execute(`return !document.querySelector('#composer-editor-tools').hidden&&document.querySelector('#composer-details').hidden&&!document.querySelector('#composer-runner-choice,.runner-input-choice');`),'append more does not expose editor or exposes parent');
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
  await execute(`window.selectComposer('order');document.querySelector('#input').focus();window.arrowCalls=window.calls.length;`);
  assert(await execute(`return document.querySelector('#composer-resume').textContent==='继续最近草稿'&&document.querySelector('#composer-choose-draft').textContent==='选择其他草稿'&&document.querySelector('#input-buffer').textContent==='暂存为草稿';`),'draft button terminology is inconsistent');
  await keys(['\uE013']);assert(await wait(`document.querySelector('#input').value==='可续写暂存'`),'native ArrowUp did not recall latest draft');
  assert(await execute(`return document.querySelector('#input-buffer').textContent==='保存草稿'&&document.querySelector('#draft-commit').textContent==='按条件提交'&&document.querySelector('#composer-draft-status').textContent.includes('草稿 #7')&&!document.querySelector('#composer-draft-status').textContent.includes('草稿 #40');`),'arrow recall lost draft identity/conditions');
  await keys(['\uE015']);assert(await wait(`document.querySelector('#input').value===''`),'native ArrowDown did not restore empty editor');
  await keys(['\uE013']);assert(await wait(`document.querySelector('#input').value==='可续写暂存'`),'draft traversal could not restart');
  await keys(['改','\uE015']);assert(await execute(`return document.querySelector('#input').value.includes('改')&&window.calls.length===window.arrowCalls;`),'arrow after editing discarded text or invoked an action');
  // Preserve this modified draft locally, then consume it through the existing save/emit regression below.
  await resize(390,844);await execute(`window.selectComposer('order');window.touch=true;`);
  assert(await execute(`return document.querySelector('#input').value.includes('可续写暂存');`),'arrow-recalled draft was not retained across resize');
  assert(await execute(`return document.querySelector('#draft-commit').textContent==='按条件提交'&&document.querySelector('#composer-condition-summary').textContent.includes('独占');`),'draft lost conditions');
  await execute(`document.querySelector('#input').focus();`);await keys(['续','写']);
  await click('#composer-launcher');
  assert(await execute(`return document.querySelector('#input-form').hidden&&document.activeElement===document.querySelector('#composer-launcher')&&document.querySelector('#composer-launcher').dataset.pending==='true';`),'collapse did not blur/preserve pending edit');
  await click('#composer-launcher'); await click('#composer-menu-order'); assert(await execute(`return !document.querySelector('#input-form').hidden&&document.querySelector('#input').value.includes('续写');`),'category did not restore automatic draft edit');
  await click('#input-buffer');assert(await wait(`window.calls.at(-1).method==='draft.update'&&document.querySelector('#input').value===''`),'resumed draft duplicated instead of update/clear');
  await click('#composer-launcher'); await click('#composer-launcher'); await click('#composer-menu-order');
  assert(await execute(`return document.querySelector('#input').value==='';`),'explicit save unexpectedly auto-loaded draft');
  await click('#composer-resume');assert(await wait(`document.querySelector('#input').value.includes('续写')`),'explicit continuation failed');
  await click('#draft-commit');assert(await wait(`window.calls.at(-1).method==='input.emit'&&window.calls.at(-1).params.draft_id===40&&window.calls.at(-1).params.expected_revision===4`),'resumed draft did not emit exact saved revision');
  console.log('PASS inline continuation, saved revision/condition identity, category auto-resume and explicit stash exclusion');
  await click('#composer-resume');assert(await wait(`document.querySelector('#input').value.includes('续写')`),'delete fixture did not restore');
  for(const width of [320,390,760,1440]){
    await resize(width,900);await execute(`document.querySelector('#input').blur();`);
    assert(await execute(`const b=document.querySelector('#composer-remove-draft'),r=b.getBoundingClientRect();return !b.hidden&&r.height>=(innerWidth<=760?44:32)&&r.left>=0&&r.right<=innerWidth&&!b.classList.contains('agent-call');`),`delete button clips or calls Agent at ${width}`);
  }
  await execute(`window.deleteCalls=window.calls.length;`);await click('#composer-remove-draft');
  assert(await execute(`return document.querySelector('.modal-title').textContent==='删除草稿 #7？'&&window.calls.length===window.deleteCalls;`),'delete confirmation used internal id or mutated before approval');
  await click('.modal-cancel');assert(await execute(`return document.querySelector('#input').value.includes('续写')&&window.calls.length===window.deleteCalls;`),'cancel deleted text');
  await click('#composer-remove-draft');await click('.modal-confirm');
  assert(await wait(`document.querySelector('#input').value===''&&document.querySelector('#composer-remove-draft').hidden`),'delete did not consume current edit');
  assert(await execute(`return window.calls.at(-1).method==='draft.remove'&&window.calls.at(-1).params.id===40&&window.calls.at(-1).params.expected_revision===4&&document.querySelector('#composer-condition-summary').hidden;`),'delete lost exact server identity/revision or retained deleted conditions');
  await click('#composer-launcher');await click('#composer-launcher');await click('#composer-menu-order');
  assert(await execute(`return document.querySelector('#input').value==='';`),'deleted browser edit was resurrected');
  console.log('PASS numbered draft deletion, cancellation, exact version/identity, responsive button and browser recovery cleanup');
  for(const theme of ['light','dark'])for(const [width,height]of [[320,700],[390,844],[760,700],[1440,900]]){
    await resize(width,height);await execute(`document.documentElement.dataset.theme='${theme}';window.append({archived:true});window.compact();`);
    assert(await execute(`const n=document.querySelector('#composer-target-status'),r=n.getBoundingClientRect(),s=document.querySelector('#composer-shell').getBoundingClientRect();return document.querySelector('#input-form').dataset.expanded==='false'&&document.querySelector('#input').disabled&&!n.hidden&&getComputedStyle(n).display!=='none'&&n.textContent.includes('分支已归档')&&r.height>0&&r.top>=s.top&&r.bottom<=s.bottom&&r.right<=innerWidth;`),`compact blocked reason hidden ${theme}/${width}`);
    await execute(`window.append({freeze:{reason:'固定交付中'}});const i=document.querySelector('#input');i.value='合法冻结追加';i.dispatchEvent(new Event('input'));i.focus();${width<=760?'window.keyboard(420);':''}`);
    assert(await wait(`document.querySelector('#composer-target-status').getBoundingClientRect().bottom<=${width<=760?420:height}`),`keyboard obscures waiting reason ${theme}/${width}`);
    assert(await execute(`const n=document.querySelector('#composer-target-status'),r=n.getBoundingClientRect(),s=document.querySelector('#composer-shell').getBoundingClientRect();return !document.querySelector('#input').disabled&&!document.querySelector('#draft-commit').disabled&&!n.hidden&&getComputedStyle(n).display!=='none'&&n.textContent.includes('冻结中：固定交付中')&&r.height>0&&r.top>=s.top&&r.bottom<=s.bottom&&!n.textContent.includes('Ctrl');`),`legal frozen append lost waiting fact or was disabled ${theme}/${width}`);
    // A subsequent blocker must still be visible with the keyboard geometry active, not hidden as advanced help.
    await execute(`window.append({archived:true});`);
    assert(await execute(`const n=document.querySelector('#composer-target-status'),r=n.getBoundingClientRect();return document.querySelector('#input').disabled&&getComputedStyle(n).display!=='none'&&r.height>0&&r.top>=0&&r.bottom<=${width<=760?420:height}&&n.textContent.includes('分支已归档');`),`keyboard hides new blocker ${theme}/${width}`);
    await execute(`window.keyboard(innerHeight);window.append();document.querySelector('#input').focus();`);await keys(['\uE00C']);
    assert(await execute(`return document.querySelector('#input-form').hidden&&document.activeElement===document.querySelector('#composer-launcher')&&document.querySelector('#input').value==='合法冻结追加';`),`Escape did not restore launcher focus ${theme}/${width}`);
    console.log(`PASS compact admission facts, keyboard blocker visibility, legal freeze and Escape focus ${theme} ${width}`);
  }
  // A real page reload keeps only browser auto-saves, independently for all three destinations.
  await execute(`window.selectComposer('order');document.querySelector('#input').value='重开新建';window.selectComposer('management');document.querySelector('#input').value='重开管理';window.append();document.querySelector('#input').value='重开追加';document.querySelector('#composer-launcher').click();`);
  await rpc(`/session/${session}/frame`,{id:null});
  await rpc(`/session/${session}/url`,{url:`http://127.0.0.1:${server.port}/`});
  await resize(390,844);assert(await wait('window.ready'),'reload fixture failed');
  await click('#composer-launcher');
  assert(await execute(`return document.querySelector('#composer-launcher').getAttribute('aria-label').includes('3 条未完成输入')&&['order','append','management'].every(m=>document.querySelector('#composer-pending-'+m).querySelectorAll('button').length===1)&&!document.querySelector('#composer-pending-append-summary').hidden;`),'reload did not discover all unfinished destinations or expose targetless append continuations');
  await click('#composer-pending-management button');
  assert(await execute(`return document.querySelector('#input').value==='重开管理'&&window.calls.length===0;`),'management browser edit did not survive reload');
  await execute(`window.selectComposer('order');`);assert(await execute(`return document.querySelector('#input').value==='重开新建';`),'new-work browser edit did not survive reload');
  await execute(`window.append();`);assert(await execute(`return document.querySelector('#input').value==='重开追加'&&window.calls.length===0;`),'append browser edit did not survive reload');
  console.log('PASS real page reload discovers three independent browser edits without mutation or Agent calls');
  await execute(`window.page();document.querySelector('#composer-launcher').click();window.menuText='很长的未完成正文'.repeat(100);`);
  for(const theme of ['light','dark'])for(const [width,height]of [[320,700],[390,844],[760,700],[1440,900]]){
    await resize(width,height);await execute(`document.documentElement.dataset.theme='${theme}';window.selectComposer('order');document.querySelector('#input').value=window.menuText;document.querySelector('#input').dispatchEvent(new Event('input'));document.querySelector('#composer-launcher').click();document.querySelector('#composer-launcher').click();`);
    assert(await execute(`const menu=document.querySelector('#composer-menu'),r=menu.getBoundingClientRect(),rows=Array.from(menu.querySelectorAll('.composer-pending-entry'));return !menu.hidden&&document.documentElement.scrollWidth<=innerWidth&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&rows.length===3&&rows.every(n=>{const b=n.getBoundingClientRect();return b.height>=44&&b.width<=r.width})&&document.querySelector('#composer-menu-order').dataset.pending==='true'&&getComputedStyle(document.querySelector('.composer-pending-count'),'::before').backgroundColor!=='rgba(0, 0, 0, 0)';`),`unfinished menu geometry/counts/dots failed ${theme}/${width}`);
    assert(await execute(`const n=document.querySelector('#composer-pending-order .composer-pending-preview');return n.scrollWidth>n.clientWidth&&getComputedStyle(n).textOverflow==='ellipsis';`),`long preview is not truncated ${theme}/${width}`);
    await execute(`const menu=document.querySelector('#composer-menu');menu.scrollTop=menu.scrollHeight;window.lastRow=menu.querySelector('#composer-pending-management button');window.lastRow.focus();`);
    assert(await execute(`const r=window.lastRow.getBoundingClientRect(),m=document.querySelector('#composer-menu').getBoundingClientRect();return document.activeElement===window.lastRow&&r.top>=m.top&&r.bottom<=m.bottom&&window.lastRow.getAttribute('aria-label').includes('已保留在本浏览器');`),`continuation keyboard focus or status failed ${theme}/${width}`);
    if(width===390||width===320)await Bun.write(`/tmp/lush-w338-validation/menu-${theme}-${width}.png`,Buffer.from(await rpc(`/session/${session}/screenshot`,undefined,'GET'),'base64'));
    await keys(['\uE00C']);
    assert(await execute(`return document.querySelector('#composer-menu').hidden&&document.activeElement===document.querySelector('#composer-launcher')`),`menu Escape lost focus ${theme}/${width}`);
    console.log(`PASS unfinished category indicators, direct continuations, long previews, keyboard focus and menu bounds ${theme} ${width}`);
  }
  await execute(`document.querySelector('#composer-launcher').click();`);await click('#composer-pending-append button');
  assert(await wait(`!document.querySelector('#input').disabled&&document.querySelector('#input').value==='重开追加'`),'cached append continuation did not re-read and restore original target');
  assert(await execute(`return window.calls.length===0&&document.querySelector('#composer-mode-target').textContent.includes('W8')`),'continuation mutated data or changed target');
  // Valet detail uses the same non-modal editor, with separately recoverable management targets.
  for(const theme of ['light','dark'])for(const width of [320,390,760,1440]){
    await resize(width,900);await execute(`document.documentElement.dataset.theme='${theme}';window.valet();document.querySelector('#valet-controls button').click();window.compact();`);
    assert(await execute(`const form=document.querySelector('#input-form');return form.dataset.mode==='management'&&!form.hidden&&document.querySelector('#modal').hidden&&document.querySelector('#composer-mode-target').textContent.includes('V3')&&document.querySelector('#input-buffer').hidden&&document.querySelector('#composer-choose-draft').hidden&&!document.querySelector('#valet-controls button').classList.contains('agent-call')&&document.querySelector('.project-elevation-label input').checked===false;`),`Valet did not use common ordinary management editor ${theme}/${width}`);
    assert(await execute(`return document.querySelector('#composer-management-settings').hidden&&document.querySelector('.project-elevation-label').getClientRects().length===0;`),`administrator option visible outside advanced settings ${theme}/${width}`);
    await click('#composer-expand');
    assert(await execute(`const label=document.querySelector('#composer-management-settings .project-elevation-label');return !document.querySelector('#composer-management-settings').hidden&&label.textContent==='以管理员身份运行'&&label.getClientRects().length>0&&document.documentElement.scrollWidth<=innerWidth&&Array.from(document.querySelectorAll('.composer-actions button,.project-elevation-label')).filter(n=>n.getClientRects().length).every(n=>{const r=n.getBoundingClientRect();return r.height>=(innerWidth<=760?44:32)&&r.left>=0&&r.right<=innerWidth+1});`),`Valet advanced controls hidden, overflowing or small ${theme}/${width}`);
    await click('#composer-expand');
    await execute(`const i=document.querySelector('#input');i.value='保留管家追加';i.dispatchEvent(new Event('input'));window.selectComposer('management');i.value='独立新管家';i.dispatchEvent(new Event('input'));window.valet();document.querySelector('#valet-controls button').click();`);
    assert(await execute(`return document.querySelector('#input').value==='保留管家追加'&&document.querySelector('#composer-mode-target').textContent.includes('V3');`),'Valet input was redirected or overwritten by new management input');
  }
  await execute(`document.querySelector('#composer-launcher').click();`);
  await rpc(`/session/${session}/frame`,{id:null});await rpc(`/session/${session}/url`,{url:`http://127.0.0.1:${server.port}/`});await resize(390,844);
  await click('#composer-launcher');
  assert(await execute(`return document.querySelector('#composer-pending-management').querySelectorAll('button').length===2;`),'new management and Valet append were merged in browser recovery');
  await click('[data-edit-key="management:9"]');
  assert(await wait(`!document.querySelector('#input').disabled&&document.querySelector('#input').value==='保留管家追加'&&document.querySelector('#composer-mode-target').textContent.includes('V3')`),'cached Valet append did not revalidate its original target');
  await execute(`window.touch=false;document.querySelector('#input').focus();`);await keys(['\uE007']);
  assert(await execute(`return document.querySelector('#input').value.includes('\\n')&&window.calls.length===0`),'Valet Enter authorized instead of newline');
  await click('#draft-commit');
  assert(await wait(`window.calls.length===1&&document.querySelector('#input-form').dataset.mode==='create'`),'Valet submit did not return to create');
  assert(await execute(`return window.calls[0].method==='worker.message'&&window.calls[0].params.id===9&&!document.querySelector('#input').value.includes('保留管家追加');`),'Valet submit used development emission or wrong target');
  console.log('PASS shared Valet append, independent management drafts, themes/widths, newline and explicit same-target submit');
  passed=true;
}finally{
  if(session)await rpc(`/session/${session}`,undefined,'DELETE').catch(()=>{});driver.kill();await driver.exited;server.stop(true);
  if(passed)await rm(temp,{recursive:true,force:true});else console.error('Browser failure log:',log);
}
