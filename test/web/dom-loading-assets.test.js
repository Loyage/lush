import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { installDom as installProjectDom } from './project-dom.js';
import { makeWorld } from './dom-world.js';
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { registerPageLeaveGuard } = await import('../../src/ui/web/assets/page-leave-guard.js');
await boot();
afterAll(() => dom.restore());

test('global lazy pages announce destination immediately; late imports cannot reclaim projects', async () => {
  const first = dom.node('settings-open').onclick();
  expect(dom.node('detail').dataset.view).toBe('settings'); expect(dom.location.hash).toBe('#settings');
  const second = dom.node('projects-open').onclick(); await Promise.all([first, second]);
  expect(ui.view.id).toBe('projects'); expect(dom.location.hash).toBe('#projects');
  expect(dom.node('detail').querySelector('button.settings-tab')).toBeNull();
});

test('two pending global chunks settle only the newest navigation, including hash/back', async () => {
  const first = dom.node('settings-open').onclick(), second = dom.node('agent-status-open').onclick();
  await Promise.all([first, second]); expect(ui.view.id).toBe('agent-status'); expect(dom.location.hash).toBe('#agent-status');
  const third = dom.node('model-sources-open').onclick(); dom.location.hash = '#projects';
  await dom.fire('hashchange'); await third;
  expect(ui.view.id).toBe('projects'); expect(dom.node('resource-panels').hidden).toBe(true);
});

test('replacement project boot cancels an old global chunk and owns one live navigation', async () => {
  const pending = dom.node('settings-open').onclick();
  const project = installProjectDom({ fetch: world.fetchImpl });
  try {
    project.location.hash = '#workers'; await boot(); await pending;
    expect(ui.view.id).toBe('tasks'); expect(project.location.hash).toBe('#workers');
    await boot(); expect(ui.view.id).toBe('tasks'); expect(project.listeners.hashchange).toHaveLength(1);
    expect(typeof project.intervalFor(1500)).toBe('function'); expect(typeof project.intervalFor(3000)).toBe('function');
    expect(project.node('side-nav').querySelectorAll('.nav-item')).toHaveLength(3);
    project.location.hash = '#settings'; await project.fire('hashchange');
    expect(ui.view.id).toBe('workspace-link'); expect(project.node('detail').querySelector('button.settings-tab')).toBeNull();
    expect(project.node('detail').querySelector('a').href).toBe('/#settings');
  } finally { project.restore(); dom.location.hash = '#projects'; await boot(); }
});

test('same-route global hash does not strand a pending chunk', async () => {
  await dom.node('projects-open').onclick(); const pending = dom.node('settings-open').onclick();
  await dom.fire('hashchange'); await pending;
  expect(ui.view.id).toBe('settings'); expect(dom.node('detail').querySelector('button.settings-tab')).toBeTruthy();
});

test('only the latest asynchronous confirmation may announce/open a clicked global destination', async () => {
  await dom.node('projects-open').onclick(); const identity = ui.view, releases = [];
  const unregister = registerPageLeaveGuard(() => new Promise(resolve => releases.push(resolve)));
  try {
    const first = dom.node('settings-open').onclick(), second = dom.node('agent-status-open').onclick();
    expect(ui.view).toBe(identity); expect(dom.location.hash).toBe('#projects');
    releases[1](true); await second; expect(ui.view.id).toBe('agent-status');
    releases[0](true); await first; expect(ui.view.id).toBe('agent-status'); expect(dom.location.hash).toBe('#agent-status');
  } finally { unregister(); }
});

test('late hash confirmation rejection cannot restore projects over a newer accepted click', async () => {
  await dom.node('projects-open').onclick(); const releases = [];
  const unregister = registerPageLeaveGuard(() => new Promise(resolve => releases.push(resolve)));
  try {
    dom.location.hash = '#settings'; const back = dom.fire('hashchange');
    const click = dom.node('docs-open').onclick(); releases[1](true); await click;
    expect(ui.view.id).toBe('docs'); expect(dom.location.hash).toBe('#docs');
    releases[0](false); await back;
    expect(ui.view.id).toBe('docs'); expect(dom.location.hash).toBe('#docs');
  } finally { unregister(); }
});

test('hash/back invalidates an earlier pending click even when the latest guard immediately stays on projects', async () => {
  await dom.node('projects-open').onclick(); let release;
  const unregister = registerPageLeaveGuard(target => target === '#projects' ? false : new Promise(resolve => { release = resolve; }));
  try {
    const click = dom.node('model-sources-open').onclick(); dom.location.hash = '#projects';
    await dom.fire('hashchange'); release(true); await click;
    expect(ui.view.id).toBe('projects'); expect(dom.location.hash).toBe('#projects');
  } finally { unregister(); }
});

test('a pending confirmation cannot survive same-document boot or replacement project boot', async () => {
  await dom.node('projects-open').onclick(); let release;
  let unregister = registerPageLeaveGuard(() => new Promise(resolve => { release = resolve; }));
  try {
    const pending = dom.node('settings-open').onclick(); await boot(); release(true); await pending;
    expect(ui.view.id).toBe('projects'); expect(dom.location.hash).toBe('#projects');
  } finally { unregister(); }
  unregister = registerPageLeaveGuard(() => new Promise(resolve => { release = resolve; }));
  const pending = dom.node('settings-open').onclick(), project = installProjectDom({ fetch: world.fetchImpl });
  try {
    project.location.hash = '#workers'; await boot(); release(true); await pending;
    expect(ui.view.id).toBe('tasks'); expect(project.location.hash).toBe('#workers');
    expect(project.node('detail').querySelector('button.settings-tab')).toBeNull();
  } finally { unregister(); project.restore(); await boot(); }
});

test('root boot awaits settings deep link, supports a second DOM, and never starts project timers', async () => {
  dom.location.hash = '#settings'; await boot(); expect(dom.node('detail').querySelector('button.settings-tab')).toBeTruthy();
  const replacement = installDom({ fetch: world.fetchImpl });
  try {
    replacement.location.hash = '#settings'; await boot();
    expect(replacement.node('detail').querySelector('button.settings-tab')).toBeTruthy();
    expect(replacement.intervalFor(1500)).toBeUndefined(); expect(typeof replacement.intervalFor(3000)).toBe('function');
  } finally { replacement.restore(); await boot(); }
});
