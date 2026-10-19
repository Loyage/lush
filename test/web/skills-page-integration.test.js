import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { installDom, deepText } from '../dom-stub.js';
import { env, temp } from '../helpers.js';
import { startTestWeb, fetch } from './auth-fixture.js';
import { AGENT_CAPABILITIES, listCapabilityGuides } from '../../src/agent/capabilities.js';
import { RuntimeSettings } from '../../src/core/settings.js';
import { agentPrompt } from '../../src/agent/prompts.js';
import { openSkills } from '../../src/ui/web/assets/render-skills.js';


const switchFor = (dom, setting) => dom.node('detail').querySelector(`[data-runtime-input="${setting}"]`);

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
    expect(calls.some(call => call.route.startsWith('/api/host/skills?'))).toBe(false);
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
      const card = dom.node('detail').querySelectorAll('.skill-card').find(node => node.dataset.skill === skill.id);
      const source = card.querySelector('.skill-source');
      expect(card.querySelectorAll('details')).toHaveLength(1);
      expect(source.querySelector('summary').textContent).toBe('展开');
      expect(source.querySelector('.skill-details').querySelector('h3').textContent).toBe('使用说明');
      expect(deepText(source.querySelector('.skill-details'))).toContain(skill.trigger);
      expect(source.open).toBeFalsy();
      const writes = calls.filter(call => call.options?.method === 'POST').length;
      source.open = true; await source.ontoggle();
      expect(source.querySelector('summary').textContent).toBe('收起');
      expect(source.querySelector('[data-skill-document="entry"]').textContent).toBe(fs.readFileSync(skill.skill, 'utf8'));
      expect(source.querySelector('[data-skill-document="guide"]').textContent).toBe(fs.readFileSync(skill.guide, 'utf8'));
      expect(source.querySelector('textarea')).toBeNull(); expect(source.querySelector('input')).toBeNull();
      expect(calls.filter(call => call.options?.method === 'POST')).toHaveLength(writes);
      const reads = calls.length; source.open = false; await source.ontoggle();
      expect(source.querySelector('summary').textContent).toBe('展开');
      source.open = true; await source.ontoggle();
      expect(calls).toHaveLength(reads); // cache only in this mounted panel
    }
    expect(agentPrompt(config, 'agent', {}, 'order').builtin_skills).toEqual([]);
    const second = new RuntimeSettings({ home: path.join(root, 'project-b'), deviceHome: path.join(device, 'shared') });
    expect(AGENT_CAPABILITIES.every(skill => second.get()[skill.setting].value === false)).toBe(true);
    await dom.node('detail').querySelector('[data-capability-reset=""]').onclick();
    expect(JSON.parse(calls.at(-1).options.body).params.settings).toEqual(Object.fromEntries(AGENT_CAPABILITIES.map(skill => [skill.setting, null])));
    expect(agentPrompt(config, 'agent', {}, 'order').builtin_skills).toEqual(before.builtin_skills);
    expect(second.get().result_notice.value).toBe(true);
    expect(calls.every(call => call.route.startsWith('/api/host/settings/') || call.route.startsWith('/api/host/skills?id='))).toBe(true);
    expect(runtimeSettings.get().result_notice.value).toBe(true);
  } finally { dom?.restore(); await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});
