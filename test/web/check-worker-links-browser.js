// Isolated real Firefox regression: native anchors, selectable cards, keyboard,
// themes, mobile layout and draft restoration. No project daemon is used.
// Run: bun run test/web/check-worker-links-browser.js (Firefox + geckodriver).
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/styles.css"></head><body><main id="root"></main><script type="module" src="/fixture.js"></script></body></html>`;
const fixture = `
import {questionnairePanel} from '/assets/render-questionnaire.js';
import {workerNumberTarget,resolveWorkerNumber} from '/assets/worker-links.js';
import {ui} from '/assets/state.js';
window.requests=[];window.submitted=0;
const notice={id:7,task_id:22,status:'open',kind:'questionnaire',created_at:'now',body:JSON.stringify({version:1,questions:[{header:'方案',question:'继续 W141 吗？',options:[{label:'采用 W141-1',description:'比较 W141-1-2 与 W142 的结果；参考 D453、N8 和 O190'},{label:'保持现状',description:'暂不修改'}]}]})};
window.paint=()=>root.replaceChildren(questionnairePanel(notice,{settle:()=>window.submitted++}));
window.fetch=async url=>{requests.push(url);return Response.json({id:277,worker_number:'W141-1-2'});};
addEventListener('hashchange',async()=>{const number=workerNumberTarget(location.hash);if(number){const id=await resolveWorkerNumber(number);history.replaceState(null,'','#worker-'+id);root.textContent='Worker detail '+id;}else if(/^#(?:notices|input-input)-[1-9]\\d*$/.test(location.hash)){root.textContent='Record detail '+location.hash;}else paint();});
paint();window.ready=true;`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  const headers = { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'" };
  if (path === '/') return new Response(html, { headers: { ...headers, 'Content-Type': 'text/html' } });
  if (path === '/fixture.js') return new Response(fixture, { headers: { ...headers, 'Content-Type': 'text/javascript' } });
  if (/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.split('/').at(-1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-worker-links-browser-'));
const log = join(temp, 'geckodriver.log');
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log),
});
let session, passed = false;
async function rpc(path, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('WebDriver timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw new Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const asyncExecute = script => rpc(`/session/${session}/execute/async`, { script, args: [] });
const assert = (value, message) => { if (!value) throw new Error(message); };
const wait = condition => asyncExecute(`const done=arguments[0];let n=0;const check=()=>(${condition})?done(true):++n>100?done(false):setTimeout(check,30);check();`);
async function click(selector) {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver exited'); await Bun.sleep(100);
  }
  assert(ready, 'geckodriver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  assert(await wait('window.ready'), 'fixture did not load');
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [390, 844], [320, 780]]) {
    await rpc(`/session/${session}/window/rect`, { width, height });
    await execute(`document.documentElement.dataset.theme='${theme}';paint();`);
    assert(await execute(`const a=document.querySelector('[href="#worker-number-W141-1-2"]'),r=a.getBoundingClientRect(),s=getComputedStyle(a),probe=document.createElement('span');probe.className='c-running';document.body.append(probe);const blue=getComputedStyle(probe).color;probe.remove();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===a&&s.textDecorationLine.includes('underline')&&s.color===blue&&document.documentElement.scrollWidth<=innerWidth&&!document.querySelector('button a');`), 'link styling/layout/hit target/nested controls failed');
    const previous = await execute('return requests.length;');
    await click('[href="#worker-number-W141-1-2"]');
    assert(await wait('root.textContent.includes("Worker detail 277")'), 'native link did not open real identity');
    assert(await execute(`return requests.length===${previous + 1}&&requests.at(-1)==='/api/worker-lookup?number=W141-1-2'&&submitted===0&&location.hash==='#worker-277';`), 'link selected/submitted or guessed an identity');
    await rpc(`/session/${session}/back`, {});
    assert(await wait('document.querySelector(".decision-option")'), 'back did not restore questionnaire');
    assert(await execute(`return !document.querySelector('.decision-option.selected');`), 'viewing a Worker selected an answer');
    for (const hash of ['#notices-453', '#notices-8', '#input-input-190']) {
      assert(await execute(`const a=document.querySelector('[href="${hash}"]'),r=a.getBoundingClientRect(),s=getComputedStyle(a);return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===a&&s.textDecorationLine.includes('underline')&&!document.querySelector('button a')&&document.documentElement.scrollWidth<=innerWidth;`), 'record link layout/hit target/nested controls failed');
      await click(`[href="${hash}"]`);
      assert(await wait('root.textContent.includes("Record detail")'), 'native record link did not navigate');
      assert(await execute(`return location.hash==='${hash}'&&submitted===0&&requests.length===${previous + 1};`), 'record link submitted or fetched during rendering');
      await rpc(`/session/${session}/back`, {});
      assert(await wait('document.querySelector(".decision-option")'), 'back did not restore record questionnaire');
      assert(await execute(`return !document.querySelector('.decision-option.selected');`), 'record link selected an answer');
    }
    console.log(`PASS ${theme} ${width}x${height}: W/D/N/O blue underline, hit target, native navigation/back, no selection`);
  }
  await execute(`document.querySelector('.decision-option-select').focus();`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: ' ' }, { type: 'keyUp', value: ' ' }] }] });
  assert(await wait('root.textContent.includes("确认你的全部选择")'), 'Space did not choose the option');
  assert(await execute('return submitted===0;'), 'selection submitted the questionnaire');
  await click('[href="#worker-number-W141-1-2"]');
  assert(await wait('root.textContent.includes("Worker detail 277")'), 'review link did not navigate');
  await rpc(`/session/${session}/back`, {});
  assert(await wait('root.textContent.includes("确认你的全部选择")'), 'back erased the selected answer draft');
  await execute(`document.querySelector('[href="#worker-number-W141-1-2"]').focus();`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  assert(await wait('root.textContent.includes("Worker detail 277")'), 'Enter did not activate the Worker link');
  console.log('PASS native keyboard selection/link activation and draft restoration under CSP');
  passed = true;
} catch (error) { console.error(`Browser failure; geckodriver log: ${log}`); throw error; }
finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  driver.kill(); await driver.exited; server.stop(true); if (passed) await rm(temp, { recursive: true, force: true });
}
