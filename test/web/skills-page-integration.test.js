import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { installDom, deepText } from '../dom-stub.js';
import { env, temp, gate } from '../helpers.js';
import { startTestWeb, fetch } from './auth-fixture.js';
import { AGENT_CAPABILITIES, listCapabilityGuides } from '../../src/agent/capabilities.js';
import { RuntimeSettings } from '../../src/core/settings.js';
import { agentPrompt } from '../../src/agent/prompts.js';
import { openSkills } from '../../src/ui/web/assets/render-skills.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { makeWorld } from './dom-world.js';

const switchFor = (dom, setting) => dom.node('detail').querySelector(`[data-runtime-input="${setting}"]`);
const refresh = dom => dom.node('detail').querySelectorAll('button').find(node => node.textContent === '重新读取');

test('Skills page -> authenticated Host -> device writer -> next Pi/Codex prompt uses the same registry without a project', async () => {
  const root = temp(), device = path.join(root, 'device');
  const web = startTestWeb(null, 0, { env: env({ LUSH_GLOBAL_CONFIG: device }) }), base = `http://127.0.0.1:${web.port}`;
  const calls = []; let dom;
  try {
    dom = installDom({ fetch: (route, options) => { calls.push({ route: String(route), options }); return fetch(base + route, options); } });
    const runtimeSettings = new RuntimeSettings({ home: path.join(root, 'project-a'), deviceHome: path.join(device, 'shared') });
    const config = { project: path.join(root, 'project-a'), home: path.join(root, 'project-a'), runtimeSettings };
    const before = agentPrompt(config, 'agent', {}, 'order');
    await openSkills();
    expect(calls).toHaveLength(1); expect(calls[0].route).toBe('/api/host/settings/runtime?scope=device');
    const data = await (await fetch(base + '/api/host/settings/runtime?scope=device')).json();
    expect(data.builtin_skills).toEqual(listCapabilityGuides());
    expect(JSON.stringify(data.builtin_skills)).not.toContain('SKILL.md');
    expect(dom.node('detail').querySelectorAll('.skill-card').map(node => node.dataset.skill)).toEqual(AGENT_CAPABILITIES.map(skill => skill.id));
    expect(deepText(dom.node('detail'))).toContain('不是权限隔离');
    for (const skill of AGENT_CAPABILITIES) {
      const input = switchFor(dom, skill.setting); expect(input.checked).toBe(true);
      input.checked = false; await input.onchange();
      const action = JSON.parse(calls.at(-1).options.body);
      expect(action).toEqual({ method: 'system.configure', params: { scope: 'device', settings: { [skill.setting]: false } } });
      expect(input.checked).toBe(false); expect(input.disabled).toBe(false);
      for (const profile of [{}, { config_mode: 'pi' }, { agent: 'codex' }]) {
        const after = agentPrompt(config, 'agent', profile, 'order');
        expect(after.builtin_skills).not.toContain(skill.skill); expect(after.text).toContain(`${skill.id}（${skill.title}）`);
      }
      expect(before.builtin_skills).toContain(skill.skill); // the old invocation snapshot is untouched
    }
    expect(agentPrompt(config, 'agent', {}, 'order').builtin_skills).toEqual([]);
    const second = new RuntimeSettings({ home: path.join(root, 'project-b'), deviceHome: path.join(device, 'shared') });
    expect(AGENT_CAPABILITIES.every(skill => second.get()[skill.setting].value === false)).toBe(true);
    await dom.node('detail').querySelector('[data-capability-reset=""]').onclick();
    expect(JSON.parse(calls.at(-1).options.body).params.settings).toEqual(Object.fromEntries(AGENT_CAPABILITIES.map(skill => [skill.setting, null])));
    expect(agentPrompt(config, 'agent', {}, 'order').builtin_skills).toEqual(before.builtin_skills);
    expect(second.get().result_notice.value).toBe(true);
    expect(calls.every(call => call.route.startsWith('/api/host/settings/'))).toBe(true);
    for (const params of [{ _token: 'synthetic-test-token', settings: { result_notice: false } }, { scope: 'project', settings: { result_notice: false } }]) {
      const rejected = await fetch(base + '/api/host/settings/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'system.configure', params }) });
      expect(rejected.status).toBeGreaterThanOrEqual(400);
    }
    expect(runtimeSettings.get().result_notice.value).toBe(true);
  } finally { dom?.restore(); await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Skills restores confirmed state after failed save, rereads before editing, and ignores late saves after navigation', async () => {
  const world = makeWorld(), pending = gate(); let mode = 'fail', writes = 0;
  const dom = installDom({ fetch: (route, options) => {
    if (options?.method === 'POST') {
      writes++;
      if (mode === 'fail') return Promise.resolve(Response.json({ error: 'fixture write failed' }, { status: 503 }));
      if (mode === 'defer') return pending.promise;
    }
    return world.fetchImpl(route, options);
  } });
  try {
    await openSkills(); const input = switchFor(dom, 'result_notice'); input.checked = false; await input.onchange();
    expect(input.checked).toBe(true); expect(input.disabled).toBe(true);
    expect(deepText(dom.node('detail'))).toContain('保存未确认');
    expect(input.parentNode.getAttribute('data-help')).toContain('重新读取');
    await input.onchange(); expect(writes).toBe(1);
    mode = 'normal'; await refresh(dom).onclick();
    const fresh = switchFor(dom, 'result_notice'); expect(fresh.disabled).toBe(false);
    mode = 'defer'; fresh.checked = false; const saving = fresh.onchange();
    expect(fresh.disabled).toBe(true);
    activateDetailView({ view: 'projects' }); dom.node('detail').replaceChildren(dom.document.createElement('article'));
    const next = dom.node('detail').children[0];
    pending.resolve(await world.fetchImpl('/api/host/settings/action', { method: 'POST', body: JSON.stringify({ method: 'system.configure', params: { settings: { result_notice: false } } }) }));
    await saving; expect(dom.node('detail').children[0]).toBe(next);
    mode = 'normal'; await openSkills(); expect(switchFor(dom, 'result_notice').checked).toBe(false);
  } finally { dom.restore(); }
});

test('Skills rejects incomplete Host metadata, allows explicit read retry and does not repaint after a late read', async () => {
  const world = makeWorld(), pending = gate(); let mode = 'incomplete';
  const dom = installDom({ fetch: (route, options) => {
    if (mode === 'incomplete') return Promise.resolve(Response.json({ ...world.state.runtimeSettings, builtin_skills: undefined,
      configuration_scope: { selected: 'device', source: 'device', project_override: false } }));
    if (mode === 'defer') return pending.promise;
    return world.fetchImpl(route, options);
  } });
  try {
    await openSkills(); expect(switchFor(dom, 'result_notice')).toBeNull();
    expect(deepText(dom.node('detail'))).toContain('请更新界面服务');
    expect(dom.node('detail').querySelector('[data-capability-reset=""]').disabled).toBe(true);
    mode = 'normal'; await refresh(dom).onclick(); expect(switchFor(dom, 'result_notice').checked).toBe(true);
    mode = 'defer'; const reading = refresh(dom).onclick();
    activateDetailView({ view: 'projects' }); dom.node('detail').textContent = 'new page';
    pending.resolve(await world.fetchImpl('/api/host/settings/runtime?scope=device')); await reading;
    expect(dom.node('detail').textContent).toBe('new page');
  } finally { dom.restore(); }
});
