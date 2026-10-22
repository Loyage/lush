// Real Firefox + isolated HTTP fixture. No daemon, real account, upstream probe or model call.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { request } from 'node:http';
import { makeWorld } from './dom-world.js';

const assets = new URL('../../src/ui/web/assets/', import.meta.url).pathname;
const config = structuredClone(makeWorld().state.agentConfig);
const id = '11111111-1111-4111-8111-111111111111';
Object.assign(config.default, { agent: 'pi', connection_id: id, model: 'openai-compatible/vendor/chat', thinking: 'high' });
config.roles = {};
for (const role of [...Object.keys(config.resolved), 'manager']) config.resolved[role] = { ...config.default };
const source = { id, label: '用于验证布局的长名称模型来源 '.repeat(4), provider: 'openai-compatible', enabled: true, auth_type: 'api_key',
  endpoint: `https://example.invalid/${'long-endpoint/'.repeat(12)}v1`, models: ['vendor/chat', 'vendor/second-model'], default_model: 'vendor/chat', default_thinking: 'low', credential: { status: 'configured' }, storage_scope: 'device' };
const registry = new Map();
const safe = row => ({ ...row, selectable: true, reason: null, source: { ...source, credential_status: 'configured' }, storage_scope: 'device' });
registry.set('model-a', safe({ id: 'model-a', name: 'astra', connection_id: id, model: 'openai-compatible/vendor/chat' }));
registry.set('model-b', safe({ id: 'model-b', name: 'second', connection_id: id, model: 'openai-compatible/vendor/second-model' }));
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['styles.css', 'styles-core.css', 'styles-agent-status.css', 'styles-agent-connections.css', 'styles-hooks.css'].map(name => `<link rel="stylesheet" href="/assets/${name}">`).join('')}
</head><body style="margin:0;padding:12px;box-sizing:border-box"><div id="detail"></div><div id="modal" hidden></div><div id="error"></div>
<script type="module">
import { createAgentConnectionPicker } from '/assets/agent-connection-picker.js';
import { createProfileForm } from '/assets/agent-profile-form.js';
import { createManagementProfileForm } from '/assets/management-profile-form.js';
import { renderAgentSettings } from '/assets/render-settings.js';
import { createRegisteredModels } from '/assets/registered-models.js';
import { settingsClient } from '/assets/settings-api.js';
window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
const config=${JSON.stringify(config)};
const attach=(name,node)=>{const section=document.createElement('section');section.dataset.fixture=name;const title=document.createElement('h2');title.textContent=name;section.append(title,node);document.body.append(section);return section;};
const settings=attach('Agent配置',renderAgentSettings(config,()=>{}));settings.classList.add('agent-status-page');
const form=createProfileForm({profile:config.default,settings:config,role:'agent'});attach('完整运行设置',form.node);await form.ready;
const creation=createProfileForm({profile:{...config.default,connection_id:'',model:''},settings:config,role:'agent'});attach('新建与Hook共用表单',creation.node);await creation.ready;
const manager=createManagementProfileForm(config);attach('管理Agent',manager.node);await manager.ready;
const backend=document.createElement('select');const opt=document.createElement('option');opt.value='pi';backend.append(opt);backend.value='pi';
const model=document.createElement('input');model.value=config.default.model;
const picker=createAgentConnectionPicker({backend,model,connectionId:config.default.connection_id});attach('共享模型选择器',picker.node);await picker.load();
const registration=createRegisteredModels({client:settingsClient(),ownsPage:()=>true,openSources:()=>{window.sourceRequested=true;}});attach('注册管理',registration.node);await registration.load();
window.forms={form,creation,manager,picker,registration,model};window.ready=true;
</script></body></html>`;
const calls = [], writes = [];
let rejectSecond = true, holdRead = null;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const url = new URL(req.url), path = url.pathname.replace(/^\/api\/host\/settings\//, '/api/');
  if (path === '/') return new Response('<!doctype html><html><body style="margin:0"><iframe id="viewport" src="/fixture" style="width:1440px;height:900px;border:0"></iframe></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (path === '/fixture') return new Response(fixture, { headers: { 'Content-Type': 'text/html' } });
  if (/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) return new Response(Bun.file(join(assets, path.split('/').at(-1))));
  if (path === '/shared/web-push-protocol.js') return new Response(Bun.file(new URL('../../src/shared/web-push-protocol.js', import.meta.url)));
  if (path === '/favicon.ico') return new Response(null, { status: 204 });
  calls.push(url.pathname);
  if (path === '/api/action' && req.method === 'POST') {
    const action = await req.json(); writes.push(action);
    if (!url.pathname.startsWith('/api/host/settings/') || action.params.scope !== 'device') return Response.json({ error: 'wrong write boundary' }, { status: 400 });
    if (action.method === 'agent.registered_models.save') {
      const row = action.params.model;
      if (row.name === 'retry-second' && rejectSecond) return Response.json({ error: 'fixture save failed' }, { status: 409 });
      if ([...registry.values()].some(item => item.id !== row.id && item.name === row.name)) return Response.json({ error: 'name conflict' }, { status: 409 });
      const saved = safe({ ...row, id: row.id || `registered-${registry.size + 1}` }); registry.set(saved.id, saved); return Response.json(saved);
    }
    if (action.method === 'agent.registered_models.remove') { registry.delete(action.params.id); return Response.json({ removed: action.params.id }); }
    return Response.json({ error: 'unexpected mutation' }, { status: 400 });
  }
  if (req.method !== 'GET') return Response.json({ error: 'unexpected mutation' }, { status: 400 });
  if (path === '/api/host') return Response.json({ mode: 'launcher', projects: [] });
  if (path === '/api/agent/connections') return Response.json({ version: 1, connections: [source], configuration_scope: { selected: url.searchParams.get('scope') || 'project', source: 'device' } });
  if (path === '/api/agent/registered-models') {
    const data = { version: 1, models: [...registry.values()], storage_scope: 'device' };
    if (holdRead) { const hook = holdRead; holdRead = null; await hook(); }
    return Response.json(data);
  }
  if (path === '/api/agent/connections/models') return Response.json({ version: 1, status: 'unknown', models: [] });
  if (path === '/api/agent/packages') return Response.json({ version: 1, packages: [], resources: { extensions: [], skills: [] } });
  if (path === '/api/agent/models') return Response.json({ models: [{ id: 'cli-only', label: 'CLI only' }] });
  return Response.json({ error: `unexpected request ${path}` }, { status: 400 });
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const temp = await mkdtemp(join(tmpdir(), 'lush-model-choice-')), log = join(temp, 'geckodriver.log');
const driver = Bun.spawn(['geckodriver', '--host', '127.0.0.1', '--port', String(port)], { env: { ...process.env, MOZ_HEADLESS: '1' }, stdout: Bun.file(log), stderr: Bun.file(log) });
let session;
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
const run = script => rpc(`/session/${session}/execute/async`, { script: `const done=arguments[0];(async()=>{${script}})().then(done,e=>done({error:String(e)}));`, args: [] }).then(value => { if (value?.error) throw Error(value.error); return value; });
const assert = (condition, message) => { if (!condition) throw Error(message); };
async function enterViewport() { const frame = await rpc(`/session/${session}/element`, { using: 'css selector', value: '#viewport' }); await rpc(`/session/${session}/frame`, { id: frame }); }
async function screenshot(name) { await Bun.write(join(temp, `${name}.png`), Buffer.from(await rpc(`/session/${session}/screenshot`, undefined, 'GET'), 'base64')); }
const key = value => rpc(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }] });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await rpc('/status', undefined, 'GET'); ready = true; break; } catch {} if (driver.exitCode !== null) throw Error('geckodriver exited'); await Bun.sleep(100); }
  assert(ready, 'geckodriver startup timed out');
  session = (await rpc('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  await rpc(`/session/${session}/window/rect`, { width: 1600, height: 1000 });
  await rpc(`/session/${session}/url`, { url: `http://127.0.0.1:${server.port}/` }); await enterViewport();
  const loaded = await rpc(`/session/${session}/execute/async`, { script: 'const done=arguments[0];let n=0;const check=()=>window.ready?done(true):++n>200?done(false):setTimeout(check,20);check();', args: [] });
  assert(loaded, `fixture failed to load: ${JSON.stringify(await execute('return window.errors'))}`);
  assert(await execute(`return forms.creation.picker.models.value===''&&forms.creation.collect().model===''&&forms.creation.validate();`), 'empty creation silently picked first model');
  await execute(`for(const p of [forms.form.picker,forms.creation.picker,forms.manager.picker,forms.picker]){p.models.value='model-b';p.models.dispatchEvent(new Event('change',{bubbles:true}));}`);
  assert(await execute(`return forms.form.collect().model==='openai-compatible/vendor/second-model'&&forms.form.collect().thinking==='high'&&forms.manager.collect().thinking==='high'&&!forms.creation.validate();`), 'shared choice did not freeze binding or changed thinking');
  await execute(`const device=document.querySelector('[data-fixture="Agent配置"]');device.querySelector('[data-agent-field=thinking]').value='';const choice=device.querySelector('[data-registered-model]');choice.value='model-b';choice.dispatchEvent(new Event('change'));`);
  assert(await execute(`return document.querySelector('[data-fixture="Agent配置"] [data-agent-field=thinking]').value==='';`), 'model choice overwrote explicitly empty thinking depth');
  registry.set('model-b', safe({ id: 'model-b', name: 'second-new', connection_id: id, model: 'openai-compatible/vendor/chat' }));
  await run(`await forms.form.picker.load();return true;`);
  assert(await execute(`return forms.form.collect().model==='openai-compatible/vendor/second-model'&&forms.form.picker.models.value===''&&forms.form.picker.node.textContent.includes('不一致');`), 'registration edit retargeted frozen binding');
  await execute(`forms.form.picker.models.value='model-b';forms.form.picker.models.dispatchEvent(new Event('change'));`);
  assert(await execute(`return forms.form.collect().model==='openai-compatible/vendor/chat'&&forms.form.collect().thinking==='high';`), 'explicit reselection did not apply new binding');
  // A late read must not replace a choice made while that read was in flight.
  let release, started;
  const startedPromise = new Promise(resolve => started = resolve);
  holdRead = () => { started(); return new Promise(resolve => release = resolve); };
  await execute(`window.lateRead=forms.picker.load();`); await startedPromise;
  await execute(`forms.picker.models.value='model-a';forms.picker.models.dispatchEvent(new Event('change'));`);
  release(); await run(`await window.lateRead;return true;`);
  assert(await execute(`return forms.model.value==='openai-compatible/vendor/chat';`), 'late list replaced choice');
  registry.delete('model-a');
  await run(`await forms.picker.load();return true;`);
  assert(await execute(`return forms.model.value==='openai-compatible/vendor/chat'&&forms.picker.models.value===''&&!forms.picker.validate()&&forms.picker.node.textContent.includes('删除');`), 'deleted registration broke frozen save');
  await execute(`forms.model.value='openai-compatible/legacy';forms.picker.reset('${id}');`);
  assert(await execute(`return forms.picker.node.textContent.includes('未注册当前配置')&&!forms.picker.validate();`), 'legacy profile not preserved');
  console.log('PASS shared device/Worker/creation/Hook/management selector, no implicit first choice, independent thinking, frozen edit/delete and late reads');

  // Register from the existing source range (physical IDs retain slashes), two items with partial failure.
  await run(`await forms.registration.load();await document.querySelector('[data-register-model=add]').onclick();return true;`);
  await execute(`const s=document.querySelector('[data-registered-source]');s.value='${id}';s.dispatchEvent(new Event('change'));`);
  await rpc(`/session/${session}/execute/async`, { args: [], script: `const done=arguments[0];let n=0;const check=()=>document.querySelectorAll('[data-registered-candidate]').length===2?done(true):++n>200?done(false):setTimeout(check,20);check();` }).then(ok => assert(ok, 'local source range missing'));
  await execute(`const rows=[...document.querySelectorAll('.registered-model-candidate')];rows.forEach((r,i)=>{const c=r.querySelector('input[type=checkbox]');c.checked=true;c.dispatchEvent(new Event('change'));r.querySelector('[data-registered-name]').value=i?'retry-second':'registered-chat';});`);
  await run(`await document.querySelector('[data-registered-save]').onclick();return true;`);
  assert(writes.length === 2 && registry.size === 2, 'partial batch results wrong');
  assert(await execute(`return document.querySelector('.registered-model-editor').textContent.includes('成功 1 项，失败 1 项')&&document.querySelector('[data-registered-name]').disabled;`), 'partial success not visible/locked');
  rejectSecond = false;
  await run(`await document.querySelector('[data-registered-save]').onclick();return true;`);
  assert(writes.length === 3 && writes.filter(action => action.params.model?.name === 'registered-chat').length === 1, 'retry resent a successful registration');
  assert(writes.at(-1).params.model.model === 'openai-compatible/vendor/second-model', 'physical ID slash was lost');
  console.log('PASS real browser registration through Host device transport, manual source range, per-item partial success and retry without duplicate writes');

  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 640, 390, 320]) {
    await rpc(`/session/${session}/frame`, { id: null }); await execute(`document.querySelector('#viewport').style.width='${width}px';`); await enterViewport();
    await execute(`document.documentElement.dataset.theme='${theme}';`);
    const result = await execute(`
      const groups=[...document.querySelectorAll('.agent-connection-binding')].filter(g=>g.getClientRects().length),errors=[];
      for(const group of groups){
        const choice=group.querySelector('[data-registered-model]'),binding=group.querySelector('[data-registered-binding]');
        if(choice.labels.length!==1||group.closest('label'))errors.push('ambiguous label');
        if([...group.querySelectorAll('input')].some(n=>n.checkVisibility()))errors.push('Pi model input remains editable/visible');
        const c=choice.getBoundingClientRect(),b=binding.getBoundingClientRect();if(c.bottom>b.top+1)errors.push('binding overlaps selector');
        if(c.right>innerWidth+1||c.left<0)errors.push('clipped selection');
      }
      for(const row of document.querySelectorAll('.registered-model-row')){const r=row.getBoundingClientRect();if(row.scrollWidth>row.clientWidth)errors.push('model row overflow');for(const b of row.querySelectorAll('button')){const box=b.getBoundingClientRect();if(box.right>r.right||box.bottom>r.bottom)errors.push('clipped model action');}}
      const advanced=document.querySelector('[data-retry-advanced=settings]');if(advanced.open||advanced.querySelector('textarea').checkVisibility())errors.push('advanced not collapsed');
      advanced.open=true;if(document.documentElement.scrollWidth>innerWidth)errors.push('expanded overflow');advanced.open=false;
      if(document.documentElement.scrollWidth>innerWidth)errors.push('horizontal overflow');return {errors,groups:groups.length,browserErrors:window.errors};`);
    assert(result.groups === 5 && !result.errors.length && !result.browserErrors.length, `${theme} ${width}: ${JSON.stringify(result)}`);
    await execute(`document.querySelector('.registered-models').scrollIntoView({block:'start'});`); await screenshot(`registration-${theme}-${width}`);
    console.log(`PASS ${theme} ${width}px: five shared selectors, read-only bindings, collapsed advanced, visible registration actions, no overflow`);
  }
  await run(`await [...document.querySelectorAll('.registered-model-editor button')].find(b=>b.textContent==='关闭登记面板').onclick();await document.querySelector('.registered-model-row button').onclick();return true;`);
  assert(await execute(`return !document.querySelector('.registered-model-editor details').open&&document.querySelector('[data-registered-name=edit]').value==='second-new';`), 'Edit must keep binding controls in collapsed advanced');
  await execute(`document.querySelector('[data-registered-name=edit]').value='registered-chat';`);
  const beforeConflict = writes.length;
  await run(`await document.querySelector('[data-registered-save]').onclick();return true;`);
  assert(writes.length === beforeConflict && await execute(`return document.querySelector('.registered-model-editor').textContent.includes('名称冲突')`), 'Duplicate name not reported locally');
  await execute(`document.querySelector('[data-registered-name=edit]').value='edited-second';document.querySelector('.registered-model-editor details').open=true;`);
  assert(await execute(`return document.documentElement.scrollWidth<=innerWidth;`), 'Advanced model editor overflows at 320px');
  await screenshot('edit-advanced-dark-320');
  await run(`await document.querySelector('[data-registered-save]').onclick();return true;`);
  assert(registry.get('model-b').name === 'edited-second', 'Edit did not save stable ID');
  await execute(`window.removal=document.querySelector('[data-registered-id=model-b]').querySelectorAll('button')[1].onclick();`);
  await run(`await document.querySelector('.modal-confirm').onclick();await window.removal;return true;`);
  assert(!registry.has('model-b') && await execute(`return forms.form.collect().model==='openai-compatible/vendor/chat'`), 'Delete retargeted existing profile');
  console.log('PASS local unique-name conflict, advanced edit, stable-ID save and confirmed removal without profile changes');
  await execute(`forms.picker.models.focus();`); await key('\uE004');
  assert(await execute(`return document.activeElement.textContent==='读取已注册模型';`), 'Tab did not skip read-only binding to refresh');
  await execute(`document.querySelector('[data-retry-advanced=settings]>summary').focus();`); await key('\uE007');
  assert(await execute(`return document.querySelector('[data-retry-advanced=settings]').open;`), 'Enter did not expand advanced');
  await execute(`forms.form.modeSelect.value='pi';forms.form.modeSelect.dispatchEvent(new Event('change'));`);
  assert(await execute(`return JSON.stringify(forms.form.collect())===JSON.stringify({agent:'pi',config_mode:'pi'});`), 'Pi default mode leaked managed values');
  await execute(`forms.form.modeSelect.value='lush';forms.form.modeSelect.dispatchEvent(new Event('change'));const b=forms.form.node.querySelector('[data-retry-field=agent]');b.value='codex';b.dispatchEvent(new Event('change'));`);
  assert(await execute(`const m=forms.form.node.querySelector('[data-retry-field=model]');return m.checkVisibility()&&!m.readOnly&&!forms.form.picker.value();`), 'Codex lost its own editable model/auth');
  registry.clear();
  await run(`await forms.registration.load();return true;`);
  assert(await execute(`return document.querySelector('.registered-model-empty').textContent.includes('先添加来源并登录');`), 'Empty model list lacks source/login guidance');
  for (let i=0;i<50;i++) registry.set(`limit-${i}`, safe({ id: `limit-${i}`, name: `model-${i}`, connection_id: id, model: 'openai-compatible/vendor/chat' }));
  await run(`await forms.registration.load();return true;`);
  assert(await execute(`return document.querySelectorAll('.registered-model-row').length===50&&document.querySelector('[data-register-model=add]').disabled;`), '50-model list silently truncated or allows another registration');
  assert(!calls.some(path => /models\.refresh|query|login/.test(path)), 'unexpected upstream query');
  await Bun.write(join(temp, 'requests.json'), JSON.stringify({ calls, writes }, null, 2));
  console.log(`PASS native keyboard, Pi default and Codex CLI isolation; browser evidence: ${temp}`);
} catch (error) {
  if (session) await screenshot('failure').catch(() => {});
  console.error(`Model choice browser failure; full logs: ${temp}`); throw error;
} finally {
  if (session) await rpc(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  driver.kill(); await driver.exited; server.stop(true);
}
