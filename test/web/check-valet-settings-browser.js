// Physical Firefox -> isolated real HTTP/RPC/SQLite; no user services or paid models.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-valet-settings-browser-'));
const f = await setup(); f.project.kick = () => {};
let driver, wrapper, session;
const assert = (ok, message) => { if (!ok) throw Error(message); };
const slot = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }); const port = slot.port; slot.stop(true);
async function rpc(suffix, body, method = 'POST') {
  const response = await globalThis.fetch(`http://127.0.0.1:${port}${suffix}`, { method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  const data = await response.json(); if (!response.ok) throw Error(JSON.stringify(data)); return data.value;
}
const run = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = condition => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0],end=Date.now()+10000;const check=()=>(${condition})?done(true):Date.now()>end?done(false):setTimeout(check,30);check();`, args: [] });
const press = label => run(`const b=[...document.querySelectorAll('button')].find(n=>n.textContent===${JSON.stringify(label)});b.scrollIntoView({block:'center',behavior:'instant'});b.click();`);
const screenshot = async name => fs.writeFileSync(path.join(evidence, `${name}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
const select = (method, access) => run(`const s=document.querySelector('[data-method="${method}"] select');s.value='${access}';s.dispatchEvent(new Event('change',{bubbles:true}));`);
const layouts = [], mutations = [];
try {
  await repo(f.root);
  const host = await (await fetch(f.url + '/api/host/projects')).json(); const projectId = host.projects.find(item => item.project === f.root).id;
  wrapper = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/fixture') return new Response(`<!doctype html><html><body style="margin:0"><iframe id="viewport" style="border:0;width:1440px;height:950px" src="/p/${projectId}/#valet-settings"></iframe></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    const body = req.method === 'POST' ? await req.text() : null;
    if (body && url.pathname.endsWith('/api/action')) mutations.push(JSON.parse(body));
    const upstream = await fetch(f.url + url.pathname + url.search, { method: req.method, ...(body === null ? {} : { headers: { 'Content-Type': 'application/json' }, body }) });
    const headers = new Headers(upstream.headers);
    if (headers.has('content-security-policy')) headers.set('content-security-policy', headers.get('content-security-policy').replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
  } });
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(evidence, 'driver.log')), stderr: Bun.file(path.join(evidence, 'driver.log')) });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {} if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100); }
  assert(ready, 'driver unavailable');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', timeouts: { script: 15000 }, 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1100 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${wrapper.port}/fixture` });
  const frame = async () => { const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: element }); };
  await frame(); assert(await wait(`document.querySelectorAll('.valet-permission-method').length>0`), 'page missing');
  assert(await run(`return [...document.querySelectorAll('.valet-methods')].every(n=>!n.open)`), 'interfaces not lazy-expanded');
  await screenshot('desktop-groups');
  await run(`document.querySelector('.valet-methods').open=true;`);
  await select('worker.resume', 'confirmation');
  assert(await run(`return document.querySelector('[data-method="manager.catalog"] select').disabled&&document.querySelector('[data-method="worker.transcript"] select').disabled&&!document.querySelector('[data-method="worker.delete"] option[value="automatic"]')`), 'fixed/elevated permissions selectable');
  await screenshot('desktop-expanded');
  await press('保存管家默认权限'); assert(await wait(`document.querySelector('.valet-settings-status').textContent.includes('已保存')`), 'save missing');
  assert(f.project.managementPermissions().permissions['worker.resume'] === 'confirmation', 'real defaults not persisted');
  assert(mutations.filter(item => item.method === 'management.permissions_update').length === 1, 'unexpected save replay');
  assert(Object.keys(mutations.find(item => item.method === 'management.permissions_update').params.permissions).length === f.project.managementPermissions().methods.length, 'incomplete mapping');
  await screenshot('desktop-save');
  for (const width of [1440, 390]) {
    await rpc(`/session/${session}/frame`, { id: null }); await run(`document.querySelector('#viewport').style.width='${width}px'`); await frame();
    await run(`document.querySelector('#detail').scrollTop=0;document.querySelector('.valet-settings-page').scrollIntoView({block:'start',behavior:'instant'});`);
    const layout = await run(`const root=document.querySelector('.valet-settings-page'),grid=document.querySelector('.valet-permission-groups');return {width:innerWidth,columns:getComputedStyle(grid).gridTemplateColumns,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,rootWidth:root.getBoundingClientRect().width,cards:[...document.querySelectorAll('.valet-permission-group')].map(n=>({x:n.getBoundingClientRect().x,width:n.getBoundingClientRect().width})),selects:[...document.querySelectorAll('.valet-methods[open] select')].map(n=>({x:n.getBoundingClientRect().x,right:n.getBoundingClientRect().right})),nav:getComputedStyle(document.querySelector('#sidebar')).position};`);
    assert(layout.documentWidth <= width && layout.bodyWidth <= width, `horizontal overflow ${width}`);
    assert(layout.columns.split(' ').length === (width === 390 ? 1 : 2), `wrong grid columns ${width}`);
    assert(layout.selects.every(item => item.x >= 0 && item.right <= width), `select offscreen ${width}`);
    layouts.push(layout); await screenshot(`${width}-expanded`);
    if (width === 390) { await press('保存管家默认权限'); await screenshot('390-save'); }
  }
  await select('draft.add', 'confirmation'); await run(`location.hash='#valets'`);
  assert(await wait(`!document.querySelector('#modal').hidden`), 'dirty leave did not confirm'); await press('取消');
  assert(await wait(`location.hash==='#valet-settings'`), 'cancel did not restore route');
  await screenshot('390-leave-guard');
  fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({ layouts, mutations, success: true }, null, 2));
  console.log(JSON.stringify({ result: 'passed', evidence, widths: layouts.map(item => item.width) }));
} catch (error) { console.error(`Browser check failed; evidence: ${evidence}`); throw error; }
finally { if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} } driver?.kill(); if (driver) await driver.exited; wrapper?.stop(true); await f.close(); }
