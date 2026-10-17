import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
import { installDom, dialogButton } from '../dom-stub.js';
import { openProjectAutomation } from '../../src/ui/web/assets/render-project-automation.js';
import { ui } from '../../src/ui/web/assets/state.js';

test('real automation DOM saves project defaults through HTTP/RPC and applies them to future Workers', async () => {
  const f = await setup(); let dom;
  try {
    await repo(f.root); f.project.kick = () => {};
    const old = (await f.project.order('existing', 'main', [], null, false)).task;
    const writes = [];
    dom = installDom({ fetch: (url, options = {}) => {
      if (options.body) writes.push(JSON.parse(options.body));
      return fetch(f.url + url, { ...options, headers: { ...options.headers, Origin: f.url } });
    } });
    await openProjectAutomation({ feature: 'completion' });
    const root = dom.node('detail'); await root.querySelector('[data-level="accept"]').onclick();
    const saving = root.querySelectorAll('button').find(item => item.textContent === '保存项目设置').onclick();
    await dialogButton(dom, '授权并保存').onclick(); await saving;
    expect(writes[0].method).toBe('hooks.automation_settings');
    expect(f.project.automationSettings().completion_defaults).toEqual({ enabled: true, level: 'accept' });
    expect(f.project.taskHooks(old.id).completion.level).toBe('off');
    const fresh = (await f.project.order('future', 'main', [], null, false)).task;
    expect(f.project.taskHooks(fresh.id).completion.level).toBe('accept');
  } finally { ui.disposeProjectAutomation?.(); dom?.restore(); await f.close(); }
});
