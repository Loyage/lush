// Actual project app + Firefox, fixture APIs only: no daemon, Git writes or model calls.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
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
const worldSource = (await Bun.file(new URL('../test/web/dom-world.js', import.meta.url)).text()).replace('../../src/ui/web/assets/prefs.js', '/prefs.js');
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
    const frame=getComputedStyle(form),icon=getComputedStyle(document.querySelector('#composer-mode-icon'));
    const target=document.querySelector('#composer-mode-target'),targetStyle=getComputedStyle(target);
    const r=band.getBoundingClientRect(),fr=form.getBoundingClientRect(),tr=target.getBoundingClientRect();
    return {mode:form.dataset.mode,viewport:innerWidth,title:document.querySelector('#composer-mode-title').textContent,target:target.textContent,
      behavior:document.querySelector('#composer-mode-behavior').textContent,frameStyle:frame.borderTopStyle,rail:frame.borderInlineStartWidth,
      iconStyle:icon.borderTopStyle,targetWeight:targetStyle.fontWeight,targetOwnRow:tr.top>=document.querySelector('#composer-mode-title').getBoundingClientRect().bottom,
      fits:r.width>0 && r.top>=0 && r.bottom<=innerHeight && fr.left>=0 && fr.right<=innerWidth && form.scrollWidth<=form.clientWidth+1
        && document.documentElement.scrollWidth<=innerWidth+1 && [...band.children].every(n=>{const cr=n.getBoundingClientRect();return cr.left>=r.left && cr.right<=r.right+1 && cr.bottom<=r.bottom+1;}),
      described:box.getAttribute('aria-describedby').includes('composer-mode-target'),
      signature:[frame.borderTopColor,frame.backgroundColor,icon.color,icon.backgroundColor,targetStyle.color,targetStyle.backgroundColor,getComputedStyle(box).outlineColor].join('|')};`);
  assert(layout.mode === mode && layout.fits && layout.described, `clipped/inaccessible ${theme}/${color}/${mode}/${focused}: ${JSON.stringify(layout)}`);
  assert(mode === 'create' ? layout.frameStyle === 'dashed' && layout.iconStyle === 'dashed' && layout.title === '新建独立 Worker' && layout.target.includes('父 Worker') && layout.behavior.includes('Enter 暂存')
    : layout.frameStyle === 'solid' && layout.rail === '4px' && layout.iconStyle === 'solid' && Number(layout.targetWeight) >= 700 && layout.targetOwnRow
      && layout.title === '继续当前 Worker' && layout.target.includes('W179') && layout.behavior.includes('不创建新 Worker'), `wrong structure/target: ${JSON.stringify(layout)}`);
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
  await execute(`const entry=[...document.querySelectorAll('.task-actions button')].find(n=>n.textContent==='向该 Worker 追加输入');if(!entry)throw Error('append entry missing');entry.id='fixture-append';`);
  await click('#fixture-append');
  assert(await waitFor('document.querySelector("#input-form").dataset.mode==="append"'), 'explicit entry did not select Worker');
  for (const mode of ['append', 'create']) {
    if (mode === 'create') {
      // Settle the existing focus-height collapse before WebDriver computes a click coordinate.
      await execute(`document.querySelector('#input').blur();`);
      await click('#composer-reset');
      assert(await waitFor('document.querySelector("#input-form").dataset.mode==="create"'), 'reset button did not restore creation');
    }
    for (const theme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [900, 700], [390, 844]]) {
      await setViewport(width, height);
      let viewport;
      for (const focused of [false, true]) {
        let signature;
        for (const color of ['green', 'blue', 'teal', 'amber', 'rose', 'slate']) {
          const layout = await checkLayout(mode, theme, color, focused); viewport = layout.viewport;
          signature ??= layout.signature;
          assert(layout.signature === signature, `project palette changed ${mode} identity: ${theme}/${color}: ${signature} -> ${layout.signature}`);
        }
      }
      if (width === 390 || width === 1440) await Bun.write(`${output}-${mode}-${theme}-${width}.png`, Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
      console.log(`PASS ${mode} ${theme} ${viewport}px: six palettes, focused/unfocused, persistent target and frame`);
    }
  }
  await setViewport(390, 844);
  const checks = await execute(`const original=window.ui.composerTask,results=[];const title='很长的追加目标标题'.repeat(20)+' <img src=x onerror=alert(1)>';
    for(const change of [{},{freeze:{reason:'固定交付'},input_queue:{buffered:2,reason:'等待交付结束'}},{status:'completed'}]){
      window.ui.composerTask={...original,worker_number:'W179-1',display_title:title,...change};window.composer.appendToWorker(window.ui.composerTask);
      const target=document.querySelector('#composer-mode-target'),form=document.querySelector('#input-form'),r=target.getBoundingClientRect();
      results.push({mode:form.dataset.mode,target:target.textContent,disabled:document.querySelector('#input').disabled,behavior:document.querySelector('#composer-mode-behavior').textContent,
        fits:target.scrollWidth<=target.clientWidth+1 && r.left>=0 && r.right<=innerWidth,unsafe:target.querySelectorAll('img').length});
    }window.ui.composerTask=original;window.composer.syncComposer();return results;`);
  assert(checks.every(row => row.mode === 'append' && row.target.includes('W179-1') && row.target.includes('<img') && row.fits && !row.unsafe)
    && !checks[1].disabled && checks[1].behavior.includes('已暂存 2 条') && checks[2].disabled, `long/frozen/blocked target lost: ${JSON.stringify(checks)}`);
  console.log('PASS long numbered/text-safe targets, frozen wait reason and blocked target retention');
  await setViewport(1440, 900);
  await execute(`const box=document.querySelector('#input');box.value='确认追加给目标';box.dispatchEvent(new Event('input'));box.focus();`);
  await enter();
  assert(await waitFor('window.calls.some(c=>c.method==="worker.message" && c.params.id===1 && c.params.body==="确认追加给目标") && !window.ui.composerSubmitting'), 'Enter routed append incorrectly');
  await click('#composer-reset');
  await execute(`const box=document.querySelector('#input');box.value='新建模式只暂存';box.dispatchEvent(new Event('input'));box.focus();`);
  await enter();
  assert(await waitFor('window.calls.some(c=>c.method==="draft.add" && c.params.content==="新建模式只暂存") && !window.ui.composerSubmitting'), 'Enter did not buffer in create mode');
  assert(await execute(`return !window.calls.some(c=>c.method==='order.submit');`), 'mode reset unexpectedly created Worker');
  await execute(`window.composer.appendToWorker(window.ui.composerTask);location.hash='#workers';`);
  assert(await waitFor('document.querySelector("#input-form").dataset.mode==="create"'), 'navigation retained stale append destination');
  console.log(`PASS Enter routes to selected inbox / draft buffer; reset and navigation restore creation. Screenshots: ${output}-*.png`);
  passed = true;
} catch (error) {
  if (session) console.error('Browser diagnostic:', await execute(`return {url:location.href,ready:window.ready,error:document.querySelector('#error')?.textContent,detail:document.querySelector('#detail')?.textContent?.slice(0,1000)};`).catch(() => null));
  console.error(`Browser check failed; complete geckodriver log: ${log}`); throw error;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true });
}
