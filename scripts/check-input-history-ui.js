// Shared real Firefox/app-shell check. Fixture APIs are not a substitute for dom-inputs-api's HTTP/RPC/SQLite chain.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCapabilityGuides } from '../src/agent/capabilities.js';
const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const fixture = `
import {makeWorld} from '/fixture-world.js';
const world=makeWorld(),json=value=>Response.json(structuredClone(value));
const base={kind:'draft',mode:'order',parent_id:1,branch:'main',references:[],conditions:[],exclusive:false,revision:1,status:'draft',created_at:'2026-10-17T05:00:00Z',merge_status:'none'};
window.rows=[
 {...base,kind:'input',id:20,mode:'order',content:'已发送的原文 <img src=x>',task_id:1,status:'waiting'},
 {...base,kind:'message',id:21,mode:'append',content:'已入箱追加',task_id:1,append_number:'A20-1'},
 {...base,kind:'management',id:22,mode:'management',content:'已提交管理原文',task_id:9,task_worker_number:'V3'},
 {...base,id:1,draft_number:12,content:'工作暂存',conditions:[{kind:'worker_merged',worker_id:17,worker_number:'W17'}]},
 {...base,id:2,content:'未知授权',dispatch:{state:'unknown',reason:'等待核验：原提交的投递结果尚未确认，请查看精确收据；不能将已保存授权视作 Agent 已执行，也不要重复提交。',conditions:[]}},
 {...base,id:3,mode:'append',content:'追加暂存',target_id:1,target_worker_number:'W20'},
 {...base,id:4,mode:'management',parent_id:null,branch:null,target_id:9,target_worker_number:'V3',content:'原管家管理暂存'}
];window.calls=[];window.reads=[];window.errors=[];window.nativeKeyEvents=[];
document.addEventListener('keydown',event=>{if(event.target.id==='input')window.nativeKeyEvents.push({key:event.key,ctrl:event.ctrlKey,trusted:event.isTrusted});},true);
addEventListener('error',e=>window.errors.push(e.message));addEventListener('unhandledrejection',e=>window.errors.push(String(e.reason)));
const viewport=new EventTarget();Object.assign(viewport,{height:innerHeight,offsetTop:0,scale:1});
Object.defineProperty(window,'visualViewport',{value:viewport,configurable:true});window.keyboard=h=>{viewport.height=h;viewport.dispatchEvent(new Event('resize'));};
window.worker={id:1,worker_number:'W20',task_kind:'order',status:'waiting',branch:'main',workspace:'/tmp/fixture',goal:'原阅读上下文'};
window.valet={id:9,worker_number:'V3',role:'manager',task_kind:'management',status:'completed',goal:'原生管家',management:{version:1,can_append:true,state:'idle'}};
const creations=new Map();
window.fetch=async(url,options={})=>{
 const route=new URL(url,location.href),path=route.pathname.replace(/^\\/p\\/[^/]+/,'');
 if(path==='/api/input-parents')return json({items:[{id:1,worker_number:'W20',branch:'main',goal:'主干'}]});
 if(path==='/api/worker/9')return json(window.valet);
 if(path==='/api/worker/1')return json({...await(await world.fetchImpl(path,options)).json(),...window.worker});
 if(path==='/api/workers')return json({tasks:[window.worker,window.valet],has_more:false});
 if(path==='/api/worker-lookup')return json(route.searchParams.get('number')==='V3'?window.valet:window.worker);
 if(path==='/api/inputs'){
  window.reads.push(route.search);const drafts=route.searchParams.get('view')==='drafts',modes=JSON.parse(route.searchParams.get('modes')||'["order","append","management"]');
  const q=route.searchParams.get('q')||'',status=route.searchParams.get('status');
  return json({items:window.rows.filter(row=>(drafts?row.kind==='draft'&&row.dispatch?.state!=='succeeded':row.kind!=='draft')&&modes.includes(row.mode)&&row.content.includes(q)&&(!status||row.status===status)),next_cursor:null});
 }
 const match=/^\\/api\\/input\\/(draft|input|message|management)\\/(\\d+)$/.exec(path);
 if(match)return json(window.rows.find(row=>row.kind===match[1]&&row.id===Number(match[2])));
 if(path==='/api/action'){
  const body=JSON.parse(options.body);window.calls.push(body);const p=body.params;
  if(body.method==='draft.add'){
   if(creations.has(p.client_request_id))return json(creations.get(p.client_request_id));
   const id=100+window.rows.length,row={...base,...p,id,draft_number:id,parent_id:p.mode==='management'?null:1,branch:p.mode==='management'?null:p.branch||'main'};
   window.rows.push(row);creations.set(p.client_request_id,row);return json(row);
  }
  const row=window.rows.find(row=>row.kind==='draft'&&row.id===(p.id??p.draft_id));
  if(body.method==='draft.update'){if(p.expected_revision!==row.revision) return Response.json({error:'draft revision conflict'},{status:409});Object.assign(row,p,{revision:row.revision+1});return json(row);}
  if(body.method==='management.submit'&&p.instruction)return json({management:true,task:window.valet});
  if(body.method==='input.emit'||body.method==='management.submit'){
   if(p.expected_revision!==row.revision)return Response.json({error:'draft revision conflict'},{status:409});
   row.dispatch={kind:row.mode==='management'?'management':'order',state:row.mode==='management'?'succeeded':'waiting_conditions',conditions:row.conditions,worker_id:row.mode==='management'?9:undefined};
   return json({emitted:row.mode!=='management',management:row.mode==='management',task:window.valet,draft_id:row.id,draft_number:row.draft_number,revision:row.revision,dispatch:row.dispatch});
  }
  if(body.method==='draft.remove'){window.rows=window.rows.filter(item=>item!==row);return json({id:p.id});}
 }
 return world.fetchImpl(path+route.search,options);
};
await import('/app.js');window.ui=(await import('/state.js')).ui;window.workspace=await import('/composer-workspace.js');window.inputPages=await import('/render-inputs.js');window.emissionFeature=await import('/automation-emission.js');
window.preferences=await import('/prefs.js');window.originalInput=document.querySelector('#input');window.ready=true;
`;

