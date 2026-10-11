// Standalone: bun test/web/check-dashboard-accounts-browser.js
// Isolated HTTP/Firefox fixture: no daemon, real credentials, provider query or model call.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/assets/styles.css"><link rel="stylesheet" href="/assets/styles-dashboard-cards.css">
<style>body{margin:0;padding:12px}#cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:12px;padding:0;list-style:none}</style>
</head><body><ul id="cards"></ul><script type="module">
import {renderAccountCard} from '/assets/dashboard-cards.js';
window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
window.network=[];window.fetch=async(url)=>{network.push(url);throw Error('unexpected network');};window.refreshed=[];
const metric=(extra={})=>({id:'plan',kind:'quota',scope:'account',label:'订阅额度',unit:'%',remaining:75,used_percent:25,reset_at:'2020-01-01T00:00:00Z',window_seconds:18000,...extra});
const observation={status:'available',source:'usage_api',checked_at:'2026-10-01T00:00:00Z',resources:[metric(),metric({id:'cash',kind:'balance',unit:'USD',remaining:12.5})]};
const connection=(id,extra={})=>({id,label:'来源 '+id,provider:'openai-codex',enabled:true,endpoint:'https://example.invalid/'+('long-path/'.repeat(20)),observation,...extra});
const row=connection=>({id:'account:'+connection.id,connection_id:connection.id,connection});
const mount=(entry,options={})=>{const card=renderAccountCard(entry,{refresh:async id=>refreshed.push(id),...options});document.querySelector('#cards').append(card);return card;};
mount(row(connection('a',{label:'很长的来源名称'.repeat(14)})));
mount(row(connection('b',{observation:{status:'unknown',source:'none',checked_at:'2026-10-01T00:00:00Z',resources:[]}})));
mount(row(connection('c',{observation:{status:'error',source:'usage_api',resources:[]},last_success:{checked_at:'2026-10-01T00:00:00Z',observation}})),{sections:['history','quota','balance','reset','observed','details','provenance']});
mount(row(connection('d',{observation:{...observation,status:'partial'}})));
mount(row(connection('e',{enabled:false})),{sections:[]});
mount({id:'account:deleted',connection_id:'deleted',connection:null});window.ready=true;
</script></body></html>`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/') return new Response('<!doctype html><html><body style="margin:0"><iframe id="viewport" src="/fixture" style="width:1440px;height:900px;border:0"></iframe></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (path === '/fixture') return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
  if (/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.split('/').at(-1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-dashboard-accounts-')), log = join(temp, 'geckodriver.log');
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log) });
let session, passed = false;
async function rpc(path, body, method = 'POST') {
  const result = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('WebDriver timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(result.text); if (result.status >= 400) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const assert = (condition, message) => { if (!condition) throw Error(message); };
async function enterViewport() {
  const frame = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' });
  await rpc(`/session/${session}/frame`, { id: frame });
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100);
  }
  assert(ready, 'geckodriver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1000 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` }); await enterViewport();
  assert(await rpc(`/session/${session}/execute/async`, { script: 'const done=arguments[0];let n=0;const check=()=>window.ready?done(true):++n>100?done(false):setTimeout(check,20);check();', args: [] }), 'fixture failed to load');
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px';`); await enterViewport();
    await execute(`document.documentElement.dataset.theme='${theme}';document.querySelectorAll('details').forEach(d=>d.open=true);`);
    const result = await execute(`
      const errors=[...window.errors],cards=[...document.querySelectorAll('.dashboard-account-card')];
      for(const card of cards){
        const r=card.getBoundingClientRect(),h=card.querySelector('h3').getBoundingClientRect(),button=card.querySelector('button'),b=button.getBoundingClientRect();
        if(h.right>b.left+.5||b.right>r.right||b.left<r.left||b.height<44)errors.push('header clipping/overlap');
        if(card.scrollWidth>card.clientWidth)errors.push('card overflow');
        for(const child of card.querySelectorAll('progress,details,p')){const c=child.getBoundingClientRect();if(c.right>r.right+.5||c.left<r.left-.5)errors.push('content clipping');}
        if(button.disabled){const host=button.parentNode;if(!host.dataset.help||host.tabIndex!==0)errors.push('missing disabled help');host.focus();if(document.activeElement!==host)errors.push('disabled help not focusable');}
      }
      const first=cards[0].textContent;
      if(first.includes('模型端点')||first.includes('观测成功')||first.includes('指标详情'))errors.push('default not compact');
      if(!cards[1].textContent.includes('尚无观测'))errors.push('fake observation');
      if(!cards[2].textContent.includes('历史成功观测（非当前值）'))errors.push('unmarked history');
      if(!cards[3].textContent.includes('部分指标可用'))errors.push('missing partial');
      if(document.documentElement.scrollWidth>innerWidth)errors.push('horizontal overflow');
      return {errors,network:window.network,count:cards.length};`);
    assert(!result.errors.length && !result.network.length && result.count === 6, `${theme} ${width}: ${JSON.stringify(result)}`);
    console.log(`PASS ${theme} ${width}px: compact/unknown/failed/partial/disabled/deleted cards, expanded details, no clipping or network`);
  }
  await execute(`document.querySelector('.dashboard-account-refresh').focus();`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  assert(await execute(`return window.refreshed.length===1&&window.refreshed[0]==='a'&&window.network.length===0;`), 'keyboard refresh did not call only the parent callback');
  console.log('PASS native keyboard refresh: one account callback, no model/provider call'); passed = true;
} catch (error) {
  if (session) await Bun.write(join(temp, 'failure.png'), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64')).catch(() => {});
  console.error(`Account browser failure; full logs: ${temp}`); throw error;
} finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true });
}
