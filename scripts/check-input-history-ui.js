// Isolated real Firefox/app-shell regression. Fixture APIs only: no daemon, model or user project.
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCapabilityGuides } from '../src/agent/capabilities.js';

const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const output = process.argv[2] || '/tmp/lush-input-pages-browser';
await mkdir(output, { recursive: true });
const fixture = `
import { makeWorld } from '/fixture-world.js';
const world=makeWorld(), json=data=>({ok:true,json:async()=>structuredClone(data)});
world.state.inputParents=[{id:1,branch:'main',goal:'主干'}];
const base={created_at:'2026-10-17T05:00:00Z',parent_id:1,parent_worker_number:null,branch:'main',merge_status:'none',integration:'none',references:[],content_truncated:false};
window.rows=[
 {...base,kind:'input',mode:'order',id:20,task_id:1,status:'awaiting_acceptance',content:'已经发送的工作原文 <img src=x>，记录用户何时对项目作出批示。'},
 {...base,kind:'message',mode:'append',id:21,task_id:1,task_worker_number:'W20',append_number:'A20-1',status:'waiting',content:'已入箱的追加指令，不代表 Agent 已经收到。'},
 {...base,kind:'management',mode:'management',id:22,task_id:22,task_worker_number:'V1',status:'running',content:'管理指令原文'},
 {...base,kind:'draft',mode:'order',id:1,draft_number:12,status:'draft',revision:1,content:'未发送工作暂存：调整历史与草稿页面，允许修改执行条件。',conditions:[{kind:'worker_merged',worker_id:17,worker_number:'W17'}],exclusive:false},
 {...base,kind:'draft',mode:'order',id:2,status:'unknown_dispatch',revision:1,content:'未知投递授权保留待核验',conditions:[],dispatch:{state:'unknown',reason:'等待核验真实现场',conditions:[]}},
 {...base,kind:'draft',mode:'append',id:3,status:'draft',revision:1,target_id:1,target_worker_number:'W20',content:'追加输入暂存：补充窄屏验证。',conditions:[],exclusive:false}
];window.calls=[];window.reads=[];
window.fetch=async(url,options={})=>{
 const route=new URL(url,location.href),path=route.pathname.replace(/^\\/p\\/[^/]+/,'');
 if(path==='/api/inputs'){
  window.reads.push(route.search);const drafts=route.searchParams.get('view')==='drafts',modes=JSON.parse(route.searchParams.get('modes')||'["order","append","management"]');
  const q=route.searchParams.get('q')||'',status=route.searchParams.get('status');
  return json({items:window.rows.filter(row=>(drafts?row.kind==='draft'&&row.dispatch?.state!=='succeeded':row.kind!=='draft')&&modes.includes(row.mode)&&row.content.includes(q)&&(!status||row.status===status)),next_cursor:null});
 }
 if(path==='/api/input-parents')return json({items:world.state.inputParents});
 const match=/^\\/api\\/input\\/(draft|input|message|management)\\/(\\d+)$/.exec(path);
 if(match)return json(window.rows.find(row=>row.kind===match[1]&&row.id===Number(match[2])));
 if(path==='/api/action'){
  const body=JSON.parse(options.body);window.calls.push(body);const p=body.params,row=window.rows.find(row=>row.kind==='draft'&&row.id===(p.id??p.draft_id));
  if(body.method==='draft.update'){if(p.expected_revision!==row.revision)throw Error('revision conflict');Object.assign(row,p,{revision:row.revision+1});return json(row);}
  if(body.method==='input.emit'){row.dispatch={state:'waiting_conditions',conditions:row.conditions};return json({emitted:true,draft_id:row.id,draft_number:row.draft_number??null,revision:row.revision,dispatch:row.dispatch});}
 }
 return world.fetchImpl(path+route.search,options);
};
window.finishDraft=()=>{const row=window.rows.find(row=>row.kind==='draft'&&row.id===1);row.dispatch={state:'succeeded',input_id:30,worker_id:30,conditions:row.conditions};row.input_id=30;
 window.rows.push({...base,kind:'input',mode:'order',id:30,task_id:30,status:'queued',content:row.content,source_draft_id:1});};
await import('/app.js');window.ui=(await import('/state.js')).ui;window.ready=true;
`;
const html = (await Bun.file(join(assets, 'index.html')).text()).replace('<script type="module" src="/app.js"></script>', '<script type="module" src="/fixture.js"></script>');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/') return new Response('<!doctype html><html><body style="margin:0"><iframe id="view" src="/p/aaaaaaaaaaaaaaaa/#inputs" style="width:1440px;height:1000px;border:0;display:block"></iframe></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (path === '/p/aaaaaaaaaaaaaaaa/') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  if (path === '/fixture.js') return new Response(fixture, { headers: { 'Content-Type': 'text/javascript' } });
  if (path === '/fixture-world.js') return new Response((await Bun.file(new URL('../test/web/dom-world.js', import.meta.url)).text()).replace('../../src/ui/web/assets/prefs.js', '/prefs.js').replace("import { listCapabilityGuides } from '../../src/agent/capabilities.js';", `const listCapabilityGuides=()=>${JSON.stringify(listCapabilityGuides())};`), { headers: { 'Content-Type': 'text/javascript' } });
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-input-pages-')), log = join(temp, 'driver.log');
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log) });
let session, passed = false;
async function rpc(path, body, method = 'POST') {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  const data = await response.json(); if (!response.ok) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const assert = (value, message) => { if (!value) throw Error(message); };
async function frame(script) {
  const result = await rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0],win=document.querySelector('#view').contentWindow,doc=win.document;
    const until=async test=>{for(let i=0;i<200;i++){if(test())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('UI condition timed out');};
    const button=text=>[...doc.querySelectorAll('button')].find(node=>node.textContent===text);
    (async()=>{${script}})().then(done).catch(error=>done({error:error.message}));`, args: [] });
  if (result?.error) throw Error(JSON.stringify(result)); return result;
}
async function screenshot(name) {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#view' });
  const bytes = await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/screenshot`, undefined, 'GET');
  await Bun.write(join(output, name), Buffer.from(bytes, 'base64'));
}
try {
  // Only wait for our isolated browser startup, never Workers or user processes.
  for (let attempt=0;attempt<100;attempt++) {
    try { await rpc('/status', undefined, 'GET'); break; } catch { if(driver.exitCode!==null)throw Error('geckodriver exited');await Bun.sleep(50); }
  }
  session=(await rpc('/session',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{args:['-headless']}}}})).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1120 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  await frame('await until(()=>win.ready);return true;');
  for (const theme of ['light','dark']) for (const width of [1440,900,390]) {
    await execute(`document.querySelector('#view').style.width='${width}px';`);
    const result=await frame(`
      doc.documentElement.dataset.theme='${theme}';win.location.hash='#inputs';
      await until(()=>win.ui.view.id==='inputs'&&doc.querySelector('.inputs-browse')&&!doc.querySelector('.inputs-browse').hidden);
      await new Promise(resolve=>win.requestAnimationFrame(()=>win.requestAnimationFrame(resolve)));
      const history=[...doc.querySelectorAll('.input-record')].map(node=>node.dataset.input);
      const advanced=doc.querySelector('.input-advanced-filters');
      const historyClosed=!advanced.open;
      const equal=[...doc.querySelectorAll('.input-row')].map(node=>node.getBoundingClientRect().height);
      doc.querySelector('[data-input="input:20"] .input-row').click();
      await until(()=>win.location.hash==='#input-input-20'&&doc.querySelector('.input-original'));
      const readOnly=!doc.querySelector('.input-detail textarea')&&!doc.querySelector('.input-detail img');
      button('← 返回历史输入').click();
      if(${width}<=760)doc.querySelector('#sidebar-toggle').click();
      doc.querySelector('#drafts-open').click();
      await until(()=>win.ui.view.id==='drafts'&&doc.querySelectorAll('.input-record').length===2);
      const draftScope=new URLSearchParams(win.reads.at(-1)).get('view');
      const summary=doc.querySelector('.input-draft-summary').textContent;
      const modes=[...doc.querySelectorAll('.input-mode-toggle')];
      const workOnly=modes.length===2&&modes.find(node=>node.dataset.mode==='order').getAttribute('aria-pressed')==='true';
      doc.querySelector('[data-mode="append"]').click();await until(()=>doc.querySelectorAll('.input-record').length===1);
      const appendOnly=doc.querySelector('.input-record').dataset.input==='draft:3';
      doc.querySelector('.input-row').click();await until(()=>win.location.hash==='#input-draft-3'&&doc.querySelector('.input-detail textarea'));
      const target=doc.querySelector('.input-detail').textContent.includes('W20');
      button('← 返回草稿').click();
      const retained=doc.querySelector('[data-mode="append"]').getAttribute('aria-pressed')==='true';
      doc.querySelector('[data-mode="order"]').click();await until(()=>doc.querySelectorAll('.input-record').length===2);
      doc.querySelector('[data-input="draft:1"] .input-row').click();await until(()=>win.location.hash==='#input-draft-1'&&doc.querySelector('.input-detail textarea'));
      await new Promise(resolve=>win.requestAnimationFrame(()=>win.requestAnimationFrame(resolve)));
      const conditions=doc.querySelector('.emission-conditions'),runtime=doc.querySelector('.input-runtime-settings');
      const conditionOpen=!conditions.hidden,advancedClosed=doc.querySelector('.emission-advanced-body').hidden&&!runtime.open;
      const fits=[doc.querySelector('.input-detail'),conditions,...doc.querySelectorAll('.input-actions')].every(node=>node.scrollWidth<=node.clientWidth+1);
      const actions=[...doc.querySelectorAll('.input-actions button')].filter(node=>node.getClientRects().length).map(node=>{const r=node.getBoundingClientRect();return {text:node.textContent,x:r.x,right:r.right,height:r.height};});
      return {width:win.innerWidth,scrollWidth:doc.documentElement.scrollWidth,history,historyClosed,equal,readOnly,draftScope,summary,workOnly,appendOnly,target,retained,conditionOpen,advancedClosed,fits,actions};
    `);
    assert(result.width===width&&result.scrollWidth<=width&&result.fits,`overflow ${theme}/${width}: ${JSON.stringify(result)}`);
    assert(JSON.stringify(result.history)===JSON.stringify(['input:20','message:21','management:22'])&&result.readOnly&&result.historyClosed,`history ${JSON.stringify(result)}`);
    assert(result.equal.every(height=>height===result.equal[0])&&result.draftScope==='drafts'&&result.summary.includes('W17 本轮合入 main'),`list summaries ${JSON.stringify(result)}`);
    assert(result.workOnly&&result.appendOnly&&result.target&&result.retained&&result.conditionOpen&&result.advancedClosed,`hierarchy ${JSON.stringify(result)}`);
    assert(result.actions.every(row=>row.x>=0&&row.right<=width+1&&(width>760||row.height>=44)),`actions ${JSON.stringify(result)}`);
    if(width===390||width===1440){
      await screenshot(`draft-${theme}-${width}.png`);
      const reachable=await frame("doc.querySelector('.emission-conditions').scrollIntoView({block:'start',behavior:'instant'});await new Promise(resolve=>win.requestAnimationFrame(()=>win.requestAnimationFrame(resolve)));const node=doc.querySelector('.emission-conditions'),r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,scroll:node.scrollWidth,client:node.clientWidth};");
      assert(reachable.top>=-1&&reachable.bottom>0&&reachable.scroll<=reachable.client+1,`condition form not reachable ${theme}/${width}: ${JSON.stringify(reachable)}`);
      await screenshot(`conditions-${theme}-${width}.png`);
      const submitReachable=await frame("const control=doc.querySelector('.input-submit-actions .agent-call');control.scrollIntoView({block:'center',behavior:'instant'});await new Promise(resolve=>win.requestAnimationFrame(()=>win.requestAnimationFrame(resolve)));const r=control.getBoundingClientRect(),composer=doc.querySelector('.composer').getBoundingClientRect();return r.top>=0&&r.bottom<=composer.top+1;");
      assert(submitReachable,`submit hidden under composer ${theme}/${width}`);
    }
    console.log(`PASS ${theme}/${width}px real iframe: sent history, independent navigation, two draft classes, expanded conditions, advanced collapsed, no overflow`);
  }
  // Actual history/back and keyboard save within the iframe browsing context.
  await execute("document.querySelector('#view').style.width='900px';");
  await frame("win.location.hash='#drafts';await until(()=>!doc.querySelector('.inputs-browse').hidden);doc.querySelector('[data-input=\"draft:1\"] .input-row').click();await until(()=>!doc.querySelector('.input-detail').hidden);return true;");
  const frameElement=await rpc(`/session/${session}/element`,{using:'css selector',value:'#view'});
  await rpc(`/session/${session}/frame`,{id:frameElement});
  await rpc(`/session/${session}/back`,{});
  const back=await rpc(`/session/${session}/execute/async`,{script:"const done=arguments[0];let n=0;const check=()=>location.hash==='#drafts'&&!document.querySelector('.inputs-browse').hidden?done(true):++n>200?done(false):setTimeout(check,10);check();",args:[]});
  assert(back,'browser back did not return to drafts list');
  await execute("document.querySelector('[data-input=\"draft:1\"] .input-row').click();");
  await rpc(`/session/${session}/execute/async`,{script:"const done=arguments[0];let n=0;const check=()=>document.querySelector('.input-detail textarea')&&!document.querySelector('.input-detail').hidden?done(true):++n>200?done(false):setTimeout(check,10);check();",args:[]});
  await execute("const node=document.querySelector('.input-detail textarea');node.value='真实键盘保存的工作暂存';node.dispatchEvent(new Event('input',{bubbles:true}));node.focus();");
  await rpc(`/session/${session}/actions`,{actions:[{type:'key',id:'keyboard',actions:[{type:'keyDown',value:'\uE009'},{type:'keyDown',value:'s'},{type:'keyUp',value:'s'},{type:'keyUp',value:'\uE009'}]}]});
  const saved=await rpc(`/session/${session}/execute/async`,{script:"const done=arguments[0];let n=0;const check=()=>window.calls.at(-1)?.method==='draft.update'&&document.querySelector('.input-save').disabled?done(true):++n>200?done(false):setTimeout(check,10);check();",args:[]});
  assert(saved,'real Ctrl+S failed');
  await execute("document.querySelector('.input-detail .agent-call').click();");
  const mounted=await rpc(`/session/${session}/execute/async`,{script:"const done=arguments[0];let n=0;const check=()=>!document.querySelector('.input-detail textarea')&&window.calls.at(-1)?.method==='input.emit'?done(true):++n>200?done(false):setTimeout(check,10);check();",args:[]});
  assert(mounted,'mount must consume editor, not create fake Worker');
  await execute("window.finishDraft();[...document.querySelectorAll('button')].find(node=>node.textContent==='刷新提交状态').click();");
  const finished=await rpc(`/session/${session}/execute/async`,{script:"const done=arguments[0];let n=0;const check=()=>document.querySelector('.input-detail').textContent.includes('已投递')?done(true):++n>200?done(false):setTimeout(check,10);check();",args:[]});
  assert(finished,'successful receipt did not refresh');
  await execute("[...document.querySelectorAll('button')].find(node=>node.textContent==='查看已创建原文 O30').click();");
  const source=await rpc(`/session/${session}/execute/async`,{script:"const done=arguments[0];let n=0;const check=()=>location.hash==='#input-input-30'&&document.querySelector('.input-detail').textContent.includes('查看提交草稿')?done(true):++n>200?done(false):setTimeout(check,10);check();",args:[]});
  assert(source,'actual original must expose source receipt');
  assert(await execute("return !document.querySelector('.input-detail').textContent.includes('提交草稿 #1');"),'source link guessed a display number from an internal id');
  await execute("[...document.querySelectorAll('button')].find(node=>node.textContent==='查看提交草稿 · 条件与独占').click();");
  await rpc(`/session/${session}/frame`,{id:null});
  const noDuplicate=await frame("await until(()=>win.location.hash==='#input-draft-1');button('← 返回草稿').click();return ![...doc.querySelectorAll('.input-record')].some(node=>node.dataset.input==='draft:1');");
  assert(noDuplicate,'successful source still appears in draft list');
  console.log('PASS real browser back, Ctrl+S, mounted readonly receipt, successful history/source round trip and no duplicate draft');
  passed=true;
} finally {
  if(session){try{await rpc(`/session/${session}`,undefined,'DELETE');}catch{}}
  driver.kill();await driver.exited;server.stop(true);
  if(passed)await rm(temp,{recursive:true,force:true});else console.error(`Browser diagnostic: ${log}`);
}
