// Production Web → RPC → Project → SQLite/Git + Firefox. Only isolated temporary services.
// Run: bun run scripts/check-versions-layout.js [screenshot-directory]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { git, repo } from '../test/helpers.js';
import { setup } from '../test/web/harness.js';
import { projectRouteId } from '../src/host/registry.js';

const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-worker-versions-browser-'));
const output = path.resolve(process.argv[2] || path.join(logs, 'screenshots'));
fs.mkdirSync(output, { recursive: true });
let f, driver, session, base, passed = false;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function rpc(route, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const request = http.request(base + route, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) request.destroy(new Error('WebDriver response too large')); else chunks.push(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() })); res.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(30000, () => request.destroy(new Error('WebDriver timeout')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const value = JSON.parse(response.text);
  if (response.status >= 400) throw new Error(JSON.stringify(value)); return value.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
async function waitFor(expression) {
  assert(await rpc(`/session/${session}/execute/async`, { args: [], script: `const done=arguments[0];let n=0;const check=()=>{try{if(${expression})return done(true)}catch{}if(++n>300)return done(false);setTimeout(check,30)};check();` }), `Timed out: ${expression}`);
}
async function click(selector) {
  const node = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${node['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function screenshot(name) {
  fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
}
async function commit(task, file, message) {
  fs.writeFileSync(path.join(task.workspace, file), message);
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', message);
  return git(task.workspace, 'rev-parse', 'HEAD');
}
async function deliver(task) {
  f.store.update(task.id, { status: 'waiting', result: '专项验证完成' });
  f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', task.id);
  await f.project.reserveTask(task.id, 'merge'); f.project.stopping = false; await f.project.driveTaskMerge(task.parent_id);
  assert(f.store.task(task.id).integration === 'merged', `fixture delivery failed ${task.id}`);
  return f.store.get("SELECT id,data FROM events WHERE task_id=? AND type='task.merge_integrated' ORDER BY id DESC LIMIT 1", task.id);
}
try {
  f = await setup({ auth: { version: 2, username: 'browser-fixture', password: 'temporary-browser-fixture-password' } });
  f.project.stopping = true; f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root);
  const { task } = await f.project.order('真实版本详情\n<script>window.injected=true</script>\n' + 'LongInput'.repeat(100));
  await commit(task, 'first.txt', '第一轮开发\n\n完整提交消息'); const firstDelivery = await deliver(task);
  await git(task.workspace, 'merge', 'main', '-m', '同步上轮落点');
  let head = await git(task.workspace, 'rev-parse', 'HEAD'); const tree = await git(task.workspace, 'rev-parse', 'HEAD^{tree}');
  for (let i = 0; i < 95; i++) head = await git(task.workspace, 'commit-tree', tree, '-p', head, '-m', `本轮已提交开发 ${i}`);
  await git(task.workspace, 'update-ref', `refs/heads/${task.branch}`, head);
  // A real fork/join, not association edges fabricated as Git parents.
  const side = await git(task.workspace, 'commit-tree', tree, '-p', head, '-m', '真实侧线开发');
  const mainSide = await git(task.workspace, 'commit-tree', tree, '-p', head, '-m', '真实主线开发');
  head = await git(task.workspace, 'commit-tree', tree, '-p', mainSide, '-p', side, '-m', '真实双父汇合');
  await git(task.workspace, 'update-ref', `refs/heads/${task.branch}`, head);
  const child = await f.project.spawn(task.id, '子 Worker 实际交付，保留持久编号');
  await commit(child, 'child.txt', '子 Worker 开发一');
  await commit(child, 'child.txt', '子 Worker 开发二\n\n完整消息 <script>window.injected=true</script>');
  const childDelivery = await deliver(child), childLanding = JSON.parse(childDelivery.data).commit;
  const fixedTip = await git(task.workspace, 'rev-parse', 'HEAD');
  const projectPath = `/p/${projectRouteId(f.root)}/`;
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = reservation.port; reservation.stop(true); base = `http://127.0.0.1:${port}`;
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(logs, 'driver.log')), stderr: Bun.file(path.join(logs, 'driver.log')) });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited'); await Bun.sleep(100);
  }
  assert(ready, 'WebDriver startup timeout');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  await rpc(`/session/${session}/url`, { url: `${f.url}/login?next=${encodeURIComponent(projectPath)}` });
  await execute(`document.querySelector('#username').value='browser-fixture';document.querySelector('#password').value='temporary-browser-fixture-password';`);
  await click('form button'); await waitFor(`location.pathname==='${projectPath}' && !!document.querySelector('#overview-open')`);
  // Instrument only reads; all responses still come from the actual production HTTP/RPC bridge.
  await execute(`window.versionReads=[];window.browserErrors=[];addEventListener('error',e=>browserErrors.push(e.message));addEventListener('unhandledrejection',e=>browserErrors.push(String(e.reason)));const original=window.fetch;window.fetch=(url,options)=>{if(String(url).includes('/version-'))versionReads.push(String(url));return original(url,options)};location.hash='#worker-${task.id}';`);
  await waitFor(`document.querySelector('.worker-versions')?.dataset.workerId==='${task.id}'`);
  assert(await execute(`return !versionReads.some(p=>p.includes('/version-graph')) && !versionReads.some(p=>p.includes('/version-deliveries'))`), 'detail entry eagerly read Git or delivery list');
  await execute(`document.querySelector('.worker-versions').scrollIntoView({block:'start'});`);
  await waitFor('document.querySelectorAll(".version-commit").length===30');
  assert(await execute(`return document.querySelector('.version-tip').textContent.includes('${fixedTip}') && !document.querySelector('.version-input')`), 'current fixed tip or lazy node contract failed');
  assert(await execute(`return document.querySelector('.version-commit[data-commit="${childLanding}"] .version-task-link').getAttribute('href')==='#worker-${child.id}' && document.querySelector('.version-task-link').textContent.includes('${child.worker_number}')`), 'child href/number is not persistent');
  await execute(`document.querySelector('.version-node').focus();`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  await waitFor('!!document.querySelector(".version-node-detail .version-message")');
  assert(await execute(`return versionReads.filter(p=>p.includes('/version-commit')).length===1 && !window.injected && !!document.querySelector('.version-node-detail .version-sha') && document.activeElement===document.querySelector('.version-node-detail')`), 'keyboard node detail was not lazy, focused or safe');
  await execute(`document.querySelector('.version-node-detail').scrollIntoView({block:'start'});`);
  await screenshot('worker-current-node');
  // Several forward pages and a cache miss on the return path: DOM/data stay bounded.
  for (let index = 2; index <= 4; index++) {
    await click('.versions-more'); await waitFor(`document.querySelector('.versions-feedback').textContent.includes('第 ${index} 页')`);
    assert(await execute(`return document.querySelectorAll('.version-commit').length<=30 && Number(document.querySelector('.worker-versions').dataset.cachedPages)<=3`), 'graph/cache accumulated unbounded nodes');
  }
  const fixedTree = await git(task.workspace, 'rev-parse', 'HEAD^{tree}');
  const advancedTip = await git(task.workspace, 'commit-tree', fixedTree, '-p', fixedTip, '-m', '首次取样后新增提交');
  await git(task.workspace, 'update-ref', `refs/heads/${task.branch}`, advancedTip);
  for (let index = 3; index >= 1; index--) { await click('.versions-newer'); await waitFor(`document.querySelector('.versions-feedback').textContent.includes('第 ${index} 页')`); }
  assert(await execute(`return document.querySelector('.version-tip').textContent.includes('${fixedTip}') && !document.querySelector('.versions-list').textContent.includes('首次取样后新增提交')`), 'return to first page silently re-sampled the advanced current ref');
  await screenshot('worker-first-page-return');
  await click(`.version-commit[data-commit="${childLanding}"] .version-delivery-choice`);
  await waitFor(`document.querySelector('.versions-scope').textContent.includes('Event ${childDelivery.id}') && document.querySelectorAll('.version-commit').length===2`);
  assert(await execute(`return versionReads.at(-1).includes('/worker/${child.id}/version-graph?limit=30&delivery=${childDelivery.id}') && document.querySelector('.versions-list').textContent.includes('子 Worker 开发一')`), 'real child delivery drilldown failed');
  await click('.version-node'); await waitFor('!!document.querySelector(".version-input")');
  assert(await execute(`return document.querySelector('.version-message').textContent.includes('<script>') && !window.injected`), 'full message did not render safely');
  await execute(`document.querySelector('.version-node-detail').scrollIntoView({block:'start'});`);
  await screenshot('child-fixed-delivery');
  await click('.versions-back'); await waitFor('document.querySelectorAll(".version-commit").length===30');
  await click('.version-rounds summary'); await waitFor('!!document.querySelector(".version-round button")');
  assert(await execute(`return versionReads.filter(p=>p.includes('/version-deliveries')).length===1`), 'delivery selector fetched more than its explicit first page');
  await click('.version-round button'); await waitFor(`document.querySelector('.versions-scope').textContent.includes('Event ${firstDelivery.id}') && document.querySelectorAll('.version-commit').length===1`);
  await screenshot('worker-earlier-delivery');
  await click('.versions-back'); await waitFor('document.querySelectorAll(".version-commit").length===30');
  await execute(`document.querySelector('.version-rounds').open=false;`);
  await click('.version-node'); await waitFor('!!document.querySelector(".version-node-detail .version-message")');
  // Real page layout in both themes, including detail expansion. Firefox has a 500px top-level
  // minimum, so a same-origin srcdoc clone supplies a genuine 390px browsing context below.
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 500]) {
    await rpc(`/session/${session}/window/rect`, { width, height: 900 });
    await execute(`document.documentElement.dataset.theme='${theme}';document.querySelector('.worker-versions').scrollIntoView({block:'start'});`);
    const layout = await execute(`const p=document.querySelector('.worker-versions'),r=p.getBoundingClientRect();return {width:innerWidth,left:r.left,right:r.right,module:p.scrollWidth-p.clientWidth,page:document.documentElement.scrollWidth-innerWidth};`);
    assert(layout.left >= 0 && layout.right <= layout.width + 1 && layout.module <= 1 && layout.page <= 1, `overflow ${theme}/${width}: ${JSON.stringify(layout)}`);
    await screenshot(`${theme}-${width}-detail`); console.log(`PASS actual Worker detail layout ${theme}/${layout.width}`);
  }
  await rpc(`/session/${session}/window/rect`, { width: 600, height: 1000 });
  for (const theme of ['light', 'dark']) {
    await execute(`const previous=document.querySelector('#narrow-check');previous?.remove();const frame=document.createElement('iframe');frame.id='narrow-check';frame.width=390;frame.height=844;frame.style.cssText='position:fixed;inset:0;z-index:99999;border:0';document.body.append(frame);const doc=frame.contentDocument;doc.open();doc.write('<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:12px"><div id="detail"></div></body></html>');doc.close();for(const sheet of document.querySelectorAll('link[rel="stylesheet"]'))doc.head.append(sheet.cloneNode(true));doc.querySelector('#detail').append(document.querySelector('.worker-versions').cloneNode(true));`);
    await waitFor(`document.querySelector('#narrow-check').contentDocument.querySelector('.worker-versions').getBoundingClientRect().width>0`);
    const narrow = await execute(`const frame=document.querySelector('#narrow-check'),d=frame.contentDocument,p=d.querySelector('.worker-versions');return {width:frame.contentWindow.innerWidth,module:p.scrollWidth-p.clientWidth,page:d.documentElement.scrollWidth-frame.contentWindow.innerWidth};`);
    assert(narrow.width === 390 && narrow.module <= 1 && narrow.page <= 1, `390px overflow ${theme}: ${JSON.stringify(narrow)}`);
    await screenshot(`${theme}-390-detail`); console.log(`PASS genuine 390px module layout ${theme} (production DOM/CSS clone)`);
  }
  await execute(`document.querySelector('#narrow-check').remove();`);
  // Native href navigation reaches the actual child's inspect reader; no surrogate button callback.
  await click(`.version-commit[data-commit="${childLanding}"] .version-task-link`);
  await waitFor(`location.hash==='#worker-${child.id}' && document.querySelector('#detail').dataset.taskId==='${child.id}'`);
  assert(await execute(`return document.querySelector('.task-hero').textContent.includes('${child.worker_number}')`), 'native child link did not reach real child detail');
  await screenshot('child-worker-detail-link');
  // The retired bookmark resolves main from real overview identity and navigates
  // to its actual detail; it must not rebuild the retired independent version page.
  await execute(`location.hash='#versions';`);
  await waitFor(`location.hash==='#worker-${task.parent_id}' && document.querySelector('#detail').dataset.taskId==='${task.parent_id}' && !!document.querySelector('.worker-versions')`);
  await screenshot('legacy-version-main-detail');
  const parentRead = await f.project.workerVersionGraph({ id: task.id }); assert(parentRead.tip === advancedTip, 'browser reads wrote Git');
  assert(await execute('return browserErrors.length===0'), 'browser emitted errors');
  fs.writeFileSync(path.join(logs, 'evidence.json'), JSON.stringify({ task: task.worker_number, child: child.worker_number, fixedTip, advancedTip, firstDelivery: firstDelivery.id, childDelivery: childDelivery.id,
    reads: await execute('return versionReads'), browserErrors: await execute('return browserErrors'), screenshots: output }, null, 2));
  passed = true;
  console.log(`PASS production Worker detail → 30-node paging/cache return → lazy commit → child fixed delivery → native child detail; delivery selector; double themes/390px. Screenshots: ${output}; logs: ${logs}`);
} catch (error) {
  if (session) await screenshot('failure').catch(() => {});
  console.error(`Worker version browser failure; full logs: ${logs}`); throw error;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  if (driver) { driver.kill(); await driver.exited; }
  await f?.close();
  console.log(`${passed ? 'PASS' : 'FAIL'} evidence directory: ${logs}`);
}