export async function runInputBrowserCheck({ scope = 'history', output = `/tmp/lush-input-${scope}` } = {}) {
  await mkdir(output, { recursive: true });
  const html = (await Bun.file(join(assets, 'index.html')).text()).replace('<script type="module" src="/app.js"></script>', '<script type="module" src="/fixture.js"></script>');
  const world = (await Bun.file(new URL('../test/web/dom-world.js', import.meta.url)).text()).replace('../../src/ui/web/assets/prefs.js', '/prefs.js').replace("import { listCapabilityGuides } from '../../src/agent/capabilities.js';", `const listCapabilityGuides=()=>${JSON.stringify(listCapabilityGuides())};`);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/') return new Response('<!doctype html><style>body{margin:0}</style><iframe id="view" src="/p/aaaaaaaaaaaaaaaa/#inputs" style="width:1440px;height:1000px;border:0;display:block"></iframe>', { headers: { 'Content-Type': 'text/html' } });
    if (path === '/p/aaaaaaaaaaaaaaaa/') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    if (path === '/fixture.js' || path === '/fixture-world.js') return new Response(path === '/fixture.js' ? fixture : world, { headers: { 'Content-Type': 'text/javascript' } });
    if (path === '/administrator/project-protocol.js') return new Response(Bun.file(new URL('../src/administrator/project-protocol.js', import.meta.url)));
    if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.slice(1))));
    return new Response('not found', { status: 404 });
  } });
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = reservation.port; reservation.stop(true);
  const temp = await mkdtemp(join(tmpdir(), 'lush-unified-input-')), log = join(output, 'geckodriver.log');
  const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log) });
  let session;
  async function rpc(path, body, method = 'POST') {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const data = await response.json(); if (!response.ok) throw Error(JSON.stringify(data)); return data.value;
  }
  const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
  const assert = (value, message) => { if (!value) throw Error(message); };
  // Use the real iframe browsing context and WebDriver input source, not dispatchEvent.
  async function nativeInput(text, key, control = false) {
    const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#view' });
    await rpc(`/session/${session}/frame`, { id: element });
    try {
      if (text !== undefined) {
        const input = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#input' });
        await rpc(`/session/${session}/element/${input['element-6066-11e4-a52e-4f735466cecf']}/value`, { text });
      }
      if (key) await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'native-input', actions: [
        ...(control ? [{ type: 'keyDown', value: '\uE009' }] : []),
        { type: 'keyDown', value: key }, { type: 'keyUp', value: key },
        ...(control ? [{ type: 'keyUp', value: '\uE009' }] : []),
      ] }] });
    } finally { await rpc(`/session/${session}/frame`, { id: null }); }
  }
  async function frame(script) {
    const result = await rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0],win=document.querySelector('#view').contentWindow,doc=win.document;
      const until=async test=>{for(let i=0;i<300;i++){if(test())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('UI condition timed out');};
      const button=text=>[...doc.querySelectorAll('button')].find(node=>node.textContent===text);
      (async()=>{${script}})().then(done).catch(error=>done({error:error.message,stack:error.stack,errors:win.errors,hash:win.location.hash,view:win.ui?.view,detail:doc.querySelector('#detail')?.textContent.slice(-2500),entry:win.workspace?.currentEdit()?.saved,calls:win.calls?.slice(-3)}));`, args: [] });
    if (result?.error) throw Error(JSON.stringify(result)); return result;
  }
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await rpc('/status', undefined, 'GET'); break; } catch { if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(50); }
    }
    session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'], prefs: { 'profile': temp } } } } })).sessionId;
    await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1120 });
    await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
    await frame('await until(()=>win.ready&&win.ui.inputEditor);return true;');
    assert(await frame(`return doc.querySelector('#input-form').hidden&&doc.querySelector('#composer-shell').getBoundingClientRect().height===0;`), 'default collapsed footprint');
    for (const theme of ['light', 'dark']) for (const width of scope === 'history' ? [1440, 900, 390, 320] : [1440, 760, 390, 320]) {
      await execute(`document.querySelector('#view').style.width='${width}px';`);
      const layout = await frame(`
        doc.documentElement.dataset.reducedMotion='true';doc.documentElement.dataset.theme='${theme}';win.keyboard(win.innerHeight);
        await win.workspace.selectComposerMode('order');
        const box=doc.querySelector('#input');box.value='便携正文 ${theme}/${width}';box.dispatchEvent(new win.Event('input'));
        const before=box;await win.ui.inputEditor.save();const id=win.workspace.currentEdit().saved.id;
        doc.querySelector('#detail').scrollTo({top:40,behavior:'instant'});const contextHash=win.location.hash,contextView=win.ui.view.id,readingScroll=doc.querySelector('#detail').scrollTop;
        const retained=box.value.includes('便携正文')&&win.rows.filter(row=>row.id===id).length===1;
        const basic=!doc.querySelector('#composer-editor-tools').hidden&&!doc.querySelector('#input-buffer').hidden&&doc.querySelector('.unified-editor-advanced').hidden&&doc.querySelector('#composer-expand').textContent==='详细编辑';
        const expectedHeight=node=>${width}<=760&&node.matches('.agent-call,.control-primary,.modal-confirm,[type="submit"]')?44:32;
        const submit=doc.querySelector('#draft-commit'),agent=submit.classList.contains('agent-call')&&submit.hasAttribute('data-help');
        await win.ui.inputEditor.detail();
        const formal=doc.querySelector('#input')===before&&doc.querySelectorAll('#input').length===1&&doc.querySelector('#input-form').dataset.host==='detail';
        const manual=doc.querySelector('.unified-editor-conditions'),natural=doc.querySelector('.draft-condition-valet');
        const hierarchy=!manual.open&&natural.getClientRects().length>0&&natural.querySelector('textarea').getClientRects().length>0
          &&natural.querySelector('button').classList.contains('agent-call')&&natural.querySelector('button').hasAttribute('data-help')
          &&!doc.querySelector('.unified-editor-runtime').open&&!doc.querySelector('.unified-editor-references').open&&!doc.querySelector('.unified-editor-danger')&&!doc.querySelector('#input-parent').disabled
          &&doc.querySelector('#composer-remove-draft-help').parentElement.classList.contains('composer-actions')&&!doc.querySelector('#composer-remove-draft').hidden
          &&!doc.querySelector('.input-metadata').textContent.includes('Worker 状态')&&!doc.querySelector('.input-metadata').textContent.includes('合并状态');
        manual.open=true;const manualAvailable=doc.querySelector('.emission-conditions').getClientRects().length>0;manual.open=false;
        const runtime=doc.querySelector('.unified-editor-runtime'),writesBefore=win.calls.length;runtime.open=true;
        await until(()=>runtime.querySelector('[data-retry-field="config_mode"]')&&!runtime.querySelector('.draft-run-fields').disabled);
        const runtimeVisible=runtime.querySelector('[data-retry-field="config_mode"]').getClientRects().length>0
          &&doc.querySelector('#modal').hidden&&!win.workspace.currentEdit().profile&&win.calls.length===writesBefore;
        const headings=[natural.querySelector('.draft-condition-summary'),runtime.querySelector('summary'),doc.querySelector('.unified-editor-references summary')];
        const aligned=headings.every(node=>Math.abs(node.getBoundingClientRect().left-headings[0].getBoundingClientRect().left)<1);
        const formalFits=[doc.querySelector('#input-form'),natural,runtime].every(node=>node.scrollWidth<=node.clientWidth+1);
        runtime.open=false;
        submit.scrollIntoView({block:'center',behavior:'instant'});const submitRect=submit.getBoundingClientRect();
        const formalActions=submitRect.top>=0&&submitRect.bottom<=win.innerHeight+1&&[...doc.querySelector('#input-form').querySelectorAll('button')].filter(node=>node.getClientRects().length).every(node=>node.getBoundingClientRect().height>=expectedHeight(node));
        box.value+=' · 详情修改';box.dispatchEvent(new win.Event('input'));
        const dirtyState=doc.querySelector('#composer-draft-status').textContent==='有未保存修改';
        const imeWrites=win.calls.length;box.dispatchEvent(new win.CompositionEvent('compositionstart'));
        box.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true,bubbles:true,cancelable:true}));
        box.dispatchEvent(new win.CompositionEvent('compositionend'));
        const imeSafe=win.calls.length===imeWrites;
        const plain=new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});box.dispatchEvent(plain);
        const savedRevision=win.workspace.currentEdit().saved.revision;
        const saveKey=new win.KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true});box.dispatchEvent(saveKey);
        await until(()=>win.workspace.currentEdit().saved.revision>savedRevision&&!win.ui.inputEditor.busy);
        const shortcuts=!plain.defaultPrevented&&saveKey.defaultPrevented;
        await win.ui.inputEditor.continuePortable();
        const bidirectional=doc.querySelector('#input')===before&&win.workspace.currentEdit().saved.id===id&&box.value.includes('详情修改')&&!win.ui.inputEditor.inDetail&&win.ui.view.id===contextView&&win.location.hash===contextHash&&Math.abs(doc.querySelector('#detail').scrollTop-readingScroll)<=1;
        const final=box.value;box.dispatchEvent(new win.KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}));
        const undone=box.value!==final;box.dispatchEvent(new win.KeyboardEvent('keydown',{key:'z',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
        const sharedUndo=undone&&box.value===final;
        await new Promise(resolve=>win.requestAnimationFrame(()=>win.requestAnimationFrame(resolve)));
        const form=doc.querySelector('#input-form'),r=form.getBoundingClientRect();
        const visible=[...form.querySelectorAll('button')].filter(node=>node.getClientRects().length);
        const controlsFit=visible.every(node=>{const b=node.getBoundingClientRect();return b.left>=0&&b.right<=win.innerWidth+1&&b.height>=expectedHeight(node);});
        const fits=doc.documentElement.scrollWidth<=win.innerWidth+1&&form.scrollWidth<=form.clientWidth+1&&r.width>0;
        const shellHeight=doc.querySelector('#composer-shell').getBoundingClientRect().height;
        const tool=doc.querySelector('#composer-expand'),tools=doc.querySelector('.composer-tools'),actions=doc.querySelector('.composer-actions');
        const compact=box.getBoundingClientRect().height===88&&shellHeight<=(${width}>760?210:260)
          &&doc.querySelector('#composer-shortcuts').hidden&&tool.scrollWidth<=tool.clientWidth+1
          &&tools.getBoundingClientRect().height===32
          &&doc.querySelector('#input-buffer').getBoundingClientRect().height===32
          &&actions.getBoundingClientRect().height===expectedHeight(submit)
          &&submit.getBoundingClientRect().height===expectedHeight(submit)
          &&doc.querySelector('#composer-draft-status').textContent==='已保存 · 未提交';
        const handle=doc.querySelector('#composer-resize');handle.dispatchEvent(new win.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));
        await new Promise(resolve=>win.requestAnimationFrame(resolve));
        const manualHeight=box.getBoundingClientRect().height;
        await win.ui.inputEditor.detail();await win.ui.inputEditor.continuePortable();
        const resizePreserved=manualHeight===104&&box.getBoundingClientRect().height===104;
        win.preferences.setPref('composerHeight',null);
        doc.querySelector('#composer-shortcuts-toggle').click();
        const helpAvailable=!doc.querySelector('#composer-shortcuts').hidden&&doc.querySelector('#composer-shortcuts-toggle').getAttribute('aria-expanded')==='true';
        doc.querySelector('#composer-shortcuts-toggle').click();
        doc.querySelector('#composer-reference-count').click();await until(()=>win.ui.inputEditor.inDetail&&doc.querySelector('.unified-editor-references').open);
        const referenceEntry=win.workspace.currentEdit().saved.id===id&&doc.querySelector('#input')===before;
        doc.querySelector('.unified-editor-references').open=false;await win.ui.inputEditor.continuePortable();
        await win.workspace.collapseComposer();doc.querySelector('#composer-launcher').click();
        await until(()=>[...doc.querySelectorAll('#composer-menu button')].every(node=>/\\d+ 份草稿/.test(node.textContent)));
        const menu=doc.querySelector('#composer-menu'),categories=[...menu.querySelectorAll('button')];
        const menuOnly=categories.length===3&&categories.every((node,index)=>node.firstElementChild.textContent===['新建工作','追加输入','管理 Lush'][index]);
        const counts=categories.every((node,index)=>{
          const mode=['order','append','management'][index],keys=new Set(win.rows.filter(row=>row.kind==='draft'&&row.mode===mode&&row.dispatch?.state!=='succeeded').map(row=>'draft:'+row.id));
          for(const entry of win.ui.composerWorkspace.entries.values())if(entry.mode===mode&&(entry.content?.trim()||entry.references?.length||entry.saved))keys.add(entry.saved?'draft:'+entry.saved.id:entry.key);
          return node.lastElementChild.textContent===keys.size+' 份草稿';
        });
        const menuFits=menu.scrollWidth<=menu.clientWidth+1&&categories.every(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=win.innerWidth+1&&r.height===32;});
        doc.querySelector('#composer-menu-order').click();await until(()=>!doc.querySelector('#input-form').hidden&&doc.querySelector('#composer-menu').hidden);
        const choose=doc.querySelector('#composer-choose-draft'),list=doc.querySelector('#composer-draft-list');
        const chooseVisible=choose.getClientRects().length>0,parent=choose.parentNode,next=choose.nextElementSibling;
        const collapsed=()=>list.hidden&&choose.textContent==='展开草稿'&&choose.getAttribute('aria-expanded')==='false';
        const initial=collapsed()&&choose.getAttribute('aria-controls')===list.id;
        const row=()=>[...list.querySelectorAll('button')].find(node=>node.dataset.editKey==='draft:'+id);
        choose.click();await until(row);
        const expanded=!list.hidden&&choose.textContent==='收起草稿'&&choose.getAttribute('aria-expanded')==='true'
          &&choose.querySelector('.view-disclosure-icon').dataset.expanded==='true'&&choose.parentNode===parent&&choose.nextElementSibling===next;
        const content=before.value,entry=win.workspace.currentEdit(),writes=win.calls.length;
        choose.click();
        const folded=collapsed()&&before.value===content&&win.workspace.currentEdit()===entry&&win.calls.length===writes
          &&choose.querySelector('.view-disclosure-icon').dataset.expanded==='false'&&choose.getClientRects().length>0
          &&choose.parentNode===parent&&choose.nextElementSibling===next;
        choose.click();await until(row);row().click();await until(()=>list.hidden);
        const picker=chooseVisible&&initial&&expanded&&folded&&collapsed()&&win.workspace.currentEdit().saved.id===id&&doc.querySelector('#input')===before;
        return {retained,basic,agent,formal,hierarchy,manualAvailable,runtimeVisible,aligned,formalFits,formalActions,bidirectional,dirtyState,imeSafe,shortcuts,sharedUndo,fits,controlsFit,compact,resizePreserved,helpAvailable,referenceEntry,menuOnly,counts,menuFits,picker,shellHeight,width:win.innerWidth,context:{actual:win.location.hash,expected:contextHash,view:win.ui.view.id,expectedView:contextView,scroll:doc.querySelector('#detail').scrollTop,expectedScroll:readingScroll},errors:win.errors};
      `);
      assert(layout.width === width && Object.entries(layout).filter(([key]) => !['width', 'errors', 'shellHeight'].includes(key)).every(([, value]) => value), `${scope}/${theme}/${width}: ${JSON.stringify(layout)}`);
      if (width === 390 || width === 1440) {
        await Bun.write(join(output, `${theme}-${width}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
        await frame(`await win.ui.inputEditor.detail();doc.querySelector('#input-form').scrollIntoView({block:'start'});await new Promise(resolve=>win.requestAnimationFrame(()=>win.requestAnimationFrame(resolve)));return true;`);
        await Bun.write(join(output, `detail-${theme}-${width}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
        await frame(`const runtime=doc.querySelector('.unified-editor-runtime');runtime.open=true;await until(()=>runtime.querySelector('select')&&!runtime.querySelector('.draft-run-fields').disabled);
          runtime.scrollIntoView({block:'start'});return true;`);
        await Bun.write(join(output, `settings-${theme}-${width}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
        await frame('doc.querySelector(".unified-editor-runtime").open=false;await win.ui.inputEditor.continuePortable();return true;');
      }
      console.log(`PASS ${scope} ${theme}/${width}: ${layout.shellHeight}px dock, 32px tools/save/menu rows + 44px mobile submission, preserved manual height, on-demand shortcuts, same DOM/state/ID, autosave, hierarchy, Agent help, touch targets, no overflow`);
    }
    if (scope === 'history') {
      assert(await frame(`
        await win.ui.inputEditor.leave();await win.workspace.collapseComposer();
        const view=win.ui.view,hash=win.location.hash;
        const feature=win.emissionFeature.renderEmissionAutomation({ownsPage:()=>win.ui.view===view});
        doc.querySelector('#detail').replaceChildren(feature);await feature.ready;
        const embedded=feature.querySelector('.inputs-page');await embedded.state.openItem({kind:'draft',id:1});
        const local=win.ui.view===view&&win.location.hash===hash&&!doc.querySelector('.unified-editor-conditions').open
          &&!doc.querySelector('#composer-condition-summary').hidden&&doc.querySelector('#composer-condition-summary').textContent==='条件 1'
          &&doc.querySelector('#draft-commit').textContent==='按条件提交';
        const body=doc.querySelector('#input');body.value+=' embedded';body.dispatchEvent(new win.Event('input'));
        await feature.setSubpage('history');
        const suspended=!win.ui.inputEditor.inDetail&&win.rows.find(row=>row.kind==='draft'&&row.id===1).content===body.value;
        await feature.setSubpage('settings');await until(()=>win.ui.inputEditor.inDetail&&win.workspace.currentEdit().saved?.id===1);
        await win.ui.inputEditor.submit();
        const receipt=win.ui.view===view&&win.location.hash===hash&&!win.ui.inputEditor.inDetail&&Boolean(embedded.querySelector('.input-original'));
        feature.dispose();await win.ui.restoreInputContext({hash:'#inputs',scroll:0});return local&&suspended&&receipt;
      `), 'embedded conditional editor must share state and keep its receipt/routing local');
      console.log('PASS embedded conditional editor shares the component, defaults conditions closed, and keeps authorization receipt local');
      assert(await frame(`
        await win.ui.inputEditor.leave();await doc.querySelector('#drafts-open').onclick();await until(()=>win.ui.view.id==='drafts'&&doc.querySelector('.inputs-browse')&&!doc.querySelector('.inputs-browse').hidden);
        await win.ui.draftsPage.pending;
        const modes=[...doc.querySelectorAll('.input-mode-toggle')],mode=value=>modes.find(node=>node.dataset.mode===value);
        const selected=()=>modes.filter(node=>node.getAttribute('aria-pressed')==='true').map(node=>node.dataset.mode).join(',');
        const check=(value,message)=>{if(!value)throw Error(message);};
        check(modes.length===3&&selected()==='order','draft default must remain order only');
        const draftRow=doc.querySelector('[data-input="draft:1"] .input-row');
        check(draftRow.firstElementChild.classList.contains('input-preview')&&!draftRow.getAttribute('aria-label').includes('Worker 状态'),'draft content first; draft authorization is not Worker execution');
        const unknown=doc.querySelector('[data-input="draft:2"] .input-summary .badge');
        check(unknown.scrollHeight<=unknown.clientHeight+1&&unknown.textContent.includes('待核验'),'unknown authorization must remain readable');
        check(doc.querySelector('.search-field-scope').textContent.includes('全部未发送草稿'),'search must state full project draft scope');
        await mode('append').onclick();check(selected()==='order,append'&&doc.querySelector('[data-input="draft:3"]'),'independent draft multiselect');
        const search=doc.querySelector('.search-field-input'),status=doc.querySelector('[aria-label="暂存状态"]');
        search.value='追加';search.dispatchEvent(new win.Event('input'));const reads=win.reads.length;
        search.dispatchEvent(new win.CompositionEvent('compositionstart'));
        search.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
        check(win.reads.length===reads,'IME confirmation must not search');search.dispatchEvent(new win.CompositionEvent('compositionend'));
        await mode('management').onclick();status.value='draft';await status.onchange();
        let query=new URLSearchParams(win.reads.at(-1));check(query.get('q')===''&&query.get('status')==='draft'&&selected()==='order,append,management','filters must not submit pending search');
        search.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await win.ui.draftsPage.pending;
        check(doc.querySelectorAll('.input-record').length===1&&doc.querySelector('[data-input="draft:3"]'),'Enter must search selected categories');
        await doc.querySelector('.search-field-clear').onclick();query=new URLSearchParams(win.reads.at(-1));
        check(query.get('q')===''&&query.get('status')==='draft'&&JSON.parse(query.get('modes')).length===3&&doc.querySelector('[data-input="draft:4"]'),'clear must keep other filters');
        for(const node of modes)await node.onclick();
        check(selected()===''&&!doc.querySelector('.input-record')&&doc.querySelector('.inputs-feedback').textContent.includes('未勾选暂存分类')&&modes.every(node=>node.classList.contains('is-off')),'empty draft selection must stay empty');
        await mode('order').onclick();await win.inputPages.openInputs({item:{kind:'draft',id:3}});
        check(selected()==='order,append'&&win.workspace.currentEdit().saved?.id===3,'deep link must add category without clearing original selection');
        const body=doc.querySelector('#input');body.value+=' · 分类往返修改';body.dispatchEvent(new win.Event('input'));
        await win.ui.draftsPage.showList();
        check(selected()==='order,append'&&win.rows.find(row=>row.kind==='draft'&&row.id===3).content===body.value,'detail return must preserve selection and save body');
        await mode('management').onclick();check(selected()==='order,append,management','all draft categories must remain independently selected');
        const rects=modes.map(node=>node.getBoundingClientRect());
        check(rects.every(box=>box.left>=0&&box.right<=win.innerWidth+1&&box.height===32)&&modes.every(node=>node.dataset.help),'draft toggles must fit narrow layout and explain multiselect');
        await mode('order').onclick();await mode('append').onclick();await mode('management').onclick();
        await win.inputPages.openInputs({item:{kind:'draft',id:4}});
        check(selected()==='management','deep link must reveal its category from empty selection');
        await until(()=>win.ui.inputEditor.inDetail&&win.workspace.currentEdit().saved?.id===4&&!doc.querySelector('#draft-commit').disabled);
        const management=!doc.querySelector('#input-buffer').hidden&&doc.querySelector('.unified-editor-condition-section').hidden&&doc.querySelector('.unified-editor-conditions').children.length===0;
        doc.querySelector('#input').value='管理修改';doc.querySelector('#input').dispatchEvent(new win.Event('input'));
        await win.ui.inputEditor.submit();await until(()=>!win.ui.inputEditor.inDetail&&doc.querySelector('.input-original'));
        const exact=win.calls.findLast(call=>call.method==='management.submit').params;
        return management&&exact.draft_id===4&&exact.expected_revision===2&&!('instruction' in exact)&&!doc.querySelector('.input-detail textarea');
      `), 'management draft exact-version submission/receipt');
      console.log('PASS draft multiselect/default/all/empty, pending search/IME/clear, additive deep links, detail autosave/return, narrow controls; management exact-version authorization → read-only receipt');
    } else {
      assert(await frame(`
        for(const [mode,task] of [['order',null],['append',win.worker],['management',win.valet]]){
          await win.workspace.selectComposerMode(mode,task);const box=doc.querySelector('#input');box.value='模式验证 '+mode;box.dispatchEvent(new win.Event('input'));
          await win.ui.inputEditor.save();const style=win.getComputedStyle(box),expected=mode==='append'?'dashed':mode==='management'?'double':'solid';
          if(style.borderTopStyle!==expected||doc.querySelector('#input-buffer').hidden)throw Error('portable mode appearance/save '+mode);
          await win.ui.inputEditor.detail();
          if(doc.querySelector('#input')!==box||win.getComputedStyle(box).borderTopStyle!==expected)throw Error('detail mode appearance '+mode);
          await win.ui.inputEditor.continuePortable();
        }
        return true;
      `), 'three modes retain distinct borders and project save');
      if (scope === 'mobile') assert(await frame(`
        await win.workspace.selectComposerMode('order');const box=doc.querySelector('#input');box.focus();win.keyboard(420);
        await new Promise(resolve=>setTimeout(resolve,100));const rect=box.getBoundingClientRect();
        const fit=rect.top>=0&&rect.bottom<=420+1;win.keyboard(win.innerHeight);return fit;
      `), 'simulated mobile keyboard hides body');
      console.log('PASS portable/detail share solid order, dashed append and double management borders; project management saving remains available');
    }
    if (scope === 'history') {
      assert(await frame(`
        await win.workspace.selectComposerMode('order');await win.workspace.newComposerEntry();const body=doc.querySelector('#input');
        body.value='浏览器管家条件挂载';body.dispatchEvent(new win.Event('input'));await win.ui.inputEditor.detail();
        const section=doc.querySelector('.draft-condition-valet'),text=section.querySelector('textarea'),send=section.querySelector('button');
        text.value='等 W20 安全收尾后再提交';text.dispatchEvent(new win.Event('input'));const count=win.calls.length;
        send.click();await until(()=>send.disabled&&section.querySelector('a'));
        const request=win.calls.slice(count).find(call=>call.method==='management.submit'),saved=win.workspace.currentEdit().saved;
        const exact=request.params.instruction.includes('"draft_id":'+saved.id+',"revision":'+saved.revision)&&request.params.instruction.includes(text.value);
        const safe=win.calls.slice(count).every(call=>call.method!=='input.emit')&&!saved.dispatch&&body.value==='浏览器管家条件挂载';
        const receipt=[...section.querySelectorAll('a')].map(link=>link.getAttribute('href'));
        await win.ui.inputEditor.continuePortable();await win.ui.inputEditor.detail();
        const retained=doc.querySelector('.draft-condition-valet textarea').value===text.value&&doc.querySelector('.draft-condition-valet button').disabled;
        await win.ui.inputEditor.continuePortable();return exact&&safe&&retained&&receipt.includes('#worker-9')&&receipt.includes('#input-draft-'+saved.id);
      `), 'natural condition entrance saves exact draft, creates ordinary Valet, retains state and distinguishes creation from mount');
      console.log('PASS natural condition input saves exact draft then hands off once, preserves shared state, and shows V/draft links without claiming mount success');
      assert(await frame(`
        const check=(value,message)=>{if(!value)throw Error(message);};
        const change=(node,value,type='change')=>{node.value=value;node.dispatchEvent(new win.Event(type,{bubbles:true}));};
        const openSettings=async()=>{const section=doc.querySelector('.unified-editor-runtime');section.open=true;
          await until(()=>section.querySelector('select')&&!section.querySelector('.draft-run-fields').disabled);return section;};
        await win.workspace.selectComposerMode('order');await win.workspace.newComposerEntry();
        change(doc.querySelector('#input'),'就地运行设置验证','input');await win.ui.inputEditor.detail();
        let runtime=await openSettings();
        const backend=runtime.querySelector('[data-retry-field="agent"]');change(backend,'codex');
        runtime.querySelector('.retry-advanced').open=true;
        const env=runtime.querySelector('[data-retry-field="env"]'),prompt=runtime.querySelector('[data-retry-field="default-prompt"]');
        change(env,'BROKEN','input');check(Boolean(win.ui.inputEditor.profileIssue)&&doc.querySelector('#draft-commit').disabled,'invalid inline configuration must block authorization');
        const before=win.calls.filter(call=>call.method==='input.emit').length;
        check(await win.ui.inputEditor.leave()===false&&env.value==='BROKEN','invalid fields must survive blocked navigation');
        await win.ui.inputEditor.save();check(win.workspace.currentEdit().saved.content==='就地运行设置验证','invalid settings must not block body save');
        change(env,'INLINE_TEST=kept','input');change(prompt,'自定义 Worker 规则','input');
        const submitting=win.ui.inputEditor.submit();await until(()=>!doc.querySelector('#modal').hidden);
        check(doc.querySelector('.modal-title').textContent.includes('自定义 Prompt'),'inline custom Prompt still needs risk confirmation');
        check(doc.querySelector('.modal-confirm').getBoundingClientRect().height===44&&doc.querySelector('.modal-cancel').getBoundingClientRect().height===32,'mobile final authorization must remain 44px while cancel is 32px');
        doc.querySelector('.modal-cancel').click();await submitting;
        check(win.calls.filter(call=>call.method==='input.emit').length===before&&prompt.value==='自定义 Worker 规则','cancelled Prompt confirmation must not authorize or discard edits');
        runtime.querySelector('.draft-run-settings > button').click();
        await until(()=>runtime.querySelector('[data-retry-field="config_mode"]')&&!runtime.querySelector('.draft-run-fields').disabled);
        check(!win.workspace.currentEdit().profile,'restore default must clear override');
        change(runtime.querySelector('[data-retry-field="config_mode"]'),'pi');
        check(win.workspace.currentEdit().profile.config_mode==='pi','inline change must apply without a second button');
        await win.ui.inputEditor.continuePortable();await win.ui.inputEditor.detail();
        check(runtime===doc.querySelector('.unified-editor-runtime')&&runtime.querySelector('[data-retry-field="config_mode"]').value==='pi','host movement must preserve the same settings form');
        await win.ui.inputEditor.submit();
        check(win.calls.findLast(call=>call.method==='input.emit').params.profile.config_mode==='pi'&&!win.workspace.currentEdit().profile,'submission must carry override once and release consumed settings');
        await win.workspace.selectComposerMode('management');await win.workspace.newComposerEntry();
        change(doc.querySelector('#input'),'新建管理运行配置','input');await win.ui.inputEditor.detail();runtime=await openSettings();
        change(runtime.querySelector('[aria-label="Valet 配置模式"]'),'pi');await win.ui.inputEditor.submit();
        check(win.calls.findLast(call=>call.method==='management.submit').params.profile.config_mode==='pi','new management must submit its inline configuration');
        await win.workspace.selectComposerMode('order');await win.workspace.newComposerEntry();
        change(doc.querySelector('#input'),'删除操作行验证','input');await win.ui.inputEditor.detail();
        const saved=win.workspace.currentEdit().saved,remove=doc.querySelector('#composer-remove-draft');
        check(remove.closest('.composer-actions')&&!remove.hidden,'delete must be directly in the action row');
        remove.click();await until(()=>!doc.querySelector('#modal').hidden);doc.querySelector('.modal-cancel').click();
        await until(()=>!win.ui.inputEditor.busy);check(win.rows.some(row=>row.id===saved.id),'cancel delete must preserve draft');
        remove.click();await until(()=>!doc.querySelector('#modal').hidden);doc.querySelector('.modal-confirm').click();
        await until(()=>!win.ui.inputEditor.busy&&!win.workspace.currentEdit().saved);
        check(win.calls.findLast(call=>call.method==='draft.remove').params.expected_revision===saved.revision&&!win.rows.some(row=>row.id===saved.id),'delete must use confirmed exact revision');
        return true;
      `), 'inline configuration edit/reset/validation/authorization and visible confirmed deletion');
      console.log('PASS inline work/management settings, invalid edit retention, Prompt confirmation cancellation, default reset, host continuity, exact submission, consumed-state release and action-row deletion');
      await frame(`await win.workspace.selectComposerMode('order');await win.workspace.newComposerEntry();win.calls=[];win.nativeKeyEvents=[];doc.querySelector('#input').focus();return true;`);
      await nativeInput('native-first', '\uE007');
      assert(await frame(`return doc.querySelector('#input').value==='native-first\\n'&&win.calls.length===0;`), 'native Enter must insert a newline without any draft/submission request');
      await nativeInput(undefined, 's', true);
      assert(await frame(`await until(()=>win.workspace.currentEdit().saved&&!win.ui.inputEditor.busy);
        return doc.querySelector('#input').value==='native-first\\n'&&win.calls.length===1&&win.calls[0].method==='draft.add';`), 'native Ctrl+S must save once and retain the body');
      await nativeInput('dirty-end', '\uE007', true);
      assert(await frame(`await until(()=>win.calls.some(call=>call.method==='input.emit')&&!win.ui.inputEditor.busy);
        const add=win.calls[0],update=win.calls[1],emit=win.calls[2],row=win.rows.find(row=>row.kind==='draft'&&row.id===emit?.params.draft_id);
        const trusted=win.nativeKeyEvents.filter(event=>event.trusted);
        return win.calls.length===3&&add.method==='draft.add'&&update.method==='draft.update'&&emit.method==='input.emit'
          &&update.params.id===row.id&&emit.params.expected_revision===row.revision&&row.revision===2
          &&row.content==='native-first\\ndirty-end'&&doc.querySelector('#input').value===''
          &&doc.querySelector('#input-form').hidden&&doc.querySelector('#composer-shell').getBoundingClientRect().height===0
          &&doc.querySelector('#composer-launcher').getAttribute('aria-expanded')==='false'&&doc.activeElement!==doc.querySelector('#input')
          &&trusted.some(event=>event.key==='Enter'&&!event.ctrl)&&trusted.some(event=>event.key==='s'&&event.ctrl)&&trusted.some(event=>event.key==='Enter'&&event.ctrl);`), 'native Ctrl+Enter must save dirty text then authorize its exact version once');
      console.log('PASS WebDriver native trusted Enter → newline/no request; Ctrl+S → one retained draft; dirty Ctrl+Enter → update then one exact-version authorization');
      assert(await frame(`
        win.workspace.openComposer({focus:false});
        const receipt=doc.querySelector('.composer-receipt'),meta=doc.querySelector('#composer-meta'),count=win.calls.length;
        const compactReceipt=receipt.parentElement===meta&&receipt.textContent==='收据'&&!receipt.hidden&&receipt.getAttribute('data-help').includes('不是当前编辑');
        receipt.click();await until(()=>doc.querySelector('.input-original')&&!win.ui.inputEditor.inDetail);
        return compactReceipt&&win.calls.length===count&&Boolean(doc.querySelector('.input-original'));
      `), 'compact receipt opens the last submitted draft without submitting again');
      console.log('PASS compact last-submission receipt shares metadata and opens read-only without another write');
    }
    const errors = await frame('return win.errors;'); assert(!errors.length, `browser errors: ${JSON.stringify(errors)}`);
    if (scope === 'history') {
      const recovery = await frame(`
        await win.workspace.selectComposerMode('order');await win.workspace.newComposerEntry();
        const box=doc.querySelector('#input');box.value='刷新恢复的项目草稿';box.dispatchEvent(new win.Event('input'));
        await win.ui.inputEditor.save();const saved=win.workspace.currentEdit().saved;
        box.value+=' · 本地未保存修改';box.dispatchEvent(new win.Event('input'));win.workspace.rememberComposer();
        return {id:saved.id,revision:saved.revision,content:box.value};`);
      await rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0],iframe=document.querySelector('#view');iframe.addEventListener('load',()=>done(true),{once:true});iframe.contentWindow.history.replaceState(null,'','#inputs');iframe.contentWindow.location.reload();`, args: [] });
      assert(await frame(`await until(()=>win.ready&&win.ui.inputEditor);win.workspace.openComposer({focus:false});
        const entry=win.workspace.currentEdit();return entry.saved.id===${recovery.id}&&entry.saved.revision===${recovery.revision}
          &&doc.querySelector('#input').value===${JSON.stringify(recovery.content)}&&entry.branch==='main'
          &&doc.querySelector('#composer-draft-status').textContent==='有未保存修改'&&win.calls.length===0;`), 'reload must recover original draft identity/target and unsaved text without authorizing');
      console.log('PASS real browser reload retains saved draft ID/version/target and unsaved text without any write or authorization');
    }
  } finally {
    if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
    driver.kill(); await driver.exited; server.stop(true); await rm(temp, { recursive: true, force: true });
  }
}
if (import.meta.main) await runInputBrowserCheck({ scope: 'history', output: process.argv[2] });
