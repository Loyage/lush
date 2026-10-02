// Real browser regression with the actual app shell and an in-memory API fixture. No daemon/model calls.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const fixtureScript = `
import { makeWorld } from '/fixture-world.js';
const world=makeWorld();world.state.inputParents=[{id:1,branch:'main',goal:'主干 Task'},{id:800,branch:'feature/old',goal:'不在 overview 中的旧父 Task'}];
const base={created_at:'2026-10-02T00:00:00Z',parent_id:1,branch:'main',integration:'none',merge_status:'none',references:[],content_truncated:false};
window.rows=[{...base,kind:'draft',id:1,content:'尚未实施的想法\\n可以随时编辑',task_id:null,status:'draft',revision:1},
 {...base,kind:'input',id:2,content:'原始输入 <img src=x onerror=alert(1)>\\n'+('多行很长的原始输入内容\\n'.repeat(100)),content_truncated:true,task_id:1,status:'awaiting_acceptance',integration:'merged',merge_status:'merged',revision:null},
 {...base,kind:'input',id:3,content:'',task_id:null,status:'unknown',merge_status:'none',revision:null},
 {...base,kind:'input',id:4,content:'X'.repeat(1000),task_id:1,status:'created',merge_status:'blocked',revision:null}];
window.calls=[];window.delayMutation=false;window.hold=null;
window.fetch=async(url,options={})=>{
 const path=new URL(url,location.href).pathname;const json=data=>({ok:true,json:async()=>structuredClone(data)});
 if(path==='/api/inputs')return json({items:window.rows,next_cursor:null});
 if(path==='/api/input-parents')return json({items:world.state.inputParents});
 const match=/^\\/api\\/input\\/(draft|input)\\/(\\d+)$/.exec(path);
 if(match)return json(window.rows.find(row=>row.kind===match[1]&&row.id===Number(match[2])));
 if(path==='/api/action'){
  const body=JSON.parse(options.body);window.calls.push(body);const p=body.params;
  if(window.delayMutation){window.delayMutation=false;await new Promise(resolve=>{window.hold=resolve;});}
  if(body.method==='draft.add'){const row={...base,...p,kind:'draft',id:Math.max(...window.rows.map(r=>r.id))+1,task_id:null,status:'draft',revision:1};window.rows.unshift(row);return json(row);}
  if(body.method==='draft.update'){const row=window.rows.find(r=>r.kind==='draft'&&r.id===p.id);Object.assign(row,p,{revision:row.revision+1});if(p.branch)row.parent_id=world.state.inputParents.find(t=>t.branch===p.branch).id;return json(row);}
  if(body.method==='draft.remove'){window.rows=window.rows.filter(r=>!(r.kind==='draft'&&r.id===p.id));return json({id:p.id});}
  if(body.method==='say.submit'&&p.draft_id){const row=window.rows.find(r=>r.kind==='draft'&&r.id===p.draft_id);row.kind='input';row.task_id=1;row.status=p.start?'queued':'created';row.revision=null;return json({id:row.id,task:{id:1}});}
 }
 return world.fetchImpl(url,options);
};
await import('/app.js');window.ready=true;
`;
const html = (await Bun.file(join(assets, 'index.html')).text()).replace('<script type="module" src="/app.js"></script>', '<script type="module" src="/fixture.js"></script>');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  if (path === '/fixture.js') return new Response(fixtureScript, { headers: { 'Content-Type': 'text/javascript' } });
  if (path === '/fixture-world.js') return new Response(Bun.file(new URL('../test/web/dom-world.js', import.meta.url)));
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-input-history-ui-')), log = join(temp, 'geckodriver.log');
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
const setTheme = theme => rpc(`/session/${session}/execute/async`, {
  script: `const done=arguments[0];import('/prefs.js').then(({setPref})=>{setPref('theme','${theme}');requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>done(true),250)));});`, args: [],
});
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const waitFor = expression => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0];let n=0;const check=()=>(${expression})?done(true):++n>150?done(false):setTimeout(check,20);check();`, args: [] });
async function click(selector) {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function keys(actions) {
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions }] });
}
const press = value => keys([{ type: 'keyDown', value }, { type: 'keyUp', value }]);
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
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/#inputs` });
  assert(await waitFor('window.ready && document.querySelectorAll(".input-record").length===4'), 'app/history did not load');
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [900, 700], [390, 844]]) {
    await rpc(`/session/${session}/window/rect`, { width, height });
    await setTheme(theme);
    const layout = await execute(`const rows=[...document.querySelectorAll('.input-row')];return {viewport:innerWidth,
      overflow:document.documentElement.scrollWidth>innerWidth+1,
      heights:rows.map(n=>n.getBoundingClientRect().height),
      clipped:rows.some(n=>n.scrollWidth>n.clientWidth+1),
      previewScrollers:rows.some(n=>getComputedStyle(n.querySelector('.input-preview')).overflowY==='auto'),
      buttons:rows.map(n=>n.querySelectorAll('button').length),
      badgesFit:rows.every(n=>[...n.querySelectorAll('.badge')].every(b=>b.getBoundingClientRect().right<=n.getBoundingClientRect().right-8))};`);
    assert(!layout.overflow && !layout.clipped && !layout.previewScrollers && layout.badgesFit, `list overflow ${theme} ${width}: ${JSON.stringify(layout)}`);
    assert(layout.heights.every(h=>Math.abs(h-layout.heights[0])<0.1) && layout.buttons.every(n=>n===0), `rows are not equal-height/native buttons: ${JSON.stringify(layout)}`);
    console.log(`PASS equal-height input rows ${theme} ${layout.viewport}px viewport: ${layout.heights.join('/')}px`);
  }
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  await setTheme('light');
  const listScreenshot = (process.argv[2] || '/tmp/lush-input-history-ui.png').replace(/\.png$/, '-list.png');
  await Bun.write(listScreenshot, Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
  await click('.input-record button');
  assert(await waitFor('document.querySelector(".input-detail textarea")'), 'editor did not load');
  assert(await execute(`return document.querySelector('.inputs-browse').hidden && !document.querySelector('.input-detail-view').hidden && location.hash==='#input-draft-1';`), 'detail did not replace list');
  await rpc(`/session/${session}/back`, {});
  assert(await waitFor('!document.querySelector(".inputs-browse").hidden && location.hash==="#inputs"'), 'browser back did not restore list');
  await click('.input-record button');
  assert(await waitFor('!document.querySelector(".input-detail").hidden'), 'cached editor did not reopen');
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [900, 700], [390, 844]]) {
    await rpc(`/session/${session}/window/rect`, { width, height });
    await setTheme(theme);
    const layout = await execute(`const panel=document.querySelector('.input-detail'),box=panel.querySelector('textarea'),composer=document.querySelector('.composer');
      return {viewport:innerWidth,pageOverflow:document.documentElement.scrollWidth>innerWidth+1,editorWidth:box.getBoundingClientRect().width,
      detailOverflow:panel.scrollWidth>panel.clientWidth+1,composerOverflow:composer.scrollWidth>composer.clientWidth+1,
      controls:[...composer.querySelectorAll('.composer-actions button')].filter(n=>!n.hidden).map(n=>{const r=n.getBoundingClientRect();return {text:n.textContent,width:r.width,x:r.x,right:r.right};})};`);
    assert(!layout.pageOverflow && !layout.detailOverflow && !layout.composerOverflow && layout.editorWidth >= 200, `layout overflow ${theme} ${width}: ${JSON.stringify(layout)}`);
    assert(layout.controls.every(c => c.width >= 20 && c.x >= 0 && c.right <= layout.viewport), `composer controls clipped: ${JSON.stringify(layout)}`);
    console.log(`PASS history/editor/composer layout ${theme} ${layout.viewport}px viewport (window ${width}x${height})`);
  }
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  await execute(`const input=document.querySelector('#input');input.value='键盘暂存';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();`);
  await press('\uE007');
  assert(await waitFor('window.calls.some(c=>c.method==="draft.add") && document.querySelector("#input").value===""'), 'real Enter did not buffer');
  assert(await execute('return window.calls.length===1 && window.calls[0].method==="draft.add"'), 'Enter also submitted say');
  await execute(`const input=document.querySelector('#input');input.value='两行';input.focus();input.setSelectionRange(2,2);`);
  await keys([{ type: 'keyDown', value: '\uE008' }, { type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }, { type: 'keyUp', value: '\uE008' }]);
  assert(await execute(`return document.querySelector('#input').value==='两行\\n' && window.calls.length===1;`), 'Shift+Enter did not insert newline');
  await execute(`window.delayMutation=true;const input=document.querySelector('#input');input.value='慢请求';input.dispatchEvent(new Event('input'));input.focus();`);
  await press('\uE007'); assert(await waitFor('!!window.hold'), 'request was not held'); await press('\uE007');
  assert(await execute(`const input=document.querySelector('#input');input.value='网络期间的新想法';input.dispatchEvent(new Event('input'));window.hold();return window.calls.length===2;`), 'repeated Enter duplicated request');
  assert(await waitFor('!document.querySelector("#input-buffer").disabled'), 'buffer not released');
  assert(await execute(`return document.querySelector('#input').value==='网络期间的新想法';`), 'new text lost');
  await execute(`document.querySelector('.input-detail textarea').value='浏览器里编辑的原文';document.querySelector('.input-detail .agent-call').scrollIntoView({block:'center'});`);
  const help = await execute(`const node=document.querySelector('.input-detail .agent-call');node.focus({preventScroll:true});const tip=document.querySelector('#help-tip');return {focused:document.activeElement===node,visible:!!tip&&!tip.hidden,text:tip?.textContent};`);
  assert(help.focused && help.visible && help.text.includes('token'), `Agent focus help missing: ${JSON.stringify(help)}`);
  await click('.input-detail .agent-call');
  assert(await waitFor('document.querySelector(".input-detail").textContent.includes("已发射并开始")'), 'draft was not fired');
  assert(await execute(`const calls=window.calls.slice(-2);return calls[0].method==='draft.update' && calls[1].method==='say.submit' && calls[1].params.expected_revision===2 && calls[1].params.start===true && !('content' in calls[1].params);`), 'save/fire contract invalid');
  assert(await execute(`return document.querySelectorAll('img').length===0;`), 'unsafe input rendered as markup');
  await execute(`document.querySelector('#input').value='';document.querySelector('#input').dispatchEvent(new Event('input'));`);
  const screenshot = process.argv[2] || '/tmp/lush-input-history-ui.png';
  await Bun.write(screenshot, Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
  console.log(`PASS independent detail/browser back, real keyboard buffering/newline, duplicate/in-flight preservation, Agent help and edit/fire; screenshots: ${listScreenshot}, ${screenshot}`);
  passed = true;
} catch (error) { console.error(`Browser check failed; complete geckodriver log: ${log}`); throw error; }
finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true });
}
