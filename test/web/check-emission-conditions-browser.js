// Real Firefox/iframe + actual app modules, isolated API fixture; no user service or model.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-emission-conditions-'));
const script = `
import { makeWorld } from '/fixture-world.js';
const world=makeWorld();const json=data=>({ok:true,json:async()=>structuredClone(data)});
window.calls=[];
window.draft={kind:'draft',id:1,mode:'order',status:'draft',revision:1,parent_id:1,branch:'main',content:'条件界面浏览器验证',references:[],conditions:[
 {kind:'worker_merged',worker_id:21,worker_number:'W123'},
 {kind:'worker_settled',worker_id:22,worker_number:'W123'+('-123456789'.repeat(18))},
 {kind:'parent_quiet'}],exclusive:true,created_at:'2026-10-14T00:00:00Z'};
window.fetch=async(url,options={})=>{const u=new URL(url,location.href),p=u.pathname.replace('/p/aaaaaaaaaaaaaaaa','');
 if(p==='/api/inputs')return json({items:[window.draft],next_cursor:null});
 if(p==='/api/input/draft/1')return json(window.draft);
 if(p==='/api/input-parents')return json({items:[{id:1,worker_number:'W1',branch:'main',goal:'main'}]});
 if(p==='/api/workers')return json({tasks:[{id:23,worker_number:'W23',goal:'超长标题'.repeat(60)}],has_more:false});
 if(p==='/api/action'){const b=JSON.parse(options.body);window.calls.push(b);if(b.method==='draft.update'){Object.assign(window.draft,b.params,{revision:window.draft.revision+1});return json(window.draft);}}
 return world.fetchImpl(p+u.search,options);};
await import('/app.js');window.ready=true;
`;
const html = (await Bun.file(path.join(assets, 'index.html')).text()).replace('<script type="module" src="/app.js"></script>', '<script type="module" src="/fixture.js"></script>');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const p = new URL(req.url).pathname;
  if (p === '/') return new Response('<html><body style="margin:0"><iframe id="viewport" style="width:1440px;height:950px;border:0" src="/p/aaaaaaaaaaaaaaaa/#input-draft-1"></iframe></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (p === '/p/aaaaaaaaaaaaaaaa/') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  if (p === '/fixture.js') return new Response(script, { headers: { 'Content-Type': 'text/javascript' } });
  if (p === '/fixture-world.js') return new Response((await Bun.file(new URL('./dom-world.js', import.meta.url)).text()).replace('../../src/ui/web/assets/prefs.js', '/prefs.js'), { headers: { 'Content-Type': 'text/javascript' } });
  if (/^\/[\w.-]+\.(js|css)$/.test(p)) return new Response(Bun.file(path.join(assets, p.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
let session, driver, passed = false;
async function rpc(suffix, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${suffix}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => text += part); res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    }); req.on('error', reject); req.setTimeout(60000, () => req.destroy(Error('WebDriver timeout'))); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = condition => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0],end=Date.now()+10000;const check=()=>(${condition})?done(true):Date.now()>end?done(false):setTimeout(check,30);check();`, args: [] });
const assert = (ok, message) => { if (!ok) throw Error(message); };
const press = label => execute(`Array.from(document.querySelectorAll('.input-detail button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`);
async function frame() { const f = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: f }); }
try {
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(evidence, 'driver.log')), stderr: Bun.file(path.join(evidence, 'driver.log')) });
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {} if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100); }
  assert(ready, 'driver startup failed');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1100 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` }); await frame();
  assert(await wait('window.ready&&document.querySelector(".input-submit-actions")'), 'draft did not load');
  assert(await execute('return document.querySelector(".emission-conditions").hidden'), 'conditions not initially folded');
  await press('执行条件设置 · 3 项 · 独占');
  assert(await execute('return !document.querySelector(".emission-conditions").hidden&&document.querySelector(".emission-advanced-body").hidden&&document.querySelectorAll(".emission-condition-row").length===4'), 'condition cards or default advanced folding missing');
  await press('加载 Worker');
  assert(await wait('document.querySelector(".emission-worker-picker .hint").textContent.includes("已加载")'), 'worker fixture missing');
  await execute(`const s=document.querySelector('[aria-label="条件 Worker"]');s.value='23';s.dispatchEvent(new Event('change',{bubbles:true}));`);
  const layouts = [];
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame();
    await execute(`document.documentElement.dataset.theme='${theme}'`);
    const layout = await execute(`const settings=document.querySelector('.emission-settings').getBoundingClientRect(),configured=document.querySelector('.emission-configured').getBoundingClientRect();
      const nodes=[...document.querySelectorAll('.emission-conditions button,.emission-conditions select,.emission-conditions input:not([type=checkbox]),.input-actions button')].filter(n=>n.getClientRects().length);
      const cards=[...document.querySelectorAll('.emission-condition-row')];
      return {theme:document.documentElement.dataset.theme,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,
      columns:Math.abs(settings.top-configured.top)<2&&configured.left>settings.right,
      stacked:configured.top>=settings.bottom,
      fits:nodes.every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&(${width}>760||r.height>=44)}),
      cards:cards.every(n=>{const s=getComputedStyle(n);return s.backgroundColor!=='rgba(0, 0, 0, 0)'&&parseFloat(s.borderTopWidth)>=1&&parseFloat(s.paddingTop)>=10&&n.scrollWidth<=n.clientWidth+1}),
      group:[...document.querySelector('.input-submit-actions').querySelectorAll('button')].map(n=>n.textContent),
      advanced:document.querySelector('.emission-advanced-body').hidden};`);
    assert(!layout.overflow && layout.fits && layout.cards && layout.advanced, `layout failed ${JSON.stringify(layout)}`);
    assert(width > 1000 ? layout.columns : layout.stacked, `wrong module ordering ${JSON.stringify(layout)}`);
    assert(layout.group.length === 2 && layout.group[0] === '按条件提交' && layout.group[1].startsWith('执行条件设置'), 'submission group not adjacent');
    await press('展开高级设置：静息与独占');
    assert(await execute(`return !document.querySelector('.emission-advanced-body').hidden&&[...document.querySelectorAll('.emission-advanced-body label')].every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&(${width}>760||r.height>=44)})`), `advanced layout failed ${theme}/${width}`);
    await press('收起高级设置');
    await execute(`document.querySelector('.emission-conditions').scrollIntoView({block:'start',behavior:'instant'})`);
    fs.writeFileSync(path.join(evidence, `${theme}-${width}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
    await execute(`document.querySelector('.emission-configured').scrollIntoView({block:'start',behavior:'instant'})`);
    fs.writeFileSync(path.join(evidence, `${theme}-${width}-cards.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
    layouts.push(layout); console.log(`PASS conditions/cards/actions/advanced ${theme}/${width}px`);
  }
  await press('移除静息条件');
  assert(await execute(`return document.querySelectorAll('.emission-condition-row').length===3&&document.querySelector('.emission-exclusive-card')&&document.querySelector('.emission-configured h3').textContent.includes('3 项')`), 'removing explicit quiet lost implicit exclusivity');
  await press('关闭独占'); await press('移除条件'); await press('移除条件');
  assert(await execute(`return document.querySelector('.emission-condition-empty')&&document.querySelector('.emission-configured h3').textContent.includes('0 项')&&document.querySelector('.input-submit-actions button').textContent==='提交指令'&&window.calls.length===0`), 'empty state or no-side-effects failed');
  fs.writeFileSync(path.join(evidence, 'checks.json'), JSON.stringify(layouts, null, 2)); passed = true;
} catch (error) {
  if (session) { try { fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify(await execute('return {url:location.href,html:document.documentElement.outerHTML};'))); } catch {} }
  throw error;
} finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  if (driver) { driver.kill(); await driver.exited; } server.stop(true);
  console.log(`${passed ? 'Browser evidence' : 'Failure diagnostics'}: ${evidence}`);
}
