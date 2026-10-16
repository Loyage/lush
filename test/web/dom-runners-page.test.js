import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { installDom as installProjectDom } from './project-dom.js';
import { makeWorld } from './dom-world.js';
import { until } from '../helpers.js';
import { openRunners } from '../../src/ui/web/assets/render-runners.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { GLOBAL_LINKS } from '../../src/ui/web/assets/dashboard-widget-model.js';
import { normalizeDashboardPatch } from '../../src/core/dashboard-settings.js';
import { runnersHash, runnersTarget } from '../../src/ui/web/assets/runner-page-route.js';
const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb', OFFLINE = 'cccccccccccccccc';
const NODE = '11111111-1111-4111-8111-111111111111';
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
function fixture() {
  const world = makeWorld(), calls = [];
  let intercept = () => null;
  const projects = [{ id: A, name: '来源 Alpha', running: true }, { id: B, name: '来源 Beta', running: true }, { id: OFFLINE, name: '离线来源', running: false }];
  const policy = id => ({ version: 1, revision: 0, project_id: `paired-${id}`, allowed_node_ids: [NODE], default_node_id: 'local' });
  const nodes = { revision: 'absent', nodes: [{ id: NODE, name: '节点一', enabled: true, ssh_alias: 'lab', expected_runner_id: null, budgets: {} }] };
  const response = value => Response.json(value);
  const fetch = (url, options = {}) => {
    const path = String(url), body = options.body ? JSON.parse(options.body) : null; calls.push({ path, body });
    const custom = intercept(path, body); if (custom) return custom;
    if (path === '/api/host/projects') return response({ projects });
    const pathname = new URL(path, 'http://fixture').pathname;
    if (pathname.endsWith('/runner/nodes')) return response(nodes);
    if (pathname.endsWith('/runner/credentials')) return response({ revision: 'absent', nodes: [] });
    const source = /^\/p\/([a-f0-9]{16})\/api\/runner\/project$/.exec(path)?.[1];
    if (source) return response(policy(source));
    return world.fetchImpl(path, options);
  };
  const dom = installDom({ fetch });
  return { dom, calls, projects, fetch, response, policy, intercept(fn) { intercept = fn; } };
}

test('global deep links and sidebar open one inert page; old project shell bookmarks lead to root, never an embedded editor', async () => {
  const f = fixture(); let project;
  try {
    const { boot } = await import('../../src/ui/web/assets/app.js');
    f.dom.location.hash = '#runners'; await boot();
    expect(ui.view.id).toBe('runners'); expect(f.dom.node('runners-open').getAttribute('aria-current')).toBe('page');
    expect(f.dom.node('detail').querySelectorAll('.runner-settings')).toHaveLength(1);
    expect(f.dom.node('detail').querySelector('.module-body').hidden).toBe(true);
    expect(f.calls.some(row => row.path.includes('/runner/project'))).toBe(false);
    const rosterReads = f.calls.filter(row => row.path === '/api/host/projects').length;
    const device = f.dom.node('detail').querySelector('.runner-settings'); await f.dom.fire('hashchange');
    expect(f.calls.filter(row => row.path === '/api/host/projects')).toHaveLength(rosterReads);
    expect(f.dom.node('detail').querySelector('.runner-settings')).toBe(device);
    await f.dom.node('projects-open').onclick(); await f.dom.node('runners-open').onclick();
    expect(ui.view.id).toBe('runners'); expect(f.dom.location.hash).toBe('#runners');
    f.dom.location.hash = '#settings-runners'; await f.dom.fire('hashchange'); expect(f.dom.location.hash).toBe('#runners');
    project = installProjectDom({ fetch: f.fetch }); project.location.hash = runnersHash(A); await boot();
    expect(ui.view.id).toBe('workspace-link'); expect(project.node('detail').querySelector('a').href).toBe(`/${runnersHash(A)}`);
    expect(project.node('detail').querySelector('a').target).toBe('_blank');
    expect(project.node('detail').querySelector('.runner-settings')).toBeNull();
    expect(f.calls.some(row => row.body?.method?.startsWith('runner.'))).toBe(false);
    expect(f.calls.some(row => /\/projects\/start|\/host\/select/.test(row.path))).toBe(false);
  } finally { project?.restore(); f.dom.restore(); }
});

