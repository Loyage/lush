// Real assembled shell/CSP fixture, temporary Firefox profile and controlled HTTP only.
// Run: bun run test/web/check-project-maintenance-browser.js [--compiled]
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { makeWorld } from './dom-world.js';
import { buildAssets } from '../../src/ui/web/build-assets.js';

const compiled = process.argv.includes('--compiled');
const temp = await mkdtemp(join(tmpdir(), 'lush-maintenance-browser-'));
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
if (compiled) await buildAssets(assets, temp, 'd'.repeat(32));
const servedAssets = compiled ? temp : assets;
const entry = await Bun.file(join(servedAssets, 'index.html')).text();
const appPath = entry.match(/src="(\/[^"\n]*(?:-app-[^"\n]+|app)\.js)"/)[1];
const world = makeWorld(), mutations = [], project = 'aaaaaaaaaaaaaaaa';
const running = { version: 1, paused: false, phase: 'running', ready_to_restart: false, active_calls: 2,
  pending_operations: 0, affected_count: 0, blockers: ['等待当前调用安全退出'] };
const pausing = { ...running, paused: true, phase: 'pausing', affected_count: 2 };
const paused = { ...pausing, phase: 'paused', ready_to_restart: true, active_calls: 0, blockers: [] };
let model = running, revision = 1, offline = false, reject = false;
const csp = { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'" };
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const url = new URL(req.url), path = url.pathname;
  if (path === '/fixture') return new Response('<!doctype html><link rel="stylesheet" href="/fixture.css"><iframe id="viewport" src="/p/aaaaaaaaaaaaaaaa/"></iframe>', { headers: { ...csp, 'Content-Type': 'text/html' } });
  if (path === '/fixture.css') return new Response('html,body{margin:0}iframe{display:block;width:1440px;height:900px;border:0;max-width:100%}', { headers: { 'Content-Type': 'text/css' } });
  if (path === '/fixture-control.js') return new Response(`import {boot} from ${JSON.stringify(appPath)};window.fixtureBoot=boot;window.fixtureState=async value=>{await fetch('/fixture/state',{method:'POST',body:JSON.stringify(value)});};`, { headers: { 'Content-Type': 'text/javascript' } });
  if (path === '/fixture/state') {
    const next = await req.json(); model = next.model ?? null; offline = next.offline === true; reject = next.reject === true; revision++;
    return Response.json({});
  }
  if (path === '/' || path === `/p/${project}/`) return new Response(entry.replace('</body>', '<script type="module" src="/fixture-control.js"></script></body>'), { headers: { ...csp, 'Content-Type': 'text/html' } });
  if (path.startsWith('/api/') || path.startsWith(`/p/${project}/api/`)) {
    const logical = path.replace(/^\/p\/[a-f0-9]{16}(?=\/api\/)/, '');
    if (['/api/overview', '/api/snapshot'].includes(logical)) {
      if (offline) return Response.json({ error: 'fixture project offline' }, { status: 503 });
      if (url.searchParams.get('revision') === String(revision)) return Response.json({ unchanged: true });
      const snapshot = await (await world.fetchImpl('/api/snapshot')).json();
      snapshot.revision = String(revision); snapshot.status.maintenance = model;
      return Response.json(snapshot);
    }
    const options = { method: req.method, ...(req.method === 'POST' ? { body: await req.text() } : {}) };
    if (logical === '/api/action') {
      const call = JSON.parse(options.body);
      if (['system.interrupt_all', 'system.resume_all'].includes(call.method)) {
        mutations.push({ path, ...call });
        if (reject) return Response.json({ error: 'fixture request rejected' }, { status: 409 });
        model = call.method === 'system.interrupt_all' ? pausing : running; revision++;
        return Response.json(model);
      }
      throw new Error(`Unexpected browser mutation: ${call.method}`);
    }
    const response = await world.fetchImpl(logical + url.search, options);
    return Response.json(await response.json(), { status: response.status || (response.ok ? 200 : 400) });
  }
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(servedAssets, path.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const log = join(temp, 'geckodriver.log');
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log) });
let session, passed = false;
async function rpc(path, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(Error('WebDriver timed out'))); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = condition => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0];let n=0;const check=()=>(${condition})?done(true):++n>250?done(false):setTimeout(check,30);check();`, args: [] });
const assert = (ok, message) => { if (!ok) throw Error(message); };
async function click(selector) {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function frame() {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: element });
}
const state = next => execute(`window.fixtureState(${JSON.stringify(next)});`);
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {} if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100); }
  assert(ready, 'geckodriver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1000 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/fixture` }); await frame();
  assert(await wait(`!document.querySelector('#project-maintenance button').disabled && typeof window.fixtureState==='function'`), 'assembled project boot did not expose maintenance');
  assert(await execute(`const home=document.querySelector('#home');return !document.querySelector('#global-inbox-summary')&&home.tagName==='A'&&home.target==='_blank'&&[...document.querySelectorAll('[data-global-navigation="true"]')].every(node=>node.hidden)&&!document.querySelector('#project-maintenance').hidden;`), 'maintenance restored global project navigation or broke the native upper-workspace link');
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame();
    await execute(`document.documentElement.dataset.theme='${theme}';document.querySelector('#input').value='保留下一条输入';`);
    for (const next of [running, pausing, paused]) {
      await state({ model: next });
      assert(await wait(`document.querySelector('#project-maintenance').dataset.phase===${JSON.stringify(next.phase)}`), 'maintenance projection did not update');
      assert(await execute(`return innerWidth===${width} && document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('#project-maintenance button')].every(b=>{const r=b.getBoundingClientRect();return r.width>=70&&r.height>=${width<=390?44:36}&&r.left>=0&&r.right<=innerWidth;}) && document.querySelector('#input').value==='保留下一条输入';`), `clipped/undersized controls or lost input: ${theme}/${width}/${next.phase}`);
    }
    await execute(`document.querySelector('#project-maintenance .help-host').focus()`);
    assert(await execute(`const h=document.querySelector('#project-maintenance .help-host');return document.activeElement===h && h.getBoundingClientRect().width>0 && h.getAttribute('data-help').includes('维护暂停')`), 'disabled help host has no focusable box');
    const screenshot = await rpc(`/session/${session}/screenshot`, undefined, 'GET');
    await Bun.write(join(temp, `${theme}-${width}.png`), Buffer.from(screenshot, 'base64'));
    console.log(`PASS persistent maintenance phase/input/help/CSP layout: ${theme} ${width}px`);
  }
  await state({ model: running }); assert(await wait(`!document.querySelector('#project-maintenance button').disabled`), 'running reset failed');
  const before = mutations.length; await click('#project-maintenance button');
  assert(await execute(`return document.querySelector('#modal').textContent.includes('包括子 Worker')&&document.querySelector('#modal').textContent.includes('不强杀')&&document.querySelector('#modal').textContent.includes('后台重启后仍保持');`), 'confirmation lost safety/descendant scope');
  await click('#modal .ghost'); assert(mutations.length === before, 'cancel sent mutation');
  await click('#project-maintenance button'); await click('#modal .modal-actions button:last-child');
  assert(await wait(`document.querySelector('#project-maintenance').dataset.phase==='pausing'&&!document.querySelector('#project-maintenance .agent-call').disabled`), 'pause ACK did not keep continue available');
  assert(mutations.length === before + 1, 'pause was duplicated');
  await state({ model: paused, reject: true });
  assert(await wait(`document.querySelector('#project-maintenance').dataset.phase==='paused'`), 'paused reset failed');
  await click('#project-maintenance .agent-call');
  assert(await wait(`document.querySelector('#error').textContent.includes('维护请求未确认')&&!document.querySelector('#project-maintenance .agent-call').disabled`), 'failure did not keep deliberate retry available');
  await state({ model: paused });
  await click('#project-maintenance .agent-call');
  assert(await wait(`document.querySelector('#project-maintenance').dataset.phase==='running'`), 'resume did not apply ACK');
  assert(mutations.length === before + 3 && mutations.every(call => call.path===`/p/${project}/api/action`&&Object.keys(call.params).length===0), 'wrong scope/params or duplicate/restart mutation');
  await state({ model: paused, offline: true });
  assert(await wait(`document.querySelector('#project-maintenance').textContent.includes('离线')`), 'offline projection not observed');
  assert(await execute(`return !document.querySelector('#project-maintenance').textContent.includes('当前可重启')&&[...document.querySelectorAll('#project-maintenance button')].every(b=>b.disabled)`), 'offline retained stale readiness');
  await state({ model: null }); assert(await wait(`document.querySelector('#project-maintenance').textContent.includes('暂不可用')`), 'legacy capability absence not observed');
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  assert(await wait(`document.documentElement.dataset.lushSpace==='global'`), 'global shell not ready');
  assert(await execute(`return document.querySelector('#project-maintenance').hidden`), 'global shell exposes project mutation');
  console.log('PASS application confirmation/cancel, scoped actions, failure/retry, offline/legacy/root safety');
  passed = true; console.log('Screenshots/log fixture:', temp);
} catch (error) { console.error('Browser check failed; fixture/log:', temp, log); throw error; }
finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  driver.kill(); await driver.exited; server.stop(true);
  // Retain browser evidence separately; failed temporary fixtures are kept for diagnostics.
  if (passed) { const evidence = process.env.PI_BROWSER_EVIDENCE; if (evidence) {
    await Bun.write(join(evidence, compiled ? 'compiled-1440.png' : 'source-1440.png'), await Bun.file(join(temp, 'light-1440.png')).arrayBuffer());
    await Bun.write(join(evidence, compiled ? 'compiled-320.png' : 'source-320.png'), await Bun.file(join(temp, 'dark-320.png')).arrayBuffer());
  } await rm(temp, { recursive: true, force: true }); }
}
