// bun run test/web/check-task-graph-mobile-browser.js — static Firefox layout regression.
// Loopback fixture only: no user project, daemon, authentication data or model calls.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const script = `<script type="module">
import {renderTaskGraph} from '/render-task-graph.js';
import {ui} from '/state.js';
import {setPref} from '/prefs.js';
window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
document.documentElement.dataset.lushSpace='project';ui.view={id:'task-graph'};
setPref('taskGraphMinimal',true);setPref('reduceMotion',true);
const own={run_ms:93784000,input:121000,output:18000,cost:224.24,running:true};
window.graph={total:6,archived_count:2,management_count:3,nodes:[
{id:1,worker_number:'W1',title:'main',branch:'main',role:'agent',task_kind:'main',status:'waiting',children_total:2,
resources:{own,subtree:{...own,input:242000,cost:448.48}}},
{id:2,parent_id:1,worker_number:'W2',title:'手机进度与消耗分行展示',role:'agent',task_kind:'order',status:'running',integration:'pending',delivery_summary:{stage:'pending'},reservation:{version:2,status:'pending'},
progress:{total:3,completed:1,current:{label:'验证较长的进度说明和移动端布局，不应被消耗信息挤走'}},resources:{own}},
{id:3,parent_id:2,worker_number:'W2-1',title:'等待中的子 Worker',role:'agent',task_kind:'child',status:'waiting',integration:'merged',delivery_summary:{stage:'integrated'},
waiting_reason:'等待父 Worker 确认接口，保留完整的等待原因',input_queue:{buffered:2},freeze:{task_id:1},resources:{own}},
{id:4,parent_id:1,worker_number:'V21',title:'运行中的项目管家',role:'manager',task_kind:'management',status:'running',agent_last_seen_at:'2026-10-22T12:00:00.000Z',management_attention:true,management:{state:'running',reason:'正在管理本项目，不进入开发分支'}},
{id:5,parent_id:null,worker_number:'V22',title:'历史无父记录只读投影到 main 的管理区',role:'manager',task_kind:'management',status:'completed',management_attention:true,management:{state:'unknown',reason:'结果未知，必须保留完整异常摘要，不能因极简或窄屏被省略'}},
{id:6,parent_id:1,worker_number:'V23',title:'资源回收未完成的管家',role:'manager',task_kind:'management',status:'failed',acceptance_recovery:true,management_attention:true,notice_count:1,management:{state:'failed',reason:'具体失败与资源回收异常须保持可见',acceptance_recovery:true,can_accept:false,acceptance_reason:'资源回收异常，请核对记录'}}
]};
window.paint=()=>renderTaskGraph(graph);window.setMode=minimal=>{setPref('taskGraphMinimal',minimal);window.paint();};window.paint();window.ready=true;
</script>`;
const html = (await Bun.file(join(assets,'index.html')).text())
  .replace(/<script[^>]*src="\/(?:app|appearance)\.js"[^>]*><\/script>/g,'').replace('</body>',script+'</body>');
const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
  const path=new URL(req.url).pathname;
  if(path==='/')return new Response('<html><body style="margin:0"><iframe id="viewport" src="/fixture" style="width:390px;height:844px;border:0"></iframe></body></html>',{headers:{'Content-Type':'text/html'}});
  if(path==='/fixture')return new Response(html,{headers:{'Content-Type':'text/html'}});
  if(['/administrator/protocol.js','/administrator/project-protocol.js','/shared/dashboard-quick-actions.js'].includes(path))return new Response(Bun.file(new URL('../../src'+path,import.meta.url)));
  if(/^\/[\w.-]+\.(js|css)$/.test(path))return new Response(Bun.file(join(assets,path.slice(1))));
  return new Response('not found',{status:404});
}});
const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')});
const port=reservation.port;reservation.stop(true);
const temp=await mkdtemp(join(tmpdir(),'lush-task-graph-mobile-')),log=join(temp,'geckodriver.log');
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
async function resize(width){
  await rpc(`/session/${session}/frame`,{id:null});
  await execute(`document.querySelector('#viewport').style.width='${width}px';`);
  const frame=await rpc(`/session/${session}/element`,{using:'css selector',value:'#viewport'});
  await rpc(`/session/${session}/frame`,{id:frame});
  assert(await execute(`return innerWidth===${width}`),'viewport mismatch');
}
try{
  let ready=false;for(let i=0;i<100;i++){try{await rpc('/status',undefined,'GET');ready=true;break;}catch{}if(driver.exitCode!==null)throw Error('geckodriver exited');await Bun.sleep(100);}assert(ready,'driver startup timeout');
  session=(await rpc('/session',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{args:['-headless']}}}})).sessionId;
  await rpc(`/session/${session}/window/rect`,{width:1600,height:1100});
  await rpc(`/session/${session}/url`,{url:`http://127.0.0.1:${server.port}/`});
  await resize(390);assert(await wait('window.ready'),'fixture failed to render: '+JSON.stringify(await execute('return window.errors||[]')));
  for(const theme of ['light','dark'])for(const width of [320,390,640,641,1440]){
    await resize(width);await execute(`document.documentElement.dataset.theme='${theme}';window.paint();`);
    const geometry=await execute(`return [...document.querySelectorAll('.task-graph-card')].map(card=>{
      const note=card.querySelector('.task-graph-minimal-note,.task-graph-merge-relations'),meta=card.querySelector('.task-graph-minimal-meta'),usage=meta.querySelector('.task-graph-usage');
      const n=note.getBoundingClientRect(),m=meta.getBoundingClientRect(),u=usage.getBoundingClientRect(),c=card.getBoundingClientRect();
      return {id:card.dataset.taskId,hasManagers:!!card.querySelector('.project-management'),height:c.height,noteHeight:n.height,noteBottom:n.bottom,metaTop:m.top,usageTop:u.top,usageBottom:u.bottom,bottom:c.bottom,
        noteOverflow:note.scrollWidth>note.clientWidth+1,metaOverflow:meta.scrollWidth>meta.clientWidth+1,
        contained:[...meta.querySelectorAll('span')].every(s=>{const r=s.getBoundingClientRect();return r.left>=c.left&&r.right<=c.right&&r.bottom<=c.bottom}),
        text:note.textContent,usage:usage.textContent,metaDisplay:getComputedStyle(meta).display,moreTop:card.querySelector('.task-graph-more-trigger').getBoundingClientRect().top};
    });`);
    const compact=await execute(`const hero=document.querySelector('.task-graph-hero'),fold=document.querySelector('.task-graph-fold'),title=fold.nextElementSibling;
      const f=fold.getBoundingClientRect(),t=title.getBoundingClientRect(),c=fold.closest('.task-graph-card').getBoundingClientRect(),children=document.querySelector('.task-graph-children'),s=getComputedStyle(children);
      return {chips:[...hero.querySelectorAll('.task-graph-summary>.badge')].map(n=>n.getBoundingClientRect().height),
        archived:hero.querySelector('.task-graph-archived-toggle').textContent,blank:hero.textContent.includes('空白创建'),
        indent:parseFloat(s.marginLeft)+parseFloat(s.paddingLeft)+parseFloat(s.borderLeftWidth),
        titleHeight:t.height,titleLabelHeight:title.querySelector('.task-graph-link-label').getBoundingClientRect().height,
        foldWidth:f.width,foldHeight:f.height,foldInside:f.left>=c.left&&f.right<=t.left,gap:t.left-f.right};`);
    assert(compact.chips.every(height=>height<=17)&&compact.archived==='已回收 2'&&!compact.blank,`filter/entry density: ${JSON.stringify(compact)}`);
    assert(compact.indent===(width<=640?10:22),`tree indentation: ${JSON.stringify(compact)}`);
    assert(compact.foldInside&&compact.gap<=3&&compact.foldWidth===(width<=760?44:20)&&compact.foldHeight===(width<=760?44:24),`compact caret/clear touch target: ${JSON.stringify(compact)}`);
    assert(width>760||(compact.titleHeight>=44&&compact.titleLabelHeight<=22),`compact title label/clear touch target: ${JSON.stringify(compact)}`);
    assert(geometry.length===3,'missing nested cards or Valet incorrectly drawn as a branch');
    const management=await execute(`const section=document.querySelector('[data-task-id="1"]>.project-management');return {expanded:section.querySelector('button').getAttribute('aria-expanded'),rows:[...section.querySelectorAll('.project-management-row')].filter(row=>!row.hidden).map(row=>{const r=row.getBoundingClientRect();return {id:row.dataset.valetId,overflow:row.scrollWidth>row.clientWidth+1,buttons:[...row.querySelectorAll('button')].map(b=>b.getBoundingClientRect().height),contained:r.right<=section.getBoundingClientRect().right};})};`);
    assert(management.expanded==='false'&&management.rows.length===1&&management.rows[0].id==='4', 'management should default to only the most recently run Valet');
    assert(management.rows.every(row=>!row.overflow&&row.contained&&(width>760||row.buttons.every(h=>h>=44))),`management overflow/touch targets: ${JSON.stringify(management)}`);
    for(const card of geometry){
      if(width<=640){
        assert(card.metaTop>=card.noteBottom&&card.usageTop>=card.noteBottom,`metadata covers progress: ${JSON.stringify(card)}`);
        assert(!card.noteOverflow&&!card.metaOverflow&&card.contained,`mobile overflow: ${JSON.stringify(card)}`);
        assert(card.usageBottom<card.bottom&&card.moreTop<card.metaTop,`usage/actions outside card: ${JSON.stringify(card)}`);
      }else{
        assert((card.hasManagers|| (width<=760?card.height>=86&&card.height<=88:card.height===68))&&card.metaDisplay==='contents',`inline layout changed: ${JSON.stringify(card)}`);
        assert(card.usageTop<card.noteBottom,'desktop no longer inline');
      }
    }
    assert(geometry[1].text.includes('1/3 · 验证较长')&&geometry[1].usage.includes('1 d 2 h 3 m 4 s'),'progress or statistics lost');
    if(width<=390)assert(geometry[1].noteHeight>20,'long progress did not wrap');
    console.log('PASS',theme,width,'progress/usage separation, nesting, long duration, desktop baseline');
  }
  for(const width of [390,1440]){
    await resize(width);
    assert(await execute(`return ['2','3'].every((id,i)=>{
      const card=document.querySelector('[data-task-id="'+id+'"]'),usage=card.querySelector('.task-graph-usage'),status=usage.nextElementSibling;
      const u=usage.getBoundingClientRect(),s=status.getBoundingClientRect();
      return status.textContent===['未合并','已合并'][i]&&!card.querySelector('.source-delivery')
        &&(innerWidth<=640||(s.left>=u.right&&s.top<u.bottom));
    });`),'merge status not inline after usage');
  }
  console.log('PASS pending/merged status after usage without standalone tracking rows');
  await execute(`window.normalGraph=graph;window.graph={total:1,nodes:[{id:2,parent_id:1,parent_worker_number:'W1',target_branch:'main',worker_number:'W2',title:'交付中的工作',role:'agent',task_kind:'order',status:'waiting',integration:'pending',
    merge_queue:{total:1,counts:{resolving:1},items:[{id:3,worker_number:'W2-1',status:'resolving'}]},
    resources:{own:{run_ms:1000,input:100,output:10,cost:0.01}}}]};`);
  for(const theme of ['light','dark'])for(const width of [320,390,640,641,1440])for(const stage of ['requested','executing','resolving']){
    await resize(width);
    const baselineHeight=await execute(`document.documentElement.dataset.theme='${theme}';delete graph.nodes[0].delivery_summary;graph.nodes[0].reservation={version:2,kind:'merge',queue_protocol:1,parent_id:1,status:'${stage}'};window.paint();
      const baseline=document.querySelector('.task-graph-card').getBoundingClientRect().height;
      graph.nodes[0].delivery_summary={version:2,stage:'${stage}'};window.paint();return baseline;`);
    const card=await execute(`const card=document.querySelector('.task-graph-card'),usage=card.querySelector('.task-graph-usage'),status=usage.nextElementSibling;
      const c=card.getBoundingClientRect(),s=status.getBoundingClientRect();
      const relations=card.querySelector('.task-graph-merge-relations'),r=relations.getBoundingClientRect();
      return {height:c.height,text:status.textContent,tracking:!!card.querySelector('.source-delivery'),contained:s.left>=c.left&&s.right<=c.right&&s.bottom<=c.bottom,relationHeight:r.height,
        links:[...relations.querySelectorAll('button')].map(link=>{const b=link.getBoundingClientRect();return {height:b.height,labelHeight:link.querySelector('.task-graph-link-label').getBoundingClientRect().height,contained:b.top>=r.top&&b.bottom<=r.bottom&&b.bottom<=c.bottom};})};`);
    assert(card.height<=baselineHeight&&!card.tracking&&card.contained,`active delivery adds a row/overflows (${theme}/${width}/${stage}): ${JSON.stringify(card)}`);
    assert((width<=760||card.relationHeight<=20)&&card.links.length===2&&card.links.every(link=>link.contained&&(width<=760?link.height>=44&&link.labelHeight<=20:link.height<=20)),`merge target/conflict link height (${theme}/${width}/${stage}): ${JSON.stringify(card)}`);
    assert(card.text===({requested:'冻结 · 等待合并',executing:'合并中 · 尚未完成',resolving:'合并中 · 源侧分歧修复'})[stage],'delivery stage lost');
  }
  console.log('PASS merge target/conflict labels stay below 20px, retain 44px mobile targets, and active delivery adds no height in both themes at 320–1440px');
  await execute(`window.graph=normalGraph;window.paint();`);
  await resize(390);
  await execute(`document.querySelector('[data-graph-focus="fold-1"]').click();`);
  assert(await execute(`const cards=document.querySelectorAll('.task-graph-card'),usage=cards[0].querySelector('.task-graph-usage');return cards.length===1&&usage.classList.contains('is-aggregate')&&usage.textContent.includes('↑242.0k')&&usage.textContent.includes('$448.48');`),'folded subtree totals changed');
  await execute(`document.querySelector('[data-graph-focus="fold-1"]').click();document.querySelector('[data-graph-focus="more-2"]').click();`);
  assert(await execute(`return document.querySelector('#task-graph-actions-2').matches(':popover-open')`),'mobile actions unavailable');
  assert(await execute('return errors.length===0'),'browser errors');
  console.log('PASS folded totals and mobile action popover');
  await execute(`document.querySelector('#task-graph-actions-2').hidePopover();window.setMode(false);`);
  for(const width of [390,1440]){
    await resize(width);await execute(`window.paint();`);
    assert(await execute(`const fold=document.querySelector('.task-graph-fold'),f=fold.getBoundingClientRect(),t=fold.nextElementSibling.getBoundingClientRect(),c=fold.closest('.task-graph-card').getBoundingClientRect();
      const title=document.querySelector('.task-graph-title'),label=title.querySelector('.task-graph-link-label').getBoundingClientRect();
      return f.left>=c.left&&f.right<=t.left&&t.left-f.right<=4&&(innerWidth>760||(t.height>=44&&label.height<=22))&&[...document.querySelectorAll('.task-graph-summary>.badge')].every(n=>n.getBoundingClientRect().height<=17);`),'detail mode caret/title/filter spacing');
  }
  console.log('PASS compact detail-mode caret and filter badges at mobile/desktop widths');
  await execute(`window.graph=structuredClone(normalGraph);window.graph.nodes.push({id:7,parent_id:1,worker_number:'V24',title:'可收起的已收口管理记录',role:'manager',task_kind:'management',status:'completed',management:{state:'succeeded'}});window.graph.management_count=4;window.graph.total++;window.paint();`);
  for(const width of [390,1440]){
    await resize(width);
    await execute(`document.querySelector('.project-management-head button').click();window.graph.sample='expanded-'+innerWidth;window.paint();`);
    assert(await execute(`const section=document.querySelector('.project-management');return section.querySelector('button').getAttribute('aria-expanded')==='true'&&[...section.querySelectorAll('.project-management-row')].every(row=>getComputedStyle(row).display!=='none')&&section.textContent.includes('结果未知')&&section.textContent.includes('资源回收未完成');`),'expanded management records or diagnostics unavailable after repaint');
    await execute(`document.querySelector('.project-management-head button').click();window.graph.sample='collapsed-'+innerWidth;window.paint();`);
    assert(await execute(`const section=document.querySelector('.project-management'),visible=[...section.querySelectorAll('.project-management-row')].filter(row=>getComputedStyle(row).display!=='none');return section.querySelector('button').getAttribute('aria-expanded')==='false'&&visible.length===1&&visible[0].dataset.valetId==='4';`),'management collapse should retain only the most recently run Valet after repaint');
  }
  console.log('PASS management defaults to one recent Valet, survives repaint and expands all diagnostics at mobile/desktop widths');passed=true;
}finally{
  if(session)await rpc(`/session/${session}`,undefined,'DELETE').catch(()=>{});
  driver.kill();await driver.exited;server.stop(true);
  if(passed)await rm(temp,{recursive:true,force:true});else console.error('Browser failure log:',log);
}
