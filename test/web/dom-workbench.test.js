import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';

const calls = [];
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url); calls.push({ path, method: options.method || 'GET' });
  if (path === '/api/host') return Response.json({ mode: 'host', projects: [], last_project_id: null, capabilities: { project_control: true } });
  if (path === '/api/host/projects') return Response.json({ projects: [] });
  if (path === '/api/docs') return Response.json({ docs: [] });
  return Response.json({ error: 'project API must not be called without a project' }, { status: 500 });
} });
afterAll(() => dom.restore());

const picker = await import('../../src/ui/web/assets/project-picker.js');
const { openSettings } = await import('../../src/ui/web/assets/render-settings.js');
const { openDocs } = await import('../../src/ui/web/assets/docs.js');

const { resetUiState } = await import('../../src/ui/web/assets/state.js');
resetUiState();
await picker.ensureProject();
await picker.openProjectManager({ push: false });

test('空根路径使用主内容项目管理，发布 shell 没有阻塞 gate', async () => {
  const html = await Bun.file(new URL('../../src/ui/web/assets/index.html', import.meta.url)).text();
  expect(html).toContain('id="projects-open"');
  expect(html).not.toContain('environments-open');
  expect(html).not.toContain('SSH');
  expect(html).toContain('id="settings-open"');
  expect(html).toContain('id="docs-open"');
  expect(html).not.toContain('id="project-gate"');
  expect(dom.node('detail').dataset.view).toBe('projects');
  expect(deepText(dom.node('detail'))).toContain('还没有项目入口');
  expect(dom.node('project-app').getAttribute('inert')).toBeNull();
  expect(calls.every(call => call.method === 'GET')).toBe(true);
});

test('空态设置、文档与项目管理可用，项目系统动作保持关闭', async () => {
  openSettings();
  expect(dom.node('detail').dataset.view).toBe('settings');
  expect(deepText(dom.node('detail'))).toContain('Markdown 渲染');
  const systemTab = dom.node('detail').querySelector('button.settings-tab[data-settings-tab="system"]');
  await systemTab.onclick();
  expect(deepText(dom.node('detail'))).toContain('当前没有可用项目');
  expect(dom.node('detail').querySelector('[data-service-restart="project"]')).toBeNull();

  await openDocs();
  expect(dom.node('detail').dataset.view).toBe('docs');
  await picker.openProjectManager({ push: false });
  expect(dom.node('detail').dataset.view).toBe('projects');
  expect(deepText(dom.node('detail'))).toContain('项目管理');
  expect(calls.every(call => call.method === 'GET')).toBe(true);
});
