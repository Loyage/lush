// Actual project app + Firefox, fixture APIs only: no daemon, Git writes or model calls.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { listCapabilityGuides } from '../src/agent/capabilities.js';
const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const projectPath = '/p/aaaaaaaaaaaaaaaa/';
const fixture = `
import { makeWorld } from '/fixture-world.js';
const world=makeWorld(), json=value=>({ok:true,status:200,json:async()=>structuredClone(value)});
window.calls=[];
window.fetch=async(url,options={})=>{
 const parsed=new URL(url,location.href),path=parsed.pathname.replace(/^\\/p\\/[a-f0-9]{16}/,'');
 if(path==='/api/worker/1'){
  const task=await(await world.fetchImpl(path,options)).json();
  return json({...task,worker_number:'W179',task_kind:'order',status:'waiting',display_title:'修复输入目标辨识',agent:{...task.agent,active:false}});
 }
 if(path==='/api/action')window.calls.push(JSON.parse(options.body));
 if(path.endsWith('/appearance'))return json({id:'aaaaaaaaaaaaaaaa',name:'fixture',project:'/tmp/demo',appearance:{version:1,color:'blue',revision:'fixture'}});
 return world.fetchImpl(path+parsed.search,options);
};
await import('/app.js');
window.ui=(await import('/state.js')).ui;
window.composer=await import('/composer.js');
window.ready=true;
`;
const worldSource = (await Bun.file(new URL('../test/web/dom-world.js', import.meta.url)).text())
  .replace('../../src/ui/web/assets/prefs.js', '/prefs.js')
  .replace("import { listCapabilityGuides } from '../../src/agent/capabilities.js';", `const listCapabilityGuides=()=>${JSON.stringify(listCapabilityGuides())};`);
