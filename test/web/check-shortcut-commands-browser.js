// Real Firefox -> Host HTTP -> RPC -> SQLite/Git/Shell in an isolated temporary project.
// Run: bun run test/web/check-shortcut-commands-browser.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { request } from 'node:http';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';

const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-shortcut-browser-'));
const f = await setup(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
let driver, wrapper, session, success = false;
const assert = (ok, message) => { if (!ok) throw Error(message); };
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
async function rpc(suffix, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${suffix}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => text += part);
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(70000, () => req.destroy(Error('WebDriver timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = (condition, timeout = 10000) => rpc(`/session/${session}/execute/async`, {
  script: `const done=arguments[0],end=Date.now()+${timeout};const check=()=>(${condition})?done(true):Date.now()>end?done(false):setTimeout(check,100);check();`, args: [] });
async function click(selector) {
  await execute(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'});`);
  const node = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${node['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function frame() {
  const node = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' });
  await rpc(`/session/${session}/frame`, { id: node });
}
try {
  await repo(f.root); const main = await f.project.bootstrapMain();
  let commands = f.project.shortcutCommands();
  const saved = f.project.saveShortcutCommand({ name: '35秒真实执行', command: 'sleep 35; printf PRIVATE_OUTPUT; printf once >> .lush/browser-proof' }, commands.revision);
  const command = saved.commands.items.at(-1);
  f.project.authorizeShortcutCommand(command.id, command.version, true, f.project.shortcutCommands().revision);
  const fast = f.project.saveShortcutCommand({ name: '后续运行', command: 'printf once >> .lush/browser-fast-proof', default_worker_id: main.id }, f.project.shortcutCommands().revision).commands.items.at(-1);
  f.project.authorizeShortcutCommand(fast.id, fast.version, true, f.project.shortcutCommands().revision);
  const host = await (await fetch(f.url + '/api/host/projects')).json();
  const projectId = host.projects.find(item => item.project === f.root)?.id;
  assert(projectId, 'temporary project is not registered');
  // Firefox's outer-window minimum prevents a 320px real viewport. A fixture-only
  // same-origin proxy changes frame-ancestors to self; all other production CSP,
  // assets, fixed project paths and real HTTP/RPC execution remain unchanged.
  wrapper = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/fixture') return new Response(`<!doctype html><html><body style="margin:0"><iframe id="viewport" style="border:0;width:1440px;height:950px" src="/p/${projectId}/#hooks"></iframe></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    const body = req.method === 'POST' ? await req.text() : null;
    const upstream = await fetch(f.url + url.pathname + url.search, { method: req.method,
      ...(body !== null ? { headers: { 'Content-Type': 'application/json' }, body } : {}) });
    const headers = new Headers(upstream.headers);
    if (headers.has('content-security-policy')) headers.set('content-security-policy', headers.get('content-security-policy').replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
  } });
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' },
    stdout: Bun.file(path.join(evidence, 'driver.log')), stderr: Bun.file(path.join(evidence, 'driver.log')) });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100);
  }
  assert(ready, 'geckodriver did not start');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', timeouts: { script: 60000 }, 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1100 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${wrapper.port}/fixture` }); await frame();
  assert(await wait(`document.querySelector('.shortcut-run-command button')&&!document.querySelector('.shortcut-run-command button').disabled`), 'assembled UI/history did not become ready');
  assert(await execute(`return !document.querySelector('.shortcut-command-runs .shortcut-execution-history')&&!document.querySelector('.shortcut-command-runs').textContent.includes('编辑快捷指令')`), 'run module contains history or management actions');
  assert(await execute(`return !document.querySelector('.shortcut-command-management').textContent.includes('手动执行')&&document.querySelectorAll('.automation-module').length===7`), 'independent modules are missing');
  await execute(`Array.from(document.querySelectorAll('.shortcut-command-management button')).find(b=>b.textContent==='注册快捷指令').click()`);
  await execute(`document.querySelector('[aria-label="快捷指令名称"]').value='保留编辑草稿';document.querySelector('[aria-label="Shell 命令"]').value='printf draft';`);
  await click('[data-module="command-management"] .automation-module-toggle');
  const keyboardToggle = await rpc(`/session/${session}/element`, { using: 'css selector', value: '[data-module="command-management"] .automation-module-toggle' });
  await rpc(`/session/${session}/element/${keyboardToggle['element-6066-11e4-a52e-4f735466cecf']}/value`, { text: '\uE007' });
  assert(await wait(`document.querySelector('[data-module="command-management"] .automation-module-toggle').getAttribute('aria-expanded')==='true'`), 'Enter did not reopen module');
  assert(await execute(`return document.querySelector('[aria-label="快捷指令名称"]').value==='保留编辑草稿'`), 'collapse lost draft');
  await execute(`Array.from(document.querySelectorAll('.shortcut-command-management button')).find(b=>b.textContent==='取消指令编辑').click()`);
  // Exercise directory-only edits through the real form/API: null and main both
  // create new unauthorized versions; authorization remains a separate confirmation.
  const fastCard = `[data-command-id="${fast.id}"]`;
  await execute(`Array.from(document.querySelector(${JSON.stringify(fastCard)}).querySelectorAll('button')).find(b=>b.textContent==='编辑快捷指令').click()`);
  assert(await wait(`document.querySelector('[aria-label="默认执行目录 Worker"]')?.value===${JSON.stringify(String(main.id))}`), 'saved main default missing in management form');
  await execute(`document.querySelector('[aria-label="默认执行目录 Worker"]').value='';Array.from(document.querySelectorAll('.shortcut-command-editor button')).find(b=>b.textContent==='保存快捷指令').click()`);
  assert(await wait(`!document.querySelector('.shortcut-command-editor [aria-label="默认执行目录 Worker"]')`), 'clearing default did not save');
  assert(f.project.shortcutCommands().items.find(item => item.id === fast.id).default_worker_id === null, 'UI null default did not persist');
  assert(f.project.shortcutCommands().items.find(item => item.id === fast.id).version === 2 && !f.project.shortcutCommands().items.find(item => item.id === fast.id).authorized, 'directory edit failed to version/revoke');
  await execute(`Array.from(document.querySelector(${JSON.stringify(fastCard)}).querySelectorAll('button')).find(b=>b.textContent==='编辑快捷指令').click()`);
  assert(await wait(`Array.from(document.querySelector('[aria-label="默认执行目录 Worker"]')?.options||[]).some(o=>o.value===${JSON.stringify(String(main.id))})`), 'main directory candidate missing');
  await execute(`document.querySelector('[aria-label="默认执行目录 Worker"]').value=${JSON.stringify(String(main.id))};Array.from(document.querySelectorAll('.shortcut-command-editor button')).find(b=>b.textContent==='保存快捷指令').click()`);
  assert(await wait(`!document.querySelector('.shortcut-command-editor [aria-label="默认执行目录 Worker"]')`), 'main default did not save');
  assert(f.project.shortcutCommands().items.find(item => item.id === fast.id).version === 3 && !f.project.shortcutCommands().items.find(item => item.id === fast.id).authorized, 'main rebind failed to version/revoke');
  await execute(`Array.from(document.querySelector(${JSON.stringify(fastCard)}).querySelectorAll('button')).find(b=>b.textContent==='授权当前版本').click()`);
  assert(await wait(`document.querySelector('#modal .modal-actions button:last-child')`), 'version authorization confirmation missing'); await click('#modal .modal-actions button:last-child');
  assert(await wait(`Array.from(document.querySelector(${JSON.stringify(fastCard)}).querySelectorAll('button')).some(b=>b.textContent==='撤销授权'&&!b.disabled)`), 'new directory version was not separately authorized');
  await execute(`Array.from(document.querySelectorAll('.shortcut-run-command')).find(c=>c.textContent.includes('35秒真实执行')).querySelector('button').click()`);
  assert(await wait(`document.querySelector('[aria-label="执行目录 Worker"]')`), 'Worker picker unavailable');
  await execute(`document.querySelector('[aria-label="执行目录 Worker"]').value=${JSON.stringify(String(main.id))};`);
  await execute(`Array.from(document.querySelectorAll('.shortcut-run-editor button')).find(b=>b.textContent==='确认执行一次').click()`);
  assert(await wait(`document.querySelector('#modal .modal-actions button:last-child')`), 'confirmation unavailable');
  await click('#modal .modal-actions button:last-child');
  assert(await wait(`document.querySelector('.shortcut-execution')?.textContent.includes('执行中')`), 'submission did not return while Shell runs');
  const accepted = f.project.shortcutCommandHistory().items[0];
  assert(accepted?.status === 'running', 'persistent running identity missing');
  // Stay longer than the original 30s client budget, exercising UI polling and real exit status.
  assert(await wait(`document.querySelector('.shortcut-execution')?.textContent.includes('执行成功')`, 45000), '35s Shell was misreported or did not complete');
  const result = f.project.shortcutCommandHistory({ execution_id: accepted.id }).items[0];
  assert(result.status === 'succeeded' && result.command_result.exit_code === 0, '35s durable result is not success');
  assert(fs.readFileSync(path.join(f.config.home, 'browser-proof'), 'utf8') === 'once', 'mutation executed more than once');
  assert(!JSON.stringify(result).includes('PRIVATE_OUTPUT'), 'history leaked raw output');
  // A second deliberate run must use the revision changed by the first completion.
  await execute(`Array.from(document.querySelectorAll('.shortcut-run-command')).find(c=>c.textContent.includes('后续运行')).querySelector('button').click()`);
  assert(await wait(`document.querySelector('.shortcut-run-editor h3')?.textContent.includes('后续运行')&&document.querySelector('[aria-label="执行目录 Worker"]')`), 'second picker did not refresh directory');
  assert(await execute(`return document.querySelector('[aria-label="执行目录 Worker"]').value===${JSON.stringify(String(main.id))}`), 'saved default directory was not preselected');
  await execute(`Array.from(document.querySelectorAll('.shortcut-run-editor button')).find(b=>b.textContent==='确认执行一次').click();`);
  assert(await wait(`document.querySelector('#modal .modal-actions button:last-child')`), 'second confirmation unavailable');
  await click('#modal .modal-actions button:last-child');
  assert(await wait(`Array.from(document.querySelectorAll('.shortcut-execution')).some(c=>c.textContent.includes('后续运行')&&c.textContent.includes('执行成功'))`), 'second deliberate run used a stale revision');
  assert(fs.readFileSync(path.join(f.config.home, 'browser-fast-proof'), 'utf8') === 'once', 'second execution duplicated');
  await rpc(`/session/${session}/refresh`, {}); await frame();
  assert(await wait(`document.querySelector('.shortcut-execution')?.textContent.includes('执行成功')`), 'reload lost persistent result');
  for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null });
    await execute(`document.querySelector('#viewport').style.width='${width}px'`); await frame();
    await execute(`document.documentElement.dataset.theme='${theme}';`);
    for (const collapsed of [true, false]) {
      await execute(`document.querySelectorAll('.automation-module-toggle').forEach(button=>{if(button.getAttribute('aria-expanded')==='${collapsed}')button.click();});`);
      assert(await execute(`return innerWidth===${width}&&document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.automation-module-toggle')].every(b=>{const r=b.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;})`), `clipped layout ${theme}/${width}/collapsed${collapsed}`);
    }
    const image = await rpc(`/session/${session}/screenshot`, undefined, 'GET');
    fs.writeFileSync(path.join(evidence, `${theme}-${width}.png`), Buffer.from(image, 'base64'));
    console.log(`PASS real shortcut modules/history layout ${theme}/${width}px`);
  }
  const count = f.project.shortcutCommandHistory().items.length;
  assert(count === 2, 'unexpected extra mutations from reload/collapse');
  const audit = f.store.all("SELECT * FROM events WHERE type IN ('shortcut.command_pending','shortcut.command_started','shortcut.command_succeeded')");
  const authorizationRevision = f.project.shortcutCommands().revision;
  await execute(`document.querySelector('.shortcut-execution .history-remove').click()`);
  assert(await wait(`document.querySelector('#modal .modal-actions button:last-child')`), 'delete confirmation missing');
  assert(await execute(`return document.getElementById('modal').textContent.includes('保留安全审计')`), 'delete audit warning missing');
  await click('#modal .modal-actions button:last-child');
  assert(await wait(`document.querySelectorAll('.shortcut-execution').length===1`), 'real history delete did not reread list');
  await execute(`Array.from(document.querySelectorAll('.shortcut-execution-history button')).find(b=>b.textContent==='清空已结束记录').click()`);
  assert(await wait(`document.querySelector('#modal .modal-actions button:last-child')`), 'clear confirmation missing'); await click('#modal .modal-actions button:last-child');
  assert(await wait(`document.querySelectorAll('.shortcut-execution').length===0`), 'real history clear did not reread list');
  await rpc(`/session/${session}/refresh`, {}); await frame();
  assert(await wait(`document.querySelector('.shortcut-execution-records')?.textContent.includes('尚无运行记录')`), 'persistently deleted records reappeared on reload');
  assert(f.project.shortcutCommandHistory().items.length === 0, 'real history still contains removed records');
  assert(f.project.shortcutCommandHistory({ execution_id: accepted.id }).items.length === 0, 'exact UUID lookup resurrected removed record');
  assert(f.project.shortcutCommands().revision === authorizationRevision, 'history removal changed command authorization');
  for (const event of audit) assert(JSON.stringify(f.store.get('SELECT * FROM events WHERE id=?', event.id)) === JSON.stringify(event), 'history removal rewrote safety audit');
  assert(f.store.all("SELECT id FROM events WHERE type='shortcut.command_history_removed'").length === 2, 'removal safety audit missing');
  assert(f.store.all("SELECT key FROM meta WHERE key LIKE 'shortcut_command_history_removed:%'").length === 2, 'persistent history markers missing');
  success = true; console.log('PASS real default directory edits/version revocation/authorization/preselection, 35s Shell success, exact-once, UUID history, persistent delete/clear/reload with audit preservation, independent modules, keyboard, draft preservation and safe output');
} catch (error) {
  if (session) {
    try { fs.writeFileSync(path.join(evidence, 'failure-page.json'), JSON.stringify(await execute('return {url:location.href,html:document.documentElement.outerHTML};'))); } catch {}
    try { fs.writeFileSync(path.join(evidence, 'failure.png'), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64')); } catch {}
  }
  throw error;
} finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  if (driver) { driver.kill(); await driver.exited; }
  wrapper?.stop(true); await f.close();
  console.log(`${success ? 'Browser evidence' : 'Browser failure diagnostics'}: ${evidence}`);
}
