// Real Firefox + temporary Project/RPC/HTTP integration. No user daemon or model calls.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { setup, fetch } from './harness.js';

const f = await setup(); f.project.kick = () => {};
const task = f.store.create({ role: 'agent', task_kind: 'order', goal: '规划历史浏览器验证' });
const steps = revision => [{ key: 'inspect', label: `检查 ${revision}` }, { key: 'test', label: `测试 ${revision}` }];
for (let i = 0; i < 13; i++) f.project.reportProgressPlan(task.id, steps(i));
f.project.completeProgressStep(task.id, 'inspect');
f.project.message(task.id, '追加开发'); f.project.reportProgressPlan(task.id, steps(12));
f.store.event(task.id, 'task.auto_titled', { auto_title: '自动标题独立筛选' });
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const html = (await Bun.file(join(assets, 'index.html')).text()).replace('<script type="module" src="/app.js"></script>', '');
const fixture = html.replace('</body>', `<script>
window.fixtureErrors=[];
window.addEventListener('error',e=>window.fixtureErrors.push(e.message||e.target?.src||String(e.error)),true);
window.addEventListener('unhandledrejection',e=>window.fixtureErrors.push(String(e.reason?.stack||e.reason)));
</script><script type="module">
try {
const [{renderDetail},{loadDetail},{refreshProgressDurations},{ui}]=await Promise.all([
  import('/render-detail.js'),import('/detail.js'),import('/render-progress.js'),import('/state.js')]);
window.fixtureStage='imports loaded';
ui.selected=${task.id}; ui.detailTask=${task.id}; ui.view={id:'task',key:'task-${task.id}'};
const nativeFetch=window.fetch.bind(window);window.supplementReleases=[];window.supplementPaths=[];window.holdSupplements=false;
window.fetch=async(url,options)=>{const path=new URL(url,location.href).pathname;
  if(window.holdSupplements&&(path==='/api/worker/${task.id}/history-page'||path==='/api/worker/${task.id}/diff'
    ||path==='/api/worker/${task.id}/usage'||path==='/api/agent/connections')) {
    window.supplementPaths.push(path);await new Promise(resolve=>window.supplementReleases.push(resolve));
  }
  return nativeFetch(url,options);};
window.progressiveRefresh=()=>loadDetail(${task.id});
window.releaseSupplements=()=>{window.holdSupplements=false;for(const release of window.supplementReleases.splice(0))release();};
window.refresh=async()=>{window.fixtureStage='inspect';window.task=await(await fetch('/api/worker/${task.id}')).json();window.fixtureStage='render';renderDetail(window.task,null,null,null);};
window.tick=()=>refreshProgressDurations(document.getElementById('detail'));
await window.refresh();window.ready=true;
} catch(error) { window.fixtureErrors.push(String(error.stack||error)); }
</script></body>`);
const requestedPaths = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const url = new URL(req.url); requestedPaths.push(url.pathname);
  if (url.pathname === '/host') return new Response('<!doctype html><body style="margin:0"><iframe id="fixture" src="/" style="width:1440px;height:900px;border:0;display:block"></iframe></body>', { headers: { 'Content-Type': 'text/html' } });
  if (url.pathname === '/') return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
  if (url.pathname.startsWith('/api/')) return fetch(f.url + url.pathname + url.search);
  if (url.pathname === '/administrator/project-protocol.js') return new Response(Bun.file(new URL('../../src/administrator/project-protocol.js', import.meta.url)));
  if (/^\/[\w.-]+\.(js|css)$/.test(url.pathname)) {
    const file = Bun.file(join(assets, url.pathname.slice(1)));
    if (!await file.exists()) console.error('Missing browser asset:', url.pathname);
    return new Response(file);
  }
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-operation-browser-'));
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
  await execute(`const frame=document.getElementById('fixture');frame.style.width='${width}px';frame.style.height='${height}px';`);
  const frame = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#fixture' });
  await rpc(`/session/${session}/frame`, { id: frame });
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
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1100 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/host` });
  await viewport(1440, 900);
  assert(await wait('window.ready'), 'fixture failed to load: '+JSON.stringify(await execute('return {errors:window.fixtureErrors,stage:window.fixtureStage,ready:document.readyState,resources:performance.getEntriesByType("resource").slice(-5).map(e=>e.name)};'))+' paths: '+JSON.stringify(requestedPaths.slice(-15)));
  assert(await execute(`return !document.querySelector('.progress-history-panel')&&
    document.querySelector('#detail>.task-progress-panel progress').value===0;`), 'plan module must only show the current reset plan');
  await click('.conversation-more');
  assert(await execute(`return !document.querySelector('.conversation-operation')&&
    ['progress','auto_title','delegation','communication','notification'].every(key=>document.querySelector('[data-conversation-filter="'+key+'"]').getAttribute('aria-pressed')==='false');`), 'collaboration records must be opt-in');
  await click('[data-conversation-filter="progress"]');
  assert(await wait(`document.querySelectorAll('.conversation-operation').length===28`), 'real operation history reading failed');
  assert(await execute(`const record=[...document.querySelectorAll('.conversation-operation')].find(n=>n.entry.operationType==='progress.completed');
    return record.querySelectorAll('li').length===0&&record.querySelector('progress').value===1&&record.querySelector('progress').max===2
      &&record.querySelector('.operation-completed-name').textContent==='检查 12';`), 'completion must show only the completed name and saved completion meter');
  assert(await execute(`return [...document.querySelectorAll('.conversation-operation')].every(n=>!n.classList.contains('conversation-long'))&&
    document.querySelectorAll('.conversation-operation-steps li').length>=54;`), 'full plan steps are not visible by default');
  assert(await wait(`!document.querySelector('.conversation-panel .detail-preview-toggle').hidden`), 'long progress history needs a module preview control');
  if (!await execute(`return document.querySelector('.conversation-panel').classList.contains('detail-preview-expanded');`)) {
    await click('.conversation-panel .detail-preview-toggle');
  }
  for (const theme of ['light', 'dark']) {
  await execute(`document.documentElement.dataset.theme='${theme}';`);
  for (const [width, height] of [[1440,900],[390,700],[320,560]]) {
    await viewport(width, height);
    assert(await execute(`const n=document.querySelector('#detail');return innerWidth===${width}&&n.scrollWidth<=n.clientWidth+1&&
      [...document.querySelectorAll('.conversation-filter')].every(n=>getComputedStyle(n).display!=='none'&&(${width}>760||n.getBoundingClientRect().height>=44));`), 'horizontal overflow, wrong viewport or inaccessible filters');
    assert(await execute(`const root=document.querySelector('.operation-completion'),meter=root.querySelector('progress'),name=root.querySelector('.operation-completed-name');
      const r=root.getBoundingClientRect(),m=meter.getBoundingClientRect(),n=name.getBoundingClientRect();
      const fill=getComputedStyle(meter,'::-moz-progress-bar').backgroundColor;
      return m.height>=6&&m.left>=r.left&&m.right<=r.right+1&&m.bottom<=r.bottom+1&&n.right<=r.right+1
        &&fill!=='rgba(0, 0, 0, 0)'&&fill!=='transparent';`), 'completion meter must have a visible fill and remain fully contained at every width');
    if (process.env.BROWSER_ARTIFACTS) {
      await execute(`document.querySelector('#composer-launcher').style.visibility='hidden';`);
      await mkdir(process.env.BROWSER_ARTIFACTS, { recursive: true });
      for (const [name, selector] of [['plan', '.operation-step-line'], ['completion', '.operation-completion']]) {
        await execute(`document.querySelector('${selector}').closest('.conversation-message').scrollIntoView({block:'center'});`);
        const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector === '.operation-step-line' ? '[data-conversation-category="progress"]' : '.operation-completion' });
        const png = await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/screenshot`, undefined, 'GET');
        await Bun.write(join(process.env.BROWSER_ARTIFACTS, `${name}-${theme}-${width}.png`), Buffer.from(png, 'base64'));
      }
    }
    if (process.env.BROWSER_ARTIFACTS) await execute(`document.querySelector('#composer-launcher').style.visibility='';`);
    console.log('PASS opt-in categories and progress layout', theme, width, height);
  }
  }
  await execute(`document.documentElement.dataset.theme='light';`);
  await viewport(1440, 900);
  assert(await execute(`window.old=document.querySelector('.conversation-operation');window.oldText=window.old.textContent;
    window.tick();return window.old.textContent===window.oldText&&
    !document.querySelector('.conversation-operation .is-running-duration');`), 'history is not frozen');
  assert(await execute(`return document.querySelector('.conversation-more').hidden;`), 'exhaustion not shown');
  await execute(`return window.refresh();`);
  assert(await execute(`return document.querySelectorAll('.conversation-operation').length===28&&
    document.querySelector('.conversation-operation')===window.old;`), 'refresh lost operation nodes');
  await click('[data-conversation-filter="progress"]');
  assert(await wait(`!document.querySelector('.conversation-operation')`), 'progress filter failed');
  await click('[data-conversation-filter="auto_title"]');
  assert(await execute(`return document.querySelectorAll('.conversation-operation').length===1&&document.querySelector('.conversation-operation').dataset.conversationCategory==='auto_title';`), 'automatic titles are not independently selectable');
  await click('[data-conversation-filter="auto_title"]');
  await click('[data-conversation-filter="progress"]');
  assert(await execute(`return document.querySelectorAll('.conversation-operation').length===28;`), 'progress filter lost loaded history');
  f.project.message(task.id, '再次追加'); f.project.reportProgressPlan(task.id, steps(12));
  await execute(`return window.refresh();`);
  // Refresh signals the changed range; only an explicit history read acquires new records.
  await click('.conversation-more');
  assert(await wait(`document.querySelectorAll('.conversation-operation').length===30`), 'appended plan operations missing');
  assert(await execute(`return document.querySelector('#detail>.task-progress-panel progress').value===0&&
    document.querySelectorAll('.conversation-operation').length===30&&window.old.isConnected;`), 'new input replaced history');
  console.log('PASS real HTTP operation reading, frozen snapshots, filtering, refresh and appended work');
  assert(await execute(`window.holdSupplements=true;return window.progressiveRefresh();`), 'progressive refresh waited for supplements');
  assert(await wait(`window.supplementPaths.includes('/api/worker/${task.id}/history-page')`), 'history request did not start');
  assert(await execute(`return document.querySelector('#detail').textContent.includes('改动加载中')
    &&!document.querySelector('.detail-diff > summary')
    &&!window.supplementPaths.some(path=>path.endsWith('/usage'))
    &&document.querySelectorAll('.conversation-operation').length===30
    &&[...document.querySelectorAll('.conversation-operation')].includes(window.old);`), 'progressive refresh lost operation history or read unnecessary content');
  assert(await wait(`window.supplementPaths.includes('/api/worker/${task.id}/diff')`), 'automatic diff read did not start');
  await execute(`window.old.querySelector('.conversation-copy').focus();window.historyAnchorTop=window.old.getBoundingClientRect().top;window.releaseSupplements();`);
  assert(await wait(`!window.holdSupplements`), 'supplements were not released');
  await execute(`document.activeElement.blur();`);
  assert(await wait(`!document.querySelector('#detail').textContent.includes('改动加载中')`), 'supplement update did not finish');
  const reading = await execute(`return {count:document.querySelectorAll('.conversation-operation').length,
    anchorTop:window.old.getBoundingClientRect().top,before:window.historyAnchorTop,
    ticking:!!document.querySelector('.conversation-operation .is-running-duration')};`);
  assert(reading.count===30&&Math.abs(reading.anchorTop-reading.before)<=1&&!reading.ticking,
    'late supplements changed history reading state: '+JSON.stringify(reading));
  console.log('PASS real progressive detail preserves frozen operation history and reading position under slow supplements');
  passed = true;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true); await f.close();
  if (passed) await rm(temp, { recursive: true, force: true }); else console.error('Browser failure log:', log);
}
