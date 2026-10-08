// Standalone: bun test/web/check-model-sources-browser.js
// Temporary HTTP fixture + Firefox/geckodriver only; no daemon, credentials or model calls.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/styles.css"><link rel="stylesheet" href="/assets/styles-agent-connections.css"><link rel="stylesheet" href="/assets/styles-agent-usage.css"><link rel="stylesheet" href="/assets/styles-agent-status.css"></head><body style="margin:0;padding:12px;box-sizing:border-box">
<script type="module">
import { createAgentConnections } from '/assets/render-agent-connections.js';
const at='2026-10-07T05:30:00Z';
const source=(id,extra={})=>({id,storage_scope:id==='b'?'project':'device',label:'订阅来源 '+id,provider:'openai-codex',auth_type:'oauth',enabled:true,endpoint:'https://chatgpt.com/backend-api/codex',models:['gpt-6.1-sol'],default_model:'gpt-6.1-sol',credential:{status:'configured'},observation:{status:'available',checked_at:at,resources:[
{kind:'quota',scope:'account',label:'主要套餐窗口',window_seconds:18000,used_percent:25,remaining:75,unit:'%',reset_at:'2026-10-08T05:29:00Z'},
{kind:'quota',scope:'account',label:'次要套餐窗口',window_seconds:604800,used_percent:50,remaining:50,unit:'%',reset_at:'2026-10-14T05:30:00Z'}]},...extra});
window.calls=[];window.fetch=async(url,options)=>{window.calls.push(String(url));if(options)throw Error('unexpected mutation');if(String(url).includes('/history?'))return Response.json({version:1,from:'2026-10-07T00:00:00Z',to:at,retention_days:90,truncated:false,series:[
{id:'cash',provider:'deepseek',account_key:'account-a',source_key:'source-a',kind:'balance',scope:'account',unit:'USD',label:'现金余额',sample_count:2,points:[{at:'2026-10-07T05:00:00Z',remaining:12,used:3,status:'available'},{at:'2026-10-07T05:05:00Z',remaining:10,used:5,status:'available'}]},
{id:'quota',provider:'openai-codex',account_key:'account-b',source_key:'source-b',kind:'quota',scope:'account',unit:'%',label:'5h套餐',window_seconds:18000,sample_count:2,points:[{at:'2026-10-07T05:00:00Z',used_percent:20,status:'available'},{at:'2026-10-07T05:05:00Z',used_percent:30,status:'available'}]}
]});return Response.json({version:1,connections:[source('a'),source('b',{label:'很长的账号名称'.repeat(10),default_model:'org/very-long-model-name'.repeat(10)}),source('c',{observation:{status:'error',checked_at:at,resources:[]}}),source('d',{observation:{status:'partial',checked_at:at,resources:[...source('d').observation.resources,{kind:'balance',remaining:5,unit:'USD'}]}})],sampling:{enabled:false,interval_minutes:5,retention_days:90}});};
window.panel=createAgentConnections({ownsPage:()=>true,now:()=>Date.parse(at)});document.body.append(window.panel.node);await window.panel.load();window.ready=true;
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
const temp = await mkdtemp(join(tmpdir(), 'lush-sources-browser-')), log = join(temp, 'geckodriver.log');
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
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 640, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null });
    await execute(`document.querySelector('#viewport').style.width='${width}px';`); await enterViewport();
    await execute(`document.documentElement.dataset.theme='${theme}';`);
    const result = await execute(`
      const rows=[...document.querySelectorAll('.model-source-row')];
      const errors=[];let height=0;
      for(const row of rows){
        const r=row.getBoundingClientRect(),actions=row.querySelector('.model-source-row-actions'),a=actions.getBoundingClientRect();height=r.height;
        if(!row.querySelector('[data-source-scope]')?.textContent.includes('来源'))errors.push('missing storage scope badge');
        const cache=actions.querySelector('.model-source-cache-time').getBoundingClientRect(),buttons=[...actions.querySelectorAll('button')],refresh=buttons[0].getBoundingClientRect(),detail=buttons[1].getBoundingClientRect();
        if(buttons.map(b=>b.textContent).join(',')!=='刷新,详情')errors.push('unexpected actions');
        if(cache.bottom>refresh.top+.5||refresh.bottom>detail.top+.5)errors.push('action order');
        if(a.right>r.right||a.left<r.left||detail.bottom>r.bottom)errors.push('clipped actions');
        for(const part of ['.model-source-identity','.model-source-settings','.model-source-resource-summary']){
          const b=row.querySelector(part).getBoundingClientRect();if(b.right>a.left+.5||b.bottom>r.bottom+.5)errors.push('overlap/clipping '+part);
        }
        const parts=['.model-source-identity','.model-source-settings','.model-source-resource-summary'].map(selector=>row.querySelector(selector).getBoundingClientRect());
        for(let i=0;i<parts.length;i++)for(let j=i+1;j<parts.length;j++)if(Math.min(parts[i].right,parts[j].right)>Math.max(parts[i].left,parts[j].left)+.5&&Math.min(parts[i].bottom,parts[j].bottom)>Math.max(parts[i].top,parts[j].top)+.5)errors.push('overlapping information');
        for(const reset of row.querySelectorAll('.model-source-reset-time')){
          if(reset.scrollWidth>reset.clientWidth)errors.push('clipped reset countdown');
          if(!reset.textContent.includes('后重置')||reset.textContent.includes('重置：'))errors.push('reset was not a countdown');
        }
      }
      if(document.documentElement.scrollWidth>innerWidth)errors.push('horizontal overflow');
      return {errors,height,calls:window.calls};`);
    assert(!result.errors.length, `${theme} ${width}: ${JSON.stringify(result)}`);
    assert(result.height === (width <= 640 ? 268 : width <= 1100 ? 168 : 144), 'unexpected row height');
    assert(result.calls.length === 1, 'overview unexpectedly queried');
    console.log(`PASS ${theme} ${width}px: ${result.height}px rows, right-hand actions, reset countdowns, no overlap/overflow`);
  }
  assert(await execute(`const row=document.querySelector('.model-source-row');row.querySelector('.model-source-details-toggle').click();const pane=document.querySelector('.model-source-detail');return pane.parentNode===row.parentNode&&pane.previousElementSibling===row&&!pane.hidden;`), 'detail did not expand inline');
  assert(await execute(`const pane=document.querySelector('.model-source-detail');[...pane.querySelectorAll('button')].find(b=>b.textContent==='编辑').click();return window.panel.node.dataset.sourcePanel==='editor'&&!pane.hidden;`), 'detail editor failed');
  assert(await execute(`document.querySelector('.model-source-back').click();return document.querySelector('.model-source-detail').hidden&&window.calls.length===1;`), 'return/networking failed');
  console.log('PASS inline detail -> editor -> return; no network mutations');
  assert(await execute(`const trends=document.querySelector('.model-source-trends');[...trends.querySelectorAll('button')].find(b=>b.textContent==='查看余额与额度趋势').click();return !trends.querySelector('.model-source-trend-body').hidden&&document.querySelector('.model-source-detail').hidden;`), 'trend entry did not expand full-width');
  assert(await rpc(`/session/${session}/execute/async`, { script: 'const done=arguments[0];let n=0;const check=()=>document.querySelectorAll(".model-source-trends svg").length===2?done(true):++n>100?done(false):setTimeout(check,20);check();', args: [] }), 'trend fixture did not draw both readings');
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px';`); await enterViewport();
    const result = await execute(`document.documentElement.dataset.theme='${theme}';
      const root=document.querySelector('.model-source-trends'),readings=[...root.querySelectorAll('.agent-usage-reading')];
      for(const details of root.querySelectorAll('.agent-usage-data'))details.open=true;
      readings[0].value='used';readings[0].dispatchEvent(new Event('change'));
      const dot=root.querySelector('.agent-usage-dot');dot.focus();
      const graphs=[...root.querySelectorAll('svg')];return {overflow:document.documentElement.scrollWidth>innerWidth,
        graphLabels:graphs.map(graph=>graph.getAttribute('aria-label')),focus:document.activeElement===dot,
        controls:[...root.querySelectorAll('select,button')].every(node=>node.getBoundingClientRect().right<=innerWidth),calls:window.calls.length};`);
    assert(!result.overflow && result.controls && result.focus, `${theme} ${width}px trends: ${JSON.stringify(result)}`);
    assert(result.graphLabels[0].includes('已用量曲线，单位 USD') && result.graphLabels[1].includes('已用比例曲线，单位 %'), 'trend axes mixed or used-only quota lost');
    assert(result.calls === 2, 'local chart controls unexpectedly requested network');
    console.log(`PASS ${theme} ${width}px: full-width trends, separate USD/% axes, keyboard focus, table scroll, no page overflow or extra requests`);
  }
  passed = true;
} catch (error) { console.error(`Browser check failed; full driver log: ${log}`); throw error; }
finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true });
}
