// Compiled assembled dashboard, real device configuration in a temporary directory,
// controlled project/connection APIs. No daemon, real credentials, provider or model calls.
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { buildAssets } from '../../src/ui/web/build-assets.js';
import { readDashboardSettings, saveDashboardSettings } from '../../src/core/dashboard-settings.js';
import { makeWorld } from './dom-world.js';
const temp = await mkdtemp(join(tmpdir(), 'lush-dashboard-panel-browser-'));
const output = process.argv[2] || temp;
await mkdir(output, { recursive: true });
const assets = join(temp, 'assets');
await buildAssets(new URL('../../src/ui/web/assets/', import.meta.url).pathname, assets, 'd'.repeat(32));
const entry = await Bun.file(join(assets, 'index.html')).text();
const config = { deviceHome: join(temp, 'shared') };
const P = 'aaaaaaaaaaaaaaaa', Q = 'bbbbbbbbbbbbbbbb';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const initial = readDashboardSettings(config);
saveDashboardSettings(config, { cards: [{ type: 'account', connection_id: A }], hidden_projects: [Q] }, initial.revision);
const world = makeWorld(), calls = [], queries = [], saves = [];
const development = { workers_total: 31, active: 2, agents_running: 1, awaiting_acceptance: 3, parent_confirmation: 2,
  pending_merges: 1, merging: 0, merge_conflicts: 0, counts: [{ status: 'running', count: 2 }],
  recent_workers: [{ id: 27, worker_number: 'W204-1', auto_title: '真实来源链接', status: 'waiting', integration: 'none' }] };
world.state.agentConnections.connections = [A, B].map((id, i) => ({ id, label: `账户 ${i + 1}`, provider: 'deepseek', enabled: true,
  observation: { status: 'available', source: 'usage_api', checked_at: '2026-10-01T00:00:00Z', resources: [
    { id: 'quota', kind: 'quota', scope: 'account', label: '5h', unit: '%', remaining: 75, used_percent: 25,
      reset_at: '2028-10-01T00:00:00Z', window_seconds: 18000 },
    { id: 'cash', kind: 'balance', scope: 'account', label: '账户现金', unit: 'USD', remaining: 12.5 } ] } }));
const projects = [{ id: P, name: '项目卡片', project: '/fixture/project-a', running: true, summary: { notices: 1, development } },
  { id: Q, name: '离线项目', project: '/fixture/project-b', running: false }];
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
    if (path === '/api/host/dashboard') {
      if (req.method === 'POST') {
        const { expected_revision, ...patch } = await req.json(); saves.push(patch);
        try { return Response.json(saveDashboardSettings(config, patch, expected_revision)); }
        catch { return Response.json({ error: 'revision changed' }, { status: 400 }); }
      }
      return Response.json(readDashboardSettings(config));
    }
    if (path.endsWith('/appearance')) return Response.json({ id: path.split('/')[4], appearance: { version: 1, color: 'rose' } });
    if (path === `/p/${P}/api/notices`) return Response.json({ notices: url.searchParams.get('status') === 'open' ? [{ id: 19, task_id: 27,
      task_worker_number: 'W204-1', kind: 'questionnaire', status: 'open', title: '等待决定' }] : [{ id: 20, task_id: 27,
      task_worker_number: 'W204-1', kind: 'info', status: 'sent', source_event_id: 8, read_at: null, title: '交付告知' }], has_more: false });
    if (path === '/api/host/settings/action') {
      const body = await req.json();
      if (body.method === 'agent.connections.query') {
        queries.push(body.params.id);
        const source = world.state.agentConnections.connections.find(connection => connection.id === body.params.id);
        if (source) source.observation.checked_at = new Date().toISOString();
        return Response.json({ ...world.state.agentConnections, configuration_scope: { selected: 'device', source: 'device', project_override: false } });
      }
      const response = await world.fetchImpl(path, { method: req.method, body: JSON.stringify(body) }); return Response.json(await response.json());
    }
    const response = await world.fetchImpl(path + url.search, { method: req.method, ...(req.method === 'POST' ? { body: await req.text() } : {}) });
    return Response.json(await response.json(), { status: response.status || 200 });
  }
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' },
  stdout: Bun.file(join(output, 'dashboard-driver.log')), stderr: Bun.file(join(output, 'dashboard-driver.log')) });
