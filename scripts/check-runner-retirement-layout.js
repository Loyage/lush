// Real Firefox project shell with controlled APIs: no daemon, paid model or remote machine.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const projectPath = '/p/aaaaaaaaaaaaaaaa/';
const fixture = `
import { makeWorld } from '/fixture-world.js';
const world=makeWorld(),json=value=>({ok:true,status:200,json:async()=>structuredClone(value)});
window.calls=[];
window.fetch=async(url,options={})=>{
 const parsed=new URL(url,location.href),path=parsed.pathname.replace(/^\\/p\\/[a-f0-9]{16}/,'');
 window.calls.push({path,body:options.body});
 if(path.includes('/runner/'))throw Error('Retired Runner API called');
 if(path==='/api/input/draft/41')return json({kind:'draft',id:41,mode:'order',revision:1,content:'保留草稿正文',references:[],parent_id:1,branch:'main',conditions:[],exclusive:false,runner_node_id:'retired-node'});
 if(path==='/api/inputs')return json({items:[],next_cursor:null});
 if(path.endsWith('/appearance'))return json({id:'aaaaaaaaaaaaaaaa',name:'fixture',appearance:{version:1,color:'blue',revision:'fixture'}});
 return world.fetchImpl(path+parsed.search,options);
};
await import('/app.js');
const {ui}=await import('/state.js');window.ui=ui;
window.showSurface=async surface=>{
 document.querySelector('#composer-shell').style.display=surface==='composer'?'':'none';
 if(surface==='draft')await(await import('/render-inputs.js')).openInputs({item:{kind:'draft',id:41}});
 if(surface==='project'){
  const form=(await import('/project-order-form.js')).createProjectOrderForm({id:'aaaaaaaaaaaaaaaa',name:'本机项目',running:true});
  document.querySelector('#detail').replaceChildren(form.root);document.querySelector('#detail').style.display='block';
 }
 if(surface==='retired'){
  const at='2026-10-17T12:00:00Z';
  ui.view={id:'task',key:'task-7'};
  (await import('/render-detail.js')).renderDetail({id:7,worker_number:'W232',role:'agent',task_kind:'order',status:'paused',calls:0,
   goal:'保留历史远端工作记录，不迁移、不回收、不连接远端机器',execution_retired:true,branch:'lush/history',target_branch:'main',workspace:'/retired/workspace',
   base_commit:'a'.repeat(40),head_commit:'b'.repeat(40),created_at:at,updated_at:at,deps:[],dependents:[],children:[]},
   {events:[{id:1,type:'invocation.completed',created_at:at,data:{run_id:1,result:'保留的历史结果'}}]},null,null);
 }
};window.ready=true;
`;
const world = (await Bun.file(new URL('../test/web/dom-world.js', import.meta.url)).text()).replace('../../src/ui/web/assets/prefs.js', '/prefs.js');
const html = (await Bun.file(join(assets, 'index.html')).text()).replace('<script type="module" src="/app.js"></script>', '<script type="module" src="/fixture.js"></script>');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === projectPath) return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  if (path === '/frame') return new Response(`<iframe id="viewport" style="border:0" width="1440" height="900" src="${projectPath}"></iframe>`, { headers: { 'Content-Type': 'text/html' } });
  if (path === '/fixture.js') return new Response(fixture, { headers: { 'Content-Type': 'text/javascript' } });
  if (path === '/fixture-world.js') return new Response(world, { headers: { 'Content-Type': 'text/javascript' } });
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-runner-retirement-browser-'));
const output = process.argv[2] || '/tmp/lush-runner-retirement-layout';
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(join(temp, 'driver.log')), stderr: Bun.file(join(temp, 'driver.log')),
});
let session, passed = false;
async function rpc(path, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; });
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(20000, () => req.destroy(new Error('WebDriver request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const asyncScript = script => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0];(async()=>{${script}})().then(done,e=>done({error:e.message}));`, args: [] });
const assert = (value, message) => { if (!value) throw Error(message); };
async function viewport(width) {
  await rpc(`/session/${session}/frame`, { id: null });
  await rpc(`/session/${session}/window/rect`, { width: Math.max(width, 600), height: 1100 });
  await execute(`const frame=document.querySelector('#viewport');frame.width=${width};frame.height=900;`);
  const frame = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' });
  await rpc(`/session/${session}/frame`, { id: frame });
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw Error('geckodriver exited');
    await Bun.sleep(100);
  }
  assert(ready, 'driver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/timeouts`, { script: 20000 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/frame` });
  await viewport(1440);
  assert(await asyncScript(`for(let i=0;i<200;i++){if(window.ready)return true;await new Promise(r=>setTimeout(r,25));}return false;`) === true, 'app not ready');
  const evidence = [];
  for (const surface of ['composer', 'draft', 'project', 'retired']) {
    assert(await asyncScript(`await window.showSurface('${surface}');return true;`) === true, `${surface} failed`);
    if (surface === 'composer') await asyncScript(`await document.querySelector('#composer-expand').onclick();return true;`);
    for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
      await viewport(width);
      const layout = await execute(`document.documentElement.dataset.theme='${theme}';
        const root=document.querySelector('${surface === 'composer' ? '#composer-shell' : '#detail'}');root.scrollIntoView({block:'start'});
        const bounds=root.getBoundingClientRect(),notice=root.querySelector('.execution-retired');
        return {surface:'${surface}',theme:'${theme}',width:innerWidth,scroll:document.documentElement.scrollWidth,
         fits:bounds.left>=-1&&bounds.right<=innerWidth+1&&root.scrollWidth<=root.clientWidth+1,
         runnerControls:document.querySelectorAll('.runner-input-choice,.worker-runner,#runners-open').length,
         notice:notice?.textContent,noticeVisible:notice?notice.getClientRects().length>0:null,
         history:root.textContent.includes('保留的历史结果'),code:!!root.querySelector('.code-reader-open'),
         actions:[...root.querySelectorAll('.task-actions button')].map(n=>n.textContent)};`);
      assert(layout.width === width && layout.fits && layout.scroll <= width + 1, `overflow ${JSON.stringify(layout)}`);
      assert(layout.runnerControls === 0, `retired UI remains ${JSON.stringify(layout)}`);
      if (surface === 'retired') assert(layout.noticeVisible && layout.notice.includes('不再续跑、迁移或回收') && layout.history && layout.code
        && JSON.stringify(layout.actions) === JSON.stringify(['刷新详情']), `unsafe retired detail ${JSON.stringify(layout)}`);
      evidence.push(layout);
      await Bun.write(`${output}-${surface}-${theme}-${width}.png`, Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
      console.log(`PASS ${surface}/${theme}/${width}: no Runner UI, no overflow${surface === 'retired' ? ', history readable without mutation controls' : ''}`);
    }
  }
  for (const hash of ['#runners', '#settings-runners', '#runners-project-aaaaaaaaaaaaaaaa']) {
    assert(await asyncScript(`location.hash='${hash}';for(let i=0;i<100;i++){if(document.querySelector('#detail').dataset.view==='retired-execution')return document.querySelector('#detail').textContent.includes('执行节点已移除');await new Promise(r=>setTimeout(r,25));}return false;`) === true, `unsafe bookmark ${hash}`);
  }
  assert(await execute(`return !window.calls.some(c=>c.path.includes('/runner/')||(c.body&&JSON.parse(c.body).method?.startsWith('runner.')));`), 'Runner request made');
  await Bun.write(`${output}.json`, JSON.stringify(evidence, null, 2)); passed = true;
} finally {
  if (session) try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {}
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true }); else console.error(`driver log: ${temp}/driver.log`);
}
