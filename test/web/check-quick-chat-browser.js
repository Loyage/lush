// Compiled Firefox/CSP fixture. All model/Host API responses are controlled; no project daemon is started.
// Run: bun run test/web/check-quick-chat-browser.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { request } from 'node:http';
import { makeWorld } from './dom-world.js';
import { buildAssets } from '../../src/ui/web/build-assets.js';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-quick-chat-browser-'));
const output = process.env.LUSH_BROWSER_OUTPUT || '/tmp/lush-w218-1-browser'; fs.mkdirSync(output, { recursive: true });
await buildAssets(new URL('../../src/ui/web/assets/', import.meta.url).pathname, scratch, 'e'.repeat(32));
const html = fs.readFileSync(path.join(scratch, 'index.html'), 'utf8'), world = makeWorld(), calls = [], errors = [];
Object.assign(world.state.quickExplanationConfig, { ready: true, reason: null, connection_id: world.state.agentConnections.connections[0].id, model: 'fixture-model' });
world.state.quickChatPrompts.push({ id: 'notes', name: '整理记录', prompt: '整理为纯文本记录', builtin: false, context_menu: true },
  { id: 'saved', name: '仅保存备用', prompt: '备用模板', builtin: false, context_menu: false });
const csp = { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'" };
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const url = new URL(req.url), pathname = url.pathname;
  if (pathname === '/fixture') return new Response(`<!doctype html><link rel="stylesheet" href="/fixture.css"><iframe id="viewport" src="${(url.searchParams.get('route') || '/').replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`, { headers: { ...csp, 'Content-Type': 'text/html' } });
  if (pathname === '/fixture.css') return new Response('html,body{margin:0}iframe{display:block;width:1440px;height:1000px;border:0}', { headers: { 'Content-Type': 'text/css' } });
  if (pathname === '/' || /^\/p\/[a-f0-9]{16}\/$/.test(pathname)) return new Response(html, { headers: { ...csp, 'Content-Type': 'text/html' } });
  if (pathname.startsWith('/api/') || /^\/p\/[a-f0-9]{16}\/api\//.test(pathname)) {
    calls.push(pathname + url.search);
    const logical = pathname.replace(/^\/p\/[a-f0-9]{16}(?=\/api\/)/, '') + url.search;
    if (logical === '/api/hooks') return Response.json({ version: 1, revision: 'hooks-fixture', triggers: [], actions: [], templates: [], commands: { version: 1, revision: 'commands-fixture', items: [] } });
    if (logical.startsWith('/api/hooks/commands/executions')) return Response.json({ version: 1, items: [], has_more: false, next_before: null });
    if (logical === '/api/branch-convergence') return Response.json({ version: 1, items: [], count: 0, truncated: false });
    const value = await world.fetchImpl(logical, { method: req.method, ...(req.method === 'POST' ? { body: await req.text() } : {}) });
    return Response.json(await value.json(), { status: value.status || (value.ok ? 200 : 400) });
  }
  if (/^\/[\w.-]+\.(?:js|css)$/.test(pathname)) return new Response(Bun.file(path.join(scratch, pathname.slice(1))));
  return new Response('not found', { status: 404 });
} });
const reserved = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }); const port = reserved.port; reserved.stop(true);
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(path.join(output, 'geckodriver.log')), stderr: Bun.file(path.join(output, 'geckodriver.log')) });
let session;
async function rpc(route, body, method = 'POST') {
  const data = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(Error('WebDriver timed out'))); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const parsed = JSON.parse(data.text); if (data.status >= 400) throw Error(JSON.stringify(parsed)); return parsed.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const wait = script => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0];let attempts=0;function check(){if(${script})done(true);else if(++attempts>200)done(false);else setTimeout(check,30)}check();`, args: [] });
const assert = (value, message) => { if (!value) throw Error(message); };
async function frame() {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: element });
}
async function width(value) {
  await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.getElementById('viewport').style.width='${value}px'`); await frame();
  assert(await execute(`return innerWidth===${value}`), 'fixture viewport width not applied');
}
async function go(hash, project = true) {
  await rpc(`/session/${session}/frame`, { id: null });
  const route = `${project ? '/p/aaaaaaaaaaaaaaaa/' : '/'}${hash}`;
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/fixture?route=${encodeURIComponent(route)}` }); await frame();
}
async function click(selector) {
  const element = await rpc(`/session/${session}/element`, { using: 'css selector', value: selector });
  return rpc(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}
async function screenshot(name) { const data = await rpc(`/session/${session}/screenshot`, undefined, 'GET'); fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(data, 'base64')); }
try {
  let ready = false; for (let attempt = 0; attempt < 100; attempt++) { try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch { await Bun.sleep(30); } }
  assert(ready, 'geckodriver unavailable');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1440, height: 1200 });
  await go('#quick-chat', false); assert(await wait('document.querySelector("#detail h1")?.textContent.includes("没有可用项目")'), 'root quick chat did not require a project');
  assert(await execute('return !document.querySelector("[data-chat-field=prompt_id]")'), 'root exposed a global conversation form');
  await execute('const text=document.querySelector("#detail h1"),range=document.createRange();range.selectNodeContents(text);getSelection().removeAllRanges();getSelection().addRange(range);text.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:80,clientY:90}))');
  assert(await execute('return ![...document.querySelectorAll("#context-menu button")].some(node=>node.textContent==="快速解释"||node.textContent==="整理记录")'), 'root exposed project model actions');
  assert(!calls.some(value => value.includes('/quick-chat/')), 'root read project chat history or Prompt library');
  await go('#quick-chat'); assert(await wait('document.querySelector("[data-chat-field=prompt_id]")?.options.length===3'), 'project new conversation form unavailable');
  assert(calls.filter(value => value.includes('/quick-chat/')).every(value => value.startsWith('/p/aaaaaaaaaaaaaaaa/api/quick-chat/')), 'chat API lost project identity');
  assert(await execute('return document.querySelector("#detail a").getAttribute("href")==="/p/aaaaaaaaaaaaaaaa/#quick-chat-settings"'), 'settings link lost project identity');
  await execute('window.fixtureErrors=[];addEventListener("error",event=>fixtureErrors.push(event.message));addEventListener("unhandledrejection",event=>fixtureErrors.push(String(event.reason)))');
  await execute('const node=document.querySelector("[data-chat-field=content]");node.value="整理这一段纯文本";node.dispatchEvent(new Event("input"))');
  await click('.quick-chat-form button.primary'); assert(await wait('location.pathname==="/p/aaaaaaaaaaaaaaaa/"&&location.hash==="#quick-chat-C1"&&document.querySelector("[data-chat-field=reply]")'), 'new chat did not navigate to project C1');
  assert(await execute('return document.querySelector(".page-subnav [data-subpage=history]").getAttribute("href")==="/p/aaaaaaaaaaaaaaaa/#quick-chat"'), 'history link lost project identity');
  assert(await execute('return document.querySelector(".quick-chat-thread").textContent.includes("快速对话示例")'), 'chat response missing');
  await execute('const node=document.querySelector("[data-chat-field=reply]");node.value="继续速记";node.dispatchEvent(new Event("input"))'); await click('.quick-chat-form button.primary');
  assert(await wait('document.querySelectorAll(".quick-chat-turn").length===2'), 'followup did not stay in same conversation');
  assert(world.state.quickChatActions.filter(value => value.method === 'send').length === 1, 'followup duplicate');
  for (const theme of ['light', 'dark']) {
    await execute(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    for (const viewport of [1440, 390, 320]) {
      await width(viewport);
      assert(await execute('return document.documentElement.scrollWidth<=innerWidth+1'), `conversation overflow ${theme}/${viewport}`);
      await screenshot(`conversation-${theme}-${viewport}`);
    }
  }
  await click('.page-subnav [data-subpage=settings]'); assert(await wait('location.hash==="#quick-chat-settings"&&document.querySelector("[data-chat-field=edit_prompt]")?.options.length===4'), 'top settings navigation unavailable');
  assert(await execute('return document.querySelector(".quick-chat-page").firstElementChild.matches(".page-subnav")&&document.querySelector(".page-subnav [aria-current=page]").dataset.subpage==="settings"&&!document.querySelector(".quick-chat-history")'), 'settings and history are not separate subpages');
  await click('.page-subnav [data-subpage=history]'); assert(await wait('location.hash==="#quick-chat"&&document.querySelector(".quick-chat-history")'), 'top history navigation unavailable');
  await click('.page-subnav [data-subpage=settings]'); assert(await wait('document.querySelector("[data-chat-field=edit_prompt]")?.options.length===4'), 'Prompt settings unavailable');
  await execute('const picker=document.querySelector("[data-chat-field=edit_prompt]");picker.value="explain";picker.dispatchEvent(new Event("change"));const menu=document.querySelector("[data-chat-field=context_menu]");menu.checked=false;menu.dispatchEvent(new Event("change"))');
  await click('.quick-chat-library form button:not(.danger)'); assert(await wait('document.querySelector(".quick-chat-library").textContent.includes("Prompt 已保存")'), 'Prompt save failed');
  assert(world.state.quickChatPrompts[0].context_menu === false, 'builtin menu toggle not saved');
  await width(320); await execute('document.documentElement.dataset.theme="dark"'); await screenshot('settings-dark-320');
  await go('#hooks-history'); assert(await wait('document.querySelector(".shortcut-history-module")&&!document.querySelector(".shortcut-history-module").hidden'), 'automation history deep link unavailable');
  assert(await execute('return document.querySelector(".hooks-page").firstElementChild.matches(".page-subnav")&&document.querySelector(".shortcut-command-management").hidden&&document.querySelector(".project-hooks").hidden'), 'automation settings leaked into history');
  await click('.page-subnav [data-subpage=settings]'); assert(await wait('location.hash==="#hooks"&&!document.querySelector(".shortcut-command-management").hidden'), 'automation settings switch unavailable');
  await execute('[...document.querySelectorAll(".shortcut-command-management button")].find(node=>node.textContent==="注册快捷指令").click()');
  await execute(`document.querySelector('[aria-label="快捷指令名称"]').value="保留编辑";document.querySelector('[aria-label="Shell 命令"]').value="echo retained"`);
  await click('.page-subnav [data-subpage=history]'); await click('.page-subnav [data-subpage=settings]');
  assert(await execute(`return document.querySelector('[aria-label="Shell 命令"]').value==="echo retained"`), 'automation tab switch lost unsaved edits');
  for (const viewport of [1440, 390, 320]) {
    await width(viewport); assert(await execute('return document.documentElement.scrollWidth<=innerWidth+1'), `automation settings overflow ${viewport}`);
    await click('.page-subnav [data-subpage=history]'); assert(await execute('return document.documentElement.scrollWidth<=innerWidth+1'), `automation history overflow ${viewport}`);
    await screenshot(`automation-history-${viewport}`); await click('.page-subnav [data-subpage=settings]');
  }
  await go('', true); assert(await wait('document.querySelector("#composer-shell").hidden===false&&document.querySelector("#detail h1")'), 'project composer unavailable');
  await width(320);
  const original = await rpc(`/session/${session}/window`, undefined, 'GET');
  // Actual project text selection and native contextmenu event, not a synthetic model API call.
  await execute('const text=document.querySelector("#detail h1");const range=document.createRange();range.selectNodeContents(text);getSelection().removeAllRanges();getSelection().addRange(range);text.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:80,clientY:90}))');
  assert(await wait('[...document.querySelectorAll("#context-menu button")].some(node=>node.textContent==="整理记录")'), 'project Prompt menu missing in project');
  assert(await execute('return ![...document.querySelectorAll("#context-menu button")].some(node=>node.textContent==="快速解释"||node.textContent==="仅保存备用")'), 'disabled/saved-only prompt leaked into menu');
  // The library permits 50 entries. Registered menus must remain usable near the viewport edge.
  world.state.quickChatPrompts.push(...Array.from({ length: 47 }, (_, index) => ({ id: `many-${index}`, name: `记录模板 ${index + 1}`, prompt: '整理文字', builtin: false, context_menu: true })));
  await execute('const text=document.querySelector("#detail h1");text.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:innerWidth-8,clientY:innerHeight-8}))');
  assert(await wait('[...document.querySelectorAll("#context-menu button")].some(node=>node.textContent==="记录模板 47")'), 'large Prompt menu incomplete');
  assert(await execute('const menu=document.querySelector("#context-menu"),rect=menu.getBoundingClientRect();return menu.scrollHeight>menu.clientHeight&&rect.top>=0&&rect.bottom<=innerHeight&&rect.right<=innerWidth'), '50-Prompt menu overflowed viewport or cannot scroll');
  await screenshot('prompt-menu-50-dark-320');
  await execute('const node=[...document.querySelectorAll("#context-menu button")].find(node=>node.textContent.startsWith("引用：所选文字"));node.click()');
  assert(await execute('return document.querySelector("#composer-chat-open").getClientRects().length===0&&document.documentElement.scrollWidth<=innerWidth'), 'collapsed mobile composer overflow or extra action');
  await click('#composer-expand');
  await click('#composer-chat-open'); assert(await wait('document.querySelector("#input-form").dataset.mode==="chat"&&!document.querySelector("#draft-commit").disabled'), 'reference-only chat mode disabled');
  assert(await execute('return document.querySelector("#composer-chat-controls a").getAttribute("href")==="/p/aaaaaaaaaaaaaaaa/#quick-chat-settings"'), 'composer settings link lost project identity');
  await click('#composer-expand');
  assert(await execute('return document.querySelector("#input-form").dataset.expanded==="false"&&document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll(".composer-actions button")].filter(node=>node.getClientRects().length).every(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})'), 'collapsed chat mode actions overflow');
  await execute('document.documentElement.dataset.theme="dark"'); await screenshot('composer-chat-dark-320');
  await execute('window.fixtureEvents=[];document.querySelector("#draft-commit").addEventListener("click",()=>fixtureEvents.push("click"));document.querySelector("#input-form").addEventListener("submit",()=>fixtureEvents.push("submit"));addEventListener("error",event=>fixtureEvents.push(event.message))');
  await click('#draft-commit');
  const consumed = await wait('document.querySelector("#composer-references").hidden');
  if (!consumed) console.log('submission diagnostics', await execute('return {events:fixtureEvents,error:document.querySelector("#error").textContent,valid:document.querySelector("#input-form").checkValidity(),mode:document.querySelector("#input-form").dataset.mode,disabled:document.querySelector("#draft-commit").disabled,html:document.querySelector("#draft-commit").outerHTML}'));
  assert(consumed, 'sent references were not consumed');
  const handles = await rpc(`/session/${session}/window/handles`, undefined, 'GET'); assert(handles.length === 2, 'user gesture did not open a new tab');
  assert(await execute('return location.pathname==="/p/aaaaaaaaaaaaaaaa/"'), 'project tab was replaced');
  await rpc(`/session/${session}/window`, { handle: handles.find(handle => handle !== original) });
  assert(await wait('location.pathname==="/p/aaaaaaaaaaaaaaaa/"&&location.hash==="#quick-chat-C2"&&document.querySelector(".quick-chat-thread")'), 'new tab missing project C2 detail');
  await rpc(`/session/${session}/window`, undefined, 'DELETE'); await rpc(`/session/${session}/window`, { handle: original });
  assert(world.state.actions.every(value => !['order.submit', 'draft.add', 'worker.message'].includes(value.method)), 'quick chat created Agent work');
  assert(calls.filter(value => value.includes('/quick-chat/')).every(value => value.startsWith('/p/aaaaaaaaaaaaaaaa/api/quick-chat/')), 'chat API accessed another project or old global route');
  console.log(JSON.stringify({ passed: true, compiled: true, themes: ['light','dark'], widths: [1440,390,320], conversations: [...world.state.quickChats.keys()], screenshots: output, calls: world.state.quickChatActions.map(value => value.method) }, null, 2));
} catch (error) { errors.push(error.message); throw error; }
finally {
  if (session) { try { await rpc(`/session/${session}`, undefined, 'DELETE'); } catch {} }
  driver.kill(); await driver.exited; server.stop(true); fs.rmSync(scratch, { recursive: true, force: true });
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ errors, calls }, null, 2));
}
