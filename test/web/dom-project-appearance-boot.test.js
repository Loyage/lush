import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld(), ids = ['abcdef0123456789', '0123456789abcdef'];
const projects = ids.map((id, index) => ({ id, name: `project-${index}`, project: `/fixture/project-${index}` }));
let offline = true, failAppearance = false, bound = false;
const calls = [];
const dom = installDom({ fetch: async (url, options) => {
  const path = String(url); calls.push({ path, options });
  if (path === '/api/host') return Response.json({ mode: bound ? 'bound' : 'host', projects, project: bound ? projects[0].project : null });
  if (path === '/api/host/projects') return Response.json({ projects });
  const match = /^\/api\/host\/projects\/([a-f0-9]{16})\/appearance$/.exec(path);
  if (match) return failAppearance ? Response.json({ error: 'configuration unavailable' }, { status: 500 }) : Response.json({ id: match[1],
    appearance: { version: 1, theme: 'dark', color: match[1] === ids[0] ? 'blue' : 'rose', revision: 'initial' } });
  const inner = path.replace(/^\/p\/[a-f0-9]{16}/, '');
  if (offline && ['/api/overview', '/api/snapshot'].includes(inner.split('?')[0])) return Response.json({ error: 'daemon offline' }, { status: 500 });
  return world.fetchImpl(inner, options);
} });
dom.location.pathname = `/p/${ids[0]}/`;
const { boot } = await import('../../src/ui/web/assets/app.js');
const { initAppearance } = await import('../../src/ui/web/assets/appearance.js');
afterAll(() => { initAppearance(); dom.restore(); });

test('startup applies Host project title and persisted color without waiting for an online daemon', () => {
  expect(dom.document.title).toBe('project-0 · Lush');
  expect(dom.node('project').textContent).toBe('project-0');
  expect(dom.document.documentElement.dataset.projectColor).toBe('blue');
  expect(calls.some(row => row.path === `/api/host/projects/${ids[0]}/appearance`)).toBe(true);
  expect(calls.filter(row => row.options?.method === 'POST')).toHaveLength(0);
});

test('switching project boot changes title/color; workbench clears them and does not call project appearance', async () => {
  dom.location.pathname = `/p/${ids[1]}/`; await boot();
  expect(dom.document.title).toBe('project-1 · Lush');
  expect(dom.document.documentElement.dataset.projectColor).toBe('rose');
  const before = calls.length;
  dom.location.pathname = '/'; await boot();
  expect(dom.document.title).toBe('Lush');
  expect(dom.document.documentElement.dataset.projectColor).toBeUndefined();
  expect(calls.slice(before).some(row => /\/appearance$/.test(row.path))).toBe(false);
});

test('single-project root resolves Host stable identity and never falls back to browser settings on read failure', async () => {
  bound = true; failAppearance = true; await boot();
  expect(dom.document.title).toBe('project-0 · Lush');
  expect(dom.node('theme-toggle').disabled).toBe(true);
  expect(dom.document.documentElement.dataset.projectColor).toBeUndefined();
  await dom.node('settings-open').onclick();
  await dom.node('detail').querySelector('button.settings-tab[data-settings-tab="interface"]').onclick();
  expect(dom.node('detail').querySelector('input.pref-radio[data-value="dark"]').disabled).toBe(true);
  expect(dom.node('detail').querySelector('.settings-error').textContent).toContain('configuration unavailable');
});
