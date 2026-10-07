// Scoped settings Firefox fixture: temporary HTTP/profile only; no daemon, accounts or models.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { makeWorld } from './dom-world.js';

const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-agent-layout-'));
const output = path.resolve(process.argv[2] || path.join(logs, 'screenshots'));
fs.mkdirSync(output, { recursive: true });
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
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
for (const row of world.state.agentConnections.connections) row.storage_scope='device';
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/assets/styles.css"><link rel="stylesheet" href="/assets/styles-core.css"><link rel="stylesheet" href="/assets/styles-agent-status.css"><link rel="stylesheet" href="/assets/styles-agent-connections.css"><link rel="stylesheet" href="/assets/styles-agent-usage.css"></head>
<body><div id="detail"></div><div id="modal" hidden></div><div id="error"></div><script type="module">
window.browserErrors=[];addEventListener('error',e=>browserErrors.push(e.message));addEventListener('unhandledrejection',e=>browserErrors.push(String(e.reason)));
import {openAgentStatus} from '/assets/render-agent-status.js';import {openModelSources} from '/assets/render-model-sources.js';
import {ensureProject} from '/assets/project-picker.js';import {openSettings} from '/assets/render-settings.js';import {openQuickExplanationPage} from '/assets/render-quick-explanation.js';await ensureProject();window.ensureProject=ensureProject;window.openSystem=async()=>{openSettings();return document.querySelector('[data-settings-tab=system]').onclick()};window.openExplain=openQuickExplanationPage;window.openConfig=openAgentStatus;window.openSources=openModelSources;await openModelSources();window.ready=true;
</script></body></html>`;
let server, driver, session, base, passed = false, diagnosisFails = false, noProjectMode = false;
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

try {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/test/mode') { noProjectMode=url.searchParams.get('global')==='true';return new Response(null,{status:204}); }
    if (url.pathname === '/api/host') return Response.json(noProjectMode ? {mode:'host',projects:[]} : {mode:'bound'});
    url.pathname=url.pathname.replace(/^\/api\/host\/settings\//,'/api/');
    if (url.pathname==='/api/runtime') url.pathname='/api/settings/runtime';
    if (url.pathname === '/') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    if (/^\/assets\/[\w.-]+\.(js|css)$/.test(url.pathname)) return new Response(Bun.file(path.join(assets, path.basename(url.pathname))));
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    if (url.pathname === '/test/diagnosis' && request.method === 'POST') {
      diagnosisFails = url.searchParams.get('fail') === 'true';
      return new Response(null, { status: 204 });
    }
    calls.push(new URL(request.url).pathname);
    const scoped = value => ({...value, configuration_scope:{selected:url.searchParams.get('scope') || 'project', source:'device', project_override:false}});
    if (url.pathname === '/api/settings/runtime') return Response.json(scoped(world.state.runtimeSettings));
    if (url.pathname === '/api/quick-explain/config') return Response.json(scoped(world.state.quickExplanationConfig));
    if (url.pathname === '/api/agent/environment') return Response.json(scoped({target:'common',values:{},file:'/fixture/agent.env'}));
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
  async function scope(value) {
    await execute(`const s=document.querySelector('[data-settings-scope]');s.value='${value}';return s.onchange()`);
  }
  async function layout(name, width) {
    const result=await execute(`const p=document.querySelector('.model-sources-page,.agent-status-page,.settings-view,.quick-explanation-page'),s=p.querySelector('.settings-scope-control');return {page:p.scrollWidth-p.clientWidth,root:document.documentElement.scrollWidth-innerWidth,flex:getComputedStyle(s).display,controls:[...p.querySelectorAll('input,select,textarea')].filter(n=>n.getClientRects().length).every(n=>n.getBoundingClientRect().right<=${width}+1)};`);
    assert(result.page<=1 && result.root<=1 && result.controls && result.flex==='flex', `Scoped layout ${name}: ${JSON.stringify(result)}`);
    await screenshot(name);
  }
  for (const theme of ['light','dark']) for (const width of [1440,900,390]) {
    await rpc(`/session/${session}/window/rect`,{width,height:950});
    await execute(`document.documentElement.dataset.theme='${theme}';document.documentElement.style.width='${width}px';window.scrollTo(0,0);return window.openSources()`);
    await waitFor('document.querySelectorAll(".model-source-row").length===3');
    assert(await execute(`return document.querySelector('[data-settings-scope]').value==='device' && document.querySelector('.model-source-row').textContent.includes('设备共享')`), 'Device source scope missing');
    await layout(`sources-${theme}-${width}`,width);
    await execute('return window.openConfig()'); await waitFor('document.querySelector("[data-agent-field=append_prompt]")');
    await execute(`const p=document.querySelector('[data-agent-field=append_prompt]');p.value='device-draft';p.dispatchEvent(new Event('input',{bubbles:true}));`);
    await scope('project'); await execute(`document.querySelector('[data-agent-field=append_prompt]').value='project-draft'`);
    await scope('device'); assert(await execute(`return document.querySelector('[data-agent-field=append_prompt]').value==='device-draft'`), 'Agent scope switch lost draft');
    await layout(`agent-${theme}-${width}`,width);
    await execute('return window.openSystem()'); await waitFor('document.querySelector("[data-runtime-input=concurrency]")'); await layout(`runtime-${theme}-${width}`,width);
    console.log(`PASS scoped source/Agent/runtime Firefox ${theme}/${width}`);
  }
  await fetch(`http://127.0.0.1:${server.port}/test/mode?global=true`,{method:'POST'});
  calls.length=0; await execute('return window.ensureProject()');
  for (const [name,entry,ready] of [['sources','openSources','.model-source-row'],['agent','openConfig','[data-agent-field=append_prompt]'],['explain','openExplain','[data-quick-field=prompt]'],['runtime','openSystem','[data-runtime-input=concurrency]']]) {
    await execute(`return window.${entry}()`); await waitFor(`document.querySelector('${ready}')`);
    assert(await execute(`return document.querySelector('[data-settings-scope]').disabled && !document.querySelector('.legacy-usage-history,.agent-connection-consumers,.settings-migration,[data-service-restart="project"]')`), `No-project boundary ${name}`);
    await layout(`host-${name}`,390);
  }
  assert(calls.every(route=>route.startsWith('/api/host/settings/')),`No-project API leaked: ${calls.join(',')}`);
  assert(await execute('return window.browserErrors.length===0'),'Browser emitted errors');
  passed=true;console.log(`PASS scoped Firefox drafts, metadata, responsive light/dark views and no-project Host-only configuration. Screenshots: ${output}`);
} catch (error) {
  if (session) await screenshot('failure').catch(() => {});
  console.error(`Device settings browser failure; full logs: ${logs}`); throw error;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  if (driver) { driver.kill(); await driver.exited; }
  server?.stop(true);
  if (passed) fs.rmSync(path.join(logs, 'driver.log'), { force: true });
}
