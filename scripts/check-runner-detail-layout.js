// Real Firefox layout of the production location component; fixture data, no Runner/daemon/model.
import fs from 'node:fs';
import path from 'node:path';
import { request } from 'node:http';
const assets = path.resolve(import.meta.dir, '../src/ui/web/assets');
const output = path.resolve(process.argv[2] || '/tmp/lush-runner-detail-layout');
fs.mkdirSync(output, { recursive: true });
const fixture = `import { renderWorkerRunner } from '/worker-runner.js';
const runner={node_id:'11111111-1111-4111-8111-111111111111',runner_id:'installation-'+ 'x'.repeat(100),workspace_id:'workspace-'+ 'y'.repeat(100),generation:3,revision:4,state:'unknown',authorized:false,head_commit:'a'.repeat(40),barriers:{bindings:1,runs:2,receipts:3}};
document.querySelector('main').append(renderWorkerRunner({id:7,status:'failed',runner},null,{refresh:async()=>{}}));window.ready=true;`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const name = new URL(req.url).pathname;
  if (name === '/') return new Response('<!doctype html><style>body{margin:0}iframe{display:block;border:0}</style><iframe id="viewport" width="1440" height="900" src="/fixture"></iframe>', { headers: { 'Content-Type': 'text/html' } });
  if (name === '/fixture') return new Response('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><style>body{display:block;overflow:auto}main{margin:0;padding:16px;min-width:0}</style><main></main><script type="module" src="/fixture.js"></script>', { headers: { 'Content-Type': 'text/html' } });
  if (name === '/fixture.js') return new Response(fixture, { headers: { 'Content-Type': 'text/javascript' } });
  if (/^\/[\w.-]+\.(js|css)$/.test(name)) return new Response(Bun.file(path.join(assets, name.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' },
  stdout: Bun.file(path.join(output, 'driver.log')), stderr: Bun.file(path.join(output, 'driver.log')) });
let session;
async function rpc(route, body, method = 'POST') {
  const result = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(20000, () => req.destroy(new Error('WebDriver timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(result.text); if (result.status >= 400) throw new Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited'); await Bun.sleep(50);
  }
  assert(ready, 'driver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  const results = [];
  for (const theme of ['dark', 'light']) for (const width of [1440, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null });
    await rpc(`/session/${session}/window/rect`, { width: Math.max(500, width), height: 1000 });
    await execute(`document.querySelector('iframe').width=${width};`);
    const frame = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' });
    await rpc(`/session/${session}/frame`, { id: frame });
    const loaded = await rpc(`/session/${session}/execute/async`, { script: 'const done=arguments[0];let n=0;const check=()=>window.ready?done(true):++n>100?done(false):setTimeout(check,20);check();', args: [] });
    assert(loaded, 'component failed to load');
    for (const expanded of [false, true]) {
      const geometry = await execute(`document.documentElement.dataset.theme='${theme}';document.documentElement.dataset.reducedMotion='true';
        const fold=document.querySelector('details');fold.open=${expanded};
        const summary=fold.querySelector('summary'),root=document.querySelector('.worker-runner');
        return {width:innerWidth,scroll:document.documentElement.scrollWidth,touchHeight:summary.getBoundingClientRect().height,
          checks:[...root.querySelectorAll('.runner-verification button')].map(n=>({height:n.getBoundingClientRect().height,visible:n.getBoundingClientRect().height>0,agent:n.classList.contains('agent-call')})),
          warnings:[...root.querySelectorAll('.worker-runner-warning')].map(n=>({text:n.textContent,visible:n.getBoundingClientRect().height>0,outside:n.parentNode===root})),
          overflow:[...root.querySelectorAll('*')].filter(n=>n.getBoundingClientRect().width>0).some(n=>n.getBoundingClientRect().right>innerWidth+1)};`);
      assert(geometry.width === width && geometry.scroll <= width + 1 && !geometry.overflow, `overflow ${JSON.stringify(geometry)}`);
      assert(geometry.touchHeight >= 44 && geometry.warnings.length === 3 && geometry.warnings.every(n => n.visible && n.outside), 'hidden warning or small touch target');
      assert(geometry.checks.length === 2 && geometry.checks.every(n=>n.visible && n.height>=44 && !n.agent), 'missing or small/non-model verification controls');
      results.push({ theme, width, expanded, ...geometry });
      fs.writeFileSync(path.join(output, `${theme}-${width}-${expanded ? 'expanded' : 'collapsed'}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64'));
    }
  }
  fs.writeFileSync(path.join(output, 'layout.json'), JSON.stringify(results, null, 2));
  console.log(`PASS Firefox: dark/light 1440/390/320px, collapsed/expanded, warnings always visible, 44px summary, long IDs without overflow. Evidence: ${output}`);
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true);
}
