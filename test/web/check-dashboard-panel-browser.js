// Compiled real panel + grid + private v7 writer, isolated controlled source APIs.
// No user daemon/Host, real credentials, provider queries or model calls.
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { buildAssets } from '../../src/ui/web/build-assets.js';
import { readDashboardSettings, saveDashboardSettings } from '../../src/core/dashboard-settings.js';
import { newWidget } from '../../src/ui/web/assets/dashboard-widget-model.js';
import { makeWorld } from './dom-world.js';
import { fixture, repo, gate, until } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { projectRoutes } from '../../src/ui/web/server-project-routes.js';
const temp = await mkdtemp(join(tmpdir(), 'lush-widget-panel-'));
const output = process.argv[2] || join(tmpdir(), 'lush-widget-panel-results');
await mkdir(output, { recursive: true });
const assets = join(temp, 'assets');
await buildAssets(new URL('../../src/ui/web/assets/', import.meta.url).pathname, assets, 'd'.repeat(32));
const compact = process.argv.includes('--compact-controls');
const entry = (await Bun.file(join(assets, 'index.html')).text()).replace('</head>', `${compact ? '<link rel="stylesheet" href="/fixture-controls.css">' : ''}</head>`);
const config = { deviceHome: join(temp, 'shared') }, P = 'aaaaaaaaaaaaaaaa', Q = 'bbbbbbbbbbbbbbbb', R = 'cccccccccccccccc';
const ids = Array.from({ length: 100 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const world = makeWorld(), calls = [], queries = [], saves = [], reads = [];
const resources = Array.from({ length: 8 }, (_, i) => ({ id: `quota-${i}`, kind: i === 7 ? 'balance' : 'quota', scope: i === 1 ? 'key' : 'account',
  label: `窗口${i} ${'较长指标名称'.repeat(10)}`, unit: [1, 7].includes(i) ? 'USD' : '%', remaining: i === 7 ? 12.5 : 75, used_percent: i === 7 ? null : 25,
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
let restartPaused = false, restartReady = false, restartNotify = true, restartWrites = [];
let automationMode = 'normal', automationWrites = 0;
const restartError = '受控安全门拒绝：' + '完整异常来源诊断。'.repeat(120) + '异常末尾可见';
const restartAccepted = new Set();
const restartMaintenance = id => {
  const paused = restartPaused && restartAccepted.has(id);
  return { paused, phase: paused ? restartReady ? 'paused' : 'pausing' : 'running', ready_to_restart: paused && restartReady,
    batch_id: paused ? '00000000-0000-4000-8000-000000000001' : null,
    completion_state: paused ? restartReady ? 'completed' : 'pending' : null,
    completion_notice_id: paused && restartReady && restartNotify ? 7 : null, notify_completion: paused ? restartNotify : null };
};
const restartRows = () => projects.map(row => ({ ...row, summary: { ...row.summary, maintenance: restartMaintenance(row.id) } }));
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
let providerCalls = 0, inputMode = 'normal', inputGate = null;
const inputWrites = [];
const inputSource = fixture({ async run() { providerCalls++; return 'controlled overview input result'; } });
inputSource.project.stopping = true; await repo(inputSource.root);
const inputRpc = new Dispatcher(inputSource.project);
const inputHost = { launcher: true, hasRoute: id => id === P,
  async openRoute(id) { if (id !== P) throw Error('unexpected input source'); return { config: inputSource.config, client: { request: (method, params) => inputRpc.dispatch(method, params) } }; } };
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'";
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const url = new URL(req.url), path = url.pathname;
  if (path === '/fixture') return new Response('<!doctype html><link rel="stylesheet" href="/fixture.css"><iframe id="viewport" src="/"></iframe>', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': csp } });
  if (path === '/fixture-controls.css') return new Response(':root{--control-height:32px;--control-primary-height:32px}@media(max-width:760px),(pointer:coarse){:root{--control-primary-height:44px}}', { headers: { 'Content-Type': 'text/css' } });
  if (path === '/fixture.css') return new Response('html,body{margin:0}iframe{display:block;width:1440px;height:900px;border:0;max-width:100%}', { headers: { 'Content-Type': 'text/css' } });
  if (path === '/fixture-errors.js') return new Response("window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));addEventListener('securitypolicyviolation',e=>fixtureErrors.push('CSP:'+e.violatedDirective));", { headers: { 'Content-Type': 'text/javascript' } });
  if (path === '/') return new Response(entry.replace('<head>', '<head><script src="/fixture-errors.js"></script>'), { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': csp } });
  if (path.startsWith('/api/') || path.startsWith('/p/')) {
    calls.push({ path: path + url.search, method: req.method });
    if (path === '/api/host') return Response.json({ mode: 'bound', projects, restart_supported: true, pid: 123 });
    if (path === '/api/host/projects') return Response.json({ projects: restartRows() });
    if (req.method === 'POST' && (path.endsWith('/api/action') || path.endsWith('/api/service/restart') || path === '/api/host/restart')) {
      const body = await req.clone().json();
      if (body.method === 'input.emit') {
        inputWrites.push({ path, body });
        if (inputMode === 'error') return Response.json({ error: '受控输入失败' }, { status: 503 });
        // Exercise the production fixed-source HTTP route, registry/permission
        // checks, Dispatcher and durable emission; only the Provider is controlled.
        const response = await projectRoutes({ request: req, url, headers: {}, json: (value, status = 200) => Response.json(value, { status }) }, inputHost);
        if (inputGate) await inputGate.promise;
        return response;
      }
      if (body.method === 'system.interrupt_all') {
        if (!restartPaused) restartAccepted.clear();
        const id = path.split('/')[2]; restartAccepted.add(id);
        restartWrites.push({ path, body }); restartPaused = true; restartNotify = body.params.notify_completion !== false;
        return Response.json(restartMaintenance(id));
      }
      if (body.method === 'system.resume_all') {
        restartWrites.push({ path, body }); restartPaused = false;
        return Response.json({ paused: false, phase: 'running', ready_to_restart: true, batch_id: '00000000-0000-4000-8000-000000000001', completion_state: 'cancelled', completion_notice_id: null, notify_completion: restartNotify });
      }
      if (path.endsWith('/api/service/restart')) { restartWrites.push({ path, body }); return Response.json({ error: restartError }, { status: 409 }); }
      return Response.json({ error: 'unexpected mutation' }, { status: 500 });
    }
    if (path === '/api/host/automation') {
      if (req.method === 'POST') {
        automationWrites++;
        if (automationMode === 'bad_ack') return Response.json({ ...world.state.deviceAutomation, auto_select: { enabled: false } });
      } else if (automationMode === 'read_error') return Response.json({ error: 'controlled unknown policy' }, { status: 503 });
    }
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
let lastScript = '';
const execute = script => { lastScript = script; return rpc(`/session/${session}/execute/sync`, { script, args: [] }); };
const asyncExecute = script => { lastScript = script; return rpc(`/session/${session}/execute/async`, { script, args: [] }); };
const wait = condition => asyncExecute(`const done=arguments[0];let n=0;const check=()=>(${condition})?done(true):++n>180?done(false):setTimeout(check,30);check();`);
const settle = () => asyncExecute('const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))));');
const assert = (value, message) => { if (!value) throw Error(message); };
const clickText = text => execute(`const b=[...document.querySelectorAll('#modal button,#detail button')].find(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled&&b.getClientRects().length&&!b.closest('[inert]'));if(!b)throw Error('missing button '+${JSON.stringify(text)});b.click();`);
async function click(selector) {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
// Compare local geometry, not document scroll or banner offsets; status changes
// must not resize buttons or move adjacent cards.
const quickGeometry = () => execute(`const controls=document.querySelector('.dashboard-quick-actions-controls'),board=document.querySelector('.project-board');
  return [[controls,'button[data-quick-action],button[data-service-restart]'],[board,'.dashboard-widget']].flatMap(([root,selector])=>{
    const origin=root.getBoundingClientRect();return [...root.querySelectorAll(selector)].map(node=>{const r=node.getBoundingClientRect();return [node.dataset.quickAction||node.dataset.serviceRestart||node.dataset.cardId,...(r.width||r.height?[r.x-origin.x,r.y-origin.y,r.width,r.height]:[0,0,0,0])]});
  });`);
async function stableQuickGeometry(before, phase, autoHeight = null) {
  const after = await quickGeometry();
  const actions = new Set(['safe','auto_select','pause','resume','all']);
  assert(before.length===after.length && before.every((row,i)=>row[0]===after[i][0]&&(autoHeight!==null&&actions.has(row[0])||row.slice(1).every((value,j)=>Math.abs(value-after[i][j+1])<0.6))), `quick geometry changed ${phase}: ${JSON.stringify({before,after})}`);
  if (autoHeight!==null) {
    assert(after.find(row=>row[0]==='auto_select')?.[4]===autoHeight, 'auto-select height must follow its current authorization semantics');
    assert(await execute(`const buttons=[...document.querySelectorAll('.dashboard-quick-actions-controls button[data-quick-action],.dashboard-quick-actions-controls button[data-service-restart]')].filter(n=>n.getBoundingClientRect().height);
      const style=getComputedStyle(document.documentElement),ordinary=parseFloat(style.getPropertyValue('--control-height')),primary=parseFloat(style.getPropertyValue('--control-primary-height'))||ordinary;
      return buttons.every((button,i)=>{const r=button.getBoundingClientRect(),previous=buttons[i-1]?.getBoundingClientRect();return r.height===(button.matches('.agent-call,.control-primary')?primary:ordinary)&&(!previous||Math.abs(r.top-previous.bottom-6)<1);});`), 'compact quick actions must keep exact semantic heights and 6px flow gaps');
  }
}
async function frame() { const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: element }); }
async function screenshot(name) {
  assert(await wait("document.getElementById('modal').hidden||(getComputedStyle(document.getElementById('modal')).opacity==='1'&&getComputedStyle(document.querySelector('#modal .modal-card')).opacity==='1')"), 'modal animation did not settle');
  await writeFile(join(output, name + '.png'), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
}
async function ready(count = 5) { assert(await wait(`document.querySelectorAll('.dashboard-widget').length===${count + 1}&&!document.querySelector('.dashboard-settings-open').disabled&&!document.querySelector('[data-card-id="aaaaaaaaaaaaaaaa"]').textContent.includes('读取中')`), 'panel ready timeout'); await settle(); }
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
let phase = 'startup';
try {
  let started = false; for (let i = 0; i < 100; i++) { try { await rpc('/status', undefined, 'GET'); started = true; break; } catch {} if (driver.exitCode !== null) throw Error('driver exited'); await Bun.sleep(100); }
  assert(started, 'driver timeout'); session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1000 }); await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/fixture` }); await frame(); await ready();
  assert(!queries.length && !saves.length && !reads.length, 'entry performs a mutation/provider query');
  for (const theme of ['light', 'dark']) for (const width of [1440, 1040, 900, 640, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.getElementById('viewport').style.width='${width}px'`); await frame();
    await execute(`document.documentElement.dataset.theme='${theme}'`); await settle(); await containment(`${theme}/${width}`);
    const controlGeometry = await execute(`const card=document.querySelector('[data-card-id="${P}"]'),account=document.querySelector('.dashboard-account-embedded');
      const style=getComputedStyle(document.documentElement),control=parseFloat(style.getPropertyValue('--control-height'));
      return {control,primary:parseFloat(style.getPropertyValue('--control-primary-height'))||control,safe:document.querySelector('.dashboard-quick-actions-controls [data-service-restart="safe"]').getBoundingClientRect().height,
        header:card.querySelector('.dashboard-widget-header').getBoundingClientRect().height,footer:card.querySelector('.dashboard-widget-footer').getBoundingClientRect().height,
        message:card.querySelector('.dashboard-widget-message').getBoundingClientRect().height,worker:card.querySelector('.dashboard-widget-worker').getBoundingClientRect().height,
        accountHeader:account.querySelector('.dashboard-account-header').getBoundingClientRect().height,account:account.getBoundingClientRect().height};`);
    assert(['header','footer','message','worker','accountHeader'].every(key=>controlGeometry[key]===controlGeometry.control)&&controlGeometry.account===controlGeometry.control+44&&controlGeometry.safe===controlGeometry.primary,'card rows must follow control token: '+JSON.stringify(controlGeometry));
    console.log('CONTROL',theme,width,JSON.stringify(controlGeometry));
    assert(await execute(`return document.querySelectorAll('.dashboard-project-messages .dashboard-widget-message').length===4&&[...document.querySelectorAll('.project-dashboard-message')].every(a=>a.target==='_blank'&&a.rel==='noopener'&&a.href.includes('/p/')&&getComputedStyle(a).flexWrap==='nowrap')&&document.querySelector('[data-card-id="${P}"] .dashboard-widget-body').getBoundingClientRect().height===576-(52+2*parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-height')))&&Number(document.querySelector('[data-card-id="${P}"]').dataset.workerSlots)===(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-height'))===32?6:3)&&[...document.querySelectorAll('.dashboard-account-reading')].every(h=>h.getBoundingClientRect().height>=14&&h.textContent.includes('25%'))`), 'aggregate body/source links/two rows');
    assert(await execute(`const nav=document.querySelector('[data-card-id="${P}"] .dashboard-project-direct-links');return nav.querySelectorAll('a').length===3&&(innerWidth!==1440||getComputedStyle(nav).display!=='none')&&document.querySelector('[data-card-id="${R}"] .dashboard-widget-body').querySelectorAll('a').length===(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-height'))===32?3:2)&&(innerWidth!==1440||getComputedStyle(document.querySelector('.dashboard-global-direct-links')).display!=='none')`), 'flat project/global navigation or bounded pure navigation missing');
    assert(await execute(`const card=document.querySelector('[data-card-id="${P}"]'),body=card.querySelector('.dashboard-widget-body'),account=document.querySelector('.dashboard-account-embedded');
      const name=account.querySelector('h3').getBoundingClientRect(),age=account.querySelector('.dashboard-account-age').getBoundingClientRect();
      return [...body.children].map(n=>n.dataset.section).join(',')==='messages,metrics,recent,distribution,delivery'
        &&card.querySelector('.metric-label').textContent==='进行中'&&name.bottom<=age.top+1&&age.height>0
        &&account.querySelector('.dashboard-account-details').getBoundingClientRect().height===32
        &&account.querySelector('[data-metric-id="quota-1"]').textContent.includes('Key 预算 · 75 USD')
        &&account.querySelector('[data-metric-id="quota-0"]').textContent.includes('套餐 5h');`), 'current facts first, two-line account identity, stable details or typed units missing');
    await screenshot(`${theme}-${width}`);
    if ([1440, 320].includes(width)) {
      await execute("document.querySelector('.dashboard-accounts-group').scrollIntoView({block:'center'})"); await settle();
      await screenshot(`accounts-${theme}-${width}`);
    }
    await execute("document.querySelector('.dashboard-diagnostics-card').scrollIntoView({block:'center'})"); await settle();
    assert(await execute("const bar=document.querySelector('.diagnostics-trend-output .diagnostics-trend-slot:last-child .diagnostics-trend-bar');return bar.getBoundingClientRect().height>0&&getComputedStyle(bar).backgroundColor!=='rgba(0, 0, 0, 0)'"), 'output trend is invisible');
    await screenshot(`diagnostics-${theme}-${width}`);
    if ([1440, 320].includes(width)) {
      await execute("document.querySelector('.dashboard-quick-actions-card').scrollIntoView({block:'center'})"); await settle();
      await screenshot(`quick-card-${theme}-${width}`);
    }
    await execute("document.querySelector('.dashboard-toolbar').scrollIntoView({block:'start'})"); await settle();
    await clickText('编辑模式'); await settle();
    assert(await execute("return [...document.querySelectorAll('.dashboard-card-settings')].every(b=>b.getClientRects().length&&!b.disabled&&b.getBoundingClientRect().height===parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-height')))&&[...document.querySelectorAll('.dashboard-toolbar button')].filter(b=>b.getClientRects().length).every(b=>b.getBoundingClientRect().height===parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-height')))"), 'edit mode must reveal every card setting and retain unified compact toolbar sizes');
    await execute(`window.before=JSON.stringify([...document.querySelectorAll('.dashboard-widget')].map(c=>{const r=c.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}));document.querySelector('.dashboard-settings-open').click()`);
    assert(await execute(`const r=document.querySelector('#modal .modal-card').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&window.before===JSON.stringify([...document.querySelectorAll('.dashboard-widget')].map(c=>{const r=c.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))`), 'modal moved grid/overflow'); await clickText('取消');
    await containment(`${theme}/${width}/editing`);
    assert(await execute("return getComputedStyle(document.querySelector('.dashboard-global-direct-links')).display==='none'&&[...document.querySelectorAll('.dashboard-project-direct-links')].every(n=>getComputedStyle(n).display==='none')"), 'editing navigation must use bounded fallback');
    await clickText('取消编辑'); await ready();
    console.log(`PASS assembled ${theme}/${width}: fixed containment, source links, settings and editing`);
  }
  phase = 'overview input';
  assert(await execute(`return document.querySelectorAll('.dashboard-project-input').length===3&&[...document.querySelectorAll('.dashboard-project-input')].every(b=>!b.classList.contains('agent-call')&&b.getClientRects().length)`), 'project input must be permanently discoverable without authorizing Agent');
  await execute(`document.querySelector('[data-card-id="${P}"] .dashboard-project-input').click()`);
  assert(await execute(`const modal=document.querySelector('.dashboard-input-modal'),r=modal.getBoundingClientRect();return modal.textContent.includes('项目A')&&modal.textContent.includes('/fixture/project-a')&&r.left>=0&&r.right<=innerWidth&&modal.scrollWidth<=modal.clientWidth&&document.activeElement.tagName==='TEXTAREA'&&modal.querySelector('.agent-call').dataset.help.includes('token')&&modal.querySelector('.agent-call').getBoundingClientRect().height===(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-primary-height'))||parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-height')))`), 'input modal identity/focus/costs/44px primary/320px containment');
  const typeInput = text => execute(`const input=document.querySelector('#modal textarea');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}))`);
  await typeInput('项目A的指令'); await settle();
  assert(await execute("const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented"), 'input reload protection');
  assert(await execute(`const actions=[...document.querySelectorAll('.dashboard-input-modal>.modal-actions button')].filter(button=>button.getClientRects().length);return actions.length===1&&actions.every(button=>button.getBoundingClientRect().height===32)&&document.querySelector('.dashboard-input-modal>.modal-actions .modal-confirm').classList.contains('control-secondary');`), 'read-only close actions must stay ordinary beside the 44px actual submit');
  await screenshot('input-320'); await clickText('关闭');
  assert(await execute(`return document.activeElement===document.querySelector('[data-card-id="${P}"] .dashboard-project-input')`), 'input close focus');
  await execute(`document.querySelector('[data-card-id="${Q}"] .dashboard-project-input').click()`);
  assert(await execute("return document.querySelector('#modal textarea').value===''") , 'cross-project draft leaked');
  await typeInput('离线项目草稿'); assert(await execute("return document.querySelector('#modal .agent-call').disabled&&document.querySelector('#modal .project-order-actions .help-host').dataset.help.includes('后台')"), 'offline submit not blocked');
  await clickText('关闭'); await clickText('刷新全部'); await ready();
  await execute(`document.querySelector('[data-card-id="${P}"] .dashboard-project-input').click()`);
  assert(await execute("return document.querySelector('#modal textarea').value==='项目A的指令'"), 'refresh/reopen lost draft');
  inputMode = 'error'; await clickText('提交指令');
  assert(await wait("document.querySelector('#modal .project-order-status').textContent.includes('受控输入失败')&&!document.querySelector('#modal .agent-call').disabled"), 'input failure not retained');
  assert(inputWrites.length === 1 && inputSource.store.all('SELECT * FROM inputs').length === 0, 'failed input executed');
  inputMode = 'normal'; inputGate = gate();
  await execute("document.querySelector('#modal .agent-call').click();document.querySelector('#modal .agent-call').click()");
  assert(await wait("document.querySelector('#modal .agent-call').disabled"), 'input pending lock');
  await typeInput('在途新增文字'); await clickText('关闭');
  await execute("document.getElementById('settings-open').click()");
  assert(await wait("location.hash==='#projects'&&document.querySelector('.project-overview')"), 'pending input allowed page leave');
  await clickText('刷新全部'); await ready();
  await execute(`document.querySelector('[data-card-id="${P}"] .dashboard-project-input').click()`);
  assert(await execute("return document.querySelector('#modal textarea').value==='在途新增文字'&&document.querySelector('#modal .agent-call').disabled"), 'pending remount lost text or single flight');
  inputGate.resolve(); inputGate = null;
  assert(await wait("document.querySelector('#modal .project-order-status').textContent.includes('工作指令已提交')&&!document.querySelector('#modal .agent-call').disabled"), 'input durable ACK');
  assert(await execute(`return document.querySelector('#modal textarea').value==='在途新增文字'&&document.querySelector('#modal .project-order-status a').getAttribute('href').startsWith('/p/${P}/#input-draft-')`), 'late ACK erased new input or source receipt');
  assert(inputWrites.length===2&&inputWrites.every(w=>w.path===`/p/${P}/api/action`&&w.body.params.branch==='main')&&inputWrites[0].body.params.client_request_id===inputWrites[1].body.params.client_request_id, 'input target/dedup identity mismatch');
  inputSource.project.stopping = false; inputSource.project.kick();
  await until(() => providerCalls===1 && inputSource.store.all('SELECT * FROM inputs').length===1 && !inputSource.project.running.size, 15000);
  assert(inputSource.store.all('SELECT * FROM inputs')[0].content==='项目A的指令', 'real input runtime did not receive submitted original');
  inputSource.project.stopping = true;
  await typeInput(''); await clickText('关闭');
  await execute(`document.querySelector('[data-card-id="${Q}"] .dashboard-project-input').click()`);
  assert(await execute("return document.querySelector('#modal textarea').value==='离线项目草稿'"), 'offline draft lost'); await typeInput(''); await clickText('关闭');
  console.log('PASS overview input: real fixed-source HTTP -> registry/permission -> Dispatcher -> durable emission -> runtime -> controlled Provider; offline/isolation/failure/retry identity/single flight/refresh/reopen/late ACK/leave guard/focus/320px');
  phase = 'diagnostic lifecycle';
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
  phase = 'quick actions lifecycle';
  // Quick actions: real panel entry, confirmation, stable in-flight controller and full error details.
  const beforeQuickConfirm = await quickGeometry();
  await click('[data-service-restart=safe]');
  assert(await wait("!document.getElementById('modal').hidden&&document.getElementById('modal').textContent.includes('一键安全重启？')"), 'quick scope confirmation');
  await stableQuickGeometry(beforeQuickConfirm, 'confirming');
  assert(await execute(`const modal=document.getElementById('modal');return modal.textContent.includes('/fixture/project-a')&&modal.textContent.includes('/fixture/project-c')&&!modal.textContent.includes('/fixture/project-b')&&modal.querySelector('.agent-call').dataset.help.includes('token')`), 'quick scope or Agent cost');
  await clickText('取消'); assert(!restartWrites.length, 'cancelled quick action wrote');
  await stableQuickGeometry(beforeQuickConfirm, 'cancelled');
  await execute("window.quickButton=document.querySelector('[data-service-restart=safe]');quickButton.click()");
  assert(await wait("document.getElementById('modal').textContent.includes('一键安全重启？')&&!document.getElementById('modal').hidden"), 'second quick confirmation');
  await execute("document.querySelector('#modal .modal-confirm').click()");
  assert(await wait("document.querySelector('.dashboard-quick-actions-controls').textContent.includes('等待固定批次')"), 'quick wait progress');
  await clickText('编辑模式');
  assert(await execute("return quickButton.disabled&&quickButton.parentElement.dataset.help.includes('编辑')"), 'editing quick action is writable');
  const quickResize = await rpc(`/session/${session}/element`, { using: 'css selector', value: '[data-card-id="widget:quick-actions"] .project-board-resize[data-corner="east"]' });
  await rpc(`/session/${session}/element/${quickResize['element-6066-11e4-a52e-4f735466cecf']}/value`, { text: '\uE015' });
  await execute("document.querySelector('[data-card-id=\"widget:quick-actions\"] .dashboard-card-settings').click();document.querySelector('input[data-quick-action-button=interrupt_all]').click()");
  await clickText('应用到草稿'); await ready();
  assert(await execute("return quickButton===document.querySelector('[data-service-restart=safe]')&&document.querySelector('.dashboard-quick-actions-controls').textContent.includes('等待固定批次')"), 'selection rebuilt ongoing flow');
  await clickText('撤销'); await ready();
  await clickText('刷新全部'); await ready();
  assert(await execute("return quickButton===document.querySelector('[data-service-restart=safe]')&&document.querySelector('.dashboard-quick-actions-controls').textContent.includes('等待固定批次')&&document.querySelectorAll('.dashboard-quick-actions-card .dashboard-card-settings').length===1"), 'refresh/resize replaced controller or lost progress');
  await clickText('保存更改'); await ready();
  assert(readDashboardSettings(config).layout.find(c => c.id === 'widget:quick-actions').h === 13, 'quick geometry not persisted');
  await execute("document.querySelector('.dashboard-quick-actions-details').click()"); restartReady = true;
  assert(await wait("document.querySelector('.dashboard-quick-actions-controls').textContent.includes('异常末尾可见')"), 'quick failure not reported');
  assert(await wait("document.querySelector('#modal .dashboard-quick-actions-result')?.textContent.includes('异常末尾可见')"), 'open details lost full live result');
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.getElementById('viewport').style.width='${width}px'`); await frame();
    await execute(`document.documentElement.dataset.theme='${theme}'`); await settle();
    assert(await execute("const m=document.querySelector('.dashboard-quick-actions-modal'),p=m.querySelector('.dashboard-quick-actions-result');return m.getBoundingClientRect().right<=innerWidth+1&&m.scrollWidth<=m.clientWidth+1&&getComputedStyle(p).overflow==='visible'&&p.scrollHeight>100"), 'quick full result clipped/overflow');
    await screenshot(`quick-error-details-${theme}-${width}`);
  }
  await clickText('关闭'); await containment('quick failure fixed geometry');
  assert(restartWrites.length === 3 && restartWrites.filter(c => c.path.endsWith('/api/service/restart')).length === 1, 'safe failure retried or continued');
  restartPaused = false; restartReady = false;
  // Remove during an observation: abort remaining steps, preserve accepted requests, restore via undo/library.
  await execute("document.querySelector('[data-service-restart=safe]').click()");
  assert(await wait("document.getElementById('modal').textContent.includes('一键安全重启？')&&!document.getElementById('modal').hidden"), 'remove test confirmation');
  await execute("document.querySelector('#modal .modal-confirm').click()");
  assert(await wait("document.querySelector('.dashboard-quick-actions-controls').textContent.includes('等待固定批次')"), 'remove test wait');
  const beforeQuickRemove = readDashboardSettings(config), acceptedBeforeRemove = restartWrites.length;
  await clickText('编辑模式');
  await execute("document.querySelector('[data-card-id=\"widget:quick-actions\"] .dashboard-card-settings').click();document.querySelector('[data-remove-card=\"widget:quick-actions\"]').click()");
  await clickText('应用到草稿');
  assert(await wait("!document.querySelector('.dashboard-quick-actions-card')&&!document.querySelector('.dashboard-layout-save').disabled"), 'remove quick card draft');
  assert(readDashboardSettings(config).quick_actions, 'quick draft wrote before save');
  restartReady = true;
  await clickText('撤销'); await ready();
  assert(await execute("return !document.querySelector('.dashboard-quick-actions-controls').textContent.includes('等待固定批次')"), 'undo resumed revoked flow');
  await clickText('重做'); assert(await wait("!document.querySelector('.dashboard-quick-actions-card')&&!document.querySelector('.dashboard-layout-save').disabled"), 'quick redo');
  await clickText('取消编辑'); await ready();
  assert(readDashboardSettings(config).revision === beforeQuickRemove.revision && restartWrites.length === acceptedBeforeRemove, 'cancel remove changed config or continued writes');
  await clickText('编辑模式'); await execute("document.querySelector('.dashboard-settings-open').click();document.querySelector('[data-quick-actions=enabled]').click()");
  await clickText('应用到草稿'); await clickText('保存更改');
  assert(await wait("!document.querySelector('.dashboard-quick-actions-card')&&!document.querySelector('.dashboard-layout-edit').disabled"), 'quick shared removal');
  assert(readDashboardSettings(config).quick_actions === false, 'quick removal was UI-only');
  await clickText('编辑模式'); await clickText('添加卡片');
  await execute("document.querySelector('input[data-library-id=\"widget:quick-actions\"]').click()");
  await clickText('应用到草稿'); await ready(); await clickText('保存更改'); await ready();
  assert(readDashboardSettings(config).quick_actions === true && readDashboardSettings(config).layout.find(c => c.id === 'widget:quick-actions').h === 13, 'library add lost shared selection/layout');
  // Leave while confirming: dispose the exact dialog, never write or resume on return.
  restartPaused = false; restartReady = false;
  await execute("document.querySelector('[data-service-restart=safe]').click()");
  assert(await wait("!document.getElementById('modal').hidden&&document.getElementById('modal').textContent.includes('一键安全重启？')"), 'leave confirmation');
  const beforeQuickLeave = restartWrites.length;
  await execute("location.hash='#settings'");
  assert(await wait("!document.querySelector('.dashboard-quick-actions-card')&&document.getElementById('modal').hidden"), 'leave did not dispose quick confirmation');
  assert(restartWrites.length === beforeQuickLeave, 'leave confirmation wrote');
  await execute("location.hash='#projects'"); await ready();
  assert(await execute("return !document.querySelector('.dashboard-quick-actions-controls').textContent.includes('等待固定批次')"), 'return resumed old authorization');
  // D681: selection is one draft, not execution; all five actions stay reachable in-place.
  const allButtons = ['safe_restart','auto_select','interrupt_all','resume_all','restart_all'];
  const setButtons = async ids => {
    await execute("document.querySelector('[data-card-id=\"widget:quick-actions\"] .dashboard-card-settings').click()");
    await execute(`for(const input of document.querySelectorAll('input[data-quick-action-button]')){input.checked=${JSON.stringify(ids)}.includes(input.dataset.quickActionButton);input.dispatchEvent(new Event('change',{bubbles:true}))}`);
    await clickText('应用到草稿'); await ready();
  };
  const initialButtonsRevision = readDashboardSettings(config).revision, initialActionWrites = automationWrites + restartWrites.length;
  await clickText('编辑模式'); await setButtons(allButtons);
  assert(await execute("return document.querySelectorAll('.dashboard-quick-actions-card [data-service-restart]').length===4&&document.querySelector('.dashboard-quick-actions-card button[data-quick-action=auto_select]').disabled"), 'all selection not rendered/guarded');
  await clickText('撤销'); await ready();
  assert(await execute("return document.querySelectorAll('.dashboard-quick-actions-card [data-service-restart]').length===1"), 'buttons undo');
  await clickText('重做'); await ready(); await setButtons([]);
  assert(await execute("return document.querySelector('.dashboard-quick-actions-empty')&&!document.querySelector('.dashboard-quick-actions-card button[data-quick-action]')&&!document.querySelector('.dashboard-quick-actions-card [data-service-restart]')"), 'empty selection not real');
  assert(readDashboardSettings(config).revision === initialButtonsRevision && automationWrites + restartWrites.length === initialActionWrites, 'selection executed or published a policy');
  await clickText('取消编辑'); await ready();
  assert(readDashboardSettings(config).quick_action_buttons.join(',') === 'safe_restart,auto_select', 'cancel lost default selection');
  await clickText('编辑模式'); await setButtons(allButtons); await clickText('保存更改'); await ready();
  assert(readDashboardSettings(config).quick_action_buttons.join(',') === allButtons.join(','), 'shared buttons did not persist');
  await rpc(`/session/${session}/refresh`, {}); await frame(); await ready();
  assert(await execute("return document.querySelectorAll('.dashboard-quick-actions-card [data-service-restart]').length===4"), 'reload lost selected operations');
  for (const theme of ['light', 'dark']) for (const width of [1440, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.getElementById('viewport').style.width='${width}px'`); await frame(); await execute(`document.documentElement.dataset.theme='${theme}'`); await settle();
    await containment('multi-button '+theme+'/'+width);
    await execute("document.querySelector('.dashboard-quick-actions-details').click()");
    assert(await execute("const m=document.querySelector('.dashboard-quick-actions-modal');return m.querySelectorAll('[data-service-restart]').length===4&&[...m.querySelectorAll('[data-service-restart],button[data-quick-action=auto_select]')].every(b=>b.getClientRects().length&&b.getBoundingClientRect().right<=innerWidth)&&m.scrollWidth<=m.clientWidth+1"), 'selected operations hidden/unusable in narrow details');
    await screenshot(`all-buttons-details-${theme}-${width}`); await clickText('关闭');
  }
  for (const [kind, title, agent] of [['pause','全部中断？',false],['resume','全部继续？',true],['all','全部重启？',false],['safe','一键安全重启？',true]]) {
    await execute(`document.querySelector('.dashboard-quick-actions-details').click();document.querySelector('#modal [data-service-restart=${kind}]').click()`);
    assert(await wait(`!document.getElementById('modal').hidden&&document.getElementById('modal').textContent.includes('${title}')`), 'detail maintenance confirmation '+kind);
    assert(await execute(`return document.getElementById('modal').textContent.includes('/fixture/project-a')&&!!document.querySelector('#modal .modal-confirm.agent-call')===${agent}`), 'detail scope/Agent cost '+kind);
    await clickText('取消');
  }
  const beforeManual = restartWrites.length;
  await execute("document.querySelector('.dashboard-quick-actions-details').click();document.querySelector('#modal [data-service-restart=pause]').click()");
  assert(await wait("document.getElementById('modal').textContent.includes('全部中断？')"), 'manual detail pause'); await execute("document.querySelector('#modal .modal-confirm').click()");
  assert(await wait("document.querySelector('.dashboard-quick-actions-controls').textContent.includes('中断请求已接受')"), 'manual card acceptance');
  restartReady = true;
  assert(await wait("document.querySelector('.dashboard-quick-actions-controls .maintenance-ready')"), 'manual card completion reminder');
  assert(restartWrites.length === beforeManual + 2 && restartWrites.slice(beforeManual).every(write=>JSON.stringify(write.body.params)==='{}'), 'manual card inherited silent policy');
  for (const kind of ['resume','all']) {
    await execute(`document.querySelector('.dashboard-quick-actions-details').click();document.querySelector('#modal [data-service-restart=${kind}]').click()`);
    assert(await wait(`!document.getElementById('modal').hidden&&document.getElementById('modal').textContent.includes('${kind==='resume'?'全部继续？':'全部重启？'}')`), 'manual execution confirmation'); await execute("document.querySelector('#modal .modal-confirm').click()");
    assert(await wait(`document.querySelector('.dashboard-quick-actions-controls').textContent.includes('${kind==='resume'?'全部继续请求已接受':'异常末尾可见'}')`), 'manual card result '+kind);
  }
  const beforeAutoSelect = await quickGeometry();
  await execute("document.querySelector('.dashboard-quick-actions-details').click();document.querySelector('#modal button[data-quick-action=auto_select]').click()");
  assert(await wait("document.querySelector('#modal .modal-confirm.agent-call')&&document.getElementById('modal').textContent.includes('持续授权')"), 'auto-select sustained authorization'); await clickText('取消'); assert(automationWrites===0, 'auto cancel wrote policy');
  await execute("document.querySelector('.dashboard-quick-actions-details').click();document.querySelector('#modal button[data-quick-action=auto_select]').click()");
  assert(await wait("document.getElementById('modal').textContent.includes('授权并开启')"), 'auto enable'); await execute("document.querySelector('#modal .modal-confirm').click()");
  assert(await wait("document.querySelector('.dashboard-quick-actions-card .device-auto-select-status')?.textContent.includes('已确认开启')&&!document.getElementById('auto-select-banner').hidden"), 'card/banner did not share enable state');
  await stableQuickGeometry(beforeAutoSelect, 'auto enabled', await execute("return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-height'))"));
  await execute("document.querySelector('#auto-select-banner button').click()");
  assert(await wait("document.querySelector('.dashboard-quick-actions-card .device-auto-select-status').textContent.includes('已确认关闭')&&document.getElementById('auto-select-banner').hidden"), 'banner close not reflected in card');
  await stableQuickGeometry(beforeAutoSelect, 'auto disabled');
  automationMode='bad_ack';
  await execute("document.querySelector('.dashboard-quick-actions-details').click();document.querySelector('#modal button[data-quick-action=auto_select]').click()");
  assert(await wait("document.getElementById('modal').textContent.includes('授权并开启')"), 'unknown ACK confirmation'); await execute("document.querySelector('#modal .modal-confirm').click()");
  assert(await wait("document.querySelector('.dashboard-quick-actions-card .device-auto-select-status').textContent.includes('状态未知')&&document.querySelector('.dashboard-quick-actions-card button[data-quick-action=auto_select]').disabled"), 'unknown ACK not locked');
  await stableQuickGeometry(beforeAutoSelect, 'auto unknown', await execute("return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-height'))"));
  assert(await execute("const b=document.querySelector('.dashboard-quick-actions-card button[data-quick-action=auto_select]');return b.parentElement.tabIndex===0&&!!b.parentElement.dataset.help"), 'unknown disabled help unavailable');
  const failedWrites = automationWrites;
  await execute("document.querySelector('.dashboard-quick-actions-details').click();document.querySelector('#modal button[data-quick-action=auto_select]').click()");
  assert(automationWrites === failedWrites, 'unknown write retried'); automationMode='read_error';
  await execute("document.querySelector('#modal .device-auto-select-reread').click()");
  assert(await wait("document.querySelector('#modal .device-auto-select-status').textContent.includes('controlled unknown policy')&&document.querySelector('#modal button[data-quick-action=auto_select]').disabled"), 'failed reread cleared uncertainty');
  automationMode='normal';
  await execute("document.querySelector('#modal .device-auto-select-reread').click()");
  assert(await wait("!document.querySelector('#modal button[data-quick-action=auto_select]').disabled"), 'explicit reread did not recover'); await clickText('关闭');
  // An edit during an outstanding authorization cannot use the old confirmation to write.
  await execute("document.querySelector('.dashboard-quick-actions-details').click();document.querySelector('#modal button[data-quick-action=auto_select]').click()");
  assert(await wait("document.getElementById('modal').textContent.includes('授权并开启')"), 'stale edit confirmation');
  await execute("document.querySelector('.dashboard-layout-edit').click();document.querySelector('#modal .modal-confirm').click()");
  assert(await wait("document.getElementById('modal').hidden"), 'stale edit confirmation unresolved');
  assert(automationWrites===failedWrites, 'edit admitted old authorization'); await clickText('取消编辑'); await ready();
  await execute("document.querySelector('.dashboard-quick-actions-details').click();document.querySelector('#modal button[data-quick-action=auto_select]').click()");
  assert(await wait("document.getElementById('modal').textContent.includes('授权并开启')"), 'leave authorization');
  await execute("document.getElementById('automation-open').click()");
  assert(await wait("document.querySelector('.workspace-automation .device-auto-select-action')&&document.getElementById('modal').hidden"), 'leave did not dismiss owned authorization');
  assert(automationWrites===failedWrites, 'leave confirmation wrote');
  await execute("document.getElementById('projects-open').click()"); await ready();
  console.log('PASS D681 selection/empty/history/shared reload, all detail actions, manual notifying vs silent safe, auto authorization/cancel/banner sync/unknown ACK/reread/stale edit; no navigation to execute');
  phase = 'unified editor';
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
  await execute("document.querySelector('.dashboard-editor-more').open=true");
  await clickText('恢复默认布局'); await clickText('恢复布局'); await ready(); await containment('reset layout draft');
  await clickText('撤销'); await ready();
  await execute(`document.querySelector('[data-card-id="${P}"] .dashboard-card-settings').click()`);
  await clickText('紧凑'); await clickText('下移');
  assert(await execute("return document.querySelector('[data-geometry=w]').value==='4'&&document.querySelector('[data-geometry=h]').value==='10'&&document.querySelector('[data-geometry=y]').value==='2'"), 'size preset/move buttons');
  await clickText('应用到草稿'); await ready();
  assert(await execute(`return document.querySelector('[data-card-id="${P}"]').style.gridRow.includes('span 10')&&document.querySelector('[data-card-id="${P}"] .project-board-geometry-feedback').textContent.includes('4 × 10')`), 'geometry draft/visible feedback');
  await clickText('撤销'); await ready();
  assert(await execute(`return document.querySelector('[data-card-id="${P}"]').style.gridRow.includes('span 24')`), 'size undo');
  await clickText('重做'); await ready();
  await execute(`document.querySelector('[data-card-id="${P}"] .dashboard-card-settings').click()`); await clickText('宽幅'); await clickText('取消');
  assert(await execute(`return document.querySelector('[data-card-id="${P}"]').style.gridRow.includes('span 10')`), 'cancelled size form mutated draft');
  await clickText('撤销'); await ready();
  await execute("document.getElementById('settings-open').click()");
  assert(await wait("document.getElementById('modal').textContent.includes('离开并丢弃未保存更改')&&!document.getElementById('modal').hidden"), 'hash navigation lost draft without confirmation');
  await clickText('取消'); assert(await wait("location.hash==='#projects'"), 'cancel leave did not restore route');
  assert(saves.length === editorSaves && readDashboardSettings(config).revision === beforeEditor.revision, 'editor draft/history published implicitly');
  await clickText('取消编辑'); await ready();
  assert(await execute("return !document.querySelector('.dashboard-layout-editing')&&document.querySelector('.dashboard-edit-status').hidden"), 'cancel did not leave editor');
  assert(JSON.stringify(readDashboardSettings(config)) === JSON.stringify(beforeEditor), 'cancel changed shared document');
  // At phone width a preset still saves canonical twelve-column dimensions,
  // not the one-column display projection. Restore the fixture baseline after proof.
  await rpc(`/session/${session}/frame`, { id: null }); await execute("document.getElementById('viewport').style.width='320px'"); await frame(); await settle();
  await clickText('编辑模式'); await execute(`document.querySelector('[data-card-id="${P}"] .dashboard-card-settings').click()`);
  await clickText('宽幅'); await settle();
  assert(await execute("const first=document.querySelector('.dashboard-size-presets button').getBoundingClientRect();return first.top>=0&&first.bottom<=innerHeight"), 'opening settings scrolled past presets');
  await screenshot('layout-presets-320');
  assert(await execute("const modal=document.querySelector('.dashboard-settings-modal'),r=modal.getBoundingClientRect();return modal.scrollWidth<=modal.clientWidth&&r.left>=0&&r.right<=innerWidth&&[...modal.querySelectorAll('button,input')].filter(b=>b.getClientRects().length).every(b=>{const s=b.getBoundingClientRect();return s.left>=r.left&&s.right<=r.right})"), 'size editor controls overflow at 320px');
  await clickText('应用到草稿'); await ready(); await clickText('保存更改'); await ready();
  assert(readDashboardSettings(config).layout.find(c=>c.id===P).w===12&&readDashboardSettings(config).layout.find(c=>c.id===P).h===24, 'phone preset saved responsive projection');
  saveDashboardSettings(config, { layout: beforeEditor.layout }, readDashboardSettings(config).revision); await clickText('刷新全部'); await ready();
  console.log('PASS layout editor: content/library discovery, presets and move buttons, form cancel, undo/redo, page cancel/save, visible geometry feedback and canonical preset persistence at 320px');
  phase = 'account and Worker paging';
  // Real account and Worker pages; no implicit writes/provider queries.
  const accountCapacity = await execute("return Number(document.querySelector('[data-card-id=\"accounts\"] .dashboard-accounts-items').dataset.slotCount)");
  await execute("document.querySelector('[data-card-id=\"accounts\"] .dashboard-widget-pagination > span:nth-child(3) button').click()");
  assert(await wait(`document.querySelector('[data-card-id="accounts"]').textContent.includes('账户${accountCapacity+1} ')`), 'account next page');
  await execute(`document.querySelector('[data-card-id="${P}"] .dashboard-widget-pagination > span:nth-child(3) button').click()`);
  assert(await wait(`document.querySelector('[data-card-id="${P}"]').textContent.includes('第 2 页')`), 'Worker next page');
  await execute(`document.querySelector('[data-card-id="${R}"] .dashboard-widget-pagination > span:nth-child(3) button').click()`);
  assert(await execute(`return document.querySelector('[data-card-id="${R}"] .dashboard-widget-body').textContent.includes('待我处理')`), 'pure navigation page'); await containment('paged');
  await execute("document.querySelector('.dashboard-account-details').click()");
  assert(await wait("!document.getElementById('modal').hidden&&document.querySelector('#modal').textContent.includes('现金余额 · 12.5 USD')&&document.querySelector('#modal').textContent.includes('Key 预算')&&document.querySelector('#modal').textContent.includes('75 USD')&&document.querySelector('#modal').textContent.includes('观测时间')"), 'resource details lost typed amounts, hidden metrics or observation time'); await clickText('关闭');
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
  phase = 'business states';
  // Fixed business-state transitions, including long error/source text.
  for (const state of ['empty', 'error', 'offline', 'normal']) {
    sourceState = state; projects[0].running = state !== 'offline'; projects[0].error = state === 'error' ? '受控来源错误'.repeat(50) : null;
    if (state === 'normal') { development.counts.push({ status: 'failed', count: 1 }); development.merge_conflicts = 1; }
    await execute("window.before=JSON.stringify([...document.querySelectorAll('.dashboard-widget')].map(c=>{const r=c.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}));document.querySelector('.dashboard-toolbar button').click()"); await ready();
    assert(await execute("return window.before===JSON.stringify([...document.querySelectorAll('.dashboard-widget')].map(c=>{const r=c.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))"), 'state changed fixed grid'); await containment(state);
    if (state === 'normal') {
      assert(await execute(`const body=document.querySelector('[data-card-id="${P}"] .dashboard-widget-body');return [...body.children].map(n=>n.dataset.section).join(',')==='messages,distribution,delivery,metrics,recent'&&body.querySelector('[data-section="distribution"]').textContent.startsWith('失败 1')&&body.querySelector('[data-section="delivery"]').textContent.startsWith('冲突 1')`), 'failure/conflict must precede routine metrics and workers');
      development.counts.pop(); development.merge_conflicts = 0;
    }
    if (['error', 'offline'].includes(state)) {
      assert(await execute(`return document.querySelector('[data-card-id="${P}"] .dashboard-project-messages').textContent.includes('离线 · 未确认')`), 'offline source became an empty message count');
      await execute(`document.querySelector('[data-card-id="${P}"] .dashboard-project-details').click()`);
      assert(await execute(`return document.querySelector('#modal').textContent.includes(${JSON.stringify(state === 'error' ? projects[0].error : '后台未运行或不可达')})`), 'full source diagnostic unavailable'); await clickText('关闭');
    }
  }
  assert(queries.every(id => ids.slice(0, 4).includes(id)), 'refresh queried unplaced source');
  phase = 'keyboard geometry and reload';
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
  assert(await execute("const card=document.querySelector('[data-card-id=\"accounts\"]'),capacity=Number(card.querySelector('.dashboard-accounts-items').dataset.slotCount);return capacity>0&&document.querySelectorAll('.dashboard-account-embedded').length===capacity&&document.querySelectorAll('.dashboard-account-metric-slot').length===capacity*2&&card.textContent.includes(String(Math.ceil(100/capacity)))"), '100 sources not paged'); await containment('100 sources');
  const boundary = readDashboardSettings(config); boundary.layout.find(c => c.id === 'accounts').h = 17;
  saveDashboardSettings(config, { layout: boundary.layout }, boundary.revision); await rpc(`/session/${session}/refresh`, {}); await frame(); await ready();
  assert(await execute("return document.querySelectorAll('.dashboard-account-embedded').length===(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-height'))===32?3:2)"), 'h17 exceeds token-derived account body budget'); await containment('h17 accounts');
  const small = readDashboardSettings(config); small.layout.find(c => c.id === 'accounts').h = 10;
  Object.assign(small.layout.find(c => c.id === P), { w: 4, h: 10 });
  Object.assign(small.layout.find(c => c.id === 'widget:diagnostics'), { w: 4, h: 10 });
  saveDashboardSettings(config, { layout: small.layout }, small.revision); await rpc(`/session/${session}/refresh`, {}); await frame(); await ready();
  assert(await execute(`const card=document.querySelector('[data-card-id="${P}"]');return document.querySelectorAll('.dashboard-account-embedded').length===1&&card.querySelectorAll('.dashboard-widget-body .dashboard-widget-message').length===2&&!card.querySelector('.dashboard-widget-body .project-development-metrics')&&card.dataset.workerSlots==='0'`), 'minimum project priority/one account slot');
  assert(await execute("return !document.querySelector('.dashboard-diagnostics-card .diagnostics-trends')&&document.querySelectorAll('.dashboard-diagnostics-card .diagnostics-rate').length===6"), 'minimum diagnostic summary overflow');
  await execute("document.querySelector('.dashboard-diagnostics-details').click()"); assert(await wait("document.querySelector('#modal .diagnostics-trends')"), 'minimum diagnostics details lost trends'); await clickText('关闭');
  await execute(`document.querySelector('[data-card-id="${P}"] .dashboard-project-details').click()`);
  assert(await wait(`document.querySelector('#modal .project-development-metrics')&&document.querySelectorAll('#modal .project-development-worker').length===3&&document.querySelector('#modal a[href="/p/${P}/#workers"]')&&!document.querySelector('#modal a[href="/p/${P}/#versions"]')&&!document.querySelector('#modal').textContent.includes('读取中')`), 'minimum project details omitted selected content/recent snapshot/full-history entry'); await clickText('关闭');
  const connections = world.state.agentConnections.connections;
  for (const state of ['error', 'unknown', 'partial', 'disabled']) {
    connections[0].enabled = state !== 'disabled'; connections[0].observation.status = state === 'disabled' ? 'available' : state;
    connections[0].observation.reason = state === 'error' ? '受控查询诊断：凭证未确认，不能作为余额耗尽。' : null;
    connections[1].observation.status = state; await clickText('刷新全部'); await ready();
    for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
      await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.getElementById('viewport').style.width='${width}px'`); await frame();
      await execute(`document.documentElement.dataset.theme='${theme}'`); await settle(); await containment(`account state ${state}/${theme}/${width}`);
    }
    if (state === 'error') {
      await execute("document.querySelector('.dashboard-account-details').click()");
      assert(await execute("return document.querySelector('#modal').textContent.includes('受控查询诊断')&&!document.querySelector('#modal').textContent.includes('现金余额 · 0')"), 'query diagnostic hidden by default metadata selection'); await clickText('关闭');
    }
  }
  await clickText('编辑模式');
  for (const theme of ['light', 'dark']) for (const width of [1440, 1040, 640, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.getElementById('viewport').style.width='${width}px'`); await frame();
    await execute(`document.documentElement.dataset.theme='${theme}'`); await settle(); await containment(`minimum project/accounts ${theme}/${width}`); await screenshot(`minimum-${theme}-${width}`);
  }
  assert(await execute("return !window.fixtureErrors.length"), 'JS/CSP error: ' + JSON.stringify(await execute('return window.fixtureErrors')));
  console.log('PASS quick actions: scope/cancel/Agent costs, in-flight resize+refresh retention, full live failure details light/dark 1440/390/320, remove/undo/redo/cancel/library/shared save/layout and leave-confirmation cleanup; no continuation after removal.');
  console.log(`PASS restored controller: diagnostics independent read/focus/draft/unknown/no-project/error/toggle/keyboard resize, flat/paged navigation, account/Worker paging, h17 boundary, minimum project+diagnostic summary/details, read failure+ACK identity+continuation, business-state geometry, raw-member-preserving device save/reload and 100-source stress. Logs/screenshots: ${output}`);
  console.log('LIMIT Firefox headless/controlled source APIs; physical touch, Chromium/Safari and real providers unverified.');
} catch (error) { console.error('Panel fixture phase:', phase, 'script:', lastScript, 'last requests:', calls.slice(-12)); if (session) { try { await screenshot('failure'); console.error(await execute("return [...document.querySelectorAll('.dashboard-widget')].map(c=>({id:c.dataset.cardId,text:c.textContent.slice(0,300),html:c.innerHTML.slice(0,500)}))")); } catch {} } throw error; }
finally { if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} } driver.kill(); await driver.exited; server.stop(true); inputGate?.resolve(); await inputSource.close(); await rm(temp, { recursive: true, force: true }); }
