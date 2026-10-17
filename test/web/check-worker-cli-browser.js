// Standalone real Firefox layout/interaction check; callbacks are controlled fixtures.
// Real authenticated HTTP/RPC/CLI execution is covered by dom-worker-cli-api.test.js.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';

const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['styles.css','styles-core.css','styles-worker-cli.css'].map(name => `<link rel="stylesheet" href="/assets/${name}">`).join('')}
</head><body style="margin:0;padding:12px;box-sizing:border-box"><div id="detail"></div><div id="modal" hidden></div><div id="error"></div>
<script type="module">
import { renderWorkerCli } from '/assets/worker-cli.js';
window.errors=[]; addEventListener('error',e=>errors.push(e.message)); addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
window.calls=[];
const task={id:77,worker_number:'W324',task_kind:'order',workspace:'/project/'+('very-long-worker-directory/').repeat(12)};
window.panel=renderWorkerCli(task,{
 preview:async command=>{calls.push('preview');return {id:77,command,workspace:task.workspace,argv:['status'],executable:'lush',path:'status',kind:command.includes('order')?'agent':'read',requires_confirmation:command.includes('order'),revision:'revision'};},
 execute:async({command})=>{calls.push('execute');return {command,workspace:task.workspace,status:'succeeded',exit_code:0,stdout:'a'.repeat(4000)+'\\n<literal-output>',stderr:'warning',duration_ms:2};}
}); document.querySelector('#detail').append(panel);window.task=task;window.ready=true;
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
  assert(await execute('return !panel.open && calls.length===0 && !panel.querySelector("textarea").checkVisibility();'),'panel must start collapsed without requests');
  await execute('panel.querySelector("summary").focus();');
  await rpc(`/session/${session}/actions`,{actions:[{type:'key',id:'keyboard',actions:[{type:'keyDown',value:'\uE007'},{type:'keyUp',value:'\uE007'}]}]});
  assert(await execute('return panel.open && calls.length===0;'),'native Enter disclosure failed');
  await execute('panel.querySelector(".worker-cli-advanced").open=true;panel.querySelector(".worker-cli-examples button").click();');
  assert(await execute('return calls.length===0 && panel.querySelector("textarea").value==="lush help";'),'example executed instead of filling');
  await execute('panel.querySelector(".worker-cli-run").click();');
  assert(await untilScript('panel.querySelector(".worker-cli-status").textContent==="执行成功。"'),'fixture query did not complete');
  for(const theme of ['light','dark'])for(const width of [1440,900,600,390,320]){
    await rpc(`/session/${session}/frame`,{id:null});await execute(`document.querySelector('#viewport').style.width='${width}px';`);await frame();
    await execute(`document.documentElement.dataset.theme='${theme}';`);
    const result=await execute(`
      const errors=[],input=panel.querySelector('textarea'),run=panel.querySelector('.worker-cli-run'),output=panel.querySelector('.worker-cli-output');
      const a=input.getBoundingClientRect(),b=run.getBoundingClientRect();
      if(innerWidth<=600 && b.top<a.bottom)errors.push('narrow controls not stacked');
      for(const control of [input,run,...panel.querySelectorAll('.worker-cli-examples button')]){const r=control.getBoundingClientRect();if(r.right>innerWidth+1||r.left<0)errors.push('clipped control');}
      if(b.height<44)errors.push('small touch target');
      if(document.documentElement.scrollWidth>innerWidth)errors.push('page overflow');
      if(output.scrollWidth<=output.clientWidth||getComputedStyle(output).overflowX!=='auto')errors.push('long output not independently scrollable');
      if(!output.textContent.endsWith('<literal-output>')||output.querySelector('literal-output'))errors.push('output not literal');
      if(!panel.querySelector('.worker-cli-advanced').open)errors.push('disclosure lost');
      return {errors,browserErrors:window.errors,calls};`);
    assert(!result.errors.length&&!result.browserErrors.length,`${theme} ${width}: ${JSON.stringify(result)}`);
    console.log(`PASS ${theme} ${width}px: stacked narrow controls, 44px actions, wrapped cwd, plain scrollable output, no page overflow`);
  }
  await execute('const input=panel.querySelector("textarea");input.value="lush order example";input.dispatchEvent(new Event("input",{bubbles:true}));panel.querySelector(".worker-cli-run").click();');
  assert(await untilScript('document.querySelector(".worker-cli-confirm")'),'Agent confirmation missing');
  assert(await execute(`const button=document.querySelector('#modal .agent-call');return !!button&&!!button.dataset.help&&calls.length===3&&document.documentElement.scrollWidth<=innerWidth;`),'Agent action marking, pre-confirm execution or confirmation overflow');
  await execute(`const buttons=[...document.querySelectorAll('#modal button')];buttons.find(b=>b.textContent==='取消').click();`);
  assert(await untilScript(`panel.querySelector('.worker-cli-status').textContent==='已取消，未执行。'`),'cancel failed');
  assert(await execute('return calls.length===3;'),'cancel executed command');
  passed=true;console.log('PASS keyboard disclosure, examples do not execute, explicit Agent confirmation/cancel; no real model calls');
}catch(error){
  if(session)await Bun.write(join(temp,'failure.png'),Buffer.from(await rpc(`/session/${session}/screenshot`,undefined,'GET'),'base64')).catch(()=>{});
  console.error(`Worker CLI browser failure logs: ${temp}`);throw error;
}finally{
  if(session)await rpc(`/session/${session}`,undefined,'DELETE').catch(()=>{});
  driver.kill();await driver.exited;server.stop(true);if(passed)await rm(temp,{recursive:true,force:true});
}
