// Firefox layout/interaction regression with local fixtures; no daemon, real account or model calls.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { makeWorld } from '../test/web/dom-world.js';

const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-agent-layout-'));
const output = path.resolve(process.argv[2] || path.join(logs, 'screenshots'));
fs.mkdirSync(output, { recursive: true });
const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const world = makeWorld(), calls = [];
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
world.state.agentConnections.connections = ids.map((id, index) => ({ id,
  label: index ? '自定义 API · 长名称用于检验布局 '.repeat(4) : '我的 DeepSeek 账号',
  provider: index ? 'openai-compatible' : 'deepseek', endpoint: index ? `https://api.example.com/${'long-endpoint-'.repeat(12)}/v1` : 'https://api.deepseek.com',
  auth_type: 'api_key', enabled: !index, models: index ? ['vendor/chat'] : ['deepseek-chat'],
  default_model: index ? 'vendor/chat' : 'deepseek-chat', default_thinking: 'high', credential: { status: 'configured' },
  observation: { status: index ? 'unsupported' : 'available', source: 'usage_api', checked_at: '2026-10-05T12:00:00Z',
    resources: index ? [] : [{ id: 'cash', kind: 'balance', scope: 'account', label: '现金余额', unit: 'USD', remaining: 12.3 }] }, consumers: [] }));
const codexId = '33333333-3333-4333-8333-333333333333';
world.state.agentConnections.connections.push({ id: codexId, label: '我的 Codex 订阅', provider: 'openai-codex',
  endpoint: 'https://chatgpt.com/backend-api/codex', auth_type: 'oauth', enabled: true, models: ['gpt-6.1-sol'],
  default_model: 'gpt-6.1-sol', default_thinking: 'xhigh', credential: { status: 'configured' }, consumers: [],
  observation: { status: 'available', source: 'usage_api', checked_at: new Date().toISOString(), resources: [
    { id: 'short', kind: 'quota', scope: 'account', label: '短窗口', unit: '%', remaining: 75, total: 100, used_percent: 25,
      window_seconds: 18000, reset_at: new Date(Date.now() + 2 * 3600000).toISOString() },
    { id: 'week', kind: 'quota', scope: 'account', label: '周窗口', unit: '%', remaining: 10, total: 100, used_percent: 90,
      window_seconds: 604800, reset_at: new Date(Date.now() + 3 * 86400000).toISOString() },
  ] } });
// Exercise the tallest bounded summary: partial data, three metrics and a completed operation.
world.state.agentConnections.connections[0].observation.status = 'partial';
world.state.agentConnections.connections[0].observation.resources.push(
  { id: 'key', kind: 'quota', scope: 'key', label: 'Key 预算', unit: 'USD', total: 100, used: 30, remaining: 70 },
  { id: 'bonus', kind: 'balance', scope: 'account', label: '其他余额', unit: 'USD', remaining: 2 });
