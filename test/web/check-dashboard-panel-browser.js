// Compiled real panel + grid + private v5 writer, isolated controlled source APIs.
// No user daemon/Host, real credentials, provider queries or model calls.
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { buildAssets } from '../../src/ui/web/build-assets.js';
import { readDashboardSettings, saveDashboardSettings } from '../../src/core/dashboard-settings.js';
import { newWidget } from '../../src/ui/web/assets/dashboard-widget-model.js';
import { makeWorld } from './dom-world.js';
const temp = await mkdtemp(join(tmpdir(), 'lush-widget-panel-'));
const output = process.argv[2] || join(tmpdir(), 'lush-widget-panel-results');
await mkdir(output, { recursive: true });
const assets = join(temp, 'assets');
await buildAssets(new URL('../../src/ui/web/assets/', import.meta.url).pathname, assets, 'd'.repeat(32));
const entry = await Bun.file(join(assets, 'index.html')).text();
const config = { deviceHome: join(temp, 'shared') }, P = 'aaaaaaaaaaaaaaaa', Q = 'bbbbbbbbbbbbbbbb', R = 'cccccccccccccccc';
const ids = Array.from({ length: 100 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const world = makeWorld(), calls = [], queries = [], saves = [], reads = [];
const resources = Array.from({ length: 8 }, (_, i) => ({ id: `quota-${i}`, kind: i === 7 ? 'balance' : 'quota', scope: 'account',
  label: `窗口${i} ${'较长指标名称'.repeat(10)}`, unit: i === 7 ? 'USD' : '%', remaining: i === 7 ? 12.5 : 75, used_percent: i === 7 ? null : 25,
  reset_at: '2028-10-01T00:00:00Z', window_seconds: 18000 }));
world.state.agentConnections.connections = ids.map((id, i) => ({ id, label: `账户${i + 1} ${'长名称'.repeat(16)}`, provider: 'deepseek', enabled: true,
  observation: { status: 'available', source: 'usage_api', checked_at: '2026-10-01T00:00:00Z', resources } }));
const workers = Array.from({ length: 12 }, (_, i) => ({ id: 30 - i, worker_number: `W234-${i + 1}`, auto_title: '当前工作 ' + '具体变化'.repeat(30), status: 'waiting', integration: 'none' }));
const development = { workers_total: 31, active: 2, agents_running: 1, awaiting_acceptance: 3, parent_confirmation: 2, pending_merges: 1,
  merging: 0, merge_conflicts: 0, counts: [{ status: 'running', count: 2 }, { status: 'waiting', count: 5 }], recent_workers: workers.slice(0, 3) };
const projects = [{ id: P, name: '项目A', project: '/fixture/project-a', running: true, summary: { notices: 4, development } },
  { id: Q, name: '项目B', project: '/fixture/project-b', running: false },
  { id: R, name: '纯导航项目', project: '/fixture/project-c', running: true }];
const question = { id: 19, task_id: 27, task_worker_number: 'W234-1', kind: 'questionnaire', status: 'open', title: '待答 ' + '具体决策'.repeat(60), body: '', created_at: '2026-10-01T00:00:00Z' };
const infos = [20, 18, 16, 14, 12].map(id => ({ id, task_id: 27, task_worker_number: 'W234-1', kind: 'info', status: 'sent', source_event_id: id,
  read_at: null, title: `告知${id} ` + '变化信息'.repeat(60), body: '', created_at: '2026-10-01T00:00:00Z', sync_identity: id.toString(16).padStart(32, '0'), sync_epoch: 'e'.repeat(32), sync_revision: 1 }));
let sourceState = 'normal', rejectRead = false, diagnosticsState = 'partial', diagnosticReads = 0;
function diagnosticSnapshot() {
  const generated_at = new Date().toISOString(), unavailable = diagnosticsState === 'none';
  return { version: 1, generated_at, currency: 'USD', estimated: true,
    windows: [60, 300].map(seconds => ({ seconds, input: 12000, output: 1200, cost: 0.12, requests: 2,
      input_per_second: 12000 / seconds, output_per_second: 1200 / seconds, cost_per_minute: 0.12 * 60 / seconds,
      unknown_tokens: 1, unknown_cost: 1, complete: false })),
    buckets: Array.from({ length: 60 }, (_, i) => ({ at: new Date(Date.now() - (59 - i) * 10000).toISOString(), input: i * 100, output: i * 10, cost: i / 1000, unknown_tokens: diagnosticsState === 'all-partial' || i === 20 ? 1 : 0, unknown_cost: diagnosticsState === 'all-partial' || i === 10 ? 1 : 0 })),
    coverage: { projects_total: unavailable ? 0 : 3, projects_online: unavailable ? 0 : 2, projects_reporting: unavailable ? 0 : 2, complete: false },
    projects: unavailable ? [] : projects.map(project => ({ id: project.id, name: project.name, state: project.running ? 'online' : 'offline', generated_at: project.running ? generated_at : null })) };
}
const widgets = ['status', 'messages', 'workers', 'accounts', 'shortcuts'].map(type => newWidget(type, `widget:${type}`, ['status', 'messages', 'workers'].includes(type) ? P : null));
widgets.find(w => w.type === 'accounts').connection_ids = ids.slice(0, 4);
widgets.find(w => w.type === 'shortcuts').links = ['notices', 'project-management', 'model-sources', 'settings'].map(target => ({ scope: 'global', target, project_id: null }))
  .concat([P, R].flatMap(project_id => ['workers', 'inputs', 'versions', 'notices'].map(target => ({ scope: 'project', target, project_id }))));
widgets.push(newWidget('messages', 'widget:messages-2', P), newWidget('messages', 'widget:offline', Q));
const layout = [{ id: 'widget:status', x: 0, y: 0, w: 4, h: 10 }, { id: 'widget:messages', x: 4, y: 0, w: 4, h: 10 },
  { id: 'widget:workers', x: 8, y: 0, w: 4, h: 12 }, { id: 'widget:accounts', x: 0, y: 12, w: 6, h: 14 },
  { id: 'widget:shortcuts', x: 6, y: 12, w: 6, h: 10 }, { id: 'widget:messages-2', x: 6, y: 22, w: 6, h: 10 },
  { id: Q, x: 6, y: 0, w: 6, h: 24 }, { id: R, x: 6, y: 24, w: 6, h: 10 }];
saveDashboardSettings(config, { widgets, layout }, readDashboardSettings(config).revision);
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'";
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const url = new URL(req.url), path = url.pathname;
  if (path === '/fixture') return new Response('<!doctype html><link rel="stylesheet" href="/fixture.css"><iframe id="viewport" src="/"></iframe>', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': csp } });
  if (path === '/fixture.css') return new Response('html,body{margin:0}iframe{display:block;width:1440px;height:900px;border:0;max-width:100%}', { headers: { 'Content-Type': 'text/css' } });
  if (path === '/fixture-errors.js') return new Response("window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));addEventListener('securitypolicyviolation',e=>fixtureErrors.push('CSP:'+e.violatedDirective));", { headers: { 'Content-Type': 'text/javascript' } });
  if (path === '/') return new Response(entry.replace('<head>', '<head><script src="/fixture-errors.js"></script>'), { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': csp } });
  if (path.startsWith('/api/') || path.startsWith('/p/')) {
    calls.push({ path: path + url.search, method: req.method });
    if (path === '/api/host') return Response.json({ mode: 'bound', projects, restart_supported: false });
    if (path === '/api/host/projects') return Response.json({ projects });
    if (path === '/api/host/diagnostics') { diagnosticReads++; return diagnosticsState === 'error'
      ? Response.json({ error: '受控诊断错误' }, { status: 503 }) : Response.json(diagnosticSnapshot()); }
    if (path === '/api/host/dashboard') {
      if (req.method === 'POST') { const { expected_revision, ...patch } = await req.json(); saves.push(patch);
        try { return Response.json(saveDashboardSettings(config, patch, expected_revision)); } catch { return Response.json({ error: 'revision changed' }, { status: 400 }); } }
      return Response.json(readDashboardSettings(config));
    }
    if (path.endsWith('/appearance')) return Response.json({ id: path.split('/')[4], appearance: { version: 1, color: 'rose' } });
    if (path === `/p/${P}/api/workers`) { const before = Number(url.searchParams.get('before') || Infinity), limit = Number(url.searchParams.get('limit')); const all = workers.filter(w => w.id < before), page = all.slice(0, limit);
      return Response.json({ tasks: page.slice().reverse(), cursor: page.at(-1)?.id || null, has_more: all.length > page.length, limit }); }
    if (path === `/p/${P}/api/notices`) {
      if (sourceState === 'error') return Response.json({ error: 'controlled read failure' }, { status: 503 });
      const all = sourceState === 'empty' ? [] : url.searchParams.get('status') === 'open' ? [question] : infos.filter(n => !n.read_at);
      const page = all.slice(0, 3);
      return Response.json({ notices: page, total: url.searchParams.get('status') === 'open' && all.length ? 4 : all.length, cursor: page.at(-1)?.id || null, has_more: all.length > page.length });
    }
    if (path === '/api/host/inbox/action') {
      const body = await req.json(); reads.push(body);
      if (rejectRead) return Response.json({ error: 'controlled read failure' }, { status: 503 });
      const notice = infos.find(n => n.id === body.id);
      if (body.project_id !== P || body.method !== 'notice.read' || body.expected_identity !== notice?.sync_identity) return Response.json({ error: 'identity mismatch' }, { status: 400 });
      notice.read_at = '2026-10-12T10:00:00Z';
      return Response.json({ project_id: P, project_name: '项目A', project: projects[0].project, online: true, notice });
    }
    if (path === '/api/host/settings/action') { const body = await req.json();
      if (body.method === 'agent.connections.query') { queries.push(body.params.id); return Response.json({ ...world.state.agentConnections, configuration_scope: { selected: 'device', source: 'device', project_override: false } }); }
      const res = await world.fetchImpl(path, { method: req.method, body: JSON.stringify(body) }); return Response.json(await res.json()); }
    const response = await world.fetchImpl(path + url.search, { method: req.method, ...(req.method === 'POST' ? { body: await req.text() } : {}) });
    return Response.json(await response.json(), { status: response.status || 200 });
  }
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }), port = reservation.port;
reservation.stop(true);
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(join(output, 'driver.log')), stderr: Bun.file(join(output, 'driver.log')) });
let session;
async function rpc(path, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    }); req.on('error', reject); req.setTimeout(60000, () => req.destroy(Error('WebDriver timeout'))); req.end(body === undefined ? undefined : JSON.stringify(body));
  }); const data = JSON.parse(response.text); if (response.status >= 400) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const asyncExecute = script => rpc(`/session/${session}/execute/async`, { script, args: [] });