let session, passed = false;
async function rpc(path, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    }); req.on('error', reject); req.setTimeout(60000, () => req.destroy(Error('WebDriver timeout'))); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const result = JSON.parse(response.text); if (response.status >= 400) throw Error(JSON.stringify(result)); return result.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const asyncExecute = script => rpc(`/session/${session}/execute/async`, { script, args: [] });
const wait = condition => asyncExecute(`const done=arguments[0];let n=0;const check=()=>(${condition})?done(true):++n>150?done(false):setTimeout(check,30);check();`);
const assert = (value, message) => { if (!value) throw Error(message); };
const clickText = text => execute(`const button=[...document.querySelectorAll('#detail button')].find(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled);if(!button)throw Error('missing button');button.click();`);
async function frame() {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: element });
}
try {
  let started = false;
  for (let i = 0; i < 100; i++) { try { await rpc('/status', undefined, 'GET'); started = true; break; } catch {} if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100); }
  assert(started, 'driver startup timeout');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1000 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/fixture` }); await frame();
  assert(await wait(`document.querySelectorAll('.project-board-card').length===2&&!document.querySelector('.dashboard-settings-open').disabled`), 'compiled dashboard failed to load');
  assert(queries.length === 0 && saves.length === 0, 'entering dashboard queried providers or wrote defaults');
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.getElementById('viewport').style.width='${width}px';window.scrollTo(0,0)`); await frame();
    await execute(`document.documentElement.dataset.theme='${theme}';`);
    await asyncExecute('const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));');
    assert(await execute(`return document.getElementById('view-toolbar').hidden&&!document.querySelector('#detail h1')&&document.documentElement.scrollWidth<=innerWidth&&document.getElementById('detail').scrollWidth<=document.getElementById('detail').clientWidth&&[...document.querySelectorAll('.project-board-card')].every(c=>{const r=c.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})`), `panel/overflow ${theme}/${width}`);
    assert(await execute(`return new Set([...document.querySelectorAll('.project-development-value')].map(e=>getComputedStyle(e).color)).size===3&&document.querySelector('.project-dashboard-message.tone-amber').href.endsWith('/p/${P}/#notices-19')&&document.querySelector('.project-dashboard-message.tone-blue').href.endsWith('/p/${P}/#notices-20')`), 'metric tones or source Notice links failed');
    await execute(`document.querySelector('.dashboard-settings-open').click()`);
    assert(await execute(`return document.querySelector('.dashboard-settings-panel').hidden===false&&!document.querySelector('.dashboard-settings-panel input[data-project-id="${Q}"]').checked&&[...document.querySelectorAll('.dashboard-settings-panel input')].length===4&&document.getElementById('detail').scrollWidth<=document.getElementById('detail').clientWidth`), `settings layout ${width}`);
    await clickText('关闭'); await clickText('编辑布局');
    assert(await execute(`return [...document.querySelectorAll('.project-board-card')].every(c=>{const a=c.querySelector('.dashboard-card-settings').getBoundingClientRect(),b=c.querySelector('.project-board-handle').getBoundingClientRect();return b.width>=44&&a.width>=44&&b.right<=a.left+1})`), `settings/edit overlap ${width}`);
    await clickText('取消布局');
    if (width <= 760) {
      assert(await execute(`const r=document.querySelector('.rail-heading').getBoundingClientRect();return r.height===52&&document.getElementById('mobile-view-title').textContent===''&&document.getElementById('sidebar-toggle').getBoundingClientRect().right<=innerWidth`), 'compact parent header or title-free dashboard failed');
      await execute(`document.getElementById('sidebar-toggle').click();document.getElementById('project-management-open').click()`);
      assert(await wait(`document.querySelector('.project-manager-list')&&!document.getElementById('view-toolbar').hidden&&document.getElementById('mobile-view-title').textContent==='项目管理'&&document.getElementById('sidebar-toggle').getAttribute('aria-expanded')==='false'`), 'mobile management navigation did not restore page chrome/close menu');
      await execute(`document.getElementById('sidebar-toggle').click();document.getElementById('projects-open').click()`);
      assert(await wait(`document.querySelectorAll('.project-board-card').length===2&&!document.querySelector('.dashboard-settings-open').disabled&&document.getElementById('view-toolbar').hidden&&document.getElementById('mobile-view-title').textContent===''&&document.getElementById('sidebar-toggle').getAttribute('aria-expanded')==='false'`), 'mobile return did not restore dashboard/close menu');
    }
    console.log(`PASS compiled panel ${theme}/${width}: header-free, semantic colors, source messages, settings and editing hit areas`);
  }
  // Persist a keyboard resize through the actual controller and the actual private device writer.
  await rpc(`/session/${session}/frame`, { id: null }); await execute("document.getElementById('viewport').style.width='1440px'"); await frame();
  await clickText('编辑布局');
  const resize = await rpc(`/session/${session}/element`, { using: 'css selector', value: `[data-project-id="${P}"] .project-board-resize[data-corner="east"]` });
  await execute(`document.querySelector('[data-project-id="${P}"] .project-board-resize').focus()`);
  await rpc(`/session/${session}/element/${resize['element-6066-11e4-a52e-4f735466cecf']}/value`, { text: '\uE014' });
  assert(saves.length === 0, 'keyboard resize saved implicitly'); await clickText('保存布局');
  assert(await wait(`!document.querySelector('.dashboard-settings-open').disabled&&document.querySelector('.dashboard-status').textContent==='已保存'`), 'layout save failed');
  assert(readDashboardSettings(config).layout.find(item => item.id === P)?.w === 7, 'device layout did not persist keyboard resize');
  await execute(`document.querySelector('[data-project-id="${P}"] .dashboard-card-settings').click()`);
  await execute(`const checkbox=document.querySelector('.dashboard-settings-panel input[data-section="messages"]');checkbox.checked=false;checkbox.dispatchEvent(new Event('change'));`);
  await clickText('保存'); assert(await wait(`!document.querySelector('.dashboard-settings-open').disabled&&document.querySelector('.dashboard-settings-panel').hidden`), 'content save failed');
  assert(await execute(`return !document.querySelector('[data-project-id="${P}"] .project-dashboard-messages')`), 'content switch did not hide messages');
  await clickText('刷新全部'); assert(await wait(`!document.querySelector('.dashboard-settings-open').disabled`), 'global refresh failed');
  assert(queries.length === 1 && queries[0] === A, 'global refresh included unplaced account');
  await rpc(`/session/${session}/refresh`, {}); await frame();
  assert(await wait(`document.querySelectorAll('.project-board-card').length===2&&!document.querySelector('.dashboard-settings-open').disabled`), 'reload failed');
  assert(await execute(`return document.querySelector('[data-project-id="${P}"]').style.gridColumn.includes('span 7')&&!document.querySelector('[data-project-id="${P}"] .project-dashboard-messages')`), 'device layout/content did not survive reload');
  assert(queries.length === 1, 'reload implicitly queried accounts');
  await execute(`document.getElementById('project-management-open').click()`);
  assert(await wait(`document.querySelector('.project-manager-list')`), 'management page failed');
  assert(await execute(`return !document.querySelector('.dashboard-settings-panel')&&!document.querySelector('section.dashboard-card-settings')&&!document.getElementById('view-toolbar').hidden`), 'settings remained in management or title toolbar failed to return');
  assert(!calls.some(call => call.path.includes(`/p/${Q}/api/notices`) || /projects\/start|host\/select/.test(call.path)), 'offline background was queried/started');
  assert(await execute('return fixtureErrors.length===0'), `browser/CSP errors: ${JSON.stringify(await execute('return fixtureErrors'))}`);
  console.log('PASS actual device layout/content persistence, native keyboard resizing, selected-account refresh, reload and management separation; no CSP/runtime errors');
  passed = true;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true);
  if (passed && output !== temp) await rm(temp, { recursive: true, force: true });
  else console.log(`fixture artifacts: ${temp}`);
}