test('source bookmark and selection use registered project name/ID, preserve form on roster refresh and block offline/removed sources', async () => {
  const f = fixture();
  try {
    const { boot } = await import('../../src/ui/web/assets/app.js');
    f.dom.location.hash = runnersHash(A); await boot();
    const detail = f.dom.node('detail'), select = detail.querySelector('[aria-label="来源项目"]');
    expect(deepText(detail)).toContain(`来源项目：来源 Alpha · Host ID：${A}`);
    expect(detail.querySelector('.module-body').hidden).toBe(false);
    const editor = detail.querySelector('.runner-project-settings'); editor.querySelector('select').value = NODE;
    await button(detail, '刷新项目状态').onclick();
    expect(detail.querySelector('.runner-project-settings')).toBe(editor); expect(editor.querySelector('select').value).toBe(NODE);
    await f.dom.fire('hashchange'); expect(detail.querySelector('.runner-project-settings')).toBe(editor);
    select.value = B; await select.onchange();
    expect(f.dom.location.hash).toBe(runnersHash(B)); expect(deepText(detail)).toContain(`来源项目：来源 Beta · Host ID：${B}`);
    expect(deepText(detail)).not.toContain(`paired-${A}`);
    expect(f.calls.filter(row => row.path.includes('/runner/project')).map(row => row.path)).toEqual([`/p/${A}/api/runner/project`, `/p/${B}/api/runner/project`]);
    select.value = OFFLINE; await select.onchange();
    expect(detail.querySelector('.runner-project-settings')).toBeNull(); expect(deepText(detail)).toContain('不能编辑授权');
    const warning = detail.querySelectorAll('.runner-feedback').find(node => node.classList.contains('error'));
    expect(warning.parentNode.className).toBe('runners-page');
    expect(f.calls.some(row => row.path.startsWith(`/p/${OFFLINE}/`))).toBe(false);
    select.value = A; await select.onchange(); f.projects.splice(0, 1); await button(detail, '刷新项目状态').onclick();
    expect(detail.querySelector('.runner-project-settings')).toBeNull(); expect(deepText(detail)).toContain('未登记');
  } finally { f.dom.restore(); }
});

test('late project replies cannot resurrect old selection; roster failure invalidates editing, explicit refresh recovers without replacing device form', async () => {
  const f = fixture(), slow = deferred();
  try {
    await openRunners(); const detail = f.dom.node('detail'), device = detail.querySelector('.runner-settings');
    expect(f.calls.some(row => row.path === '/api/host/projects')).toBe(false);
    // Expand via the real ordinary-module toggle, which lazily reads the roster.
    await detail.querySelector('.module-toggle').onclick(); await until(() => detail.querySelector('option[value=""]') || f.calls.some(row => row.path === '/api/host/projects'));
    f.intercept(path => path === `/p/${A}/api/runner/project` ? slow.promise : null);
    const selectingA = openRunners({ projectId: A }); await until(() => f.calls.some(row => row.path === `/p/${A}/api/runner/project`));
    await openRunners({ projectId: B });
    slow.resolve(f.response(f.policy(A))); await selectingA;
    expect(deepText(detail)).toContain(`paired-${B}`); expect(deepText(detail)).not.toContain(`paired-${A}`);
    f.intercept(path => path === '/api/host/projects' ? Promise.reject(new Error('sensitive transport')) : null);
    await button(detail, '刷新项目状态').onclick();
    expect(detail.querySelector('.runner-project-settings')).toBeNull(); expect(deepText(detail)).toContain('项目列表读取失败'); expect(deepText(detail)).not.toContain('sensitive transport');
    expect(detail.querySelector('.runner-settings')).toBe(device);
    f.intercept(() => null); await button(detail, '刷新项目状态').onclick(); expect(deepText(detail)).toContain(`paired-${B}`);
    const credentials = button(detail, '配置凭据').onclick(); const secret = f.dom.node('modal').querySelector('[data-runner-field="machine_token"]'); secret.value = 'never-retain';
    activateDetailView({ view: 'settings' }); await credentials;
    expect(secret.value).toBe(''); expect(ui.runnersPage).toBeNull();
  } finally { f.dom.restore(); }
});

test('leaving while roster is pending prevents project reads or replacement-page publication; offline and project errors stay explicit', async () => {
  const f = fixture(), slow = deferred();
  try {
    f.intercept(path => path === '/api/host/projects' ? slow.promise : null);
    const pending = openRunners({ projectId: A });
    activateDetailView({ view: 'projects' }); f.dom.node('detail').textContent = 'replacement';
    slow.resolve(f.response({ projects: f.projects })); await pending;
    expect(f.dom.node('detail').textContent).toBe('replacement'); expect(f.calls.some(row => row.path.includes('/runner/project'))).toBe(false);
    f.intercept(path => path === `/p/${A}/api/runner/project` ? Response.json({ error: 'offline' }, { status: 503 }) : null);
    await openRunners({ projectId: A });
    expect(deepText(f.dom.node('detail'))).toContain('项目授权读取失败');
    const issues = f.dom.node('detail').querySelector('.runners-project-issues');
    expect(issues.hidden).toBe(false); expect(issues.textContent).toContain('项目授权读取失败');
    await f.dom.node('detail').querySelector('.module-toggle').onclick();
    expect(issues.parentNode.className).toBe('runners-page'); expect(issues.hidden).toBe(false);
    expect(button(f.dom.node('detail'), '保存项目授权').disabled).toBe(true);
    expect(f.calls.some(row => /\/projects\/start|\/host\/select/.test(row.path))).toBe(false);
  } finally { f.dom.restore(); }
});

test('dashboard shortcut and route contracts accept the global Runner destination, reject malformed source identities', () => {
  expect(GLOBAL_LINKS).toContainEqual(['runners', '执行节点']);
  const item = { id: 'widget:nodes', type: 'shortcuts', project_id: null, connection_ids: [], links: [{ scope: 'global', target: 'runners', project_id: null }], sections: ['shortcuts'] };
  expect(normalizeDashboardPatch({ widgets: [item] }).widgets[0].links).toEqual(item.links);
  expect(runnersTarget('#settings-runners')).toEqual({ projectId: '' });
  expect(runnersTarget('#runners-project-../bad')).toBeNull(); expect(() => runnersHash('../bad')).toThrow();
});
