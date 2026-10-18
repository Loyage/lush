// bun run test/web/check-one-shot-integration-browser.js — real Firefox + authenticated disposable Host/RPC/Git.
import fs from 'node:fs';
import path from 'node:path';
import { request } from 'node:http';
import { oneShotIntegrationFixture } from './one-shot-integration-fixture.js';
import { git, until as untilBackend } from '../helpers.js';

const out = path.resolve('.lush/logs/one-shot-integration-browser'); fs.mkdirSync(out, { recursive: true });
const f = await oneShotIntegrationFixture({ hold: true, count: 10 });
const origin = f.url, project = `/p/${f.projectId}/`, errors = [], network = [], pending = new Map();
const reserve = () => { const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }); const port = server.port; server.stop(true); return port; };
const port = reserve(), bidiPort = reserve(), log = path.join(out, 'geckodriver.log');
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port), '--websocket-port', String(bidiPort)], {
  env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log),
});
let session, socket, sequence = 0;
async function rpc(route, body, method = 'POST') {
  const result = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', data => chunks.push(data)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('WebDriver request timeout'))); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(result.text); if (result.status >= 400) throw new Error(JSON.stringify(data)); return data.value;
}
function bidi(method, params) { return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); }
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const assert = (value, message) => { if (!value) throw new Error(message); };
async function until(expression) {
  assert(await rpc(`/session/${session}/execute/async`, { args: [], script: `const done=arguments[0];let n=0;const check=()=>{try{if(${expression})return done(true)}catch{}if(++n>200)return done(false);setTimeout(check,30)};check();` }), `UI did not settle: ${expression}`);
}
const navigate = url => rpc(`/session/${session}/url`, { url });
async function click(selector) {
  await execute(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});`);
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function screenshot(name) { fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64')); }
async function resize(width) {
  await rpc(`/session/${session}/window/rect`, { width, height: 900 });
  const context = await rpc(`/session/${session}/window`, undefined, 'GET');
  await bidi('browsingContext.setViewport', { context, viewport: { width, height: 900 }, devicePixelRatio: 1 });
}
async function layout(selector, width, name) {
  await execute(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});`);
  const result = await execute(`const root=document.querySelector(${JSON.stringify(selector)}),detail=document.querySelector('#detail'); return {width:innerWidth,page:document.documentElement.scrollWidth,scroll:root.scrollWidth,client:root.clientWidth,detail:detail.scrollWidth,detailClient:detail.clientWidth}`);
  assert(result.width === width && result.page <= width + 1 && result.scroll <= result.client + 1 && result.detail <= result.detailClient + 1, `overflow ${name}: ${JSON.stringify(result)}`);
  await screenshot(name);
}
try {
  f.store.run('UPDATE tasks SET display_title=? WHERE id=?', '长来源标题 / VeryLongUnbrokenIntegrationSourceTitle0123456789'.repeat(3), f.sources[0].id);
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {} if (driver.exitCode !== null) throw new Error('driver startup failed'); await Bun.sleep(100); }
  assert(ready, 'driver startup timeout');
  const created = await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', webSocketUrl: true, 'moz:firefoxOptions': { args: ['-headless'] } } } });
  session = created.sessionId; socket = new WebSocket(created.capabilities.webSocketUrl);
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'log.entryAdded' && message.params.type === 'javascript' && message.params.level === 'error') errors.push(message.params.text);
    if (message.method === 'network.beforeRequestSent') network.push({ method: message.params.request.method, url: message.params.request.url });
    const callback = pending.get(message.id); if (callback) { pending.delete(message.id); message.type === 'error' ? callback.reject(new Error(message.message)) : callback.resolve(message.result); }
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await bidi('session.subscribe', { events: ['log.entryAdded', 'network.beforeRequestSent'] });
  await resize(1440); await navigate(`${origin}/login?next=${encodeURIComponent(project + '#worker-graph')}`);
  await execute(`document.querySelector('#username').value='fixture-user';document.querySelector('#password').value='synthetic-test-only-password';`); await click('form button');
  const main = `[data-task-id="${f.parent.id}"]`, more = `${main} .task-graph-more-trigger`, panel = `${main} .task-graph-actions-popover`, start = `${panel} .integration-control button`;
  await until(`document.querySelector('${more}')`);
  assert(await execute(`return !document.querySelector('#deliveries-open') && !document.querySelector('.task-graph-merge-all') && !document.querySelector('${start}') && !document.querySelector('${main} > .integration-control')`), 'tree entry was not tucked into more actions');
  assert(!network.some(row => row.url.includes('/api/branch-integrate-plan')), 'tree eagerly fetched a plan');
  for (const width of [1440, 390, 320]) {
    await resize(width); await layout(main, width, `tree-${width}`);
    await click(more); await until(`document.querySelector('${panel}').matches(':popover-open')`);
    await layout(panel, width, `menu-${width}`);
    assert(await execute(`return document.querySelector('${start}').classList.contains('agent-call') && document.querySelector('${start}').dataset.help.includes('token')`), 'menu lost Agent cost help');
    await execute(`document.querySelector('${panel}').hidePopover()`);
  }
  assert(!network.some(row => row.url.includes('/api/branch-integrate-plan')), 'opening menu eagerly fetched a plan');
  await click(more); await click(start); await until(`!document.querySelector('#modal').hidden && document.querySelector('.modal-confirm')`);
  assert(await execute(`const m=document.querySelector('#modal');return m.textContent.includes('10 个来源') && m.textContent.includes('之后完成的来源不加入') && m.textContent.includes('父子关系保持不变') && document.querySelector('.modal-confirm').classList.contains('agent-call')`), 'preflight lost full scope/cost/stable identity');
  assert(f.store.all('SELECT id FROM delivery_runs').length === 0, 'read-only preflight created an operation');
  for (const width of [1440, 390, 320]) { await resize(width); await layout('#modal .modal-card', width, `confirmation-${width}`); }
  await click('.modal-confirm'); await until(`document.querySelector('#modal').hidden`);
  await untilBackend(() => f.store.get('SELECT * FROM delivery_runs'));
  const run = f.store.get('SELECT * FROM delivery_runs'); f.start(); await f.entered.promise;
  const source = `[data-task-id="${f.sources[0].id}"]`;
  // The heavy graph has its own slow sampling cadence; use its ordinary read-only refresh.
  await execute(`Array.from(document.querySelectorAll('.task-graph-hero button')).find(node=>node.textContent==='刷新').click()`);
  await until(`document.querySelector('${source} .task-graph-integration-status')`);
  await click(more);
  assert(await execute(`return document.querySelector('${source} .task-graph-integration-status').textContent==='合并处理中' && !document.querySelector('.task-graph-card > .integration-summary') && document.querySelector('${start}')?.disabled===true`), 'compact status/start duplicate guard incorrect');
  await execute(`document.querySelector('${panel}').hidePopover()`);
  assert(await git(f.root, 'rev-parse', 'main') === f.baseline, 'target changed before complete verification');
  for (const width of [1440, 390, 320]) { await resize(width); await layout(source, width, `merging-tree-${width}`); }
  await click(`${source} .task-graph-title`);
  await until(`document.querySelector('.integration-summary a')`);
  await click('.integration-summary a');
  await until(`location.hash==='#worker-${run.integration_worker_id}' && document.querySelector('.integration-details')`);
  assert(await execute(`return !document.querySelector('.integration-evidence').open && !document.querySelector('.integration-details').textContent.includes('交付')`), 'detail advanced defaults/product wording incorrect');
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await resize(width); await execute(`document.documentElement.dataset.theme='${theme}';`); await layout('.integration-details', width, `active-${theme}-${width}`);
  }
  f.release.resolve();
  await untilBackend(() => ['integrated', 'failed', 'blocked'].includes(f.store.deliveryRun(run.id).state), 15000);
  assert(f.store.deliveryRun(run.id).state === 'integrated', `operation did not land: ${f.store.deliveryRun(run.id).error}`);
  await rpc(`/session/${session}/refresh`, {});
  await until(`document.querySelector('.integration-result')?.textContent.includes('已实际合入 main')`);
  assert(await execute(`return !document.querySelector('.integration-evidence').open && document.querySelectorAll('.integration-sources li').length===10 && document.querySelector('#detail').textContent.includes('10 项通过')`), 'landed detail lost scope/evidence/result');
  for (const width of [1440, 390, 320]) { await resize(width); await layout('.integration-details', width, `integrated-${width}`); }
  assert(await git(f.root, 'rev-list', '--count', `${f.baseline}..main`) === '1', 'more than one target commit');
  assert(f.providerCalls === 1, 'unexpected Provider calls');
  for (const source of f.sources) assert(f.store.task(source.id).parent_id === f.parent.id && await git(source.workspace, 'rev-parse', 'HEAD') === source.head_commit, 'source identity/ref changed');
  const mutations = network.filter(row => row.method !== 'GET' && new URL(row.url).pathname.includes('/api/'));
  assert(mutations.length === 1 && mutations[0].url.endsWith('/api/action'), `unexpected API writes: ${JSON.stringify(mutations)}`);
  assert(errors.length === 0, `browser errors: ${JSON.stringify(errors)}`);
  fs.writeFileSync(path.join(out, 'network.json'), JSON.stringify(network, null, 2));
  console.log(`PASS real Firefox/Host/HTTP/RPC/Git: tree -> complete 10-source confirmation -> single controlled Agent -> one Squash -> original Worker; unchanged source identities; one API write; no browser errors. Actual 1440/390/320px screenshots: ${out}`);
} catch (error) {
  await screenshot('failure').catch(() => {});
  fs.writeFileSync(path.join(out, 'failure-network.json'), JSON.stringify(network, null, 2));
  fs.writeFileSync(path.join(out, 'failure-state.json'), JSON.stringify({ errors, runs: f.store.all('SELECT id,state,error FROM delivery_runs'),
    core: (await f.project.taskGraph({ details: false, scope: 'tree' })).nodes.map(row => ({ id: row.id, merge_operation: row.merge_operation })),
    browser: session ? await execute(`return document.querySelector('#detail').innerHTML`).catch(() => null) : null }, null, 2));
  console.error(`Browser failed; logs/screenshots: ${out}`); throw error;
}
finally {
  socket?.close(); if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; await f.close();
}
