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
const press = async label => {
  assert(await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled&&b.getClientRects().length)`), `button not ready: ${label}`);
  return execute(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled&&b.getClientRects().length).click()`);
};
async function frame() { await rpc(`/session/${session}/frame`, { id: await element('#viewport') }); }
async function route(hash, feature) {
  await execute(`location.hash=${JSON.stringify(hash)}`);
  const selector = feature ? `.automation-settings[data-feature-settings="${feature}"]` : '.automation-feature-list';
  assert(await wait(`document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`), `route missing ${hash}`);
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
async function screenshot(name) {
  assert(await wait(`!document.querySelector('[data-disclosure-motion]')`), 'disclosure animation did not settle');
  fs.writeFileSync(path.join(evidence, `${name}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
}
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
  assert(await wait(`document.querySelectorAll('.automation-feature').length===${f.project.hooksList().registry.total}`), 'dynamic registry entries missing');
  await execute(`const s=document.querySelector('[aria-label="查找自动化功能"]');s.value='待验收告知';s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
  assert(await execute(`return [...document.querySelectorAll('.automation-feature')].filter(n=>!n.hidden).length===1`), 'explicit search failed');
  await click('.automation-feature:not([hidden]) a'); assert(await wait(`document.querySelector('.automation-acceptance-notice [data-level="off"]')`), 'notice settings missing');
  await state('off'); await press('← 返回自动化功能列表');
  assert(await execute(`return document.querySelector('[aria-label="查找自动化功能"]').value==='待验收告知'`), 'back lost search');
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
  assert(await wait(`location.hash==='#hooks'&&document.querySelectorAll('.automation-feature').length===${f.project.hooksList().registry.total}`), 'retired convergence hash did not redirect');
  assert(await execute(`return !document.querySelector('.convergence-defaults')&&!document.querySelector('[data-feature="convergence"]')`), 'retired settings remain');
  const unmounted = (await f.project.order('Browser future Worker 2', 'main', [], null, false)).task;
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame(); await execute(`document.documentElement.dataset.theme='${theme}'`);
    for (const feature of [null, 'completion', 'push', 'acceptance_notice']) {
      await route(feature ? `#hooks-${feature}` : '#hooks', feature);
      assert(await execute(`return innerWidth===${width}&&document.documentElement.scrollWidth<=innerWidth&&!document.querySelector('.page-subnav')`), `overflow ${theme}/${width}/${feature}`);
      if (feature) {
        assert(await execute(`const panel=document.querySelector('.automation-settings-panel'),head=panel.querySelector('.section-title'),feedback=panel.querySelector('.automation-settings-feedback');return panel.classList.contains('ui-module')&&panel.classList.contains('module-fold')&&getComputedStyle(head).position==='sticky'&&!panel.querySelector('.module-body').hidden&&feedback.parentElement===panel&&!document.querySelector('.automation-principle').open&&getComputedStyle(document.querySelector('.registry-metadata')).display==='flex'`), `shared settings hierarchy ${theme}/${width}/${feature}`);
        assert(await execute(`return [...document.querySelectorAll('.automation-settings .hook-actions button')].every(b=>{const r=b.getBoundingClientRect();return r.width<innerWidth*.8&&r.right<=innerWidth&&r.height===(b.matches('.control-primary,.agent-call')&&${width}<=760?44:32)})`), `full-line or small buttons ${theme}/${width}/${feature}`);
        await execute(`window.retainedAutomationControls=[...document.querySelectorAll('.automation-settings :is(select,button)')];`);
        await click('.automation-settings-panel .module-toggle');
        assert(await execute(`const p=document.querySelector('.automation-settings-panel');return p.querySelector('.module-body').hidden&&p.querySelector('.automation-settings-feedback').getClientRects().length&&retainedAutomationControls.every(n=>n.isConnected)`), `fold lost feedback or controls ${theme}/${width}/${feature}`);
        await route('#hooks'); await route(`#hooks-${feature}`, feature);
        assert(await execute(`return document.querySelector('.automation-settings-panel .module-body').hidden`), 'feature navigation lost module state');
        await click('.automation-settings-panel .module-toggle');
        assert(await wait(`(()=>{const body=document.querySelector('.automation-settings-panel .module-body');return !body.hasAttribute('data-disclosure-motion')&&!body.hidden&&getComputedStyle(body).overflowY==='visible'&&body.clientHeight>=body.scrollHeight-1})()`), `settings form clipped ${theme}/${width}/${feature}`);
      } else {
        assert(await execute(`const tools=document.querySelector('.automation-directory-tools');return tools.classList.contains('ui-list-tools')&&!!tools.querySelector('.search-field')&&!!tools.querySelector('[aria-label="包含已回收临时项"]')&&!!tools.querySelector('.hook-actions')&&!!document.querySelector('.ui-list-pagination [role="status"]')`), `shared directory tools ${theme}/${width}`);
      }
      await screenshot(`${theme}-${width}-${feature || 'directory'}`);
    }
    for (const worker of [main, old, child, unmounted]) {
      await workerRoute(worker); const facts = f.project.taskHooks(worker.id).mounted_features;
      const expected = Object.keys(facts).filter(id => facts[id] && id !== 'convergence');
      const layout = await execute(`const root=document.querySelector('.worker-hooks'), heads=[...root.querySelectorAll('.worker-automation-feature-head')];return {features:heads.map(n=>n.parentElement.dataset.feature),height:root.getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth||root.scrollWidth>root.clientWidth,heads:heads.map(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height}}),advancedHidden:root.querySelector('.hook-management').hidden};`);
      layouts.push({ theme, width, worker_id: worker.id, ...layout });
      assert(JSON.stringify(layout.features.sort()) === JSON.stringify(expected.sort()), `non-mounted entries ${worker.id}`);
      assert(!layout.overflow && layout.heads.every(r => r.left >= 0 && r.right <= width), `Worker heading overflow ${theme}/${width}/${worker.id}`);
      assert(layout.heads.every((r,i)=>Math.abs(r.left-layout.heads[0].left)<1&&Math.abs(r.right-layout.heads[0].right)<1&&(i===0||r.top>=layout.heads[i-1].bottom)), `each automation feature needs its own row ${theme}/${width}/${worker.id}`);
      assert(layout.advancedHidden && layout.height < (width === 1440 ? 245 : 345), `automation too tall ${theme}/${width}/${worker.id}: ${layout.height}`);
      assert(await execute(`return [...document.querySelectorAll('.worker-automation-feature')].every(n=>{const t=n.querySelector('h3'),labels=[...n.querySelectorAll('button')].map(b=>b.textContent);return t.tabIndex===0&&!!t.dataset.help&&!t.hasAttribute('title')&&!n.querySelector('details')&&JSON.stringify(labels)===JSON.stringify(n.dataset.feature==='completion'?['关闭','合并','验收']:n.dataset.feature==='push'?['关闭推送','开启推送']:['关闭告知','开启告知'])})`), 'title/help/button shape mismatch');
      assert(await execute(`const root=document.querySelector('.worker-hooks'),toggle=root.querySelector('.module-toggle');return root.classList.contains('ui-module')&&getComputedStyle(root.querySelector('.section-title')).position==='sticky'&&toggle.getAttribute('aria-expanded')==='false'&&root.querySelector('.module-body').hidden&&[...root.querySelectorAll('.worker-feature-title')].every(n=>{const r=n.getBoundingClientRect(),controls=n.nextElementSibling.getBoundingClientRect();return r.width>0&&r.height>0&&r.right<=controls.left&&!!n.dataset.help})&&[...root.querySelectorAll('[data-feature="completion"] button')].every(n=>!n.classList.contains('agent-call')&&getComputedStyle(n,'::before').content==='none'&&n.getBoundingClientRect().height===32)`), 'shared heading, compact controls or non-Agent delivery markers');
      await click('.worker-hooks .module-toggle');
      assert(await execute(`const root=document.querySelector('.worker-hooks');window.savedControls=[...root.querySelectorAll('.worker-automation-feature button')];return root.querySelector('.module-toggle').getAttribute('aria-expanded')==='true'&&!root.querySelector('.module-body').hidden&&[...root.querySelectorAll('.worker-feature-title')].every(n=>getComputedStyle(n).display!=='none')`), 'full automation expansion');
      if (await execute(`return document.querySelector('.worker-hooks').getBoundingClientRect().height>300`)) {
        await execute(`const root=document.querySelector('.worker-hooks'),panel=document.querySelector('#detail'),page=getComputedStyle(panel).overflowY==='visible';
          window.automationStickyEdge=parseFloat(getComputedStyle(root.querySelector('.section-title')).top)+(page?0:panel.getBoundingClientRect().top+parseFloat(getComputedStyle(panel).paddingTop));
          const delta=root.getBoundingClientRect().top-automationStickyEdge+80;if(page)scrollBy(0,delta);else panel.scrollTop+=delta;`);
        assert(await wait(`(()=>{const root=document.querySelector('.worker-hooks'),head=root.querySelector('.section-title');return Math.abs(head.getBoundingClientRect().top-automationStickyEdge)<2&&head.getBoundingClientRect().bottom<=root.getBoundingClientRect().bottom+1})()`), 'automation sticky title geometry');
      }
      await click('.worker-hooks .module-toggle');
      assert(await execute(`return savedControls.every(n=>n.isConnected)&&document.querySelector('.worker-hooks .module-body').hidden`), 'fold must preserve live controls');
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
  // Move off the title before keyboard focus, so scroll-induced pointerout cannot cancel its help timer.
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', origin: 'viewport', x: 2, y: 2 }] }] });
  await execute(`dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.querySelector('.worker-hooks .module-toggle').scrollIntoView({block:'center',behavior:'instant'});document.querySelector('.worker-hooks .module-toggle').focus();`);
  await rpc(`/session/${session}/execute/async`, { script: 'requestAnimationFrame(()=>requestAnimationFrame(()=>arguments[0](true)))', args: [] });
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE004' }, { type: 'keyUp', value: '\uE004' }] }] });
  assert(await execute(`return document.activeElement.matches(${JSON.stringify(title)})`), 'keyboard cannot reach title');
  assert(await wait(visibleTitleHelp), 'keyboard title help missing'); await recordHelp('keyboard');
  await execute(`dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);
  const beforePress = mutations.length;
  await pointer(title, [{ type: 'pointerDown', button: 0 }, { type: 'pause', duration: 750 }, { type: 'pointerUp', button: 0 }]);
  assert(await wait(visibleTitleHelp), 'long-press title help missing'); assert(mutations.length === beforePress, 'help press mutated settings'); await recordHelp('long-press');
  await click('[data-notice-enabled="true"]'); assert(await wait(`document.querySelector('[data-notice-enabled="true"]').getAttribute('aria-pressed')==='true'`), 'Worker notice ACK missing');
  assert(f.project.taskHooks(child.id).acceptance_notice.enabled && f.project.taskHooks(child.id).completion.locked, 'child notice save unlocked completion');
  await click('.worker-hooks .module-toggle');
  assert(await execute(`return !document.querySelector('.hook-management').hidden&&!document.querySelector('.delivery-handler')&&!document.querySelector('.worker-convergence-control')`), 'retired handler/settings visible');
  await press('刷新详情'); assert(await wait(`!document.querySelector('.hook-management').hidden`), 'refresh lost advanced expansion');
  // A second real chain uses the unified registry, not a test-only RPC shortcut.
  await execute(`location.hash='#hooks-feature-register'`);
  assert(await wait(`document.querySelector('.registry-registration')`), 'registration route missing');
  const fill = (label, value) => execute(`const n=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('change',{bubbles:true}));`);
  await fill('Hook 名称', 'Browser registered notice'); await fill('触发节点', 'agent.returned'); await fill('动作类型', 'notify'); await fill('告知标题', 'Browser'); await fill('消息或告知正文', 'Not executed during registration');
  await press('确认登记功能'); await press('只登记功能');
  assert(await wait(`document.querySelector('.registry-registration > [role="status"]').textContent.includes('登记成功')`), 'register ACK missing');
  const registered = f.project.hooksList().registry.items.find(item => item.name === 'Browser registered notice');
  assert(registered?.mount_count === 0 && !f.project.taskHooks(main.id).mounts.some(m => m.registry_id === registered.id), 'registration mounted main');
  await execute(`location.hash='#hooks'`); assert(await wait(`document.querySelector('.automation-feature-list')?.textContent.includes('Browser registered notice')`), 'registered feature not in directory');
  await execute(`location.hash='#hooks-feature-${registered.id}'`); assert(await wait(`document.querySelector('.registry-mount')`), 'registered detail missing');
  await press('读取 Worker 列表'); assert(await wait(`document.querySelector('[aria-label="选择目标 Worker"]').options.length>1`), 'Worker list missing');
  assert(await execute(`return document.querySelector('[aria-label="选择目标 Worker"]').value===''`), 'main selected implicitly');
  await fill('选择目标 Worker', String(old.id)); assert(await wait(`document.querySelector('.registered-mount-picker')`), 'version picker missing');
  assert(await execute(`return document.querySelector('[aria-label="授权版本"]').value===''`), 'implicit latest selected');
  await fill('授权版本', '1'); await press('确认挂载'); await press('授权挂载');
  assert(await wait(`document.querySelector('.registered-mount-picker [role="status"]').textContent.includes('已保存')`), 'mount ACK missing');
  let model = f.project.taskHooks(old.id), mount = model.mounts.find(m => m.registry_id === registered.id); assert(mount?.registry_version === 1 && !mount.enabled, 'fixed disabled mount missing');
  await execute(`document.querySelector('.registry-advanced').open=true`); await fill('Hook 名称', 'Browser notice revision 2'); await press('登记新版本'); await press('只登记功能');
  assert(await wait(`document.querySelector('.registry-registration > [role="status"]').textContent.includes('登记成功')`), 'revision ACK missing');
  assert(f.project.taskHooks(old.id).mounts.find(m => m.id === mount.id).registry_version === 1, 'definition revision changed old grant');
  await workerRoute(old); await click('.worker-hooks .module-toggle');
  assert(await execute(`return document.querySelector('.worker-hooks').textContent.includes('自定义 · ${registered.id} · 固定 v1')&&!document.querySelector('.worker-hooks .hook-form')&&!document.querySelector('[aria-label="挂载模板"]')`), 'source/version missing or raw action editor remains');
  await execute(`document.querySelector('[data-hook-id="${mount.id}"]').querySelectorAll('button')[2].click()`);
  assert(await wait(`document.querySelector('.registered-mount-picker')`), 'upgrade picker missing'); await fill('授权版本', '2');
  await execute(`window.upgradePicker=document.querySelector('.registered-mount-picker');document.querySelector('[aria-label="授权版本"]').focus()`);
  await click('.worker-hooks .module-toggle'); await click('.worker-hooks .module-toggle');
  assert(await execute(`return upgradePicker===document.querySelector('.registered-mount-picker')&&upgradePicker.querySelector('[aria-label="授权版本"]').value==='2'`), 'fold discarded active editor/version draft');
  await press('确认升级挂载版本'); await press('授权升级版本');
  assert(await wait(`document.querySelector('.worker-hooks')?.textContent.includes('固定 v2')`), 'Worker explicit upgrade not visible');
  for (const theme of ['light', 'dark']) for (const width of [1440, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame(); await execute(`document.documentElement.dataset.theme='${theme}';location.hash='#hooks-feature-${registered.id}'`);
    assert(await wait(`document.querySelector('.registry-automation')`), 'registry layout route missing');
    assert(await execute(`const mount=document.querySelector('.registry-mount');return innerWidth===${width}&&document.documentElement.scrollWidth<=innerWidth&&!document.querySelector('.registry-advanced').open&&!document.querySelector('.registry-targets').open&&mount.classList.contains('ui-module')&&!mount.querySelector('.module-body').hidden&&getComputedStyle(mount.querySelector('.section-title')).position==='sticky'`), `registry hierarchy/overflow ${theme}/${width}`);
    await screenshot(`registry-${theme}-${width}`);
    await execute(`document.querySelector('.registry-advanced').open=true;document.querySelector('.registry-targets').open=true`);
    assert(await execute(`return document.documentElement.scrollWidth<=innerWidth`), `expanded registry overflow ${theme}/${width}`); await screenshot(`registry-expanded-${theme}-${width}`);
    await execute(`document.querySelector('.registry-advanced').open=false;document.querySelector('.registry-targets').open=false`);
  }
  // Temporary definitions created by a user/Valet must remain mountable despite readonly definitions.
  const temporary = await execute(`return fetch('api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'hooks.temporary_create',params:{hook:{name:'Browser temporary notice',trigger:'agent.returned',actions:[{type:'notify',title:'browser-temporary',body:'Use once'}]},expected_revisions:{registry:${JSON.stringify(f.project.hooksList().registry.revision)}},client_request_id:'browser-temporary'}})}).then(r=>r.json())`);
  assert(temporary.created && temporary.temporary, 'temporary creation receipt missing');
  await route('#hooks'); await press('刷新目录'); assert(await wait(`document.querySelector('[data-feature="${temporary.template_id}"]')`), 'temporary directory entry missing');
  assert(await execute(`return document.querySelector('[data-feature="${temporary.template_id}"]').textContent.includes('临时')`), 'temporary text label missing');
  await execute(`location.hash='#hooks-feature-${temporary.template_id}'`); assert(await wait(`document.querySelector('.temporary-usage')?.textContent.includes('实际挂载 0')`), 'temporary usage missing');
  await press('读取 Worker 列表'); assert(await wait(`document.querySelector('[aria-label="选择目标 Worker"]').options.length>1`), 'temporary target list missing');
  await fill('选择目标 Worker', String(old.id)); assert(await wait(`document.querySelector('.registered-mount-picker')`), 'temporary picker missing');
  assert(await execute(`return document.querySelector('[aria-label="已登记功能"]').textContent.includes('Browser temporary notice · 临时')`), 'readonly temporary filtered out');
  await fill('授权版本', '1'); await press('确认挂载'); await press('授权挂载');
  assert(await wait(`document.querySelector('.temporary-reclaim-reason')?.textContent.includes('残留挂载')`), 'disabled mount did not block reclaim');
  for (const theme of ['light', 'dark']) for (const width of [1440, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame(); await execute(`document.documentElement.dataset.theme='${theme}'`);
    assert(await execute(`const usage=document.querySelector('.temporary-usage');return innerWidth===${width}&&document.documentElement.scrollWidth<=innerWidth&&!document.querySelector('.registry-advanced').open&&usage.classList.contains('ui-module')&&usage.querySelector('.temporary-usage-summary').parentElement===usage&&usage.querySelector('.temporary-reclaim-reason').parentElement===usage`), `temporary hierarchy/overflow ${theme}/${width}`);
    await screenshot(`temporary-${theme}-${width}`);
    await execute(`document.querySelector('.registry-advanced').open=true;document.querySelector('.temporary-usage details').open=true`);
    assert(await execute(`return document.documentElement.scrollWidth<=innerWidth`), `temporary expanded overflow ${theme}/${width}`); await screenshot(`temporary-expanded-${theme}-${width}`);
    await execute(`document.querySelector('.registry-advanced').open=false;document.querySelector('.temporary-usage details').open=false`);
  }
  await workerRoute(old); await click('.worker-hooks .module-toggle');
  const tempMount = f.project.taskHooks(old.id).mounts.find(m => m.registry_id === temporary.template_id);
  await execute(`document.querySelector('[data-hook-id="${tempMount.id}"]').querySelector('button').click()`);
  assert(await wait(`document.querySelector('[data-hook-id="${tempMount.id}"]').textContent.includes('停用 Hook')`), 'temporary enable ACK missing');
  f.project.emitTaskHook(old.id, 'agent.returned'); await f.project.hookQueue;
  await execute(`location.hash='#hooks-feature-${temporary.template_id}'`); assert(await wait(`document.querySelector('.temporary-usage')`), 'temporary return missing');
  await press('只读刷新使用状态'); assert(await wait(`document.querySelector('.temporary-usage').textContent.includes('累计挂载 1 · 成功 1')`), 'temporary success count missing');
  await press('安全回收临时功能'); await press('确认安全回收'); assert(await wait(`document.querySelector('.temporary-usage [role="status"]').textContent.includes('安全回收成功')`), 'reclaim ACK missing');
  await route('#hooks'); assert(await execute(`return !document.querySelector('[data-feature="${temporary.template_id}"]')`), 'reclaimed entry still default-visible');
  await click('[aria-label="包含已回收临时项"]'); assert(await wait(`document.querySelector('[data-feature="${temporary.template_id}"]')?.textContent.includes('已回收')`), 'reclaimed audit entry missing');
  await execute(`location.hash='#hooks-feature-${temporary.template_id}'`); assert(await wait(`document.querySelector('.temporary-usage')`), 'reclaimed detail missing'); await press('只读刷新使用状态');
  assert(await wait(`document.querySelector('.temporary-usage').textContent.includes('已回收 · 只读')`), 'reclaimed readonly state missing');
  assert(await execute(`return [...document.querySelectorAll('.registry-mount')].every(n=>n.hidden)&&document.querySelector('.temporary-usage').textContent.includes('hook.execution_succeeded')`), 'reclaimed remained mountable or audit lost');
  assert(!f.project.hooksList().registry.items.find(item => item.id === registered.id).temporary, 'permanent item migrated');
  assert(!reads.some(url => url.includes('/api/automation/completion/workers') || url.includes('/branch-convergence/runs')), 'project settings loaded execution records');
  assert(mutations.every(item => ['hooks.automation_settings', 'worker.acceptance_notice', 'hooks.save', 'worker.hook_attach', 'worker.hook_update', 'hooks.temporary_create', 'hooks.temporary_reclaim'].includes(item.method)), 'unexpected mutation');
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