const html = (await Bun.file(join(assets, 'index.html')).text()).replace('<script type="module" src="/app.js"></script>', '<script type="module" src="/fixture.js"></script>');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === projectPath) return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  // Firefox's top-level minimum width is 500px. A real nested browsing context tests 390px without changing app CSS.
  if (path === '/fixture-frame') return new Response(`<!doctype html><style>body{margin:0}iframe{display:block;border:0}</style><iframe id="viewport" width="1440" height="900" src="${projectPath}#worker-1"></iframe>`, { headers: { 'Content-Type': 'text/html' } });
  if (path === '/fixture.js') return new Response(fixture, { headers: { 'Content-Type': 'text/javascript' } });
  if (path === '/fixture-world.js') return new Response(worldSource, { headers: { 'Content-Type': 'text/javascript' } });
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-composer-layout-')), log = join(temp, 'geckodriver.log');
const output = process.argv[2] || '/tmp/lush-composer-layout';
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log),
});
let session, passed = false;
async function rpc(path, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; });
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('WebDriver request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw new Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const waitFor = expression => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0];let n=0;const check=()=>(${expression})?done(true):++n>250?done(false):setTimeout(check,20);check();`, args: [] });
async function click(selector) {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function setViewport(width, height) {
  await rpc(`/session/${session}/frame`, { id: null });
  await rpc(`/session/${session}/window/rect`, { width: Math.max(width, 500), height: height + 200 });
  await execute(`const frame=document.querySelector('#viewport');frame.width=${width};frame.height=${height};`);
  const frame = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' });
  await rpc(`/session/${session}/frame`, { id: frame });
}
async function enter() {
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
}
async function checkLayout(mode, theme, color, focused) {
  const layout = await execute(`const form=document.querySelector('#input-form'),band=document.querySelector('#composer-mode'),box=document.querySelector('#input');
    document.documentElement.dataset.reducedMotion='true';document.documentElement.dataset.theme='${theme}';document.documentElement.dataset.projectColor='${color}';
    box.value='打字之后仍需清楚知道输入去向';box.dispatchEvent(new Event('input'));${focused ? 'box.focus();' : 'box.blur();'}
    const field=getComputedStyle(box),icon=document.querySelector('#composer-mode-icon');
    const shell=getComputedStyle(document.querySelector('.composer'));
    const target=document.querySelector('#composer-mode-target'),targetStyle=getComputedStyle(target);
    const r=band.getBoundingClientRect(),fr=form.getBoundingClientRect(),tr=target.getBoundingClientRect();
    return {mode:form.dataset.mode,viewport:innerWidth,title:document.querySelector('#composer-mode-title').textContent,target:target.textContent,
      behavior:document.querySelector('#composer-mode-behavior').textContent,placeholder:box.placeholder,contentLabel:box.getAttribute('aria-label'),submit:document.querySelector('#draft-commit').textContent,bufferHidden:document.querySelector('#input-buffer').hidden,fieldStyle:field.borderTopStyle,fieldWidth:field.borderTopWidth,outlineStyle:field.outlineStyle,
      outerBorderless:[form,icon,target,document.querySelector('.composer-input')].every(n=>['Top','Right','Bottom','Left'].every(edge=>getComputedStyle(n)['border'+edge+'Width']==='0px')),
      regionTint:shell.backgroundColor,fieldBackground:getComputedStyle(document.querySelector('.composer-input')).backgroundColor,targetWeight:targetStyle.fontWeight,targetOwnRow:tr.top>=document.querySelector('#composer-mode-title').getBoundingClientRect().bottom,
      fits:r.width>0 && r.top>=0 && r.bottom<=innerHeight && fr.left>=0 && fr.right<=innerWidth && form.scrollWidth<=form.clientWidth+1
        && document.documentElement.scrollWidth<=innerWidth+1 && [...band.children].filter(n=>n.getClientRects().length).every(n=>{const cr=n.getBoundingClientRect();return cr.left>=r.left && cr.right<=r.right+1 && cr.bottom<=r.bottom+1;}),
      described:box.getAttribute('aria-describedby').includes('composer-mode-target'),
      fieldColor:field.borderTopColor,iconColor:getComputedStyle(icon).color,accent:getComputedStyle(document.querySelector('#sidebar')).borderTopColor};`);
  assert(layout.mode === mode && layout.fits && layout.described, `clipped/inaccessible ${theme}/${color}/${mode}/${focused}: ${JSON.stringify(layout)}`);
  assert(layout.outerBorderless && layout.fieldWidth === (focused ? '3px' : '2px') && (!focused || layout.outlineStyle === 'none')
    && layout.regionTint !== layout.fieldBackground, `extra frame or missing regional tint/focus: ${JSON.stringify(layout)}`);
  assert(mode === 'create' ? layout.fieldStyle === 'solid' && layout.title === '新建工作' && layout.target.includes('去向：新 Worker · 基于') && layout.behavior.includes('Enter 暂存')
    : mode === 'append' ? layout.fieldStyle === 'dashed' && Number(layout.targetWeight) >= 650
      && layout.title === '追加输入' && layout.target.includes('W179') && layout.behavior.includes('Enter 提交追加') && !layout.behavior.includes('Enter 暂存')
      : layout.fieldStyle === 'double' && layout.title === '管理 Lush' && layout.target === '去向：管家 · 当前项目'
        && layout.bufferHidden && layout.behavior.includes('暂不支持暂存'), `wrong structure/target: ${JSON.stringify(layout)}`);
  const copy = mode === 'create' ? ['描述你希望新 Worker 完成的工作…', '工作指令正文', '提交新工作']
    : mode === 'append' ? ['补充要求、提供反馈，或说明需要调整的地方…', '追加指令正文', '提交追加']
      : ['描述你希望管家查询、调整或安排的事项…', '管理指令正文', '提交管理指令'];
  assert(layout.placeholder === copy[0] && layout.contentLabel === copy[1] && layout.submit === copy[2], `wrong input copy: ${JSON.stringify(layout)}`);
  assert(layout.fieldColor === layout.accent && layout.iconColor === layout.accent,
    `mode lost project color ${theme}/${color}: ${JSON.stringify(layout)}`);
  return layout;
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited before startup');
    await Bun.sleep(100);
  }
  assert(ready, 'geckodriver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/fixture-frame` });
  await setViewport(1440, 900);
  assert(await waitFor('window.ready && window.ui.composerTask?.id===1'), 'project app/detail did not load');
  assert(await execute(`return document.querySelector('#input-form').dataset.mode==='create';`), 'detail implicitly entered append mode');
  // Enter append using the actual visible mode-selection control, not a synthetic destination.
  await execute(`const entry=[...document.querySelectorAll('.task-actions button')].find(n=>n.textContent==='追加输入');if(!entry)throw Error('append entry missing');entry.id='fixture-append';`);
  await click('#fixture-append');
  assert(await waitFor('document.querySelector("#input-form").dataset.mode==="append"'), 'explicit entry did not select Worker');
  for (const mode of ['append', 'create', 'management']) {
    if (mode === 'management') {
      await execute(`document.querySelector('#input').blur();`);
      await click('#composer-launcher'); await click('#composer-launcher'); await click('#composer-menu-management');
      assert(await waitFor('document.querySelector("#input-form").dataset.mode==="management"'), 'management mode missing');
    }
    if (mode === 'create') {
      // Settle the existing focus-height collapse before WebDriver computes a click coordinate.
      await execute(`document.querySelector('#input').blur();`);
      await click('#composer-launcher'); await click('#composer-launcher'); await click('#composer-menu-order');
      assert(await waitFor('document.querySelector("#input-form").dataset.mode==="create"'), 'reset button did not restore creation');
    }
    for (const theme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [760, 700], [390, 844], [320, 700]]) {
      await setViewport(width, height);
      let viewport;
      for (const focused of [false, true]) {
        const fieldColors = new Set(), regionTints = new Set();
        for (const color of ['green', 'blue', 'teal', 'amber', 'rose', 'slate']) {
          const layout = await checkLayout(mode, theme, color, focused); viewport = layout.viewport;
          fieldColors.add(layout.fieldColor); regionTints.add(layout.regionTint);
        }
        assert(fieldColors.size === 6 && regionTints.size === 6, `mode did not follow all six project palettes: ${theme}/${mode}`);
      }
      if (width === 390 || width === 1440) await Bun.write(`${output}-${mode}-${theme}-${width}.png`, Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
      console.log(`PASS ${mode} ${theme} ${viewport}px: six palettes, whole-region tint, single solid/dashed field edge, focused/unfocused target`);
    }
  }
  await setViewport(390, 844);
  const checks = await execute(`window.composer.toggleComposerDetails(false);const original=window.ui.composerTask,results=[];const title='很长的追加目标标题'.repeat(20)+' <img src=x onerror=alert(1)>';
    for(const change of [{},{freeze:{reason:'固定交付'},input_queue:{buffered:2,reason:'等待交付结束'}},{status:'completed'}]){
      window.ui.composerTask={...original,worker_number:'W179-1',display_title:title,...change};window.composer.appendToWorker(window.ui.composerTask);
      const target=document.querySelector('#composer-mode-target'),form=document.querySelector('#input-form'),r=target.getBoundingClientRect();
      const status=document.querySelector('#composer-target-status'),sr=status.getBoundingClientRect(),shell=document.querySelector('#composer-shell').getBoundingClientRect();
      results.push({mode:form.dataset.mode,target:target.textContent,disabled:document.querySelector('#input').disabled,behavior:document.querySelector('#composer-mode-behavior').textContent,
        compact:form.dataset.expanded==='false',summary:status.textContent,statusVisible:!status.hidden&&getComputedStyle(status).display!=='none'&&sr.width>0&&sr.top>=shell.top&&sr.bottom<=shell.bottom,
        fits:target.scrollWidth<=target.clientWidth+1 && r.left>=0 && r.right<=innerWidth,unsafe:target.querySelectorAll('img').length});
    }window.ui.composerTask=original;window.composer.syncComposer();return results;`);
  assert(checks.every(row => row.mode === 'append' && row.target.includes('W179-1') && row.target.includes('<img') && row.fits && !row.unsafe)
    && checks.every(row=>row.compact) && !checks[1].disabled && checks[1].statusVisible && checks[1].summary.includes('已入箱 2 条追加指令')
    && checks[2].disabled && checks[2].statusVisible && checks[2].summary.includes('Worker 已完成'), `long/frozen/blocked target lost: ${JSON.stringify(checks)}`);
  console.log('PASS long numbered/text-safe targets, compact visible frozen/blocked reasons and legal frozen append');
  await setViewport(1440, 900);
  await execute(`const box=document.querySelector('#input');box.value='确认追加给目标';box.dispatchEvent(new Event('input'));box.focus();`);
  await enter();
  assert(await waitFor('window.calls.some(c=>c.method==="input.emit" && c.params.mode==="append" && c.params.target_id===1 && c.params.content==="确认追加给目标") && !window.ui.composerSubmitting && document.querySelector("#input-form").dataset.mode==="create"'), 'Enter append emission ACK did not restore creation');
  assert(await execute(`return document.querySelector('#composer-reset').hidden && !document.querySelector('#input-buffer-help').hidden;`), 'auto-reset did not restore new-work controls');
  await execute(`const box=document.querySelector('#input');box.value='新建模式只暂存';box.dispatchEvent(new Event('input'));box.focus();`);
  await enter();
  assert(await waitFor('window.calls.some(c=>c.method==="draft.add" && c.params.content==="新建模式只暂存") && !window.ui.composerSubmitting'), 'Enter did not buffer in create mode');
  assert(await execute(`return !window.calls.some(c=>c.method==='order.submit');`), 'mode reset unexpectedly created Worker');
  await execute(`window.composer.appendToWorker(window.ui.composerTask);const box=document.querySelector('#input');box.value='仍然只给原目标';box.dispatchEvent(new Event('input'));location.hash='#workers';`);
  assert(await waitFor('document.querySelector("#input-form").hidden && window.ui.composerAppendTarget?.id===1'), 'navigation changed the pinned append destination or left the form open');
  await click('#composer-launcher'); await click('#composer-menu-append');
  assert(await execute(`return window.ui.composerAppendTarget?.id===1&&document.querySelector('#input').value==='仍然只给原目标'&&!document.querySelector('#input-form').hidden;`), 'launcher changed destination or lost the retained body');
  await execute(`window.ui.composerTask={id:999,worker_number:'W999',goal:'不同页面目标'};window.composer.syncComposer();`);
  assert(await execute(`return document.querySelector('#composer-mode-target').textContent.includes('W179')&&!document.querySelector('#composer-mode-target').textContent.includes('W999');`), 'unrelated detail replaced pinned target metadata');
  console.log(`PASS Enter emits selected append target, ACK restores new-work mode; navigation collapses without retargeting. Screenshots: ${output}-*.png`);
  // Exercise the actual pointer-captured drag, persisted reload, keyboard and viewport clamp.
  await setViewport(1440, 900);
  await execute(`document.querySelector('#input').blur();document.querySelector('#composer-shell').scrollTop=0;`);
  const initialHeight = await execute(`return document.querySelector('#input').getBoundingClientRect().height;`);
  const grip = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#composer-resize' });
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'pointer', id: 'resize-mouse', parameters: { pointerType: 'mouse' }, actions: [
    { type: 'pointerMove', duration: 0, origin: grip, x: 0, y: 0 }, { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', duration: 150, origin: 'pointer', x: 0, y: -80 }, { type: 'pointerUp', button: 0 },
  ] }] });
  const resized = await execute(`return {height:document.querySelector('#input').getBoundingClientRect().height,pref:localStorage.getItem('lush.composer.height:aaaaaaaaaaaaaaaa')};`);
  assert(Math.abs(resized.height-initialHeight-80)<2 && Number(resized.pref)===Math.round(resized.height), `drag did not resize/save: ${JSON.stringify({initialHeight,resized})}`);
  await rpc(`/session/${session}/frame`, { id: null });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/fixture-frame` });
  await setViewport(1440, 900);
  assert(await waitFor('window.ready && window.ui.composerTask?.id===1'), 'reload failed');
  await click('#composer-launcher'); await click('#composer-menu-order');
  assert(await execute(`return Math.abs(document.querySelector('#input').getBoundingClientRect().height-${resized.height})<2;`), 'reload lost input height');
  await setViewport(390, 400);
  assert(await execute(`const box=document.querySelector('#input');return box.getBoundingClientRect().height<=200 && localStorage.getItem('lush.composer.height:aaaaaaaaaaaaaaaa')==='${resized.pref}';`), 'narrow viewport overwrote preference or failed to clamp');
  await execute(`const box=document.querySelector('#input'),shell=document.querySelector('#composer-shell');box.focus();shell.dataset.keyboard='true';shell.style.setProperty('--composer-visible-height','300px');`);
  assert(await execute(`return document.querySelector('#input').getBoundingClientRect().height===64 && localStorage.getItem('lush.composer.height:aaaaaaaaaaaaaaaa')==='${resized.pref}';`), 'soft-keyboard layout overwrote remembered height');
  await setViewport(1440, 900);
  await execute(`document.querySelector('#input').blur();document.querySelector('#composer-resize').focus();`);
  assert(await execute(`return Math.abs(document.querySelector('#input').getBoundingClientRect().height-${resized.height})<2;`), 'viewport restore lost preferred height');
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'resize-keys', actions: [{ type: 'keyDown', value: '\uE013' }, { type: 'keyUp', value: '\uE013' }] }] });
  assert(await execute(`return Number(localStorage.getItem('lush.composer.height:aaaaaaaaaaaaaaaa'))===${Number(resized.pref)+16};`), 'keyboard resizing did not save');
  console.log('PASS actual pointer drag, persisted reload, narrow-screen/soft-keyboard temporary clamp and keyboard resize');
  passed = true;
} catch (error) {
  if (session) console.error('Browser diagnostic:', await execute(`return {url:location.href,ready:window.ready,error:document.querySelector('#error')?.textContent,detail:document.querySelector('#detail')?.textContent?.slice(0,1000)};`).catch(() => null));
  console.error(`Browser check failed; complete geckodriver log: ${log}`); throw error;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true });
}
