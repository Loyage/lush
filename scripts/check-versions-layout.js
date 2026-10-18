// Production Web → RPC → Project → SQLite/Git + Firefox. Isolated temporary services only.
// Run: bun run scripts/check-versions-layout.js [screenshot-directory]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { git, repo } from '../test/helpers.js';
import { setup } from '../test/web/harness.js';
import { projectRouteId } from '../src/host/registry.js';

const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-worker-lineage-browser-'));
const output = path.resolve(process.argv[2] || path.join(logs, 'screenshots'));
fs.mkdirSync(output, { recursive: true });
let f, driver, session, base, passed = false;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function rpc(route, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const request = http.request(base + route, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) request.destroy(new Error('WebDriver response too large')); else chunks.push(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() })); res.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(30000, () => request.destroy(new Error('WebDriver timeout')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const value = JSON.parse(response.text);
  if (response.status >= 400) throw new Error(JSON.stringify(value)); return value.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
async function waitFor(expression) {
  assert(await rpc(`/session/${session}/execute/async`, { args: [], script: `const done=arguments[0];let n=0;const check=()=>{try{if(${expression})return done(true)}catch{}if(++n>300)return done(false);setTimeout(check,30)};check();` }), `Timed out: ${expression}`);
}
async function click(selector) {
  // Native WebDriver interaction, centered away from the app's fixed composer.
  await execute(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'});`);
  const node = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${node['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function screenshot(name) {
  fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
}
async function commit(task, file, message) {
  fs.writeFileSync(path.join(task.workspace, file), message);
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', message);
  return git(task.workspace, 'rev-parse', 'HEAD');
}
async function deliver(task) {
  f.store.update(task.id, { status: 'waiting', result: '专项验证完成' });
  f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', task.id);
  await f.project.reserveTask(task.id, 'merge'); f.project.stopping = false; await f.project.driveTaskMerge(task.parent_id);
  assert(f.store.task(task.id).integration === 'merged', `fixture delivery failed ${task.id}`);
  const row = f.store.get("SELECT id,data FROM events WHERE task_id=? AND type='task.merge_integrated' ORDER BY id DESC LIMIT 1", task.id);
  return { id: row.id, ...JSON.parse(row.data) };
}
async function openWorker(id) {
  await execute(`location.hash='#worker-${id}';`);
  await waitFor(`document.querySelector('.worker-versions')?.dataset.workerId==='${id}'`);
  await execute(`document.querySelector('.worker-versions').scrollIntoView({block:'start'});`);
  await waitFor(`document.querySelector('.worker-versions').getAttribute('aria-busy')==='false' && !!document.querySelector('.lineage-origin')`);
}
function contrast(a, b) {
  const lum = value => {
    const rgb = value.match(/[\d.]+/g).slice(0, 3).map(n => Number(n) / 255).map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
async function readability(theme) {
  const colors = await execute(`const p=document.querySelector('.worker-versions'),a=p.querySelector('.lineage-anchor .lineage-node'),s=p.querySelector('.lineage-source .lineage-node'),h=p.querySelector('.lineage-anchor h4');return {background:getComputedStyle(p).backgroundColor,anchor:getComputedStyle(a).color,source:getComputedStyle(s).color,text:getComputedStyle(h).color,card:getComputedStyle(h.closest('.lineage-body')).backgroundColor,filter:getComputedStyle(a).filter};`);
  const ratios = { anchor: contrast(colors.anchor, colors.background), source: contrast(colors.source, colors.background), text: contrast(colors.text, colors.card) };
  assert(ratios.anchor >= 3 && ratios.source >= 3 && ratios.text >= 4.5 && colors.filter === 'none', `theme readability ${theme}: ${JSON.stringify({ colors, ratios })}`);
  return { colors, ratios };
}
const geometryScript = (context = 'document') => `const d=${context},p=d.querySelector('.worker-versions'),r=p.getBoundingClientRect(),cards=[...p.querySelectorAll('.lineage-card')],rails=cards.map(c=>c.querySelector('.lineage-rail').getBoundingClientRect()),bodies=cards.map(c=>c.querySelector('.lineage-body').getBoundingClientRect()),a=p.querySelector('.lineage-origin .lineage-node'),b=p.querySelector('.lineage-source .lineage-node'),gutter=parseFloat(d.defaultView.getComputedStyle(p).getPropertyValue('--lineage-gutter')),ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return {width:d.defaultView.innerWidth,left:r.left,right:r.right,module:p.scrollWidth-p.clientWidth,page:d.documentElement.scrollWidth-d.defaultView.innerWidth,gutter:rails[0].width,descriptionWidth:bodies[0].width,aligned:rails.every((x,i)=>Math.abs(x.width-gutter)<1&&Math.abs(x.right-bodies[i].left)<1&&Math.abs(bodies[i].left-bodies[0].left)<1),dual:ar.right<br.left,laneSpacing:br.left-ar.left,touch:Math.min(ar.width,ar.height,br.width,br.height),origin:a.textContent,source:b.textContent,landing:p.querySelector('.lineage-landing .lineage-parent-node')?.textContent};`;
async function geometry(theme, width) {
  const value = await execute(geometryScript());
  assert(value.left >= 0 && value.right <= value.width + 1 && value.module <= 1 && value.page <= 1 && value.dual && value.aligned && value.gutter >= 96 && value.gutter <= 112 && value.laneSpacing >= 48 && value.touch >= 44 && value.descriptionWidth > value.gutter && value.origin === '◇' && value.source === '●' && value.landing === '□',
    `overflow/unified descriptions ${theme}/${width}: ${JSON.stringify(value)}`);
  return value;
}
async function stickyCheck(theme, width, prefix) {
  // Let reading-anchor observers finish resize/expansion before an explicit scroll.
  await settle();
  await execute(`const p=document.querySelector('.worker-versions'),d=document.querySelector('#detail');if(getComputedStyle(d).overflowY==='visible')scrollBy({top:p.getBoundingClientRect().top-53+180,behavior:'instant'});else d.scrollTop+=p.getBoundingClientRect().top-d.getBoundingClientRect().top+180;`);
  await settle();
  const value = await execute(`const p=document.querySelector('.worker-versions'),h=p.querySelector('.section-title'),r=h.getBoundingClientRect(),d=document.querySelector('#detail'),b=document.querySelector('.project-banners'),n=document.querySelector('#notice-banner'),s=document.querySelector('#sidebar');return {top:r.top,bottom:r.bottom,expected:getComputedStyle(d).overflowY==='visible'?s.getBoundingClientRect().bottom+b.getBoundingClientRect().height:d.getBoundingClientRect().top+(innerWidth<=760?parseFloat(getComputedStyle(d).paddingTop):0),notice:!n.hidden,noticeBottom:n.hidden?0:n.getBoundingClientRect().bottom,toolbarBottom:document.querySelector('.view-toolbar').getBoundingClientRect().bottom,position:getComputedStyle(h).position,cssTop:getComputedStyle(h).top,scrollY,scrollTop:d.scrollTop,rootTop:p.getBoundingClientRect().top,rootHeight:p.getBoundingClientRect().height,bodyOverflow:getComputedStyle(document.body).overflow,detailOverflow:getComputedStyle(d).overflow};`);
  assert(value.position==='sticky' && Math.abs(value.top-value.expected)<2 && value.top>=value.noticeBottom-1 && (width<=760||value.top>=value.toolbarBottom-1), `sticky ${theme}/${width}: ${JSON.stringify(value)}`);
  await screenshot(`${prefix}-${theme}-${width}-sticky`); return value;
}
const settle = () => rpc(`/session/${session}/execute/async`, { args: [], script: 'const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));' });
async function mappingGeometry(context = 'document') {
  await settle();
  const result = await execute(`const d=${context},p=d.querySelector('.worker-versions'),canvas=p.querySelector('.lineage-canvas'),base=canvas.getBoundingClientRect(),paths=[...p.querySelectorAll('.lineage-delivery-edge')],receipts=[...p.querySelectorAll('.lineage-mapping[data-verified="true"]')],pairs=new Set(receipts.map(r=>r.dataset.source+':'+r.dataset.landing)),gutter=parseFloat(d.defaultView.getComputedStyle(p).getPropertyValue('--lineage-gutter'));let maxError=0;const errors=[];
    if(paths.length!==pairs.size)errors.push('pair count');
    for(const receipt of receipts){const found=paths.filter(e=>e.dataset.source===receipt.dataset.source&&e.dataset.landing===receipt.dataset.landing&&e.dataset.deliveries.split(',').includes(receipt.dataset.delivery));if(found.length!==1)errors.push('Event '+receipt.dataset.delivery)}
    for(const edge of paths){const a=d.getElementById(edge.dataset.sourceNode),b=d.getElementById(edge.dataset.targetNode);if(!a?.classList.contains('lineage-node')||!b?.classList.contains('lineage-parent-node')){errors.push('missing real marker');continue}const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect(),start=edge.getPointAtLength(0),end=edge.getPointAtLength(edge.getTotalLength()),err=Math.max(Math.hypot(start.x-(ar.left+ar.width/2-base.left),start.y-(ar.top+ar.height/2-base.top)),Math.hypot(end.x-(br.left+br.width/2-base.left),end.y-(br.top+br.height/2-base.top)));maxError=Math.max(maxError,err);const box=edge.getBBox();if(err>1||edge.getTotalLength()<=0||box.x<-1||box.y<-1||box.x+box.width>gutter+1||box.y+box.height>base.height+1||getComputedStyle(edge).strokeDasharray==='none'||!edge.getAttribute('d').includes(' C ')||!edge.getAttribute('marker-end'))errors.push(edge.dataset.source+':'+edge.dataset.landing)}for(const edge of p.querySelectorAll('.lineage-git-edge')){const a=d.getElementById(edge.dataset.sourceNode).getBoundingClientRect(),b=d.getElementById(edge.dataset.targetNode).getBoundingClientRect(),start=edge.getPointAtLength(0),end=edge.getPointAtLength(edge.getTotalLength()),err=Math.max(Math.hypot(start.x-(a.left+a.width/2-base.left),start.y-(a.top+a.height/2-base.top)),Math.hypot(end.x-(b.left+b.width/2-base.left),end.y-(b.top+b.height/2-base.top)));if(err>1||getComputedStyle(edge).strokeDasharray!=='none'||edge.getBBox().x+edge.getBBox().width>gutter+1)errors.push('real Git '+edge.dataset.child)}return {count:paths.length,maxError,errors,pairs:paths.map(e=>({source:e.dataset.source,landing:e.dataset.landing,events:e.dataset.deliveries,sourceNode:e.dataset.sourceNode,targetNode:e.dataset.targetNode,d:e.getAttribute('d')}))};`);
  assert(result.errors.length === 0, `mapping endpoints/geometry: ${JSON.stringify(result)}`); return result;
}
async function narrowCheck(theme, event, prefix) {
  await execute(`window.narrowMappings?.dispose();document.querySelector('#narrow-check')?.remove();const frame=document.createElement('iframe');frame.id='narrow-check';frame.width=390;frame.height=844;frame.style.cssText='position:fixed;inset:0;z-index:99999;border:0';document.body.append(frame);const doc=frame.contentDocument;doc.open();doc.write('<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:12px"><div id="detail"></div></body></html>');doc.close();for(const sheet of document.querySelectorAll('link[rel="stylesheet"]'))doc.head.append(sheet.cloneNode(true));doc.querySelector('#detail').append(document.querySelector('.worker-versions').cloneNode(true));window.narrowReady=false;
    import('/version-lineage-mappings.js').then(({createLineageMappings})=>{const p=doc.querySelector('.worker-versions'),canvas=p.querySelector('.lineage-canvas'),original=[...p.querySelectorAll('.lineage-delivery-edge')],git=[...p.querySelectorAll('.lineage-git-edge')],origin=p.querySelector('.lineage-origin [data-commit]').dataset.commit,sources=new Map(),targets=new Map(),cells=new Map();for(const marker of p.querySelectorAll('.lineage-node')){const sha=marker.closest('[data-commit]').dataset.commit;sources.set(sha,marker);cells.set(sha,marker.closest('.lineage-rail'))}for(const marker of p.querySelectorAll('.lineage-parent-node')){const card=marker.closest('.lineage-card');targets.set(card.dataset.landing||card.dataset.commit,marker)}const model={origin:{commit:{commit:origin}},rows:git.map(e=>({edges:[{child:e.dataset.child,parent:e.dataset.parent,external:e.dataset.secondary==='true'}]})),connections:original.map(e=>({source:e.dataset.source,landing:e.dataset.landing,events:e.dataset.deliveries.split(',').map(Number)}))};p.querySelector('.lineage-delivery-lines')?.remove();window.narrowMappings=createLineageMappings(p,canvas,()=>frame.isConnected);narrowMappings.present(model,sources,targets,cells);window.narrowReady=true}).catch(e=>browserErrors.push(String(e)));`);
  await waitFor(`window.narrowReady && [...document.querySelector('#narrow-check').contentDocument.querySelectorAll('link')].every(l=>!!l.sheet)`);
  const context = "document.querySelector('#narrow-check').contentDocument";
  const narrow = await execute(geometryScript(context));
  assert(narrow.width === 390 && narrow.module <= 1 && narrow.page <= 1 && narrow.dual && narrow.aligned && narrow.gutter===96 && narrow.descriptionWidth>96 && narrow.laneSpacing>=48 && narrow.touch>=44, `390px overflow/tracks ${theme}: ${JSON.stringify(narrow)}`);
  narrow.mappings = await mappingGeometry(context); await screenshot(`${prefix}-${theme}-390-dual-track`);
  if (event) {
    await execute(`${context}.querySelector('.lineage-mapping[data-delivery="${event}"]').scrollIntoView({block:'center'});`);
    await screenshot(`${prefix}-${theme}-390-delivery-mapping`);
  }
  if (await execute(`return !${context}.querySelector('.version-node-detail').hidden`)) {
    await execute(`${context}.querySelector('.version-node-detail').scrollIntoView({block:'start'});`); await screenshot(`${prefix}-${theme}-390-node-detail`);
  }
  await execute('window.narrowMappings.dispose();document.querySelector("#narrow-check").remove();');
  console.log(`PASS genuine 390px mapping endpoints ${prefix}/${theme}`); return { theme, ...narrow };
}
try {
  f = await setup({ auth: { version: 2, username: 'browser-fixture', password: 'temporary-browser-fixture-password' } });
  f.project.stopping = true; f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root);
  const { task } = await f.project.order('真实版本来源链\n<script>window.injected=true</script>\n' + 'LongInput'.repeat(100));
  f.project.notify(task.id, '吸顶避让验证', '隔离项目中的真实未读告知');
  const origin = task.base_commit;
  const c1 = await commit(task, 'first.txt', '第一轮开发一\n\n完整提交消息');
  const c2 = await commit(task, 'second.txt', '第一轮开发二'); const first = await deliver(task);
  await git(task.workspace, 'merge', 'main', '-m', '同步上轮落点 · 真实第二父外部边');
  const syncCommit = await git(task.workspace, 'rev-parse', 'HEAD');
  let head = syncCommit; const tree = await git(task.workspace, 'rev-parse', 'HEAD^{tree}');
  for (let i = 0; i < 95; i++) head = await git(task.workspace, 'commit-tree', tree, '-p', head, '-m', `自身来源提交 ${i}`);
  await git(task.workspace, 'update-ref', `refs/heads/${task.branch}`, head);
  const child = await f.project.spawn(task.id, '子 Worker 实际交付，保留持久编号');
  await commit(child, 'child.txt', '子 Worker 开发一');
  await commit(child, 'child.txt', '子 Worker 开发二\n\n完整消息 <script>window.injected=true</script>');
  const childDelivery = await deliver(child), childLanding = childDelivery.commit;
  const second = await deliver(task);
  const currentTip = await commit(task, 'unpublished.txt', '两次交付后仍有未交付开发\n\n完整消息 <script>window.injected=true</script>');
  const { task: undelivered } = await f.project.order('完全没有交付但来源链有commit');
  const unpublished = await commit(undelivered, 'unpublished.txt', '没有交付的自身提交');
  const { task: empty } = await f.project.order('只有创建起点，没有自身开发');
  const { task: reclaimed } = await f.project.order('验收回收后仍可恢复全部来源历史');
  await commit(reclaimed, 'history.txt', '回收前来源一');
  await commit(reclaimed, 'history.txt', '回收前来源二'); const reclaimedDelivery = await deliver(reclaimed);
  await f.project.acceptTask(reclaimed.id);
  assert(f.store.task(reclaimed.id).workspace === null, 'fixture did not reclaim history');
  // Controlled persistent receipts over real Git objects, as in the core lineage
  // verifier tests. Runtime-delivered rounds above remain real merge executions.
  const { task: mapped } = await f.project.order('映射几何：多落点、共享落点与origin无新落点');
  const mappedOrigin = mapped.base_commit, special = [];
  let attempt = 90000;
  const record = (source, landing, baseline) => {
    const attempt_id = ++attempt;
    f.store.event(mapped.id, 'merge.baseline_fixed', { attempt_id, baseline });
    const id = f.store.event(mapped.id, 'task.merge_integrated', { source_commit: source, commit: landing, parent_id: mapped.parent_id, squash: true, attempt_id });
    special.push({ id, source, landing }); return id;
  };
  record(mappedOrigin, mappedOrigin, mappedOrigin);
  await git(mapped.workspace, 'commit', '--allow-empty', '-m', '映射来源一'); const sourceOne = await git(mapped.workspace, 'rev-parse', 'HEAD');
  await git(f.root, 'commit', '--allow-empty', '-m', '父侧落点一'); const landingOne = await git(f.root, 'rev-parse', 'HEAD');
  record(sourceOne, landingOne, mappedOrigin); record(sourceOne, landingOne, mappedOrigin);
  await git(f.root, 'commit', '--allow-empty', '-m', '父侧落点二'); const landingTwo = await git(f.root, 'rev-parse', 'HEAD');
  const differentLandingEvent = record(sourceOne, landingTwo, landingOne);
  await git(mapped.workspace, 'commit', '--allow-empty', '-m', '映射来源二（无树变化）'); const sourceTwo = await git(mapped.workspace, 'rev-parse', 'HEAD');
  const sharedEvent = record(sourceTwo, landingOne, landingOne);
  record(sourceTwo, mappedOrigin, mappedOrigin);
  const invalidEvent = record(sourceTwo, 'f'.repeat(40), mappedOrigin);
  const mappedRead = await f.project.workerVersionLineage({ id: mapped.id });
  assert(mappedRead.deliveries.filter(m=>m.delivery_available).length===6 && mappedRead.deliveries.find(m=>m.delivery_id===invalidEvent)?.delivery_available===false, 'special real-object receipt fixture did not pass/fail expected verifier paths');
  const projectPath = `/p/${projectRouteId(f.root)}/`;
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = reservation.port; reservation.stop(true); base = `http://127.0.0.1:${port}`;
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(logs, 'driver.log')), stderr: Bun.file(path.join(logs, 'driver.log')) });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited'); await Bun.sleep(100);
  }
  assert(ready, 'WebDriver startup timeout');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  await rpc(`/session/${session}/url`, { url: `${f.url}/login?next=${encodeURIComponent(projectPath)}` });
  await execute(`document.querySelector('#username').value='browser-fixture';document.querySelector('#password').value='temporary-browser-fixture-password';`);
  await click('form button'); await waitFor(`location.pathname==='${projectPath}' && !!document.querySelector('#overview-open')`);
  // Log real read responses without replacing/mocking the production HTTP/RPC bridge.
  await execute(`window.versionReads=[];window.lineageResponses=[];window.browserErrors=[];addEventListener('error',e=>browserErrors.push(e.message));addEventListener('unhandledrejection',e=>browserErrors.push(String(e.reason)));const original=window.fetch;window.fetch=(url,options)=>{if(String(url).includes('/version-'))versionReads.push(String(url));return original(url,options).then(r=>{if(String(url).includes('/version-lineage?'))r.clone().json().then(data=>lineageResponses.push(data)).catch(()=>{});return r})};location.hash='#worker-${task.id}';`);
  await waitFor(`document.querySelector('.worker-versions')?.dataset.workerId==='${task.id}'`);
  assert(await execute(`return !versionReads.some(p=>p.includes('/version-'))`), 'detail entry eagerly read Git');
  await execute(`document.querySelector('.worker-versions').scrollIntoView({block:'start'});`);
  await waitFor('document.querySelectorAll(".lineage-source").length===30');
  assert(await execute(`return versionReads.filter(p=>p.includes('/version-lineage?')).length===1 && !versionReads.some(p=>p.includes('/version-deliveries')||p.includes('/version-graph')) && document.querySelector('.lineage-origin [data-commit]').dataset.commit==='${origin}' && document.querySelectorAll('.lineage-source')[29].dataset.commit==='${currentTip}' && !!document.querySelector('.lineage-gap') && !document.querySelector('.lineage-fork') && !document.querySelector('.version-input')`), 'direct source/segment semantics failed');
  assert(await execute(`const m=document.querySelector('.lineage-mapping[data-delivery="${second.id}"]');return m?.dataset.source==='${second.source_commit}' && m.dataset.landing==='${second.commit}' && m.dataset.verified==='true' && !!document.querySelector('.lineage-landing[data-landing="${second.commit}"]') && !document.querySelector('.lineage-source[data-commit="${currentTip}"]').parentNode.querySelector('.lineage-mapping')`), 'current source/landing mapping or unpublished commit is wrong');
  assert(await execute(`return document.querySelector('.lineage-source[data-commit="${childLanding}"] .version-task-link').getAttribute('href')==='#worker-${child.id}' && document.querySelector('.lineage-source[data-commit="${childLanding}"] .version-task-link').textContent.includes('${child.worker_number}')`), 'child href/number is not persistent');
  await waitFor(`document.querySelector('.worker-versions').classList.contains('module-long')`);
  assert(await execute(`const p=document.querySelector('.worker-versions');return p.classList.contains('detail-preview')&&!p.classList.contains('module-expanded')&&p.querySelectorAll('.module-body').length===1&&p.querySelectorAll('.module-toggle').length===1&&p.querySelector('.versions-feedback').closest('.module-summary')&&!p.querySelector('.module-body .versions-feedback')`), 'lineage not using shared automatic preview/visible diagnostics');
  await screenshot('direct-lineage-shared-collapsed');
  await click('.worker-versions .module-toggle');
  assert(await execute(`return document.querySelectorAll('.lineage-source').length===30&&document.querySelector('.worker-versions').classList.contains('module-expanded')&&versionReads.filter(p=>p.includes('/version-lineage?')).length===1`), 'expansion altered graph or fetched');
  await screenshot('direct-dual-track-lineage');
  await execute(`document.querySelector('.lineage-mapping[data-delivery="${second.id}"]').scrollIntoView({block:'center'});`);
  await screenshot('source-to-parent-landing-mapping');
  // Origin detail is an allowed lineage snapshot node; landing is receipt-only.
  await click('.lineage-origin .lineage-node'); await waitFor('!!document.querySelector(".version-node-detail .version-message")');
  assert(await execute(`return versionReads.at(-1).includes('/version-lineage-commit?') && versionReads.at(-1).includes('commit=${origin}') && document.querySelector('.version-node-detail .version-sha').textContent==='${origin}'`), 'origin detail did not use signed lineage API');
  await click('.version-node-detail button');
  await execute(`document.querySelector('.lineage-source[data-commit="${currentTip}"] .lineage-node').focus();`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  await waitFor('!!document.querySelector(".version-node-detail .version-message")');
  assert(await execute(`return document.querySelector('.version-message').textContent.includes('<script>') && !window.injected && !!document.querySelector('.version-input') && !document.querySelector('.version-input').open && document.activeElement===document.querySelector('.version-node-detail')`), 'keyboard source detail was not lazy, focused or safe');
  await execute(`document.querySelector('.version-node-detail').scrollIntoView({block:'start'});`); await screenshot('lineage-source-node-detail');
  await execute(`window.savedVersions=document.querySelector('.worker-versions');window.savedBody=savedVersions.querySelector('.module-body');window.savedNode=savedVersions.querySelector('.version-node-detail');window.savedReads=versionReads.length;`);
  f.store.run('UPDATE tasks SET display_title=?,updated_at=? WHERE id=?', '同 Worker 常规刷新验收', '2099-01-01T00:00:00Z', task.id);
  await execute(`dispatchEvent(new Event('visibilitychange'));`);
  await waitFor(`document.querySelector('.task-title')?.textContent==='同 Worker 常规刷新验收'`);
  const repaint = await execute(`return {root:savedVersions===document.querySelector('.worker-versions'),body:savedBody===savedVersions.querySelector('.module-body'),node:savedNode===savedVersions.querySelector('.version-node-detail'),expanded:savedVersions.classList.contains('module-expanded'),reads:versionReads.length,savedReads};`);
  assert(repaint.root&&repaint.body&&repaint.node&&repaint.expanded&&repaint.reads===repaint.savedReads, `same-Worker repaint lost expansion, detail, cache or DOM: ${JSON.stringify(repaint)}`);
  await click('.worker-versions .module-toggle');
  assert(await execute(`return !savedVersions.classList.contains('module-expanded')&&savedNode===savedVersions.querySelector('.version-node-detail')&&document.querySelectorAll('.lineage-source').length===30`), 'collapse removed graph/detail');
  await execute(`savedVersions.querySelector('.lineage-source[data-commit="${currentTip}"] .lineage-node').focus();`);
  await settle();
  const focusReveal = await execute(`const r=document.activeElement.getBoundingClientRect(),h=savedVersions.querySelector('.section-title').getBoundingClientRect();return {expanded:savedVersions.classList.contains('module-expanded'),reads:versionReads.length,savedReads,top:r.top,bottom:r.bottom,headingBottom:h.bottom,composerTop:document.querySelector('.composer').getBoundingClientRect().top};`);
  assert(focusReveal.expanded&&focusReveal.reads===focusReveal.savedReads&&focusReveal.top>=focusReveal.headingBottom-1&&focusReveal.bottom<=focusReveal.composerTop+1, `clipped keyboard focus not visibly revealed: ${JSON.stringify(focusReveal)}`);

  // Both themes in real top-level page and a genuine 390px iframe using production DOM/CSS.
  const geometries = [];
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 500]) {
    await rpc(`/session/${session}/window/rect`, { width, height: 900 });
    await execute(`document.documentElement.dataset.theme='${theme}';document.querySelector('.worker-versions').scrollIntoView({block:'start'});`);
    // Theme transitions must finish before recording colors/screenshots.
    await rpc(`/session/${session}/execute/async`, { args: [], script: 'const done=arguments[0];requestAnimationFrame(()=>setTimeout(()=>done(true),250));' });
    geometries.push({ theme, requestedWidth: width, ...await geometry(theme, width), ...await readability(theme), mappings: await mappingGeometry() });
    await screenshot(`${theme}-${width}-dual-track`);
    geometries.at(-1).sticky = await stickyCheck(theme, width, 'lineage');
    await click('.worker-versions .module-toggle'); await screenshot(`${theme}-${width}-collapsed`);
    const beforeFocus = await execute('return versionReads.length');
    await execute(`document.querySelector('.lineage-source[data-commit="${currentTip}"] .lineage-node').focus();`); await settle();
    const visibleFocus = await execute(`const r=document.activeElement.getBoundingClientRect(),p=document.querySelector('.worker-versions');return {expanded:p.classList.contains('module-expanded'),top:r.top,bottom:r.bottom,headingBottom:p.querySelector('.section-title').getBoundingClientRect().bottom,composerTop:document.querySelector('.composer').getBoundingClientRect().top,reads:versionReads.length};`);
    assert(visibleFocus.expanded&&visibleFocus.reads===beforeFocus&&visibleFocus.top>=visibleFocus.headingBottom-1&&visibleFocus.bottom<=visibleFocus.composerTop+1, `visible keyboard reveal ${theme}/${width}: ${JSON.stringify(visibleFocus)}`);
    geometries.at(-1).focusReveal = visibleFocus;
    await screenshot(`${theme}-${width}-keyboard-reveal`);
    await execute(`document.querySelector('.worker-versions').scrollIntoView({block:'start'});`); await screenshot(`${theme}-${width}-expanded`);
    await execute(`document.querySelector('.version-node-detail').scrollIntoView({block:'start'});`);
    await screenshot(`${theme}-${width}-node-detail`); console.log(`PASS real Worker lineage layout ${theme}/${width}`);
  }
  await rpc(`/session/${session}/window/rect`, { width: 600, height: 1000 });
  for (const theme of ['light', 'dark']) geometries.push(await narrowCheck(theme, second.id, 'lineage'));
  // Forward pagination replaces a segment instead of accumulating the graph.
  for (let page = 2; page <= 4; page++) {
    await click('.versions-more'); await waitFor(`document.querySelector('.versions-feedback').textContent.includes('第 ${page} 页')`);
    assert(await execute(`return document.querySelectorAll('.lineage-source').length<=30 && Number(document.querySelector('.worker-versions').dataset.cachedPages)<=3`), 'graph/cache accumulated unbounded nodes');
  }
  assert(await execute(`const m=document.querySelector('.lineage-mapping[data-delivery="${first.id}"]');return m?.dataset.source==='${c2}' && m.dataset.landing==='${first.commit}' && !!document.querySelector('.lineage-source[data-commit="${c1}"]') && !!document.querySelector('.lineage-fork') && !!document.querySelector('.lineage-git-boundary[data-child="${syncCommit}"][data-parent="${first.commit}"]')`), 'earliest source/first delivery/origin or real sync parent was lost');
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  await execute(`document.querySelector('.lineage-mapping[data-delivery="${first.id}"]').scrollIntoView({block:'center'});`);
  await screenshot('earliest-origin-first-delivery-sync');
  await execute(`document.querySelector('.worker-versions').scrollIntoView({block:'start'});`);
  await screenshot('earliest-origin-first-real-edge');
  const advancedTip = await commit(task, 'advanced.txt', '首屏固定后新增来源提交');
  for (let page = 3; page >= 1; page--) { await click('.versions-newer'); await waitFor(`document.querySelector('.versions-feedback').textContent.includes('第 ${page} 页')`); }
  assert(await execute(`return document.querySelector('.lineage-source[data-commit="${currentTip}"]') && !document.querySelector('.lineage-source[data-commit="${advancedTip}"]')`), 'return to pinned first page re-sampled moving ref');
  await click('.versions-refresh'); await waitFor(`!!document.querySelector('.lineage-source[data-commit="${advancedTip}"]')`);
  assert(await execute(`return lineageResponses.filter(p=>p.tip==='${currentTip}').every(p=>p.snapshot===lineageResponses[0].snapshot) && lineageResponses.at(-1).snapshot!==lineageResponses[0].snapshot`), 'page snapshot identity was not fixed until explicit refresh');
  await screenshot('explicit-refreshed-first-page');
  // Native Worker href, not recursive old delivery graph drilldown.
  await click(`.lineage-source[data-commit="${childLanding}"] .version-task-link`);
  await waitFor(`location.hash==='#worker-${child.id}' && document.querySelector('#detail').dataset.taskId==='${child.id}'`);
  await execute(`document.querySelector('.worker-versions').scrollIntoView({block:'start'});`);
  await waitFor('document.querySelectorAll(".lineage-source").length===2');
  assert(await execute(`return document.querySelector('.task-hero').textContent.includes('${child.worker_number}') && !!document.querySelector('.lineage-mapping[data-delivery="${childDelivery.id}"]') && !document.querySelector('.version-delivery-choice')`), 'native child link did not reach real lineage detail');
  assert(await execute(`const p=document.querySelector('.worker-versions');return p.querySelector('.lineage-overview').textContent.includes('${childDelivery.commit.slice(0,8)}') && p.querySelector('.lineage-overview').textContent.includes('${child.base_commit.slice(0,8)}') && p.querySelectorAll('.lineage-legend span:not(.lineage-direction)').length===3 && p.querySelectorAll('.lineage-source').length===2 && [...p.querySelectorAll('.lineage-mapping')].every(r=>!r.open&&!r.querySelector('summary').textContent.includes('Event')) && p.querySelector('.lineage-source .lineage-body').getBoundingClientRect().height<100 && !!p.querySelector('.lineage-tip-badge')`), 'confirmed default hierarchy/compact rows/receipt disclosure missing');
  await mappingGeometry(); await screenshot('child-native-lineage-detail');
  // Retired #versions bookmark resolves the actual main identity; main remains Git graph/link-only.
  await execute(`location.hash='#versions';`);
  await waitFor(`location.hash==='#worker-${task.parent_id}' && document.querySelector('#detail').dataset.taskId==='${task.parent_id}' && !!document.querySelector('.worker-versions')`);
  await execute(`document.querySelector('.worker-versions').scrollIntoView({block:'start'});`);
  await waitFor('document.querySelectorAll(".version-commit").length>0');
  assert(await execute(`return !document.querySelector('.lineage-list') && !document.querySelector('.version-delivery-choice') && document.querySelectorAll('.version-task-link').length>0 && [...document.querySelectorAll('.version-task-link')].some(l=>l.getAttribute('href')==='#worker-${task.id}')`), 'main must keep real graph and native links only');
  await waitFor(`document.querySelector('.worker-versions').classList.contains('module-long')`);
  assert(await execute(`const p=document.querySelector('.worker-versions');return p.classList.contains('detail-preview')&&!p.classList.contains('module-expanded')&&p.querySelectorAll('.module-toggle').length===1`), 'main did not join shared automatic preview');
  await screenshot('main-shared-collapsed'); await click('.worker-versions .module-toggle');
  await screenshot('legacy-bookmark-main-link-only');
  await stickyCheck('main', 1440, 'main');
  await click('.worker-versions .module-toggle');
  await execute(`document.querySelector('.worker-versions .version-node').focus();`);
  assert(await execute(`return document.querySelector('.worker-versions').classList.contains('module-expanded')`), 'main clipped keyboard focus not revealed');
  await click('.version-node'); await waitFor(`!!document.querySelector('.version-node-detail .version-message')`);
  await click('.version-node-detail button');
  assert(await execute(`return document.querySelector('.version-node-detail').parentElement.classList.contains('module-content')`), 'main cancelNode escaped shared content');
  await openWorker(undelivered.id);
  assert(await execute(`return !!document.querySelector('.lineage-source[data-commit="${unpublished}"]') && document.querySelectorAll('.lineage-mapping').length===0 && !document.querySelector('.version-rounds')`), 'unpublished branch commit was hidden behind empty rounds');
  await screenshot('unpublished-source-without-deliveries');
  await openWorker(empty.id);
  assert(await execute(`return document.querySelectorAll('.lineage-source').length===0 && !!document.querySelector('.lineage-origin') && document.querySelector('.versions-feedback').textContent.includes('尚无自身开发')`), 'empty Worker lost creation origin');
  await screenshot('origin-without-development');
  await openWorker(reclaimed.id);
  assert(await execute(`return document.querySelectorAll('.lineage-source').length===2 && document.querySelector('.version-tip').textContent.includes('分支已回收') && !!document.querySelector('.lineage-mapping[data-delivery="${reclaimedDelivery.id}"]')`), 'reclaimed source history was not recovered from exact persistent source');
  await screenshot('reclaimed-source-history');
  await openWorker(mapped.id);
  const expectedPairs = new Set(mappedRead.deliveries.filter(m=>m.delivery_available).map(m=>`${m.source_commit}:${m.commit}`));
  const specialGeometry = await mappingGeometry();
  assert(specialGeometry.count === 5 && specialGeometry.pairs.every(p=>expectedPairs.has(`${p.source}:${p.landing}`)) && specialGeometry.pairs.some(p=>p.source===mappedOrigin && p.landing===mappedOrigin), 'shared/multiple/origin target paths not complete');
  assert(await execute(`return document.querySelectorAll('.lineage-landing').length===2 && document.querySelectorAll('.lineage-source').length===2 && ![...document.querySelectorAll('.lineage-delivery-edge')].some(p=>p.dataset.deliveries.split(',').includes('${invalidEvent}'))`), 'deduplication or untrusted geometry failed');
  await execute(`document.querySelector('.lineage-mapping[data-delivery="${sharedEvent}"] summary').focus();`);
  assert(await execute(`return [...document.querySelectorAll('.lineage-delivery-edge.is-active')].some(e=>e.dataset.deliveries.split(',').includes('${sharedEvent}'))`), 'keyboard receipt does not distinguish its shared-target edge');
  await screenshot('all-pairs-shared-multiple-origin');
  const beforeExpansion = await execute(`return [...document.querySelectorAll('.lineage-delivery-edge')].find(e=>e.dataset.deliveries.split(',').includes('${sharedEvent}')).getAttribute('d')`);
  await click(`.lineage-source[data-commit="${sourceOne}"] .lineage-node`); await waitFor('!!document.querySelector(".version-node-detail .version-message")');
  await execute(`document.querySelector('.lineage-landing-receipts').open=true;`);
  const expandedMappings = await mappingGeometry();
  assert(await execute(`return [...document.querySelectorAll('.lineage-delivery-edge')].find(e=>e.dataset.deliveries.split(',').includes('${sharedEvent}')).getAttribute('d')!==${JSON.stringify(beforeExpansion)}`), 'expanding node/receipt failed to remeasure mapping endpoints');
  const specialGeometries = [{ stage: 'expanded', ...expandedMappings }];
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 500]) {
    await rpc(`/session/${session}/window/rect`, { width, height: 1000 });
    await execute(`document.documentElement.dataset.theme='${theme}';document.querySelector('.worker-versions').scrollIntoView({block:'start'});`);
    await rpc(`/session/${session}/execute/async`, { args: [], script: 'const done=arguments[0];requestAnimationFrame(()=>setTimeout(()=>done(true),250));' });
    specialGeometries.push({ theme, width, ...await geometry(theme, width), ...await readability(theme), mappings: await mappingGeometry() });
    await screenshot(`pairs-${theme}-${width}-expanded`);
    specialGeometries.at(-1).sticky = await stickyCheck(theme, width, 'pairs');
    await execute(`document.querySelector('.lineage-mapping[data-delivery="${differentLandingEvent}"]').scrollIntoView({block:'center'});`);
    await screenshot(`pairs-${theme}-${width}-multi-target`);
  }
  await rpc(`/session/${session}/window/rect`, { width: 600, height: 1000 });
  for (const theme of ['light', 'dark']) specialGeometries.push(await narrowCheck(theme, sharedEvent, 'pairs'));
  assert((await f.project.workerVersionLineage({ id: task.id })).tip === advancedTip, 'browser reads wrote Git');
  assert(await execute('return browserErrors.length===0'), 'browser emitted errors');
  fs.writeFileSync(path.join(logs, 'evidence.json'), JSON.stringify({ task: task.worker_number, child: child.worker_number, origin, c1, c2, currentTip, advancedTip, first, second, childDelivery, reclaimedDelivery,
    special, mappedOrigin, sourceOne, sourceTwo, landingOne, landingTwo, specialGeometries, geometries, repaint, focusReveal, reads: await execute('return versionReads'), browserErrors: await execute('return browserErrors'), screenshots: output }, null, 2));
  passed = true;
  console.log(`PASS real Web→RPC→SQLite/Git→Firefox: direct dual tracks, full source history/two delivery mappings/unpublished tip; origin/node details; paging/cache/snapshot/refresh; native child/main; no-delivery/empty/reclaimed; every verified shared/multiple/origin-target mapping and expanded-node endpoints; stable 112/96px gutter, curved directional mappings, compact rows and confirmed default hierarchy; shared previews/main, sticky headings, same-Worker repaint and keyboard reveal; two themes 1440/900/500/390. Screenshots: ${output}; logs: ${logs}`);
} catch (error) {
  if (session) {
    await screenshot('failure').catch(() => {});
    fs.writeFileSync(path.join(logs, 'failure.json'), JSON.stringify({ error: String(error), reads: await execute('return window.versionReads || []').catch(() => []), browserErrors: await execute('return window.browserErrors || []').catch(() => []) }, null, 2));
  }
  console.error(`Worker lineage browser failure; full logs: ${logs}`); throw error;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  if (driver) { driver.kill(); await driver.exited; }
  await f?.close();
  console.log(`${passed ? 'PASS' : 'FAIL'} evidence directory: ${logs}`);
}
