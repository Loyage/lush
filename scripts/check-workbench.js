// Real Chromium/CDP workbench regression. Temporary Host/profile only; no user projects or SSH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { startWeb } from '../src/ui/web/server.js';
import { projectRouteId } from '../src/host/registry.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-workbench-ui-')));
const browserPath = process.env.LUSH_TEST_CHROME || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
const environmentManager = {
  status: () => ({ execution: { hostname: 'fixture-machine', username: 'fixture-user', scope: 'host' },
    ssh: { supported: false, reason: 'SSH disabled in isolated browser fixture', hosts: [], warnings: [], connections: [] } }),
  endpoint: () => { throw new Error('测试环境已离线'); }, dispose() {},
};
const selected = [], fixtureProject = path.join(root, 'mock-project');
const projectHost = {
  launcher: true, rememberCurrent() {},
  status: async () => ({ mode: 'host', projects: [], capabilities: { project_control: true } }),
  projects: async () => [], hasRoute: id => id === projectRouteId(fixtureProject),
  select: async project => { selected.push(project); return fixtureProject; },
};
const server = startWeb(null, 0, { env: { HOME: root, LUSH_GLOBAL_CONFIG: root }, environmentManager, projectHost });
const origin = `http://127.0.0.1:${server.port}`;
const profile = path.join(root, 'chrome');
let browser, socket, passed = false;
const errors = [], pending = new Map(); let sequence = 0;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
function http(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(url, { method }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } }); });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('CDP startup timeout'))); req.end();
  });
}
function cdp(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
  return result.result.value;
}
async function until(expression) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate(expression)) return; await Bun.sleep(40); }
  throw new Error(`UI did not settle: ${expression}`);
}
try {
  browser = Bun.spawn([browserPath, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdout: 'ignore', stderr: Bun.file(path.join(root, 'chrome.log')) });
  let debugPort;
  for (let attempt = 0; attempt < 500; attempt++) {
    if (browser.exitCode !== null) throw new Error(`Chromium exited: ${fs.readFileSync(path.join(root, 'chrome.log'), 'utf8')}`);
    try { debugPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); if (debugPort) break; } catch {}
    await Bun.sleep(40);
  }
  assert(debugPort, 'Chromium debugger did not start');
  const target = await http(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result); }
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url: origin });
  await until(`document.querySelector('#detail .project-manager') !== null`);
  assert(await evaluate(`!document.getElementById('project-app').hasAttribute('inert')`), 'workbench is blocked by project gate');
  assert(await evaluate(`document.querySelector('.composer').hidden || getComputedStyle(document.querySelector('.composer')).display === 'none'`), 'empty workbench shows active composer');
  for (const [id, fragment] of [['settings-open', 'settings'], ['docs-open', 'docs'], ['environments-open', 'environments'], ['projects-open', 'projects']]) {
    await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    await until(`location.hash === '#${fragment}'`);
    await until(`!document.getElementById('detail').textContent.includes('正在加载')`);
  }
  await evaluate(`document.querySelector('.project-manager-form input').value = ${JSON.stringify(fixtureProject)}`);
  await cdp('Runtime.evaluate', { expression: `document.querySelector('.project-manager-form').requestSubmit()`, userGesture: true });
  let child;
  for (let attempt = 0; attempt < 100; attempt++) {
    child = (await http(`http://127.0.0.1:${debugPort}/json/list`)).find(page => page.id !== target.id && page.url === `${origin}/p/${projectRouteId(fixtureProject)}/`);
    if (child) break;
    await Bun.sleep(40);
  }
  assert(child && selected.length === 1 && selected[0] === fixtureProject, 'project did not open in an independent browser page');
  assert(await evaluate(`location.pathname === '/' && document.querySelector('.project-manager-form input').value === ${JSON.stringify(fixtureProject)}`), 'opening a project replaced the source page or discarded its input');
  await http(`http://127.0.0.1:${debugPort}/json/close/${child.id}`).catch(() => {});
  await evaluate(`document.getElementById('environments-open').click()`);
  await until(`document.getElementById('detail').textContent.includes('fixture-machine')`);
  assert(await evaluate(`document.getElementById('detail').textContent.includes('fixture-user')`), 'SSH execution identity absent');
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 390]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    await evaluate(`document.documentElement.dataset.theme='${theme}'`);
    await Bun.sleep(40);
    assert(await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`), `horizontal viewport overflow ${theme} ${width}`);
  }
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `${origin}/e/${'a'.repeat(32)}/` });
  await until(`document.readyState === 'complete' && document.querySelector('#detail .workbench-view') !== null`);
  assert(await evaluate(`document.getElementById('projects-open') && document.getElementById('docs-open')`), 'offline environment lost shell');
  await evaluate(`document.getElementById('docs-open').click()`);
  await until(`location.hash === '#docs' && document.getElementById('detail').textContent.includes('文档')`);
  assert(errors.length === 0, `browser exceptions: ${errors.join('\n')}`);
  passed = true; console.log('Workbench browser checks passed: empty root, navigation, independent project page and retained input, SSH execution identity, light/dark responsive layout, offline shell.');
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) {
    const state = await evaluate(`({url:location.href,ready:document.readyState,body:document.body?.innerText,html:document.getElementById('detail')?.innerHTML})`).catch(() => null);
    console.error(JSON.stringify({ errors, state }, null, 2));
    fs.writeFileSync(path.join(root, 'diagnostics.json'), JSON.stringify({ errors, state }, null, 2));
    const shot = await cdp('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    if (shot?.data) fs.writeFileSync(path.join(root, 'screenshot.png'), Buffer.from(shot.data, 'base64'));
  }
  throw error;
} finally {
  socket?.close();
  for (const callback of pending.values()) callback.reject(new Error('Browser fixture closing'));
  pending.clear();
  if (browser) { browser.kill('SIGTERM'); await browser.exited; }
  server.stop(true);
  if (passed) fs.rmSync(root, { recursive: true, force: true });
  else console.error(`Browser fixture diagnostics retained: ${root}`);
}
