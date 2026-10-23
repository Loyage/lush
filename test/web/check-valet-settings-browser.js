// Physical Firefox -> isolated real HTTP/RPC/SQLite; no user services or paid models.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
import { startTestWeb } from './auth-fixture.js';
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-cli-interfaces-browser-'));
const f = await setup(); f.project.kick = () => {};
let driver, wrapper, session, launcher;
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
const search = text => run(`const s=document.querySelector('.cli-search input');s.value=${JSON.stringify(text)};s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
const choose = command => run(`const row=document.querySelector('.cli-results [data-command="${command.startsWith('lush') ? command : `lush ${command}`}"]');if(!row)throw Error(${JSON.stringify(`Missing command: ${command}`)});row.click();document.querySelectorAll('.cli-permissions-disclosure').forEach(n=>n.open=true);`);
const layouts = [], mutations = [], permissionWrites = [], catalogueRequests = [];
let permissionReads = 0;
try {
  await repo(f.root);
  const host = await (await fetch(f.url + '/api/host/projects')).json(); const projectId = host.projects.find(item => item.project === f.root).id;
  launcher = startTestWeb(null, 0, { env: f.config.env });
  let upstreamUrl = `http://127.0.0.1:${launcher.port}`;
  assert((await (await fetch(upstreamUrl + '/api/host/projects')).json()).projects.length === 0, 'launcher fixture must have no registered projects');
  wrapper = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/fixture') return new Response(`<!doctype html><html><body style="margin:0"><iframe id="viewport" style="border:0;width:1440px;height:950px" src="/#valet-settings"></iframe></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    const body = req.method === 'POST' ? await req.text() : null;
    if (body && url.pathname.endsWith('/api/action')) mutations.push(JSON.parse(body));
    if (url.pathname.endsWith('-cli-catalog.json')) catalogueRequests.push(url.pathname);
    if (url.pathname === '/api/host/management/permissions') {
      if (body) permissionWrites.push(JSON.parse(body)); else permissionReads++;
    }
    const forwardHeaders = new Headers();
    if (body !== null) forwardHeaders.set('Content-Type', 'application/json');
    if (req.headers.has('if-none-match')) forwardHeaders.set('If-None-Match', req.headers.get('if-none-match'));
    const upstream = await fetch(upstreamUrl + url.pathname + url.search, { method: req.method, headers: forwardHeaders, ...(body === null ? {} : { body }) });
    const headers = new Headers(upstream.headers);
    if (headers.has('content-security-policy')) headers.set('content-security-policy', headers.get('content-security-policy').replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    return new Response(upstream.status === 304 ? null : await upstream.arrayBuffer(), { status: upstream.status, headers });
  } });
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(evidence, 'driver.log')), stderr: Bun.file(path.join(evidence, 'driver.log')) });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {} if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100); }
  assert(ready, 'driver unavailable');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', timeouts: { script: 15000, implicit: 10000 }, 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1100 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${wrapper.port}/fixture` });
  const frame = async () => { const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: element }); };
  await frame(); assert(await wait(`document.querySelectorAll('.cli-command-link').length>0`), 'page missing');
  assert(await run(`return location.hash==='#cli-interfaces'&&[...document.querySelectorAll('.cli-results [data-command]')].every(n=>n.dataset.command.split(' ').length===2)`), 'empty search must show only roots / old route redirect');
  assert(await run(`const hero=document.querySelector('.resource-hero'),search=document.querySelector('.cli-search'),results=document.querySelector('.cli-results');return hero.getBoundingClientRect().top<search.getBoundingClientRect().top&&search.getBoundingClientRect().bottom<=results.getBoundingClientRect().top&&search.nextElementSibling===results&&!document.querySelector('.cli-operation-filters')&&document.querySelector('.cli-catalog-notice').hidden`), 'title/search/results hierarchy is not compact');
  assert(await run(`return getComputedStyle(document.querySelector('.cli-command-link strong')).color===getComputedStyle(document.querySelector('.cli-interfaces-page')).color`), 'command names are not legible');
  assert(await run(`return !document.querySelector('.cli-search-prefix')&&[...document.querySelectorAll('.cli-results [data-command]')].some(n=>n.dataset.command.startsWith('lushw '))`), 'fixed prefix was not removed or development entry is missing');
  assert(permissionReads === 0 && catalogueRequests.length === 1, 'static browsing requested global permissions or duplicate data');
  await screenshot('desktop-directory');
  await run(`location.hash='#projects'`); assert(await wait(`document.querySelector('#detail').dataset.view==='projects'&&document.querySelector('.dashboard-layout-edit')&&!document.querySelector('.dashboard-layout-edit').disabled`), 'leave missing');
  await run(`location.hash='#cli-interfaces'`); assert(await wait(`document.querySelectorAll('.cli-command-link').length>0`), 'return missing');
  assert(permissionReads === 0 && catalogueRequests.length === 1, 'same-document revisit did not reuse data');
  // A new document discards JS memory, but must reuse the immutable HTTP resource.
  await rpc(`/session/${session}/frame`, { id: null });
  await run(`document.querySelector('#viewport').src='/?cache-probe=1#cli-interfaces'`);
  assert(await wait(`document.querySelector('#viewport').contentWindow.location.search==='?cache-probe=1'&&document.querySelector('#viewport').contentDocument.querySelectorAll('.cli-command-link').length>0`), 'new document missing');
  await frame();
  assert(permissionReads === 0 && catalogueRequests.length === 1, 'new document downloaded an unchanged catalogue');
  const cacheEvidence = await run(`return performance.getEntriesByType('resource').filter(n=>n.name.endsWith('-cli-catalog.json')).map(n=>({name:n.name,transferSize:n.transferSize,encodedBodySize:n.encodedBodySize}))`);
  assert(cacheEvidence.length === 1 && cacheEvidence[0].transferSize === 0, 'catalogue did not come from browser HTTP cache');
  await search('worker');
  assert(await run(`const read=document.querySelector('[data-command="lush worker show"] .cli-command-operation'),write=document.querySelector('[data-command="lush worker resume"] .cli-command-operation'),directory=document.querySelector('[data-command="lush worker"] .cli-command-operation');return read.textContent==='读'&&write.textContent==='写'&&directory.textContent==='读／写'`), 'reads/writes are not unified or status is ambiguous');
  assert(await run(`const counts=[...document.querySelectorAll('.cli-results .cli-command-link')].map(n=>n.dataset.command.split(' ').length-1);return counts.every((n,i)=>!i||n>=counts[i-1])&&counts.includes(3)`), 'word-count ordering missing');
  const paths = await run(`return [...document.querySelectorAll('.cli-results .cli-command-link')].map(n=>n.dataset.command)`);
  await search('LUSH worker');
  assert(await run(`return JSON.stringify([...document.querySelectorAll('.cli-results .cli-command-link')].map(n=>n.dataset.command))===${JSON.stringify(JSON.stringify(paths.filter(command => command.startsWith('lush '))))}`), 'full command paste must select its actual executable');
  for (const width of [1440, 768, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await run(`document.querySelector('#viewport').style.width='${width}px'`); await frame();
    const layout = await run(`const rows=[...document.querySelectorAll('.cli-results .cli-command-link')];return {kind:'list',width:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,listWidth:document.querySelector('.cli-results').getBoundingClientRect().width,rows:rows.map(n=>{const r=n.getBoundingClientRect(),name=n.querySelector('strong').getBoundingClientRect(),description=n.querySelector('.cli-command-description').getBoundingClientRect(),operation=n.querySelector('.cli-command-operation').getBoundingClientRect(),permission=n.querySelector('.cli-command-access').getBoundingClientRect();return {height:r.height,display:getComputedStyle(n).display,margin:getComputedStyle(n).marginBottom,last:n.lastElementChild.className,nameX:name.x,nameRight:name.right,nameBottom:name.bottom,descriptionX:description.x,descriptionY:description.y,descriptionRight:description.right,operationX:operation.x,permissionX:permission.x,permissionRight:permission.right,gap:getComputedStyle(n).columnGap};})};`);
    assert(layout.documentWidth <= width && layout.bodyWidth <= width && layout.listWidth <= 800, `list overflow or excessive reading width ${width}: ${JSON.stringify(layout)}`);
    assert(layout.rows.every(row => row.display === 'grid' && row.height >= 44 && row.margin === '0px' && row.last === 'cli-command-access' && parseFloat(row.gap) <= 12 && row.permissionRight <= width && (width <= 600 ? row.descriptionY >= row.nameBottom : width > 760 ? row.nameRight <= row.descriptionX && row.descriptionRight <= row.operationX && row.operationX < row.permissionX : row.descriptionX === row.nameX && row.descriptionY >= row.nameBottom && row.descriptionRight <= row.operationX && row.nameRight <= row.operationX && row.operationX < row.permissionX)), `not compact responsive rows ${width}: ${JSON.stringify(layout)}`);
    layouts.push(layout); await screenshot(`${width}-list`);
  }
  await rpc(`/session/${session}/frame`, { id: null }); await run(`document.querySelector('#viewport').style.width='1440px'`); await frame();
  await search('继续'); const beforeIME = await run(`return document.querySelector('.cli-results').textContent`);
  await run(`const s=document.querySelector('.cli-search input');s.dispatchEvent(new CompositionEvent('compositionstart'));s.value='删除';s.dispatchEvent(new InputEvent('input',{isComposing:true}));`);
  assert(await run(`return document.querySelector('.cli-results').textContent===${JSON.stringify(beforeIME)}`), 'IME intermediate results changed');
  await run(`document.querySelector('.cli-search input').dispatchEvent(new CompositionEvent('compositionend'));`);
  assert(await run(`return document.querySelector('.cli-results').textContent===${JSON.stringify(beforeIME)}`), 'IME completion must not submit');
  await search('删除');
  assert(await run(`return !!document.querySelector('.cli-results [data-command="lush worker delete"]')`), 'submitted Chinese search missing');
  await run(`document.querySelector('.cli-permissions-save').parentElement.open=true`);
  await press('读取全局权限'); assert(await wait(`document.querySelector('.cli-settings-status').textContent.includes('内建默认已生效')`), 'active built-in permissions missing');
  assert(permissionReads === 1, 'permissions did not load exactly on demand');
  assert(await run(`return !document.querySelector('.cli-permissions-unconfigured').hidden&&document.querySelector('.cli-permissions-save button').disabled&&document.querySelector('.cli-permissions-unconfigured').textContent.includes('无需先保存')&&!document.querySelector('.cli-interfaces-page').textContent.includes('尚未统一生效')`), 'active defaults require a save or are labelled as an inactive draft');
  await search('status');
  assert(await run(`return document.querySelector('[data-command="lush status"] .cli-command-access').textContent.includes('独立命令 · 可调用')`), 'command type missing');
  await search('worker cancel'); await choose('worker cancel');
  assert(await run(`return document.querySelector('[data-method="worker.cancel"] select').value==='automatic'`), 'controlled destructive call is not automatic by default');
  await select('worker.cancel', 'confirmation');
  await press('保存全局管家权限'); assert(await wait(`!document.querySelector('#modal').hidden`), 'first custom save confirmation missing');
  assert(await run(`return document.querySelector('#modal').textContent.includes('此设备用户所有项目的新旧管家权限')&&document.querySelector('#modal').textContent.includes('当前内建默认已经生效')`), 'first save scope or active defaults not disclosed');
  await screenshot('first-custom-save-confirmation'); await press('取消');
  await screenshot('active-built-in-defaults');
  assert(permissionWrites.length === 0 && !(await (await fetch(`http://127.0.0.1:${launcher.port}/api/host/management/permissions`)).json()).configured, 'cancel mutated permissions');
  assert(await run(`return !document.querySelector('.cli-permissions-save button').disabled&&!document.querySelector('.cli-permissions-unconfigured').hidden&&document.querySelector('[data-method="worker.cancel"] select').value==='confirmation'`), 'cancel discarded draft');
  await press('保存全局管家权限'); assert(await wait(`!document.querySelector('#modal').hidden`), 'first save confirmation missing on retry'); await press('确认保存更改');
  assert(await wait(`document.querySelector('.cli-settings-status').textContent.includes('已保存')`), 'custom permissions save missing');
  assert(permissionWrites.length === 1 && f.project.managementPermissions().scope === 'device'&&f.project.managementPermissions().permissions['worker.cancel']==='confirmation', 'no-project save did not publish device policy');
  assert(await run(`return document.querySelector('.cli-permissions-unconfigured').hidden`), 'successful first save still labelled unconfigured');
  await search('config valet-permission set'); await choose('config valet-permission set');
  assert(await run(`const s=document.querySelector('[data-method="management.permission_set"] select');return s.value==='unavailable'&&[...s.options].map(n=>n.value).join(',')==='unavailable'`), 'project identity can change shared device permissions');
  await search('order'); await choose('order');
  assert(await run(`return !document.querySelector('.cli-advanced').open&&document.querySelector('.cli-results').hidden`), 'single detail / advanced hierarchy missing');
  await select('order.submit', 'confirmation');
  await press('返回搜索结果'); assert(await run(`return document.querySelector('.cli-search input').value==='order'`), 'search lost'); await choose('order');
  assert(await run(`return document.querySelector('[data-method="order.submit"] select').value==='confirmation'`), 'draft lost');
  await screenshot('desktop-detail');
  await press('保存全局管家权限'); assert(await wait(`document.querySelector('.cli-settings-status').textContent.includes('已保存')`), 'save missing');
  assert(await run(`const text=document.querySelector('.cli-permissions-save').textContent;return text.includes('新旧管家均生效')&&text.includes('未开始的操作执行前重新检查')&&text.includes('已开始的不强行中断')&&text.includes('已执行的不撤销')&&text.includes('权限改变不新建操作')&&text.includes('已有未开始的请求可能继续或受阻')&&text.includes('此设备用户所有项目的新旧管家')&&text.includes('失败不重放')&&!/未来新管家|已有管家不变|已有权限快照不变/.test(text)`), 'device-wide permission copy is missing or stale');
  assert(f.project.managementPermissions().permissions['order.submit'] === 'confirmation', 'real project permissions not persisted');
  assert(permissionWrites.length === 2 && !mutations.some(item => item.method === 'management.permissions_update'), 'unexpected save replay or retired project write');
  assert(Object.keys(permissionWrites[1].permissions).length === f.project.managementPermissions().methods.length, 'incomplete mapping');
  await run(`document.querySelector('.cli-advanced').open=true;`);
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await run(`document.querySelector('#viewport').style.width='${width}px'`); await frame();
    await run(`if(document.documentElement.dataset.theme!=='${theme}')document.querySelector('#theme-toggle').click();`);
    assert(await wait(`document.documentElement.dataset.theme==='${theme}'`), `theme ${theme} missing`);
    await run(`document.querySelector('#detail').scrollTop=0;document.querySelector('.cli-command-detail').scrollIntoView({block:'start',behavior:'instant'});`);
    const layout = await run(`const root=document.querySelector('.cli-interfaces-page'),detail=document.querySelector('.cli-command-detail'),code=document.querySelector('.cli-command-code'),nav=document.querySelector('.cli-detail-nav');return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,rootWidth:root.getBoundingClientRect().width,codeWidth:code.getBoundingClientRect().width,codeScroll:code.scrollWidth,codeClient:code.clientWidth,codes:[...document.querySelectorAll('.cli-command-code')].map(n=>({scroll:n.scrollWidth,client:n.clientWidth})),navTop:nav.getBoundingClientRect().top,headingTop:detail.querySelector('h2').getBoundingClientRect().top,rows:[...document.querySelectorAll('.cli-permission-method')].map(n=>({x:n.getBoundingClientRect().x,width:n.getBoundingClientRect().width,columns:getComputedStyle(n).gridTemplateColumns})),selects:[...document.querySelectorAll('.cli-permission-method select')].map(n=>({x:n.getBoundingClientRect().x,right:n.getBoundingClientRect().right}))};`);
    assert(layout.documentWidth <= width && layout.bodyWidth <= width, `horizontal overflow ${width}`);
    assert(layout.codes.every(code => code.scroll <= code.client + 1), `long command overflows ${width}`);
    assert(layout.selects.every(item => item.x >= 0 && item.right <= width), `select offscreen ${width}`);
    assert(layout.navTop < layout.headingTop, `return not at top ${width}`);
    if (width <= 390) {
      assert(layout.rows.every(item => item.columns.split(' ').length === 1), 'mobile permissions not single column');
      assert(layout.navTop >= 56, 'mobile return is hidden under shell header');
    }
    assert(await run(`const button=document.querySelector('.cli-permissions-save button'),footer=document.querySelector('.cli-permissions-save');return innerWidth>760||Math.abs(button.getBoundingClientRect().width-(footer.clientWidth-parseFloat(getComputedStyle(footer).paddingLeft)-parseFloat(getComputedStyle(footer).paddingRight)))<=1`), 'mobile save button not full width');
    layouts.push({ kind: 'detail', theme, ...layout }); await screenshot(`${width}-${theme}-detail`);
  }
  await select('order.submit', 'unavailable'); await run(`location.hash='#projects'`);
  assert(await wait(`!document.querySelector('#modal').hidden`), 'dirty leave did not confirm'); await press('取消');
  assert(await wait(`location.hash==='#cli-interfaces'`), 'cancel did not restore route'); await screenshot('390-leave-guard');
  await run(`location.hash='#projects'`); assert(await wait(`!document.querySelector('#modal').hidden`), 'discard missing'); await press('丢弃并离开');
  assert(await wait(`document.querySelector('.dashboard-layout-edit')&&!document.querySelector('.dashboard-layout-edit').disabled`), 'discard destination not ready');
  await rpc(`/session/${session}/frame`, { id: null }); await run(`document.querySelector('#viewport').src='/#cli-interfaces'`);
  assert(await wait(`document.querySelector('#viewport').contentWindow.location.pathname==='/'&&document.querySelector('#viewport').contentDocument.querySelector('.cli-results .cli-command-link')`), 'global catalogue missing');
  await frame(); await search('order'); await choose('order');
  assert(await run(`return [...document.querySelectorAll('.cli-permission-method select')].every(s=>s.disabled)&&document.querySelector('.cli-permissions-save button').disabled&&document.querySelector('.cli-permissions-save').textContent.includes('全局权限尚未读取')`), 'new document carried permissions without rereading');
  await press('读取全局权限'); assert(await wait(`!document.querySelector('[data-method="order.submit"] select').disabled`), 'global permissions not editable');
  await screenshot('320-global-editable');
  // Native legacy project links must preserve their source tab and hide the global entry.
  upstreamUrl = f.url;
  for (const hash of ['cli-interfaces', 'valet-settings']) {
    await rpc(`/session/${session}/frame`, { id: null }); await run(`document.querySelector('#viewport').src='/p/${projectId}/#${hash}'`);
    assert(await wait(`document.querySelector('#viewport').contentDocument.querySelector('#detail').dataset.view==='workspace-link'`), 'legacy project bookmark not redirected');
    await frame();
    assert(await run(`const entry=document.querySelector('#cli-interfaces-open'),link=document.querySelector('#detail a');return !entry.checkVisibility()&&link.getAttribute('href')==='/#cli-interfaces'&&link.target==='_blank'&&link.rel==='noopener'&&!link.onclick&&location.pathname==='/p/${projectId}/'&&location.hash==='#${hash}'&&!document.querySelector('.cli-interfaces-page')`), 'project entry visible or legacy bookmark replaced source tab');
    await screenshot(`legacy-project-${hash}`);
    await run(`document.querySelector('#input').value='preserve project input';`);
    const handles = await rpc(`/session/${session}/window/handles`, undefined, 'GET');
    const link = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#detail a' });
    await rpc(`/session/${session}/element/${link['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
    const opened = (await rpc(`/session/${session}/window/handles`, undefined, 'GET')).find(handle => !handles.includes(handle));
    assert(opened, 'native legacy link did not open a new tab');
    await rpc(`/session/${session}/window`, { handle: opened });
    // A native new tab may still be replacing its initial document. Let WebDriver
    // wait on the element across navigation rather than injecting a timer into
    // the about:blank document that is about to be discarded (same 10s budget).
    await rpc(`/session/${session}/element`, { using: 'css selector', value: '.cli-results .cli-command-link' });
    assert(await run(`return location.pathname==='/'&&location.hash==='#cli-interfaces'`), 'legacy destination missing in new global tab');
    await rpc(`/session/${session}/window`, undefined, 'DELETE'); await rpc(`/session/${session}/window`, { handle: handles[0] }); await frame();
    assert(await run(`return location.pathname==='/p/${projectId}/'&&location.hash==='#${hash}'&&document.querySelector('#input').value==='preserve project input'`), 'native global link changed project source input or route');
  }
  // Close only the isolated fixture's RPC service; the root page remains fully writable.
  await f.rpc.close();
  await rpc(`/session/${session}/frame`, { id: null });
  await run(`document.querySelector('#viewport').src='/?daemon-stopped=1#cli-interfaces'`);
  assert(await wait(`document.querySelector('#viewport').contentWindow.location.search==='?daemon-stopped=1'&&document.querySelector('#viewport').contentDocument.querySelectorAll('.cli-command-link').length>0`), 'stopped project prevented static browsing');
  await frame();
  assert(permissionReads === 2 && catalogueRequests.length === 1, 'stopped project browsing fetched dynamic permissions or redownloaded static data');
  await press('读取全局权限'); assert(await wait(`document.querySelector('.cli-settings-status').textContent.includes('已读取')`), 'offline project blocked Host permission read');
  await search('order'); await choose('order'); await select('order.submit', 'unavailable'); await press('保存全局管家权限');
  assert(await wait(`document.querySelector('.cli-settings-status').textContent.includes('已保存')`), 'all-daemon-offline save failed');
  assert(permissionWrites.length === 3 && f.project.managementPermissions().permissions['order.submit'] === 'unavailable', 'offline write missing or replayed');
  await screenshot('320-stopped-project-writable');
  fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({ layouts, mutations, permissionWrites, catalogueRequests, permissionReads, cacheEvidence, success: true }, null, 2));
  console.log(JSON.stringify({ result: 'passed', evidence, widths: layouts.map(item => item.width) }));
} catch (error) {
  try { fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify(await run(`return {url:location.href,ready:document.readyState,body:document.body?.innerText?.slice(0,12000),width:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body?.scrollWidth,rootWidth:document.querySelector('.cli-interfaces-page')?.getBoundingClientRect().width}`), null, 2)); await screenshot('failure'); } catch {}
  console.error(`Browser check failed; evidence: ${evidence}`); throw error;
}
finally { if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} } driver?.kill(); if (driver) await driver.exited; wrapper?.stop(true); await launcher?.stop(true); await f.close(); }
