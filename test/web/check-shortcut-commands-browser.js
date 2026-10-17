// Real Firefox -> isolated Host/RPC/SQLite/Git. No manual execution API or real Agent.
// Run: bun run test/web/check-shortcut-commands-browser.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { request } from 'node:http';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
import { attachRegisteredHook } from '../hook-registry.js';

const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-command-management-browser-'));
const f = await setup(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
let driver, wrapper, session, success = false;
const mutations = [];
const assert = (ok, message) => { if (!ok) throw Error(message); };
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
async function rpc(suffix, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${suffix}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => text += part);
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(70000, () => req.destroy(Error('WebDriver timed out'))); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = (condition, timeout = 10000) => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0],end=Date.now()+${timeout};const check=()=>(${condition})?done(true):Date.now()>end?done(false):setTimeout(check,100);check();`, args: [] });
async function click(selector) {
  await execute(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'});`);
  const node = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${node['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
const press = label => execute(`Array.from(document.querySelectorAll('.hooks-page button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`);
async function navigate(page) { await click(`.page-subnav [data-subpage="${page}"]`); assert(await wait(`location.hash===${JSON.stringify(page === 'commands' ? '#hooks-commands' : page === 'history' ? '#hook-tools-history' : '#hook-tools')}`), 'subpage route missing'); }
async function frame() { const node = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: node }); }
try {
  await repo(f.root); const main = await f.project.bootstrapMain();
  const command = f.project.saveShortcutCommand({ name: 'Hook 专用测试', command: 'printf PRIVATE_OUTPUT', default_worker_id: main.id }, f.project.shortcutCommands().revision).commands.items.at(-1);
  attachRegisteredHook(f.project, main.id, { name: '安全历史测试', trigger: 'worker.merge_received', mode: 'persistent', enabled: true, actions: [{ type: 'command', command_id: command.id }] });
  for (let n = 0; n < 2; n++) { f.project.emitTaskHook(main.id, 'worker.merge_received', f.store.event(main.id, 'test.browser_merge', {})); await f.project.hookQueue; }
  const historical = f.project.shortcutCommandHistory().items;
  assert(historical.length === 2 && historical.every(row => row.status === 'succeeded' && row.source === 'hook'), 'Hook history setup failed');
  const audit = f.store.all("SELECT * FROM events WHERE type IN ('shortcut.command_pending','shortcut.command_started','shortcut.command_succeeded')");
  const host = await (await fetch(f.url + '/api/host/projects')).json(), projectId = host.projects.find(item => item.project === f.root)?.id;
  assert(projectId, 'temporary project not registered');
  // Fixture-only frame-ancestors self permits a real 320px viewport; production assets/routes stay unchanged.
  wrapper = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/fixture') return new Response(`<!doctype html><html><body style="margin:0"><iframe id="viewport" style="border:0;width:1440px;height:950px" src="/p/${projectId}/#hooks-commands"></iframe></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    const body = req.method === 'POST' ? await req.text() : null;
    if (url.pathname.endsWith('/api/action') && body) mutations.push(JSON.parse(body));
    const upstream = await fetch(f.url + url.pathname + url.search, { method: req.method, ...(body !== null ? { headers: { 'Content-Type': 'application/json' }, body } : {}) });
    const headers = new Headers(upstream.headers);
    if (headers.has('content-security-policy')) headers.set('content-security-policy', headers.get('content-security-policy').replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
  } });
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(evidence, 'driver.log')), stderr: Bun.file(path.join(evidence, 'driver.log')) });
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {} if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100); }
  assert(ready, 'geckodriver did not start');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', timeouts: { script: 60000 }, 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1100 }); await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${wrapper.port}/fixture` }); await frame();
  assert(await wait(`document.querySelector('.shortcut-directory .ui-list-entry')`), 'management deep link not ready');
  assert(await execute(`return document.querySelector('.shortcut-command-detail-page').hidden&&!document.querySelector('.shortcut-run-module')&&!document.querySelector('[aria-label="默认执行目录 Worker"]')`), 'list-only management or manual retirement failed');
  const pick = `.shortcut-directory-pick[data-command-id="${command.id}"]`;
  // Real keyboard activation and back preserve submitted filter and selected row.
  await execute(`const s=document.querySelector('[aria-label="查找管理指令"]');s.value='Hook 专用';s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
  const keyboardPick = await rpc(`/session/${session}/element`, { using: 'css selector', value: pick }); await rpc(`/session/${session}/element/${keyboardPick['element-6066-11e4-a52e-4f735466cecf']}/value`, { text: '\uE007' });
  assert(await wait(`!document.querySelector('.shortcut-command-detail-page').hidden`), 'keyboard list selection failed');
  await press('编辑快捷指令'); await execute(`document.querySelector('[aria-label="Shell 命令"]').value='printf draft > latest-hook.txt';`);
  await press('返回指令列表'); await navigate('settings'); await navigate('history'); assert(await wait(`document.querySelectorAll('.shortcut-execution').length===2`), 'Hook history missing'); await navigate('commands'); await press('继续指令编辑');
  assert(await execute(`return document.querySelector('[aria-label="Shell 命令"]').value==='printf draft > latest-hook.txt'&&document.querySelector('[aria-label="查找管理指令"]').value==='Hook 专用'`), 'subpage/list transition lost draft or search');
  await press('保存快捷指令'); assert(await wait(`!document.querySelector('.shortcut-command-editor [aria-label="Shell 命令"]')`), 'save failed');
  const saved = f.project.shortcutCommands().items.find(item => item.id === command.id);
  assert(saved.version === 2 && !Object.hasOwn(saved, 'authorized') && saved.default_worker_id === main.id, 'version or old-default preservation failed');
  assert(!mutations.find(call => call.method === 'hooks.command_save').params.command.hasOwnProperty('default_worker_id'), 'retired default sent by UI');
  assert(await execute(`return !document.querySelector('.command-authorize,.command-revoke,[aria-label="查找管理指令授权"]')`), 'retired authorization controls remain');
  assert(f.project.taskHooks(main.id).mounts.find(m => m.name === '安全历史测试').enabled, 'editing disabled the existing Hook');
  f.project.emitTaskHook(main.id, 'worker.merge_received', f.store.event(main.id, 'test.browser_merge', {})); await f.project.hookQueue;
  assert(fs.readFileSync(path.join(f.root, 'latest-hook.txt'), 'utf8') === 'draft', 'existing Hook did not execute latest edited body');
  assert(f.project.shortcutCommandHistory().items[0].command_version === 2, 'actual execution version was not recorded');
  // Runtime execution updates commands.revision; explicitly refresh before another edit.
  assert(await rpc(`/session/${session}/execute/async`, { script: "const done=arguments[0];Array.from(document.querySelectorAll('.hooks-page button')).find(b=>b.textContent==='刷新目录').onclick().then(()=>done(true),()=>done(false));", args: [] }), 'directory refresh after execution failed');
  await press('返回指令列表'); await press('注册快捷指令');
  await execute(`document.querySelector('[aria-label="快捷指令名称"]').value='交付审查';const type=document.querySelector('[aria-label="指令类型"]');type.value='prompt';type.dispatchEvent(new Event('change'));document.querySelector('[aria-label="提示词正文"]').value='Review project changes';document.querySelector('[aria-label="作用说明"]').value='审查项目变更';document.querySelector('[aria-label="标签（每行一个）"]').value='review\\n交付';`);
  await press('保存快捷指令'); assert(await wait(`!document.querySelector('.shortcut-command-editor [aria-label="快捷指令名称"]')`), 'prompt save failed');
  const prompt = f.project.shortcutCommands().items.find(item => item.name === '交付审查'); assert(prompt?.kind === 'prompt' && !Object.hasOwn(prompt, 'authorized') && prompt.tags.join(',') === 'review,交付', 'prompt metadata incorrect');
  await press('导出 Markdown'); assert(await wait(`document.querySelector('.shortcut-command-editor a[download]')`), 'export missing'); assert(await execute(`return document.querySelector('.shortcut-command-editor pre').textContent.includes('kind: "prompt"')&&!document.querySelector('.shortcut-command-detail .agent-call')`), 'export or non-Agent editing incorrect');
  await press('返回指令列表');
  // Text drafts cannot leak into immediate type filters; IME Enter cannot submit.
  await execute(`const input=document.querySelector('[aria-label="查找管理指令"]');Array.from(input.closest('.ui-list-tools').querySelectorAll('button')).find(b=>b.textContent==='清空').click();input.value='zero-match';input.dispatchEvent(new CompositionEvent('compositionstart'));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));const type=document.querySelector('[aria-label="查找管理指令类型"]');type.value='prompt';type.dispatchEvent(new Event('change'));`);
  assert(await execute(`return document.querySelectorAll('.shortcut-directory-pick').length===1`), 'draft or IME incorrectly applied');
  await execute(`const input=document.querySelector('[aria-label="查找管理指令"]');input.dispatchEvent(new CompositionEvent('compositionend'));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`); assert(await execute(`return document.querySelectorAll('.shortcut-directory-pick').length===0`), 'submitted query not applied');
  await execute(`Array.from(document.querySelectorAll('.shortcut-directory button')).find(b=>b.textContent==='清空').click();`);
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame(); await execute(`document.documentElement.dataset.theme='${theme}';`);
    for (const subpage of ['commands', 'settings', 'history']) {
      await navigate(subpage); assert(await execute(`return innerWidth===${width}&&document.documentElement.scrollWidth<=innerWidth`), `overflow ${theme}/${width}/${subpage}`);
      fs.writeFileSync(path.join(evidence, `${theme}-${width}-${subpage}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
      if (subpage === 'commands') {
        await click(`.shortcut-directory-pick[data-command-id="${prompt.id}"]`); await press('编辑快捷指令');
        assert(await execute(`return document.documentElement.scrollWidth<=innerWidth&&!document.querySelector('.shortcut-command-editor .agent-call')&&document.querySelector('.shortcut-command-detail').hidden`), `editor overflow or duplicate detail ${theme}/${width}`);
        fs.writeFileSync(path.join(evidence, `${theme}-${width}-editor.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
        await press('取消指令编辑'); await press('返回指令列表');
      }
    }
    console.log(`PASS list/settings/history layout ${theme}/${width}px`);
  }
  await press('刷新运行记录'); assert(await wait(`document.querySelectorAll('.shortcut-execution').length===3`), 'latest execution missing from refreshed history');
  await press('删除运行记录'); assert(await wait(`document.querySelector('#modal .modal-confirm')`), 'history delete confirmation missing'); await click('#modal .modal-confirm'); assert(await wait(`document.querySelectorAll('.shortcut-execution').length===2`), 'history delete failed');
  await press('清空已结束记录'); assert(await wait(`document.querySelector('#modal .modal-confirm')`), 'history clear confirmation missing'); await click('#modal .modal-confirm'); assert(await wait(`document.querySelectorAll('.shortcut-execution').length===0`), 'history clear failed');
  await navigate('commands'); await execute(`const type=document.querySelector('[aria-label="查找管理指令类型"]');type.value='';type.dispatchEvent(new Event('change'));`); await click(`.shortcut-directory-pick[data-command-id="${prompt.id}"]`); await press('删除快捷指令'); assert(await wait(`document.querySelector('#modal .modal-confirm')`), 'definition delete confirmation missing'); await click('#modal .modal-confirm'); assert(await wait(`document.querySelector('.shortcut-command-detail-page').hidden`), 'delete did not return to list');
  assert(!f.project.shortcutCommands().items.some(item => item.id === prompt.id), 'definition not removed');
  await rpc(`/session/${session}/refresh`, {}); await frame(); assert(await wait(`document.querySelector('.shortcut-directory-pick')`), 'command deep link did not reload'); await navigate('history'); assert(await wait(`document.querySelector('.shortcut-execution-records')?.textContent.includes('尚无运行记录')`), 'deleted history reappeared');
  assert(f.project.shortcutCommandHistory().items.length === 0, 'history removal not durable');
  for (const event of audit) assert(JSON.stringify(f.store.get('SELECT * FROM events WHERE id=?', event.id)) === JSON.stringify(event), 'safety audit rewritten');
  assert(!mutations.some(call => ['hooks.command_start', 'hooks.command_run', 'hooks.command_authorize'].includes(call.method)), 'retired manual or authorization mutation submitted');
  fs.writeFileSync(path.join(evidence, 'mutations.json'), JSON.stringify(mutations, null, 2));
  success = true; console.log('PASS independent command page/list/detail/back, draft/search retention, keyboard/IME, metadata, default data retention, latest-definition execution with actual version history, absent authorization controls, export/delete, durable Hook history deletion with preserved audit; no manual/authorization mutation or Agent call');
} catch (error) {
  if (session) {
    try { fs.writeFileSync(path.join(evidence, 'failure-page.json'), JSON.stringify(await execute('return {url:location.href,html:document.documentElement.outerHTML};'))); } catch {}
    try { fs.writeFileSync(path.join(evidence, 'failure.png'), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64')); } catch {}
  }
  throw error;
} finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  if (driver) { driver.kill(); await driver.exited; } wrapper?.stop(true); await f.close(); console.log(`${success ? 'Browser evidence' : 'Browser failure diagnostics'}: ${evidence}`);
}
