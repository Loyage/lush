// Standalone real Firefox CLI page layout/interaction check; API responses are controlled fixtures.
// Real authenticated HTTP/RPC/CLI execution is covered by dom-worker-cli-api.test.js.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { cliCatalog } from '../../src/rpc/cli-catalog.js';

const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['styles.css','styles-core.css','styles-code.css','styles-performance.css','styles-worker-cli.css'].map(name => `<link rel="stylesheet" href="/assets/${name}">`).join('')}
</head><body style="margin:0;padding:12px;box-sizing:border-box"><div id="project-app"><div id="detail"></div></div><div id="modal" class="modal-root" hidden></div><div id="error"></div>
<script type="module">
import { openWorkerCliPage } from '/assets/worker-cli-page.js';
import { openExecutionPage } from '/assets/execution-page.js';
import { ui } from '/assets/state.js';
import { initHelp } from '/assets/help.js';
initHelp();window.ui=ui;
window.errors=[]; addEventListener('error',e=>errors.push(e.message)); addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
window.calls=[];
const task={id:77,worker_number:'W324',task_kind:'order',workspace:'/project/'+('very-long-worker-directory/').repeat(12)};
window.fetch=async(url,options)=>{
 if(String(url).includes('/cli/catalog'))return Response.json(${JSON.stringify(cliCatalog())});
 if(String(url).endsWith('/api/worker/77'))return Response.json(task);
 if(String(url).includes('/code-state'))return Response.json({availability:'unavailable',reason:'fixture',changes:[]});
 if(!options?.body)return Response.json({steps:[],files:[],next:0,oldest:0,has_more:false,has_older:false});
 const {method,params:{command}}=JSON.parse(options.body);
 if(method==='worker.cli_history')return Response.json({entries:[],before:null,has_more:false});
 if(method==='worker.cli_history_clear')return Response.json({cleared:true});
 if(method==='worker.cli_preview'){calls.push('preview');return Response.json({id:77,command,workspace:task.workspace,argv:['status'],executable:'lush',path:'status',kind:command.includes('order')?'agent':'read',requires_confirmation:command.includes('order'),revision:'revision'});}
 calls.push('execute');return Response.json({command,workspace:task.workspace,status:'succeeded',exit_code:0,stdout:'a'.repeat(4000)+'\\n<literal-output>',stderr:'warning',duration_ms:2});
};
// Set the route before opening, just as the application hashchange dispatcher does.
history.replaceState(null,'','#worker-77-execution-cli');
window.panel=await openExecutionPage({taskId:77,mode:'cli'});window.task=task;window.ready=true;
window.switchTab=async index=>{ui.transcriptView.panel.querySelectorAll('[role="tab"]')[index].click();};
</script></body></html>`;
const server = Bun.serve({ hostname:'127.0.0.1', port:0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/') return new Response('<!doctype html><html><body style="margin:0"><iframe id="viewport" src="/fixture" style="width:1440px;height:900px;border:0"></iframe></body></html>', {headers:{'Content-Type':'text/html'}});
  if (path === '/fixture') return new Response(fixture, {headers:{'Content-Type':'text/html'}});
  if (/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets,path.split('/').at(-1))));
  return new Response(null,{status:404});
} });
const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')});
const port=reservation.port;reservation.stop(true);
const temp=await mkdtemp(join(tmpdir(),'lush-worker-cli-browser-'));
const driver=Bun.spawn(['geckodriver','--host','127.0.0.1','--port',String(port)],{env:{...process.env,MOZ_HEADLESS:'1'},stdout:Bun.file(join(temp,'driver.log')),stderr:Bun.file(join(temp,'driver.log'))});
let session, passed=false;
async function rpc(path,body,method='POST') {
  const value=await new Promise((resolve,reject)=>{
    const req=request(`http://127.0.0.1:${port}${path}`,{method,headers:{'Content-Type':'application/json'}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,text}));res.on('error',reject);
    });req.on('error',reject);req.setTimeout(20000,()=>req.destroy(Error('WebDriver timeout')));req.end(body===undefined?undefined:JSON.stringify(body));
  });const data=JSON.parse(value.text);if(value.status>=400)throw Error(JSON.stringify(data));return data.value;
}
const execute=script=>rpc(`/session/${session}/execute/sync`,{script,args:[]});
const assert=(value,message)=>{if(!value)throw Error(message);};
async function frame(){const node=await rpc(`/session/${session}/element`,{using:'css selector',value:'#viewport'});await rpc(`/session/${session}/frame`,{id:node});}
async function untilScript(script) { return rpc(`/session/${session}/execute/async`, {script:`const done=arguments[0];let n=0;const check=()=>(${script})?done(true):++n>200?done(false):setTimeout(check,20);check();`,args:[]}); }
try {
  let ready=false;
  for(let i=0;i<100;i++){try{await rpc('/status',undefined,'GET');ready=true;break;}catch{}if(driver.exitCode!==null)throw Error('driver exited');await Bun.sleep(100);}
  assert(ready,'driver startup timed out');
  session=(await rpc('/session',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{args:['-headless']}}}})).sessionId;
  await rpc(`/session/${session}/window/rect`,{width:1600,height:1000});
  await rpc(`/session/${session}/url`,{url:`http://127.0.0.1:${server.port}/`});await frame();
  assert(await untilScript('window.ready'),'fixture did not load');
  assert(await untilScript('panel.querySelector(".worker-cli-discovery").textContent.includes("输入命令路径")'),'catalog not loaded');
  await execute('const i=panel.querySelector("textarea");i.value="lush worker sh";i.dispatchEvent(new Event("input"));i.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown"}));i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter"}));');
  assert(await execute('return calls.length===0&&panel.querySelector("textarea").value==="lush worker show"&&panel.querySelector(".worker-cli-guide").textContent.includes("风险");'),'selected suggestion must fill and explain, not execute');
  await execute('const i=panel.querySelector("textarea");i.value="lush worker message W1 原始正文";i.dispatchEvent(new Event("input"));');
  assert(await execute('return !panel.querySelector(".worker-cli-suggestions").children.length'),'body must not be guessed');
  await execute('const s=panel.querySelector(".worker-cli-discovery input");s.value="合并";s.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true}));');
  assert(await execute('return !panel.querySelector(".worker-cli-candidates").children.length'),'IME search submitted');
  await execute('panel.querySelector(".worker-cli-discovery button").click();');
  assert(await execute('return panel.querySelector(".worker-cli-candidates").children.length>0&&calls.length===0'),'Chinese static search missing');
  assert(await execute('return panel.tagName==="SECTION" && calls.length===0 && panel.querySelector("textarea").checkVisibility() && !panel.querySelector(".worker-cli-advanced").open;'),'CLI page must show input without requests and keep advanced help collapsed');
  await execute('panel.querySelector(".worker-cli-advanced").open=true;panel.querySelector(".worker-cli-examples button").click();');
  assert(await execute('return calls.length===0 && panel.querySelector("textarea").value==="lush help";'),'example executed instead of filling');
  await execute('panel.querySelector(".worker-cli-run").scrollIntoView({block:"center"});');
  const runElement=await rpc(`/session/${session}/element`,{using:'css selector',value:'.worker-cli-run'});
  await rpc(`/session/${session}/actions`,{actions:[{type:'pointer',id:'mouse',parameters:{pointerType:'mouse'},actions:[{type:'pointerMove',duration:0,origin:runElement,x:0,y:0},{type:'pointerDown',button:0},{type:'pause',duration:800},{type:'pointerUp',button:0}]}]});
  assert(await execute('return calls.length===0&&document.querySelector("#help-tip")?.closest("dialog")?.open;'),'long press must show top-layer help without execution');
  await execute('panel.querySelector("textarea").focus();');
  await rpc(`/session/${session}/actions`,{actions:[{type:'key',id:'keyboard',actions:[{type:'keyDown',value:'\uE007'},{type:'keyUp',value:'\uE007'}]}]});
  assert(await untilScript('panel.querySelector(".worker-cli-status").textContent==="执行成功。"'),'fixture query did not complete');
  assert(await execute('return panel.querySelector("textarea").value==="";'),'submitted draft not cleared');
  await rpc(`/session/${session}/actions`,{actions:[{type:'key',id:'keyboard',actions:[{type:'keyDown',value:'\uE008'},{type:'keyDown',value:'\uE007'},{type:'keyUp',value:'\uE007'},{type:'keyUp',value:'\uE008'}]}]});
  assert(await execute('return panel.querySelector("textarea").value==="\\n"&&calls.length===2;'),'Shift+Enter must insert newline without execution');
  await execute('const input=panel.querySelector("textarea");input.value="lush status";input.dispatchEvent(new Event("input",{bubbles:true}));for(const options of [{isComposing:true},{keyCode:229},{repeat:true}])input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,...options}));');
  assert(await execute('return calls.length===2;'),'IME/repeated shortcut dispatched a command');
  for(const theme of ['light','dark'])for(const width of [1440,900,600,390,320]){
    await rpc(`/session/${session}/frame`,{id:null});await execute(`document.querySelector('#viewport').style.width='${width}px';`);await frame();
    await execute(`document.documentElement.dataset.theme='${theme}';`);
    const result=await execute(`
      const errors=[],input=panel.querySelector('textarea'),run=panel.querySelector('.worker-cli-run'),output=panel.querySelector('.worker-cli-output');
      const a=input.getBoundingClientRect(),b=run.getBoundingClientRect();
      if(innerWidth<=600 && b.top<a.bottom)errors.push('narrow controls not stacked');
      const result=panel.querySelector('.worker-cli-result'),advanced=panel.querySelector('.worker-cli-advanced');
      if(!(panel.querySelector('.worker-cli-controls').compareDocumentPosition(panel.querySelector('.worker-cli-history'))&Node.DOCUMENT_POSITION_FOLLOWING))errors.push('input and guide must precede history');
      if(panel.querySelector('.worker-cli-history-disclosure').open)errors.push('history must start collapsed');
      if(!panel.querySelector('.worker-cli-current').contains(result))errors.push('current result must remain next to editor');
      const parts=[...result.children];
      if(parts[0].tagName!=='SUMMARY'||!parts[1].classList.contains('worker-cli-result-command')||!parts.at(-1).classList.contains('worker-cli-result-meta'))errors.push('command/output/status order');
      const tabs=[...document.querySelectorAll('.execution-tabs button')];
      if(tabs.length!==4||tabs.at(-1).textContent!=='CLI 交互')errors.push('four reader tabs missing');
      if(!document.querySelector('.transcript-dialog').open||document.querySelector('.transcript-back'))errors.push('not standalone reader');
      for(const tab of tabs){const r=tab.getBoundingClientRect();if(r.right>innerWidth+1||r.left<0)errors.push('clipped tab');}
      if(innerWidth===320&&tabs.at(-1).getBoundingClientRect().top<=tabs[0].getBoundingClientRect().top)errors.push('narrow tabs must wrap');
      for(const control of [input,run,...panel.querySelectorAll('.worker-cli-examples button')]){const r=control.getBoundingClientRect();if(r.right>innerWidth+1||r.left<0)errors.push('clipped control');}
      const precheck=panel.querySelector('.worker-cli-actions>button').getBoundingClientRect(),summary=panel.querySelector('.worker-cli-advanced>summary').getBoundingClientRect();
      const ordinary=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-height'));
      const primary=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-primary-height'))||ordinary;
      if(b.height!==primary||precheck.height!==ordinary||summary.height!==ordinary||!run.classList.contains('control-primary'))errors.push('ordinary/primary control density');
      if(document.documentElement.scrollWidth>innerWidth)errors.push('page overflow');
      if(output.scrollWidth<=output.clientWidth||getComputedStyle(output).overflowX!=='auto')errors.push('long output not independently scrollable');
      if(!output.textContent.endsWith('<literal-output>')||output.querySelector('literal-output'))errors.push('output not literal');
      if(!panel.querySelector('.worker-cli-advanced').open)errors.push('disclosure lost');
      return {errors,browserErrors:window.errors,calls,geometry:{ordinary,primary,precheck:precheck.height,summary:summary.height,execute:b.height}};`);
    assert(!result.errors.length&&!result.browserErrors.length,`${theme} ${width}: ${JSON.stringify(result)}`);
    console.log(`PASS ${theme} ${width}px: actual ordinary/primary density ${JSON.stringify(result.geometry)}, wrapped cwd, plain scrollable output, no page overflow`);
  }
  await execute('const input=panel.querySelector("textarea");input.value="lush status";input.dispatchEvent(new Event("input",{bubbles:true}));panel.querySelector(".worker-cli-run").click();');
  assert(await untilScript('panel.querySelectorAll(".worker-cli-result").length===2 && panel.querySelector(".worker-cli-status").textContent==="执行成功。"'),'multiple ordered results missing');
  await execute('panel.querySelector("textarea").value="next draft";panel.querySelector("textarea").dispatchEvent(new Event("input",{bubbles:true}));window.saved=panel.querySelector(".worker-cli-result");');
  for(const index of [0,1,2,3]){
    await execute(`switchTab(${index});`);
    assert(await untilScript(`ui.transcriptView.mode===${JSON.stringify(['transcript','code','performance','cli'][index])}`),'tab did not activate');
  }
  assert(await execute('return ui.transcriptView.cli===panel&&panel.querySelector("textarea").value==="next draft"&&panel.querySelector(".worker-cli-result")===saved;'),'tab switching lost history/draft');
  await execute('const input=panel.querySelector("textarea");input.value="lush order example";input.dispatchEvent(new Event("input",{bubbles:true}));panel.querySelector(".worker-cli-run").click();');
  assert(await untilScript('document.querySelector(".worker-cli-confirm")'),'Agent confirmation missing');
  assert(await execute(`const button=document.querySelector('#modal .agent-call');return !!button&&!!button.dataset.help&&button.getBoundingClientRect().height===(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-primary-height'))||parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-height')))&&calls.length===5&&document.documentElement.scrollWidth<=innerWidth&&button.closest('dialog')?.open&&document.elementFromPoint(button.getBoundingClientRect().x+3,button.getBoundingClientRect().y+3)===button;`),'Agent action marking, pre-confirm execution or confirmation overflow');
  await execute(`const buttons=[...document.querySelectorAll('#modal button')];buttons.find(b=>b.textContent==='取消').click();`);
  assert(await untilScript(`panel.querySelector('.worker-cli-status').textContent==='已取消，未执行。'`),'cancel failed');
  assert(await execute('return calls.length===5;'),'cancel executed command');
  passed=true;console.log('PASS fullscreen fourth tab, native Enter/Shift+Enter, ordered terminal history, four-tab draft retention, top-layer Agent confirmation/cancel; no real model calls');
}catch(error){
  if(session)await Bun.write(join(temp,'failure.png'),Buffer.from(await rpc(`/session/${session}/screenshot`,undefined,'GET'),'base64')).catch(()=>{});
  console.error(`Worker CLI browser failure logs: ${temp}`);throw error;
}finally{
  if(session)await rpc(`/session/${session}`,undefined,'DELETE').catch(()=>{});
  driver.kill();await driver.exited;server.stop(true);if(passed)await rm(temp,{recursive:true,force:true});
}
