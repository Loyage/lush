// Real Firefox layout regression with a static fixture; no user daemon, project writes or model calls.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { startWeb } from '../../src/ui/web/server.js';
// The module-only scope reuses this fixture for disclosure work without unrelated conversation/copy checks.
const modulesOnly = process.argv.includes('--modules-only');
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const html = (await Bun.file(join(assets, 'index.html')).text()).replace('<script type="module" src="/app.js"></script>', '');
const fixture = html.replace('</body>', `<script type="module">
import { renderDetail } from '/render-detail.js';
import { renderConversation } from '/render-conversation.js';
import { OPERATION_CATEGORIES } from '/render-agent-operation.js';
window.operationCategories=OPERATION_CATEGORIES;
import { revealDetailPreview } from '/detail-preview.js';
import { ui } from '/state.js';
import { noticePanel } from '/render-notices.js';
import { activateDetailView, paintCollapsed } from '/sidebar-ui.js';
window.paintCollapsed=paintCollapsed;window.activateDetailView=activateDetailView;window.ui=ui;
import { block, el } from '/dom.js';
import { enhanceModule, observeModules, disposeModules, revealModule } from '/shared-module.js';
import { enhanceVersionModule } from '/version-module.js';
window.enhanceVersions=enhanceVersionModule;
const at='2026-10-08T10:00:00Z';
const long=Array.from({length:50},(_,i)=>'段落 '+i+'：这是一段较长的正文，预览应保留格式，后续内容仍然完整存在。').join('\\n\\n');
window.task={id:7,worker_number:'W7',role:'agent',task_kind:'order',status:'waiting',calls:1,
  goal:long,goal_input_source:{kind:'user'},result:long+'\\n\\n最后一段结果',created_at:at,updated_at:at,
  workspace:'/home/developer/projects/'+('long-workspace-name/'.repeat(12))+'worker-7',
  progress:{version:1,items:Array.from({length:30},(_,i)=>({key:'step'+i,label:'步骤 '+i+' '+('较长的阶段名称 '.repeat(5)),status:i<5?'completed':'pending'}))},
  children:Array.from({length:20},(_,i)=>({id:100+i,worker_number:'W7-'+(i+1),role:'agent',status:'waiting',goal:'子 Worker '+i,updated_at:at})),
  notices:[{id:71,kind:'questionnaire',status:'answered',title:'历史决定',body:JSON.stringify({version:1,body:'保留决定',questions:[{header:'范围',question:'选择范围？',options:[{label:'方案一',description:'当前方案'},{label:'方案二',description:'候选方案'}]}]}),answer:JSON.stringify({answers:[{selected:[0],labels:['方案一'],custom:''}]})}],
  messages:Array.from({length:20},(_,i)=>({id:i+1,sender_id:null,body:'消息 '+i+'\\n\\n'+long,created_at:at,
    input_source:i===19?{kind:'unknown'}:i===0?{kind:'valet',worker_id:42,worker_number:'V42'}:{kind:'user'}}))};
window.fixtureHistory={events:[...Array.from({length:50},(_,i)=>({id:i+1,type:'invocation.completed',created_at:at,data:{run_id:i+1,result:'此前结果 '+i+'\\n'+long}})),
  {id:80,type:'message',created_at:'2026-10-08T10:01:00Z',data:{sender:null,body:'短追加输入',input_source:{kind:'user'}},input_delivery:{status:'pending',at:null}},
  {id:81,type:'message',created_at:'2026-10-08T10:02:00Z',data:{sender:100,body:'来自子 Worker 的通信',message_id:81}},
  {id:82,type:'invocation.started',created_at:'2026-10-08T10:03:00Z',data:{call:2}},
  {id:83,type:'merge.failed',created_at:'2026-10-08T10:04:00Z',data:{error:'合并失败诊断',commit:'abcdef',hooks:{credential:'PRIVATE-TIMELINE'}}},
  {id:84,type:'progress.completed',created_at:'2026-10-08T10:05:00Z',data:{key:'inspect'}}]};
ui.selected=7; ui.view={id:'task',key:'7'};
window.paint=(progressive=null)=>renderDetail(window.task,window.fixtureHistory,null,null,null,progressive);
window.reveal=revealDetailPreview;
window.makeSharedModules=()=>{
  const panel=document.querySelector('#detail');disposeModules(panel);panel.dataset.view='settings';
  const wrapper=el('div'),reading=block('普通阅读模块'),form=block('表单与待答问卷');
  const prose=el('div');prose.innerHTML=Array.from({length:80},(_,i)=>'<p>阅读段落 '+i+' '+('共用预览与页面滚动。'.repeat(8))+'</p>').join('');
  reading.append(prose);const editor=el('textarea');editor.value='未保存草稿';form.append(editor,el('div'));
  form.lastElementChild.style.height='1600px';wrapper.append(reading,form);panel.replaceChildren(wrapper);
  window.sharedStates=new Map();window.sharedReading=enhanceModule(reading,{key:'reading',states:window.sharedStates,summary:'读取失败诊断保留在正文外'});
  window.sharedForm=enhanceModule(form,{key:'form',mode:'fold',states:window.sharedStates,summary:'等待回答 · 副作用未知'});
  window.sharedEditor=editor;window.sharedReveal=revealModule;window.sharedDispose=observeModules(panel,[window.sharedReading,window.sharedForm]);
};
window.makeNoticeModule=(kind,scope)=>{
  // Freeze page-entry transforms before comparing sticky geometry across successive frames.
  document.documentElement.dataset.reducedMotion='true';
  disposeModules(document.querySelector('#detail'));ui.noticeModuleStates=new Map();
  // Settled records now open in the independent detail page, never inside the list.
  const panel=document.querySelector('#detail');
  activateDetailView({view:scope==='records'?'notice':'task',push:false});
  const notice={id:778,task_id:7,task_worker_number:'W7',kind,status:kind==='info'?'sent':'answered',answer_source:'user',
    created_at:at,title:'已回答决策的长标题与连续标识 '+('LongDecisionTitle'.repeat(12)),
    body:kind==='info'?long:window.task.notices[0].body,answer:window.task.notices[0].answer};
  const section=noticePanel(notice),host=scope==='records'?el('div',undefined,'notice-record-detail'):panel;
  if(scope==='records'){host.id='notice-record-detail';const page=el('div',undefined,'notice-detail-page');page.append(host);panel.replaceChildren(page);}
  host.replaceChildren(section);section.querySelector('.module-content').append(el('p',long));
  const tail=el('div');tail.style.height='1400px';host.append(tail);
  panel.scrollTop=0;window.scrollTo(0,0);window.noticeFixture={panel,section,head:section.querySelector('.notice-head'),
    listHead:null};
};
window.makeCopyFixture=()=>{
  disposeModules(document.querySelector('#detail'));const fence=String.fromCharCode(96).repeat(3);
  window.copySource='# 原始输入\\n\\n'+fence+'shell\\n  echo "<raw>"  \\n\\nprintf W313\\n'+fence+'\\n';
  window.copyOutput='**原始回复**\\n\\n'+fence+'\\n输出代码\\n'+fence;
  window.copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copied.push(text)}});
  const root=renderConversation({id:99,worker_number:'W313',goal:window.copySource,result:window.copyOutput});
  const panel=document.querySelector('#detail');panel.replaceChildren(root);
  panel.scrollTop=0;window.scrollTo(0,0);
  // Match the real detail page: wrapped toolbars must feed the sticky message-header offset.
  const view=enhanceModule(root,{key:'copy',states:new Map([['copy',true]])});
  observeModules(panel,[view]);
};
window.paint(); window.ready=true;
</script></body>`);
const temp = await mkdtemp(join(tmpdir(), 'lush-w198-preview-'));
const username = 'Preview浏览器账号', password = randomBytes(24).toString('base64url');
let authServer;
// Keep the layout fixture controlled, but put every fixture/asset read behind real Host auth.
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  if (!authServer) return new Response('fixture initializing', { status: 503 });
  const url = new URL(req.url), path = url.pathname;
  const headers = new Headers(req.headers); headers.delete('host');
  const upstream = `http://127.0.0.1:${authServer.port}`;
  if (['/login', '/logout', '/api/host/session'].includes(path)) return fetch(upstream + path + url.search, {
    method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(), redirect: 'manual',
  });
  const gate = await fetch(upstream + '/api/host', { headers, redirect: 'manual' });
  if (gate.status === 401) return path.startsWith('/api/') ? gate : new Response(null, {
    status: 303, headers: { Location: `/login?next=${encodeURIComponent(path + url.search)}` },
  });
  if (!gate.ok) return gate;
  if (path === '/host') return new Response('<!doctype html><iframe id="fixture" src="/" style="border:0;width:1440px;height:900px"></iframe>', { headers: { 'Content-Type': 'text/html' } });
  if (path === '/') return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
  if (path === '/administrator/project-protocol.js') return new Response(Bun.file(new URL('../../src/administrator/project-protocol.js', import.meta.url)));
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.slice(1))));
  return new Response('not found', { status: 404 });
} });
const env = { HOME: temp, LUSH_GLOBAL_CONFIG: temp };
// New login configuration must keep the real authentication gate on loopback.
await writeFile(join(temp, 'web.json'), JSON.stringify({ version: 2, username, password,
  origin: `http://127.0.0.1:${server.port}` }), { mode: 0o600 });
