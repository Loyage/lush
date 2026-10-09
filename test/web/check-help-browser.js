// Standalone: bun run test/web/check-help-browser.js
// Real Firefox with an isolated fixture; no project daemon, account or model call.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';

const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/styles.css"></head>
<body style="padding:40px"><button id="plain">刷新</button><button id="help">复杂操作</button>
<span class="help-host" data-help="不可用的原因"><button id="disabled" disabled>不可用</button></span>
<script type="module">
import { initHelp, agentHelp } from '/assets/help.js';
document.querySelector('#help').dataset.help=agentHelp('测试操作。');
window.calls=0;document.querySelector('#help').onclick=()=>window.calls++;
initHelp();window.ready=true;
</script></body></html>`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/') return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
  if (/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.split('/').at(-1))));
  return new Response(null, { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-help-browser-')), log = join(temp, 'geckodriver.log');
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log),
});
let session, passed = false;
async function rpc(path, body, method = 'POST') {
  const result = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('WebDriver timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(result.text); if (result.status >= 400) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = ms => rpc(`/session/${session}/execute/async`, { script: `setTimeout(arguments[0],${ms});`, args: [] });
const visible = () => execute('return !!document.querySelector("#help-tip:not([hidden])")');
const assert = (value, message) => { if (!value) throw Error(message); };
const element = id => rpc(`/session/${session}/element`, { using: 'css selector', value: `#${id}` });
async function mouse(actions) {
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }] });
}
const move = origin => ({ type: 'pointerMove', duration: 0, origin, x: 0, y: 0 });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100);
  }
  assert(ready, 'geckodriver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  const loaded = await rpc(`/session/${session}/execute/async`, { script: 'const done=arguments[0];let n=0;const check=()=>window.ready?done(true):++n>100?done(false):setTimeout(check,20);check();', args: [] });
  assert(loaded, 'fixture failed to load');
  const help = await element('help'), plain = await element('plain'), disabled = await element('disabled');
  await mouse([move(help)]); await wait(150); assert(!await visible(), 'hover appeared immediately');
  await mouse([move(plain)]); await wait(1300); assert(!await visible(), 'brief hover or plain refresh showed help');
  await mouse([move(help), { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }]);
  await wait(1300); assert(!await visible(), 'click/focus showed help');
  assert(await execute('return calls===1'), 'normal click did not execute');
  await mouse([move(plain), move(help)]); await wait(1300); assert(await visible(), 'delayed hover did not show');
  assert(await execute('return document.querySelector("#help").getAttribute("aria-describedby")==="help-tip"'), 'ARIA description missing');
  await mouse([move(plain)]); assert(!await visible(), 'moving away did not hide');
  await mouse([move(help), { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 800 }]);
  assert(await visible(), 'mouse long press did not show');
  await mouse([{ type: 'pointerUp', button: 0 }]);
  assert(await execute('return calls===1'), 'long press executed button');
  await mouse([move(plain)]);
  await rpc(`/session/${session}/element/${Object.values(plain)[0]}/click`, {});
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE004' }, { type: 'keyUp', value: '\uE004' }] }] });
  assert(!await visible(), 'keyboard focus showed help immediately');
  await wait(1300); assert(await visible(), 'keyboard dwell did not show');
  await mouse([move(disabled)]); await wait(1300); assert(await visible(), 'disabled host help missing');
  const disabledText = await execute('return document.querySelector("#help-tip").textContent');
  assert(disabledText === '不可用的原因', `disabled help wrong: ${disabledText}`);
  await execute(`document.dispatchEvent(new Event('scroll'));document.querySelector('#help').dispatchEvent(new Event('touchstart',{bubbles:true}));`);
  await wait(150); assert(!await visible(), 'touch help appeared immediately');
  await execute(`document.querySelector('#help').dispatchEvent(new Event('touchend',{bubbles:true}));`);
  await wait(700); assert(!await visible(), 'short touch showed help');
  await execute(`document.querySelector('#help').dispatchEvent(new Event('touchstart',{bubbles:true}));`);
  await wait(800); assert(await visible(), 'simulated touch long press did not show');
  const consumed = await execute(`const button=document.querySelector('#help');button.dispatchEvent(new Event('touchend',{bubbles:true}));return !button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));`);
  assert(consumed && await execute('return calls===1'), 'touch long press executed button');
  console.log('PASS: Firefox — delayed hover/keyboard, brief hover, normal click/focus, mouse long press without execution, simulated touch, disabled host and ARIA');
  passed = true;
} finally {
  if (session) try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {}
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true });
  else console.error(`Browser diagnostics: ${log}`);
}
