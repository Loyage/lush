// Real Firefox project shell and page modules; local fixture APIs, no daemon/model/SSH.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const projectPath = '/p/aaaaaaaaaaaaaaaa/';
const fixture = `
import { makeWorld } from '/fixture-world.js';
const world=makeWorld(),json=value=>({ok:true,status:200,json:async()=>structuredClone(value)});
window.calls=[]; window.revoked=false;
window.fetch=async(url,options={})=>{
 const parsed=new URL(url,location.href),path=parsed.pathname.replace(/^\\/p\\/[a-f0-9]{16}/,'');
 if(path==='/api/runner/nodes')return json({nodes:[{id:'11111111-1111-4111-8111-111111111111',name:'研发远端长名称节点 · 保留完整的异常与执行环境说明',enabled:true}]});
 if(path==='/api/runner/project')return json({allowed_node_ids:window.revoked?[]:['11111111-1111-4111-8111-111111111111'],default_node_id:'11111111-1111-4111-8111-111111111111'});
 if(path==='/api/input/draft/41')return json({kind:'draft',id:41,mode:'order',revision:1,content:'待提交的远端工作',references:[],parent_id:1,branch:'main',conditions:[],exclusive:false,runner_node_id:'11111111-1111-4111-8111-111111111111'});
 if(path==='/api/inputs')return json({items:[],next_cursor:null});
 if(path==='/api/action')window.calls.push(JSON.parse(options.body));
 if(path.endsWith('/appearance'))return json({id:'aaaaaaaaaaaaaaaa',name:'fixture',appearance:{version:1,color:'blue',revision:'fixture'}});
 return world.fetchImpl(path+parsed.search,options);
};
await import('/app.js');
window.ui=(await import('/state.js')).ui;
window.composer=await import('/composer.js');
window.showSurface=async surface=>{
 document.querySelector('#composer-shell').style.display=surface==='composer'?'':'none';
 if(surface==='draft')await(await import('/render-inputs.js')).openInputs({item:{kind:'draft',id:41}});
 if(surface==='project'){
  const form=(await import('/project-order-form.js')).createProjectOrderForm({id:'aaaaaaaaaaaaaaaa',name:'研发项目',running:true});
  document.querySelector('#detail').replaceChildren(form.root);document.querySelector('#detail').style.display='block';
 }
};
window.ready=true;
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
const temp = await mkdtemp(join(tmpdir(), 'lush-runner-choice-browser-'));
const output = process.argv[2] || '/tmp/lush-runner-choice-layout';
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
  assert(await asyncScript(`for(let i=0;i<200;i++){if(window.ready&&document.querySelector('#composer-runner-choice .runner-input-choice'))return true;await new Promise(r=>setTimeout(r,25));}return false;`), 'app not ready');
  const evidence = [];
  for (const surface of ['composer', 'draft', 'project']) {
    const result = await asyncScript(`await window.showSurface('${surface}');return true;`); assert(result === true, JSON.stringify(result));
    const selector = surface === 'composer' ? '#composer-runner-choice .runner-input-choice' : '#detail .runner-input-choice';
    assert(await execute(`return !!document.querySelector('${selector}');`), `${surface} choice missing`);
    if (surface === 'composer') {
      assert(await execute(`return document.querySelector('${selector}').getClientRects().length===0;`), 'composer environment visible before More');
      await asyncScript(`await document.querySelector('#composer-expand').onclick();return true;`);
    }
    await asyncScript(`const root=document.querySelector('${selector}');await [...root.querySelectorAll('button')].find(n=>n.textContent==='更改执行环境').onclick();return true;`);
    if (surface === 'draft') assert(await execute(`const root=document.querySelector('${selector}'),option=root.querySelector('[data-runner-node="default"]');
      if(option.disabled)return false;option.click();const save=document.querySelector('.input-save');
      const changed=!save.disabled&&root.querySelector('[data-runner-node="default"]').getAttribute('aria-pressed')==='true';
      root.querySelector('[data-runner-node="11111111-1111-4111-8111-111111111111"]').click();return changed&&save.disabled;`), 'draft default reset/undo is not editable');
    for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
      await viewport(width);
      const layout = await execute(`document.documentElement.dataset.theme='${theme}';
        const root=document.querySelector('${selector}');root.scrollIntoView({block:'center'});
        const bounds=root.getBoundingClientRect(), choices=[...root.querySelectorAll('.runner-choice-option')];
        return {surface:'${surface}',theme:'${theme}',width:innerWidth,scroll:document.documentElement.scrollWidth,display:getComputedStyle(root).display,
          fits:bounds.left>=0&&bounds.right<=innerWidth+1&&root.scrollWidth<=root.clientWidth+1,
          controls:choices.map(n=>({height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width,whiteSpace:getComputedStyle(n).whiteSpace})),
          optionWidth:root.querySelector('.runner-choice-list').getBoundingClientRect().width,
          summary:root.querySelector('.runner-choice-summary').textContent};`);
      assert(layout.width === width && layout.fits && layout.scroll <= width + 1 && layout.display === 'block', `overflow ${JSON.stringify(layout)}`);
      if (width <= 390) assert(layout.controls.every(c => c.height >= 44 && Math.abs(c.width - layout.optionWidth) < 2 && c.whiteSpace === 'normal'), `small/clipped options ${JSON.stringify(layout)}`);
      evidence.push(layout);
      await Bun.write(`${output}-${surface}-${theme}-${width}.png`, Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
      console.log(`PASS ${surface}/${theme}/${width}: complete wrapping options, no horizontal overflow`);
    }
    await asyncScript(`window.revoked=true;const root=document.querySelector('${selector}');await [...root.querySelectorAll('button')].find(n=>n.textContent==='刷新配置预览').onclick();await [...root.querySelectorAll('button')].find(n=>n.textContent==='更改执行环境').onclick();return true;`);
    assert(await execute(`const root=document.querySelector('${selector}'),diagnostic=root.querySelector('.runner-choice-diagnostic');return !diagnostic.hidden&&diagnostic.textContent.includes('授权已撤销')&&root.querySelector('.runner-choice-options').hidden;`), `${surface} collapsed revocation missing`);
    await execute('window.revoked=false;');
  }
  assert(await execute(`return !window.calls.some(c=>c.method==='runner.nodes.check');`), 'reading connected remote');
  await Bun.write(`${output}.json`, JSON.stringify(evidence, null, 2)); passed = true;
} finally {
  if (session) try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {}
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true }); else console.error(`driver log: ${temp}/driver.log`);
}
