// Real Worker tree layout/popover regression. Firefox + geckodriver, no daemon or model calls.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/styles.css"></head>
<body><div id="detail"></div><div id="modal" hidden></div><div id="error"></div><script type="module">
import { renderTaskGraph, loadTaskGraph } from '/assets/render-task-graph.js';
import { ui } from '/assets/state.js';
import { initHelp } from '/assets/help.js';
initHelp();
import { registerNavigation } from '/assets/navigate.js';
registerNavigation({detail:id=>{window.openedTask=id;}});
window.graph={total:9,nodes:[
{id:1,parent_id:null,task_kind:'main',role:'agent',title:'main',status:'waiting',branch:'main'},
...['running','awaiting','awaiting_acceptance','failed','completed','paused','waiting'].map((status,i)=>({
id:i+2,parent_id:i===6?2:1,task_kind:'order',role:'agent',status,branch:'task-'+i,
title:'Worker '+(i+2)+' '+('长标题用于确认固定高度和截断 '.repeat(i?2:20)),
integration:i===4?'merged':'pending',notice_count:i===1?3:0,
notice:i===1?{id:1,kind:'question',title:'确认接口',body:'待决问题'}:null,
waiting_reason:'等待用户确认接口兼容范围',goal_preview:'完整目标',result_preview:'完整结果'.repeat(200),
progress:i===5?null:{total:5,completed:i===4?5:2,current:i===4?null:{label:'实现 Worker 树双行摘要 '.repeat(10)}}
})),
{id:99,parent_id:1,task_kind:'order',role:'agent',title:'已归档 Worker',status:'completed',archived:true}
]};
for (const node of window.graph.nodes) {
  node.merge_queue={counts:{},total:0,items:[],truncated:false};
  node.resources={own:{input:121000,output:18000,cost:2.24,run_ms:3661000,running:node.status==='running'},
    subtree:{input:968000,output:144000,cost:17.92,run_ms:7322000,running:true}};
}
window.graph.nodes[0].merge_queue={counts:{resolving:1,requested:7,blocked:1},total:9,truncated:true,
  items:[{id:2,status:'resolving'},{id:900,status:'requested'},{id:901,status:'blocked'}]};
window.graph.nodes[1].reservation={version:2,kind:'merge',queue_protocol:1,parent_id:1,status:'resolving'};
ui.view={id:'task-graph'}; window.paint=()=>renderTaskGraph(window.graph);
window.refreshGraph=loadTaskGraph;
window.fetch=async(url)=>new URL(url,location.href).pathname==='/api/worker-graph'
  ?Response.json(window.graph):Response.json({error:'no route '+url},{status:404});
