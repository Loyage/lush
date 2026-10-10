// Real Firefox layout regression with a static fixture; no user daemon, project writes or model calls.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const html = (await Bun.file(join(assets, 'index.html')).text()).replace('<script type="module" src="/app.js"></script>', '');
const fixture = html.replace('</body>', `<script type="module">
import { renderDetail } from '/render-detail.js';
import { revealDetailPreview } from '/detail-preview.js';
import { ui } from '/state.js';
const at='2026-10-08T10:00:00Z';
const long=Array.from({length:50},(_,i)=>'段落 '+i+'：这是一段较长的正文，预览应保留格式，后续内容仍然完整存在。').join('\\n\\n');
window.task={id:7,worker_number:'W7',role:'agent',task_kind:'order',status:'waiting',calls:1,
  goal:long,result:long+'\\n\\n最后一段结果',created_at:at,updated_at:at,
  progress:{version:1,items:Array.from({length:30},(_,i)=>({key:'step'+i,label:'步骤 '+i+' '+('较长的阶段名称 '.repeat(5)),status:i<5?'completed':'pending'}))},
  children:Array.from({length:20},(_,i)=>({id:100+i,worker_number:'W7-'+(i+1),role:'agent',status:'waiting',goal:'子 Worker '+i,updated_at:at})),
  messages:Array.from({length:20},(_,i)=>({id:i+1,sender_id:null,body:'消息 '+i+'\\n\\n'+long,created_at:at}))};
window.fixtureHistory={events:Array.from({length:50},(_,i)=>({id:i+1,type:'invocation.completed',created_at:at,data:{run_id:i+1,result:'此前结果 '+i+'\\n'+long}}))};
ui.selected=7; ui.view={id:'task',key:'7'};
window.paint=(progressive=null)=>renderDetail(window.task,window.fixtureHistory,null,null,null,progressive);
window.reveal=revealDetailPreview;
window.paint(); window.ready=true;
</script></body>`);
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/host') return new Response('<!doctype html><iframe id="fixture" src="/" style="border:0;width:1440px;height:900px"></iframe>', { headers: { 'Content-Type': 'text/html' } });
  if (path === '/') return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-w136-preview-'));
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
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/host` });
  await viewport(1440, 900);
  assert(await wait('window.ready'), 'fixture failed to load');
  for (const [width, height] of [[1440,900],[390,700],[320,560]]) for (const theme of ['light','dark']) {
    await viewport(width, height);
    await execute(`document.documentElement.dataset.theme='${theme}';window.paint();`);
    assert(await wait(`document.querySelector('.goal-panel').classList.contains('detail-preview-long')`), 'long goal not measured');
    const sizes = await execute(`return [...document.querySelectorAll('.detail-preview')].map(n=>({
      title:n.querySelector('h2').textContent,body:n.querySelector('.detail-preview-body').getBoundingClientRect().height,
      limit:n.querySelector('.detail-preview-limit').getBoundingClientRect().height,
      footer:getComputedStyle(n.querySelector('.detail-preview-footer')).display,
      footerHeight:n.querySelector('.detail-preview-footer').getBoundingClientRect().height,
      mask:getComputedStyle(n.querySelector('.detail-preview-body')).maskImage,
      controls:n.querySelectorAll('.detail-preview-toggle').length,
      headerControl:!!n.querySelector('.section-title>.detail-preview-toggle'),
      footerControl:!!n.querySelector('.detail-preview-footer .detail-preview-toggle'),
      natural:n.querySelector('.detail-preview-content').getBoundingClientRect().height}));`);
    assert(sizes.length >= 8, 'missing reading modules');
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
    assert(await execute(`return document.querySelector('#detail').scrollWidth<=document.querySelector('#detail').clientWidth+1;`), 'horizontal page overflow');
    assert(await execute(`return !document.querySelector('.task-actions .detail-preview-body') &&
      !document.querySelector('.goal-panel').classList.contains('detail-preview-expanded');`), 'actions clipped or expanded by default');
    // Test actual clipping, not only the presence of an expand control, at each responsive limit.
    await execute(`window.boundaryProbe=[...document.querySelectorAll('.detail-preview')].find(n=>n.querySelector('h2').textContent==='Worker 依赖');
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
  await execute(`window.resizeProbe=[...document.querySelectorAll('.detail-preview')].find(n=>n.querySelector('h2').textContent==='Worker 依赖');
    const fixed=document.createElement('div');fixed.style.height='400px';fixed.textContent='短模块高度响应测试';
    window.resizeProbe.querySelector('.detail-preview-content').replaceChildren(fixed);`);
  assert(await wait(`window.resizeProbe.querySelector('.detail-preview-toggle').hidden`), '400px module should fit a tall viewport');
  await viewport(1440, 450);
  assert(await wait(`!window.resizeProbe.querySelector('.detail-preview-toggle').hidden`), 'height-only resize clipped a short module without an expand control');
  await viewport(1440, 900);
  assert(await wait(`window.resizeProbe.querySelector('.detail-preview-toggle').hidden`), 'height-only resize left a redundant expand control');
  await execute('window.paint();');
  await click('.result-panel .section-title .detail-preview-toggle');
  assert(await execute(`const n=document.querySelector('.result-panel');return n.classList.contains('detail-preview-expanded')&&
    n.querySelector('.detail-preview-body').getBoundingClientRect().height>1000&&n.textContent.includes('最后一段结果')&&
    getComputedStyle(n.querySelector('.detail-preview-body')).maskImage==='none';`), 'result expansion lost body or retained fade');
  assert(await execute(`window.savedGoal=document.querySelector('.goal-panel');window.savedResult=document.querySelector('.result-panel');
    window.savedMessage=document.querySelector('.task-message');window.paint();return document.querySelector('.result-panel')===window.savedResult&&
    document.querySelector('.goal-panel')===window.savedGoal&&document.querySelector('.task-message')===window.savedMessage&&
    window.savedResult.classList.contains('detail-preview-expanded');`), 'refresh reset reading state/nodes');
  await click('.result-panel .section-title .detail-preview-toggle');
  assert(await execute(`const n=document.querySelector('.result-panel');return !n.classList.contains('detail-preview-expanded')&&
    n.querySelector('.detail-preview-body').getBoundingClientRect().height<=400&&
    getComputedStyle(n.querySelector('.detail-preview-body')).maskImage.includes('linear-gradient');`), 'collapse not bounded or missing fade');
  assert(await execute(`const n=document.querySelector('.agent-panel');const target=n.querySelector('.detail-preview-content button');target.focus();
    return n.classList.contains('detail-preview-expanded')&&document.activeElement===target;`), 'keyboard focus stayed clipped');
  assert(await execute(`const n=[...document.querySelectorAll('.detail-preview')].find(n=>n.querySelector('h2').textContent==='消息');
    const last=n.querySelectorAll('.task-message')[19];window.reveal(last);return n.classList.contains('detail-preview-expanded');`), 'reference reveal failed');
  await execute(`const short=[...document.querySelectorAll('.detail-preview')].find(n=>n.querySelector('h2').textContent==='Worker 依赖');
    window.short=short;const extra=document.createElement('p');extra.textContent='新增历史\\n'.repeat(300);extra.style.whiteSpace='pre-wrap';
    short.querySelector('.detail-preview-content').append(extra);`);
  assert(await wait(`window.short.classList.contains('detail-preview-long')&&!window.short.querySelector('.detail-preview-toggle').hidden`), 'lazy growth did not expose expand control');
  // Reading geometry, not just scroll numbers: refresh and late content above a reader.
  for (const [width,height] of [[1440,900],[390,700],[320,560]]) for (const theme of ['light','dark']) {
    await viewport(width, height);
    await execute(`document.documentElement.dataset.theme='${theme}';window.paint();
      window.result=document.querySelector('.result-panel');window.reveal(window.result);
      window.anchor=window.result.querySelectorAll('.markdown p')[25];
      const panel=document.querySelector('#detail');window.page=matchMedia('(max-width:760px)').matches;
      const delta=window.anchor.getBoundingClientRect().top-(window.page?140:panel.getBoundingClientRect().top+100);
      if(window.page)window.scrollBy(0,delta);else panel.scrollTop+=delta;`);
    await rpc(`/session/${session}/execute/async`, { script:'requestAnimationFrame(()=>requestAnimationFrame(()=>arguments[0](true)));',args:[] });
    assert(await execute(`const head=window.result.querySelector('.section-title');
      const edge=window.page?42:document.querySelector('#detail').getBoundingClientRect().top;
      window.anchorTop=window.anchor.getBoundingClientRect().top;
      return Math.abs(head.getBoundingClientRect().top-edge)<2&&
        !head.querySelector('button').hidden;`), `sticky result header/control ${width}/${theme}`);
    assert(await execute(`window.task={...window.task,progress:{...window.task.progress,items:window.task.progress.items.slice(0,10)}};
      window.paint();window.result=document.querySelector('.result-panel');
      return Math.abs(window.anchor.getBoundingClientRect().top-window.anchorTop)<2;`), `refresh moved reader ${width}/${theme}`);
    await execute(`const before=document.querySelector('.goal-panel .detail-preview-content');
      const extra=document.createElement('p');extra.textContent='异步新增内容';extra.style.height='160px';
      window.reveal(document.querySelector('.goal-panel'));before.append(extra);`);
    // Explicit expansion is intentional; establish a new reading position, then grow it lazily.
    await execute(`const panel=document.querySelector('#detail');const delta=window.anchor.getBoundingClientRect().top-(window.page?140:panel.getBoundingClientRect().top+100);
      if(window.page)window.scrollBy(0,delta);else panel.scrollTop+=delta;`);
    await rpc(`/session/${session}/execute/async`, { script:'requestAnimationFrame(()=>requestAnimationFrame(()=>arguments[0](true)));',args:[] });
    await execute(`window.anchorTop=window.anchor.getBoundingClientRect().top;
      document.querySelector('.goal-panel .detail-preview-content').lastElementChild.style.height='340px';`);
    assert(await wait(`Math.abs(window.anchor.getBoundingClientRect().top-window.anchorTop)<2`), `lazy growth moved reader ${width}/${theme}`);
    // Move close to the module end: its header must give way, not overlay the next module.
    assert(await execute(`const panel=document.querySelector('#detail');const edge=window.page?42:panel.getBoundingClientRect().top;
      const delta=window.result.getBoundingClientRect().bottom-edge-10;
      if(window.page)window.scrollBy(0,delta);else panel.scrollTop+=delta;
      return window.result.querySelector('.section-title').getBoundingClientRect().bottom<=window.result.getBoundingClientRect().bottom+1;`), 'sticky header escaped module');
    await execute(`window.result.querySelector('.detail-preview-toggle').click();`);
    assert(await execute(`const box=window.result.querySelector('.section-title').getBoundingClientRect();
      return !window.result.classList.contains('detail-preview-expanded')&&box.bottom>0&&box.top<innerHeight;`), 'sticky collapse left control offscreen');
    // Supplemental history/use patches above a late module must preserve the same paragraph.
    await execute(`window.patches=window.paint({current:()=>true});
      window.messages=[...document.querySelectorAll('.detail-preview')].find(n=>n.querySelector('h2').textContent==='消息');
      window.reveal(window.messages);window.messageAnchor=window.messages.querySelectorAll('.task-message')[10].querySelectorAll('p')[5];
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
  console.log('PASS height-only resize, expand/collapse, refresh, focus, reference reveal, lazy growth and Worker isolation');
  passed = true;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true }); else console.error('Browser failure log:', log);
}
