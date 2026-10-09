// Standalone real-browser regression: bun ./test/web/check-auto-select-browser.js
// Actual shell/CSS, controlled HTTP reads/actions; no user daemon or model calls.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';

const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const script = `<script type="module">
import { ui, resetUiState } from '/state.js';
import { refresh } from '/refresh.js';
import { initNoticeRecords } from '/render-notices.js';
import { activateDetailView, openResource } from '/sidebar-ui.js';
import { registerNavigation } from '/navigate.js';
resetUiState();initNoticeRecords();window.enabled=true;window.generation=1;window.calls=[];window.fail=false;
window.fetch=async(url,options)=>{
 if(options?.body){const call=JSON.parse(options.body);window.calls.push(call);if(window.fail)return Response.json({error:'fixture revision changed'},{status:400});window.enabled=false;window.generation++;return Response.json({daemon_hooks:{version:1,revision:'auto-'+window.generation,mounts:[{id:'auto-select',enabled:false,editable:true}]}});}
 if(String(url).includes('/api/notices'))return Response.json({notices:[],cursor:null,has_more:false});
 return Response.json({revision:String(window.generation),status:{project:'/fixture',auto_select:{enabled:window.enabled,revision:'auto-'+window.generation,editable:true},concurrency:1,control_concurrency:1,agents:[],tasks:[],layers:[]},tasks:[],notices:[],ladder:{groups:[]},inputs:[],drafts:[],specs:[],candidates:[]});
};
registerNavigation({refresh,resource:openResource});
window.go=id=>{activateDetailView({view:id});document.querySelector('#detail').replaceChildren(...Array.from({length:100},(_,i)=>{const p=document.createElement('p');p.textContent=id+' · 内容 '+i;return p;}));};
window.reset=async()=>{window.enabled=true;window.generation++;window.fail=false;window.calls=[];window.go('docs');await refresh();};
window.poll=refresh;window.debug=()=>({busy:ui.busy,offline:ui.offline,model:ui.lastSnapshot?.status?.auto_select});window.reset().then(()=>window.ready=true);
</script>`;
const fixture = (await Bun.file(join(assets, 'index.html')).text()).replace('<script type="module" src="/app.js"></script>', '').replace('</body>', script + '</body>');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/') return new Response('<html><body style="margin:0"><iframe id="viewport" src="/fixture" style="width:1440px;height:900px;border:0"></iframe></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (path === '/fixture') return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-auto-select-browser-')), log = join(temp, 'geckodriver.log');
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log) });
let session, passed = false;
async function rpc(path, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(Error('WebDriver timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = condition => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0];let n=0;const check=()=>(${condition})?done(true):++n>100?done(false):setTimeout(check,20);check();`, args: [] });
const assert = (ok, message) => { if (!ok) throw Error(message); };
async function frame() {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' });
  await rpc(`/session/${session}/frame`, { id: element });
}
try {
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); break; } catch {}
    if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100);
  }
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` }); await frame();
  assert(await wait('window.ready'), 'fixture did not initialize');
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null });
    await rpc(`/session/${session}/window/rect`, { width: Math.max(600, width + 50), height: 1000 });
    await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame();
    await execute(`document.documentElement.dataset.theme='${theme}';window.reset();window.scrollTo(0,0);`);
    assert(await wait('!document.querySelector("#auto-select-banner").hidden'), 'enabled banner missing');
    assert(await execute(`return innerWidth===${width} && document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('.auto-select-actions button')].every(b=>{const r=b.getBoundingClientRect();return r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth;});`), `clipped controls ${theme}/${width}`);
    for (const page of ['settings', 'task', 'task-graph', 'docs']) {
      await execute(`window.go('${page}');window.poll()`);
      assert(await execute(`return !document.querySelector('#auto-select-banner').hidden && document.querySelector('#detail').dataset.view==='${page}'`), 'navigation lost persistent mode');
    }
    if (width <= 390) {
      await execute('window.scrollTo(0,500)');
      assert(await execute(`const r=document.querySelector('#auto-select-banner').getBoundingClientRect();return r.top>=41&&r.top<=43`), 'mobile banner did not stay below toolbar');
      await execute('window.scrollTo(0,0)');
    }
    await execute(`document.querySelector('.auto-select-actions button').click()`);
    assert(await wait('document.querySelector("#side-notices").hidden===false'), 'history navigation failed');
    assert(await execute(`return document.querySelector('[data-notice-filter="automatic"]').getAttribute('aria-pressed')==='true' && window.calls.length===0;`), 'history view caused mutation or selected wrong filter');
    console.log('PASS persistent banner, visible controls and read-only history', theme, width);
  }
  await execute('window.reset();');
  assert(await wait(`!document.querySelector('#auto-select-banner').hidden && !document.querySelector('.auto-select-actions button:last-child').disabled`), 'reset did not restore enabled mode: '+JSON.stringify(await execute(`return {state:window.debug(),error:document.querySelector('#error').textContent,banner:document.querySelector('#auto-select-banner').textContent,buttons:[...document.querySelectorAll('.auto-select-actions button')].map(b=>({text:b.textContent,disabled:b.disabled}))}`)));
  await execute(`window.fail=true;document.querySelector('.auto-select-actions button:last-child').click()`);
  assert(await wait(`document.querySelector('#error').textContent.includes('关闭未确认')`), 'failure not reported: '+JSON.stringify(await execute(`return {calls:window.calls,error:document.querySelector('#error').textContent,banner:document.querySelector('#auto-select-banner').textContent}`)));
  assert(await execute(`return !document.querySelector('#auto-select-banner').hidden && !document.querySelector('.auto-select-actions button:last-child').disabled;`), 'failure hid mode or blocked retry');
  await execute(`window.fail=false;document.querySelector('.auto-select-actions button:last-child').focus()`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  assert(await wait(`document.querySelector('#auto-select-banner').hidden`), 'keyboard close did not apply ACK');
  assert(await execute(`return window.calls.length===2&&window.calls.every(c=>c.method==='hooks.auto_select'&&c.params.enabled===false&&c.params.expected_revision.startsWith('auto-'));`), 'wrong close request');
  console.log('PASS close failure/retry and keyboard close with independent revision'); passed = true;
} catch (error) { console.error('Browser check failed; log:', log); throw error; }
finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true });
}
