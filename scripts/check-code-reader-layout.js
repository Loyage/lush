// Real browser + real Git read-model integration, isolated from every user project/service.
// Requires Firefox and geckodriver. Screenshots remain; all owned processes/projects are cleaned up.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fixture, git, repo } from '../test/helpers.js';

const f = fixture();
const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-code-browser-'));
const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'lush-code-reader-screenshots'));
fs.mkdirSync(output, { recursive: true });
const driverLog = path.join(logs, 'geckodriver.log');
const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const counts = { state: 0, tree: 0, file: 0 };
const errors = [];
let server, driver, session, base, passed = false;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function rpc(route, body, method = 'POST') {
  // node:http deliberately ignores inherited outbound proxies for this loopback-only fixture.
  return new Promise((resolve, reject) => {
    const request = http.request(base + route, { method, headers: { 'Content-Type': 'application/json' } }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) request.destroy(new Error('WebDriver response exceeded fixture limit'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode >= 400) reject(new Error(JSON.stringify(value))); else resolve(value.value);
        } catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(30000, () => request.destroy(new Error('WebDriver timeout')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const waitFor = async (expression, label) => {
  const value = await rpc(`/session/${session}/execute/async`, { args: [], script: `
    const done=arguments[0]; let tries=0; const check=()=>{try {if(${expression})return done(true);}catch{}
      if(++tries>200)return done(false);setTimeout(check,50);};check();` });
  if (!value) throw new Error(`Timed out: ${label}\n${await execute('return document.body.innerText;')}`);
};
async function click(selector) {
  const node = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${node['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function clickText(text) {
  const selector = await execute(`const node=[...document.querySelectorAll('button')].find(n=>n.textContent===${JSON.stringify(text)}&&!n.closest('[hidden]'));
    if(!node)throw new Error('Missing button');node.dataset.browserClick='target';return '[data-browser-click="target"]';`);
  await click(selector); await execute(`document.querySelector('[data-browser-click="target"]')?.removeAttribute('data-browser-click');`);
}
async function screenshot(name) {
  const raw = await rpc(`/session/${session}/screenshot`, undefined, 'GET');
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(raw, 'base64'));
}
try {
  await repo(f.root);
  fs.mkdirSync(path.join(f.root, 'src'));
  const oldCode = ['export function readPage(input) {', '  return readAll(input);', '}', '', ...Array.from({ length: 100 }, (_, i) => `// stable context ${i}`)].join('\n') + '\n';
  fs.writeFileSync(path.join(f.root, 'src/reader.js'), oldCode);
  fs.writeFileSync(path.join(f.root, 'README.md'), '# Untouched project file\nThis file is unchanged.\n');
  fs.writeFileSync(path.join(f.root, 'gone.js'), 'export const retired = true;\n');
  await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'code browser baseline');
  const commit = await git(f.root, 'rev-parse', 'HEAD');
  const workspace = path.join(f.config.home, 'worktrees', 'browser');
  await git(f.root, 'worktree', 'add', '-b', 'code-browser-fixture', workspace);
  const task = { id: 101, workspace, branch: 'code-browser-fixture', base_commit: commit, head_commit: commit };
  const codePath = path.join(workspace, 'src/reader.js');
  const newCode = oldCode.replace('  return readAll(input);', '  const page = readBounded(input);\n  return page;');
  fs.writeFileSync(codePath, newCode); fs.unlinkSync(path.join(workspace, 'gone.js'));
  fs.writeFileSync(path.join(workspace, 'new.js'), 'export const newFile = true;\n');
  fs.writeFileSync(path.join(workspace, 'long.txt'), 'long single line '.repeat(1800) + '\nsecond line\n');
  const indexPath = path.join(await git(workspace, 'rev-parse', '--absolute-git-dir'), 'index');
  const originalIndex = fs.readFileSync(indexPath);
  const step = { seq: 1, kind: 'text', title: '回答', file: 'fixture', body: 'Reading src/reader.js', excerpt: 'src/reader.js' };
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/styles.css"></head>
  <body><div id="project-app"><div id="detail"></div></div><div id="context-menu"></div>
  <script type="module">
  import { openTranscriptView } from '/assets/transcript-view.js';
  import { ui, transcriptCache } from '/assets/state.js';
  ui.selected=101;ui.lastSnapshot={tasks:[{id:101,status:'running'}]};
  transcriptCache.set(101,{order:'desc',steps:[${JSON.stringify(step)}],files:['fixture'],next:1,oldest:1});
  window.browserErrors=[];addEventListener('error',e=>window.browserErrors.push(e.message));addEventListener('unhandledrejection',e=>window.browserErrors.push(String(e.reason)));
  window.readerReady=openTranscriptView(101);
  </script></body></html>`;
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url), route = url.pathname;
    try {
      if (route === '/') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
      if (/^\/assets\/[\w.-]+\.(js|css)$/.test(route) || route === '/highlight.min.js') return new Response(Bun.file(path.join(assets, path.basename(route))));
      if (route.endsWith('/transcript-search')) return Response.json({ steps: [step], files: ['fixture'], next: 1, has_more: false });
      if (route.endsWith('/transcript-step')) return Response.json({ step, related: [], context: [], has_more: false });
      const match = /^\/api\/task\/101\/code-(state|tree|file)$/.exec(route);
      if (match) {
        const kind = match[1], params = Object.fromEntries(url.searchParams);
        if ('changed' in params) params.changed = params.changed === 'true';
        counts[kind]++;
        const method = { state: 'codeState', tree: 'codeTree', file: 'codeFile' }[kind];
        return Response.json(await f.project.workspaces[method](task, params));
      }
      return new Response('not found', { status: 404 });
    } catch (error) { errors.push(error.message); return Response.json({ error: error.message }, { status: 500 }); }
  } });
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = reservation.port; reservation.stop(true); base = `http://127.0.0.1:${port}`;
  driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(driverLog), stderr: Bun.file(driverLog),
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited before startup');
    await Bun.sleep(100);
  }
  assert(ready, 'geckodriver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  await waitFor('document.querySelector(".transcript-dialog[open]")', 'execution reader opened');
  assert(counts.state + counts.tree + counts.file === 0, 'closed code tab must not read files');
  await click('#execution-tab-code-101');
  await waitFor('document.querySelectorAll(".code-file-entry").length>=5', 'real file tree loaded');
  assert(await execute(`return [...document.querySelectorAll('.code-file-entry')].some(n=>n.dataset.path==='README.md')`), 'unchanged project file missing');
  await click('.code-change-group [data-path="src/reader.js"]');
  await waitFor('document.querySelector(".code-hunk")', 'real Git diff rendered');
  await waitFor('document.querySelector(".code-hunk .hljs .hljs-keyword")', 'real syntax highlighting loaded');
  assert(await execute(`return document.querySelector('.code-file-body').textContent.includes('readBounded(input)')&&document.querySelector('.code-file-body').textContent.includes('readAll(input)')`), 'old/new Git text missing');
  assert(await execute(`return getComputedStyle(document.querySelector('.code-split')).display!=='none'&&getComputedStyle(document.querySelector('.code-unified')).display==='none'`), 'desktop must default to split diff');
  for (const theme of ['light', 'dark']) {
    await execute(`document.documentElement.dataset.theme='${theme}';`);
    for (const [width, height] of [[1440, 900], [900, 700], [390, 844]]) {
      await rpc(`/session/${session}/window/rect`, { width, height });
      const box = await execute(`const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};
        return {side:rect('.code-sidebar'),body:rect('.code-viewport'),filter:rect('.code-tree-filter'),width:innerWidth,height:innerHeight,split:getComputedStyle(document.querySelector('.code-split')).display,unified:getComputedStyle(document.querySelector('.code-unified')).display};`);
      assert(box.body.h > 100 && box.body.w > 200, `clipped body ${theme}/${width}: ${JSON.stringify(box)}`);
      assert(box.body.right <= box.width + 1 && box.body.bottom <= box.height + 1, `escaped viewport: ${JSON.stringify(box)}`);
      if (box.width > 760) assert(box.side.right <= box.body.x + 1 && Math.abs(box.side.y - box.body.y) < 1, `desktop columns misplaced: ${JSON.stringify(box)}`);
      else assert(box.side.bottom <= box.body.y + 1 && box.split === 'none' && box.unified !== 'none', `mobile must stack and show unified: ${JSON.stringify(box)}`);
      assert(box.filter.bottom <= box.side.bottom + 1, 'filter clipped inside sidebar');
      await screenshot(`code-${theme}-${width}`); console.log(`PASS real Git diff and layout ${theme}/${width}`);
    }
  }
  await clickText('收起文件栏');
  assert(await execute(`return getComputedStyle(document.querySelector('.code-sidebar')).display==='none'&&document.querySelector('.code-viewport').getBoundingClientRect().height>300`), 'mobile file collapse did not expand body');
  await clickText('展开文件栏');
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 900 });
  await clickText('文件内容');
  await waitFor('document.querySelector(".code-content-segment")', 'current file content');
  await execute(`window.savedFile=document.querySelector('.code-content-segment');document.querySelector('.code-viewport').scrollTop=100;window.savedScroll=document.querySelector('.code-viewport').scrollTop;`);
  await click('#execution-tab-transcript-101');
  await click('#execution-tab-code-101');
  await waitFor('document.querySelectorAll(".code-file-entry").length>=5', 'tree restored after tab switch');
  const restored = await execute(`return {same:window.savedFile===document.querySelector('.code-content-segment'),scroll:document.querySelector('.code-viewport').scrollTop,expected:window.savedScroll}`);
  assert(restored.same && restored.scroll === restored.expected, `tab switch lost body or reading position: ${JSON.stringify(restored)}`);
  // Native clicking the header action may scroll it into view; that movement is not a lost scroll position.
  await clickText('在执行记录中搜索此路径');
  await waitFor('document.querySelector(".transcript-match [data-seq]")', 'path search in records');
  assert(await execute(`return document.querySelector('.transcript-query-row input').value==='src/reader.js'`), 'path search query incorrect');
  await click('#execution-tab-code-101');
  await waitFor('document.querySelectorAll(".code-file-entry").length>=5', 'tree restored after records');
  assert(await execute(`return window.savedFile===document.querySelector('.code-content-segment')`), 'path search roundtrip replaced selected file body');
  const beforeFileReads = counts.file;
  fs.writeFileSync(codePath, newCode.replace('return page;', 'return page.items;'));
  await waitFor('document.querySelector(".code-update-banner")?.hidden===false', 'state probe noticed real file mutation');
  assert(counts.file === beforeFileReads, 'probe downloaded file body');
  assert(await execute(`return window.savedFile===document.querySelector('.code-content-segment')&&!document.querySelector('.code-file-body').textContent.includes('page.items')`), 'probe silently replaced selected content');
  await clickText('加载最新');
  await waitFor('document.querySelector(".code-file-body")?.textContent.includes("page.items")', 'explicit latest loaded real mutation');
  await click('.code-tree-entries [data-path="README.md"]');
  await waitFor('document.querySelector(".code-file-body")?.textContent.includes("Untouched project file")', 'unchanged full file readable');
  await click('.code-change-group [data-path="long.txt"]'); await clickText('文件内容');
  await waitFor('[...document.querySelectorAll("button")].some(n=>n.textContent==="继续读取文件")', 'large file first bounded page');
  await clickText('继续读取文件');
  await waitFor('document.querySelector(".code-file-body")?.textContent.includes("second line")', 'continued long line body');
  assert(await execute(`return document.querySelectorAll('.code-content-line[data-line="1"]').length===1`), 'continued line duplicated source line number');
  assert(fs.readFileSync(indexPath).equals(originalIndex), 'read-only viewer rewrote original Git index');
  assert((await git(workspace, 'rev-parse', 'HEAD')) === commit, 'read-only viewer moved HEAD');
  await clickText('返回任务 · Esc');
  const closedCount = counts.state;
  await Bun.sleep(3500);
  assert(counts.state === closedCount, 'closed viewer kept polling');
  assert(errors.length === 0, `fixture API errors: ${errors.join('; ')}`);
  const browserErrors = await execute('return window.browserErrors;');
  assert(browserErrors.length === 0, `browser errors: ${browserErrors.join('; ')}`);
  passed = true;
  console.log(`PASS actual content/diff, untouched files, path search roundtrip, preserved reading, controlled live update, continued long line, close cleanup; requests=${JSON.stringify(counts)}`);
  console.log(`Screenshots: ${output}`);
} catch (error) {
  console.error(`Code browser integration failed; logs: ${logs}; screenshots: ${output}`);
  if (session) await screenshot('failure').catch(() => {});
  throw error;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  if (driver) { driver.kill(); await driver.exited; }
  server?.stop(true);
  await f.close();
  if (passed) fs.rmSync(logs, { recursive: true, force: true });
}
