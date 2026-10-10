// Real Firefox + temporary Project/RPC/HTTP integration. No user daemon or model calls.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { setup, fetch } from './harness.js';

const f = await setup(); f.project.kick = () => {};
const task = f.store.create({ role: 'agent', task_kind: 'order', goal: '规划历史浏览器验证' });
const steps = revision => [{ key: 'inspect', label: `检查 ${revision}` }, { key: 'test', label: `测试 ${revision}` }];
for (let i = 0; i < 13; i++) f.project.reportProgressPlan(task.id, steps(i));
f.project.completeProgressStep(task.id, 'inspect');
f.project.message(task.id, '追加开发'); f.project.reportProgressPlan(task.id, steps(12));
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const html = (await Bun.file(join(assets, 'index.html')).text()).replace('<script type="module" src="/app.js"></script>', '');
const fixture = html.replace('</body>', `<script type="module">
import { renderDetail } from '/render-detail.js';
import { loadDetail } from '/detail.js';
import { refreshProgressDurations } from '/render-progress.js';
import { ui } from '/state.js';
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
window.refresh=async()=>{window.task=await(await fetch('/api/worker/${task.id}')).json();renderDetail(window.task,null,null,null);};
window.tick=()=>refreshProgressDurations(document.getElementById('detail'));
await window.refresh();window.ready=true;
</script></body>`);
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === '/') return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
  if (url.pathname.startsWith('/api/')) return fetch(f.url + url.pathname + url.search);
  if (/^\/[\w.-]+\.(js|css)$/.test(url.pathname)) return new Response(Bun.file(join(assets, url.pathname.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-w149-browser-'));
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
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  assert(await wait('window.ready'), 'fixture failed to load');
  assert(await execute(`return document.querySelectorAll('.progress-history-version').length===10&&
    [...document.querySelectorAll('.progress-history-version')].every(n=>!n.open)&&
    document.querySelector('#detail>.task-progress-panel progress').value===0;`), 'initial folding/current reset failed');
  for (const [width, height] of [[1440,900],[390,700],[320,560]]) {
    await rpc(`/session/${session}/window/rect`, { width, height });
    assert(await execute(`const n=document.querySelector('#detail');return n.scrollWidth<=n.clientWidth+1;`), 'horizontal overflow');
    console.log('PASS history layout', width, height);
  }
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  await click('.progress-history-version summary');
  assert(await execute(`window.old=document.querySelector('.progress-history-version');window.oldText=window.old.textContent;
    window.tick();return window.old.open&&window.old.textContent===window.oldText&&
    !document.querySelector('.progress-history-panel .is-running-duration');`), 'expanded history is not frozen');
  assert(await wait(`!document.querySelector('.progress-history-panel .detail-preview-toggle').hidden`), 'expanded history has no full-reading control');
  // Focusing the native summary can already reveal the whole module for keyboard accessibility.
  if (!await execute(`return document.querySelector('.progress-history-panel').classList.contains('detail-preview-expanded');`)) {
    await click('.progress-history-panel .detail-preview-toggle');
  }
  await click('.progress-history-controls button');
  assert(await wait(`document.querySelectorAll('.progress-history-version').length===13`), 'real history pagination failed');
  assert(await execute(`return document.querySelector('.progress-history-controls button').hidden;`), 'exhaustion not shown');
  await execute(`return window.refresh();`);
  assert(await execute(`return document.querySelectorAll('.progress-history-version').length===13&&
    document.querySelector('.progress-history-version')===window.old&&window.old.open;`), 'refresh lost historical nodes or open state');
  f.project.message(task.id, '再次追加'); f.project.reportProgressPlan(task.id, steps(12));
  await execute(`return window.refresh();`);
  assert(await execute(`return document.querySelectorAll('.progress-history-version').length===14&&
    document.querySelector('#detail>.task-progress-panel progress').value===0&&window.old.open;`), 'new input replaced history');
  console.log('PASS real HTTP pagination, frozen timers, retained expansion, refresh and appended work');
  assert(await execute(`window.holdSupplements=true;return window.progressiveRefresh();`), 'progressive refresh waited for supplements');
  assert(await wait(`window.supplementPaths.includes('/api/worker/${task.id}/history-page')`), 'history request did not start');
  assert(await execute(`return document.querySelector('#detail').textContent.includes('改动加载中')
    &&!document.querySelector('.detail-diff > summary')
    &&!window.supplementPaths.some(path=>path.endsWith('/usage'))
    &&document.querySelectorAll('.progress-history-version').length===14&&window.old.open
    &&[...document.querySelectorAll('.progress-history-version')].includes(window.old);`), 'progressive refresh lost folded history, pagination, or read unnecessary content');
  assert(await wait(`window.supplementPaths.includes('/api/worker/${task.id}/diff')`), 'automatic diff read did not start');
  await execute(`window.old.querySelector('summary').focus();window.historyAnchorTop=window.old.querySelector('summary').getBoundingClientRect().top;window.releaseSupplements();`);
  assert(await wait(`!window.holdSupplements`), 'supplements were not released');
  await execute(`document.activeElement.blur();`);
  assert(await wait(`!document.querySelector('#detail').textContent.includes('改动加载中')`), 'supplement update did not finish');
  const reading = await execute(`return {count:document.querySelectorAll('.progress-history-version').length,open:window.old.open,
    exhausted:document.querySelector('.progress-history-controls button').hidden,
    anchorTop:window.old.querySelector('summary').getBoundingClientRect().top,before:window.historyAnchorTop,
    ticking:!!document.querySelector('.progress-history-panel .is-running-duration')};`);
  // Supplementary conversation content above history may change scrollTop; preserve the visible anchor instead.
  assert(reading.count===14&&reading.open&&reading.exhausted&&Math.abs(reading.anchorTop-reading.before)<=1&&!reading.ticking,
    'late supplements changed history reading state: '+JSON.stringify(reading));
  console.log('PASS real progressive detail preserves loaded/open frozen history and reading position under slow supplements');
  passed = true;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true); await f.close();
  if (passed) await rm(temp, { recursive: true, force: true }); else console.error('Browser failure log:', log);
}
