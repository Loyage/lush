// bun test/web/check-mobile-composer-browser.js — real Firefox layout/input, temporary fixture only.
// Soft keyboard geometry is simulated via VisualViewport; this is not an iOS/Android device test.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const script = `<script type="module">
import {initComposer,appendToWorker,syncComposer} from '/composer.js';
import {ui} from '/state.js';
import {registerNavigation} from '/navigate.js';
const nativeMatch=window.matchMedia.bind(window);window.touch=false;
window.matchMedia=q=>q==='(pointer: coarse)'?{matches:window.touch}:nativeMatch(q);
const viewport=new EventTarget();Object.assign(viewport,{height:innerHeight,offsetTop:0,scale:1});
Object.defineProperty(window,'visualViewport',{value:viewport,configurable:true});
window.keyboard=h=>{viewport.height=h;viewport.dispatchEvent(new Event('resize'));};
window.calls=[];window.fail=false;window.defer=false;
window.fetch=async(url,options)=>{if(String(url).endsWith('/api/input-parents'))return Response.json({items:[{id:1,branch:'main'}]});
const body=JSON.parse(options.body);window.calls.push(body);if(window.defer)await new Promise(r=>window.release=r);
if(window.fail)return Response.json({error:'fixture failure'},{status:500});return Response.json({id:4,task:{id:8,worker_number:'W8'}});};
registerNavigation({refresh:async()=>{},detail:async()=>{}});ui.view={id:'overview'};
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
    await resize(width,height);await execute(`document.documentElement.dataset.theme='${theme}';window.touch=${width<=760};document.querySelector('#input').focus();`);
    assert(await wait(`document.querySelector('#input').getBoundingClientRect().bottom<=innerHeight+1`),'focus did not expose input');
    assert(await execute(`return document.documentElement.scrollWidth<=innerWidth&&Array.from(document.querySelectorAll('.composer-actions button,.text-editor-controls button')).filter(b=>!b.hidden).every(b=>{const r=b.getBoundingClientRect();return r.right<=innerWidth+1&&(innerWidth>760||r.height>=44)});`),`clipped/small controls ${width} ${theme}`);
    console.log(`PASS focus, wrapped controls, themes ${theme} ${width}x${height}`);
  }
  await resize(390,844);await execute(`window.touch=true;document.querySelector('#input').focus();`);
  await keys(['a','b','\uE007','c']);
  assert(await execute(`return document.querySelector('#input').value==='ab\\nc'&&window.calls.length===0`),'touch Enter did not insert native newline');
  await click('.text-editor-undo');assert(await execute(`return document.querySelector('#input').value==='ab\\n'&&window.calls.length===0`),'undo submitted or restored wrong text');
  await click('.text-editor-redo');assert(await execute(`return document.querySelector('#input').value==='ab\\nc'`),'redo failed');
  await execute(`window.keyboard(420);document.querySelector('#input').focus();`);
  assert(await wait(`document.querySelector('#input').getBoundingClientRect().bottom<=420&&document.querySelector('#input-start').getBoundingClientRect().bottom<=420`),'overlay keyboard hides input/actions');
  console.log('PASS touch native newline, undo/redo, simulated overlay keyboard');
  await click('#input-start');assert(await wait(`document.querySelector('#input').value===''`),'start did not release text');
  assert(await execute(`return window.calls.length===1&&window.calls[0].method==='order.submit'&&window.calls[0].params.start===true&&document.querySelector('.text-editor-undo').disabled`),'start mode or history cleanup failed');
  await execute(`window.keyboard(innerHeight);window.frozen(true);document.querySelector('#input').focus();`);await keys(['x']);await click('#draft-commit');
  assert(await wait(`window.calls.length===2`),'deferred create not submitted');assert(await execute(`return window.calls[1].params.defer===true&&window.calls[1].params.start===false`),'frozen only-create accidentally starts');
  await execute(`window.frozen(false);window.append();`);await keys(['z','\uE007']);
  assert(await execute(`return window.calls.length===2&&document.querySelector('#input-start').hidden`),'append enter sends or extra start remains');await click('#draft-commit');
  assert(await wait(`window.calls.length===3`),'append not submitted');assert(await execute(`return window.calls[2].method==='worker.message'`),'append created worker');
  console.log('PASS explicit start, only-create reservation, append mode and consumed undo history');
  passed=true;
}finally{
  if(session)await rpc(`/session/${session}`,undefined,'DELETE').catch(()=>{});driver.kill();await driver.exited;server.stop(true);
  if(passed)await rm(temp,{recursive:true,force:true});else console.error('Browser failure log:',log);
}
