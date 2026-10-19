// Isolated Firefox -> actual user HTTP/RPC/Event reader. No daemon/model processes.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { setup, fetch } from './harness.js';
import { beginManagementCall, finishManagementCall } from '../../src/core/project/management-calls.js';
import { managementDiagnostic } from '../../src/core/management-diagnostic.js';

const f = await setup(); f.project.kick = () => {};
const manager = f.project.submitManagementInstruction({ instruction: '隔离浏览器调用时间线验证' }).task;
f.store.update(manager.id, { status: 'running' });
f.project.running.set(manager.id, { recordId: 781, controller: new AbortController() });
const start = () => beginManagementCall(f.project, f.store.task(manager.id), 'manager.call', 'worker.inspect', { id: manager.id, instruction: 'PRIVATE-NOT-DISPLAYED' });
for (let i = 0; i < 35; i++) { const call = start(); finishManagementCall(f.project, manager.id, call, { status: 'pending_confirmation', receipt_id: i + 100 }, null); }
// Safe historical fault fixture, not a replay or a model call.
const target = f.store.create({ role: 'agent', task_kind: 'order', goal: 'PRIVATE-TARGET', status: 'paused' });
const fault = beginManagementCall(f.project, f.store.task(manager.id), 'manager.call', 'worker.resume', { id: target.id });
const receiptId = f.store.event(manager.id, 'management.capability_requested', { method: 'worker.resume', call_id: fault.call_id });
const diagnostic = managementDiagnostic('succeeded', 'completion', 'applied', 'completion_saved', { actor_id: manager.id, worker_number: manager.worker_number, call_id: fault.call_id, receipt_id: receiptId });
const actionId = f.store.event(manager.id, 'management.action_submitted', { action: 'start', target_id: target.id, capability_receipt_id: receiptId, call_id: fault.call_id });
const actionDiagnostic = managementDiagnostic('execution_failed', 'execution', 'unknown', 'dispatch_entered', { actor_id: manager.id, worker_number: manager.worker_number, call_id: fault.call_id, receipt_id: actionId, target_id: target.id });
const state = JSON.parse(f.store.task(manager.id).management);
state.control_calls = [{ receipt_id: receiptId, call_id: fault.call_id, method: 'worker.resume', status: 'succeeded', diagnostic }];
state.receipts = [{ receipt_id: actionId, call_id: fault.call_id, action: 'start', capability_receipt_id: receiptId, target_id: target.id, status: 'unknown', diagnostic: actionDiagnostic, reason: 'PRIVATE-RAW-ERROR' }];
state.enabled = false; state.state = 'unknown'; state.emergency = { status: 'isolated' };
f.store.update(manager.id, { management: JSON.stringify(state) });
f.store.event(manager.id, 'management.action_failed', { receipt_id: actionId, diagnostic: actionDiagnostic, status: 'unknown' });
fault.receipt_id = receiptId; fault.capability_diagnostic = diagnostic;
finishManagementCall(f.project, manager.id, fault, { receipt_id: receiptId, status: 'succeeded', result: { action: { receipt_id: actionId, status: 'waiting' } } }, null);
const orphan = start();
const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const base = (await Bun.file(join(assets, 'index.html')).text()).replace('<script type="module" src="/app.js"></script>', '');
const fixture = base.replace('</body>', `<script type="module">
import {loadDetail,disposeDetailRequests} from '/detail.js';
import {ui} from '/state.js';
ui.selected=${manager.id};ui.detailTask=${manager.id};ui.view={id:'task',key:'task-${manager.id}'};
window.copies=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copies.push(text)}});
window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
window.refresh=()=>loadDetail(${manager.id});window.leave=()=>{disposeDetailRequests();document.getElementById('detail').replaceChildren();};
await window.refresh();window.ready=true;
</script></body>`);
let fail = false, hold = false, releaseHold = null;
const paths = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === '/') return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname.endsWith('/management-calls')) {
      paths.push(url.search);
      if (hold) await new Promise(resolve => { releaseHold = resolve; });
      if (fail) return Response.json({ error: 'fixture service unavailable' }, { status: 503 });
    }
    return fetch(f.url + url.pathname + url.search);
  }
  if (/^\/[\w.-]+\.(js|css)$/.test(url.pathname)) return new Response(Bun.file(join(assets, url.pathname.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-management-calls-browser-')), log = join(temp, 'geckodriver.log');
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log),
});
let session, passed = false;
async function rpc(path, body, method = 'POST') {
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(20000, () => req.destroy(new Error('WebDriver timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(response.text); if (response.status >= 400) throw new Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = script => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0];let n=0;const check=()=>(${script})?done(true):++n>150?done(false):setTimeout(check,30);check();`, args: [] });
const assert = (value, message) => { if (!value) throw new Error(message); };
async function click(selector) {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  await rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
const settled = `document.querySelector('.management-calls-status')?.textContent.includes('已显示')`;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw new Error('geckodriver startup failed'); await Bun.sleep(50);
  }
  assert(ready, 'geckodriver timeout');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` });
  assert(await wait(`window.ready&&${settled}`), 'fixture failed to load');
  assert(await execute(`return document.querySelectorAll('.management-call').length===26&&
    document.querySelector('.management-calls').textContent.includes('待用户确认')&&
    !document.querySelector('.management-calls').textContent.includes('PRIVATE-NOT-DISPLAYED');`), 'tail window/status/redaction failed');
  // Firefox desktop window minimum is wider than 320px: iframe provides exact CSS viewports.
  for (const width of [1440,390,320]) {
    await rpc(`/session/${session}/window/rect`, { width: 1500, height: 1000 });
    await execute(`const frame=document.createElement('iframe');frame.id='layout-frame';frame.style.cssText='position:fixed;inset:0;width:${width}px;height:850px;border:0;z-index:99999';frame.src='/';document.body.append(frame);`);
    assert(await wait(`document.getElementById('layout-frame').contentWindow.ready&&document.getElementById('layout-frame').contentDocument.querySelector('.management-call')`), 'frame did not load');
    assert(await wait(`document.getElementById('layout-frame').contentDocument.querySelector('.management-calls-has-failures')`), 'failure summary not ready '+width);
    const layout = await execute(`const frame=document.getElementById('layout-frame'),d=frame.contentDocument,w=frame.contentWindow,n=d.querySelector('.management-calls');
      n.querySelector('code').textContent='worker.very_long_method_name_for_ellipsis'.repeat(8);
      return {width:w.innerWidth,overflow:n.scrollWidth>n.clientWidth+1,bodyOverflow:d.documentElement.scrollWidth>w.innerWidth+1,
      compact:[...n.querySelectorAll('.management-call')].every(row=>row.getBoundingClientRect().height<=46&&row.querySelector('summary').getBoundingClientRect().height>=44),
      closed:[...n.querySelectorAll('.management-call-fold')].every(f=>!f.open),
      preview:n.classList.contains('detail-preview'),unclipped:w.getComputedStyle(n.querySelector('.module-body')).maxHeight==='none',
      failureHidden:d.querySelector('[data-call-id="${fault.call_id}"] .management-call-failure').getBoundingClientRect().height===0,
      unknownVisible:d.querySelector('[data-call-id="${fault.call_id}"] .management-call-alert').textContent.includes('未知'),
      badgeUnclipped:[...n.querySelectorAll('.management-call-alert')].filter(e=>!e.hidden).every(e=>e.scrollWidth<=e.clientWidth+1),
      ellipsis:w.getComputedStyle(n.querySelector('code')).textOverflow==='ellipsis'};`);
    assert(layout.width===width&&!layout.overflow&&!layout.bodyOverflow&&layout.preview&&layout.unclipped&&layout.failureHidden
      &&layout.compact&&layout.closed&&layout.unknownVisible&&layout.badgeUnclipped&&layout.ellipsis, 'layout failure '+JSON.stringify(layout));
    assert(await execute(`const d=document.getElementById('layout-frame').contentDocument,n=d.querySelector('.management-calls');
      n.querySelector('.management-call-head').click();
      d.querySelector('[data-call-id="${fault.call_id}"] .management-call-head').click();
      return n.querySelector('details').open&&d.defaultView.getComputedStyle(n.querySelector('pre')).overflowY==='visible'
      &&[...d.querySelectorAll('[data-call-id="${fault.call_id}"] .management-diagnostic-controls button,[data-call-id="${fault.call_id}"] .management-diagnostic-controls a')].every(e=>e.getBoundingClientRect().height>=44)
      &&n.scrollWidth<=n.clientWidth+1&&d.documentElement.scrollWidth<=d.defaultView.innerWidth+1;`), 'expanded main-scroll/touch reading failed');
    await execute(`const w=document.getElementById('layout-frame').contentWindow;w.savedCall=w.document.querySelector('.management-call');w.savedCall.querySelector('summary').focus();`);
    // Native focus scrolling and shared module ResizeObserver settle before the baseline.
    await rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0],w=document.getElementById('layout-frame').contentWindow;
      w.requestAnimationFrame(()=>w.requestAnimationFrame(()=>{w.savedTop=w.savedCall.querySelector('summary').getBoundingClientRect().top;done();}));`, args: [] });
    await execute(`return document.getElementById('layout-frame').contentWindow.refresh();`);
    const refreshed = await execute(`const w=document.getElementById('layout-frame').contentWindow,n=w.document.querySelector('.management-calls');return {
      unclipped:w.getComputedStyle(n.querySelector('.module-body')).maxHeight==='none',same:w.document.querySelector('.management-call')===w.savedCall,
      open:w.savedCall.querySelector('details').open,focused:w.document.activeElement===w.savedCall.querySelector('summary'),
      delta:w.savedCall.querySelector('summary').getBoundingClientRect().top-w.savedTop};`);
    assert(refreshed.unclipped&&refreshed.same&&refreshed.open&&refreshed.focused&&Math.abs(refreshed.delta)<=1, 'viewport refresh lost reading state '+width+' '+JSON.stringify(refreshed));
    console.log('PASS exact viewport, single-line collapsed rows/explicit alerts/ellipsis/touch expansion and retained refresh', width);
    await execute(`document.getElementById('layout-frame').remove();`);
  }
  await execute(`document.querySelector('[data-call-id="${fault.call_id}"] .management-call-head').focus();`);
  const key = value => rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }] });
  await key('\uE007');
  assert(await wait(`document.querySelector('[data-call-id="${fault.call_id}"] .management-call-fold').open&&document.querySelector('[data-call-id="${fault.call_id}"] .management-call-head').getAttribute('aria-expanded')==='true'`), 'Enter did not expand call');
  await key(' ');
  assert(await wait(`!document.querySelector('[data-call-id="${fault.call_id}"] .management-call-fold').open&&document.querySelector('[data-call-id="${fault.call_id}"] .management-call-head').getAttribute('aria-expanded')==='false'`), 'Space did not collapse call');
  await key('\uE007');
  await execute(`const r=document.querySelector('[data-call-id="${fault.call_id}"]');r.querySelector('.management-diagnostic-controls button').click();`);
  assert(await wait(`window.copies.length===1`), 'copy did not complete');
  assert(await execute(`const r=document.querySelector('[data-call-id="${fault.call_id}"]'),text=window.copies[0];return [...r.querySelectorAll('.management-call-failure p')].filter(p=>!p.hidden).every(p=>text.includes(p.textContent))&&text.includes('已急救隔离')&&text.includes('该方法已生效')&&text.includes('动作最初失败')&&!text.includes('PRIVATE');`), 'visible/copy whitelist mismatch');
  await execute(`document.querySelector('[data-call-id="${fault.call_id}"] .management-diagnostic-controls button').focus();`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  assert(await wait(`window.copies.length===2`), 'keyboard copy failed');
  await execute(`document.querySelector('[data-call-id="${fault.call_id}"] .management-diagnostic-details>summary').focus();`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  assert(await wait(`document.querySelector('[data-call-id="${fault.call_id}"] .management-diagnostic-timeline-status').textContent.includes('已读取')`), 'safe associated timeline not loaded');
  await execute(`document.activeElement.blur();document.querySelector('.management-calls-order button:last-child').click();
    [...document.querySelectorAll('.management-calls-controls button')].find(b=>b.textContent==='全部展开').click();`);
  await click('.management-calls-controls button:first-child');
  assert(await wait(`document.querySelectorAll('.management-call').length===37`), 'older real HTTP page missing '+JSON.stringify(await execute(`return {n:document.querySelectorAll('.management-call').length,status:document.querySelector('.management-calls-status').textContent,focus:document.activeElement?.outerHTML,toast:document.getElementById('error')?.textContent};`))+' paths='+JSON.stringify(paths));
  assert(await execute(`const ids=[...document.querySelectorAll('.management-call')].map(n=>+n.dataset.callId);return ids.every((id,i)=>!i||ids[i-1]>id)&&[...document.querySelectorAll('.management-call-fold')].every(f=>f.open);`), 'reverse order/bulk mode lost across older page');
  await execute(`document.querySelector('.management-calls-order button:first-child').click();`);
  assert(await execute(`const ids=[...document.querySelectorAll('.management-call')].map(n=>+n.dataset.callId);return ids.every((id,i)=>!i||ids[i-1]<id)&&[...document.querySelectorAll('.management-call-fold')].every(f=>f.open);`), 'ascending order/folds not stable');
  await execute(`window.old=document.querySelector('.management-call');window.old.querySelector('details').open=true;
    window.focusNode=window.old.querySelector('summary');window.focusNode.focus();window.anchorTop=window.focusNode.getBoundingClientRect().top;`);
  await execute(`return window.refresh();`);
  assert(await execute(`return document.querySelectorAll('.management-call').length===37&&document.querySelector('.management-call')===window.old&&window.old.querySelector('details').open&&document.activeElement===window.focusNode
    &&Math.abs(window.focusNode.getBoundingClientRect().top-window.anchorTop)<=1;`), 'refresh lost nodes/fold/focus/reading anchor');
  await execute(`document.activeElement.blur();window.text=window.old.querySelector('code').firstChild;window.getSelection().setBaseAndExtent(window.text,0,window.text,6);`);
  await execute(`return window.refresh();`);
  assert(await execute(`return getSelection().toString()==='worker'&&getSelection().anchorNode===window.text;`), 'refresh stole selected text');
  await execute(`document.querySelector('.management-calls-order button:last-child').click();`);
  assert(await execute(`return getSelection().toString()==='worker'&&getSelection().anchorNode===window.text&&window.old.querySelector('details').open;`), 'reverse sort lost selection or fold');
  await execute(`document.querySelector('.management-calls-order button:first-child').click();`);
  assert(await execute(`return getSelection().toString()==='worker'&&getSelection().anchorNode===window.text&&document.querySelector('.management-call')===window.old;`), 'ascending sort lost selected node');
  await execute(`getSelection().removeAllRanges();window.targetText=window.old.querySelector('.management-diagnostic-links a').firstChild;window.targetSelection=window.targetText.textContent;
    getSelection().setBaseAndExtent(window.targetText,0,window.targetText,window.targetText.length);`);
  await execute(`return window.refresh();`);
  assert(await execute(`return getSelection().toString()===window.targetSelection&&getSelection().anchorNode===window.targetText;`), 'refresh stole target link selection');
  await execute(`getSelection().removeAllRanges();`);
  // No new Event is written; only re-reading the exact start window can discover unknown.
  f.project.running.delete(manager.id); f.store.update(manager.id, { status: 'completed' });
  await execute(`return window.refresh();`);
  assert(await wait(`document.querySelector('[data-call-id="${orphan.call_id}"] .management-call-status').textContent.includes('结果未知')`), 'terminal empty after page failed to re-project orphan');
  assert(paths.some(value => value.includes(`before=${orphan.call_id + 1}`) && value.includes('limit=1')), 'exact start window was not read');
  console.log('PASS real HTTP older paging, retained nodes/focus/selection, terminal unknown without new Event');
  fail = true;
  await execute(`document.querySelectorAll('.management-calls-controls button')[1].click();`);
  assert(await wait(`document.querySelector('.management-calls-status').textContent.includes('不可用或失败')`), 'failure not shown');
  assert(await execute(`return document.querySelectorAll('.management-call').length===37;`), 'failure erased readable records');
  fail = false;
  await execute(`[...document.querySelectorAll('.management-calls-controls button')].find(b=>b.textContent==='全部收起').click();`);
  const late = start(); finishManagementCall(f.project, manager.id, late, {}, null);
  await execute(`document.querySelectorAll('.management-calls-controls button')[2].click();`);
  assert(await wait(`document.querySelectorAll('.management-call').length===38&&${settled}`), 'read retry failed');
  assert(await execute(`return [...document.querySelectorAll('.management-call-fold')].every(f=>!f.open);`), 'collapse mode lost on newer page');
  hold = true;
  await execute(`document.querySelectorAll('.management-calls-controls button')[1].click();`);
  await execute(`window.leave();`);
  hold = false; releaseHold?.();
  assert(await execute(`return !document.querySelector('.management-calls');`), 'leave did not release module');
  const errors = await execute(`return window.errors;`);
  // Firefox can report a deferred shared-preview geometry notification during reflow.
  // Do not mask script exceptions or unhandled rejections with this one known diagnostic.
  assert(errors.every(error => error === 'ResizeObserver loop completed with undelivered notifications.'),
    'browser runtime errors: ' + JSON.stringify(errors));
  console.log('PASS readable failure/retry and navigation cancellation; no script errors; deferred ResizeObserver notifications:', errors.length);
  passed = true;
} finally {
  releaseHold?.();
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true); f.project.running.delete(manager.id); await f.close();
  if (passed) await rm(temp, { recursive: true, force: true }); else console.error('Browser failure log:', log);
}
