// Firefox → isolated Host/HTTP/RPC/SQLite/Git; no paid Provider or user service.
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
const mutations = [], errors = [], reads = [];
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
async function click(selector) {
  await execute(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'});`);
  const node = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${node['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
const press = label => execute(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`);
async function frame() { const node = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: node }); }
async function route(hash, feature) {
  await execute(`location.hash=${JSON.stringify(hash)}`);
  const selector = feature ? `.automation-settings[data-feature-settings="${feature}"]` : '.automation-feature-list';
  assert(await wait(`document.querySelector(${JSON.stringify(selector)})`), `route missing ${hash}`);
}
const choose = (label, value) => execute(`const s=document.querySelector('[aria-label="${label}"]');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));`);
try {
  await repo(f.root); const main = await f.project.bootstrapMain();
  const old = (await f.project.order('Browser existing Worker', 'main', [], null, false)).task;
  f.project.stopping = true;
  const child = await f.project.spawn(old.id, 'Browser child');
  f.project.stopping = false;
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
  assert(await wait(`document.querySelectorAll('.automation-feature').length===4`), 'four setting entries missing');
  assert(await execute(`return [...document.querySelectorAll('.automation-feature')].every(n=>n.textContent.includes('功能简介：')&&n.textContent.includes('原理简介：'))&&!document.querySelector('[data-feature="emission"]')`), 'metadata or exclusion missing');
  await execute(`document.documentElement.dataset.reducedMotion='true';const s=document.querySelector('[aria-label="查找自动化功能"]');s.value='告知';s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
  assert(await execute(`return [...document.querySelectorAll('.automation-feature')].filter(n=>!n.hidden).length===1`), 'explicit search failed');
  await click('.automation-feature:not([hidden]) a'); assert(await wait(`document.querySelector('[aria-label="用户新建 Worker 默认待验收告知"]')`), 'notice settings missing');
  await choose('用户新建 Worker 默认待验收告知', 'off');
  await press('← 返回自动化功能列表'); assert(await execute(`return document.querySelector('[aria-label="查找自动化功能"]').value==='告知'`), 'back lost search');
  await route('#hooks-completion', 'completion'); await choose('用户新建 Worker 默认开启到', 'accept');
  assert(await execute(`return [...document.querySelectorAll('button')].find(b=>b.textContent==='保存项目设置').classList.contains('agent-call')`), 'authorization costs missing');
  await press('保存项目设置'); assert(await wait(`!document.querySelector('#modal').hidden`), 'acceptance confirmation missing');
  assert(await execute(`return document.querySelector('#modal').textContent.includes('分支子树')&&document.querySelector('#modal').textContent.includes('脏改动阻止验收')&&document.querySelector('#modal').textContent.includes('不是质量评审')`), 'acceptance scope incomplete');
  await press('取消'); assert(mutations.length === 0, 'cancel wrote authorization');
  await press('保存项目设置'); await press('授权并保存');
  assert(await wait(`document.querySelector('.automation-settings-status').textContent.includes('已保存')`), 'completion ACK missing');
  assert(f.project.automationSettings().completion_defaults.level === 'accept' && f.project.automationSettings().completion_defaults.enabled, 'real SQLite default missing');
  assert(f.project.taskHooks(old.id).completion.level === 'off', 'existing Worker changed');
  await route('#hooks-acceptance_notice', 'acceptance_notice');
  assert(await execute(`return document.querySelector('[aria-label="用户新建 Worker 默认待验收告知"]').value==='off'`), 'feature change lost notice draft');
  await press('保存项目设置'); assert(await wait(`document.querySelector('.automation-settings-status').textContent.includes('原 revision 保留')`), 'stale feature revision not rejected');
  await press('重新读取项目设置'); await press('放弃并读取');
  assert(await wait(`document.querySelector('[aria-label="用户新建 Worker 默认待验收告知"]').value==='on'`), 'explicit reread failed');
  await choose('用户新建 Worker 默认待验收告知', 'off'); await press('保存项目设置');
  assert(await wait(`document.querySelector('.automation-settings-status').textContent.includes('已保存')`), 'notice ACK missing');
  assert(!f.project.automationSettings().acceptance_notice_defaults.enabled, 'notice default did not persist');
  await route('#hooks-push-history', 'push'); assert(await execute(`return !document.querySelector('.page-subnav')&&!document.querySelector('.push-history')&&location.hash==='#hooks-push'`), 'legacy history did not become settings');
  await press('展开推送高级设置'); assert(await execute(`return !document.querySelector('.shortcut-execution')&&!document.querySelector('.hook-execution')`), 'advanced showed history');
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame(); await execute(`document.documentElement.dataset.theme='${theme}'`);
    for (const feature of [null, 'completion', 'push', 'convergence', 'acceptance_notice']) {
      await route(feature ? `#hooks-${feature}` : '#hooks', feature);
      assert(await execute(`return innerWidth===${width}&&document.documentElement.scrollWidth<=innerWidth&&!document.querySelector('.page-subnav')&&!document.querySelector('.completion-workers')`), `overflow/history ${theme}/${width}/${feature}`);
      if (feature) assert(await execute(`return [...document.querySelectorAll('.automation-settings select')].every(s=>{const r=s.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.height>=44})`), `control layout ${theme}/${width}/${feature}`);
      fs.writeFileSync(path.join(evidence, `${theme}-${width}-${feature || 'directory'}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
    }
    for (const worker of [main, old, child]) {
      await execute(`location.hash='#worker-${worker.id}'`);
      assert(await wait(`document.getElementById('worker-${worker.id}-automation-completion')&&document.querySelectorAll('.worker-automation-feature').length===4`), 'Worker feature entries missing');
      assert(await execute(`return document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.worker-automation-feature-body')].every(n=>!n.hidden)`), `Worker default layout/folding ${theme}/${width}/${worker.id}`);
      assert(await execute(`return [...document.querySelectorAll('.worker-automation-feature-head')].every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})`), `Worker long heading overflow ${theme}/${width}/${worker.id}`);
      if (worker.id === child.id) assert(await execute(`return [...document.querySelectorAll('[data-feature="completion"] .hook-completion-level')].every(n=>n.disabled)&&!document.querySelector('[data-notice-enabled="true"]').disabled`), 'child flow lock or independent notice lost');
      if (worker.id === main.id) assert(await execute(`return !document.querySelector('.acceptance-notice-control')&&!document.querySelector('[data-feature="completion"] .hook-completion-control')&&document.querySelector('[data-feature="push"]').textContent.includes('当前 main 推送：关闭')`), 'main gained unsupported controls or lost real push identity');
      fs.writeFileSync(path.join(evidence, `${theme}-${width}-worker-${worker.id}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
    }
    console.log(`PASS four settings/directory and main/order/child ${theme}/${width}px`);
  }
  await route('#hooks-completion', 'completion');
  const select = await rpc(`/session/${session}/element`, { using: 'css selector', value: '[aria-label="默认显示原则"]' });
  await rpc(`/session/${session}/element/${select['element-6066-11e4-a52e-4f735466cecf']}/value`, { text: '\uE013' });
  assert(await execute(`return document.activeElement?.getAttribute('aria-label')==='默认显示原则'`), 'keyboard cannot focus setting');
  await execute(`location.hash='#worker-${child.id}'`);
  assert(await wait(`document.querySelector('.worker-hooks')&&document.querySelector('[data-notice-enabled="true"]')`), 'child switch missing');
  const folding = await rpc(`/session/${session}/element`, { using: 'css selector', value: '[data-feature="completion"] .worker-feature-toggle' });
  const foldPath = `/session/${session}/element/${folding['element-6066-11e4-a52e-4f735466cecf']}/value`;
  await rpc(foldPath, { text: '\uE007' });
  assert(await execute(`return document.querySelector('[data-feature="completion"] .worker-automation-feature-body').hidden`), 'keyboard could not collapse Worker feature');
  await rpc(foldPath, { text: '\uE007' });
  assert(await execute(`return !document.querySelector('[data-feature="completion"] .worker-automation-feature-body').hidden`), 'keyboard could not reopen Worker controls');
  await click('[data-notice-enabled="true"]');
  assert(await wait(`document.querySelector('[data-notice-enabled="true"]').getAttribute('aria-pressed')==='true'`), 'Worker notice ACK missing');
  assert(f.project.taskHooks(child.id).acceptance_notice.enabled && f.project.taskHooks(child.id).completion.locked, 'real child notice save altered flow lock');
  await route('#hooks-acceptance_notice', 'acceptance_notice'); await choose('默认显示原则', 'main'); await press('保存项目设置');
  assert(await wait(`document.querySelector('.automation-settings-status').textContent.includes('已保存')`), 'display policy ACK missing');
  await execute(`location.hash='#worker-${child.id}'`);
  assert(await wait(`document.querySelector('[data-feature="acceptance_notice"] .worker-automation-feature-body')?.hidden`), 'saved project policy did not fold child feature');
  assert(f.project.taskHooks(child.id).acceptance_notice.enabled && f.project.taskHooks(child.id).completion.locked, 'display policy changed authorization');
  await click('[data-feature="acceptance_notice"] .worker-feature-toggle');
  assert(await execute(`return !document.querySelector('[data-feature="acceptance_notice"] .worker-automation-feature-body').hidden&&!document.querySelector('[data-notice-enabled="false"]').disabled`), 'folded setting cannot be explicitly opened');
  await execute(`location.hash='#hooks-emission-history'`); assert(await wait(`location.hash==='#inputs'&&document.querySelector('.inputs-page')`), 'conditional bookmark not redirected');
  // Worker detail legitimately loads its execution transcript; settings must not load other history or batches.
  assert(!reads.some(url => url.includes('/api/automation/completion/workers') || url.includes('/history-page') && !/\/api\/worker\/\d+\/history-page$/.test(url) || url.includes('/branch-convergence/runs')), 'project settings read execution records');
  assert(mutations.every(item => ['hooks.automation_settings', 'worker.acceptance_notice'].includes(item.method)), 'unexpected execution mutation');
  assert(errors.every(error => error.includes('/api/action')) && errors.length === 1, `unexpected HTTP failures: ${errors}`);
  fs.writeFileSync(path.join(evidence, 'checks.json'), JSON.stringify({ mutations, errors, reads }, null, 2));
  success = true; console.log('PASS real project defaults and child notice saves, policy→Worker folding without authorization change, explicit resource authorization, stale revision protection, retained drafts, legacy routes, keyboard and dual-theme narrow layouts');
} catch (error) {
  if (session) { try { fs.writeFileSync(path.join(evidence, 'failure-page.json'), JSON.stringify(await execute('return {url:location.href,html:document.documentElement.outerHTML};'))); } catch {} }
  throw error;
} finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  if (driver) { driver.kill(); await driver.exited; } wrapper?.stop(true); f.project.stopping = false; await f.close();
  console.log(`${success ? 'Browser evidence' : 'Browser failure diagnostics'}: ${evidence}`);
}
