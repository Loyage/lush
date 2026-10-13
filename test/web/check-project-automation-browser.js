// Real Firefox -> isolated Host/RPC/SQLite/Git. Browsing and unsaved edits never authorize execution.
// Run: bun run test/web/check-project-automation-browser.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { request } from 'node:http';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';

const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-project-automation-browser-'));
const f = await setup(); f.project.stopping = true; f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
f.project.provider = { run() { throw Error('No real Agent allowed in this fixture'); } };
let driver, wrapper, session, success = false;
const mutations = [], errors = [];
const assert = (ok, message) => { if (!ok) throw Error(message); };
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
async function rpc(suffix, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${suffix}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => text += part);
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(70000, () => req.destroy(Error('WebDriver timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = condition => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0],end=Date.now()+10000;const check=()=>(${condition})?done(true):Date.now()>end?done(false):setTimeout(check,100);check();`, args: [] });
async function click(selector) {
  await execute(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'});`);
  const node = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${node['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
const press = label => execute(`Array.from(document.querySelectorAll('#detail button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`);
async function frame() { const node = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: node }); }
async function route(hash) { await execute(`location.hash=${JSON.stringify(hash)}`); assert(await wait(`location.hash===${JSON.stringify(hash)}&&document.querySelector(${JSON.stringify(hash === '#hooks' ? '.automation-browse' : '.page-subnav')})`), `route ${hash} missing`); }
try {
  await repo(f.root); const main = await f.project.bootstrapMain();
  const { task } = await f.project.order('Browser completion authorization fixture', 'main', [], null, false);
  const dispatch = new Dispatcher(f.project);
  const draft = await dispatch.dispatch('draft.add', { content: 'Browser conditional draft', conditions: [{ kind: 'parent_quiet' }] });
  const waiting = await dispatch.dispatch('draft.add', { content: 'Browser waiting receipt', conditions: [{ kind: 'parent_quiet' }] });
  f.store.run('UPDATE drafts SET emission=? WHERE id=?', JSON.stringify({ state: 'waiting_conditions', signals: [{ kind: 'parent_quiet', satisfied: false }] }), waiting.id);
  const catalogue = await (await fetch(f.url + '/api/hooks')).json();
  assert(catalogue.command_example?.hook_id, 'push identity missing');
  f.store.event(main.id, 'hook.execution_unknown', { hook_id: catalogue.command_example.hook_id, execution_id: 'browser-unknown', error: 'Browser unknown result, no replay', output: 'PRIVATE_RAW_OUTPUT' });
  const host = await (await fetch(f.url + '/api/host/projects')).json(), projectId = host.projects.find(item => item.project === f.root)?.id;
  assert(projectId, 'temporary project not registered');
  // Reads may initialize device metadata; keep the fixture writable while kick remains inert.
  f.project.stopping = false;
  wrapper = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/fixture') return new Response(`<!doctype html><html><body style="margin:0"><iframe id="viewport" style="border:0;width:1440px;height:950px" src="/p/${projectId}/#hooks"></iframe></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    const body = req.method === 'POST' ? await req.text() : null;
    if (url.pathname.endsWith('/api/action') && body) mutations.push(JSON.parse(body));
    const upstream = await fetch(f.url + url.pathname + url.search, { method: req.method, ...(body !== null ? { headers: { 'Content-Type': 'application/json' }, body } : {}) });
    if (upstream.status >= 400) errors.push(`${upstream.status} ${url.pathname}${url.search}`);
    const headers = new Headers(upstream.headers);
    if (headers.has('content-security-policy')) headers.set('content-security-policy', headers.get('content-security-policy').replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
  } });
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(evidence, 'driver.log')), stderr: Bun.file(path.join(evidence, 'driver.log')) });
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {} if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100); }
  assert(ready, 'geckodriver did not start');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', timeouts: { script: 60000 }, 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1100 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${wrapper.port}/fixture` }); await frame();
  assert(await wait(`document.querySelectorAll('.automation-feature').length===4`), 'four-feature directory missing');
  await execute(`document.documentElement.dataset.reducedMotion='true'`);
  assert(await execute(`return !document.querySelector('.hook-signals')&&!document.querySelector('.hook-managers')&&!document.querySelector('.hook-template')`), 'old settings wall remains');
  await execute(`const s=document.querySelector('[aria-label="查找自动化功能"]');s.value='条件';s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
  assert(await execute(`return Array.from(document.querySelectorAll('.automation-feature')).filter(n=>!n.hidden).length===1`), 'directory search failed');
  await click('.automation-feature:not([hidden]) a');
  assert(await wait(`document.querySelector('.automation-emission .input-row')`), 'emission settings missing');
  await execute(`Array.from(document.querySelectorAll('.automation-emission .input-row')).find(n=>n.textContent.includes('Browser conditional draft')).click()`);
  assert(await wait(`document.querySelector('.automation-emission [aria-label="草稿正文"]')`), 'embedded draft editor missing');
  assert(await execute(`return document.querySelector('.emission-conditions').hidden&&Array.from(document.querySelectorAll('.input-actions button')).some(b=>b.textContent==='按条件发射'&&b.classList.contains('agent-call'));`), 'saved draft conditions are intrusive or emission authorization unclear');
  await press('条件发射设置 · 1 项');
  assert(await execute(`return !document.querySelector('.emission-conditions').hidden`), 'explicit condition expansion failed');
  await press('条件发射设置 · 1 项');
  assert(await execute(`return document.querySelector('.emission-conditions').hidden&&document.querySelector('[aria-label="等待目标树彻底静息后发射"]').checked`), 'collapse lost saved conditions');
  await execute(`const t=document.querySelector('[aria-label="草稿正文"]');t.value='unsaved browser draft';t.dispatchEvent(new Event('input',{bubbles:true}));`);
  await click('.page-subnav [data-subpage="history"]');
  assert(await wait(`Array.from(document.querySelectorAll('.automation-emission .input-row')).some(n=>n.textContent.includes('Browser waiting receipt'))`), 'conditional execution receipts missing');
  await click('.page-subnav [data-subpage="settings"]');
  assert(await execute(`return document.querySelector('[aria-label="草稿正文"]').value==='unsaved browser draft'&&location.hash==='#hooks-emission'`), 'tab change lost draft or feature ownership');
  await press('← 返回自动化功能列表');
  assert(await execute(`return document.querySelector('[aria-label="查找自动化功能"]').value==='条件'`), 'return lost directory search');
  await route('#hooks-completion');
  assert(await wait(`document.querySelector('.completion-worker[data-worker-id="${task.id}"]')`), 'actual Worker authorization missing');
  assert(await execute(`return document.querySelector('.completion-worker [data-level="accept"]').classList.contains('agent-call')&&document.querySelector('.completion-defaults a').getAttribute('href')==='/#automation'`), 'completion cost marking or device-default link missing');
  await click('.page-subnav [data-subpage="history"]');
  assert(await wait(`!document.querySelector('.automation-completion-history').hidden`), 'completion history missing');
  await route('#hooks-push-history');
  assert(await wait(`document.querySelector('.push-executions')?.textContent.includes('browser-unknown')`), 'durable push record missing');
  assert(await execute(`return !document.querySelector('.push-history').textContent.includes('PRIVATE_RAW_OUTPUT')&&document.querySelector('.push-history').textContent.includes('不自动重放')`), 'push record privacy or unknown-result rule failed');
  await route('#hooks-convergence');
  assert(await wait(`document.querySelector('.branch-convergence [aria-label="目标分支"]')?.value==='main'&&document.querySelector('.branch-convergence')?.getAttribute('aria-busy')==='false'`), 'convergence policy not ready');
  await route('#management'); assert(await wait(`document.querySelector('.management-settings .hook-signals')`), 'management navigation missing');
  await press('新建时间信号'); await execute(`document.querySelector('[aria-label="信号名称"]').value='unsaved signal';`);
  await click('.page-subnav [data-subpage="history"]'); await click('.page-subnav [data-subpage="settings"]');
  assert(await execute(`return document.querySelector('[aria-label="信号名称"]').value==='unsaved signal'&&!document.querySelector('.branch-convergence')`), 'management draft lost or automation leaked into management');
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame(); await execute(`document.documentElement.dataset.theme='${theme}'`);
    for (const hash of ['#hooks', '#hooks-completion', '#hooks-completion-history', '#hooks-push', '#hooks-push-history', '#hooks-convergence', '#hooks-convergence-history', '#hooks-emission', '#hooks-emission-history', '#management', '#management-history']) {
      await route(hash);
      const marker = hash === '#hooks' ? '.automation-feature-list' : hash.startsWith('#management') ? '.management-page' : hash.includes('completion') ? '.completion-worker' : hash.includes('push') ? '.automation-push' : hash.includes('convergence') ? '.branch-convergence' : '.automation-emission .input-row';
      assert(await wait(`document.querySelector(${JSON.stringify(marker)})`), `page content missing ${hash}`);
      assert(await execute(`return innerWidth===${width}&&document.documentElement.scrollWidth<=innerWidth`), `overflow ${theme}/${width}/${hash}`);
      fs.writeFileSync(path.join(evidence, `${theme}-${width}-${hash.slice(1)}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
    }
    console.log(`PASS directory/four feature settings/history/management ${theme}/${width}px`);
  }
  assert(mutations.length === 0, 'read-only navigation unexpectedly submitted a mutation');
  assert(f.store.draft(draft.id).content === 'Browser conditional draft', 'unsaved draft persisted unexpectedly');
  assert(errors.length === 0, `HTTP failures: ${errors.join(', ')}`);
  fs.writeFileSync(path.join(evidence, 'checks.json'), JSON.stringify({ mutations, errors }, null, 2));
  success = true; console.log('PASS native directory/search/back, feature deep links/tabs, embedded draft retention, authoritative Worker authorization, safe push evidence, independent management drafts, no execution mutation or Agent call');
} catch (error) {
  if (session) {
    try { fs.writeFileSync(path.join(evidence, 'failure-page.json'), JSON.stringify(await execute('return {url:location.href,html:document.documentElement.outerHTML};'))); } catch {}
    try { fs.writeFileSync(path.join(evidence, 'failure.png'), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64')); } catch {}
  }
  throw error;
} finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  if (driver) { driver.kill(); await driver.exited; } wrapper?.stop(true); await f.close();
  console.log(`${success ? 'Browser evidence' : 'Browser failure diagnostics'}: ${evidence}`);
}
