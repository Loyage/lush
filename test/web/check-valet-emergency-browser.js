// bun run test/web/check-valet-emergency-browser.js — isolated shell, no user daemon/model.
import { join } from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const evidence = '/tmp/lush-w342-delivery/browser'; await mkdir(evidence, { recursive: true });
const script = `<script type="module">
import {renderTree} from '/render-tree.js';
import {openResource} from '/sidebar-ui.js';
import {registerNavigation} from '/navigate.js';
import {ui} from '/state.js';
const count={enabled:1,pending_occurrences:1,unstarted_actions:1,unstarted_calls:1,started_receipts:0,unknown_receipts:1,open_decisions:1,live_workers:0};
const items=Array.from({length:100},(_,i)=>({id:801+i,worker_number:'V'+(12+i),...count,blockers:[]}));
window.calls=[];window.mode='isolated';
window.fetch=async(url,options={})=>{if(options.method==='POST'){const call=JSON.parse(options.body);window.calls.push(call);return Response.json({version:1,scope:'current_project',request_revision:'exact-r1',status:window.mode,affected_total:105,isolated_total:window.mode==='isolated'?105:104,stopping_total:window.mode==='isolated'?0:1,blockers:window.mode==='isolated'?[]:[{id:801,worker_number:'V12',kinds:['provider_cleanup','control_owner']}],blockers_total:window.mode==='isolated'?0:1,blockers_truncated:false,history_preserved:true});}
return Response.json({version:1,scope:'current_project',revision:'exact-r1',total:105,affected_total:105,already_isolated_total:0,stopping_total:0,items,items_truncated:true,totals:Object.fromEntries(Object.entries(count).map(([k,v])=>[k,v*105])),history_preserved:true});};
registerNavigation({refresh:async()=>{}});openResource('valets');renderTree({tasks:[],notices:[]});window.ready=true;
</script>`;
const html = (await Bun.file(join(assets, 'index.html')).text()).replace(/<script[^>]*src="\/(?:app|appearance)\.js"[^>]*><\/script>/g, '').replace('</body>', script + '</body>');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/') return new Response('<html><body style="margin:0"><iframe id="viewport" src="/fixture" style="width:390px;height:844px;border:0"></iframe></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (path === '/fixture') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }); const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-valet-emergency-browser-'));
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1', TMPDIR: temp }, stdout: Bun.file(join(evidence, 'geckodriver.log')), stderr: Bun.file(join(evidence, 'geckodriver.log')) });
let session;
async function rpc(path, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    }); req.on('error', reject); req.setTimeout(20000, () => req.destroy(Error('WebDriver timeout'))); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = expression => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0];let n=0;const check=()=>(${expression})?done(true):++n>100?done(false):setTimeout(check,20);check();`, args: [] });
const assert = (value, message) => { if (!value) throw Error(message); };
async function click(selector) { const e = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector }); await rpc(`/session/${session}/element/${e['element-6066-11e4-a52e-4f735466cecf']}/click`, {}); }
async function key(value) { await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }] }); }
async function resize(width) {
  await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px';`);
  const frame = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: frame });
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {} if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100); }
  assert(ready, 'driver startup timeout');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1100 }); await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  await resize(390); assert(await wait('window.ready'), 'fixture did not load');
  let writes = 0;
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await resize(width); await execute(`document.documentElement.dataset.theme='${theme}';window.mode='isolated';`);
    assert(await execute(`const b=document.querySelector('.valet-emergency-control button');const r=b.getBoundingClientRect();return r.height>=44&&r.width>0&&r.right<=innerWidth&&!b.classList.contains('agent-call')&&b.dataset.help.includes('不停止开发 Worker');`), `permanent entry hidden/clipped ${theme}/${width}`);
    await click('.valet-emergency-control button'); assert(await wait(`!document.querySelector('#modal').hidden`), 'dialog missing');
    assert(await execute(`return window.calls.length===${writes}&&!document.querySelector('.valet-emergency-details').open&&document.querySelector('.valet-emergency-form').textContent.includes('本次影响 105 个')&&document.querySelector('.valet-emergency-details').textContent.includes('前 100 个');`), 'default hierarchy or preview mutated');
    const fits = await execute(`const card=document.querySelector('.valet-emergency-modal');return {overflow:card.scrollWidth-card.clientWidth,page:document.documentElement.scrollWidth-innerWidth,bad:[...card.querySelectorAll('button,summary')].filter(n=>n.getClientRects().length).filter(n=>{const r=n.getBoundingClientRect();return r.height<44||r.left<0||r.right>innerWidth+1}).map(n=>n.textContent)};`);
    assert(fits.overflow <= 1 && fits.page <= 1 && !fits.bad.length, `narrow overflow/targets ${theme}/${width}: ${JSON.stringify(fits)}`);
    assert(await execute(`return document.activeElement===document.querySelector('.modal-confirm')&&!document.querySelector('.modal-confirm').classList.contains('agent-call');`), 'focus/Agent marking wrong');
    await key('\uE004'); assert(await execute(`return document.activeElement===document.querySelector('.valet-emergency-details summary');`), 'Tab not trapped on details');
    await Bun.write(join(evidence, `${theme}-${width}-confirm.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
    await click('.valet-emergency-details summary'); assert(await execute(`return document.querySelector('.valet-emergency-details').open&&document.querySelector('.valet-emergency-modal').scrollWidth<=document.querySelector('.valet-emergency-modal').clientWidth+1;`), 'details overflow');
    await click('.valet-emergency-details summary'); await click('.modal-cancel'); assert(await execute(`return window.calls.length===${writes}`), 'cancellation mutated');
    await click('.valet-emergency-control button'); assert(await wait(`!document.querySelector('#modal').hidden`), 'reopen failed');
    await click('.modal-confirm'); writes++;
    assert(await wait(`document.querySelector('#modal').hidden&&window.calls.length===${writes}`), 'confirmation did not finish');
    assert(await execute(`const c=window.calls.at(-1);return c.method==='management.emergency_stop'&&c.params.revision==='exact-r1'&&c.params.confirm===true&&document.querySelector('.valet-emergency-status').textContent.includes('历史占位已解除');`), 'exact request/isolation missing');
    console.log(`PASS ${theme} ${width}px: permanent entry, exact preview/confirmation, collapsed full-scope details, 44px controls, Tab trap, cancellation, isolated result, no horizontal overflow`);
  }
  await resize(320); await execute(`window.mode='stopping';`); await click('.valet-emergency-control button'); assert(await wait(`!document.querySelector('#modal').hidden`), 'stopping preview missing'); await key('\uE00C');
  assert(await execute(`return document.querySelector('#modal').hidden&&window.calls.length===${writes}`), 'Escape mutated');
  await click('.valet-emergency-control button'); assert(await wait(`!document.querySelector('#modal').hidden`), 'stopping reopen missing'); await click('.modal-confirm'); writes++;
  assert(await wait(`document.querySelector('#modal').hidden&&window.calls.length===${writes}`), 'stopping write missing');
  assert(await execute(`const s=document.querySelector('.valet-emergency-status');return s.textContent.includes('尚未全部解除占位')&&s.textContent.includes('V12：模型进程或退出清理尚未结束、受控操作尚未退出')&&!s.textContent.includes('可重新提交救援')&&document.documentElement.scrollWidth<=innerWidth;`), 'stopping falsely claims ready');
  await Bun.write(join(evidence, 'dark-320-stopping.png'), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
  console.log(`PASS stopping blockers and Escape cancellation; screenshots: ${evidence}`);
} catch (error) {
  if (session) { try { await Bun.write(join(evidence, 'failure.png'), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64')); } catch {} }
  throw error;
} finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  driver.kill(); await driver.exited; server.stop(true); await rm(temp, { recursive: true, force: true });
}