const wait = condition => asyncExecute(`const done=arguments[0];let n=0;const check=()=>(${condition})?done(true):++n>180?done(false):setTimeout(check,30);check();`);
const settle = () => asyncExecute('const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))));');
const assert = (value, message) => { if (!value) throw Error(message); };
const clickText = text => execute(`const b=[...document.querySelectorAll('#modal button,#detail button')].find(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled&&b.getClientRects().length);if(!b)throw Error('missing button '+${JSON.stringify(text)});b.click();`);
async function frame() { const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: element }); }
async function screenshot(name) { await writeFile(join(output, name + '.png'), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64')); }
async function ready(count = 5) { assert(await wait(`document.querySelectorAll('.dashboard-widget').length===${count}&&!document.querySelector('.dashboard-settings-open').disabled&&!document.querySelector('[data-card-id="aaaaaaaaaaaaaaaa"]').textContent.includes('读取中')`), 'panel ready timeout'); await settle(); }
async function containment(context) {
  const problems = await execute(`const problems=[],cards=[...document.querySelectorAll('.dashboard-widget')],rects=cards.map(c=>c.getBoundingClientRect());
    for(const [i,c] of cards.entries()){const r=rects[i],content=c.querySelector('.project-board-content');
      if(c.scrollWidth>c.clientWidth+1||c.scrollHeight>c.clientHeight+1)problems.push(c.dataset.cardId+':overflow '+c.scrollHeight+'/'+c.clientHeight);
      if(content.scrollHeight>content.clientHeight+1)problems.push(c.dataset.cardId+':content overflow '+content.scrollHeight+'/'+content.clientHeight);
      for(const slot of c.querySelectorAll('.dashboard-account-card,.dashboard-widget-slot'))if(slot.scrollHeight>slot.clientHeight+1)problems.push(c.dataset.cardId+':slot overflow '+slot.scrollHeight+'/'+slot.clientHeight);
      for(const e of c.querySelectorAll('a,button,progress')){if(!e.getClientRects().length)continue;const b=e.getBoundingClientRect();if(b.left<r.left-.5||b.right>r.right+.5||b.top<r.top-.5||b.bottom>r.bottom+.5)problems.push(c.dataset.cardId+':outside '+e.textContent);}
      for(let j=i+1;j<rects.length;j++){const s=rects[j];if(r.left<s.right&&r.right>s.left&&r.top<s.bottom&&r.bottom>s.top)problems.push('overlap');}}
    if(document.documentElement.scrollWidth>innerWidth+1)problems.push('page width');return problems;`);
  assert(!problems.length, `${context}: ${JSON.stringify(problems)}`);
}
try {
  let started = false; for (let i = 0; i < 100; i++) { try { await rpc('/status', undefined, 'GET'); started = true; break; } catch {} if (driver.exitCode !== null) throw Error('driver exited'); await Bun.sleep(100); }
  assert(started, 'driver timeout'); session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1000 }); await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/fixture` }); await frame(); await ready();
  assert(!queries.length && !saves.length && !reads.length, 'entry performs a mutation/provider query');
  for (const theme of ['light', 'dark']) for (const width of [1440, 1040, 900, 640, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.getElementById('viewport').style.width='${width}px'`); await frame();
    await execute(`document.documentElement.dataset.theme='${theme}'`); await settle(); await containment(`${theme}/${width}`);
    assert(await execute(`return document.querySelectorAll('.dashboard-project-messages .dashboard-widget-message').length===4&&[...document.querySelectorAll('.project-dashboard-message')].every(a=>a.target==='_blank'&&a.rel==='noopener'&&a.href.includes('/p/')&&getComputedStyle(a).flexWrap==='nowrap')&&document.querySelector('[data-card-id="${P}"] .dashboard-widget-body').getBoundingClientRect().height===436&&document.querySelector('[data-card-id="${P}"]').dataset.workerSlots==='3'&&[...document.querySelectorAll('.dashboard-account-reading')].every(h=>h.getBoundingClientRect().height>=14&&h.textContent.includes('25%'))`), 'aggregate body/source links/two rows');
    assert(await execute(`const nav=document.querySelector('[data-card-id="${P}"] .dashboard-project-direct-links');return nav.querySelectorAll('a').length===4&&(innerWidth!==1440||getComputedStyle(nav).display!=='none')&&document.querySelector('[data-card-id="${R}"] .dashboard-widget-body').querySelectorAll('a').length===2&&(innerWidth!==1440||getComputedStyle(document.querySelector('.dashboard-global-direct-links')).display!=='none')`), 'flat project/global navigation or bounded pure navigation missing');
    await screenshot(`${theme}-${width}`);
    await execute("document.querySelector('.dashboard-diagnostics-card').scrollIntoView({block:'center'})"); await settle();
    assert(await execute("const bar=document.querySelector('.diagnostics-trend-output .diagnostics-trend-slot:last-child .diagnostics-trend-bar');return bar.getBoundingClientRect().height>0&&getComputedStyle(bar).backgroundColor!=='rgba(0, 0, 0, 0)'"), 'output trend is invisible');
    await screenshot(`diagnostics-${theme}-${width}`);
    await execute("document.querySelector('.dashboard-toolbar').scrollIntoView({block:'start'})"); await settle();
    await clickText('编辑模式'); await settle();
    assert(await execute("return [...document.querySelectorAll('.dashboard-card-settings')].every(b=>b.getClientRects().length&&!b.disabled)"), 'edit mode must reveal every card setting');
    await execute(`window.before=JSON.stringify([...document.querySelectorAll('.dashboard-widget')].map(c=>{const r=c.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}));document.querySelector('.dashboard-settings-open').click()`);
    assert(await execute(`const r=document.querySelector('#modal .modal-card').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&window.before===JSON.stringify([...document.querySelectorAll('.dashboard-widget')].map(c=>{const r=c.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))`), 'modal moved grid/overflow'); await clickText('取消');
    await containment(`${theme}/${width}/editing`);
    assert(await execute("return getComputedStyle(document.querySelector('.dashboard-global-direct-links')).display==='none'&&[...document.querySelectorAll('.dashboard-project-direct-links')].every(n=>getComputedStyle(n).display==='none')"), 'editing navigation must use bounded fallback');
    await clickText('取消编辑'); await ready();
    console.log(`PASS assembled ${theme}/${width}: fixed containment, source links, settings and editing`);
  }
  // Regression: one uncertain source must not erase positive subtotals in every bucket.
  diagnosticsState = 'all-partial';
  for (const theme of ['light', 'dark']) for (const width of [1440, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.getElementById('viewport').style.width='${width}px'`); await frame();
    await execute(`document.documentElement.dataset.theme='${theme}';document.querySelector('.dashboard-diagnostics-refresh').click()`);
    assert(await wait("document.querySelector('.dashboard-diagnostics-refresh').getAttribute('aria-disabled')==='false'"), 'all-partial diagnostic refresh');
    await settle(); await containment(`diagnostic all-partial ${theme}/${width}`);
    assert(await execute(`return [...document.querySelectorAll('.diagnostics-trend')].every(graph=>{
      const slots=[...graph.querySelectorAll('.diagnostics-trend-slot')],bar=slots[59].querySelector('.diagnostics-trend-bar');
      return slots.every(slot=>!slot.classList.contains('unknown')&&slot.dataset.complete==='false'&&getComputedStyle(slot).backgroundImage==='none')
        &&graph.querySelectorAll('.diagnostics-trend-bar').length===59&&!slots[0].querySelector('.diagnostics-trend-bar')
        &&bar.getBoundingClientRect().height>0&&getComputedStyle(bar).backgroundImage==='none'
        &&getComputedStyle(bar).backgroundColor!=='rgba(0, 0, 0, 0)'&&graph.textContent.includes('峰值 ≥');
    })`), 'plain partial subtotal bars/lower-bound peak lost');
    await execute("document.querySelector('.dashboard-diagnostics-card').scrollIntoView({block:'center'})"); await settle();
    await screenshot(`diagnostics-all-partial-${theme}-${width}`);
    console.log(`PASS diagnostic all-partial ${theme}/${width}: visible plain subtotal bars and lower-bound peaks`);
  }
  diagnosticsState = 'partial';
  // Independent diagnostics reads retain the grid, settings draft, revision, and focused control.
  const beforeDiagnostics = readDashboardSettings(config), queryCount = queries.length, readCount = diagnosticReads;
  await execute("window.diagCard=document.querySelector('.dashboard-diagnostics-card');window.diagRefresh=diagCard.querySelector('.dashboard-diagnostics-refresh');window.diagRects=JSON.stringify([...document.querySelectorAll('.dashboard-widget')].map(c=>{const r=c.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}));diagRefresh.focus({preventScroll:true});diagRefresh.click()");
  assert(await wait("window.diagRefresh.getAttribute('aria-disabled')==='false'"), 'diagnostic refresh timeout');
  const diagnosticAudit = await execute("return {node:window.diagCard===document.querySelector('.dashboard-diagnostics-card'),focus:document.activeElement===window.diagRefresh,layout:window.diagRects===JSON.stringify([...document.querySelectorAll('.dashboard-widget')].map(c=>{const r=c.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})),trends:diagCard.querySelectorAll('.diagnostics-trend').length===3,plain:diagCard.querySelectorAll('.diagnostics-trend-slot.unknown').length===0&&[...diagCard.querySelectorAll('.diagnostics-trend-slot,.diagnostics-trend-bar')].every(n=>getComputedStyle(n).backgroundImage==='none'),partial:diagCard.textContent.includes('≥')&&diagCard.textContent.includes('不完整')}" );
  assert(Object.values(diagnosticAudit).every(Boolean), 'diagnostic update invariant: ' + JSON.stringify(diagnosticAudit));
  assert(diagnosticReads >= readCount + 1 && queries.length === queryCount && readDashboardSettings(config).revision === beforeDiagnostics.revision, 'diagnostic refresh wrote or queried accounts');
  await execute("document.querySelector('.dashboard-diagnostics-details').click()"); assert(await wait("!document.getElementById('modal').hidden"), 'diagnostic details');
  assert(await execute("return document.getElementById('modal').textContent.includes('估算费用不是账单')&&document.getElementById('modal').textContent.includes('未知费用项')&&document.getElementById('modal').textContent.includes('贡献项计数')&&document.getElementById('modal').textContent.includes('离线')"), 'diagnostic details coverage/estimate missing'); await clickText('关闭');
  await execute("document.querySelector('.dashboard-diagnostics-details').click()"); assert(await wait("document.querySelector('#modal .diagnostics-trends')"), 'diagnostic details trends');
  assert(await execute("return [...document.querySelectorAll('#modal .diagnostics-trend-slot,#modal .diagnostics-trend-bar')].every(n=>getComputedStyle(n).backgroundImage==='none')&&!document.getElementById('modal').textContent.includes('斜纹')"), 'diagnostic details still hatched'); await clickText('关闭');
  diagnosticsState = 'error'; await execute("document.querySelector('.dashboard-diagnostics-refresh').click()"); assert(await wait("document.querySelector('.dashboard-diagnostics-card').textContent.includes('更新失败')"), 'diagnostic error hidden'); await containment('diagnostic failure');
  diagnosticsState = 'none'; await execute("document.querySelector('.dashboard-diagnostics-refresh').click()"); assert(await wait("document.querySelector('.dashboard-diagnostics-card').textContent.includes('无登记项目')"), 'no projects shown as zero');
  assert(await execute("return [...document.querySelectorAll('.dashboard-diagnostics-card .diagnostics-rate strong')].every(n=>n.textContent==='未知')"), 'no-project rate fabricated'); diagnosticsState = 'partial';
  await clickText('编辑模式');
  await execute("document.querySelector('.dashboard-settings-open').click();const input=document.querySelector('[data-diagnostics=enabled]');input.checked=false;input.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('.dashboard-diagnostics-refresh').click()");
  assert(await wait("document.querySelector('.dashboard-diagnostics-refresh').getAttribute('aria-disabled')==='false'"), 'draft diagnostic refresh');
  assert(await execute("return !document.querySelector('[data-diagnostics=enabled]').checked&&!document.getElementById('modal').hidden"), 'diagnostic refresh destroyed settings draft');
  await clickText('应用到草稿'); await ready(4);
  assert(readDashboardSettings(config).diagnostics === true, 'card form published instead of staging');
  await clickText('保存更改'); await ready(4); assert(readDashboardSettings(config).diagnostics === false && JSON.stringify(readDashboardSettings(config).widgets) === JSON.stringify(beforeDiagnostics.widgets), 'diagnostic toggle changed members');
  await clickText('编辑模式');
  await execute("document.querySelector('.dashboard-settings-open').click();const input=document.querySelector('[data-diagnostics=enabled]');input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}))"); await clickText('应用到草稿'); await ready(); await clickText('保存更改'); await ready();
  // Unified editor: visible settings, searchable library, history, layout reset and whole-page cancellation.
  const beforeEditor = readDashboardSettings(config), editorSaves = saves.length;
  await clickText('编辑模式');
  await execute(`document.querySelector('[data-card-id="${Q}"] .dashboard-card-settings').click();document.querySelector('[data-remove-card="${Q}"]').click()`);
  await clickText('应用到草稿'); await ready(4);
  await clickText('撤销'); await ready();
  await clickText('重做'); await ready(4);
  await clickText('添加卡片');
  await execute("const s=document.querySelector('.dashboard-library-search');s.value='项目B';document.querySelector('.dashboard-library-searchbar button').click()");
  assert(await execute(`return [...document.querySelectorAll('.dashboard-library-item')].filter(e=>!e.hidden).length===1&&!document.querySelector('input[data-library-id="${Q}"]').disabled&&document.querySelector('input[data-library-id="${P}"]').disabled`), 'library search/duplicate guard');
  await execute(`document.querySelector('input[data-library-id="${Q}"]').click()`);
  await clickText('应用到草稿'); await ready();
  await execute(`document.querySelector('[data-card-id="${P}"] .dashboard-card-settings').click();document.querySelector('[data-section="distribution"]').click()`);
  await clickText('应用到草稿'); await ready();
  await clickText('恢复默认布局'); await clickText('恢复布局'); await ready(); await containment('reset layout draft');
  await clickText('撤销'); await ready();
  await execute("location.hash='#settings'");
  assert(await wait("document.getElementById('modal').textContent.includes('离开并丢弃未保存更改')&&!document.getElementById('modal').hidden"), 'hash navigation lost draft without confirmation');
  await clickText('取消'); assert(await wait("location.hash==='#projects'"), 'cancel leave did not restore route');
  assert(saves.length === editorSaves && readDashboardSettings(config).revision === beforeEditor.revision, 'editor draft/history published implicitly');
  await clickText('取消编辑'); await ready();
  assert(await execute("return !document.querySelector('.dashboard-layout-editing')&&document.querySelector('.dashboard-edit-status').hidden"), 'cancel did not leave editor');
  assert(JSON.stringify(readDashboardSettings(config)) === JSON.stringify(beforeEditor), 'cancel changed shared document');
  // Real account and Worker pages; no implicit writes/provider queries.
  await execute("document.querySelector('[data-card-id=\"accounts\"] .dashboard-widget-pagination > span:nth-child(3) button').click()");
  assert(await wait("document.querySelector('[data-card-id=\"accounts\"]').textContent.includes('账户3')"), 'account next page');
  await execute(`document.querySelector('[data-card-id="${P}"] .dashboard-widget-pagination > span:nth-child(3) button').click()`);
  assert(await wait(`document.querySelector('[data-card-id="${P}"]').textContent.includes('第 2 页')`), 'Worker next page');
  await execute(`document.querySelector('[data-card-id="${R}"] .dashboard-widget-pagination > span:nth-child(3) button').click()`);
  assert(await execute(`return document.querySelector('[data-card-id="${R}"] .dashboard-widget-body').textContent.includes('版本迭代')`), 'pure navigation page'); await containment('paged');
  await execute("document.querySelector('.dashboard-account-details').click()"); assert(await wait("!document.getElementById('modal').hidden"), 'resource details'); await clickText('关闭');
  rejectRead = true; await execute("document.querySelector('.dashboard-widget-notice-read').click()");
  assert(await wait("document.querySelector('.dashboard-project-messages').textContent.includes('已知失败')"), 'failed read not reported');
  assert(infos[0].read_at === null && reads.length === 1, 'failed read removed notice'); await containment('notice read failure'); rejectRead = false;
  await execute(`document.querySelector('[data-card-id="${P}"] .dashboard-project-details').click()`);
  await execute("document.querySelector('#modal .dashboard-widget-notice-read').click()");
  assert(await wait(`document.querySelector('[data-card-id="${P}"]').textContent.includes('告知18')&&document.querySelector('#modal').textContent.includes('告知18')&&!document.querySelector('[data-card-id="${P}"]').textContent.includes('告知20')`), 'read ACK not synchronized across card/details');
  assert(reads.length === 2 && reads.every(r => r.method === 'notice.read' && r.project_id === P && r.expected_identity), 'read escaped source/identity');
  await clickText('关闭'); await containment('read ACK');
  const beforeContinuation = calls.filter(c => c.path.includes('status=unread')).length;
  for (const id of [18, 16]) {
    await execute(`document.querySelector('[data-card-id="${P}"] .dashboard-widget-notice-read').click()`);
    assert(await wait(`!document.querySelector('[data-card-id="${P}"]').textContent.includes('告知${id}')`), 'ACK continuation timeout');
  }
  assert(await wait(`document.querySelector('[data-card-id="${P}"]').textContent.includes('告知14')`), 'three-record continuation missing');
  assert(calls.filter(c => c.path.includes('status=unread')).length === beforeContinuation + 1, 'continuation must read only this source');
  // Fixed business-state transitions, including long error/source text.
  for (const state of ['empty', 'error', 'offline', 'normal']) {
    sourceState = state; projects[0].running = state !== 'offline'; projects[0].error = state === 'error' ? '受控来源错误'.repeat(50) : null;
    await execute("window.before=JSON.stringify([...document.querySelectorAll('.dashboard-widget')].map(c=>{const r=c.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}));document.querySelector('.dashboard-toolbar button').click()"); await ready();
    assert(await execute("return window.before===JSON.stringify([...document.querySelectorAll('.dashboard-widget')].map(c=>{const r=c.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))"), 'state changed fixed grid'); await containment(state);
  }
  assert(queries.every(id => ids.slice(0, 4).includes(id)), 'refresh queried unplaced source');
  // Real controller keyboard geometry save + shared private writer + reload.
  await rpc(`/session/${session}/frame`, { id: null }); await execute("document.getElementById('viewport').style.width='1440px'"); await frame(); await settle(); await clickText('编辑模式');
  const resize = await rpc(`/session/${session}/element`, { using: 'css selector', value: '[data-card-id="aaaaaaaaaaaaaaaa"] .project-board-resize[data-corner="east"]' });
  const beforeSave = saves.length; await rpc(`/session/${session}/element/${resize['element-6066-11e4-a52e-4f735466cecf']}/value`, { text: '\uE015' });
  assert(saves.length === beforeSave, 'resize saved implicitly'); await clickText('保存更改'); await ready();
  assert(saves.length === beforeSave + 1 && readDashboardSettings(config).layout.find(c => c.id === P).h === 25, 'keyboard geometry not saved');
  const diagnosticResize = await rpc(`/session/${session}/element`, { using: 'css selector', value: '[data-card-id="widget:diagnostics"] .project-board-resize[data-corner="east"]' });
  await clickText('编辑模式'); await rpc(`/session/${session}/element/${diagnosticResize['element-6066-11e4-a52e-4f735466cecf']}/value`, { text: '\uE015' });
  await clickText('保存更改'); await ready(); assert(readDashboardSettings(config).layout.find(c => c.id === 'widget:diagnostics').h === 19, 'diagnostic keyboard resize not saved');
  await rpc(`/session/${session}/refresh`, {}); await frame(); await ready();
  assert(await execute(`return document.querySelector('[data-card-id="${P}"]').style.gridRow.includes('span 25')&&document.querySelector('.dashboard-diagnostics-card').style.gridRow.includes('span 19')`), 'reload lost geometry');
  assert(JSON.stringify(readDashboardSettings(config).widgets) === JSON.stringify(widgets), 'layout-only changed original v4 members');
  // A hundred sources still only occupy the selected fixed page, even with 8 resources each.
  const current = readDashboardSettings(config); current.widgets.find(w => w.type === 'accounts').connection_ids = ids;
  saveDashboardSettings(config, { widgets: current.widgets }, current.revision); await rpc(`/session/${session}/refresh`, {}); await frame(); await ready();
  assert(await execute("return document.querySelectorAll('.dashboard-account-embedded').length===2&&document.querySelectorAll('.dashboard-account-metric-slot').length===4&&document.querySelector('[data-card-id=\"accounts\"]').textContent.includes('50')"), '100 sources not paged'); await containment('100 sources');
  const boundary = readDashboardSettings(config); boundary.layout.find(c => c.id === 'accounts').h = 17;
  saveDashboardSettings(config, { layout: boundary.layout }, boundary.revision); await rpc(`/session/${session}/refresh`, {}); await frame(); await ready();
  assert(await execute("return document.querySelectorAll('.dashboard-account-embedded').length===2"), 'h17 exceeds exact 268px body budget'); await containment('h17 accounts');
  const small = readDashboardSettings(config); small.layout.find(c => c.id === 'accounts').h = 10;
  Object.assign(small.layout.find(c => c.id === P), { w: 4, h: 10 });
  Object.assign(small.layout.find(c => c.id === 'widget:diagnostics'), { w: 4, h: 10 });
  saveDashboardSettings(config, { layout: small.layout }, small.revision); await rpc(`/session/${session}/refresh`, {}); await frame(); await ready();
  assert(await execute(`const card=document.querySelector('[data-card-id="${P}"]');return document.querySelectorAll('.dashboard-account-embedded').length===1&&card.querySelectorAll('.dashboard-widget-body .dashboard-widget-message').length===2&&!card.querySelector('.dashboard-widget-body .project-development-metrics')&&card.dataset.workerSlots==='0'`), 'minimum project priority/one account slot');
  assert(await execute("return !document.querySelector('.dashboard-diagnostics-card .diagnostics-trends')&&document.querySelectorAll('.dashboard-diagnostics-card .diagnostics-rate').length===6"), 'minimum diagnostic summary overflow');
  await execute("document.querySelector('.dashboard-diagnostics-details').click()"); assert(await wait("document.querySelector('#modal .diagnostics-trends')"), 'minimum diagnostics details lost trends'); await clickText('关闭');
  await execute(`document.querySelector('[data-card-id="${P}"] .dashboard-project-details').click()`);
  assert(await wait(`document.querySelector('#modal .project-development-metrics')&&document.querySelectorAll('#modal .project-development-worker').length===3&&document.querySelector('#modal a[href="/p/${P}/#workers"]')&&!document.querySelector('#modal').textContent.includes('读取中')`), 'minimum project details omitted selected content/recent snapshot/full-history entry'); await clickText('关闭');
  const connections = world.state.agentConnections.connections;
  for (const state of ['error', 'unknown', 'partial', 'disabled']) {
    connections[0].enabled = state !== 'disabled'; connections[0].observation.status = state === 'disabled' ? 'available' : state;
    connections[1].observation.status = state; await clickText('刷新全部'); await ready();
    for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
      await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.getElementById('viewport').style.width='${width}px'`); await frame();
      await execute(`document.documentElement.dataset.theme='${theme}'`); await settle(); await containment(`account state ${state}/${theme}/${width}`);
    }
  }
  await clickText('编辑模式');
  for (const theme of ['light', 'dark']) for (const width of [1440, 1040, 640, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.getElementById('viewport').style.width='${width}px'`); await frame();
    await execute(`document.documentElement.dataset.theme='${theme}'`); await settle(); await containment(`minimum project/accounts ${theme}/${width}`); await screenshot(`minimum-${theme}-${width}`);
  }
  assert(await execute("return !window.fixtureErrors.length"), 'JS/CSP error: ' + JSON.stringify(await execute('return window.fixtureErrors')));
  console.log(`PASS restored controller: diagnostics independent read/focus/draft/unknown/no-project/error/toggle/keyboard resize, flat/paged navigation, account/Worker paging, h17 boundary, minimum project+diagnostic summary/details, read failure+ACK identity+continuation, business-state geometry, raw-member-preserving device save/reload and 100-source stress. Logs/screenshots: ${output}`);
  console.log('LIMIT Firefox headless/controlled source APIs; physical touch, Chromium/Safari and real providers unverified.');
} catch (error) { if (session) { try { await screenshot('failure'); console.error(await execute("return [...document.querySelectorAll('.dashboard-widget')].map(c=>({id:c.dataset.cardId,text:c.textContent.slice(0,300),html:c.innerHTML.slice(0,500)}))")); } catch {} } throw error; }
finally { if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} } driver.kill(); await driver.exited; server.stop(true); await rm(temp, { recursive: true, force: true }); }
