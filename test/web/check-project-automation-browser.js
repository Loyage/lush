// Firefox → isolated Host/HTTP/RPC/SQLite/Git. No user service or paid Provider.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { request } from 'node:http';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-project-automation-browser-'));
const f = await setup(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
f.project.provider = { run() { throw Error('No real Agent allowed'); } };
let driver, wrapper, session, success = false;
const mutations = [], errors = [], reads = [], layouts = [], helpChecks = [];
const assert = (ok, message) => { if (!ok) throw Error(message); };
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
async function rpc(suffix, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${suffix}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => text += part); res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(70000, () => req.destroy(Error('WebDriver timed out'))); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = condition => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0],end=Date.now()+10000;const check=()=>(${condition})?done(true):Date.now()>end?done(false):setTimeout(check,50);check();`, args: [] });
const element = selector => rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
async function click(selector) {
  await execute(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'});`);
  const node = await element(selector); await rpc(`/session/${session}/element/${node['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
const press = label => execute(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`);
async function frame() { await rpc(`/session/${session}/frame`, { id: await element('#viewport') }); }
async function route(hash, feature) {
  await execute(`location.hash=${JSON.stringify(hash)}`);
  const selector = feature ? `.automation-settings[data-feature-settings="${feature}"]` : '.automation-feature-list';
  assert(await wait(`document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).hidden`), `route missing ${hash}`);
}
const scope = value => execute(`const s=document.querySelector('.automation-settings [aria-label="挂载范围"]');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));`);
const state = value => click(`.automation-settings [data-level="${value}"]`);
const visibleTitleHelp = `(()=>{const tip=document.querySelector('.help-tip:not([hidden])');if(!tip)return false;const r=tip.getBoundingClientRect(),s=getComputedStyle(tip);return tip.textContent.includes('成果就绪')&&s.opacity==='1'&&s.display!=='none'&&r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&document.querySelector('[data-feature="completion"] h3')?.getAttribute('aria-describedby')==='help-tip'})()`;
async function recordHelp(name) {
  assert(await wait(visibleTitleHelp), `${name} title help missing`);
  helpChecks.push(await execute(`const t=document.querySelector('.help-tip'),r=t.getBoundingClientRect();return {name:${JSON.stringify(name)},hidden:t.hidden,opacity:getComputedStyle(t).opacity,text:t.textContent,left:r.left,right:r.right,top:r.top,height:r.height};`));
  await screenshot(`title-${name}`);
  assert(await execute(`return ${visibleTitleHelp}`), `${name} help vanished during screenshot`);
}
async function workerRoute(worker) {
  await execute(`location.hash='#worker-${worker.id}'`);
  assert(await wait(`document.querySelector('.worker-hooks')?.dataset.workerId==='${worker.id}'&&!document.querySelector('.automation-settings')`), `Worker missing ${worker.id}`);
}
async function pointer(selector, actions) {
  await execute(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'});`);
  // WebDriver may move before scrollIntoView's queued scroll event dispatch;
  // that event correctly cancels help timers. Settle layout before hovering.
  await rpc(`/session/${session}/execute/async`, { script: 'const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(()=>done()));', args: [] });
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
    { type: 'pointerMove', duration: 0, origin: await element(selector), x: 0, y: 0 }, ...actions,
  ] }] });
}
async function screenshot(name) { fs.writeFileSync(path.join(evidence, `${name}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64')); }
try {
  await repo(f.root); const main = await f.project.bootstrapMain();
  const old = (await f.project.order('Browser existing Worker', 'main', [], null, false)).task;
  f.project.stopping = true; const child = await f.project.spawn(old.id, 'Browser child'); f.project.stopping = false;
  const host = await (await fetch(f.url + '/api/host/projects')).json(), projectId = host.projects.find(item => item.project === f.root)?.id;
  assert(projectId, 'temporary project not registered');
  wrapper = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/fixture') return new Response(`<!doctype html><html><body style="margin:0"><iframe id="viewport" style="border:0;width:1440px;height:950px" src="/p/${projectId}/#hooks"></iframe></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    const body = req.method === 'POST' ? await req.text() : null;
    if (url.pathname.endsWith('/api/action') && body) mutations.push(JSON.parse(body)); else if (url.pathname.includes('/api/')) reads.push(url.pathname);
    const upstream = await fetch(f.url + url.pathname + url.search, { method: req.method, ...(body !== null ? { headers: { 'Content-Type': 'application/json' }, body } : {}) });
    if (upstream.status >= 400) errors.push(`${upstream.status} ${url.pathname}`);
    const headers = new Headers(upstream.headers);
    if (headers.has('content-security-policy')) headers.set('content-security-policy', headers.get('content-security-policy').replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
  } });
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(evidence, 'driver.log')), stderr: Bun.file(path.join(evidence, 'driver.log')) });
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {} if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100); }
  assert(ready, 'geckodriver did not start');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', timeouts: { script: 60000 }, 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1100 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${wrapper.port}/fixture` }); await frame();
  assert(await wait(`document.querySelectorAll('.automation-feature').length===3`), 'current setting entries missing');
  await execute(`const s=document.querySelector('[aria-label="查找自动化功能"]');s.value='告知';s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
  assert(await execute(`return [...document.querySelectorAll('.automation-feature')].filter(n=>!n.hidden).length===1`), 'explicit search failed');
  await click('.automation-feature:not([hidden]) a'); assert(await wait(`document.querySelector('.automation-acceptance-notice [data-level="off"]')`), 'notice settings missing');
  await state('off'); await press('← 返回自动化功能列表');
  assert(await execute(`return document.querySelector('[aria-label="查找自动化功能"]').value==='告知'`), 'back lost search');
  await route('#hooks-completion', 'completion'); await state('accept'); await scope('user');
  await press('保存项目设置'); assert(await wait(`!document.querySelector('#modal').hidden`), 'acceptance confirmation missing');
  assert(await execute(`return document.querySelector('#modal').textContent.includes('分支子树')&&document.querySelector('#modal').textContent.includes('不是质量评审')`), 'acceptance scope incomplete');
  await press('取消'); assert(mutations.length === 0, 'cancel wrote authorization');
  await press('保存项目设置'); await press('授权并保存'); assert(await wait(`document.querySelector('.automation-settings-status').textContent.includes('已保存')`), 'completion ACK missing');
  assert(f.project.automationSettings().mount_scopes.completion === 'user' && f.project.automationSettings().completion_defaults.level === 'accept', 'real scope/default missing');
  assert(f.project.taskHooks(old.id).completion.level === 'off', 'existing Worker changed');
  await route('#hooks-acceptance_notice', 'acceptance_notice');
  assert(await execute(`return document.querySelector('[data-level="off"]').getAttribute('aria-pressed')==='true'`), 'feature change lost draft');
  await press('保存项目设置'); assert(await wait(`document.querySelector('.automation-settings-status').textContent.includes('原 revision 保留')`), 'stale revision not rejected');
  await press('重新读取项目设置'); await press('放弃并读取'); assert(await wait(`document.querySelector('[data-level="on"]').getAttribute('aria-pressed')==='true'`), 'reread failed');
  await state('off'); await scope('user'); await press('保存项目设置'); assert(await wait(`document.querySelector('.automation-settings-status').textContent.includes('已保存')`), 'notice ACK missing');
  const fresh = (await f.project.order('Browser future Worker', 'main', [], null, false)).task;
  assert(f.project.taskHooks(fresh.id).completion.level === 'accept' && !f.project.taskHooks(fresh.id).acceptance_notice.enabled, 'future order did not freeze defaults');
  await execute(`location.hash='#hooks-convergence'`);
  assert(await wait(`location.hash==='#hooks'&&document.querySelectorAll('.automation-feature').length===3`), 'retired convergence hash did not redirect');
  assert(await execute(`return !document.querySelector('.convergence-defaults')&&!document.querySelector('[data-feature="convergence"]')`), 'retired settings remain');
  const unmounted = (await f.project.order('Browser future Worker 2', 'main', [], null, false)).task;
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame(); await execute(`document.documentElement.dataset.theme='${theme}'`);
    for (const feature of [null, 'completion', 'push', 'acceptance_notice']) {
      await route(feature ? `#hooks-${feature}` : '#hooks', feature);
      assert(await execute(`return innerWidth===${width}&&document.documentElement.scrollWidth<=innerWidth&&!document.querySelector('.page-subnav')`), `overflow ${theme}/${width}/${feature}`);
      if (feature) assert(await execute(`return [...document.querySelectorAll('.automation-settings .hook-actions button')].every(b=>{const r=b.getBoundingClientRect();return r.width<innerWidth*.8&&r.right<=innerWidth})`), `full-line buttons ${theme}/${width}/${feature}`);
      await screenshot(`${theme}-${width}-${feature || 'directory'}`);
    }
    for (const worker of [main, old, child, unmounted]) {
      await workerRoute(worker); const facts = f.project.taskHooks(worker.id).mounted_features;
      const expected = Object.keys(facts).filter(id => facts[id] && id !== 'convergence');
      const layout = await execute(`const root=document.querySelector('.worker-hooks'), heads=[...root.querySelectorAll('.worker-automation-feature-head')];return {features:heads.map(n=>n.parentElement.dataset.feature),height:root.getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth,heads:heads.map(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height}}),advancedHidden:root.querySelector('.hook-management').hidden};`);
      layouts.push({ theme, width, worker_id: worker.id, ...layout });
      assert(JSON.stringify(layout.features.sort()) === JSON.stringify(expected.sort()), `non-mounted entries ${worker.id}`);
      assert(!layout.overflow && layout.heads.every(r => r.left >= 0 && r.right <= width), `Worker heading overflow ${theme}/${width}/${worker.id}`);
      assert(layout.advancedHidden && layout.height < (width === 1440 ? 245 : 345), `automation too tall ${theme}/${width}/${worker.id}: ${layout.height}`);
      assert(await execute(`return [...document.querySelectorAll('.worker-automation-feature')].every(n=>{const t=n.querySelector('h3'),labels=[...n.querySelectorAll('button')].map(b=>b.textContent);return t.tabIndex===0&&!!t.dataset.help&&!t.hasAttribute('title')&&!n.querySelector('details')&&JSON.stringify(labels)===JSON.stringify(n.dataset.feature==='completion'?['关闭','合并','验收']:['关闭','开启'])})`), 'title/help/button shape mismatch');
      if (worker.id === child.id) assert(await execute(`return [...document.querySelectorAll('[data-feature="completion"] button')].every(n=>n.disabled)&&!document.querySelector('[data-notice-enabled="true"]').disabled`), 'child lock changed');
      await execute(`document.querySelector('.worker-hooks').scrollIntoView({block:'center',behavior:'instant'});`);
      await screenshot(`${theme}-${width}-worker-${worker.id}`);
    }
    console.log(`PASS settings, mounted main/order/child/excluded; ${theme}/${width}px`);
  }
  await workerRoute(child); const title = '[data-feature="completion"] h3';
  await execute(`window.helpEvents=[];for(const type of ['pointerover','pointerout','scroll','focusout'])addEventListener(type,e=>helpEvents.push({type,time:performance.now(),target:e.target.outerHTML?.slice(0,300)}));`);
  await pointer(title, [{ type: 'pause', duration: 1400 }]); assert(await wait(visibleTitleHelp), 'hover title help missing');
  await recordHelp('hover');
  await execute(`dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.querySelector('.hook-management-toggle').scrollIntoView({block:'center',behavior:'instant'});document.querySelector('.hook-management-toggle').focus();`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE004' }, { type: 'keyUp', value: '\uE004' }] }] });
  assert(await execute(`return document.activeElement.matches(${JSON.stringify(title)})`), 'keyboard cannot reach title');
  assert(await wait(visibleTitleHelp), 'keyboard title help missing'); await recordHelp('keyboard');
  await execute(`dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);
  const beforePress = mutations.length;
  await pointer(title, [{ type: 'pointerDown', button: 0 }, { type: 'pause', duration: 750 }, { type: 'pointerUp', button: 0 }]);
  assert(await wait(visibleTitleHelp), 'long-press title help missing'); assert(mutations.length === beforePress, 'help press mutated settings'); await recordHelp('long-press');
  await click('[data-notice-enabled="true"]'); assert(await wait(`document.querySelector('[data-notice-enabled="true"]').getAttribute('aria-pressed')==='true'`), 'Worker notice ACK missing');
  assert(f.project.taskHooks(child.id).acceptance_notice.enabled && f.project.taskHooks(child.id).completion.locked, 'child notice save unlocked completion');
  await press('高级与记录'); assert(await execute(`return !document.querySelector('.hook-management').hidden&&!document.querySelector('.delivery-handler')&&!document.querySelector('.worker-convergence-control')`), 'retired handler/settings visible');
  await press('刷新详情'); assert(await wait(`!document.querySelector('.hook-management').hidden`), 'refresh lost advanced expansion');
  assert(!reads.some(url => url.includes('/api/automation/completion/workers') || url.includes('/branch-convergence/runs')), 'project settings loaded execution records');
  assert(mutations.every(item => ['hooks.automation_settings', 'worker.acceptance_notice'].includes(item.method)), 'unexpected mutation');
  assert(errors.length === 1 && errors[0].includes('/api/action'), `unexpected failures: ${errors}`);
  fs.writeFileSync(path.join(evidence, 'checks.json'), JSON.stringify({ mutations, errors, reads, layouts, helpChecks, help: ['hover 1200ms', 'keyboard Tab 1200ms', 'mouse long-press 650ms'] }, null, 2));
  success = true; console.log('PASS real defaults/scope saves, frozen future creation, hidden non-mounts, retained draft/stale revision, compact dual-theme layout and title hover/keyboard/long-press help');
} catch (error) {
  if (session) { try { fs.writeFileSync(path.join(evidence, 'failure-page.json'), JSON.stringify(await execute('return {url:location.href,html:document.documentElement.outerHTML,helpEvents:window.helpEvents};'))); } catch {} }
  if (session) { try { await screenshot('failure'); } catch {} }
  throw error;
} finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  if (driver) { driver.kill(); await driver.exited; } wrapper?.stop(true); f.project.stopping = false; await f.close();
  console.log(`${success ? 'Browser evidence' : 'Browser failure diagnostics'}: ${evidence}`);
}
