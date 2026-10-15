// bun run test/web/check-delivery-view-browser.js — real Firefox, authenticated Host/RPC/SQLite in disposable projects.
import fs from 'node:fs';
import path from 'node:path';
import { request } from 'node:http';
import { deliveryViewFixture, deliveryDatabase } from './delivery-view-fixture.js';

const out = path.resolve('.lush/logs/delivery-repair-browser'); fs.mkdirSync(out, { recursive: true });
const f = await deliveryViewFixture(), origin = f.url, project = `/p/${f.projectId}/`;
const before = deliveryDatabase(f), errors = [], network = [], pending = new Map();
const attention = f.project.workerDeliveryGraph().counts.attention;
const attentionText = Number.isSafeInteger(attention) && attention >= 0 ? `待处理 ${attention}` : '待处理统计未提供';
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
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function screenshot(name) { fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64')); }
async function resize(width) {
  await rpc(`/session/${session}/window/rect`, { width, height: 900 });
  const context = await rpc(`/session/${session}/window`, undefined, 'GET');
  await bidi('browsingContext.setViewport', { context, viewport: { width, height: 900 }, devicePixelRatio: 1 });
}
try {
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
  await resize(1440);
  await navigate(`${origin}/login?next=${encodeURIComponent(project + '#worker-graph')}`);
  await execute(`document.querySelector('#username').value='fixture-user'; document.querySelector('#password').value='synthetic-test-only-password';`);
  await click('form button');
  await until(`document.querySelector('[data-task-id="${f.sources[0].id}"] .source-delivery')`);
  assert(await execute(`return !document.querySelector('[data-task-id="${f.helper.id}"]') && !document.querySelector('[data-task-id="${f.sources[0].id}"] .source-delivery').textContent.includes('暂存输入：')`), 'tree source summary/whitelist incorrect');
  assert(attention === 1, 'real backend must supply complete counts.attention=1');
  assert(await execute(`return !document.querySelector('#delivery-count') && !document.querySelector('#deliveries-open')`), 'retired delivery navigation/count remains');
  await screenshot('tree-desktop');
  for (const width of [390, 320]) {
    await resize(width);
    await execute(`document.querySelector('[data-task-id="${f.sources[0].id}"]').scrollIntoView({block:'center'});`);
    const layout = await execute(`const d=document.querySelector('#detail'),c=document.querySelector('[data-task-id="${f.sources[0].id}"]');return {width:innerWidth,root:document.documentElement.scrollWidth,detail:d.scrollWidth,client:d.clientWidth,card:c.scrollWidth,cardClient:c.clientWidth}`);
    assert(layout.width === width && layout.root <= width + 1 && layout.detail <= layout.client + 1 && layout.card <= layout.cardClient + 1, `source tree overflow: ${JSON.stringify(layout)}`);
    await screenshot(`tree-source-${width}`);
  }
  await resize(1440);
  await click(`[data-task-id="${f.sources[0].id}"] .source-delivery .nav-link`);
  await until(`location.hash==='#deliveries-run-${f.focusRun.id}-source-${f.sources[0].id}' && document.querySelector('[data-delivery-key="batch:${f.focusRun.id}"]')`);
  const card = `[data-delivery-key="batch:${f.focusRun.id}"]`;
  assert(await execute(`return document.querySelector('${card}').classList.contains('delivery-exception') && document.querySelector('${card}').textContent.includes('落地待核查') && document.querySelector('${card}').textContent.includes('#${f.helper.id}') && !document.querySelector('${card} button') && !document.querySelector('${card} details').open`), 'real card state or advanced default wrong');
  await click('#task-graph-open');
  await until(`location.hash==='#worker-graph-worker-${f.sources[0].id}' && document.querySelector('[data-task-id="${f.sources[0].id}"].delivery-located')`);
  await execute(`location.hash='#deliveries'`);
  await until(`location.hash==='#deliveries-run-${f.focusRun.id}-source-${f.sources[0].id}' && document.querySelector('${card}')`);
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await resize(width); await execute(`document.documentElement.dataset.theme='${theme}';document.querySelector('#detail').scrollTop=0;`);
    // Theme changes animate inherited ink; do not capture the transient light-on-dark frame.
    await until(`document.documentElement.dataset.theme==='${theme}' && getComputedStyle(document.querySelector('.delivery-header h1')).color===getComputedStyle(document.documentElement).color && getComputedStyle(document.querySelector('aside')).color===getComputedStyle(document.documentElement).color`);
    const contrast = await execute(`const channels=s=>s.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});const luminance=s=>channels(s).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);const card=document.querySelector('${card}');const ink=luminance(getComputedStyle(card).color),background=luminance(getComputedStyle(card).backgroundColor);return (Math.max(ink,background)+.05)/(Math.min(ink,background)+.05)`);
    assert(contrast >= 4.5, `delivery text contrast below AA: ${theme}/${width} ${contrast}`);
    const layout = await execute(`const d=document.querySelector('#detail'),c=document.querySelector('${card}'),h=document.querySelector('.delivery-header');return {width:innerWidth,root:document.documentElement.scrollWidth,detail:d.scrollWidth,client:d.clientWidth,card:c.scrollWidth,cardClient:c.clientWidth,summary:h.textContent.includes('活动 26')&&h.textContent.includes(${JSON.stringify(attentionText)}),switchVisible:!!h.querySelector('a[href*="worker-graph"]')}`);
    assert(layout.width === width && layout.root <= width + 1 && layout.detail <= layout.client + 1 && layout.card <= layout.cardClient + 1 && layout.summary && layout.switchVisible, `layout overflow/lost summary: ${JSON.stringify(layout)}`);
    await screenshot(`delivery-${theme}-${width}`);
  }
  await resize(1440);
  await click(`${card} .delivery-helper a`);
  await until(`location.hash==='#worker-${f.helper.id}' && document.querySelector('#detail').dataset.taskId==='${f.helper.id}'`);
  assert(await execute(`return document.querySelector('#detail').textContent.includes('真实整合 Worker')`), 'helper link not original detail');
  await rpc(`/session/${session}/back`, {}); await until(`document.querySelector('${card}')`);
  await rpc(`/session/${session}/forward`, {}); await until(`location.hash==='#worker-${f.helper.id}' && document.querySelector('#detail').dataset.taskId==='${f.helper.id}'`);
  await navigate(`${origin}${project}#deliveries-run-${f.focusRun.id}-node-${f.node.id}`);
  await until(`document.querySelector('[data-delivery-node="${f.node.id}"].delivery-located')`);
  assert(await execute(`return document.querySelector('${card} details').open`), 'deep node hidden');
  await rpc(`/session/${session}/refresh`, {}); await until(`document.querySelector('[data-delivery-node="${f.node.id}"].delivery-located')`);
  await execute(`document.querySelector('.delivery-header a[href*="deliveries-history"]').click()`);
  await until(`location.hash.includes('deliveries-history') && document.querySelectorAll('.delivery-card').length===20`);
  await execute(`Array.from(document.querySelectorAll('.delivery-view button')).find(n=>n.textContent==='继续加载').click()`);
  await until(`document.querySelectorAll('.delivery-card').length===22`);
  assert(await execute(`return document.querySelector('.delivery-view').textContent.includes('非当前预约交付') && document.querySelector('.delivery-count-summary').textContent.includes('待处理 1') && !document.querySelector('.delivery-exception') && !document.querySelector('.delivery-view .agent-call')`), 'history uses current round or offers Agent action');
  await screenshot('delivery-history-desktop');
  fs.writeFileSync(path.join(out, 'network.json'), JSON.stringify(network, null, 2));
  assert(errors.length === 0, `browser errors: ${JSON.stringify(errors)}`);
  const mutations = network.filter(row => row.method !== 'GET' && new URL(row.url).pathname.includes('/api/'));
  assert(mutations.length === 0, `readonly navigation invoked API mutation: ${JSON.stringify(mutations)}`);
  assert(f.providerCalls === 0, 'unexpected model calls');
  assert(deliveryDatabase(f) === before, 'readonly browser changed persistent delivery facts');
  console.log(`PASS real Firefox/Host/HTTP/RPC/SQLite: tree->delivery->helper, back/forward/refresh, node deep link, history paging; no writes/models; ${attentionText}. Desktop, actual 390/320px light+dark screenshots: ${out}`);
} catch (error) { await screenshot('failure').catch(() => {}); console.error(`Browser failed; logs/screenshots: ${out}`); throw error; }
finally {
  socket?.close(); if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; await f.close();
}
