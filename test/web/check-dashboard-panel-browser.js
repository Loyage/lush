// Compiled real panel + grid + private v4 writer, isolated controlled source APIs.
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
const config = { deviceHome: join(temp, 'shared') }, P = 'aaaaaaaaaaaaaaaa', Q = 'bbbbbbbbbbbbbbbb';
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
  { id: Q, name: '项目B', project: '/fixture/project-b', running: false }];
const question = { id: 19, task_id: 27, task_worker_number: 'W234-1', kind: 'questionnaire', status: 'open', title: '待答 ' + '具体决策'.repeat(60), body: '', created_at: '2026-10-01T00:00:00Z' };
const infos = [20, 18, 16].map(id => ({ id, task_id: 27, task_worker_number: 'W234-1', kind: 'info', status: 'sent', source_event_id: id,
  read_at: null, title: `告知${id} ` + '变化信息'.repeat(60), body: '', created_at: '2026-10-01T00:00:00Z', sync_identity: id.toString(16).padStart(32, '0'), sync_epoch: 'e'.repeat(32), sync_revision: 1 }));
let sourceState = 'normal', rejectRead = false;
const widgets = ['status', 'messages', 'workers', 'accounts', 'shortcuts'].map(type => newWidget(type, `widget:${type}`, ['status', 'messages', 'workers'].includes(type) ? P : null));
widgets.find(w => w.type === 'accounts').connection_ids = ids.slice(0, 4);
widgets.find(w => w.type === 'shortcuts').links = ['notices', 'project-management', 'model-sources', 'settings'].map(target => ({ scope: 'global', target, project_id: null }));
widgets.push(newWidget('messages', 'widget:messages-2', P));
const layout = [{ id: 'widget:status', x: 0, y: 0, w: 4, h: 10 }, { id: 'widget:messages', x: 4, y: 0, w: 4, h: 10 },
  { id: 'widget:workers', x: 8, y: 0, w: 4, h: 12 }, { id: 'widget:accounts', x: 0, y: 12, w: 6, h: 14 },
  { id: 'widget:shortcuts', x: 6, y: 12, w: 6, h: 10 }, { id: 'widget:messages-2', x: 6, y: 22, w: 6, h: 10 }];
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
      return Response.json({ notices: all, total: url.searchParams.get('status') === 'open' && all.length ? 4 : all.length, cursor: all.at(-1)?.id || null, has_more: false });
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
const clickText = text => execute(`const b=[...document.querySelectorAll('#modal button,#detail button')].find(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled);if(!b)throw Error('missing button '+${JSON.stringify(text)});b.click();`);
async function frame() { const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: element }); }
async function screenshot(name) { await writeFile(join(output, name + '.png'), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64')); }
async function ready() { assert(await wait("document.querySelectorAll('.dashboard-widget').length>=6&&!document.querySelector('.dashboard-settings-open').disabled&&!document.querySelector('.dashboard-widget-workers').textContent.includes('读取中')"), 'panel ready timeout'); await settle(); }
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
    assert(await execute(`return document.querySelectorAll('.dashboard-widget-messages .dashboard-widget-message').length===4&&[...document.querySelectorAll('.project-dashboard-message')].every(a=>a.target==='_blank'&&a.rel==='noopener'&&a.href.includes('/p/${P}/#notices-')&&getComputedStyle(a).flexWrap==='nowrap')&&[...document.querySelectorAll('.dashboard-account-reading')].every(h=>h.getBoundingClientRect().height>=14&&h.textContent.includes('25%'))`), 'message source links/two rows');
    await screenshot(`${theme}-${width}`);
    await execute(`window.before=JSON.stringify([...document.querySelectorAll('.dashboard-widget')].map(c=>{const r=c.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}));document.querySelector('.dashboard-settings-open').click()`);
    assert(await execute(`const r=document.querySelector('#modal .modal-card').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&window.before===JSON.stringify([...document.querySelectorAll('.dashboard-widget')].map(c=>{const r=c.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))`), 'modal moved grid/overflow'); await clickText('取消');
    await clickText('编辑布局'); await containment(`${theme}/${width}/editing`); await clickText('取消布局');
    console.log(`PASS assembled ${theme}/${width}: fixed containment, source links, settings and editing`);
  }
  // Real account and Worker pages; no implicit writes/provider queries.
  await execute("document.querySelector('[data-card-id=\"widget:accounts\"] .dashboard-widget-pagination > span:last-child button').click()");
  assert(await wait("document.querySelector('[data-card-id=\"widget:accounts\"]').textContent.includes('账户3')"), 'account next page');
  await execute("document.querySelector('[data-card-id=\"widget:workers\"] .dashboard-widget-pagination > span:nth-child(3) button').click()");
  assert(await wait("document.querySelector('[data-card-id=\"widget:workers\"]').textContent.includes('第 2 页')"), 'Worker next page'); await containment('paged');
  await execute("document.querySelector('.dashboard-account-details').click()"); assert(await wait("!document.getElementById('modal').hidden"), 'resource details'); await clickText('关闭');
  rejectRead = true; await execute("document.querySelector('.dashboard-widget-notice-read').click()");
  assert(await wait("document.querySelector('.dashboard-widget-messages').textContent.includes('已知失败')"), 'failed read not reported');
  assert(infos[0].read_at === null && reads.length === 1, 'failed read removed notice'); await containment('notice read failure'); rejectRead = false;
  await execute("document.querySelector('.dashboard-widget-notice-read').click()");
  assert(await wait("[...document.querySelectorAll('.dashboard-widget-messages')].every(c=>c.textContent.includes('告知18')&&!c.textContent.includes('告知20'))"), 'read ACK not synchronized across cards');
  assert(reads.length === 2 && reads.every(r => r.method === 'notice.read' && r.project_id === P && r.expected_identity), 'read escaped source/identity');
  await containment('read ACK');
  // Fixed business-state transitions, including long error/source text.
  for (const state of ['empty', 'error', 'offline', 'normal']) {
    sourceState = state; projects[0].running = state !== 'offline'; projects[0].error = state === 'error' ? '受控来源错误'.repeat(50) : null;
    await execute("window.before=JSON.stringify([...document.querySelectorAll('.dashboard-widget')].map(c=>{const r=c.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}));document.querySelector('.dashboard-toolbar button').click()"); await ready();
    assert(await execute("return window.before===JSON.stringify([...document.querySelectorAll('.dashboard-widget')].map(c=>{const r=c.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))"), 'state changed fixed grid'); await containment(state);
  }
  assert(queries.every(id => ids.slice(0, 4).includes(id)), 'refresh queried unplaced source');
  // Real controller keyboard geometry save + shared private writer + reload.
  await rpc(`/session/${session}/frame`, { id: null }); await execute("document.getElementById('viewport').style.width='1440px'"); await frame(); await settle(); await clickText('编辑布局');
  const resize = await rpc(`/session/${session}/element`, { using: 'css selector', value: '[data-card-id="widget:workers"] .project-board-resize[data-corner="east"]' });
  const beforeSave = saves.length; await rpc(`/session/${session}/element/${resize['element-6066-11e4-a52e-4f735466cecf']}/value`, { text: '\uE015' });
  assert(saves.length === beforeSave, 'resize saved implicitly'); await clickText('保存布局'); await ready();
  assert(saves.length === beforeSave + 1 && readDashboardSettings(config).layout.find(c => c.id === 'widget:workers').h === 13, 'keyboard geometry not saved');
  await rpc(`/session/${session}/refresh`, {}); await frame(); await ready();
  assert(await execute("return document.querySelector('[data-card-id=\"widget:workers\"]').style.gridRow.includes('span 13')"), 'reload lost geometry');
  // A hundred sources still only occupy the selected fixed page, even with 8 resources each.
  const current = readDashboardSettings(config); current.widgets.find(w => w.type === 'accounts').connection_ids = ids;
  saveDashboardSettings(config, { widgets: current.widgets }, current.revision); await rpc(`/session/${session}/refresh`, {}); await frame(); await ready();
  assert(await execute("return document.querySelectorAll('.dashboard-account-embedded').length===2&&document.querySelectorAll('.dashboard-account-metric-slot').length===4&&document.querySelector('[data-card-id=\"widget:accounts\"]').textContent.includes('50')"), '100 sources not paged'); await containment('100 sources');
  const small = readDashboardSettings(config); small.layout.find(c => c.id === 'widget:accounts').h = 10;
  saveDashboardSettings(config, { layout: small.layout }, small.revision); await rpc(`/session/${session}/refresh`, {}); await frame(); await ready();
  assert(await execute("return document.querySelectorAll('.dashboard-account-embedded').length===1"), 'minimum account geometry must have one source');
  const connections = world.state.agentConnections.connections;
  for (const state of ['error', 'unknown', 'partial', 'disabled']) {
    connections[0].enabled = state !== 'disabled'; connections[0].observation.status = state === 'disabled' ? 'available' : state;
    connections[1].observation.status = state; await clickText('刷新全部'); await ready();
    for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
      await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.getElementById('viewport').style.width='${width}px'`); await frame();
      await execute(`document.documentElement.dataset.theme='${theme}'`); await settle(); await containment(`account state ${state}/${theme}/${width}`);
    }
  }
  assert(await execute("return !window.fixtureErrors.length"), 'JS/CSP error: ' + JSON.stringify(await execute('return window.fixtureErrors')));
  console.log(`PASS real controller: account/Worker paging, bounded metrics/modal, read failure+ACK multi-card identity, business-state geometry, explicit device save/reload and 100-source stress. Logs/screenshots: ${output}`);
  console.log('LIMIT Firefox headless/controlled source APIs; physical touch, Chromium/Safari and real providers unverified.');
} catch (error) { if (session) { try { await screenshot('failure'); console.error(await execute("return [...document.querySelectorAll('.dashboard-widget')].map(c=>({id:c.dataset.cardId,text:c.textContent.slice(0,300),html:c.innerHTML.slice(0,500)}))")); } catch {} } throw error; }
finally { if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} } driver.kill(); await driver.exited; server.stop(true); await rm(temp, { recursive: true, force: true }); }
