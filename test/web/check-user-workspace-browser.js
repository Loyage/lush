// Independent assembled-app Firefox/CSP fixture; only a temporary, controlled Host mock is served.
// Run: bun run test/web/check-user-workspace-browser.js [--compiled]
// --compiled serves the actual buildAssets output over HTTP, with the same controlled Host fixture.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { makeWorld } from './dom-world.js';
import { buildAssets } from '../../src/ui/web/build-assets.js';
const compiled = process.argv.includes('--compiled');
const temp = await mkdtemp(join(tmpdir(), 'lush-user-workspace-browser-'));
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
if (compiled) await buildAssets(assets, temp, 'c'.repeat(32));
const servedAssets = compiled ? temp : assets;
const entryHtml = await Bun.file(join(servedAssets, 'index.html')).text();
const appPath = entryHtml.match(/src="(\/[^"\n]*(?:-app-[^"\n]+|app)\.js)"/)[1];
const world = makeWorld(), calls = [], preferenceWrites = [], assetCalls = [], projectId = 'aaaaaaaaaaaaaaaa'; let offline = false, inboxNotices = [];
const inboxItem = id => ({ project_id: projectId, project_name: 'fixture', project: '/tmp/demo', online: true,
  checked_at: new Date().toISOString(), notice: { id, task_id: 1, task_worker_number: 'W1', kind: 'info', status: 'sent',
    title: `编译提醒 ${id}`, body: 'controlled fixture', created_at: new Date().toISOString(), source_event_id: id,
    lifecycle_type: 'failed', read_at: null, answer: null, answer_source: null,
    sync_identity: id.toString(16).padStart(32, '0'), sync_revision: id, sync_epoch: 'e'.repeat(32) } });
const headers = { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'" };
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const url = new URL(req.url), path = url.pathname;
  if (path === '/fixture') return new Response('<!doctype html><link rel="stylesheet" href="/fixture.css"><iframe id="viewport" src="/"></iframe>', { headers: { ...headers, 'Content-Type': 'text/html' } });
  if (path === '/fixture.css') return new Response('html,body{margin:0}iframe{display:block;width:1440px;height:900px;border:0;max-width:100%}', { headers: { 'Content-Type': 'text/css' } });
  // Track live observer-delay handles before any entry runs. This is a passive timer ledger:
  // real browser time still advances, and cleared/fired timers are removed exactly as scheduled.
  if (path === '/fixture-timers.js') return new Response(`window.fixtureObserverTimers=new Map();window.fixtureTimerEvents=[];
    const schedule=window.setTimeout.bind(window),cancel=window.clearTimeout.bind(window);
    window.setTimeout=(fn,delay,...args)=>{let id;id=schedule(()=>{if(fixtureObserverTimers.has(id))fixtureTimerEvents.push(['fire',id]);fixtureObserverTimers.delete(id);fn(...args)},delay);
      if(delay===3000){fixtureObserverTimers.set(id,new Error().stack);fixtureTimerEvents.push(['set',id])}return id};
    window.clearTimeout=id=>{if(fixtureObserverTimers.has(id))fixtureTimerEvents.push(['clear',id]);fixtureObserverTimers.delete(id);cancel(id)};`, { headers: { 'Content-Type': 'text/javascript' } });
  // WebDriver execute/async uses an isolated script realm in Firefox. Importing app
  // there would instantiate a SECOND module graph. Expose the real page's export instead.
  if (path === '/fixture-control.js') return new Response(`import {boot} from ${JSON.stringify(appPath)};window.fixtureBoot=boot;`, { headers: { 'Content-Type': 'text/javascript' } });
  if (path === '/' || path === `/p/${projectId}/`) {
    const html = entryHtml.replace('<head>', '<head><script src="/fixture-timers.js"></script>')
      .replace('</body>', '<script src="/fixture-control.js" type="module"></script></body>');
    return new Response(html, { headers: { ...headers, 'Content-Type': 'text/html' } });
  }
  if (path.startsWith('/api/') || path.startsWith(`/p/${projectId}/api/`)) {
    calls.push(path + url.search);
    if (path === '/api/host/inbox') return Response.json({ version: 1,
      items: url.searchParams.get('status') === 'open' ? [] : inboxNotices, cursor: null, has_more: false, complete: true,
      projects: [{ id: projectId, name: 'fixture', online: true, checked_at: new Date().toISOString(), error: null, complete: true }] });
    if (offline && path === '/api/host/automation') return Response.json({ error: 'fixture Host offline' }, { status: 503 });
    const options = { method: req.method, ...(req.method === 'POST' ? { body: await req.text() } : {}) };
    if (path === '/api/host/preferences' && req.method === 'POST') preferenceWrites.push(JSON.parse(options.body));
    const logical = path.replace(/^\/p\/[a-f0-9]{16}(?=\/api\/)/, '') + url.search;
    const response = await world.fetchImpl(logical, options);
    return Response.json(await response.json(), { status: response.status || (response.ok ? 200 : 400) });
  }
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) { assetCalls.push(path); return new Response(Bun.file(join(servedAssets, path.slice(1)))); }
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
const asyncExecute = script => rpc(`/session/${session}/execute/async`, { script, args: [] });
const assert = (value, message) => { if (!value) throw Error(message); };
const wait = condition => asyncExecute(`const done=arguments[0];let n=0;const check=()=>(${condition})?done(true):++n>150?done(false):setTimeout(check,30);check();`);
// about:blank may disappear while execute/async runs in a just-opened tab. Wait for
// WebDriver's top-level URL before checking the document, without weakening either assertion.
async function waitUrl(target) {
  for (let i = 0; i < 150; i++) {
    if (await rpc(`/session/${session}/url`, undefined, 'GET') === target) return true;
    await Bun.sleep(30);
  }
  return false;
}
async function click(selector) {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function frame() {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: element });
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {} if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100); }
  assert(ready, 'geckodriver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/fixture` }); await frame();
  assert(await wait(`document.getElementById('detail').dataset.view==='projects'&&!document.getElementById('theme-toggle').disabled`), 'root boot failed');
  const pages = [['settings', 'settings'], ['agent-status', 'agent-status'], ['model-sources', 'model-sources'], ['quick-explain', 'quick-explain'], ['automation', 'automation'], ['global-inbox', 'global-inbox']];
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.getElementById('viewport').style.width='${width}px'`); await frame();
    if (await execute(`return document.documentElement.dataset.theme!=='${theme}'`)) { await click('#theme-toggle'); assert(await wait(`document.documentElement.dataset.theme==='${theme}'`), 'authoritative theme save failed'); }
    for (const [id, view] of pages) {
      await execute(`document.getElementById('${id}-open').click()`);
      assert(await wait(`document.getElementById('detail').dataset.view==='${view}'&&!document.getElementById('detail').textContent.includes('正在加载页面')`), `global ${id} chunk failed`);
      assert(await execute(`return document.documentElement.scrollWidth<=innerWidth&&document.getElementById('detail').scrollWidth<=document.getElementById('detail').clientWidth&&!document.querySelector('button a')&&document.getElementById('composer-shell').hidden&&document.documentElement.dataset.lushSpace==='global'`), `global ${id} layout or partition failed at ${width}/${theme}`);
    }
    assert(!calls.some(path => /^\/api\/(overview|snapshot|worker\/|stats|transcript)/.test(path)), 'root boot/read attached a project');
    console.log(`PASS assembled global pages, authoritative theme and CSP: ${theme} ${width}px`);
  }
  // Replace only the browser permission/delivery capability, never prefs or observer modules.
  await execute(`window.sentNotifications=[];Object.defineProperty(window,'Notification',{configurable:true,value:class {
    static permission='granted';static requestPermission(){throw Error('unexpected permission request')}
    constructor(title,options){sentNotifications.push({title,...options})}close(){}
  }});`);
  assert(await wait(`typeof window.fixtureBoot==='function'`), 'page-owned entry export did not load');
  const reboot = () => asyncExecute(`const done=arguments[0];window.fixtureBoot().then(()=>window.fixtureBoot()).then(()=>done(true)).catch(e=>done({error:e.message}));`);
  const writesBeforeBoot = preferenceWrites.length;
  inboxNotices = [inboxItem(1)];
  world.state.devicePreferences = { ...world.state.devicePreferences, revision: 'compiled-authority-1',
    values: { ...world.state.devicePreferences.values, noticeNotifications: true } };
  assert(await reboot() === true, 'repeated entry boot failed');
  assert(await wait(`document.getElementById('global-inbox-count').textContent==='1'&&fixtureObserverTimers.size===1`), 'compiled observer lost authoritative inbox state');
  assert(await execute('return sentNotifications.length===0'), 'repeated boot replayed historical notifications');
  assert(preferenceWrites.length === writesBeforeBoot, 'repeated boot wrote a cached preference back to Host');
  await execute(`document.getElementById('settings-open').click()`);
  assert(await wait(`document.querySelector('.notice-notification-control button')?.textContent==='关闭系统提醒'`), 'lazy settings did not share authoritative notification prefs');
  await execute(`document.querySelector('.notice-notification-control button').click()`);
  assert(await wait(`document.querySelector('.notice-notification-control button')?.textContent==='开启系统提醒'&&!document.querySelector('.notice-notification-control button').disabled`), 'lazy notification preference save failed');
  assert(world.state.devicePreferences.values.noticeNotifications === false, 'toggle did not ACK to Host');
  inboxNotices.push(inboxItem(2));
  assert(await wait(`document.getElementById('global-inbox-count').textContent==='2'`), 'inbox observer stopped while notifications were disabled');
  assert(await execute('return sentNotifications.length===0'), 'lazy preference disable was not shared with the compiled observer');
  await execute(`document.querySelector('.notice-notification-control button').click()`);
  assert(await wait(`document.querySelector('.notice-notification-control button')?.textContent==='关闭系统提醒'&&!document.querySelector('.notice-notification-control button').disabled`), 'lazy preference enable failed');
  assert(world.state.devicePreferences.values.noticeNotifications === true, 'enable did not ACK to Host');
  // The ACK changes authorization and starts a no-history baseline. Wait for its real
  // scheduled next scan before adding a NEW record, rather than racing that baseline.
  assert(await wait(`document.getElementById('global-inbox-count').textContent==='2'&&fixtureObserverTimers.size===1`), 'authorization baseline did not settle');
  inboxNotices.push(inboxItem(3));
  assert(await wait(`sentNotifications.length===1&&document.getElementById('global-inbox-count').textContent==='3'`), 'new authorized record was lost by a duplicated preference singleton');
  await execute(`document.getElementById('global-inbox-open').click()`);
  assert(await wait(`document.getElementById('detail').textContent.includes('编译提醒 3')`), 'lazy inbox did not render current Host records');
  const writesBeforeSecondBoot = preferenceWrites.length;
  assert(await reboot() === true, 'second repeated boot failed');
  assert(await wait(`document.getElementById('global-inbox-count').textContent==='3'&&fixtureObserverTimers.size===1`), 'observer did not settle after repeated boot');
  assert(preferenceWrites.length === writesBeforeSecondBoot, 'second repeated boot wrote preferences without user action');
  assert(await execute(`return fixtureObserverTimers.size===1`), 'repeated boot retained more than one observer timer');
  inboxNotices.push(inboxItem(4));
  assert(await wait(`sentNotifications.length===2&&document.getElementById('global-inbox-count').textContent==='4'`), 'new record after repeated boot was lost or delivered twice');
  // A busy browser can complete more than one valid scan before WebDriver returns.
  // Count live timers, not wall-clock-dependent HTTP cycles, to test disposal directly.
  assert(await wait(`fixtureObserverTimers.size===1`), 'repeated boot leaked duplicate inbox polling timers');
  assert(await execute(`return new Set(sentNotifications.map(n=>n.tag)).size===2`), 'notification identity dedupe did not survive repeated boot');
  console.log(`PASS ${compiled ? 'compiled' : 'source'} lazy settings, shared notification prefs/inbox, repeated boot and single observer`);
  if (compiled) {
    assert(assetCalls.some(path => /-app-/.test(path)) && assetCalls.some(path => /-appearance-/.test(path)), 'fixture did not fetch both compiled entrypoints');
    assert(!assetCalls.some(path => path === '/app.js' || path === '/appearance.js'), 'compiled fixture fell back to source entrypoints');
    assert(assetCalls.some(path => /-render-settings-/.test(path)) && assetCalls.some(path => /-global-inbox-/.test(path)), 'fixture did not fetch real compiled lazy settings/inbox chunks');
    console.log('PASS compiled HTML, CSS, both entrypoints and lazy chunks served over CSP HTTP without source fallback');
  }
  await execute(`document.getElementById('automation-open').click()`);
  assert(await wait(`Array.from(document.querySelectorAll('#detail button')).some(b=>b.textContent==='开启全局自动选择'&&!b.disabled)`), 'automation never became authoritative');
  await execute(`Array.from(document.querySelectorAll('#detail button')).find(b=>b.textContent==='开启全局自动选择').click()`);
  assert(await wait(`document.getElementById('modal').textContent.includes('已有和新到问题')`), 'authorization omitted existing questions');
  assert(await execute(`return Array.from(document.querySelectorAll('#modal button')).find(b=>b.textContent==='授权并开启').classList.contains('agent-call')`), 'authorization omitted Agent costs');
  await execute(`Array.from(document.querySelectorAll('#modal button')).find(b=>b.textContent==='取消').click();const c=document.querySelector('[aria-label="启用新指令默认自动流程"]');c.checked=true;c.dispatchEvent(new Event('change'));document.querySelector('[data-level="archive"]').click()`);
  offline = true; await execute(`Array.from(document.querySelectorAll('#detail button')).find(b=>b.textContent==='重新读取策略').click()`);
  assert(await wait(`document.getElementById('modal').textContent.includes('放弃未保存更改')`), 'draft reread omitted explicit discard confirmation');
  await execute(`Array.from(document.querySelectorAll('#modal button')).find(b=>b.textContent==='放弃并读取').click()`);
  assert(await wait(`document.getElementById('detail').textContent.includes('fixture Host offline')`), 'offline failure not visible');
  assert(await execute(`const b=Array.from(document.querySelectorAll('#detail button')).find(b=>b.textContent==='保存设备默认'),h=b.parentElement;h.focus();return b.disabled&&h===document.activeElement&&h.getAttribute('tabindex')==='0'&&h.getAttribute('data-help').includes('重新读取')&&document.querySelector('[aria-label="启用新指令默认自动流程"]').checked&&document.querySelector('[data-level="archive"]').getAttribute('aria-pressed')==='true'`), 'offline help or unsaved authorization draft lost');
  console.log('PASS cancelled Agent authorization and focusable offline help preserve the draft'); offline = false;
  await rpc(`/session/${session}/frame`, { id: null });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/p/${projectId}/` });
  assert(await wait(`document.getElementById('detail').dataset.view==='overview'`), 'explicit project boot failed');
  await execute(`document.getElementById('input').value='未提交输入';const d=document.getElementById('detail');d.scrollTop=120;const range=document.createRange();range.selectNodeContents(document.getElementById('view-title'));getSelection().removeAllRanges();getSelection().addRange(range);window.before={scroll:d.scrollTop,quote:getSelection().toString(),view:d.dataset.view};document.getElementById('sidebar-toggle').click()`);
  const original = await rpc(`/session/${session}/window`, undefined, 'GET'); await click('#settings-open');
  const handles = await rpc(`/session/${session}/window/handles`, undefined, 'GET'); assert(handles.length === 2, 'global settings did not open a separate tab');
  await rpc(`/session/${session}/window`, { handle: handles.find(handle => handle !== original) });
  assert(await waitUrl(`http://127.0.0.1:${server.port}/#settings`), 'global tab URL retained a project identity');
  assert(await wait(`location.pathname==='/'&&location.hash==='#settings'&&document.getElementById('detail').dataset.view==='settings'`), 'global tab retained a project identity');
  await rpc(`/session/${session}/window`, undefined, 'DELETE'); await rpc(`/session/${session}/window`, { handle: original });
  assert(await execute(`return document.getElementById('input').value==='未提交输入'&&document.getElementById('detail').dataset.view===before.view&&document.getElementById('detail').scrollTop===before.scroll&&getSelection().toString()===before.quote`), 'native global link destroyed project input, reading position or selection');
  console.log('PASS independent global tab preserves project identity, draft, selection and reading position'); passed = true;
} catch (error) {
  let snapshot; try { snapshot = await execute(`return {url:location.href,count:document.getElementById('global-inbox-count')?.textContent,timers:window.fixtureObserverTimers?.size,stacks:Array.from(window.fixtureObserverTimers?.values()||[]),events:window.fixtureTimerEvents?.slice(-25),sent:window.sentNotifications,error:document.getElementById('error')?.textContent}`); } catch {}
  console.error(`Browser failure; geckodriver log: ${log}; snapshot: ${JSON.stringify(snapshot)}; mock requests: ${JSON.stringify(calls.slice(-15))}`); throw error;
}
finally { if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} } driver.kill(); await driver.exited; server.stop(true); if (passed) await rm(temp, { recursive: true, force: true }); }
