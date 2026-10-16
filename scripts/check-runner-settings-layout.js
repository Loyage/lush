// Real Firefox layout evidence using actual page entries and controlled, non-network Runner data.
// This is not SSH/cgroup acceptance. The real HTTP/RPC chain lives in runner-settings-page-integration.test.js.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const evidence = await mkdtemp(join(tmpdir(), 'lush-runner-settings-layout-'));
const fixture = `
import { makeWorld } from '/fixture-world.js';
const world=makeWorld(),id='11111111-1111-4111-8111-111111111111';
window.runnerCalls=[];
const nodes={revision:'1'.repeat(64),nodes:[{id,name:'可信远端节点 · 长名称用于窄屏换行验证',ssh_alias:'private-alias',enabled:false,expected_runner_id:null,budgets:{max_commands:1,timeout_ms:60000,output_bytes:1048576}}]};
window.fetch=async(url,options={})=>{
 const parsed=new URL(url,location.href),path=parsed.pathname;
 const json=value=>({ok:true,status:200,json:async()=>structuredClone(value)});
 if(path.includes('/runner/'))window.runnerCalls.push({path});
 if(path.includes('/runner/nodes'))return json(nodes);
 if(path.includes('/runner/credentials'))return json({revision:'absent',nodes:[]});
 if(path.includes('/runner/project'))return json({revision:1,project_id:'paired-fixture',allowed_node_ids:[],default_node_id:id});
 if(path==='/api/host/projects')return json({projects:[{id:'aaaaaaaaaaaaaaaa',name:'来源项目 A',running:true}]});
 if(options.method==='POST'&&JSON.parse(options.body)?.method?.startsWith('runner.'))throw Error('layout must not mutate');
 return world.fetchImpl(String(url),options);
};
window.openDevice=async()=>{const {openSettings}=await import('/render-settings.js');await openSettings({preferenceActions:{}});await document.querySelector('[data-settings-tab="runners"]').onclick();};
window.openProject=async()=>{const {openProjectManager}=await import('/project-picker.js');await openProjectManager();await [...document.querySelectorAll('.project-item button')].find(n=>n.textContent==='执行节点').onclick();};
await import('/app.js');
await window.openDevice();window.ready=true;
`;
const html = (await Bun.file(join(assets, 'index.html')).text()).replace('<script type="module" src="/app.js"></script>', '<script type="module" src="/fixture.js"></script>');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  // Firefox desktop enforces a 500px outer-window minimum. A real 320px browsing
  // context still exercises responsive media queries and layout without pretending 500px is 320px.
  if (path === '/narrow') return new Response('<!doctype html><html><body style="margin:0"><iframe src="/" style="display:block;border:0;width:320px;height:1000px" title="320px device viewport"></iframe></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (path === '/fixture.js') return new Response(fixture, { headers: { 'Content-Type': 'text/javascript' } });
  if (path === '/fixture-world.js') return new Response((await Bun.file(new URL('../test/web/dom-world.js', import.meta.url)).text()).replace('../../src/ui/web/assets/prefs.js', '/prefs.js'), { headers: { 'Content-Type': 'text/javascript' } });
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }), port = reserve.port; reserve.stop(true);
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(join(evidence, 'geckodriver.log')), stderr: Bun.file(join(evidence, 'geckodriver.log')) });
let session;
async function rpc(path, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; }); res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(20000, () => req.destroy(new Error('WebDriver 20s budget exceeded')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw new Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const asyncExecute = script => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0];(async()=>{${script}})().then(done,error=>done({error:error.message}));`, args: [] });
const assert = (value, text) => { if (!value) throw new Error(text); };
const screenshot = async name => Bun.write(join(evidence, name), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited during startup');
    await Bun.sleep(100);
  }
  assert(ready, 'geckodriver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/timeouts`, { script: 20000, pageLoad: 20000 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  assert(await asyncExecute('for(let i=0;i<100;i++){if(window.ready)return true;await new Promise(r=>setTimeout(r,20));}return false;') === true, 'device entry did not load');
  const results = [];
  for (const theme of ['light', 'dark']) for (const width of [1440, 320]) {
    await rpc(`/session/${session}/frame`, { id: null });
    await rpc(`/session/${session}/window/rect`, { width: Math.max(500, width), height: 1000 });
    await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/${width === 320 ? 'narrow' : ''}` });
    if (width === 320) {
      const frame = await rpc(`/session/${session}/element`, { using: 'css selector', value: 'iframe' });
      await rpc(`/session/${session}/frame`, { id: frame });
    }
    assert(await asyncExecute('for(let i=0;i<100;i++){if(window.ready)return true;await new Promise(r=>setTimeout(r,20));}return false;') === true, 'viewport entry did not load');
    await execute(`document.documentElement.dataset.theme='${theme}';document.documentElement.dataset.reducedMotion='true';`);
    const device = await execute(`const root=document.querySelector('.runner-settings'),visible=n=>!!n.getClientRects().length;
      return {width:innerWidth,entryHeight:document.querySelector('[data-settings-tab="runners"]').getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...root.querySelectorAll('button')].filter(visible).map(n=>n.getBoundingClientRect().height),
      advanced:[...root.querySelectorAll('details')].every(n=>!n.open),warning:visible(root.querySelector('.runner-warning')),alias:root.innerText.includes('private-alias'),
      vertical:innerWidth>600||getComputedStyle(root.querySelector('.runner-actions')).flexDirection==='column'};`);
    assert(device.width === width && device.entryHeight >= 44 && !device.overflow && device.buttons.every(h => h >= 44) && device.advanced && device.warning && !device.alias && device.vertical, `device layout: ${JSON.stringify(device)}`);
    results.push({ page: 'device', theme, requestedWidth: width, ...device }); await screenshot(`device-${theme}-${width}.png`);
    await execute(`document.querySelectorAll('.runner-settings button').forEach(n=>{if(n.textContent==='配置凭据')n.click()});`);
    const credentials = await execute(`const card=document.querySelector('.runner-dialog');return {overflow:card.scrollWidth>card.clientWidth,buttons:[...card.querySelectorAll('button')].map(n=>n.getBoundingClientRect().height),passwords:[...card.querySelectorAll('input')].filter(n=>n.type==='password').length};`);
    assert(!credentials.overflow && credentials.buttons.every(h => h >= 44) && credentials.passwords === 2, `credential layout: ${JSON.stringify(credentials)}`);
    await screenshot(`credentials-${theme}-${width}.png`);
    await execute(`document.querySelector('.modal-cancel').click();`);
    assert(await asyncExecute('await window.openProject();return true;') === true, 'project entry failed');
    const project = await execute(`const root=document.querySelector('.runner-project-settings');return {width:innerWidth,entryHeight:document.querySelector('.project-runner-open').getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth,warning:!!root.querySelector('.runner-warning').getClientRects().length,rows:[...root.querySelectorAll('.runner-choice')].map(n=>n.getBoundingClientRect().height),buttons:[...root.querySelectorAll('button')].map(n=>n.getBoundingClientRect().height)};`);
    assert(project.width === width && project.entryHeight >= 44 && !project.overflow && project.warning && project.rows.every(h => h >= 44) && project.buttons.every(h => h >= 44), `project layout: ${JSON.stringify(project)}`);
    results.push({ page: 'project', theme, requestedWidth: width, ...project });
    await execute(`document.querySelector('.runner-project-settings').scrollIntoView({block:'start'});`);
    await screenshot(`project-${theme}-${width}.png`);
    assert(await asyncExecute('await window.openDevice();return true;') === true, 'device return failed');
  }
  await Bun.write(join(evidence, 'layout.json'), JSON.stringify(results, null, 2));
  console.log(`PASS desktop/narrow light/dark device/project pages, visible anomalies, collapsed diagnostics, credential controls ≥44px. Evidence: ${evidence}`);
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true);
  console.log(`Layout logs/screenshots: ${evidence}`);
}
