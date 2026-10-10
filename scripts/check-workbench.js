// Real Firefox/WebDriver workbench regression. Temporary Host/profile only; no user projects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { startWeb } from '../src/ui/web/server.js';
import { projectRouteId } from '../src/host/registry.js';
import { readProjectAppearance, saveProjectAppearance } from '../src/host/project-appearance.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-workbench-ui-')));
let offline = false, richProjects = false;
const development = { workers_total: 314, active: 5, agents_running: 2, awaiting_acceptance: 3, parent_confirmation: 4,
  pending_merges: 7, merging: 1, merge_conflicts: 2,
  counts: [{ status: 'running', count: 2 }, { status: 'waiting', count: 3 }, { status: 'completed', count: 309 }],
  recent_workers: [{ id: 8, worker_number: 'W186-1', display_title: '最新开发状态与很长的自定义展示标题'.repeat(5), status: 'running', integration: 'pending' },
    { id: 9, worker_number: null, goal: 'long-unbroken-worker-title-'.repeat(8), status: 'awaiting_acceptance', integration: 'merged' }] };
const selected = [], fixtureProject = path.join(root, 'mock-project'), secondProject = path.join(root, 'second-project');
for (const project of [fixtureProject, secondProject]) fs.mkdirSync(project);
const fixtureEnv = { HOME: root, LUSH_GLOBAL_CONFIG: root };
const entries = () => [...new Set(selected)].map((project, index) => ({ id: projectRouteId(project), name: path.basename(project), project,
  running: richProjects && index === 0,
  ...(richProjects && index === 0 ? { summary: { pid: 1234, notices: 6, development } } : {}) }));
