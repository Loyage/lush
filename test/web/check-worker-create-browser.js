// bun run test/web/check-worker-create-browser.js — isolated real app-shell fixture, never a user daemon.
import { join } from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const evidence = '/tmp/w337-2-browser'; await mkdir(evidence, { recursive: true });
const script = `<script type="module">
import {openWorkerCreate} from '/worker-create-form.js';
import {createEmissionConditions} from '/emission-form.js';
import {workerCreateControl} from '/worker-create.js';
import {initComposer} from '/composer.js';
import {ui} from '/state.js';
import {registerNavigation} from '/navigate.js';
import {loadDetail} from '/detail.js';
import {renderTaskGraph} from '/render-task-graph.js';
import {renderTree} from '/render-tree.js';
import {activateDetailView} from '/sidebar-ui.js';
const source={id:208,worker_number:'W735-2',parent_id:19,parent_worker_number:'W735',role:'agent',task_kind:'order',status:'waiting',branch:'lush/source',target_branch:'lush/parent',base_commit:'a'.repeat(40),goal:'来源标题及工作上下文'.repeat(15),calls:1,agent_wakes:1,children:[],deps:[],dependents:[],notices:[],integration:'none'};
const directChild={...source,id:209,worker_number:'W736',parent_id:208,parent_worker_number:source.worker_number,goal:'已有直接子 Worker'};
let id=301;const tasks=new Map([[208,source],[209,directChild]]);window.calls=[];
window.fetch=async(url,options={})=>{const path=new URL(url,location.href).pathname;
if(path==='/api/worker-lookup')return Response.json({id:208,worker_number:'W735-2'});
if(path==='/api/input-parents')return Response.json({items:[{id:1,branch:'main',worker_number:'W1'},{id:19,branch:'lush/parent',worker_number:'W735',goal:'交付父'}]});
if(path==='/api/agent/config')return Response.json({default:{agent:'pi',config_mode:'lush',model:'fixture/model'},options:{agents:['pi','codex']}});
if(path.endsWith('/run-settings'))return Response.json({profile:{agent:'pi',config_mode:'lush',model:'fixture/model',append_prompt:'来源专属参数',env:{LONG_VARIABLE:'value'.repeat(50)}},explicit:true});
if(path==='/api/agent/packages')return Response.json({version:1,packages:[],resources:{}});
if(path==='/api/agent/connections')return Response.json({connections:[]});
if(path==='/api/action'){const call=JSON.parse(options.body);window.calls.push(call);
if(call.method==='worker.create'){const fork=call.params.mode==='fork';const task={...source,id:id++,worker_number:'W999-'+id,parent_id:call.params.parent||(fork?19:1),parent_worker_number:call.params.parent===208?source.worker_number:fork?'W735':'W1',status:'paused',goal:'',input_id:null,calls:0,agent_wakes:0,display_title:call.params.title||'空白 Worker',creation:{mode:call.params.mode,source_id:fork?call.params.source:null,source_worker_number:fork?(call.params.source===209?directChild.worker_number:source.worker_number):null,commit:'b'.repeat(40),session_inherited:fork,warning:null,waiting_first_input:true}};tasks.set(task.id,task);return Response.json({task});}
if(call.method==='input.emit')return Response.json({emitted:true,draft_id:40,dispatch:{state:'queued'}});}
const match=/^\\/api\\/worker\\/(\\d+)$/.exec(path);if(match){if(Number(match[1])===208&&window.holdSource)await new Promise(resolve=>window.releaseSource=resolve);return Response.json(tasks.get(Number(match[1])));}
if(path.endsWith('/history-page'))return Response.json({events:[],has_more:false,cursor:null});
if(path.endsWith('/relations'))return Response.json({children:{items:path.includes('/208/')?[directChild]:[],has_more:false,cursor:209},deps:[],dependents:[]});
return Response.json({});};
registerNavigation({detail:loadDetail,refresh:async()=>{}});ui.view={id:'overview'};
await initComposer();
window.create=fork=>{void openWorkerCreate({source:fork?source:null});};
window.createChild=()=>{void openWorkerCreate({parent:source});};
window.page=()=>activateDetailView({view:'overview'});
window.graph=()=>{ui.view={id:'task-graph'};ui.taskGraphMinimal=true;renderTaskGraph({nodes:[source],edges:[],total:1});};
window.list=()=>{renderTree({tasks:[source],notices:[]});};
window.quiet=()=>{window.page();document.querySelector('#detail').replaceChildren(createEmissionConditions({mode:'append',conditions:[{kind:'parent_quiet'}]}).node);};
window.ready=true;
</script>`;
const html = (await Bun.file(join(assets, 'index.html')).text()).replace(/<script[^>]*src="\/(?:app|appearance)\.js"[^>]*><\/script>/g, '').replace('</body>', script + '</body>');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/') return new Response('<html><body style="margin:0"><iframe id="viewport" src="/fixture" style="width:390px;height:844px;border:0"></iframe></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (path === '/fixture') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  if (path === '/administrator/project-protocol.js') return new Response(Bun.file(new URL('../../src/administrator/project-protocol.js', import.meta.url)));
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }); const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-worker-create-browser-'));
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1', TMPDIR: temp }, stdout: Bun.file(join(evidence, 'geckodriver.log')), stderr: Bun.file(join(evidence, 'geckodriver.log')) });
let session;
async function rpc(path, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    }); req.on('error', reject); req.setTimeout(60000, () => req.destroy(Error('WebDriver timeout'))); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = expression => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0];let n=0;const check=()=>(${expression})?done(true):++n>100?done(false):setTimeout(check,20);check();`, args: [] });
function assert(value, message) { if (!value) throw Error(message); }
async function click(selector) { const e = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector }); await rpc(`/session/${session}/element/${e['element-6066-11e4-a52e-4f735466cecf']}/click`, {}); }
async function keys(values) { await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: values.flatMap(value => [{ type: 'keyDown', value }, { type: 'keyUp', value }]) }] }); }
async function resize(width, height) {
  await rpc(`/session/${session}/frame`, { id: null }); await execute(`const f=document.querySelector('#viewport');f.style.width='${width}px';f.style.height='${height}px';`);
  const frame = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: frame });
}
try {
  let ready = false; for (let i = 0; i < 100; i++) { try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {} if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100); } assert(ready, 'driver startup timeout');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1100 }); await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  await resize(390, 844); assert(await wait('window.ready'), 'fixture load failed');
  await execute('window.list();window.graph();');
  assert(await execute(`return ![...document.querySelectorAll('#detail button')].some(b=>b.textContent==='空白创建')&&[...document.querySelectorAll('#side-tasks button')].some(b=>b.textContent==='空白创建');`), 'graph must stay compact while the Worker list retains the creation entry');
  await click('.task-graph-more-trigger'); assert(await execute(`return [...document.querySelectorAll('.task-graph-actions-popover button')].some(b=>b.textContent==='创建子 Worker'&&!b.classList.contains('agent-call'))&&!document.querySelector('.task-graph-actions-popover').textContent.includes('复制创建');`), 'missing unique non-Agent child action');
  await keys(['\uE00C']);
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await resize(width, 900); await execute(`window.page();document.documentElement.dataset.theme='${theme}';window.create(false);`);
    assert(await wait(`!document.querySelector('#modal').hidden`), 'spawn dialog did not open');
    assert(await execute(`const p=document.querySelector('[data-create-field=parent]');const r=p.getBoundingClientRect();return document.querySelector('[data-create-field=mode]').value==='spawn'&&r.height===32&&r.left>=0&&r.right<=innerWidth&&document.querySelector('.worker-create-modal').scrollWidth<=document.querySelector('.worker-create-modal').clientWidth+1;`), `spawn parent/layout ${theme}/${width}`);
    await execute(`window.holdSource=true;const mode=document.querySelector('[data-create-field=mode]');mode.value='fork';mode.dispatchEvent(new Event('change'));document.querySelector('.worker-create-modal .emission-worker-picker input').value='W735-2';`);
    await click('.worker-create-modal .emission-worker-picker .emission-picker-row:nth-child(2) button');
    assert(await wait(`window.releaseSource&&document.querySelector('.worker-create-parent').dataset.sourceState==='loading'`), 'W lookup did not request source detail');
    assert(await execute(`return document.querySelector('.modal-confirm').disabled&&document.querySelector('.worker-create-parent').textContent.includes('核验交付父')&&!document.querySelector('.worker-create-parent').textContent.includes('#undefined');`), 'unverified W lookup enabled creation or guessed its parent');
    await execute('window.holdSource=false;window.releaseSource();window.releaseSource=null;');
    assert(await wait(`document.querySelector('.worker-create-parent').dataset.sourceState==='ready'&&!document.querySelector('.modal-confirm').disabled`), 'verified parent did not unlock creation');
    assert(await execute(`return document.querySelector('.worker-create-parent').textContent.includes('交付父：W735')&&document.querySelector('[data-create-field=source]').selectedOptions[0].textContent.includes('来源标题')&&document.querySelector('.worker-create-modal').scrollWidth<=document.querySelector('.worker-create-modal').clientWidth+1;`), `W lookup parent/layout ${theme}/${width}`);
    await Bun.write(join(evidence, `${theme}-${width}-lookup.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
    await keys(['\uE00C']); await execute('window.create(true);');
    assert(await wait(`!document.querySelector('#modal').hidden&&document.querySelector('.worker-create-parent').dataset.sourceState==='ready'`), 'creation dialog source did not load');
    assert(await execute(`return document.querySelector('[data-create-field=mode]').value==='fork'&&!document.querySelector('.worker-create-advanced').open&&document.querySelector('.worker-create-parent').textContent.includes('W735')&&!document.querySelector('.modal-confirm').classList.contains('agent-call')&&window.calls.filter(c=>c.method==='worker.create').length===${(theme === 'light' ? 0 : 3) + [1440,390,320].indexOf(width)};`), `default source/layout/unauthorized creation ${theme}/${width}`);
    const fits = await execute(`const card=document.querySelector('.worker-create-modal');const controls=[...card.querySelectorAll('button,select,input:not([type=checkbox]),summary')].filter(n=>n.getClientRects().length);return {overflow:card.scrollWidth-card.clientWidth,page:document.documentElement.scrollWidth-innerWidth,bad:controls.filter(n=>{const r=n.getBoundingClientRect();return r.width<1||r.left<0||r.right>innerWidth+1||r.height<(innerWidth<=760&&n.matches('.modal-confirm,.agent-call,.control-primary')?44:32)}).map(n=>[n.textContent,n.getBoundingClientRect().toJSON()])};`);
    if (width <= 760) assert(await execute(`return document.querySelector('.worker-create-advanced>summary').getBoundingClientRect().height===32&&document.querySelector('.modal-confirm').getBoundingClientRect().height===44&&document.querySelector('.modal-cancel').getBoundingClientRect().height===32;`), 'ordinary disclosure/cancel must actually shrink, final confirmation stays 44px');
    assert(fits.overflow <= 1 && fits.page <= 1 && fits.bad.length === 0, `clipped/small controls ${theme}/${width}: ${JSON.stringify(fits)}`);
    assert(await execute(`return document.activeElement===document.querySelector('[data-create-field=mode]')&&document.querySelector('.modal-title').getBoundingClientRect().top>=document.querySelector('.worker-create-modal').getBoundingClientRect().top;`), 'default focus scrolled past the main creation fields');
    // Native keyboard focus stays in DOM order, includes advanced disclosure and skips hidden controls.
    await keys(['\uE004']); assert(await execute(`return document.activeElement===document.querySelector('[data-create-field=source]');`), 'Tab escaped dialog or skipped source');
    for(let i=0;i<12;i++) { if(await execute(`return document.activeElement===document.querySelector('.worker-create-advanced>summary');`)) break; await keys(['\uE004']); }
    assert(await execute(`return document.activeElement===document.querySelector('.worker-create-advanced>summary');`), 'advanced disclosure is not keyboard reachable');
    await execute(`document.querySelector('[data-create-field=mode]').focus();document.querySelector('.worker-create-modal').scrollTop=0;`);
    await Bun.write(join(evidence, `${theme}-${width}-create.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
    await click('.worker-create-advanced>summary'); await click('[data-create-field=override]');
    assert(await wait(`document.querySelector('[data-retry-field="model"]')`), 'inline profile did not load');
    assert(await execute(`return document.querySelectorAll('[role=dialog]').length===1&&document.querySelector('[data-retry-field="model"]').value==='fixture/model'&&document.querySelector('.worker-create-modal').scrollWidth<=document.querySelector('.worker-create-modal').clientWidth+1;`), `nested dialog or advanced overflow ${theme}/${width}`);
    await execute(`const checkbox=document.querySelector('[data-create-field=override]');checkbox.checked=false;checkbox.dispatchEvent(new Event('change'));document.querySelector('.worker-create-advanced').open=false;document.querySelector('.worker-create-modal').scrollTop=0;`);
    await click('.modal-confirm');
    assert(await wait(`document.querySelector('.worker-first-input')&&document.querySelector('#modal').hidden`), 'creation did not navigate to waiting detail');
    assert(await execute(`const actions=[...document.querySelectorAll('.task-actions button')];return !actions.some(b=>['开始','继续','检查后重试'].includes(b.textContent))&&actions.some(b=>b.textContent==='输入工作指令'&&!b.classList.contains('agent-call'))&&document.querySelector('.worker-creation-facts').textContent.includes('已继承');`), 'waiting facts or action guards wrong');
    await execute(`[...document.querySelectorAll('.task-actions button')].find(b=>b.textContent==='输入工作指令').click();`);
    assert(await wait(`!document.querySelector('#input-form').hidden`), 'instruction entry failed');
    assert(await execute(`return document.querySelector('#composer-mode-title').textContent==='输入工作指令'&&!document.querySelector('#composer-target-status').textContent.includes('需开始')&&document.querySelector('#draft-commit').classList.contains('agent-call')&&document.documentElement.scrollWidth<=innerWidth;`), `first-input composer mismatch ${theme}/${width}`);
    await execute(`document.querySelector('#composer-launcher').click();window.quiet();[...document.querySelectorAll('#detail button')].find(b=>b.textContent==='展开高级设置：静息等待').click();`);
    assert(await execute(`const hint=document.querySelector('.emission-quiet-limit');return hint.getClientRects().length>0&&hint.textContent.includes('空 Worker 或暂停 Worker')&&hint.textContent.includes('需取消静息条件提交')&&document.documentElement.scrollWidth<=innerWidth&&hint.getBoundingClientRect().right<=innerWidth+1;`), `quiet limitation missing/clipped ${theme}/${width}`);
    await Bun.write(join(evidence, `${theme}-${width}-quiet.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
    console.log(`PASS ${theme} ${width}px: minimal W lookup -> loading gate -> verified parent, quiet limitation, permanent entries, collapsed/inline settings, 32px ordinary/44px mobile confirmation controls, Tab, waiting detail, first-input editor, no overflow`);
  }
  await execute('window.page();window.create(false);'); await keys(['\uE00C']);
  assert(await execute(`return document.querySelector('#modal').hidden&&window.calls.filter(c=>c.method==='worker.create').length===6;`), 'keyboard cancellation created a Worker');
  console.log(`PASS Escape cancellation; screenshots and driver log: ${evidence}`);
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await resize(width, 900); await execute(`window.page();document.documentElement.dataset.theme='${theme}';window.createChild();`);
    assert(await wait(`!document.querySelector('#modal').hidden`), 'child dialog did not open');
    assert(await execute(`return document.querySelector('.modal-title').textContent==='创建子 Worker'&&document.querySelector('[data-create-field=mode]').value==='spawn'&&document.querySelector('.worker-create-parent').textContent.includes('W735-2')&&!document.querySelector('.worker-child-source').getClientRects().length&&!document.querySelector('#modal .emission-worker-picker')&&!document.querySelector('.modal-confirm').classList.contains('agent-call');`), 'child default/parent/source scope incorrect');
    await execute(`const mode=document.querySelector('[data-create-field=mode]');mode.value='fork';mode.dispatchEvent(new Event('change'));`);
    assert(await wait(`document.querySelector('.worker-create-parent').dataset.sourceState==='ready'`), 'self source not verified');
    assert(await execute(`return document.querySelector('[data-create-field=source]').value==='208'&&document.querySelector('[data-create-field=source]').selectedOptions[0].textContent.includes('当前 Worker（默认）');`), 'copy did not default to current Worker');
    await execute(`[...document.querySelectorAll('.worker-child-source button')].find(b=>b.textContent==='加载直接子 Worker').click();`);
    assert(await wait(`document.querySelector('[data-create-field=source]').options.length===2`), 'direct child did not load');
    await execute(`const source=document.querySelector('[data-create-field=source]');source.value='209';source.dispatchEvent(new Event('change'));`);
    assert(await wait(`document.querySelector('.worker-create-parent').dataset.sourceState==='ready'`), 'direct child source not verified');
    assert(await execute(`const card=document.querySelector('.worker-create-modal');return document.querySelector('.worker-create-parent').textContent.includes('父 Worker：W735-2')&&card.scrollWidth<=card.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth;`), 'child parent drift or narrow overflow');
    await Bun.write(join(evidence, theme+'-'+width+'-child.png'), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
    await click('.modal-confirm'); assert(await wait(`document.querySelector('.worker-first-input')&&document.querySelector('#modal').hidden`), 'child creation did not navigate');
    assert(await execute(`const call=window.calls.filter(c=>c.method==='worker.create').at(-1);const text=document.querySelector('.worker-creation-facts').textContent;return call.params.parent===208&&call.params.source===209&&text.includes('W735-2')&&![...document.querySelectorAll('.task-actions button')].some(b=>['空白创建','复制创建'].includes(b.textContent));`), 'actual child request/unique detail entry wrong');
    console.log('PASS '+theme+' '+width+'px: child default spawn, fixed parent, self-copy default, direct child sources, no project lookup/overflow');
  }
} catch (error) {
  if (session) { try { await Bun.write(join(evidence, 'failure.png'), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64')); } catch {} }
  throw error;
} finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  driver.kill(); await driver.exited; server.stop(true); await rm(temp, { recursive: true, force: true });
}
