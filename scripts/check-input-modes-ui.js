// Isolated Firefox fixture: real project shell/CSS, no daemon or model calls.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCapabilityGuides } from '../src/agent/capabilities.js';

const assets = new URL('../src/ui/web/assets/', import.meta.url).pathname;
const fixture = `
import { makeWorld } from '/fixture-world.js';
const world = makeWorld(), json = data => ({ ok: true, json: async () => structuredClone(data) });
const base = { created_at: '2026-10-13T00:00:00Z', status: 'running', merge_status: 'none', references: [], content_truncated: false };
const rows = [
  { ...base, kind: 'input', mode: 'order', id: 1, task_id: 1, content: '新建原始输入' },
  { ...base, kind: 'message', mode: 'append', id: 2, task_id: 1, task_worker_number: 'W1', append_number: 'A1-1', content: '<img src=x>追加原文' },
  { ...base, kind: 'management', mode: 'management', id: 3, task_id: 3, task_worker_number: 'V1', content: '管理 Lush 原文' },
  { ...base, kind: 'draft', mode: 'order', id: 9, status: 'draft', content: '尚未发送的草稿，不得混入历史', revision: 1 }
];
window.fetch = async (url, options = {}) => {
  const route = new URL(url, location.href), path = route.pathname.replace(/^\\/p\\/[^/]+/, '');
  if (path === '/api/inputs') {
    const modes = JSON.parse(route.searchParams.get('modes') ?? '["order","append","management"]');
    if (route.searchParams.get('view') !== 'history') throw Error('history must explicitly request sent scope');
    return json({ items: rows.filter(row => row.kind !== 'draft' && modes.includes(row.mode)), next_cursor: null });
  }
  const match = /^\\/api\\/input\\/(input|message|management)\\/(\\d+)$/.exec(path);
  if (match) return json(rows.find(row => row.kind === match[1] && row.id === Number(match[2])));
  return world.fetchImpl(path + route.search, options);
};
const { boot } = await import('/app.js'); await boot();
const { openInputs } = await import('/render-inputs.js'); await openInputs();
window.ready = true;
`;
const html = (await Bun.file(join(assets, 'index.html')).text()).replace('<script type="module" src="/app.js"></script>', '<script type="module" src="/fixture.js"></script>');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/') return new Response('<iframe id="view" src="/p/aaaaaaaaaaaaaaaa/" style="width:1440px;height:900px;border:0"></iframe>', { headers: { 'Content-Type': 'text/html' } });
  if (path === '/p/aaaaaaaaaaaaaaaa/') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  if (path === '/fixture.js') return new Response(fixture, { headers: { 'Content-Type': 'text/javascript' } });
  if (path === '/fixture-world.js') return new Response((await Bun.file(new URL('../test/web/dom-world.js', import.meta.url)).text())
    .replace('../../src/ui/web/assets/prefs.js', '/prefs.js')
    .replace("import { listCapabilityGuides } from '../../src/agent/capabilities.js';", `const listCapabilityGuides=()=>${JSON.stringify(listCapabilityGuides())};`), { headers: { 'Content-Type': 'text/javascript' } });
  if (path === '/administrator/project-protocol.js') return new Response(Bun.file(new URL('../src/administrator/project-protocol.js', import.meta.url)));
  if (/^\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-input-modes-')), log = join(temp, 'driver.log');
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log),
});
let session, passed = false;
async function rpc(path, body, method = 'POST') {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  const data = await response.json(); if (!response.ok) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const assert = (condition, message) => { if (!condition) throw Error(message); };
async function inFrame(script) {
  return rpc(`/session/${session}/execute/async`, { script: `const done = arguments[0], win = document.querySelector('#view').contentWindow;
    (async () => { ${script} })().then(done).catch(error => done({ error: error.message }));`, args: [] });
}
try {
  // Startup polling is restricted to our isolated browser process, never Lush Workers.
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); break; } catch { await Bun.sleep(50); }
  }
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1050 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  const ready = await inFrame(`for (let i=0;i<200;i++) { if (win.ready) return true; await new Promise(resolve => setTimeout(resolve, 50)); } return false;`);
  assert(ready === true, `fixture failed to boot: ${JSON.stringify(ready)}`);
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 390]) {
    await execute(`document.querySelector('#view').style.width='${width}px';`);
    const result = await inFrame(`
      const document = win.document; document.documentElement.dataset.theme = '${theme}';
      await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
      const buttons = [...document.querySelectorAll('.input-mode-toggle')];
      const mode = value => buttons.find(node => node.dataset.mode === value);
      for (const node of buttons) if (node.getAttribute('aria-pressed') !== 'true') await node.onclick();
      const rects = buttons.map(node => { const box=node.getBoundingClientRect(), style=win.getComputedStyle(node); return {
        x:box.x, right:box.right, width:box.width, height:box.height, color:style.color, background:style.backgroundColor,
        help:node.dataset.help, selected:node.getAttribute('aria-pressed'), text:node.textContent }; });
      const initial = document.querySelectorAll('.input-record').length;
      await mode('order').onclick(); await mode('management').onclick();
      const appendOnly = [...document.querySelectorAll('.input-record')].map(node => node.dataset.input);
      document.querySelector('.input-row').click();
      for(let i=0;i<100 && !document.querySelector('.input-detail').textContent.includes('追加原文');i++) await new Promise(resolve=>setTimeout(resolve,10));
      const safe = !document.querySelector('.input-detail img') && document.querySelector('.input-detail').textContent.includes('A1-1');
      [...document.querySelectorAll('.breadcrumb button')].find(node=>node.textContent.includes('返回历史输入')).click();
      await mode('append').onclick();
      const empty = document.querySelectorAll('.input-record').length===0 && document.querySelector('.inputs-feedback').textContent.includes('未勾选');
      await mode('order').onclick(); await mode('append').onclick(); await mode('management').onclick();
      return { width:win.innerWidth, scrollWidth:document.documentElement.scrollWidth, rects, initial, appendOnly, safe, empty };
    `);
    assert(!result.error, JSON.stringify(result));
    assert(result.width === width && result.scrollWidth <= width, `overflow ${theme}/${width}: ${JSON.stringify(result)}`);
    assert(result.initial === 3 && JSON.stringify(result.appendOnly) === '["message:2"]' && result.safe && result.empty, `filter/detail failure ${JSON.stringify(result)}`);
    assert(result.rects.every(box => box.x >= 0 && box.right <= width && box.width > 60 && box.height >= (width <= 760 ? 44 : 32) && box.help && box.selected === 'true'), `mode controls clipped ${JSON.stringify(result)}`);
    assert(new Set(result.rects.map(box => box.background)).size === 3, `mode colors not distinct ${JSON.stringify(result)}`);
    console.log(`PASS ${theme} ${width}px: three distinct color toggles, filtering/empty state, safe append detail, no overflow`);
  }
  passed = true;
} finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true }); else console.error(`Browser diagnostic: ${log}`);
}