function appearance(id, body) {
  const project = entries().find(row => row.id === id)?.project;
  if (!project) throw new Error('unknown fixture project');
  return { id, project, name: path.basename(project), appearance: body
    ? saveProjectAppearance(project, body, { projects: entries().map(row => row.project), env: fixtureEnv }) : readProjectAppearance(project) };
}
const projectHost = {
  launcher: true, rememberCurrent() {},
  status: async () => { if (offline) throw new Error('fixture Host offline'); return { mode: 'host', projects: entries(), capabilities: { project_control: true } }; },
  projects: async () => entries(), hasRoute: id => entries().some(row => row.id === id),
  select: async project => { if (![fixtureProject, secondProject].includes(project)) throw new Error('unknown fixture project'); selected.push(project); return project; },
  openRoute: async () => { throw new Error('fixture project daemon offline'); },
  appearance: id => appearance(id), saveAppearance: (id, body) => appearance(id, body),
};
const server = startWeb(null, 0, { env: { HOME: root, LUSH_GLOBAL_CONFIG: root }, projectHost });
const origin = `http://127.0.0.1:${server.port}`;
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
let currentPort = port, extraPort = null;
let driver, extraDriver, session, extraSession, socket, passed = false;
const errors = [], pending = new Map(), reloadReads = []; let sequence = 0, captureReload = false;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function rpc(route, body, method = 'POST') {
  // Loopback WebDriver requests must not inherit outbound proxies.
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${currentPort}${route}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
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
  const settled = await rpc(`/session/${session}/execute/async`, { args: [], script: `const done=arguments[0];let n=0;const check=()=>{try{if(${expression})return done(true)}catch{}if(++n>400)return done(false);setTimeout(check,50)};check();` });
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
  await until(`document.documentElement.dataset.projectColor === 'green' && document.title === 'mock-project · Lush'`);
  assert(await evaluate(`document.getElementById('theme-toggle').hidden`), 'project shell exposes a theme editing control');
  // Project navigation excludes every global page group; only the brand leads to the parent space.
  assert(await evaluate(`Array.from(document.querySelectorAll('[data-global-navigation]')).every(node => getComputedStyle(node).display === 'none') && !document.getElementById('global-inbox-summary')`), 'project shell exposes global navigation or inbox summary');
  await click('#home');
  let settingsWindow;
  for (let attempt = 0; attempt < 100; attempt++) {
    settingsWindow = (await rpc(`/session/${session}/window/handles`, undefined, 'GET')).find(handle => handle !== source && handle !== child);
    if (settingsWindow) break; await Bun.sleep(40);
  }
  assert(settingsWindow, 'global settings did not open in a separate page');
  await rpc(`/session/${session}/window`, { handle: settingsWindow });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await rpc(`/session/${session}/url`, undefined, 'GET')) === `${origin}/#projects`) break;
    await Bun.sleep(40);
  }
  await until(`document.querySelector('#detail .project-manager') !== null`);
  await click('#settings-open');
  await until(`document.querySelector('input.pref-radio[data-value="dark"]') && !document.querySelector('input.pref-radio[data-value="dark"]').disabled`);
  async function setDeviceTheme(theme) {
    await rpc(`/session/${session}/window`, { handle: settingsWindow }); await resize(1440); await click('#settings-open');
    await until(`document.querySelector('input.pref-radio[data-value="${theme}"]') && !document.querySelector('input.pref-radio[data-value="${theme}"]').disabled`);
    await click(`input.pref-radio[data-value="${theme}"]`);
    await until(`document.documentElement.dataset.theme==='${theme}' && !document.querySelector('input.pref-radio[data-value="${theme}"]').disabled`);
  }
  async function setProjectColor(color) {
    await rpc(`/session/${session}/window`, { handle: settingsWindow }); await resize(1440); await click('#projects-open');
    await until(`document.querySelector('.project-color-open') !== null`); await click('.project-color-open');
    await until(`document.querySelector('input[data-project-color="${color}"]') && !document.querySelector('input[data-project-color="${color}"]').disabled`);
    await click(`input[data-project-color="${color}"]`);
    await until(`document.querySelector('input[data-project-color="${color}"]').checked && !document.querySelector('input[data-project-color="${color}"]').disabled`);
    assert(readProjectAppearance(fixtureProject).color === color, 'global color editor did not persist the selected identity color');
    await rpc(`/session/${session}/window`, { handle: child });
    await navigate(`${origin}/p/${projectRouteId(fixtureProject)}/`);
    await until(`document.documentElement.dataset.projectColor==='${color}' && document.title==='mock-project · Lush'`);
  }
  await setDeviceTheme('dark'); await setProjectColor('rose');
  await until(`document.documentElement.dataset.theme === 'dark'`);
  assert(await evaluate(`document.title === 'mock-project · Lush'`), 'global settings lost project-tab identity');
  const firstAppearance = readProjectAppearance(fixtureProject);
  assert(firstAppearance.theme === 'system' && firstAppearance.color === 'rose', 'color save modified the retained inactive project theme');
  // A second independent Firefox profile has no localStorage but must render the same project.
  const primarySession = session;
  const extraReservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  extraPort = extraReservation.port; extraReservation.stop(true);
  extraDriver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(extraPort)], {
    env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(root, 'geckodriver-second.log')), stderr: Bun.file(path.join(root, 'geckodriver-second.log')),
  });
  currentPort = extraPort;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await rpc('/status', undefined, 'GET'); break; } catch {}
    if (extraDriver.exitCode !== null) throw new Error('second geckodriver exited');
    await Bun.sleep(100);
  }
  const secondBrowser = await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } });
  extraSession = secondBrowser.sessionId; session = extraSession;
  try {
    await navigate(`${origin}/p/${projectRouteId(fixtureProject)}/`);
    await until(`document.documentElement.dataset.projectColor === 'rose' && document.documentElement.dataset.theme === 'dark'`);
    assert(await evaluate(`document.title === 'mock-project · Lush' && document.getElementById('theme-toggle').hidden`), 'independent browser did not share device theme/project identity');
    await navigate(`${origin}/#settings`);
    await until(`document.querySelector('input.pref-radio[data-value="light"]') && !document.querySelector('input.pref-radio[data-value="light"]').disabled`);
    await click('input.pref-radio[data-value="light"]');
    await until(`document.documentElement.dataset.theme === 'light' && !document.querySelector('input.pref-radio[data-value="light"]').disabled`);
  } finally {
    await rpc(`/session/${extraSession}`, undefined, 'DELETE'); extraSession = null;
    extraDriver.kill('SIGTERM'); await extraDriver.exited; extraDriver = null;
    session = primarySession; currentPort = port;
  }
  await until(`document.documentElement.dataset.theme === 'light'`);
  // Full palette × light/dark × responsive widths. CSS checks also protect semantic colors.
  for (const theme of ['light', 'dark']) {
    await setDeviceTheme(theme);
    for (const color of ['green', 'blue', 'teal', 'amber', 'rose', 'slate']) {
      await setProjectColor(color);
      await until(`document.documentElement.dataset.theme === '${theme}'`);
      // Palette changes animate the sidebar for 200ms. First let style/paint
      // run so the transition exists, then measure only after it has settled.
      await rpc(`/session/${session}/execute/async`, { args: [], script: 'const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));' });
      await until(`(() => { const side=document.getElementById('sidebar'); getComputedStyle(side).backgroundColor; return side.getAnimations().length === 0; })()`);
      const contrast = await evaluate(`(() => { const canvas=document.createElement('canvas'), ctx=canvas.getContext('2d'); canvas.width=canvas.height=1;
        const rgb=color=>{ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(n=>n/255)};
        const lum=color=>rgb(color).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
        const ratio=(a,b)=>{a=lum(a);b=lum(b);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
        const brand=getComputedStyle(document.querySelector('.brand-mark')), side=getComputedStyle(document.getElementById('sidebar')), tokens=getComputedStyle(document.documentElement);
        return {button:ratio(brand.color,brand.backgroundColor),side:ratio(side.borderTopColor,side.backgroundColor),failed:tokens.getPropertyValue('--failed').trim(),agent:tokens.getPropertyValue('--violet-ink').trim()}; })()`);
      assert(contrast.button >= 4.5 && contrast.side >= 4.5, `project contrast failed ${theme}/${color}: ${JSON.stringify(contrast)}`);
      assert(contrast.failed === (theme === 'dark' ? '#f4959d' : '#bd4147') && contrast.agent === (theme === 'dark' ? '#c1a4f3' : '#7955b4'), `project color changed semantic colors: ${JSON.stringify(contrast)}`);
      for (const width of [1440, 900, 390]) {
        await resize(width);
        assert(await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`), `project settings overflow ${theme}/${color}/${width}`);
        await screenshot(`project-${theme}-${color}-${width}`);
      }
    }
  }
  await resize(1440);
  // New-project allocation avoids the first project's current color; reopening remains stable.
  const registered = await fetch(`${origin}/api/host/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: secondProject }) });
  assert(registered.ok, 'second fixture project registration failed');
  await navigate(`${origin}/p/${projectRouteId(secondProject)}/`);
  await until(`document.title === 'second-project · Lush' && document.documentElement.dataset.projectColor === 'green'`);
  await navigate(`${origin}/p/${projectRouteId(fixtureProject)}/`);
  await until(`document.title === 'mock-project · Lush' && document.documentElement.dataset.projectColor === 'slate'`);
  console.log('PASS device theme/project identity: independent Firefox profiles, global color editing outside project pages, preserved inactive theme, cross-browser synchronization, offline titles, stable allocation, six palettes/light+dark/responsive with contrast and semantic-color checks');
  await rpc(`/session/${session}/window`, undefined, 'DELETE');
  await rpc(`/session/${session}/window`, { handle: settingsWindow }); await rpc(`/session/${session}/window`, undefined, 'DELETE');
  await rpc(`/session/${session}/window`, { handle: source });
  assert(await evaluate(`location.pathname === '/' && document.querySelector('.project-manager-form input').value === ${JSON.stringify(fixtureProject)}`), 'opening a project replaced the source page or discarded its input');
  assert(await evaluate(`document.getElementById('environments-open') === null`), 'removed environment navigation remains');
  assert(await evaluate(`document.querySelector('#sidebar .project-list') === null && document.getElementById('project-list-panel') === null`), 'sidebar still contains a project list');
  // Exercise the shared project identity typography with a long directory name,
  // including unbroken names that previously disappeared behind an ellipsis.
  await evaluate(`document.getElementById('project').textContent = 'long-project-name-for-sidebar-readability-check'`);
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 390, 320]) {
    await resize(width);
    await evaluate(`document.documentElement.dataset.theme='${theme}'`);
    const layout = await evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})`);
    assert(layout.width === width && layout.scrollWidth <= layout.width + 1, `wrong viewport or horizontal overflow ${theme} ${width}: ${JSON.stringify(layout)}`);
    const identity = await evaluate(`(() => { const node=document.getElementById('project'), style=getComputedStyle(node); return {size:parseFloat(style.fontSize),weight:Number(style.fontWeight),whiteSpace:style.whiteSpace,width:node.clientWidth,scrollWidth:node.scrollWidth}; })()`);
    assert(identity.size >= 20 && identity.weight >= 700 && identity.whiteSpace !== 'nowrap' && identity.scrollWidth <= identity.width + 1,
      `project identity is small, clipped or not bold ${theme} ${width}: ${JSON.stringify(identity)}`);
    assert(await evaluate(`(() => { const section=document.querySelector('.workbench-service-restart'); return ['pause','resume'].every(kind=>{const b=section?.querySelector('[data-service-restart="'+kind+'"]'); if(!b)return false;const r=b.getBoundingClientRect();return b.disabled && r.width>=44 && r.height>=44 && r.left>=0 && r.right<=innerWidth && b.parentNode.classList.contains('help-host') && b.parentNode.getAttribute('data-help');}) && section.querySelector('[data-service-restart="resume"]').classList.contains('agent-call'); })()`), `global maintenance controls missing/clipped or lack disabled help/Agent marker ${theme}/${width}`);
    await screenshot(`${theme}-${width}`);
    console.log(`PASS workbench layout ${theme}/${layout.width}`);
  }
  richProjects = true;
  await click('#projects-open');
  await until(`document.querySelector('.project-development-metrics') !== null`);
  await evaluate(`document.querySelector('.project-order > button').click()`);
  await until(`document.querySelector('.project-order-form textarea') !== null`);
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 390, 320]) {
    await resize(width); await evaluate(`document.documentElement.dataset.theme='${theme}'`);
    assert(await evaluate(`(() => { const buttons=[...document.querySelectorAll('.project-manager button')];const fonts=buttons.map(b=>{const s=getComputedStyle(b);return [s.fontFamily,s.fontSize,s.fontWeight,s.lineHeight].join('|')});return buttons.length>=10&&new Set(fonts).size===1&&fonts[0].includes('12px'); })()`), `overview action typography differs at ${theme}/${width}`);
    assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth && document.getElementById('detail').scrollWidth<=document.getElementById('detail').clientWidth && [...document.querySelectorAll('.project-development,.project-development-metric,.project-development-worker-link')].every(n=>n.scrollWidth<=n.clientWidth+1)`), `development card overflow at ${theme}/${width}`);
    assert(await evaluate(`(() => { const cards=document.querySelectorAll('.project-development');const link=cards[0].querySelector('a');link.focus();return cards[0].textContent.includes('314')&&cards[0].textContent.includes('4 个派生 Worker 待父确认')&&cards[0].textContent.includes('2 个 Agent 正在调用')&&link.href.endsWith('/#worker-8')&&link.target==='_blank'&&link.rel==='noopener'&&document.activeElement===link&&cards[1].textContent.includes('当前开发状态未确认')&&!cards[1].querySelector('.project-development-metrics'); })()`), `development state or keyboard links failed at ${theme}/${width}`);
    await screenshot(`development-${theme}-${width}`);
    console.log(`PASS project development cards and uniform action typography ${theme}/${width}`);
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
  if (extraSession) { currentPort = extraPort; await rpc(`/session/${extraSession}`, undefined, 'DELETE').catch(() => {}); }
  if (extraDriver) { extraDriver.kill('SIGTERM'); await extraDriver.exited; }
  currentPort = port;
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  if (driver) { driver.kill('SIGTERM'); await driver.exited; }
  server.stop(true);
  if (passed) fs.rmSync(root, { recursive: true, force: true });
  else console.error(`Browser fixture diagnostics retained: ${root}`);
}
