// Physical Firefox -> isolated real HTTP/RPC/SQLite; no user services or paid models.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-cli-interfaces-browser-'));
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
const search = text => run(`const s=document.querySelector('.cli-search input');s.value=${JSON.stringify(text)};s.dispatchEvent(new Event('input',{bubbles:true}));`);
const choose = command => run(`document.querySelector('.cli-results [data-command="${command}"]').click();`);
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
  await frame(); assert(await wait(`document.querySelectorAll('.cli-command-link').length>0`), 'page missing');
  assert(await run(`return location.hash==='#cli-interfaces'&&[...document.querySelectorAll('.cli-results [data-command]')].every(n=>!n.dataset.command.includes(' '))`), 'empty search must show only roots / old route redirect');
  assert(await run(`return document.querySelector('.cli-search').getBoundingClientRect().top<document.querySelector('.resource-hero').getBoundingClientRect().top`), 'search is not first');
  assert(await run(`return getComputedStyle(document.querySelector('.cli-command-link strong')).color===getComputedStyle(document.querySelector('.cli-interfaces-page')).color`), 'command names are not legible');
  assert(await run(`return document.querySelector('.cli-search-prefix').textContent==='lush'&&!document.querySelector('.cli-search-prefix input')`), 'lush prefix is not fixed');
  await screenshot('desktop-directory');
  await search('worker');
  assert(await run(`const counts=[...document.querySelectorAll('.cli-results .cli-command-link')].map(n=>n.dataset.command.split(' ').length);return counts.every((n,i)=>!i||n>=counts[i-1])&&counts.includes(3)`), 'word-count ordering missing');
  const paths = await run(`return [...document.querySelectorAll('.cli-results .cli-command-link')].map(n=>n.dataset.command)`);
  await search('LUSH worker');
  assert(await run(`return JSON.stringify([...document.querySelectorAll('.cli-results .cli-command-link')].map(n=>n.dataset.command))===${JSON.stringify(JSON.stringify(paths))}`), 'full command paste differs from prefix-free search');
  for (const width of [1440, 390]) {
    await rpc(`/session/${session}/frame`, { id: null }); await run(`document.querySelector('#viewport').style.width='${width}px'`); await frame();
    const layout = await run(`const rows=[...document.querySelectorAll('.cli-results .cli-command-link')];return {kind:'list',width:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,rows:rows.map(n=>{const r=n.getBoundingClientRect(),name=n.querySelector('strong').getBoundingClientRect(),description=n.querySelector('.cli-command-description').getBoundingClientRect(),permission=n.querySelector('.cli-command-access').getBoundingClientRect();return {height:r.height,display:getComputedStyle(n).display,margin:getComputedStyle(n).marginBottom,last:n.lastElementChild.className,nameRight:name.right,descriptionX:description.x,descriptionRight:description.right,permissionX:permission.x,permissionRight:permission.right};})};`);
    assert(layout.documentWidth <= width && layout.bodyWidth <= width, `list horizontal overflow ${width}`);
    assert(layout.rows.every(row => row.display === 'grid' && row.height >= 44 && row.margin === '0px' && row.last === 'cli-command-access' && row.nameRight <= row.descriptionX && row.descriptionRight <= row.permissionX && row.permissionRight <= width), `not compact aligned rows ${width}`);
    layouts.push(layout); await screenshot(`${width}-list`);
  }
  await rpc(`/session/${session}/frame`, { id: null }); await run(`document.querySelector('#viewport').style.width='1440px'`); await frame();
  await search('继续'); const beforeIME = await run(`return document.querySelector('.cli-results').textContent`);
  await run(`const s=document.querySelector('.cli-search input');s.dispatchEvent(new CompositionEvent('compositionstart'));s.value='删除';s.dispatchEvent(new InputEvent('input',{isComposing:true}));`);
  assert(await run(`return document.querySelector('.cli-results').textContent===${JSON.stringify(beforeIME)}`), 'IME intermediate results changed');
  await run(`document.querySelector('.cli-search input').dispatchEvent(new CompositionEvent('compositionend'));`);
  assert(await run(`return !!document.querySelector('.cli-results [data-command="worker delete"]')`), 'IME final search missing');
  await search('order'); await choose('order');
  assert(await run(`return !document.querySelector('.cli-advanced').open&&document.querySelector('.cli-results').hidden`), 'single detail / advanced hierarchy missing');
  await select('draft.add', 'confirmation');
  assert(await run(`return document.querySelector('[data-method="management.submit"] select').disabled&&!document.querySelector('[data-method="management.submit"] option[value="automatic"]')`), 'unavailable permission elevated');
  await press('返回搜索结果'); assert(await run(`return document.querySelector('.cli-search input').value==='order'`), 'search lost'); await choose('order');
  assert(await run(`return document.querySelector('[data-method="draft.add"] select').value==='confirmation'`), 'draft lost');
  await screenshot('desktop-detail');
  await press('保存管家默认权限'); assert(await wait(`document.querySelector('.cli-settings-status').textContent.includes('已保存')`), 'save missing');
  assert(f.project.managementPermissions().permissions['draft.add'] === 'confirmation', 'real defaults not persisted');
  assert(mutations.filter(item => item.method === 'management.permissions_update').length === 1, 'unexpected save replay');
  assert(Object.keys(mutations.find(item => item.method === 'management.permissions_update').params.permissions).length === f.project.managementPermissions().methods.length, 'incomplete mapping');
  await run(`document.querySelector('.cli-advanced').open=true;`);
  for (const width of [1440, 390]) {
    await rpc(`/session/${session}/frame`, { id: null }); await run(`document.querySelector('#viewport').style.width='${width}px'`); await frame();
    await run(`document.querySelector('#detail').scrollTop=0;document.querySelector('.cli-command-detail').scrollIntoView({block:'start',behavior:'instant'});`);
    const layout = await run(`const root=document.querySelector('.cli-interfaces-page'),detail=document.querySelector('.cli-command-detail'),code=document.querySelector('.cli-command-code'),nav=document.querySelector('.cli-detail-nav');return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,rootWidth:root.getBoundingClientRect().width,codeWidth:code.getBoundingClientRect().width,codeScroll:code.scrollWidth,codeClient:code.clientWidth,codes:[...document.querySelectorAll('.cli-command-code')].map(n=>({scroll:n.scrollWidth,client:n.clientWidth})),navTop:nav.getBoundingClientRect().top,headingTop:detail.querySelector('h2').getBoundingClientRect().top,rows:[...document.querySelectorAll('.cli-permission-method')].map(n=>({x:n.getBoundingClientRect().x,width:n.getBoundingClientRect().width,columns:getComputedStyle(n).gridTemplateColumns})),selects:[...document.querySelectorAll('.cli-permission-method select')].map(n=>({x:n.getBoundingClientRect().x,right:n.getBoundingClientRect().right}))};`);
    assert(layout.documentWidth <= width && layout.bodyWidth <= width, `horizontal overflow ${width}`);
    assert(layout.codes.every(code => code.scroll <= code.client + 1), `long command overflows ${width}`);
    assert(layout.selects.every(item => item.x >= 0 && item.right <= width), `select offscreen ${width}`);
    assert(layout.navTop < layout.headingTop, `return not at top ${width}`);
    if (width === 390) {
      assert(layout.rows.every(item => item.columns.split(' ').length === 1), 'mobile permissions not single column');
      assert(layout.navTop >= 56, 'mobile return is hidden under shell header');
    }
    layouts.push({ kind: 'detail', ...layout }); await screenshot(`${width}-detail`);
  }
  await select('draft.add', 'unavailable'); await run(`location.hash='#valets'`);
  assert(await wait(`!document.querySelector('#modal').hidden`), 'dirty leave did not confirm'); await press('取消');
  assert(await wait(`location.hash==='#cli-interfaces'`), 'cancel did not restore route'); await screenshot('390-leave-guard');
  await run(`location.hash='#valets'`); assert(await wait(`!document.querySelector('#modal').hidden`), 'discard missing'); await press('丢弃并离开');
  await rpc(`/session/${session}/frame`, { id: null }); await run(`document.querySelector('#viewport').src='/#cli-interfaces'`);
  assert(await wait(`document.querySelector('#viewport').contentWindow.location.pathname==='/'&&document.querySelector('#viewport').contentDocument.querySelector('.cli-results [data-command="order"]')`), 'global catalogue missing');
  await frame(); await search('order'); await choose('order');
  assert(await run(`return [...document.querySelectorAll('.cli-permission-method select')].every(s=>s.disabled)&&document.querySelector('.cli-permissions-save button').disabled&&document.querySelector('.cli-permissions-save').textContent.includes('当前没有项目')`), 'global permissions not readonly');
  await screenshot('390-global-readonly');
  fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({ layouts, mutations, success: true }, null, 2));
  console.log(JSON.stringify({ result: 'passed', evidence, widths: layouts.map(item => item.width) }));
} catch (error) { console.error(`Browser check failed; evidence: ${evidence}`); throw error; }
finally { if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} } driver?.kill(); if (driver) await driver.exited; wrapper?.stop(true); await f.close(); }
