// Firefox + isolated real Host/HTTP/RPC. No user service, account or model calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
import { resource, digest } from '../project/agent-connection-fixture.js';

const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-navigation-links-'));
const f = await setup();
f.project.kick = () => {};
f.project.provider = { run() { throw Error('No real Agent allowed'); } };
const assert = (ok, message) => { if (!ok) throw Error(message); };
const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reserve.port; reserve.stop(true);
let driver, wrapper, session, success = false, holdDiagnostic = false, releaseDiagnostic, diagnosticAborted = false;
const diagnosticReads = [];
const layouts = [];
async function rpc(route, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => text += part);
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(Error('WebDriver timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const result = JSON.parse(response.text);
  if (response.status >= 400) throw Error(JSON.stringify(result));
  return result.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
async function wait(condition) {
  // Poll through document replacement: an async script in the old document is cancelled on navigation.
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try { if (await execute(`return Boolean(${condition})`)) return; } catch {}
    await Bun.sleep(50);
  }
  throw Error(`UI did not settle: ${condition}`);
}
const frame = () => rpc(`/session/${session}/frame`, { id: { 'element-6066-11e4-a52e-4f735466cecf': frameId } });
let frameId;
async function click(selector) {
  await execute(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'});`);
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
const screenshot = async name => fs.writeFileSync(path.join(evidence, `${name}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
try {
  wrapper = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/fixture') return new Response('<!doctype html><html><body style="margin:0"><iframe id="viewport" style="border:0;width:1440px;height:1000px" src="/#docs"></iframe></body></html>', { headers: { 'Content-Type': 'text/html' } });
    if (url.pathname.endsWith('/diagnostics/query')) {
      diagnosticReads.push(url);
      if (holdDiagnostic) {
        req.signal.addEventListener('abort', () => { diagnosticAborted = true; }, { once: true });
        await new Promise(resolve => { releaseDiagnostic = resolve; });
      }
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.text();
    const upstream = await fetch(f.url + url.pathname + url.search, { method: req.method, ...(body !== null ? { headers: { 'Content-Type': 'application/json' }, body } : {}) });
    const headers = new Headers(upstream.headers);
    if (headers.has('content-security-policy')) headers.set('content-security-policy', headers.get('content-security-policy').replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
  } });
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(evidence, 'driver.log')), stderr: Bun.file(path.join(evidence, 'driver.log')) });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw Error('geckodriver exited');
    await Bun.sleep(100);
  }
  assert(ready, 'geckodriver did not start');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1200 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${wrapper.port}/fixture` });
  frameId = (await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }))['element-6066-11e4-a52e-4f735466cecf'];
  await frame(); await wait(`document.querySelector('.doc-row .nav-link')`);
  for (const theme of ['light', 'dark']) for (const width of [1440, 768, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null });
    await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame();
    await execute(`document.documentElement.dataset.reducedMotion='true';document.documentElement.dataset.theme='${theme}';`);
    const result = await execute(`const links=[...document.querySelectorAll('.doc-row .nav-link')];return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,links:links.map(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return {text:n.textContent,left:r.left,right:r.right,height:r.height,minHeight:s.minHeight,expected:parseFloat(s.getPropertyValue('--control-height')),decoration:s.textDecorationLine,radius:s.borderRadius,border:s.borderTopWidth,color:s.color,background:s.backgroundColor,arrow:getComputedStyle(n,'::after').clipPath}}),sidebarDecoration:getComputedStyle(document.querySelector('#docs-open')).textDecorationLine};`);
    layouts.push({ theme, ...result });
    assert(result.width === width && !result.overflow, `document overflow ${theme}/${width}`);
    assert(result.links.every(n => n.left >= 0 && n.right <= width && n.expected === 32 && n.height >= n.expected && n.minHeight === '32px' && n.decoration === 'none' && n.radius === '8px' && n.border === '1px' && n.arrow.startsWith('polygon(')), `navigation style/fit ${theme}/${width}`);
    assert(result.sidebarDecoration === 'none', 'sidebar gained an underline');
    if (width <= 760) {
      const rows = await execute(`const toggle=document.querySelector('#sidebar-toggle'),open=toggle.getAttribute('aria-expanded')==='true';
        if(!open)toggle.click();
        const rows=[...document.querySelectorAll('#sidebar .workspace-link,#sidebar .nav-item')].filter(n=>n.getClientRects().length).map(n=>({text:n.textContent,height:n.getBoundingClientRect().height}));
        if(!open)toggle.click();return rows;`);
      assert(rows.length > 0 && rows.every(row => row.height === 32), `mobile navigation rows must actually shrink: ${JSON.stringify(rows)}`);
    }
    await screenshot(`${theme}-${width}`);
  }
  // Real callback route and Enter activation, with a visible keyboard focus ring.
  await execute(`document.querySelector('.doc-row .nav-link').focus()`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE004' }, { type: 'keyUp', value: '\uE004' }] }] });
  await execute(`document.querySelector('.doc-row .nav-link').focus()`);
  assert(await execute(`const n=document.activeElement;return n.matches('.nav-link:focus-visible')&&getComputedStyle(n).outlineWidth==='2px';`), 'keyboard focus is not visible');
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  await wait(`location.hash.startsWith('#doc-')&&document.querySelector('.doc-body')`);
  assert(await execute(`return [...document.querySelectorAll('.doc-body a')].every(n=>!n.classList.contains('nav-link'));`), 'prose styled as UI navigation');
  await click('.doc-back'); await wait(`location.hash==='#docs'&&document.querySelector('.doc-row .nav-link')`);
  // Native new-tab link, plus exclusions and hidden/long-label regression probes,
  // rendered by the same production factories under the complete real stylesheet stack.
  await rpc(`/session/${session}/execute/async`, { args: [], script: `const done=arguments[0];Promise.all([import('/render-hooks.js'),import('/worker-links.js')]).then(([hooks,refs])=>{const root=document.createElement('section');root.id='navigation-probes';root.style.cssText='display:flex;flex-wrap:wrap;gap:8px;margin:16px 0';const help=hooks.hookHelpLink();help.id='help-probe';const hidden=help.cloneNode(true);hidden.id='hidden-probe';hidden.hidden=true;const long=help.cloneNode(true);long.id='long-probe';long.textContent='打开非常长的页面名称用于验证导航入口在窄屏可以完整换行而不会撑出页面';const text=document.createElement('p');text.textContent='自动引用 W283 D12 N13 O5';refs.linkWorkerNumbers(text);root.append(help,hidden,long,text);document.querySelector('#detail').prepend(root);done(true)}).catch(e=>done(String(e)));` });
  assert(await execute(`const hidden=document.querySelector('#hidden-probe'),long=document.querySelector('#long-probe'),r=long.getBoundingClientRect();return getComputedStyle(hidden).display==='none'&&r.right<=innerWidth&&r.height>=parseFloat(getComputedStyle(long).getPropertyValue('--control-height'))&&getComputedStyle(document.querySelector('.worker-link')).textDecorationLine==='underline'&&[...document.querySelectorAll('.record-link')].every(n=>getComputedStyle(n).textDecorationLine==='underline');`), 'hidden/long-label/reference regression');
  const original = await rpc(`/session/${session}/window`, undefined, 'GET');
  await click('#help-probe');
  let handles = [];
  for (let i = 0; i < 30; i++) { handles = await rpc(`/session/${session}/window/handles`, undefined, 'GET'); if (handles.length > 1) break; await Bun.sleep(100); }
  const opened = handles.find(id => id !== original); assert(opened, 'help link did not open a native new tab');
  await rpc(`/session/${session}/window`, { handle: opened });
  await wait(`location.hash==='#doc-docs-hooks'&&document.querySelector('.doc-body')`);
  assert(await execute(`return window.opener===null`), 'help link exposed opener');
  await rpc(`/session/${session}/window`, undefined, 'DELETE');
  await rpc(`/session/${session}/window`, { handle: original }); await frame();
  assert(await execute(`return location.hash==='#docs'`), 'new-tab help replaced the source page');
  // Hover feedback must not reintroduce an underline through page-specific CSS.
  const help = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#help-probe' });
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', duration: 0, origin: help, x: 0, y: 0 }] }] });
  await wait(`(()=>{const n=document.querySelector('#help-probe'),s=getComputedStyle(n);return n.matches(':hover')&&s.borderTopColor===s.color})()`);
  assert(await execute(`const n=document.querySelector('#help-probe');return n.matches(':hover')&&getComputedStyle(n).textDecorationLine==='none'&&getComputedStyle(n,'::after').transform!=='none';`), 'hover/new-tab arrow feedback failed');
  await screenshot('narrow-help-probes');
  await execute(`location.hash='#agent-status'`);
  await wait(`document.querySelector('.agent-status-head .agent-sources-link')`);
  for (const theme of ['light', 'dark']) for (const width of [1440, 320]) {
    await rpc(`/session/${session}/frame`, { id: null });
    await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame();
    await execute(`document.documentElement.dataset.theme='${theme}'`);
    const source = await execute(`const n=document.querySelector('.agent-status-head .agent-sources-link'),s=getComputedStyle(n),r=n.getBoundingClientRect();return {href:n.getAttribute('href'),display:s.display,decoration:s.textDecorationLine,left:r.left,right:r.right,height:r.height,expected:parseFloat(s.getPropertyValue('--control-height'))};`);
    assert(source.href === '/#model-sources' && source.display === 'inline-flex' && source.decoration === 'none' && source.left >= 0 && source.right <= width && source.expected === 32 && source.height === source.expected, `source management navigation ${theme}/${width}: ${JSON.stringify(source)}`);
    layouts.push({ theme, width, source });
    await screenshot(`sources-entry-${theme}-${width}`);
  }
  await click('.agent-status-head .agent-sources-link');
  await wait(`location.hash==='#model-sources'&&document.querySelector('.model-sources-page')`);
  // Real Worker -> native new tab -> independent project-scoped reader, including reload and Escape.
  await repo(f.root); await f.project.bootstrapMain();
  // Diagnostics uses the actual compiled page, CSP, Host registry, HTTP/RPC and SQLite projection.
  // Seed observations only; no Provider/network probing is involved.
  const action = async (method, params) => {
    const response = await fetch(f.url + '/api/host/settings/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params: { ...params, scope: 'device' } }) });
    assert(response.status === 200, `diagnostics setup ${method}: ${await response.clone().text()}`); return response.json();
  };
  const connection = await action('agent.connections.save', { connection: { label: '诊断浏览器来源', provider: 'deepseek', auth_type: 'api_key', models: ['deepseek-chat'] }, credential: { api_key: 'isolated-fixture-only' } });
  await action('agent.registered_models.save', { model: { name: '诊断命名模型', connection_id: connection.id, model: 'deepseek/deepseek-chat' } });
  const diagnosticWorker = (await f.project.order('diagnostic observations fixture', 'main', [], null, false)).task;
  const run = f.store.startRun(diagnosticWorker, { agent: 'mock' });
  f.store.beginDiagnosticsRun(run.id, connection.id, 'deepseek/deepseek-chat');
  f.store.recordDiagnosticsRun(run.id, { dropped: 1, rows: [{ at: new Date().toISOString(), model: 'deepseek/deepseek-chat', status: 'ok', input_tokens: 50, output_tokens: 20, estimated_cost_usd: .01, response_ms: 1000, text_chars: 12, text_ms: 400, wait_ms: 100, ttft_ms: 200 }] });
  f.store.finishRun(run.id, 'completed');
  const now = Date.now();
  for (const [index, remaining, status] of [[0, 80, 'available'], [1, 60, 'available'], [2, null, 'error'], [3, 55, 'available'], [4, 100, 'available']]) {
    f.store.recordAgentConnectionObservation({ query_key: `browser-diagnostic-${index}`, connection_id: connection.id, provider: 'deepseek', account_key: digest('browser-account'), source_key: digest('browser-source'), observation: { status, checked_at: new Date(now - 6000 + index * 500).toISOString(), source: 'usage_api', resources: [resource(remaining, { reset_at: new Date(now + (index === 4 ? 7200000 : 3600000)).toISOString() })] } });
  }
  await execute(`location.hash='#model-sources-connections'`); await wait(`document.querySelector('.model-source-row .diagnostics-link')`);
  await click('.model-source-row .diagnostics-link');
  await wait(`document.querySelector('.diagnostic-status')?.textContent.includes('读取完成')`);
  assert(diagnosticReads.at(-1).searchParams.get('connection_id') === connection.id && !diagnosticReads.at(-1).searchParams.has('model'), 'source diagnostic binding missing');
  await click('[data-model-sources-tab=models]'); await wait(`document.querySelector('.registered-model-row .diagnostics-link')`);
  await click('.registered-model-row .diagnostics-link'); await wait(`document.querySelector('.diagnostic-status')?.textContent.includes('读取完成')`);
  assert(diagnosticReads.at(-1).searchParams.get('model') === 'deepseek/deepseek-chat', 'model link used registration name instead of actual binding');
  assert(await execute(`return document.querySelector('[data-diagnostic-filter=connection_id]').selectedOptions[0].textContent==='诊断浏览器来源'`), 'known source label did not replace the temporary deep-link ID');
  assert(await execute(`const p=document.querySelector('.runtime-diagnostics-page');return p.textContent.includes('下界')&&p.textContent.includes('丢弃样本 1')&&p.textContent.includes('模型筛选不适用于额度')&&p.textContent.includes('可能重置')&&p.querySelector('.diagnostic-quota-series svg').querySelectorAll('.diagnostic-line').length===1`), 'coverage or quota reset/failure continuity incorrect');
  await execute(`const n=document.querySelector('[data-diagnostic-filter=period]');n.value='7d';n.dispatchEvent(new Event('change'));document.querySelector('[data-diagnostic-apply]').focus()`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  await wait(`document.querySelector('.diagnostic-status')?.textContent.includes('读取完成')`);
  let query = diagnosticReads.at(-1).searchParams;
  assert(Date.parse(query.get('to')) - Date.parse(query.get('from')) === 7 * 86400000, 'keyboard period apply did not submit range');
  await execute(`const n=document.querySelector('[data-diagnostic-filter=project_id]');n.value=[...n.options].find(o=>o.value).value;n.dispatchEvent(new Event('change'));const p=document.querySelector('[data-diagnostic-filter=period]');p.value='custom';p.dispatchEvent(new Event('change'));const local=t=>{const d=new Date(t);return new Date(t-d.getTimezoneOffset()*60000).toISOString().slice(0,16)};document.querySelector('[data-diagnostic-filter=from]').value=local(${now - 3600000});document.querySelector('[data-diagnostic-filter=to]').value=local(${now - 60000});document.querySelector('[data-diagnostic-apply]').click()`);
  await wait(`document.querySelector('.diagnostic-status')?.textContent.includes('读取完成')`);
  query = diagnosticReads.at(-1).searchParams;
  assert(/^[a-f0-9]{16}$/.test(query.get('project_id')) && Date.parse(query.get('to')) - Date.parse(query.get('from')) === 3540000, 'custom range/real project identity not submitted');
  // Restore the default time so the just-recorded samples appear in the layout evidence.
  await execute(`const p=document.querySelector('[data-diagnostic-filter=period]');p.value='24h';p.dispatchEvent(new Event('change'));document.querySelector('[data-diagnostic-apply]').click()`);
  await wait(`document.querySelector('.diagnostic-status')?.textContent.includes('读取完成')`);
  for (const theme of ['light', 'dark']) for (const width of [1440, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame();
    await execute(`document.documentElement.dataset.theme='${theme}'`);
    const bounds = await execute(`const p=document.querySelector('.runtime-diagnostics-page');return {overflow:document.documentElement.scrollWidth-innerWidth,page:p.scrollWidth-p.clientWidth,controls:[...p.querySelectorAll('button,input,select')].filter(n=>n.getClientRects().length).map(n=>{const r=n.getBoundingClientRect();return {name:n.className||n.dataset.diagnosticFilter,width:r.width,height:r.height,expected:parseFloat(getComputedStyle(n).getPropertyValue('--control-height'))}}),folds:[...p.querySelectorAll('.block')].map(n=>n.querySelector('.module-body').hidden)};`);
    assert(bounds.overflow <= 1 && bounds.page <= 1 && bounds.controls.every(n=>n.width<=width&&n.height>=n.expected) && JSON.stringify(bounds.folds) === '[false,false,false,true,true,true]', `diagnostic layout ${theme}/${width}: ${JSON.stringify(bounds)}`);
    layouts.push({ theme, width, diagnostics: bounds }); await screenshot(`diagnostics-${theme}-${width}`);
  }
  holdDiagnostic = true;
  await click('[data-diagnostic-reload]'); await wait(`document.querySelector('.runtime-diagnostics-page').getAttribute('aria-busy')==='true'`);
  await click('[data-model-sources-tab=models]');
  holdDiagnostic = false; releaseDiagnostic?.();
  await wait(`document.querySelector('.registered-model-row')?.checkVisibility()`);
  assert(diagnosticAborted, 'leaving diagnostics did not abort its HTTP request');
  await execute(`document.querySelector('[data-model-sources-tab=sources]').focus()`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE014' }, { type: 'keyUp', value: '\uE014' }] }] });
  await wait(`document.querySelector('[data-model-sources-tab=diagnostics]').getAttribute('aria-selected')==='true'&&document.querySelector('.diagnostic-status')?.textContent.includes('读取完成')`);
  await execute(`location.hash='#projects'`); await wait(`document.querySelector('.dashboard-diagnostics-card .diagnostics-link')`);
  await click('.dashboard-diagnostics-card .diagnostics-link'); await wait(`document.querySelector('.diagnostic-status')?.textContent.includes('读取完成')`);
  assert(!diagnosticReads.at(-1).searchParams.has('connection_id') && !diagnosticReads.at(-1).searchParams.has('model'), 'dashboard did not open unfiltered analysis');
  console.log('PASS compiled diagnostics: source/model/dashboard links, HTTP filters/ranges, quota breaks, coverage, cancellation, keyboard and 320/1440 dual themes');
  const worker = (await f.project.order('Reader navigation browser fixture', 'main', [], null, false)).task;
  for (let index = 0; index < 105; index++) {
    f.store.update(worker.id, { calls: index });
    const run = f.store.startRun(f.store.task(worker.id), { agent: 'mock' }); f.store.finishRun(run.id, 'completed');
    const start = index === 0 ? '00' : index === 1 ? '25' : '30', end = index === 0 ? '20' : '30';
    f.store.run('UPDATE agent_runs SET started_at=?,ended_at=? WHERE id=?', `2026-01-01T00:00:${start}.000Z`, `2026-01-01T00:00:${end}.000Z`, run.id);
  }
  f.store.update(worker.id, { calls: 105 });
  f.store.setProgressPlan(worker.id, { version: 1, items: [
    { key: 'build', label: '实现阶段瓶颈', status: 'completed', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:20Z', duration_ms: 20000 },
    { key: 'test', label: '测试阶段', status: 'completed', started_at: '2026-01-01T00:00:25Z', completed_at: '2026-01-01T00:00:30Z', duration_ms: 5000 },
  ] }); // Recorded evidence fixture; no Provider is run.
  fs.mkdirSync(path.join(f.config.home, 'sessions'), { recursive: true });
  const commandRecords = [], at = ms => new Date(Date.parse('2026-01-01T00:00:00Z') + ms).toISOString();
  for (let index = 0; index < 53; index++) {
    const failed = index < 2, command = index === 52 ? 'sleep 12' : 'echo performance-browser';
    const timeout = index === 51 ? 21 : 20, elapsed = failed ? 7000 : index === 52 ? 12000 : index === 51 ? 1000 : 2000;
    commandRecords.push({ type: 'message', timestamp: at(index * 20000), message: { role: 'assistant', content: [{ type: 'toolCall', id: `browser-${index}`, name: 'bash', arguments: { command, timeout } }] } },
      { type: 'message', timestamp: at(index * 20000 + elapsed), message: { role: 'toolResult', toolCallId: `browser-${index}`, toolName: 'bash', isError: failed,
        content: [{ type: 'text', text: failed ? 'recorded failed attempt' : 'recorded successful attempt' }] } });
  }
  fs.writeFileSync(path.join(f.config.home, 'sessions', `001_lush-task-${worker.id}.jsonl`), commandRecords.map(record => JSON.stringify(record)).join('\n') + '\n');
  const host = await (await fetch(f.url + '/api/host/projects')).json();
  const projectId = host.projects.find(row => row.project === f.root)?.id;
  assert(projectId, 'temporary project missing');
  await rpc(`/session/${session}/frame`, { id: null });
  await execute(`document.querySelector('#viewport').src='/p/${projectId}/'`);
  await wait(`document.querySelector('#viewport').contentDocument?.querySelector('#tasks [data-id="${worker.id}"]')`); await frame();
  await execute(`location.hash='#worker-${worker.id}'`);
  await wait(`document.querySelector('.task-actions .worker-workbench-open')`);
  for (const theme of ['light', 'dark']) for (const width of [1440, 768, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null });
    await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame();
    await execute(`document.documentElement.dataset.theme='${theme}';document.documentElement.dataset.reducedMotion='true'`);
    const checkToolbar = async expanded => {
      const result = await execute(`const bar=document.querySelector('.task-actions'),more=bar.querySelector('.worker-action-more');
        const nodes=[...bar.querySelectorAll('a,button,summary')].filter(n=>n.getClientRects().length&&n.getBoundingClientRect().height>0);
        return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,first:bar.firstElementChild.textContent,
          beforeFacts:bar.previousElementSibling.classList.contains('task-hero'),count:document.querySelectorAll('.worker-workbench-open').length,
          expanded:more.open,controls:nodes.map(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return {text:n.textContent,left:r.left,right:r.right,height:r.height,minHeight:s.minHeight,expected:parseFloat(s.getPropertyValue('--control-height')),primary:n.matches('.agent-call,.control-primary,.modal-confirm,[type="submit"]')}}),
          settingsVisible:!!more.querySelector('.worker-action-settings button')?.getClientRects().length};`);
      assert(result.width === width && !result.overflow && result.first === '打开工作台' && result.beforeFacts && result.count === 1, `toolbar hierarchy ${theme}/${width}: ${JSON.stringify(result)}`);
      assert(result.expanded === expanded && result.settingsVisible === expanded, `toolbar disclosure ${theme}/${width}`);
      assert(result.controls.every(n => n.left >= 0 && n.right <= width && n.expected === (width <= 760 && n.primary ? 44 : 32) && n.height >= n.expected && n.minHeight === `${n.expected}px`), `toolbar targets/fit ${theme}/${width}: ${JSON.stringify(result)}`);
      layouts.push({ theme, width, toolbar: result });
      await screenshot(`toolbar-${theme}-${width}-${expanded ? 'expanded' : 'compact'}`);
    };
    await checkToolbar(false);
    await execute(`document.querySelector('.worker-action-more>summary').focus()`);
    await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'toolbar-keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
    await checkToolbar(true);
    await execute(`document.querySelector('.worker-action-more>summary').focus()`);
    await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'toolbar-keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  }
  for (const width of [1440, 320]) for (const mode of ['transcript', 'code']) {
    await rpc(`/session/${session}/frame`, { id: null });
    await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame();
    const selector = '.worker-workbench-open';
    await execute(`document.querySelector('#input').value='preserve reader source draft';document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'});`);
    await click(selector);
    // Native focus may minimally reveal the anchor. Measure retained reading after that click settles.
    await rpc(`/session/${session}/execute/async`, { args: [], script: 'const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(()=>done()));' });
    const before = await execute(`return {scroll:document.querySelector('#detail').scrollTop,page:scrollY,hash:location.hash}`);
    assert(before.hash === `#worker-${worker.id}`,  'reader click replaced the source route');
    let tabs = [];
    for (let i = 0; i < 30; i++) { tabs = await rpc(`/session/${session}/window/handles`, undefined, 'GET'); if (tabs.length > 1) break; await Bun.sleep(100); }
    const tab = tabs.find(id => id !== original); assert(tab, `${mode}/${width} did not open a new tab`);
    await rpc(`/session/${session}/window`, { handle: tab });
    const hash = `#worker-${worker.id}-execution`;
    const active = mode === 'code' ? '.code-view' : '.transcript-viewport';
    await wait(`location.pathname==='/p/${projectId}/'&&location.hash==='${hash}'&&document.querySelector('.transcript-viewport')`);
    assert(await execute(`return document.querySelector('#execution-tab-transcript-${worker.id}').getAttribute('aria-selected')==='true'&&!document.querySelector('.worker-cli')&&!document.querySelector('.code-view')`), 'workbench must default to records without eager CLI/code');
    if (mode === 'code') { await click(`#execution-tab-code-${worker.id}`); await wait(`document.querySelector('.code-view')`); }
    assert(await execute(`return window.opener===null`), 'reader exposed opener');
    await rpc(`/session/${session}/refresh`, {});
    await wait(`location.hash==='${hash}'&&document.querySelector('.transcript-viewport')`);
    if (mode === 'code') { await click(`#execution-tab-code-${worker.id}`); await wait(`document.querySelector('.code-view')`); }
    assert(await execute(`return !document.querySelector('.transcript-back')&&!document.querySelector('#detail a[href="#worker-${worker.id}"]')`), 'standalone reader offers a Worker return entry');
    await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'reader-keyboard', actions: [{ type: 'keyDown', value: '\uE00C' }, { type: 'keyUp', value: '\uE00C' }] }] });
    assert(await execute(`return location.hash==='${hash}'&&!!document.querySelector('${active}')&&!document.querySelector('.transcript-back')`), 'Escape left the standalone reader');
    await rpc(`/session/${session}/window`, undefined, 'DELETE');
    await rpc(`/session/${session}/window`, { handle: original }); await frame();
    const after = await execute(`return {hash:location.hash,input:document.querySelector('#input').value,scroll:document.querySelector('#detail').scrollTop,page:scrollY,reader:!!document.querySelector('.transcript-dialog')}`);
    assert(after.hash === before.hash && after.input === 'preserve reader source draft' && Math.abs(after.scroll - before.scroll) < 2 && Math.abs(after.page - before.page) < 2 && !after.reader, `reader replaced source state ${mode}/${width}: ${JSON.stringify({ before, after })}`);
    layouts.push({ reader: mode, width, sourcePreserved: true, reload: true, noopener: true });
  }
  // A dedicated analysis bookmark in an exact-size iframe verifies the approved information hierarchy.
  await execute(`location.hash='#worker-${worker.id}-execution-performance'`);
  await wait(`document.querySelector('.performance-status')?.textContent.includes('尚非全部历史')&&!document.querySelector('.performance-controls button').disabled`);
  assert(await execute(`return !document.querySelector('.performance-advanced').open&&!document.querySelector('.performance-stages')&&!document.querySelector('.performance-view').textContent.includes('实现阶段瓶颈')&&document.querySelector('.performance-slow .performance-command').textContent==='echo performance-browser'`), 'analysis still shows plans instead of actual command bottlenecks');
  await click('.performance-controls button:nth-child(2)');
  await wait(`document.querySelector('.performance-status')?.textContent.includes('当前采样范围已扫描完')`);
  assert(await execute(`return document.querySelectorAll('.performance-slow .performance-command-row').length===3&&document.querySelectorAll('.performance-retries .performance-command-row').length===1&&document.querySelector('.performance-retries').textContent.includes('2 / 51')&&document.querySelector('.performance-retries').textContent.includes('明确成功')`), 'exact parameters or repeated failure outcomes were not preserved');
  await execute(`const sort=document.querySelector('[aria-label="慢指令排序"]');sort.value='total_ms';sort.dispatchEvent(new Event('change',{bubbles:true}));`);
  assert(await execute(`return document.querySelector('.performance-slow .performance-command').textContent==='echo performance-browser'`), 'cumulative command sort failed');
  await execute(`const sort=document.querySelector('[aria-label="慢指令排序"]');sort.value='max_ms';sort.dispatchEvent(new Event('change',{bubbles:true}));`);
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame();
    await execute(`document.documentElement.dataset.theme='${theme}'`);
    const layout = await execute(`const root=document.querySelector('.performance-view'),r=root.getBoundingClientRect(),rank=document.querySelector('.performance-ranks'),buttons=[...root.querySelectorAll('button')].filter(n=>n.getClientRects().length);return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth||root.scrollWidth>root.clientWidth,columns:getComputedStyle(rank).gridTemplateColumns.split(' ').length,height:r.height,inside:r.left>=0&&r.right<=innerWidth,ordinary:parseFloat(getComputedStyle(root).getPropertyValue('--control-height')),buttons:buttons.every(n=>n.getBoundingClientRect().height>=parseFloat(getComputedStyle(n).getPropertyValue('--control-height'))),toolbarHeight:document.querySelector('.performance-controls').getBoundingClientRect().height,selects:[...root.querySelectorAll('.performance-sort select')].map(n=>n.getBoundingClientRect().height),metrics:document.querySelector('.performance-summary').textContent,order:[...document.querySelectorAll('.performance-slow .performance-command')].map(n=>n.textContent)};`);
    assert(layout.width === width && !layout.overflow && layout.inside && layout.height > 150 && layout.buttons && layout.toolbarHeight===layout.ordinary && layout.selects.every(height=>height===layout.ordinary) && layout.columns === (width <= 760 ? 1 : 2), `performance layout ${theme}/${width}: ${JSON.stringify(layout)}`);
    assert(layout.metrics.includes('14 秒') && layout.order[0] === 'sleep 12', 'command timing/failure ranking missing'); layouts.push({ theme, performance: layout });console.log(`PASS performance ordinary density ${theme}/${width}: toolbar=${layout.toolbarHeight}, selects=${layout.selects.join(',')}`);
    await screenshot(`performance-${theme}-${width}`);
  }
  await execute(`window.performanceFetch=window.fetch;window.performanceRefreshReads=0;
    window.savedCommand=document.querySelector('.performance-slow .performance-command');
    const range=document.createRange();range.selectNodeContents(window.savedCommand);getSelection().removeAllRanges();getSelection().addRange(range);
    window.selectedCommand=getSelection().toString();
    window.fetch=(url,options)=>String(url).includes('/api/worker/${worker.id}')?new Promise(resolve=>{window.performanceRefreshReads++;window.failPerformanceRefresh=()=>resolve(Response.json({error:'controlled analysis failure'},{status:500}));}):window.performanceFetch(url,options);
    document.querySelector('.performance-controls button').click();document.querySelector('.performance-controls button').click();`);
  assert(await execute(`return window.performanceRefreshReads===1&&document.querySelector('.performance-status').textContent.includes('正在读取')&&window.savedCommand===document.querySelector('.performance-slow .performance-command')&&getSelection().toString()===window.selectedCommand;`),'analysis refresh must retain old sample and selection while reading');
  await execute(`window.failPerformanceRefresh();window.fetch=window.performanceFetch;`);
  await wait(`document.querySelector('.performance-status').textContent.includes('controlled analysis failure')&&!document.querySelector('.performance-controls button').disabled`);
  assert(await execute(`return window.savedCommand===document.querySelector('.performance-slow .performance-command')&&getSelection().toString()===window.selectedCommand&&document.querySelectorAll('.performance-slow .performance-command-row').length===3;`),'failed analysis refresh erased its old sample/selection');
  await click('.performance-controls button');
  await wait(`!document.querySelector('.performance-controls button').disabled&&document.querySelector('.performance-status').textContent.includes('尚非全部历史')`);
  assert(await execute(`return window.savedCommand!==document.querySelector('.performance-slow .performance-command')&&!document.querySelector('.performance-status').textContent.includes('controlled analysis failure');`),'successful analysis refresh did not replace the prior sample');
  await click('.performance-controls button:nth-child(2)');
  await wait(`document.querySelector('.performance-status').textContent.includes('当前采样范围已扫描完')`);
  await execute(`document.querySelector('.performance-retries .performance-attempts').open=true`);
  await click('.performance-retries .performance-source');
  await wait(`document.querySelector('[role="tab"][aria-selected="true"]').textContent==='执行记录'&&document.querySelector('.step-located')`);
  assert(await execute(`return !document.querySelector('.transcript-back')&&document.querySelector('.step-located').textContent.includes('performance-browser')&&document.querySelector('.step-located').textContent.includes('recorded failed attempt')`), 'command analysis did not locate its failed attempt/output');
  fs.writeFileSync(path.join(evidence, 'checks.json'), JSON.stringify(layouts, null, 2));
  success = true;
  console.log('PASS navigation: light/dark × 1440/768/390/320px, native new tab/noopener, Worker transcript/code new tabs + reload/no-Worker-return + preserved source draft/scroll, Shell longest/cumulative + exact-parameter repeated-failure rankings/full-scan/source + exact narrow layouts, callback route/back, keyboard focus/Enter, hover, hidden/long labels and reference/prose exclusions');
} catch (error) {
  if (session) { try { await screenshot('failure'); fs.writeFileSync(path.join(evidence, 'failure-page.json'), JSON.stringify(await execute('return {url:location.href,html:document.documentElement.outerHTML}')));
  } catch {} }
  throw error;
} finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  if (driver) { driver.kill(); await driver.exited; }
  wrapper?.stop(true); await f.close();
  console.log(`${success ? 'Browser evidence' : 'Browser failure diagnostics'}: ${evidence}`);
}
