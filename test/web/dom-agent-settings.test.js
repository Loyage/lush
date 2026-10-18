import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { renderAgentSettings } from '../../src/ui/web/assets/settings-agent.js';
import { disposePageModules } from '../../src/ui/web/assets/page-modules.js';

test('default Agent keeps its header and fold control outside the preserved profile draft', () => {
  const world = makeWorld(), dom = installDom({ fetch: world.fetchImpl });
  try {
    const panel = dom.node('detail');
    panel.append(renderAgentSettings(world.state.agentConfig, () => {}));
    const card = panel.querySelector('[data-agent-target="default"]');
    const head = card.querySelector('.agent-profile-head'), body = card.querySelector('.module-body');
    const toggle = head.querySelector('.module-toggle');
    expect(head.parentNode).toBe(card);
    expect(deepText(head)).toContain('默认 Agent');
    expect(deepText(head)).toContain('设备默认');
    expect(toggle.getAttribute('aria-controls')).toBe(body.id);
    expect(body.hidden).toBe(false);
    const prompt = body.querySelector('[data-agent-field="append_prompt"]');
    prompt.value = 'unsaved default Agent prompt';
    toggle.onclick();
    expect(body.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(head.parentNode).toBe(card);
    toggle.onclick();
    expect(body.hidden).toBe(false);
    expect(body.querySelector('[data-agent-field="append_prompt"]')).toBe(prompt);
    expect(prompt.value).toBe('unsaved default Agent prompt');
  } finally { disposePageModules(); dom.restore(); }
});
