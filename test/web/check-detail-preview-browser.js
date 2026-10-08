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
window.paint=()=>renderDetail(window.task,window.fixtureHistory,null,null);
window.reveal=revealDetailPreview;
window.paint(); window.ready=true;
</script></body>`);
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
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
  for (const [width, height] of [[1440,900],[390,700],[320,560]]) for (const theme of ['light','dark']) {
    await rpc(`/session/${session}/window/rect`, { width, height });
    await execute(`document.documentElement.dataset.theme='${theme}';window.paint();`);
    assert(await wait(`document.querySelector('.goal-panel').classList.contains('detail-preview-long')`), 'long goal not measured');
    const sizes = await execute(`return [...document.querySelectorAll('.detail-preview')].map(n=>({
      title:n.querySelector('h2').textContent,body:n.querySelector('.detail-preview-body').getBoundingClientRect().height,
      limit:n.querySelector('.detail-preview-limit').getBoundingClientRect().height,
      footer:getComputedStyle(n.querySelector('.detail-preview-footer')).display,
      controls:n.querySelectorAll('.detail-preview-toggle').length,
      headerControl:!!n.querySelector('.section-title>.detail-preview-toggle'),
      footerControl:!!n.querySelector('.detail-preview-footer .detail-preview-toggle'),
      natural:n.querySelector('.detail-preview-content').getBoundingClientRect().height}));`);
    assert(sizes.length >= 8, 'missing reading modules');
    for (const size of sizes) {
      assert(size.body <= size.limit + 1 && size.limit <= 240, `${width}/${theme}: ${JSON.stringify(size)}`);
      assert((size.footer !== 'none') === (size.natural > size.limit + 1), 'short/long control mismatch');
      assert(size.controls === 1 && size.headerControl && !size.footerControl, 'module must have only a header toggle');
    }
    assert(await execute(`return document.querySelector('#detail').scrollWidth<=document.querySelector('#detail').clientWidth+1;`), 'horizontal page overflow');
    assert(await execute(`return !document.querySelector('.task-actions .detail-preview-body') &&
      !document.querySelector('.goal-panel').classList.contains('detail-preview-expanded');`), 'actions clipped or expanded by default');
    console.log('PASS bounded modules', width, height, theme);
  }
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  await execute(`window.resizeProbe=[...document.querySelectorAll('.detail-preview')].find(n=>n.querySelector('h2').textContent==='Worker 依赖');
    const fixed=document.createElement('div');fixed.style.height='180px';fixed.textContent='短模块高度响应测试';
    window.resizeProbe.querySelector('.detail-preview-content').replaceChildren(fixed);`);
  assert(await wait(`window.resizeProbe.querySelector('.detail-preview-toggle').hidden`), '180px module should fit a tall viewport');
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 450 });
  assert(await wait(`!window.resizeProbe.querySelector('.detail-preview-toggle').hidden`), 'height-only resize clipped a short module without an expand control');
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  assert(await wait(`window.resizeProbe.querySelector('.detail-preview-toggle').hidden`), 'height-only resize left a redundant expand control');
  await execute('window.paint();');
  await click('.result-panel .section-title .detail-preview-toggle');
  assert(await execute(`const n=document.querySelector('.result-panel');return n.classList.contains('detail-preview-expanded')&&
    n.querySelector('.detail-preview-body').getBoundingClientRect().height>1000&&n.textContent.includes('最后一段结果');`), 'result expansion lost body');
  assert(await execute(`window.savedGoal=document.querySelector('.goal-panel');window.savedResult=document.querySelector('.result-panel');
    window.savedMessage=document.querySelector('.task-message');window.paint();return document.querySelector('.result-panel')===window.savedResult&&
    document.querySelector('.goal-panel')===window.savedGoal&&document.querySelector('.task-message')===window.savedMessage&&
    window.savedResult.classList.contains('detail-preview-expanded');`), 'refresh reset reading state/nodes');
  await click('.result-panel .section-title .detail-preview-toggle');
  assert(await execute(`const n=document.querySelector('.result-panel');return !n.classList.contains('detail-preview-expanded')&&
    n.querySelector('.detail-preview-body').getBoundingClientRect().height<=240;`), 'collapse not bounded');
  assert(await execute(`const n=document.querySelector('.agent-panel');const target=n.querySelector('.detail-preview-content button');target.focus();
    return n.classList.contains('detail-preview-expanded')&&document.activeElement===target;`), 'keyboard focus stayed clipped');
  assert(await execute(`const n=[...document.querySelectorAll('.detail-preview')].find(n=>n.querySelector('h2').textContent==='消息');
    const last=n.querySelectorAll('.task-message')[19];window.reveal(last);return n.classList.contains('detail-preview-expanded');`), 'reference reveal failed');
  await execute(`const short=[...document.querySelectorAll('.detail-preview')].find(n=>n.querySelector('h2').textContent==='Worker 依赖');
    window.short=short;const extra=document.createElement('p');extra.textContent='新增历史\\n'.repeat(300);extra.style.whiteSpace='pre-wrap';
    short.querySelector('.detail-preview-content').append(extra);`);
  assert(await wait(`window.short.classList.contains('detail-preview-long')&&!window.short.querySelector('.detail-preview-toggle').hidden`), 'lazy growth did not expose expand control');
  await execute(`window.task={...window.task,id:8,worker_number:'W8'};window.paint();`);
  assert(await execute(`return [...document.querySelectorAll('.detail-preview')].every(n=>!n.classList.contains('detail-preview-expanded'));`), 'state leaked into other Worker');
  console.log('PASS height-only resize, expand/collapse, refresh, focus, reference reveal, lazy growth and Worker isolation');
  passed = true;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true }); else console.error('Browser failure log:', log);
}
