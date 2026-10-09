// Real Firefox/WebDriver workbench regression. Temporary Host/profile only; no user projects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { startWeb } from '../src/ui/web/server.js';
import { projectRouteId } from '../src/host/registry.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-workbench-ui-')));
let offline = false;
const selected = [], fixtureProject = path.join(root, 'mock-project');
const projectHost = {
  launcher: true, rememberCurrent() {},
  status: async () => { if (offline) throw new Error('fixture Host offline'); return { mode: 'host', projects: [], capabilities: { project_control: true } }; },
  projects: async () => [], hasRoute: id => id === projectRouteId(fixtureProject),
  select: async project => { selected.push(project); return fixtureProject; },
};
const server = startWeb(null, 0, { env: { HOME: root, LUSH_GLOBAL_CONFIG: root }, projectHost });
const origin = `http://127.0.0.1:${server.port}`;
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
let driver, session, socket, passed = false;
const errors = [], pending = new Map(), reloadReads = []; let sequence = 0, captureReload = false;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function rpc(route, body, method = 'POST') {
  // Loopback WebDriver requests must not inherit outbound proxies.
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) req.destroy(new Error('WebDriver response too large')); else chunks.push(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('WebDriver timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text);
  if (response.status >= 400) throw new Error(JSON.stringify(data));
  return data.value;
}
function bidi(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser event subscription timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = expression => rpc(`/session/${session}/execute/sync`, { script: `return (${expression});`, args: [] });
async function until(expression) {
  const settled = await rpc(`/session/${session}/execute/async`, { args: [], script: `const done=arguments[0];let n=0;const check=()=>{try{if(${expression})return done(true)}catch{}if(++n>200)return done(false);setTimeout(check,50)};check();` });
  assert(settled, `UI did not settle: ${expression}`);
}
async function click(selector) {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
const navigate = url => rpc(`/session/${session}/url`, { url });
async function resize(width) {
  await rpc(`/session/${session}/window/rect`, { width, height: 900 });
  // Firefox's desktop window has a minimum width; set the content viewport explicitly
  // so the 390px check is genuinely mobile-sized, not a clamped 500px window.
  const context = await rpc(`/session/${session}/window`, undefined, 'GET');
  await bidi('browsingContext.setViewport', { context, viewport: { width, height: 900 }, devicePixelRatio: 1 });
}
async function screenshot(name) {
  fs.writeFileSync(path.join(root, `${name}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
}
try {
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(root, 'geckodriver.log')), stderr: Bun.file(path.join(root, 'geckodriver.log')),
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited during startup');
    await Bun.sleep(100);
  }
  assert(ready, 'WebDriver startup timeout');
  const created = await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', webSocketUrl: true,
    'moz:firefoxOptions': { args: ['-headless'] } } } });
  session = created.sessionId;
  // Subscribe before navigating, retaining startup exceptions and unhandled rejections.
  socket = new WebSocket(created.capabilities.webSocketUrl);
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'log.entryAdded' && message.params.type === 'javascript' && message.params.level === 'error') errors.push(message.params.text);
    if (captureReload && message.method === 'network.beforeRequestSent'
      && /\/web-[a-f0-9]{32}-.*\.(?:js|css)$/.test(new URL(message.params.request.url).pathname)) {
      reloadReads.push({ conditional: message.params.request.headers.some(header => header.name.toLowerCase() === 'if-none-match') });
    }
    const callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); message.type === 'error' ? callback.reject(new Error(message.message)) : callback.resolve(message.result); }
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await bidi('session.subscribe', { events: ['log.entryAdded', 'network.beforeRequestSent'] });
  await resize(1440); await navigate(origin);
  await until(`document.querySelector('#detail .project-manager') !== null`);
  const resources = () => evaluate(`performance.getEntriesByType('resource').filter(row=>/\\/web-[a-f0-9]{32}-.*\\.(?:js|css)$/.test(new URL(row.name).pathname)).map(row=>({name:new URL(row.name).pathname,transfer:row.transferSize,encoded:row.encodedBodySize,decoded:row.decodedBodySize}))`);
  const cold = await resources();
  assert(cold.length > 0 && cold.some(row => row.transfer > 0), 'cold load has no measurable static transfers');
  assert(!cold.some(row => row.name.includes('-render-settings-')), 'settings chunk was fetched before opening its page');
  // Normal revisit, not an explicit reload that Firefox can revalidate even fresh HTTP assets.
  await navigate(`${origin}/?cache-check=1`);
  await until(`document.querySelector('#detail .project-manager') !== null`);
  const warm = await resources();
  const coldNames = new Set(cold.map(row => row.name)), reused = warm.filter(row => coldNames.has(row.name));
  assert(reused.length > 0 && reused.every(row => row.transfer === 0), `repeat navigation did not reuse versioned browser resources: ${JSON.stringify({ cold, warm })}`);
  console.log('PASS Firefox static cache cold/warm:', JSON.stringify({
    coldFiles: coldNames.size, coldTransferBytes: cold.reduce((sum, row) => sum + row.transfer, 0),
    coldEncodedBytes: cold.reduce((sum, row) => sum + row.encoded, 0), coldDecodedBytes: cold.reduce((sum, row) => sum + row.decoded, 0),
    warmFiles: new Set(reused.map(row => row.name)).size, warmTransferBytes: reused.reduce((sum, row) => sum + row.transfer, 0),
  }));
  captureReload = true;
  await rpc(`/session/${session}/refresh`, {});
  await until(`document.querySelector('#detail .project-manager') !== null`);
  captureReload = false;
  const reloaded = (await resources()).filter(row => coldNames.has(row.name));
  assert(reloaded.length > 0, 'reload did not report the versioned static resources');
  // WebDriver can bypass cache (including validators); report this separately from normal revisit.
  console.log('MEASURE Firefox WebDriver reload:', JSON.stringify({
    transferBytes: reloaded.reduce((sum, row) => sum + row.transfer, 0),
    staticRequests: reloadReads.length, conditionalRequests: reloadReads.filter(row => row.conditional).length,
  }));
  assert(await evaluate(`!document.getElementById('project-app').hasAttribute('inert')`), 'workbench is blocked by project gate');
  assert(await evaluate(`document.querySelector('.composer').hidden || getComputedStyle(document.querySelector('.composer')).display === 'none'`), 'empty workbench shows active composer');
  for (const [id, fragment] of [['settings-open', 'settings'], ['docs-open', 'docs'], ['projects-open', 'projects']]) {
    await click(`#${id}`);
    await until(`location.hash === '#${fragment}'`);
    await until(`!document.getElementById('detail').textContent.includes('正在加载')`);
  }
  await evaluate(`document.querySelector('.project-manager-form input').value = ${JSON.stringify(fixtureProject)}`);
  const source = await rpc(`/session/${session}/window`, undefined, 'GET');
  await click('.project-manager-form button[type="submit"]');
  let child;
  for (let attempt = 0; attempt < 100; attempt++) {
    child = (await rpc(`/session/${session}/window/handles`, undefined, 'GET')).find(handle => handle !== source);
    if (child) break;
    await Bun.sleep(40);
  }
  assert(child, 'project did not open in an independent browser page');
  await rpc(`/session/${session}/window`, { handle: child });
  await until(`location.href === ${JSON.stringify(`${origin}/p/${projectRouteId(fixtureProject)}/`)}`);
  assert(selected.length === 1 && selected[0] === fixtureProject, 'project selection was not explicit and single-shot');
  await rpc(`/session/${session}/window`, undefined, 'DELETE');
  await rpc(`/session/${session}/window`, { handle: source });
  assert(await evaluate(`location.pathname === '/' && document.querySelector('.project-manager-form input').value === ${JSON.stringify(fixtureProject)}`), 'opening a project replaced the source page or discarded its input');
  assert(await evaluate(`document.getElementById('environments-open') === null`), 'removed environment navigation remains');
  assert(await evaluate(`document.querySelector('#sidebar .project-list') === null && document.getElementById('project-list-panel') === null`), 'sidebar still contains a project list');
  // Exercise the shared project identity typography with a long directory name,
  // including unbroken names that previously disappeared behind an ellipsis.
  await evaluate(`document.getElementById('project').textContent = 'long-project-name-for-sidebar-readability-check'`);
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 390]) {
    await resize(width);
    await evaluate(`document.documentElement.dataset.theme='${theme}'`);
    const layout = await evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})`);
    assert(layout.width === width && layout.scrollWidth <= layout.width + 1, `wrong viewport or horizontal overflow ${theme} ${width}: ${JSON.stringify(layout)}`);
    const identity = await evaluate(`(() => { const node=document.getElementById('project'), style=getComputedStyle(node); return {size:parseFloat(style.fontSize),weight:Number(style.fontWeight),whiteSpace:style.whiteSpace,width:node.clientWidth,scrollWidth:node.scrollWidth}; })()`);
    assert(identity.size >= 20 && identity.weight >= 700 && identity.whiteSpace !== 'nowrap' && identity.scrollWidth <= identity.width + 1,
      `project identity is small, clipped or not bold ${theme} ${width}: ${JSON.stringify(identity)}`);
    await screenshot(`${theme}-${width}`);
    console.log(`PASS workbench layout ${theme}/${layout.width}`);
  }
  await resize(1440);
  offline = true; await navigate(origin);
  await until(`document.readyState === 'complete' && document.querySelector('#detail .project-manager') !== null`);
  assert(await evaluate(`document.getElementById('connection').textContent === 'Host 离线' && !document.getElementById('project-app').hasAttribute('inert')`), 'offline Host lost shell');
  await click('#settings-open');
  await until(`location.hash === '#settings' && document.getElementById('detail').textContent.includes('Markdown 渲染')`);
  await click('#docs-open');
  await until(`location.hash === '#docs' && document.getElementById('detail').textContent.includes('文档')`);
  assert(errors.length === 0, `browser exceptions: ${errors.join('\n')}`);
  passed = true; console.log('Workbench Firefox checks passed: empty root, navigation, independent project page and retained input, light/dark responsive layout, offline Host shell with settings and docs.');
} catch (error) {
  if (session) {
    const state = await evaluate(`({url:location.href,ready:document.readyState,body:document.body?.innerText,html:document.getElementById('detail')?.innerHTML})`).catch(() => null);
    console.error(JSON.stringify({ errors, state }, null, 2));
    fs.writeFileSync(path.join(root, 'diagnostics.json'), JSON.stringify({ errors, state }, null, 2));
    await screenshot('failure').catch(() => {});
  }
  throw error;
} finally {
  socket?.close();
  for (const callback of pending.values()) callback.reject(new Error('Browser fixture closing'));
  pending.clear();
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  if (driver) { driver.kill('SIGTERM'); await driver.exited; }
  server.stop(true);
  if (passed) fs.rmSync(root, { recursive: true, force: true });
  else console.error(`Browser fixture diagnostics retained: ${root}`);
}