authServer = startWeb({ home: temp, env }, 0, { env,
  projectHost: { launcher: false, status: async () => ({ mode: 'bound', projects: [] }) } });
if (authServer.hostname !== '127.0.0.1') throw new Error('v2 preview authentication must stay loopback');
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const log = join(temp, 'geckodriver.log');
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log),
});
let session, passed = false;
async function rpc(path, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('WebDriver timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text);
  if (response.status >= 400) throw new Error(JSON.stringify(data));
  return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = script => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0];let n=0;const check=()=>(${script})?done(true):++n>100?done(false):setTimeout(check,30);check();`, args: [] });
const assert = (value, message) => { if (!value) throw new Error(message); };
async function click(selector) {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function viewport(width, height) {
  await rpc(`/session/${session}/frame`, { id: null });
  await execute(`const frame=document.querySelector('#fixture');frame.style.width='${width}px';frame.style.height='${height}px';`);
  const frame = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#fixture' });
  await rpc(`/session/${session}/frame`, { id: frame });
  assert(await execute(`return innerWidth===${width}&&innerHeight===${height};`), 'fixture viewport mismatch');
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver startup failed');
    await Bun.sleep(100);
  }
  assert(ready, 'geckodriver timeout');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox',
    'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  const origin = `http://127.0.0.1:${server.port}`;
  assert((await fetch(origin + '/host', { redirect: 'manual' })).status === 303, 'preview must require login');
  await rpc(`/session/${session}/url`, { url: origin + '/host' });
  assert(await wait(`document.querySelector('form[action="/login"]')`), 'preview login form missing');
  await execute(`document.querySelector('[name="username"]').value=${JSON.stringify(username)};
    document.querySelector('[name="password"]').value=${JSON.stringify(password)};`);
  await click('form[action="/login"] button[type="submit"]');
  assert(await wait(`document.querySelector('#fixture') && location.pathname==='/host'`), 'preview login did not restore fixture');
  await viewport(1440, 900);
  assert(await wait('window.ready'), 'fixture failed to load');
  assert(await execute(`const card=document.createElement('div');card.className='task-graph-card task-graph-running';
    card.innerHTML='<div class="graph-task-progress is-running"><span class="graph-task-progress-track"></span></div><span class="task-graph-usage is-live">运行中</span>';
    document.body.append(card);const progress=card.firstChild,usage=card.lastChild;
    const result=getComputedStyle(card).animationName==='none'&&getComputedStyle(progress).animationName==='none'&&
      getComputedStyle(usage).animationName==='none'&&getComputedStyle(progress.firstChild,'::after').animationName==='graph-progress-sweep';
    card.remove();return result;`),'one progress cue must replace repeated card/progress/usage pulses');
  // One representative short fold exercises the real WAAPI path; long reading modules
  // below deliberately keep immediate geometry rather than stretching several screens.
  for (const [width,height] of [[1440,900],[320,560]]) {
    await viewport(width,height);
    await execute(`window.makeSharedModules();const f=window.sharedForm;
      f.content.lastElementChild.style.height='100px';f.section.scrollIntoView({block:'center'});
      window.sharedEditor.focus();window.sharedEditor.setSelectionRange(1,4);
      window.motionNatural=f.body.getBoundingClientRect().height;f.toggle.click();`);
    assert(await execute(`const f=window.sharedForm,a=f.body.getAnimations()[0];
      return f.body.hidden&&f.toggle.getAttribute('aria-expanded')==='false'&&document.activeElement===f.toggle&&
        a?.effect.getTiming().duration===160&&f.body.inert&&f.body.getAttribute('aria-hidden')==='true';`),'short collapse must animate while focus/aria already reflect the target');
    assert(await rpc(`/session/${session}/execute/async`,{script:`const done=arguments[0],f=window.sharedForm;
      const a=f.body.getAnimations()[0];a.currentTime=80;
      requestAnimationFrame(()=>{const before=f.body.getBoundingClientRect().height;f.toggle.click();
        const next=f.body.getAnimations()[0];done(before>0&&before<window.motionNatural&&
          Math.abs(parseFloat(next.effect.getKeyframes()[0].height)-before)<1&&
          next.effect.getTiming().duration===200&&!f.body.hidden&&!f.body.inert);});`,args:[]}), 'reverse must start from the visible height without queuing');
    assert(await wait(`!window.sharedForm.body.hasAttribute('data-disclosure-motion')`),'opening never cleaned up');
    assert(await execute(`const f=window.sharedForm;return Math.abs(f.body.getBoundingClientRect().height-window.motionNatural)<1&&
      !f.body.hasAttribute('aria-hidden')&&window.sharedEditor.value==='未保存草稿'&&window.sharedEditor.selectionStart===1&&window.sharedEditor.selectionEnd===4;`),'opening lost natural layout, draft or selection');
    await execute(`window.sharedForm.toggle.click();`);
    assert(await wait(`!window.sharedForm.body.hasAttribute('data-disclosure-motion')`),'collapse never cleaned up');
    assert(await execute(`return window.sharedForm.body.hidden&&window.sharedForm.body.getBoundingClientRect().height===0;`),'collapse must end at genuinely hidden content');
    await execute(`window.sharedForm.toggle.click();window.sharedReveal(window.sharedEditor);window.sharedEditor.focus();`);
    assert(await execute(`return !window.sharedForm.body.getAnimations().length&&document.activeElement===window.sharedEditor;`),'reference/focus reveal must settle geometry immediately');
    await execute(`window.sharedForm.toggle.click();document.documentElement.dataset.reducedMotion='true';`);
    assert(await wait(`!window.sharedForm.body.getAnimations().length`),'application reduced motion must cancel in-flight animation');
    assert(await execute(`window.sharedForm.toggle.click();return !window.sharedForm.body.getAnimations().length&&!window.sharedForm.body.hidden;`),'application reduced motion must skip new animations');
    await execute(`delete document.documentElement.dataset.reducedMotion;window.sharedForm.toggle.click();window.sharedDispose();`);
    assert(await execute(`return !window.sharedForm.body.getAnimations().length&&!window.sharedForm.body.hasAttribute('data-disclosure-motion');`),'page disposal must release visual state');
    await execute(`window.sharedForm.toggle.click();window.sharedForm.section.remove();`);
    assert(await wait(`!window.sharedForm.body.getAnimations().length&&!window.sharedForm.body.hasAttribute('data-disclosure-motion')`),'detaching a module must cancel motion');
    // Resource groups use the same helper, but preference repaint/initialization is instant.
    await execute(`const root=document.querySelector('#side-tasks'),body=root.querySelector('.side-body'),head=root.querySelector('.side-head');
      document.querySelector('#resource-panels').hidden=false;document.querySelector('#detail').hidden=true;root.hidden=false;
      body.replaceChildren(Object.assign(document.createElement('textarea'),{value:'分组草稿'}));body.firstChild.style.height='100px';
      window.ui.sideNodes.set('tasks',root);window.ui.sideHeads.set('tasks',head);window.ui.collapsed=new Set();window.paintCollapsed();
      window.ui.collapsed.add('tasks');window.paintCollapsed(true);window.sideMotion={root,body,head};`);
    assert(await execute(`return window.sideMotion.body.getAnimations().length===1&&window.sideMotion.head.getAttribute('aria-expanded')==='false';`),'resource group did not start closing');
    await execute(`window.ui.collapsed.clear();window.paintCollapsed(true);`);
    assert(await wait(`!window.sideMotion.body.getAnimations().length`),'resource group reversal never settled');
    assert(await execute(`const {body,head}=window.sideMotion;return body.getBoundingClientRect().height>0&&head.getAttribute('aria-expanded')==='true'&&body.firstChild.value==='分组草稿';`),'resource group lost final state/draft');
    await execute(`window.ui.collapsed.add('tasks');window.paintCollapsed(true);window.paintCollapsed();`);
    assert(await execute(`return !window.sideMotion.body.getAnimations().length&&window.sideMotion.body.getBoundingClientRect().height===0;`),'preference repaint must settle without replaying');
    await execute(`window.ui.collapsed.clear();window.paintCollapsed(true);window.activateDetailView({view:'task',key:'motion-exit-${width}',push:false});
      document.querySelector('#resource-panels').hidden=true;document.querySelector('#detail').hidden=false;window.ui.sideNodes.clear();window.ui.sideHeads.clear();`);
    assert(await execute(`return !window.sideMotion.body.getAnimations().length;`),'navigation must cancel resource motion');
    console.log('PASS reversible short folds/resource groups, focus, draft/selection, reduced motion and disposal',width,height);
  }
  await rpc(`/session/${session}/frame`, { id: null });
  await rpc(`/session/${session}/refresh`, {});
  await viewport(1440,900);
  assert(await wait('window.ready'), 'fixture failed to reset after motion checks');
  if (!modulesOnly) {
  for (const [width, height] of [[1440,900],[390,700],[320,560]]) for (const theme of ['light','dark']) {
    await viewport(width, height);
    await execute(`document.documentElement.dataset.theme='${theme}';window.paint();`);
    assert(await wait(`document.querySelector('.conversation-panel').classList.contains('detail-preview-long')`), 'long goal not measured');
    assert(await execute(`return (async()=>{const root=document.querySelector('.conversation-panel'),timeline=document.querySelector('.worker-timeline-panel'),filters=[...root.querySelectorAll('.conversation-filter')];
      const expected=[['input',true],['output',true],['decision',true],...window.operationCategories.map(([key,,enabled])=>[key,enabled]),['unknown',false]];
      if(filters.length!==expected.length||filters.some((n,i)=>n.dataset.conversationFilter!==expected[i][0]||n.getAttribute('aria-pressed')!==String(expected[i][1]))||root.querySelector('[data-conversation-filter="lifecycle"]')||root.textContent.includes('来自子 Worker 的通信'))throw new Error('input/output boundaries');
      if(root.querySelector('.conversation-operation')||window.operationCategories.some(([key])=>root.querySelector('[data-conversation-filter="'+key+'"]').getAttribute('aria-pressed')!=='false'))throw new Error('Agent operation categories must be hidden by default');
      root.querySelector('[data-conversation-filter="progress"]').click();
      if(!root.querySelector('[data-conversation-key="operation:84"]')||root.querySelector('.conversation-operation.conversation-long')||document.querySelector('.progress-history-panel'))throw new Error('Agent operations must share input/output without restoring the retired plan history');
      await Promise.resolve();root.querySelector('[data-conversation-filter="progress"]').click();
      if(root.querySelector('[data-conversation-key="operation:84"]')||root.querySelector('[data-conversation-filter="progress"]').getAttribute('aria-pressed')!=='false')throw new Error('deselecting progress must hide its records again');
      if(!filters[0].textContent.includes('输入指令')||root.querySelector('[data-conversation-key="input:message:1"] .conversation-sender')?.textContent!=='管家 V42')throw new Error('input submitter identity');
      const advanced=timeline.querySelector('.lifecycle-advanced');if(advanced.open)throw new Error('advanced open by default');
      if(!timeline.querySelector('.lifecycle-current')||!timeline.querySelector('[data-lifecycle-key="point:83"]')?.textContent.includes('合并失败诊断'))throw new Error('lifecycle default facts');
      const failure=await timeline.revealTimelineReference({kind:'history_event',target:{task_id:7,event_id:83}});
      if(!advanced.open||!failure.expanded||failure.textContent.includes('PRIVATE-TIMELINE')||failure.querySelector('pre').hidden)throw new Error('safe evidence expansion');
      const body=failure.querySelector('pre');window.paint();if(document.querySelector('.worker-timeline-panel')!==timeline||timeline.querySelector('[data-lifecycle-record="event:83"]')!==failure||failure.querySelector('pre')!==body||!failure.expanded)throw new Error('lifecycle refresh');
      advanced.open=false;if(timeline.classList.contains('detail-preview-expanded'))timeline.querySelector('.detail-preview-toggle').click();
      if(!document.querySelector('.decision-record').open)throw new Error('decision state');return true;
    })();`), 'separate input/output and lifecycle defaults, safe evidence, exact references and retained nodes');
    assert(await execute(`const context=document.querySelector('.code-context'),card=context.querySelector('.kv'),grid=context.nextElementSibling.querySelector('.grid');
      const gap=grid.getBoundingClientRect().top-card.getBoundingClientRect().bottom;
      return Math.abs(gap-parseFloat(getComputedStyle(grid).rowGap))<=1&&card.scrollWidth<=card.clientWidth+1;`), 'workspace card must retain the grid card gap and wrap long paths');
    assert(await execute(`const titles=[...document.querySelector('#detail').children].filter(n=>n.matches('.block')).map(n=>n.matches('.worker-hooks')?'自动化':n.querySelector('h2')?.textContent).slice(0,9).join('/');
      if(titles!=='自动化/计划/输入输出/时间线/Agent/代码与提交/版本迭代/决策记录/Worker 关系')throw new Error('primary order: '+titles);return true;`), 'primary module order');
    const sizes = await execute(`return [...document.querySelectorAll('.detail-preview')].map(n=>({
      title:n.querySelector('h2').textContent,body:n.querySelector('.detail-preview-body').getBoundingClientRect().height,
      limit:n.querySelector('.detail-preview-limit').getBoundingClientRect().height,
      footer:getComputedStyle(n.querySelector('.detail-preview-footer')).display,
      footerHeight:n.querySelector('.detail-preview-footer').getBoundingClientRect().height,
      mask:getComputedStyle(n.querySelector('.detail-preview-body')).maskImage,
      controls:n.querySelectorAll('.detail-preview-toggle').length,
      headerControl:!!n.querySelector('.section-title>.module-actions>.detail-preview-toggle'),
      footerControl:!!n.querySelector('.detail-preview-footer .detail-preview-toggle'),
      natural:n.querySelector('.detail-preview-content').getBoundingClientRect().height}));`);
    assert(sizes.length >= 7, 'missing reading modules');
    assert(await execute(`return ![...document.querySelectorAll('#detail h2')].some(n=>n.textContent==='消息')&&
      document.querySelector('.conversation-panel h2').textContent==='输入输出'&&document.querySelector('.worker-timeline-panel h2').textContent==='时间线';`), 'independent message module was not integrated');
    for (const size of sizes) {
      const long = size.natural > size.limit + 120;
      assert(size.limit <= 400 && Math.abs(size.body - (long ? size.limit : size.natural)) <= 1,
        `${width}/${theme}: ${JSON.stringify(size)}`);
      assert((size.footer !== 'none') === long, 'short/long control mismatch');
      assert((size.mask.includes('linear-gradient')) === long, 'fade must appear only on clipped previews');
      assert(!long || size.mask.includes('96px'), 'fade should cover the bottom reading edge');
      assert(size.footerHeight <= 1, 'preview note should be screen-reader-only, not a visible footer');
      assert(size.controls === 1 && size.headerControl && !size.footerControl, 'module must have only a header toggle');
    }
    assert(await execute(`const root=document.querySelector('.conversation-panel');
      return root.querySelector('.conversation-filters').querySelectorAll('button').length===4+window.operationCategories.length&&
        !['只看 Agent 回复','只看我的输入','恢复默认内容'].some(text=>[...root.querySelectorAll('button')].some(n=>n.textContent===text));`), 'duplicate filter shortcuts retained');
    const previewReading = await execute(`const root=document.querySelector('.conversation-panel'),body=root.querySelector('.detail-preview-body').getBoundingClientRect(),
      prose=root.querySelector('.conversation-prose').getBoundingClientRect();
      return {body:body.toJSON(),prose:prose.toJSON(),readable:body.bottom-96-prose.top};`);
    if(width<=760)assert(previewReading.body.bottom-32-previewReading.prose.top>=48,
      `${width}/${theme}: fewer than two readable lines before preview bottom: ${JSON.stringify(previewReading)}`);
    assert(await execute(`return document.querySelector('#detail').scrollWidth<=document.querySelector('#detail').clientWidth+1;`), 'horizontal page overflow');
    assert(await execute(`const root=document.querySelector('.conversation-panel'),list=root.querySelector('.conversation-list').getBoundingClientRect();
      const input=root.querySelector('.conversation-input'),output=root.querySelector('.conversation-output');
      const short=[...root.querySelectorAll('.conversation-input')].find(n=>n.textContent.includes('短追加输入'));
      return Math.abs(input.getBoundingClientRect().right-list.right)<2&&Math.abs(output.getBoundingClientRect().left-list.left)<2&&
        input.querySelector('.conversation-avatar').textContent!==output.querySelector('.conversation-avatar').textContent&&
        short.querySelector('.conversation-expand').hidden&&short.textContent.includes('待输入')&&
        [...root.querySelectorAll('.conversation-long')].every(n=>n.querySelector('.conversation-body').getBoundingClientRect().height<=Math.min(260,innerHeight*.35)+1);`), 'bubble alignment, avatars or message previews');
    assert(await execute(`return !document.querySelector('.task-actions .detail-preview-body') &&
      !document.querySelector('.conversation-panel').classList.contains('detail-preview-expanded');`), 'actions clipped or expanded by default');
    assert(await execute(`const root=document.querySelector('.conversation-panel'),search=root.querySelector('.conversation-search'),toggle=root.querySelector('.conversation-search-toggle');
      return getComputedStyle(search).display===(${width}<=760?'none':'flex')&&
        (getComputedStyle(toggle).display!=='none')===(${width}<=760)&&toggle.getAttribute('aria-expanded')==='false'&&
        toggle.getAttribute('aria-controls')===search.id&&(${width}>760||
          [...root.querySelectorAll('.conversation-filter,.conversation-order button,.conversation-search-toggle')].every(n=>n.getBoundingClientRect().height>=44));`), 'responsive search disclosure default or touch targets');
    assert(await execute(`const root=document.querySelector('.conversation-panel');
      return !!root.querySelector('.ui-list-pagination .conversation-more')&&[...root.querySelectorAll('.conversation-filters button,.ui-list-pagination button')].every(n=>{
        const s=getComputedStyle(n),r=n.getBoundingClientRect();return n.hidden||(s.fontSize==='12px'&&s.borderRadius==='9px'&&s.fontWeight==='600'&&r.height>=(innerWidth<=760?44:32));
      });`), 'conversation shared filter/pagination sizes or wiring');
    assert(await execute(`return [...document.querySelectorAll('#detail>.ui-module>.section-title')].every(head=>{
      const group=head.querySelector('.module-actions');if(!group||!group.getClientRects().length)return true;
      const r=group.getBoundingClientRect(),h=head.getBoundingClientRect();
      return head.querySelectorAll(':scope>.module-actions').length===1&&Math.abs(r.right-h.right)<1&&r.left>=h.left&&
        [...group.children].filter(n=>n.getClientRects().length).every(n=>getComputedStyle(n).marginLeft==='0px');
    });`), 'module heading actions must share one right-aligned group, including wrapped narrow headings');
    assert(await execute(`const root=document.querySelector('.conversation-panel');return [...root.querySelectorAll('.conversation-order button,.conversation-filters button,.search-field-row>button')]
      .filter(n=>n.getClientRects().length).every(n=>n.getBoundingClientRect().height===(innerWidth<=760?44:32));`), 'standalone reading/search/filter buttons must share the compact height');
    assert(await execute(`return [...document.querySelectorAll('.module-toggle,.conversation-expand')].filter(n=>!n.hidden&&n.getClientRects().length).every(n=>{const s=getComputedStyle(n),r=n.getBoundingClientRect();return n.classList.contains('view-disclosure')&&s.fontSize==='12px'&&s.fontWeight==='400'&&s.borderTopColor==='rgba(0, 0, 0, 0)'&&r.height===(innerWidth<=760?44:28);});`), 'reading disclosures must stay lighter and more compact than toolbar buttons');
    if(width<=760){
      await execute(`const root=document.querySelector('.conversation-panel');root.querySelector('.conversation-search-toggle').click();
        window.savedSearch=root.querySelector('.conversation-search');window.savedSearch.querySelector('input').focus();`);
      assert(await execute(`const root=document.querySelector('.conversation-panel');return root.classList.contains('conversation-search-open')&&
        root.classList.contains('detail-preview-expanded')&&getComputedStyle(window.savedSearch).display==='flex';`), 'mobile search not revealed for keyboard input');
      await execute(`const input=window.savedSearch.querySelector('input');input.value='此前结果';input.dispatchEvent(new Event('input',{bubbles:true}));window.paint();`);
      assert(await execute(`const root=document.querySelector('.conversation-panel');return root.querySelector('.conversation-search')===window.savedSearch&&
        root.querySelector('.conversation-search-toggle').getAttribute('aria-expanded')==='true'&&window.savedSearch.querySelector('input').value==='此前结果'&&
        [...root.querySelectorAll('.conversation-input')].some(n=>n.textContent.includes('短追加输入'));`), 'search draft or open state lost on refresh, or draft applied implicitly');
      await execute(`window.savedSearch.querySelector('.search-field-submit').click();document.querySelector('.conversation-search-toggle').click();window.paint();`);
      assert(await execute(`const root=document.querySelector('.conversation-panel');return root.querySelector('.conversation-search-toggle').textContent==='搜索 · 已筛选'&&
        !root.classList.contains('conversation-search-open')&&root.querySelectorAll('.conversation-message').length>0&&
        [...root.querySelectorAll('.conversation-message')].every(n=>n.textContent.includes('此前结果'));`), 'collapsed search lost active condition or its visible indicator');
      await execute(`document.querySelector('.conversation-search-toggle').click();`);
      await execute(`window.savedSearch.querySelector('.search-field-clear').click();
        document.querySelector('.conversation-search-toggle').click();const root=document.querySelector('.conversation-panel');
        window.visibleCancel=root.querySelector('.conversation-cancel');window.visibleCancel.hidden=false;`);
      assert(await execute(`return !window.visibleCancel.closest('.conversation-search')&&getComputedStyle(window.visibleCancel).display!=='none'&&
        document.querySelector('#detail').scrollWidth<=document.querySelector('#detail').clientWidth+1;`), 'cancellation hidden inside collapsed search or search overflow');
      await execute(`window.visibleCancel.hidden=true;const root=document.querySelector('.conversation-panel');
        if(root.classList.contains('detail-preview-expanded'))root.querySelector('.detail-preview-toggle').click();`);
    }
    // Test actual clipping, not only the presence of an expand control, at each responsive limit.
    await execute(`window.boundaryProbe=[...document.querySelectorAll('.detail-preview')].find(n=>n.querySelector('h2').textContent==='状态');
      window.boundaryFixed=document.createElement('div');
      window.boundaryProbe.querySelector('.detail-preview-content').replaceChildren(window.boundaryFixed);`);
    for (const excess of [1, 119, 120, 121, 120]) {
      await execute(`const limit=window.boundaryProbe.querySelector('.detail-preview-limit').getBoundingClientRect().height;
        window.boundaryFixed.style.height=(limit+${excess})+'px';`);
      assert(await wait(`window.boundaryProbe.classList.contains('detail-preview-long')===${excess > 120}`), 'boundary measurement not updated');
      assert(await execute(`const n=window.boundaryProbe,body=n.querySelector('.detail-preview-body'),natural=n.querySelector('.detail-preview-content');
        const limit=n.querySelector('.detail-preview-limit').getBoundingClientRect().height;
        return n.querySelector('.detail-preview-toggle').hidden===${excess <= 120}&&
          Math.abs(body.getBoundingClientRect().height-(${excess > 120} ? limit : natural.getBoundingClientRect().height))<=1&&
          getComputedStyle(body).maskImage.includes('linear-gradient')===${excess > 120};`),
        `${width}/${theme}: incorrect clipping at +${excess}px`);
    }
    console.log('PASS bounded modules, clipped-only fade, accessible note and 120px margin', width, height, theme);
  }
  await viewport(1440, 900);
  await execute(`window.resizeProbe=[...document.querySelectorAll('.detail-preview')].find(n=>n.querySelector('h2').textContent==='状态');
    const fixed=document.createElement('div');fixed.style.height='400px';fixed.textContent='短模块高度响应测试';
    window.resizeProbe.querySelector('.detail-preview-content').replaceChildren(fixed);`);
  assert(await wait(`window.resizeProbe.querySelector('.detail-preview-toggle').hidden`), '400px module should fit a tall viewport');
  await viewport(1440, 450);
  assert(await wait(`!window.resizeProbe.querySelector('.detail-preview-toggle').hidden`), 'height-only resize clipped a short module without an expand control');
  await viewport(1440, 900);
  assert(await wait(`window.resizeProbe.querySelector('.detail-preview-toggle').hidden`), 'height-only resize left a redundant expand control');
  await execute('window.paint();');
  await click('.conversation-panel .section-title .detail-preview-toggle');
  assert(await execute(`const n=document.querySelector('.conversation-panel');return n.classList.contains('detail-preview-expanded')&&
    n.querySelector('.detail-preview-body').getBoundingClientRect().height>1000&&n.textContent.includes('最后一段结果')&&
    getComputedStyle(n.querySelector('.detail-preview-body')).maskImage==='none';`), 'result expansion lost body or retained fade');
  assert(await execute(`window.savedResult=document.querySelector('.conversation-panel');
    window.savedMessage=document.querySelector('.conversation-message');window.paint();return document.querySelector('.conversation-panel')===window.savedResult&&
    document.querySelector('.conversation-message')===window.savedMessage&&
    window.savedResult.classList.contains('detail-preview-expanded');`), 'refresh reset reading state/nodes');
  await click('.conversation-panel .section-title .detail-preview-toggle');
  assert(await execute(`const n=document.querySelector('.conversation-panel');return !n.classList.contains('detail-preview-expanded')&&
    n.querySelector('.detail-preview-body').getBoundingClientRect().height<=400&&
    getComputedStyle(n.querySelector('.detail-preview-body')).maskImage.includes('linear-gradient');`), 'collapse not bounded or missing fade');
  assert(await execute(`const n=document.querySelector('.agent-panel');const target=document.createElement('button');target.textContent='隔离焦点目标';n.querySelector('.detail-preview-content').append(target);target.focus();
    return n.classList.contains('detail-preview-expanded')&&document.activeElement===target;`), 'keyboard focus stayed clipped');
  assert(await execute(`const n=document.querySelector('.conversation-panel');
    n.revealConversationReference({kind:'message',target:{message_id:20}});
    const last=n.querySelector('[data-ref~="message-20"]');window.reveal(last);
    return n.classList.contains('detail-preview-expanded')&&last.classList.contains('conversation-expanded')&&last.textContent.includes('来源不明');`), 'hidden message reference reveal failed');
  await execute(`document.querySelector('[data-conversation-filter="unknown"]').click();`);
  await execute(`const short=[...document.querySelectorAll('.detail-preview')].find(n=>n.querySelector('h2').textContent==='状态');
    window.short=short;const extra=document.createElement('p');extra.textContent='新增历史\\n'.repeat(300);extra.style.whiteSpace='pre-wrap';
    short.querySelector('.detail-preview-content').append(extra);`);
  assert(await wait(`window.short.classList.contains('detail-preview-long')&&!window.short.querySelector('.detail-preview-toggle').hidden`), 'lazy growth did not expose expand control');
  // Reading geometry, not just scroll numbers: refresh and late content above a reader.
  for (const [width,height] of [[1440,900],[390,700],[320,560]]) for (const theme of ['light','dark']) {
    await viewport(width, height);
    await execute(`document.documentElement.dataset.theme='${theme}';window.paint();
      window.result=document.querySelector('.conversation-panel');
      window.reply=window.result.querySelector('.conversation-output');window.reveal(window.reply);
      window.anchor=window.reply.querySelectorAll('.markdown p')[25];
      const panel=document.querySelector('#detail');window.page=matchMedia('(max-width:760px)').matches;
      const delta=window.anchor.getBoundingClientRect().top-(window.page?140:panel.getBoundingClientRect().top+100);
      if(window.page)window.scrollBy(0,delta);else panel.scrollTop+=delta;`);
    await rpc(`/session/${session}/execute/async`, { script:'requestAnimationFrame(()=>requestAnimationFrame(()=>arguments[0](true)));',args:[] });
    assert(await execute(`const head=window.result.querySelector('.section-title');
      const edge=window.page?parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mobile-header-height')):document.querySelector('#detail').getBoundingClientRect().top;
      window.anchorTop=window.anchor.getBoundingClientRect().top;
      window.stickyDiagnostic={top:head.getBoundingClientRect().top,edge,height:head.getBoundingClientRect().height,
        module:window.result.getBoundingClientRect().toJSON(),anchor:window.anchorTop,hidden:head.querySelector('button').hidden};
      return Math.abs(head.getBoundingClientRect().top-edge)<2&&
        !head.querySelector('button').hidden;`), `sticky result header/control ${width}/${theme}: ${JSON.stringify(await execute('return window.stickyDiagnostic;'))}`);
    assert(await execute(`const meta=window.reply.querySelector('.conversation-meta'),head=window.result.querySelector('.section-title');
      return Math.abs(meta.getBoundingClientRect().top-head.getBoundingClientRect().bottom)<2&&
        window.reply.classList.contains('conversation-expanded');`), `sticky message header ${width}/${theme}`);
    assert(await execute(`window.task={...window.task,progress:{...window.task.progress,items:window.task.progress.items.slice(0,10)}};
      window.paint();window.result=document.querySelector('.conversation-panel');
      return Math.abs(window.anchor.getBoundingClientRect().top-window.anchorTop)<2;`), `refresh moved reader ${width}/${theme}`);
    await execute(`const before=document.querySelector('.conversation-list');
      window.extra=document.createElement('p');window.extra.textContent='异步新增内容';window.extra.style.height='160px';
      before.prepend(window.extra);`);
    // Explicit expansion is intentional; establish a new reading position, then grow it lazily.
    await execute(`const panel=document.querySelector('#detail');const delta=window.anchor.getBoundingClientRect().top-(window.page?140:panel.getBoundingClientRect().top+100);
      if(window.page)window.scrollBy(0,delta);else panel.scrollTop+=delta;`);
    await rpc(`/session/${session}/execute/async`, { script:'requestAnimationFrame(()=>requestAnimationFrame(()=>arguments[0](true)));',args:[] });
    await execute(`window.anchorTop=window.anchor.getBoundingClientRect().top;
      window.extra.style.height='340px';`);
    assert(await wait(`Math.abs(window.anchor.getBoundingClientRect().top-window.anchorTop)<2`), `lazy growth moved reader ${width}/${theme}`);
    // Move close to the module end: its header must give way, not overlay the next module.
    assert(await execute(`const panel=document.querySelector('#detail');const edge=window.page?parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mobile-header-height')):panel.getBoundingClientRect().top;
      const delta=window.result.getBoundingClientRect().bottom-edge-10;
      if(window.page)window.scrollBy(0,delta);else panel.scrollTop+=delta;
      return window.result.querySelector('.section-title').getBoundingClientRect().bottom<=window.result.getBoundingClientRect().bottom+1;`), 'sticky header escaped module');
    await execute(`window.result.querySelector('.detail-preview-toggle').click();`);
    assert(await execute(`const box=window.result.querySelector('.section-title').getBoundingClientRect();
      return !window.result.classList.contains('detail-preview-expanded')&&box.bottom>0&&box.top<innerHeight;`), 'sticky collapse left control offscreen');
    // Supplemental history/use patches above a late module must preserve the same paragraph.
    await execute(`window.patches=window.paint({current:()=>true});
      window.messages=document.querySelector('.conversation-panel');
      window.reveal(window.messages);const reply=window.messages.querySelector('.conversation-output');window.reveal(reply);
      window.messageAnchor=reply.querySelectorAll('.markdown p')[25];
      const panel=document.querySelector('#detail');const delta=window.messageAnchor.getBoundingClientRect().top-(window.page?140:panel.getBoundingClientRect().top+100);
      if(window.page)window.scrollBy(0,delta);else panel.scrollTop+=delta;`);
    await rpc(`/session/${session}/execute/async`, { script:'requestAnimationFrame(()=>requestAnimationFrame(()=>arguments[0](true)));',args:[] });
    assert(await execute(`window.messageTop=window.messageAnchor.getBoundingClientRect().top;
      window.patches.update('usage',{files:['fixture'],requests:1,totals:{input:200,output:30,cost:0.01}},true);
      window.patches.update('history',{events:[...window.fixtureHistory.events,{id:900,type:'invocation.completed',created_at:'2026-10-10T00:00:00Z',data:{run_id:900,result:'新增历史结果\\n\\n'.repeat(100)}}]},true);
      return Math.abs(window.messageAnchor.getBoundingClientRect().top-window.messageTop)<2;`), `supplemental patch moved reader ${width}/${theme}`);
    assert(await wait(`Math.abs(window.messageAnchor.getBoundingClientRect().top-window.messageTop)<2`), 'observer undid patch compensation');
    console.log('PASS sticky header, refresh anchor, lazy growth, supplemental patches and collapse',width,height,theme);
  }
  await execute(`window.task={...window.task,id:8,worker_number:'W8'};window.paint();`);
  assert(await execute(`return [...document.querySelectorAll('.detail-preview')].every(n=>!n.classList.contains('detail-preview-expanded'));`), 'state leaked into other Worker');
  await execute(`window.reveal(document.querySelector('.conversation-panel'));`);
  assert(await execute(`const root=document.querySelector('.conversation-panel'),before=[...root.querySelector('.conversation-list').children];
    root.querySelector('.conversation-order button').click();
    const after=[...root.querySelector('.conversation-list').children];window.paint();
    return root.dataset.order==='asc'&&before.every((n,i)=>after[after.length-1-i]===n)&&document.querySelector('.conversation-panel').dataset.order==='asc';`), 'order change replaced messages or refresh lost selection');
  console.log('PASS height-only resize, bubbles, message/module sticky headers, sorting, expand/collapse, refresh, focus, reference reveal, lazy growth and Worker isolation');
  const copyClick = async selector => {
    await execute(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'});`);
    // Let viewport reflow and sticky headings settle before the real WebDriver hit test.
    await rpc(`/session/${session}/execute/async`, { script:'requestAnimationFrame(()=>requestAnimationFrame(()=>arguments[0](true)));',args:[] });
    await click(selector);
  };
  for (const [width,height] of [[1440,900],[390,700],[320,560]]) for (const theme of ['light','dark']) {
    await viewport(width,height);
    await execute(`document.documentElement.dataset.theme='${theme}';window.makeCopyFixture();`);
    await copyClick('.conversation-input .conversation-copy');
    assert(await wait(`window.copied.length===1`), 'input copy failed');
    assert(await execute(`return window.copied[0]===window.copySource;`), 'input copy lost raw Markdown');
    await copyClick('.conversation-input .code-copy');
    assert(await wait(`window.copied.length===2`), 'code copy failed');
    assert(await execute(`return window.copied[1]==='  echo "<raw>"  \\n\\nprintf W313';`), 'code copy included labels or changed whitespace');
    await copyClick('.conversation-output .conversation-copy');
    assert(await wait(`window.copied.length===3`), 'output copy failed');
    assert(await execute(`return window.copied[2]===window.copyOutput;`), 'output copy lost raw Markdown');
    await copyClick('.conversation-output .code-copy');
    assert(await wait(`window.copied.length===4`), 'unlabelled code copy failed');
    assert(await execute(`return window.copied[3]==='输出代码'&&!document.querySelector('.conversation-panel .message-original')&&
      !document.querySelector('.conversation-panel').textContent.includes('查看完整原文')&&
      [...document.querySelectorAll('.conversation-copy,.code-copy')].every(button=>{
        const box=button.getBoundingClientRect(),parent=button.closest('.conversation-message').getBoundingClientRect();
        return box.width>0&&box.left>=parent.left&&box.right<=parent.right+1&&(${width}>760||box.height>=44);
      })&&document.querySelector('#detail').scrollWidth<=document.querySelector('#detail').clientWidth+1;`), 'copy controls overflow or raw-view entry retained');
    console.log('PASS exact raw/code clipboard payloads and responsive copy controls',width,height,theme);
  }
  }
  for (const [width,height] of [[1440,900],[390,700],[320,560]]) for (const theme of ['light','dark']) {
    await viewport(width,height);
    await execute(`document.documentElement.dataset.theme='${theme}';window.makeSharedModules();`);
    assert(await wait(`window.sharedReading.section.classList.contains('module-long')`),'shared preview not measured');
    assert(await execute(`const v=window.sharedReading,f=window.sharedForm;
      return Math.abs(v.body.getBoundingClientRect().height-v.gauge.getBoundingClientRect().height)<1&&
        getComputedStyle(v.body).maskImage.includes('linear-gradient')&&v.summary.parentNode===v.section&&!v.summary.hidden&&
        !f.body.hidden&&f.body.getBoundingClientRect().height>1600&&!f.section.classList.contains('module-long')&&
        getComputedStyle(f.body).maskImage==='none'&&document.querySelector('#detail').scrollWidth<=document.querySelector('#detail').clientWidth+1;`),'shared modes, summary or width regression');
    await execute(`window.sharedReading.toggle.click();`);
    assert(await execute(`const v=window.sharedReading;return v.expanded&&getComputedStyle(v.body).maskImage==='none'&&
      v.body.getBoundingClientRect().height>1000&&getComputedStyle(v.body).overflowY==='visible';`),'shared expansion introduced inner scrolling');
    await execute(`window.sharedAnchor=window.sharedReading.content.querySelectorAll('p')[30];
      const panel=document.querySelector('#detail');window.sharedPage=matchMedia('(max-width:760px)').matches;
      const delta=window.sharedAnchor.getBoundingClientRect().top-(window.sharedPage?140:panel.getBoundingClientRect().top+100);
      if(window.sharedPage)window.scrollBy(0,delta);else panel.scrollTop+=delta;`);
    await rpc(`/session/${session}/execute/async`,{script:'requestAnimationFrame(()=>requestAnimationFrame(()=>arguments[0](true)));',args:[]});
    assert(await execute(`const v=window.sharedReading,panel=document.querySelector('#detail');
      const edge=window.sharedPage?parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mobile-header-height')):panel.getBoundingClientRect().top;
      window.sharedTop=window.sharedAnchor.getBoundingClientRect().top;
      return Math.abs(v.head.getBoundingClientRect().top-edge)<2;`),'ordinary module heading not sticky');
    await execute(`const extra=document.createElement('div');extra.style.height='180px';window.sharedReading.content.prepend(extra);`);
    assert(await wait(`Math.abs(window.sharedAnchor.getBoundingClientRect().top-window.sharedTop)<2`),'shared observer moved visible reader');
    await execute(`window.sharedReading.toggle.click();`);
    assert(await execute(`const v=window.sharedReading,box=v.head.getBoundingClientRect();return !v.expanded&&box.bottom>0&&box.top<innerHeight;`),'shared collapse lost header');
    assert(await execute(`const f=window.sharedForm;window.sharedEditor.focus();f.setExpanded(false);
      return f.body.hidden&&!f.summary.hidden&&document.activeElement===f.toggle&&window.sharedEditor.value==='未保存草稿';`),'explicit fold lost draft, focus or summary');
    await execute(`window.sharedForm.toggle.click();window.sharedReveal(window.sharedAnchor);`);
    assert(await execute(`return !window.sharedForm.body.hidden&&window.sharedEditor===window.sharedForm.content.querySelector('textarea')&&
      window.sharedReading.expanded&&window.sharedReading.section.querySelectorAll('.module-body').length===1;`),'shared reference/fold node retention');
    console.log('PASS shared ordinary module geometry, sticky heading, anchor, preview/fold, draft/focus and summaries',width,height,theme);
  }
  await execute(`window.sharedDispose();document.querySelector('#detail').replaceChildren();`);
  for (const [width,height] of [[1440,900],[390,700],[320,560]]) for (const theme of ['light','dark'])
    for (const scope of ['records','detail']) for (const kind of ['questionnaire','info']) {
      await viewport(width,height);
      await execute(`document.documentElement.dataset.theme='${theme}';window.makeNoticeModule('${kind}','${scope}');`);
      assert(await execute(`const {panel,section,head}=window.noticeFixture,title=head.querySelector('h3'),meta=head.querySelector('.notice-meta'),toggle=head.querySelector('.module-toggle');
        const h=head.getBoundingClientRect(),t=title.getBoundingClientRect(),m=meta.getBoundingClientRect(),b=toggle.getBoundingClientRect();
        return getComputedStyle(head).backgroundColor===getComputedStyle(section).backgroundColor&&
          getComputedStyle(head).backgroundColor!=='rgba(0, 0, 0, 0)'&&m.bottom<=t.top+1&&t.right<=b.left+1&&
          t.left>=h.left-1&&t.bottom<=h.bottom+1&&b.right<=h.right+1&&title.scrollWidth<=title.clientWidth+1&&
          panel.scrollWidth<=panel.clientWidth+1;`),`Notice tint/title geometry ${width}/${theme}/${scope}/${kind}`);
      await execute(`const {panel,head}=window.noticeFixture;const mobile=matchMedia('(max-width:760px)').matches;
        const delta=head.getBoundingClientRect().top-(mobile?42:panel.getBoundingClientRect().top)+300;
        if(mobile)window.scrollBy(0,delta);else panel.scrollTop+=delta;`);
      await rpc(`/session/${session}/execute/async`,{script:'requestAnimationFrame(()=>requestAnimationFrame(()=>arguments[0](true)));',args:[]});
      await execute(`const {panel,head}=window.noticeFixture;window.noticeStickyTop=head.getBoundingClientRect().top;
        if(matchMedia('(max-width:760px)').matches)window.scrollBy(0,200);else panel.scrollTop+=200;`);
      await rpc(`/session/${session}/execute/async`,{script:'requestAnimationFrame(()=>requestAnimationFrame(()=>arguments[0](true)));',args:[]});
      assert(await execute(`const {panel,section,head,listHead}=window.noticeFixture,style=getComputedStyle(head),box=head.getBoundingClientRect();
        const mobile=matchMedia('(max-width:760px)').matches;
        const edge=listHead?listHead.getBoundingClientRect().bottom:mobile?parseFloat(style.top):panel.getBoundingClientRect().top;
        const inset=listHead||mobile?2:parseFloat(getComputedStyle(panel).paddingTop);
        window.noticeStickyDiagnostic={top:box.top,previous:window.noticeStickyTop,edge,inset,bottom:box.bottom,
          sectionBottom:section.getBoundingClientRect().bottom,scroll:window.scrollY,panelScroll:panel.scrollTop};
        return style.position==='sticky'&&Math.abs(box.top-window.noticeStickyTop)<2&&box.top>=edge-1&&
          box.top<=edge+inset&&box.bottom<=section.getBoundingClientRect().bottom+1;`),
        `Notice sticky edge ${width}/${theme}/${scope}/${kind}: ${JSON.stringify(await execute('return window.noticeStickyDiagnostic;'))}`);
      await execute(`window.noticeFixture.head.querySelector('.module-toggle').click();`);
      assert(await execute(`const {section,head}=window.noticeFixture,box=head.getBoundingClientRect();
        return section.querySelector('.module-body').hidden&&box.bottom>0&&box.top<innerHeight&&head.textContent.includes('LongDecisionTitle');`), 'Notice collapse lost title/control');
      await execute(`window.noticeFixture.head.querySelector('.module-toggle').click();`);
      assert(await execute(`return !window.noticeFixture.section.querySelector('.module-body').hidden;`),'Notice failed to re-expand');
      if(scope==='records'){
        assert(await execute(`return window.noticeFixture.panel===document.querySelector('#detail')&&
          !!document.querySelector('#detail #notice-record-detail')&&!document.querySelector('#side-notices #notice-record-detail');`),
          'record preview must stay on the independent detail page');
      }
    }
  console.log('PASS Notice tinted sticky headings, metadata/title wrapping and fold controls: desktop/mobile, light/dark, records/detail, decision/info');
  // Project mobile pages use an inner #detail scrollport (the global fixture above uses
  // document scrolling). Compare with the real scrollport edge, not the CSS top value.
  for (const [width,height] of [[1440,900],[390,700],[320,560]]) for (const theme of ['light','dark'])
    for (const colored of [false,true]) for (const kind of ['ordinary','worker','versions','conversation','notice']) {
      await viewport(width,height);
      await execute(`document.documentElement.dataset.lushSpace='project';
        document.documentElement.dataset.theme='${theme}';document.documentElement.dataset.reducedMotion='true';
        if(${colored})document.documentElement.dataset.projectColor='blue';else delete document.documentElement.dataset.projectColor;
        const panel=document.querySelector('#detail'),banner=document.querySelector('#notice-banner');
        banner.hidden='${kind}'!=='versions';banner.style.height='60px';
        if('${kind}'==='conversation'){
          window.paint();window.projectSection=panel.querySelector('.conversation-panel');
          window.projectReply=window.projectSection.querySelector('.conversation-output');window.reveal(window.projectReply);
        }else if('${kind}'==='notice'){
          window.makeNoticeModule('info','records');window.projectSection=window.noticeFixture.section;
        }else{
          window.makeSharedModules();const {section}=window.sharedReading;
          panel.replaceChildren(section,window.sharedForm.section);
          if('${kind}'!=='ordinary')panel.dataset.view='task';
          if('${kind}'==='versions'){
            section.classList.add('worker-versions');window.enhanceVersions(section,document.createElement('p'));
          }
          window.projectSection=section;window.sharedReading.setExpanded(true);
        }
        window.projectHead=window.projectSection.querySelector('.section-title');
        window.scrollTo(0,0);panel.scrollTop=0;
        const target='${kind}'==='conversation'?window.projectReply:window.projectHead;
        panel.scrollTop=target.getBoundingClientRect().top-panel.getBoundingClientRect().top+300;`);
      await rpc(`/session/${session}/execute/async`,{script:'requestAnimationFrame(()=>requestAnimationFrame(()=>arguments[0](true)));',args:[]});
      const geometry=await execute(`const panel=document.querySelector('#detail'),head=window.projectHead;
        return {edge:panel.getBoundingClientRect().top,top:head.getBoundingClientRect().top,
          scroll:panel.scrollTop,pageScroll:window.scrollY,headerBottom:document.querySelector('#sidebar').getBoundingClientRect().bottom,
          bannersBottom:document.querySelector('.project-banners').getBoundingClientRect().bottom,
          meta:'${kind}'==='conversation'?window.projectReply.querySelector('.conversation-meta').getBoundingClientRect().top:null,
          headBottom:head.getBoundingClientRect().bottom};`);
      assert(geometry.scroll>0&&geometry.pageScroll===0&&Math.abs(geometry.top-geometry.edge)<2,
        `project scrollport sticky edge ${width}/${theme}/${colored}/${kind}: ${JSON.stringify(geometry)}`);
      assert(geometry.top>=geometry.bannersBottom-1,`project banners overlap module: ${JSON.stringify(geometry)}`);
      if(width<=760)assert(geometry.top>=geometry.headerBottom-1,'module overlaps mobile navigation');
      if(kind==='conversation')assert(Math.abs(geometry.meta-geometry.headBottom)<2,'project message header separated from module');
    }
  console.log('PASS project scrollport sticky headings: ordinary/Worker/version/conversation/Notice, desktop/mobile, themes and project colors');
  // Exercise the real media query, not a JS matchMedia stub. A separate browser preference
  // represents the OS setting and proves that application opt-out cannot override it.
  await rpc(`/session/${session}`, undefined, 'DELETE');session=null;
  session=(await rpc('/session',{capabilities:{alwaysMatch:{browserName:'firefox',
    'moz:firefoxOptions':{args:['-headless'],prefs:{'ui.prefersReducedMotion':1}}}}})).sessionId;
  await rpc(`/session/${session}/url`,{url:origin+'/host'});
  assert(await wait(`document.querySelector('form[action="/login"]')`),'reduced-motion session login missing');
  await execute(`document.querySelector('[name="username"]').value=${JSON.stringify(username)};
    document.querySelector('[name="password"]').value=${JSON.stringify(password)};`);
  await click('form[action="/login"] button[type="submit"]');
  assert(await wait(`document.querySelector('#fixture')`),'reduced-motion fixture missing');
  await viewport(1440,900);assert(await wait('window.ready'),'reduced-motion fixture not ready');
  assert(await execute(`window.makeSharedModules();document.documentElement.dataset.reducedMotion='false';
    const f=window.sharedForm;f.content.lastElementChild.style.height='100px';f.toggle.click();
    return matchMedia('(prefers-reduced-motion:reduce)').matches&&f.body.hidden&&!f.body.getAnimations().length&&
      getComputedStyle(f.toggle.viewIcon,'::before').transitionDuration==='0s';`),'system reduced motion must disable height and arrow transitions');
  console.log('PASS real system reduced-motion preference');
  passed = true;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true); await authServer.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true }); else console.error('Browser failure log:', log);
}
