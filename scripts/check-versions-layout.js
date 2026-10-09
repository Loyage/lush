// Firefox + real Git/Project read-model smoke test; no user services or Agent calls.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fixture, git, repo } from '../test/helpers.js';

const f = fixture(), logs = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-versions-browser-'));
const output = path.resolve(process.argv[2] || path.join(logs, 'screenshots'));
fs.mkdirSync(output, { recursive: true });
const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
let server, driver, session, base, tree, head, reads = 0, passed = false;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function rpc(route, body, method = 'POST') {
  // Loopback requests must not inherit outbound proxies.
  const data = await new Promise((resolve, reject) => {
    const request = http.request(base + route, { method, headers: { 'Content-Type': 'application/json' } }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) request.destroy(new Error('WebDriver response too large')); else chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(30000, () => request.destroy(new Error('WebDriver timeout')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const value = JSON.parse(data.text);
  if (data.status >= 400) throw new Error(JSON.stringify(value));
  return value.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
async function waitFor(expression) {
  assert(await rpc(`/session/${session}/execute/async`, { args: [], script: `const done=arguments[0];let n=0;const check=()=>{try{if(${expression})return done(true)}catch{}if(++n>200)return done(false);setTimeout(check,50)};check();` }), `Timed out: ${expression}`);
}
async function click(selector) {
  const node = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${node['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function screenshot(name) {
  fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
}
async function commit(subject) {
  head = await git(f.root, 'commit-tree', tree, '-p', head, '-m', subject);
  await git(f.root, 'update-ref', 'refs/heads/main', head);
  return head;
}
try {
  await repo(f.root); const main = await f.project.bootstrapMain();
  head = await git(f.root, 'rev-parse', 'HEAD'); tree = await git(f.root, 'rev-parse', 'HEAD^{tree}');
  const task = f.store.create({ role: 'agent', task_kind: 'order', parent_id: main.id, goal: '版本迭代 · 长目标验证 '.repeat(12) });
  f.store.run('INSERT INTO inputs(id,content,task_id) VALUES (?,?,?)', 1, '原始需求：\n保留换行与 <script>window.injected=true</script>\n' + 'LongText'.repeat(50), task.id);
  f.store.run('UPDATE tasks SET input_id=1, target_branch=? WHERE id=?', 'main', task.id);
  for (let i = 1; i <= 52; i++) {
    const sha = await commit(`功能交付 ${i} · ${'long-subject-'.repeat(i === 52 ? 20 : 1)}`);
    if (i % 2 === 0) f.store.event(task.id, 'task.merge_integrated', { commit: sha, parent_id: main.id });
  }
  const initial = head;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/assets/styles.css"><link rel="stylesheet" href="/assets/styles-core.css"><link rel="stylesheet" href="/assets/styles-versions.css"></head>
  <body><div id="detail"></div><script type="module">
  window.browserErrors=[];addEventListener('error',e=>browserErrors.push(e.message));addEventListener('unhandledrejection',e=>browserErrors.push(String(e.reason)));
  import {openVersions} from '/assets/render-versions.js';import {registerNavigation} from '/assets/navigate.js';
  registerNavigation({detail:id=>{window.openedTask=id;}});await openVersions();window.ready=true;
  </script></body></html>`;
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    if (/^\/assets\/[\w.-]+\.(js|css)$/.test(url.pathname)) return new Response(Bun.file(path.join(assets, path.basename(url.pathname))));
    if (url.pathname === '/api/versions') {
      reads++;
      try { return Response.json(await f.project.branchHistory({ limit: Number(url.searchParams.get('limit')), ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}) })); }
      catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
    }
    return new Response('not found', { status: 404 });
  } });
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = reservation.port; reservation.stop(true); base = `http://127.0.0.1:${port}`;
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(logs, 'driver.log')), stderr: Bun.file(path.join(logs, 'driver.log')) });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited during startup');
    await Bun.sleep(100);
  }
  assert(ready, 'WebDriver startup timeout');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` }); await waitFor('window.ready');
  assert(await execute('return document.querySelectorAll(".version-commit").length===50'), 'first page must contain 50 commits');
  assert(await execute(`return !document.querySelector('.versions-mode input').checked && document.querySelector('.version-input').hidden && document.querySelector('.version-sha').hidden`), 'default must be compact');
  const firstReads = reads;
  const compactHeight = await execute(`return document.querySelector('.versions-list').getBoundingClientRect().height`);
  await click('.versions-mode input');
  assert(await execute(`return !document.querySelector('.version-input').hidden && !document.querySelector('.version-sha').hidden`), 'detail mode did not reveal metadata');
  const detailedHeight = await execute(`return document.querySelector('.versions-list').getBoundingClientRect().height`);
  assert(compactHeight < detailedHeight * 0.6, `compact history is not dense enough: ${compactHeight}/${detailedHeight}`);
  await click('.version-input summary'); await click('.version-task-link');
  assert(await execute(`return window.openedTask===${task.id} && !window.injected && document.querySelector('.version-order').textContent.includes('<script>')`), 'Worker navigation or safe original order rendering failed');
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1440,900], [900,700], [390,844]]) for (const detailed of [false, true]) {
    if (await execute(`return document.querySelector('.versions-mode input').checked !== ${detailed}`)) await click('.versions-mode input');
    await rpc(`/session/${session}/window/rect`, { width, height });
    await execute(`document.documentElement.dataset.theme='${theme}';document.querySelector('#detail').scrollTop=0;window.scrollTo(0,0);`);
    const layout = await execute(`const c=document.querySelector('.version-commit'),p=document.querySelector('.versions-page'),r=c.getBoundingClientRect();return {width:innerWidth,left:r.left,right:r.right,card:c.scrollWidth-c.clientWidth,page:p.scrollWidth-p.clientWidth,overflow:document.documentElement.scrollWidth-innerWidth};`);
    assert(layout.left >= 0 && layout.right <= layout.width + 1 && layout.card <= 1 && layout.page <= 1 && layout.overflow <= 1, `layout overflow ${theme}/${width}: ${JSON.stringify(layout)}`);
    assert(await execute(`return document.querySelector('.version-input').open && document.querySelector('.version-input').hidden === ${!detailed} && getComputedStyle(document.querySelector('.version-sha')).display ${detailed ? '!==' : '==='} 'none'`), 'detail visibility or original order expansion was lost');
    await screenshot(`${theme}-${width}-${detailed ? 'detailed' : 'compact'}`); console.log(`PASS versions layout ${theme}/${width}/${detailed ? 'detailed' : 'compact'}`);
  }
  assert(reads === firstReads, 'mode changes must not refetch history');
  await commit('new main commit after first page');
  await click('.versions-more'); await waitFor('document.querySelectorAll(".version-commit").length===53');
  assert(await execute(`return document.querySelector('.version-tip').textContent.includes('${initial}') && !document.querySelector('.versions-list').textContent.includes('new main commit') && [...document.querySelectorAll('.version-detail')].every(n=>!n.hidden)`), 'pagination did not preserve initial tip or detail mode');
  await click('.versions-mode input');
  await click('.versions-refresh'); await waitFor('document.querySelector(".versions-list").textContent.includes("new main commit")');
  assert(await execute(`return document.querySelectorAll('.version-commit').length===50 && document.querySelector('.version-tip').textContent.includes('${head}') && !document.querySelector('.versions-mode input').checked && [...document.querySelectorAll('.version-detail')].every(n=>n.hidden)`), 'refresh did not replace snapshot or preserve compact mode');
  assert((await git(f.root, 'rev-parse', 'HEAD')) === head, 'read changed main');
  assert(await execute('return window.browserErrors.length===0'), 'browser emitted errors');
  passed = true; console.log(`PASS real Git paging, fixed tip, explicit refresh, safe order and Worker navigation. Screenshots: ${output}`);
} catch (error) {
  if (session) await screenshot('failure').catch(() => {});
  console.error(`Version browser failure; full logs: ${logs}`); throw error;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  if (driver) { driver.kill(); await driver.exited; }
  server?.stop(true); await f.close();
  if (passed) fs.rmSync(path.join(logs, 'driver.log'), { force: true });
}
