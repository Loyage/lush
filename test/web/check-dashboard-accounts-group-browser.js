// Standalone: bun run test/web/check-dashboard-accounts-group-browser.js
// Account renderer with the real board shell/styles; W212 owns controller/modal/CSP integration.
// No daemon, credentials or provider/model calls.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/assets/styles.css"><link rel="stylesheet" href="/assets/styles-project-board.css"><link rel="stylesheet" href="/assets/styles-workbench.css"><link rel="stylesheet" href="/assets/styles-dashboard-cards.css">
<style>body{margin:0;padding:12px}</style>
</head><body><div id="mount"></div><script type="module">
import {renderAccountGroup} from '/assets/dashboard-accounts-group.js';
import {createProjectBoard} from '/assets/project-board.js';
window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
window.network=[];window.fetch=async url=>{network.push(url);throw Error('unexpected network');};window.refreshed=[];window.all=0;
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const metric=(extra={})=>({id:'short',kind:'quota',scope:'account',label:'5小时套餐窗口',unit:'%',remaining:75,used_percent:25,reset_at:'2020-01-01T00:00:00Z',window_seconds:18000,...extra});
const observation={status:'available',source:'usage_api',checked_at:'2026-10-01T00:00:00Z',resources:[metric(),metric({id:'week',label:'7天套餐窗口',window_seconds:604800}),metric({id:'cash',kind:'balance',unit:'USD',remaining:12.5,label:'现金余额'}),metric({id:'key',scope:'key',unit:'USD',remaining:3,label:'Key预算'}),metric({id:'unknown',scope:'model',unit:'tokens',remaining:null,used_percent:null,label:'未知模型额度'})]};
const account=n=>({id:'account:'+id(n),type:'account',connection_id:id(n),connection:{id:id(n),label:n===1?'很长的账号名称'.repeat(8):'同名账号 '+n,provider:'openrouter',enabled:n!==5,observation:n===2?{status:'unknown',source:'none',checked_at:'2026-10-01T00:00:00Z',resources:[]}:n===3?{status:'error',source:'usage_api',resources:[]}:n===4?{...observation,status:'partial'}:observation,last_success:n===3?{checked_at:'2026-01-01T00:00:00Z',observation}:null}});
const board=createProjectBoard({renderCard:row=>{
 const root=renderAccountGroup(row,{mode:row.mode,refresh:async id=>refreshed.push(id),refreshAll:async()=>all++,sectionsForAccount:row=>row.connection_id===id(3)?['quota','balance','observed','history','details','provenance']:undefined});
 const host=document.createElement('span');host.className='help-host dashboard-card-settings-host';
 const settings=document.createElement('button');settings.className='fixture-settings dashboard-card-settings';settings.textContent='⚙';settings.dataset.help='模拟父级窗口设置入口';host.append(settings);root.prepend(host);
 return root;
}});board.root.id='board';document.querySelector('#mount').append(board.root);window.board=board;
window.mount=(mode='list',height=16)=>{
 const accounts=Array.from({length:100},(_,i)=>account(i+1));accounts[5].connection=null;
 void board.update([{id:'accounts',type:'accounts',name:'额度与余额',accounts,mode}],{layout:[{id:'accounts',x:0,y:0,w:12,h:height}]});
 window.group=board.root.firstElementChild;return window.group;
};window.mount();window.ready=true;
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
const temp = await mkdtemp(join(tmpdir(), 'lush-account-group-browser-')), log = join(temp, 'geckodriver.log');
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
const settle = () => rpc(`/session/${session}/execute/async`, { script: 'const done=arguments[0];let n=0;const tick=()=>++n===6?done(true):requestAnimationFrame(tick);requestAnimationFrame(tick);', args: [] });
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
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) for (const mode of ['list', 'tiles']) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px';`); await enterViewport();
    for (const container of [0, 240]) for (const height of [6, 16]) for (const editing of [false, true]) {
      await execute(`document.documentElement.dataset.theme='${theme}';document.querySelector('#board').style.width='${container ? `${container}px` : '100%'}';window.mount('${mode}',${height});window.board.setEditing(${editing});document.querySelectorAll('details').forEach(d=>d.open=true);`);
      await settle();
      const result = await execute(`
        const errors=[...window.errors],root=window.group,region=root.querySelector('.project-board-content'),cards=[...root.querySelectorAll('.dashboard-account-card')];
        const bounds=region.getBoundingClientRect();
        const overlap=(a,b)=>Math.min(a.right,b.right)>Math.max(a.left,b.left)+.5&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)+.5;
        const refresh=root.querySelector('.dashboard-accounts-refresh').getBoundingClientRect();
        for(const selector of ['.fixture-settings','.project-board-handle']){const node=root.querySelector(selector);if(!node.hidden&&overlap(refresh,node.getBoundingClientRect()))errors.push('group refresh/settings/handle overlap');}
        for(const card of cards){
          const r=card.getBoundingClientRect(),header=card.querySelector('.dashboard-account-header'),h=header.querySelector('h3').getBoundingClientRect(),button=header.querySelector('button'),b=button.getBoundingClientRect();
          if(getComputedStyle(header).paddingRight!=='0px')errors.push('inner inherited header reserve');
          if(overlap(h,b)||b.right>r.right+.5||b.left<r.left-.5||b.height<44)errors.push('inner header clipping/overlap');
          if(card.scrollWidth>card.clientWidth+1)errors.push('card horizontal overflow');
          if(button.disabled){const host=button.parentNode;if(!host.dataset.help||host.tabIndex!==0)errors.push('disabled help missing');}
          for(const part of card.querySelectorAll('progress,p,details')){const b=part.getBoundingClientRect();if(b.right>r.right+.5||b.left<r.left-.5)errors.push('content clipped');}
        }
        const last=cards.at(-1),button=last.querySelector('button');
        const b=button.getBoundingClientRect();if(b.top<bounds.top-.5||b.bottom>bounds.bottom+.5)errors.push('last source refresh outside expanded card');
        const end=last.querySelector('.dashboard-account-metric:last-child').lastElementChild;
        const e=end.getBoundingClientRect();if(e.top<bounds.top-.5||e.bottom>bounds.bottom+.5)errors.push('last metric outside expanded card');
        const items=root.querySelector('.dashboard-accounts-items');
        for(const part of [region,items]){if(part.scrollHeight>part.clientHeight+1||['auto','scroll'].includes(getComputedStyle(part).overflowY))errors.push('nested vertical scroll');}
        if(root.getBoundingClientRect().height<=384)errors.push('content did not expand minimum height');
        if(region.scrollWidth>region.clientWidth+1||document.documentElement.scrollWidth>innerWidth)errors.push('horizontal overflow');
        if(cards.length!==100)errors.push('source dropped');
        if(root.querySelectorAll('.dashboard-account-metric').length!==490)errors.push('metric dropped');
        return {errors,network:window.network,firstHeight:cards[0].getBoundingClientRect().height,regionWidth:bounds.width,rootHeight:root.getBoundingClientRect().height,regionHeight:bounds.height,scrollHeight:region.scrollHeight,scrollTop:region.scrollTop,itemsHeight:root.querySelector('.dashboard-accounts-items').getBoundingClientRect().height};`);
      assert(!result.errors.length && !result.network.length, `${theme} ${width} ${mode} container=${container || 'full'} height=${height} editing=${editing}: ${JSON.stringify(result)}`);
      console.log(`PASS ${theme} ${width}px ${mode} width=${Math.round(result.regionWidth)} min-rows=${height} editing=${editing}: 100 sources, all metrics flat, no nested scroll/overlap/network`);
    }
  }
  await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='1440px';`); await enterViewport();
  await execute(`document.querySelector('#board').style.width='100%';window.board.setEditing(false);window.mount('list')`); await settle();
  const list = await execute(`return group.querySelector('.dashboard-account-card').getBoundingClientRect().height`);
  await execute(`window.mount('tiles')`); await settle();
  const density = { list, tiles: await execute(`return group.querySelector('.dashboard-account-card').getBoundingClientRect().height`) };
  assert(density.list < density.tiles, `list was not compact: ${JSON.stringify(density)}`);
  await execute(`window.mount('list');group.querySelector('.dashboard-account-refresh').focus();`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  await execute(`group.querySelector('.dashboard-accounts-refresh').click();`);
  assert(await execute(`return refreshed.length===1&&refreshed[0]==='00000000-0000-4000-8000-000000000001'&&window.all===1&&network.length===0;`), 'callbacks did not remain explicit/single-source');
  console.log(`PASS compact list ${density.list}px < tiles ${density.tiles}px; keyboard single-source and group callback only`); passed = true;
} catch (error) {
  if (session) await Bun.write(join(temp, 'failure.png'), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64')).catch(() => {});
  console.error(`Account group browser failure; full logs: ${temp}`); throw error;
} finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true });
}
