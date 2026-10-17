// Real Firefox + isolated HTTP/RPC/Git. Explicit confirmation only, no paid Provider or user service.
import fs from 'node:fs';
import path from 'node:path';
import { request } from 'node:http';
import { setup, fetch } from './harness.js';
import { acceptanceFixture } from '../acceptance-fixture.js';
const evidence = process.env.LUSH_TEST_EVIDENCE || '/tmp/lush-w318-logs/browser';
fs.mkdirSync(evidence, { recursive: true });
const f = await setup();
let driver, wrapper, session;
const mutations = [], layouts = [];
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const assert = (ok, message) => { if (!ok) throw Error(message); };
async function rpc(suffix, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${suffix}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => text += part); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(Error('WebDriver timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const value = JSON.parse(response.text); assert(response.status < 400, JSON.stringify(value)); return value.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = condition => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0],end=Date.now()+8000;const check=()=>(${condition})?done(true):Date.now()>end?done(false):setTimeout(check,30);check();`, args: [] });
const press = label => execute(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)}).click();`);
try {
  const { parent, child } = await acceptanceFixture(f);
  const projects = await (await fetch(f.url + '/api/host/projects')).json();
  const projectId = projects.projects.find(row => row.project === f.root)?.id; assert(projectId, 'project not registered');
  wrapper = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/fixture') return new Response(`<!doctype html><html><body style="margin:0"><iframe id="viewport" style="border:0;width:1440px;height:950px" src="/p/${projectId}/#worker-${parent.id}"></iframe></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    const body = req.method === 'POST' ? await req.text() : null;
    if (url.pathname.endsWith('/api/action') && body) mutations.push(JSON.parse(body));
    const response = await fetch(f.url + url.pathname + url.search, { method: req.method,
      ...(body !== null ? { headers: { 'Content-Type': 'application/json' }, body } : {}) });
    const headers = new Headers(response.headers);
    if (headers.has('content-security-policy')) headers.set('content-security-policy', headers.get('content-security-policy').replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    return new Response(await response.arrayBuffer(), { status: response.status, headers });
  } });
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(evidence, 'driver.log')), stderr: Bun.file(path.join(evidence, 'driver.log')) });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100);
  }
  assert(ready, 'driver unavailable');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox',
    'moz:firefoxOptions': { args: ['-headless'] }, timeouts: { script: 15000 } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1100 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${wrapper.port}/fixture` });
  const iframe = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' });
  await rpc(`/session/${session}/frame`, { id: iframe });
  assert(await wait(`Array.from(document.querySelectorAll('.iteration-actions button')).some(b=>b.textContent==='验收')`), 'accept button unavailable');
  assert(await execute(`return !Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='强制验收…')`), 'force must not be default');
  await press('验收');
  assert(await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='强制验收…')`), 'missing explicit fallback');
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null });
    await execute(`document.querySelector('#viewport').style.width='${width}px'`);
    await rpc(`/session/${session}/frame`, { id: iframe });
    await execute(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await press('强制验收…'); assert(await wait(`document.querySelector('.force-acceptance-dialog')`), 'confirmation missing');
    const layout = await execute(`const c=document.querySelector('.force-acceptance-dialog'),d=c.querySelector('.modal-detail'),b=c.querySelector('.modal-confirm'),r=c.getBoundingClientRect(),br=b.getBoundingClientRect();return {width:innerWidth,theme:document.documentElement.dataset.theme,card:{left:r.left,right:r.right},detailOverflow:d.scrollWidth-d.clientWidth,button:{width:br.width,height:br.height},agent:b.classList.contains('agent-call'),text:c.textContent};`);
    assert(layout.card.left >= 0 && layout.card.right <= width + 1, `dialog out of viewport ${width}`);
    assert(layout.detailOverflow <= 1, `paths do not wrap ${width}`);
    assert(layout.button.height >= 44 && !layout.agent, `button target/Agent marking ${width}`);
    assert(layout.text.includes(child.worker_number) && layout.text.includes('child.cancelled') && layout.text.includes('失败/取消'), 'risk summary missing');
    layouts.push(layout);
    fs.writeFileSync(path.join(evidence, `${theme}-${width}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
    await press('取消');
  }
  assert(!mutations.some(row => row.method === 'worker.accept_force'), 'cancel must not mutate');
  await press('强制验收…'); assert(await wait(`document.querySelector('.force-acceptance-dialog')`), 'final confirmation missing');
  await press('跳过所列通知并验收回收');
  assert(await wait(`document.querySelector('#error')?.textContent.includes('验收完成')`), 'completion missing');
  assert(f.store.task(parent.id).status === 'completed' && f.store.task(child.id).status === 'cancelled', 'outcome changed');
  assert(mutations.filter(row => row.method === 'worker.accept_force').length === 1, 'duplicate force mutation');
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ layouts, mutations }, null, 2));
  console.log(`Firefox: six theme/viewport checks and real forced acceptance passed; ${evidence}`);
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  if (driver) { driver.kill(); await driver.exited; }
  if (wrapper) wrapper.stop(true);
  await f.close();
}