Object.assign(world.state.agentConfig.default, { agent: 'pi', connection_id: ids[0], model: 'deepseek/deepseek-chat' });
for (const role of Object.keys(world.state.agentConfig.resolved)) world.state.agentConfig.resolved[role] = { ...world.state.agentConfig.default };
for (const row of world.state.agentConnections.connections) row.storage_scope = 'device';
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/assets/styles.css"><link rel="stylesheet" href="/assets/styles-core.css"><link rel="stylesheet" href="/assets/styles-agent-status.css"><link rel="stylesheet" href="/assets/styles-agent-connections.css"><link rel="stylesheet" href="/assets/styles-agent-usage.css"></head>
<body><div id="detail"></div><div id="modal" hidden></div><div id="error"></div><script type="module">
window.browserErrors=[];addEventListener('error',e=>browserErrors.push(e.message));addEventListener('unhandledrejection',e=>browserErrors.push(String(e.reason)));
import {openAgentStatus} from '/assets/render-agent-status.js';import {openModelSources} from '/assets/render-model-sources.js';
import {ensureProject} from '/assets/project-picker.js';await ensureProject();
window.openConfig=openAgentStatus;window.openSources=openModelSources;await openModelSources();window.ready=true;
</script></body></html>`;
let server, driver, session, base, passed = false, diagnosisFails = false;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function rpc(route, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const request = http.request(base + route, { method, headers: { 'Content-Type': 'application/json' } }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) request.destroy(new Error('WebDriver response too large')); else chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() })); response.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(30000, () => request.destroy(new Error('WebDriver timeout')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const value = JSON.parse(response.text);
  if (response.status >= 400) throw new Error(JSON.stringify(value));
  return value.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
async function waitFor(expression) {
  assert(await rpc(`/session/${session}/execute/async`, { args: [], script: `const done=arguments[0];let n=0;const check=()=>{try{if(${expression})return done(true)}catch{}if(++n>200)return done(false);setTimeout(check,50)};check();` }), `Timed out: ${expression}`);
}
async function click(selector) {
  const node = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${node['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function screenshot(name) {
  fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
}
async function layout(name) {
  const result = await execute(`const p=document.querySelector('.model-sources-page,.agent-status-page');return {page:p.scrollWidth-p.clientWidth,document:document.documentElement.scrollWidth-innerWidth,inputs:[...p.querySelectorAll('input,select,textarea')].filter(n=>n.getClientRects().length).some(n=>n.getBoundingClientRect().right>innerWidth+1)};`);
  assert(result.page <= 1 && result.document <= 1 && !result.inputs, `Overflow ${name}: ${JSON.stringify(result)}`);
  const rows = await execute(`const rows=[...document.querySelectorAll('.model-source-row')].filter(n=>n.getClientRects().length);return rows.map(row=>{const box=row.getBoundingClientRect();return {height:box.height,overflow:row.scrollHeight>row.clientHeight+1,informationFirst:(()=>{const a=row.querySelector('.model-source-row-actions').getBoundingClientRect(),info=[...row.children].filter(n=>!n.matches('.model-source-row-actions')).map(n=>n.getBoundingClientRect());return a.top>=Math.max(...info.map(n=>n.bottom))-1||a.left>=Math.max(...info.map(n=>n.right))-1})(),controls:[...row.querySelectorAll('button,input')].every(n=>{const b=n.getBoundingClientRect();return b.top>=box.top&&b.bottom<=box.bottom&&b.right<=box.right})}});`);
  assert(rows.every(row => row.height === rows[0].height && !row.overflow && row.informationFirst && row.controls), `Unequal/clipped rows ${name}: ${JSON.stringify(rows)}`);
  assert(await execute(`return [...document.querySelectorAll('.model-source-key-amount')].filter(n=>n.getClientRects().length).every(n=>Number(getComputedStyle(n).fontWeight)>=700) && [...document.querySelectorAll('.model-source-refresh-row')].filter(n=>n.getClientRects().length).every(n=>(()=>{const c=n.querySelector('.model-source-cache-time').getBoundingClientRect(),b=n.querySelector('button').getBoundingClientRect();return c.bottom<=b.top+1||c.left>=b.right-1})());`), `Key amounts are not bold or refresh timestamp overlaps its button ${name}`);
  await screenshot(name);
}
try {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    if (/^\/assets\/[\w.-]+\.(js|css)$/.test(url.pathname)) return new Response(Bun.file(path.join(assets, path.basename(url.pathname))));
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    if (url.pathname === '/test/diagnosis' && request.method === 'POST') {
      diagnosisFails = url.searchParams.get('fail') === 'true';
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/api/host') return Response.json({ mode: 'bound' });
    calls.push(url.pathname);
    const scoped = value => ({ ...value, configuration_scope: { selected: url.searchParams.get('scope') || 'project',
      source: 'device', project_override: false, device_home: '/tmp/layout-device/shared', project_home: '/tmp/layout-fixture/.lush' } });
    if (url.pathname === '/api/agent/status') return diagnosisFails
      ? Response.json({ error: 'Fixture software check failed' }, { status: 503 })
      : Response.json({ version: 2, checked_at: new Date().toISOString(), scope: { project: '/tmp/layout-fixture', note: '软件诊断，不读取账号或凭证。' }, warnings: [],
          software: ['pi', 'codex'].map(agent => ({ agent, command: agent, executable: `/bin/${agent}`, real_path: `/opt/${agent}/cli.js`, version: '1.2.3', status: 'available', warning: null })) });
    if (url.pathname === '/api/agent/connections') return Response.json(scoped(world.state.agentConnections));
    if (url.pathname === '/api/action' && request.method === 'POST') {
      const action = await request.json();
      assert(action.method === 'agent.connections.query', `Unexpected mock action: ${action.method}`);
      return Response.json(scoped(world.state.agentConnections));
    }
    if (url.pathname === '/api/agent/config') return Response.json(scoped(world.state.agentConfig));
    if (url.pathname === '/api/agent/resources') return Response.json({ extensions: [], skills: [], warning: null });
    // Agent 配置页与来源选择读取的本地目录；fixture 只给空/未确认结果，不联网、不调用模型。
    if (url.pathname === '/api/agent/packages') return Response.json({ version: 1, packages: [], resources: { extensions: [], skills: [] }, truncated: false });
    if (url.pathname === '/api/agent/connections/models') return Response.json({ version: 1, id: url.searchParams.get('id'), checked_at: null, status: 'unsupported', source: null, models: [] });
    if (url.pathname === '/api/agent/usage/history') return Response.json(world.state.agentUsageHistory);
    return Response.json({ error: `Unexpected request: ${url.pathname}` }, { status: 400 });
  } });
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = reservation.port; reservation.stop(true); base = `http://127.0.0.1:${port}`;
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(logs, 'driver.log')), stderr: Bun.file(path.join(logs, 'driver.log')) });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited during startup');
    await Bun.sleep(100);
  }
  assert(ready, 'WebDriver startup timeout');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` }); await waitFor('window.ready');
  assert(await execute(`const rows=document.querySelector('.model-source-rows'),tools=document.querySelector('.model-source-intro');return document.querySelectorAll('.model-source-row').length===3 && document.querySelector('.model-source-detail').hidden && rows.getBoundingClientRect().top<innerHeight && tools.getBoundingClientRect().top>=rows.getBoundingClientRect().bottom;`), 'Information-first overview or closed initial panel missing');
  assert(await execute(`const row=document.querySelector('[data-source-id="${codexId}"]');return row.textContent.includes('gpt-6.1-sol') && !row.textContent.includes('xhigh') && row.textContent.includes('已用 25%') && row.textContent.includes('已用 90%') && !row.querySelector('details') && row.querySelectorAll('[role="progressbar"]').length===2 && !row.querySelector('.model-source-resource-summary').textContent.includes('观测成功') && row.querySelector('.model-source-cache-time').textContent.includes('上次刷新') && row.querySelector('.model-source-cache-time').getAttribute('data-help').includes('缓存观测（非实时）');`), 'Bounded Codex model/quota summary missing');
  await click('.model-source-row:nth-child(3) .model-source-row-actions > button:last-child');
  assert(await execute(`const card=document.querySelector('[data-connection-id="${codexId}"]'),pane=document.querySelector('.model-source-detail'),row=document.querySelector('[data-source-id="${codexId}"]');return pane.previousElementSibling===row && getComputedStyle(pane).position==='static' && pane.getBoundingClientRect().top>=row.getBoundingClientRect().bottom && card.textContent.includes('xhigh') && card.querySelectorAll('[role="progressbar"]').length===2 && [...card.querySelectorAll('.agent-reset-remaining')].every(n=>n.textContent.includes('后重置'));`), 'Full per-source quota detail missing');
  await click('.model-source-back');
  await click('.model-source-row:first-child .model-source-refresh-row button');
  await waitFor('document.querySelector(".model-source-row:first-child .model-source-operation")?.textContent.includes("刷新完成")');
  await click('.model-source-row:nth-child(2) .model-source-row-actions > button:last-child');
  assert(await execute(`return document.querySelector('.agent-connections-panel').textContent.includes('不支持') && !document.querySelector('[data-connection-field="api_key"]')?.getClientRects().length`), 'Unknown quota or write-only editor wrong');
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1440,900], [900,700], [390,844]]) {
    await rpc(`/session/${session}/window/rect`, { width, height });
    await execute(`document.documentElement.dataset.theme='${theme}';window.scrollTo(0,0)`);
    if (await execute(`return !document.querySelector('.model-source-detail').hidden`)) await click('.model-source-back');
    await layout(`overview-${theme}-${width}`);
    await click('.model-source-row:nth-child(2) .model-source-row-actions > button:last-child');
    assert(await execute(`const pane=document.querySelector('.model-source-detail'),list=document.querySelector('.model-source-list');return getComputedStyle(pane).position==='static' && getComputedStyle(list).display!=='none'`), 'Source detail is not inline or hid the overview');
    await layout(`sources-${theme}-${width}`);
    await click('.model-source-back');
    assert(await execute(`return getComputedStyle(document.querySelector('.model-source-list')).display!=='none' && getComputedStyle(document.querySelector('.model-source-detail')).display==='none'`), 'Return did not show overview');
    await click('.model-source-row:first-child .model-source-row-actions > button:last-child');
    assert(await execute(`return document.activeElement.matches('.agent-connection-card h3') && document.querySelector('.model-source-row:first-child').getAttribute('aria-current')==='true'`), 'Source selection lost keyboard focus');
    await click('.model-source-back');
    assert(await execute(`return document.activeElement.matches('.model-source-row:first-child button:last-child')`), 'Focus not returned to detail trigger');
    await click('.model-source-intro .agent-connection-actions > .primary');
    assert(await execute(`return document.activeElement.matches('[data-connection-field="label"]') && document.querySelector('.model-source-detail').getAttribute('aria-modal')===null`), 'Editor focus/nonmodal semantics missing');
    await layout(`editor-${theme}-${width}`);
    await execute(`document.querySelector('.model-source-detail').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);
    assert(await execute(`return document.activeElement.textContent==='添加连接'`), 'Escape not returned to add trigger');
    await execute(`const s=document.querySelector('.model-source-filters input');s.value='自定义';s.dispatchEvent(new Event('input'));`);
    assert(await execute(`return document.querySelectorAll('.model-source-row').length===1`), 'Local source search failed');
    await execute(`const s=document.querySelector('.model-source-filters input');s.value='';s.dispatchEvent(new Event('input'));`);
    await click('.model-source-row:nth-child(2) .model-source-row-actions > button:last-child');
    await execute('window.openConfig()'); await waitFor('document.querySelector("[data-agent-target=default]")');
    await layout(`config-${theme}-${width}`);
    await waitFor('document.querySelector(".agent-default-summary")?.textContent.includes("我的 DeepSeek")');
    await execute(`document.querySelector('[data-agent-field="model"]').value='unsaved-model';`);
    await click('[data-agent-tab="status"]');
    await waitFor('document.querySelector(".agent-status-feedback")?.textContent.includes("检查完成")');
    assert(await execute(`const results=document.querySelector('.agent-status-results');return results.textContent.includes('Pi 软件') && results.textContent.includes('Codex 软件') && results.textContent.includes('1.2.3') && !results.querySelector('.agent-status-accounts,.agent-status-model-table,.agent-usage-panel');`), 'Software-only diagnosis missing or contains old account diagnostics');
    await layout(`diagnosis-${theme}-${width}`);
    await fetch(`http://127.0.0.1:${server.port}/test/diagnosis?fail=true`, { method: 'POST' });
    await click('.agent-status-refresh');
    await waitFor('document.querySelector(".agent-status-feedback")?.textContent.includes("检查失败")');
    await fetch(`http://127.0.0.1:${server.port}/test/diagnosis?fail=false`, { method: 'POST' });
    await click('[data-agent-tab="settings"]');
    assert(await execute(`return document.querySelector('[data-agent-field="model"]').value==='unsaved-model'`), 'Diagnostic failure lost configuration draft');
    await execute('window.openSources()'); await waitFor('document.querySelectorAll(".model-source-row").length===3');
    if (await execute(`return !document.querySelector('.model-source-detail').hidden`)) await click('.model-source-back');
    assert(await execute(`return document.querySelector('.legacy-usage-history').hidden`), 'Legacy archive unexpectedly loaded on entry');
    await click('.model-sources-legacy-history > button');
    await waitFor('document.querySelector(".agent-usage-history-feedback")?.textContent.includes("已读取本地缓存")');
    assert(await execute(`const archive=document.querySelector('.legacy-usage-history');return !archive.hidden && archive.textContent.includes('只读旧余额') && !archive.querySelector('.agent-usage-config,[data-usage-field]');`), 'Legacy archive is not read-only');
    await layout(`archive-${theme}-${width}`);
    await click('.model-sources-legacy-history > button');
    console.log(`PASS Agent/source layout and interaction ${theme}/${width}`);
  }
  assert(calls.every(route => ['/api/action', '/api/agent/connections', '/api/agent/connections/models', '/api/agent/packages',
    '/api/agent/config', '/api/agent/status', '/api/agent/usage/history'].includes(route)), `Unexpected API: ${calls.join(',')}`);
  assert(calls.filter(route => route === '/api/agent/usage/history').length === 6, 'Archive history must load only on explicit open');
  assert(await execute('return window.browserErrors.length===0'), 'Browser emitted errors');
  passed = true; console.log(`PASS mock-only equal-height compact overview/detail/editor layouts, Codex summary and full windows/countdown, narrow screen navigation, local search, focus/Escape and draft preservation, software-only diagnosis and read-only legacy archive. Screenshots: ${output}`);
} catch (error) {
  if (session) await screenshot('failure').catch(() => {});
  console.error(`Agent browser failure; full logs: ${logs}`); throw error;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  if (driver) { driver.kill(); await driver.exited; }
  server?.stop(true);
  if (passed) fs.rmSync(path.join(logs, 'driver.log'), { force: true });
}
