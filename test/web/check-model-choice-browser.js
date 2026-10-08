// Standalone: bun test/web/check-model-choice-browser.js
// Real Firefox, isolated HTTP fixtures; no daemon, real account or model call.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { makeWorld } from './dom-world.js';

const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const config = structuredClone(makeWorld().state.agentConfig);
const id = '11111111-1111-4111-8111-111111111111';
Object.assign(config.default, { agent: 'pi', connection_id: id, model: 'openai-compatible/vendor/chat' });
config.roles = {};
for (const role of [...Object.keys(config.resolved), 'manager']) config.resolved[role] = { ...config.default };
const source = { id, label: '用于验证布局的长名称模型来源 '.repeat(4), provider: 'openai-compatible', enabled: true, auth_type: 'api_key',
  endpoint: `https://example.invalid/${'long-endpoint/'.repeat(12)}v1`, models: ['vendor/chat', 'vendor/second-model'], default_model: 'vendor/chat', credential: { status: 'configured' } };
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['styles.css', 'styles-core.css', 'styles-agent-status.css', 'styles-agent-connections.css', 'styles-hooks.css', 'styles-quick-explanation.css'].map(name => `<link rel="stylesheet" href="/assets/${name}">`).join('')}
</head><body style="margin:0;padding:12px;box-sizing:border-box"><div id="detail"></div><div id="modal" hidden></div><div id="error"></div>
<script type="module">
import { createAgentConnectionPicker } from '/assets/agent-connection-picker.js';
import { createProfileForm } from '/assets/agent-profile-form.js';
import { createManagementProfileForm } from '/assets/management-profile-form.js';
import { renderAgentSettings } from '/assets/render-settings.js';
import { openQuickExplanationPage } from '/assets/render-quick-explanation.js';
window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
const config=${JSON.stringify(config)};
const attach=(name,node)=>{const section=document.createElement('section');section.dataset.fixture=name;const title=document.createElement('h2');title.textContent=name;section.append(title,node);document.body.append(section);return section;};
const settings=attach('Agent配置',renderAgentSettings(config,()=>{}));settings.classList.add('agent-status-page');
const form=createProfileForm({profile:config.default,settings:config,role:'agent',collapseAdvanced:true});attach('完整运行设置',form.node);await form.ready;await form.picker.load();
const manager=createManagementProfileForm(config);attach('管理Agent',manager.node);await manager.picker.load();
const backend=document.createElement('select');backend.value='';const opt=document.createElement('option');opt.value='pi';backend.append(opt);backend.value='pi';
const model=document.createElement('input');model.value=config.default.model;
const picker=createAgentConnectionPicker({backend,model,connectionId:config.default.connection_id});attach('共享模型选择器',picker.node);await picker.load();
await openQuickExplanationPage();document.querySelector('#detail').dataset.fixture='快捷解释';
window.forms={form,manager,picker};window.ready=true;
</script></body></html>`;
const calls = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const url = new URL(req.url), path = url.pathname.replace(/^\/api\/host\/settings\//, '/api/');
  if (path === '/') return new Response('<!doctype html><html><body style="margin:0"><iframe id="viewport" src="/fixture" style="width:1440px;height:900px;border:0"></iframe></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (path === '/fixture') return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
  if (/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.split('/').at(-1))));
  if (path === '/favicon.ico') return new Response(null, { status: 204 });
  calls.push(path); if (req.method !== 'GET') return Response.json({ error: 'unexpected mutation' }, { status: 400 });
  if (path === '/api/host') return Response.json({ mode: 'launcher', projects: [] });
  if (path === '/api/agent/connections') return Response.json({ version: 1, connections: [source], configuration_scope: { selected: url.searchParams.get('scope') || 'project', source: 'device' } });
  if (path === '/api/agent/connections/models') return Response.json({ version: 1, status: 'unknown', models: [] });
  if (path === '/api/agent/packages') return Response.json({ version: 1, packages: [], resources: { extensions: [], skills: [] } });
  if (path === '/api/quick-explain/config') return Response.json({ connection_id: id, model: 'vendor/chat', ready: true, default_prompt: '请简洁解释', configuration_scope: { selected: 'device', source: 'device' } });
  if (path === '/api/quick-explain/history') return Response.json({ items: [] });
  return Response.json({ error: `unexpected request ${path}` }, { status: 400 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-model-choice-')), log = join(temp, 'geckodriver.log');
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log) });
let session, passed = false;
async function rpc(path, body, method = 'POST') {
  const result = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('WebDriver timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const data = JSON.parse(result.text); if (result.status >= 400) throw Error(JSON.stringify(data)); return data.value;
}
const execute = script => rpc(`/session/${session}/execute/sync`, { script, args: [] });
const assert = (condition, message) => { if (!condition) throw Error(message); };
async function enterViewport() {
  const frame = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' });
  await rpc(`/session/${session}/frame`, { id: frame });
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {}
    if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100);
  }
  assert(ready, 'geckodriver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1000 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` }); await enterViewport();
  const loaded = await rpc(`/session/${session}/execute/async`, { script: 'const done=arguments[0];let n=0;const check=()=>window.ready?done(true):++n>200?done(false):setTimeout(check,20);check();', args: [] });
  assert(loaded, `fixture failed to load: ${JSON.stringify(await execute('return {errors:window.errors,calls:performance.getEntriesByType("resource").map(e=>e.name)}'))}`);
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 640, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null });
    await execute(`document.querySelector('#viewport').style.width='${width}px';`); await enterViewport();
    await execute(`document.documentElement.dataset.theme='${theme}';`);
    const result = await execute(`
      const groups=[...document.querySelectorAll('.agent-connection-binding')].filter(g=>g.getClientRects().length),errors=[];
      for(const group of groups){
        const row=group.querySelector('.model-choice-row'),candidate=row.querySelector('select'),model=row.querySelector('input');
        const c=candidate.getBoundingClientRect(),m=model.getBoundingClientRect(),r=row.getBoundingClientRect();
        const actions=group.querySelector('.model-source-actions').getBoundingClientRect();
        if(group.querySelectorAll('select').length!==2||model.labels.length!==1||candidate.labels.length!==1||group.closest('label'))errors.push('ambiguous labels/duplicates');
        if(Math.min(c.right,m.right)>Math.max(c.left,m.left)+1&&Math.min(c.bottom,m.bottom)>Math.max(c.top,m.top)+1)errors.push('overlap');
        if(innerWidth>640 ? Math.abs(c.top-m.top)>1||m.left-c.right>10 : m.top-c.bottom>30||m.top<c.bottom)errors.push('candidate and name are not adjacent');
        if(actions.top<r.bottom-1)errors.push('actions interrupt selection');
        const physical=!!model.dataset.quickField,expected=physical?'vendor/chat':'openai-compatible/vendor/chat';
        model.value=expected;model.dispatchEvent(new Event('input',{bubbles:true}));if(candidate.value!==expected)errors.push('typing did not select candidate');
        model.value='manual/model';model.dispatchEvent(new Event('input',{bubbles:true}));if(candidate.value!==''||model.value!=='manual/model')errors.push('draft not preserved');
        candidate.value=expected;candidate.dispatchEvent(new Event('change',{bubbles:true}));if(model.value!==expected||candidate.value!==expected)errors.push('candidate did not fill name');
        for(const control of [model,candidate]){const b=control.getBoundingClientRect();if(b.right>innerWidth+1||b.left<0)errors.push('clipped control');}
      }
      const advanced=document.querySelector('[data-retry-advanced="settings"]');
      if(advanced.open||advanced.querySelector('textarea').checkVisibility())errors.push('advanced settings not collapsed');
      advanced.open=true;
      for(const control of advanced.querySelectorAll('input,select,textarea')){const b=control.getBoundingClientRect();if(b.right>innerWidth+1||b.left<0)errors.push('clipped advanced control');}
      if(document.documentElement.scrollWidth>innerWidth)errors.push('expanded horizontal overflow');
      advanced.open=false;
      if(document.documentElement.scrollWidth>innerWidth)errors.push('horizontal overflow');
      return {errors,groups:groups.length,browserErrors:window.errors,configurationError:document.querySelector('.quick-explanation-settings')?.textContent.includes('配置读取失败')};`);
    assert(result.groups === 5 && !result.errors.length && !result.browserErrors.length, `${theme} ${width}: ${JSON.stringify(result)}`);
    console.log(`PASS ${theme} ${width}px: five model groups, adjacent controls, explicit labels, draft/selection sync, no overflow`);
  }
  await execute(`window.forms.picker.models.focus();`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE004' }, { type: 'keyUp', value: '\uE004' }] }] });
  assert(await execute(`return document.activeElement===window.forms.picker.node.querySelector('.model-choice-row input');`), 'Tab did not move directly from candidate to name');
  await execute(`document.querySelector('[data-retry-advanced="settings"]>summary').focus();`);
  await rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  assert(await execute(`return document.querySelector('[data-retry-advanced="settings"]').open;`), 'Enter did not expand advanced settings');
  assert(!calls.includes('/api/action'), 'unexpected mutation/model call');
  passed = true; console.log('PASS native keyboard Tab from candidate to editable name; fixtures only, no model calls');
} catch (error) {
  if (session) await Bun.write(join(temp, 'failure.png'), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64')).catch(() => {});
  console.error(`Model choice browser failure; full logs: ${temp}`); throw error;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true);
  if (passed) await rm(temp, { recursive: true, force: true });
}