window.paint(); window.ready=true;
</script></body></html>`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/') return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
  if (/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.split('/').at(-1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-task-graph-layout-'));
const log = join(temp, 'geckodriver.log');
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log),
});
let session, passed = false;
async function rpc(path, body, method = 'POST') {
  // node:http goes directly to loopback, independent of Bun's inherited fetch proxy settings.
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('WebDriver request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text);
  if (response.status >= 400) throw new Error(JSON.stringify(data));
  return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function click(selector) {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function key(value) {
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [
    { type: 'keyDown', value }, { type: 'keyUp', value },
  ] }] });
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited before startup');
    await Bun.sleep(100);
  }
  assert(ready, 'geckodriver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox',
    'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  assert(await rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0];let n=0;const check=()=>window.ready?done(true):++n>100?done(false):setTimeout(check,30);check();`, args: [] }), 'fixture did not load');
  assert(await execute(`return !document.querySelector('[data-graph-focus="detail-mode"]').checked && !!document.querySelector('.task-graph-minimal');`), 'tree did not default to minimal mode');
  await click('[data-graph-focus="detail-mode"]');
  assert(await execute(`return document.querySelector('[data-graph-focus="detail-mode"]').checked && !document.querySelector('.task-graph-minimal') && !!document.querySelector('.task-graph-result');`), 'details checkbox did not expand cards');
  await click('[data-graph-focus="detail-mode"]');
  assert(await execute(`const usage=document.querySelector('[data-task-id="2"] .task-graph-usage');
    return usage.textContent.includes('$2.24') && usage.firstElementChild.classList.contains('task-graph-usage-runtime')
      && usage.textContent.includes('运行 1 小时 1 分') && getComputedStyle(usage).animationName==='task-usage-live'
      && getComputedStyle(usage.querySelector('.task-graph-usage-input')).color!==getComputedStyle(usage.querySelector('.task-graph-usage-output')).color;`), 'resource values, colors or running animation missing');
  await click('[data-graph-focus="fold-1"]');
  assert(await execute(`const usage=document.querySelector('[data-task-id="1"] .task-graph-usage');
    return usage.classList.contains('is-aggregate') && usage.classList.contains('is-live') && getComputedStyle(usage).fontWeight==='700' && usage.textContent.includes('$17.92');`), 'folded subtree resource total missing');
  await click('[data-graph-focus="fold-1"]');
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1440,900],[900,700],[390,844]]) {
    await rpc(`/session/${session}/window/rect`, { width, height });
    await execute(`document.documentElement.dataset.theme='${theme}'`);
    const layout = await execute(`
      const cards=[...document.querySelectorAll('.task-graph-card')];
      return {heights:cards.map(n=>n.getBoundingClientRect().height),
        overflow:cards.some(n=>{const h=n.querySelector('.task-graph-head');return h.scrollWidth>h.clientWidth+1;}),
        titleWidths:cards.map(n=>n.querySelector('.task-graph-title').getBoundingClientRect().width),
        checkbox:document.querySelector('[data-graph-focus="detail-mode"]').getBoundingClientRect().width,
        pageOverflow:document.documentElement.scrollWidth>innerWidth,
        paragraphs:document.querySelectorAll('.task-graph-goal,.task-graph-result,.task-graph-git').length};`);
    assert(layout.heights.length===8 && layout.heights.every(h=>h===68), `nonuniform rows: ${JSON.stringify(layout)}`);
    assert(!layout.overflow && !layout.pageOverflow && layout.titleWidths.every(w=>w>=48), `clipped controls: ${JSON.stringify(layout)}`);
    assert(layout.checkbox===16 && layout.paragraphs===0, 'minimal mode retained full card content');
    await click('.task-graph-archived-toggle span');
    assert(await execute(`const checkbox=document.querySelector('[data-graph-focus="show-archived"]');return checkbox.checked && checkbox.getBoundingClientRect().width===16 && document.activeElement===checkbox && !!document.querySelector('[data-task-id="99"]') && document.documentElement.scrollWidth<=innerWidth;`), 'archived label did not enable the matching checkbox');
    await key(' ');
    assert(await execute(`return !document.querySelector('[data-graph-focus="show-archived"]').checked && !document.querySelector('[data-task-id="99"]');`), 'Space did not disable archived display');
    await click('[data-task-id="2"] .task-graph-more-trigger');
    const menu = await execute(`const p=document.querySelector(':popover-open');const r=p?.getBoundingClientRect();return {open:!!p,x:r?.x,y:r?.y,right:r?.right,bottom:r?.bottom,width:innerWidth,height:innerHeight,focus:p?.contains(document.activeElement)};`);
    assert(menu.open && menu.focus && menu.x>=0 && menu.y>=0 && menu.right<=menu.width && menu.bottom<=menu.height, `popover escaped viewport/focus: ${JSON.stringify(menu)}`);
    assert(await execute(`const p=document.querySelector(':popover-open');p.querySelector('.agent-call').focus();const t=document.querySelector('#help-tip');return t?.parentNode===p && !t.hidden && t.textContent.includes('Agent');`), 'Agent help was hidden behind top layer');
    assert(await execute(`window.paint();return !!document.querySelector(':popover-open') && [...document.querySelectorAll('.task-graph-card')].every(n=>n.getBoundingClientRect().height===68);`), 'repaint discarded menu or changed row height');
    await key('\uE00C');
    assert(await execute(`return !document.querySelector(':popover-open') && document.activeElement.dataset.graphFocus==='more-2';`), 'Esc did not restore trigger focus');
    console.log(`PASS equal-height tree and native menu ${theme} ${width}x${height}`);
  }
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  await click('[data-task-id="2"] .task-graph-more-trigger');
  await key('\uE004');
  assert(await execute(`return document.querySelector(':popover-open').contains(document.activeElement)`), 'Tab escaped menu before actions');
  await click('.task-graph-hero h1');
  assert(await execute(`return !document.querySelector(':popover-open')`), 'outside click did not dismiss');
  await click('[data-task-id="2"] .task-graph-more-trigger');
  await execute(`document.querySelector('#task-graph-actions-2 > .agent-call').click()`);
  assert(await execute(`return !document.querySelector(':popover-open') && !document.querySelector('#modal').hidden && document.activeElement.id==='modal-input';`), 'operation did not close popover before input dialog');
  await key('\uE00C');
  assert(await execute(`return document.querySelector('#modal').hidden && document.activeElement.dataset.graphFocus==='more-2';`), 'dialog did not restore more trigger');
  await click('[data-task-id="2"] .task-graph-title');
  assert(await execute('return window.openedTask===2'), 'title did not open correct Worker');
  // Real layout: only a same-parent reorder gets finite transform animations.
  const reorder = await execute(`
    document.querySelector('#detail').style.cssText='height:360px;overflow:auto';
    document.activeElement.blur();
    window.graph.nodes[1].reservation.status='requested'; window.paint();
    window.graph.nodes[2].reservation={version:2,kind:'merge',queue_protocol:1,parent_id:1,status:'executing'};
    const anchor=document.querySelector('[data-task-id="2"]');
    const host=document.querySelector('#detail'); host.scrollTop=anchor.offsetTop-40;
    document.querySelector('[data-task-id="2"] .task-graph-title').focus({preventScroll:true});
    window.anchorId=[...document.querySelectorAll('.task-graph-card')].find(n=>n.getBoundingClientRect().bottom>Math.max(0,host.getBoundingClientRect().top)).dataset.taskId;
    window.anchorTop=document.querySelector('[data-task-id="'+window.anchorId+'"]').getBoundingClientRect().top;
    window.paint();
    window.movedCard=document.querySelector('[data-task-id="3"]');
    window.motionEffects=document.getAnimations().filter(a=>a.effect.getKeyframes().some(f=>f.transform));
    window.paint();
    return {count:window.motionEffects.length,durations:window.motionEffects.map(a=>a.effect.getTiming().duration),
      preserved:window.movedCard===document.querySelector('[data-task-id="3"]'),focus:document.activeElement.dataset.graphFocus};`);
  assert(reorder.count>0 && reorder.durations.every(n=>n===250) && reorder.preserved && reorder.focus==='title-2', `invalid FLIP: ${JSON.stringify(reorder)}`);
  await rpc(`/session/${session}/execute/async`, { script: 'const done=arguments[0];Promise.all(window.motionEffects.map(a=>a.finished)).then(()=>done(true));', args: [] });
  assert(await execute(`return Math.abs(document.querySelector('[data-task-id="'+window.anchorId+'"]').getBoundingClientRect().top-window.anchorTop)<2;`), 'reorder lost reading anchor');
  assert(await execute(`window.paint();return !document.getAnimations().some(a=>a.effect.getKeyframes().some(f=>f.transform));`), 'ordinary refresh replayed FLIP');
  assert(await execute(`document.documentElement.dataset.reducedMotion='true';window.graph.nodes[2].reservation.status='pending';window.paint();return !document.getAnimations().some(a=>a.effect.getKeyframes().some(f=>f.transform));`), 'reduced motion played FLIP');
  assert(await execute(`delete document.documentElement.dataset.reducedMotion;const n=document.querySelector('[data-task-id="2"]');const r=document.createRange();r.selectNodeContents(n.querySelector('.task-graph-title'));getSelection().addRange(r);window.graph.nodes[2].reservation.status='executing';window.paint();const kept=n===document.querySelector('[data-task-id="2"]');getSelection().removeAllRanges();return kept;`), 'selection did not protect tree');
  console.log('PASS real FLIP duration, no polling restart, reading anchor/focus, reduced motion and selection protection');
  await rpc(`/session/${session}/refresh`, {});
  assert(await rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0];let n=0;const check=()=>window.ready?done(!document.querySelector('[data-graph-focus="detail-mode"]').checked):++n>100?done(false):setTimeout(check,30);check();`, args: [] }), 'preference did not survive reload');
  await execute(`document.documentElement.dataset.theme='light';`);
  const screenshotPath = process.argv[2] || '/tmp/lush-task-graph-layout.png';
  await Bun.write(screenshotPath, Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
  console.log(`PASS keyboard, outside dismissal, dialog handoff, detail navigation and persistence; screenshot: ${screenshotPath}`);
  passed = true;
} catch (error) {
  console.error(`Browser check failed; geckodriver log: ${log}`); throw error;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true });
}
