import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildAssets } from '../../src/ui/web/build-assets.js';
import { installDom, deepText } from '../dom-stub.js';
import { installDom as installProjectDom } from './project-dom.js';
import { makeWorld } from './dom-world.js';
import { temp } from '../helpers.js';
import { diagnosticsQuery, emptyDiagnosticQuery, finishDiagnosticQuery } from '../../src/core/diagnostics-query.js';

const root = temp(), assets = fileURLToPath(new URL('../../src/ui/web/assets/', import.meta.url));
await buildAssets(assets, root, 'a'.repeat(32));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = html.match(/src="\/([^"\n]+-app-[^"\n]+\.js)"/)[1];
const world = makeWorld(), inboxReads = [], diagnosticReads = [], dom = installDom({ fetch: (url, options) => {
  if (String(url).startsWith('/api/host/diagnostics/query?')) {
    const params = new URL(url, 'http://fixture').searchParams; diagnosticReads.push({ params, signal: options.signal });
    return Response.json(finishDiagnosticQuery(emptyDiagnosticQuery(diagnosticsQuery(Object.fromEntries(params), Date.now(), true))));
  }
  if (String(url).startsWith('/api/host/inbox?')) inboxReads.push(new URL(url, 'http://fixture').searchParams);
  return world.fetchImpl(url, options);
} });
const { boot } = await import(pathToFileURL(path.join(root, app)).href);
afterAll(() => { dom.restore(); fs.rmSync(root, { recursive: true, force: true }); });

test('compiled root workbench loads global lazy pages with shared navigation state', async () => {
  expect(dom.node('detail').dataset.view).toBe('projects');
  for (const [view, hash] of [['settings', 'settings'], ['skills', 'skills'], ['agent-status', 'agent-status'], ['model-sources', 'model-sources'], ['automation', 'automation'], ['global-inbox', 'notices']]) {
    await dom.node(`${view}-open`).onclick();
    expect(dom.node('detail').dataset.view).toBe(view); expect(dom.location.hash).toBe(`#${hash}`);
    expect(dom.node(`${view}-open`).getAttribute('aria-current')).toBe('page');
  }
  const inbox = dom.node('detail'), search = inbox.querySelector('.search-field-input');
  const notice = inbox.querySelector('[data-category="notice"]'), decision = inbox.querySelector('[data-category="decision"]');
  expect(notice.getAttribute('aria-pressed')).toBe('true'); expect(decision.getAttribute('aria-pressed')).toBe('true');
  search.value = '未提交'; await notice.onclick();
  expect(JSON.parse(inboxReads.at(-1).get('categories'))).toEqual(['decision']); expect(inboxReads.at(-1).get('q')).toBe('');
  await inbox.querySelector('.search-field-submit').onclick(); expect(inboxReads.at(-1).get('q')).toBe('未提交');
  search.value = '下一条尚未提交'; const status = inbox.querySelector('.global-inbox-status').querySelector('select');
  status.value = 'answered'; await status.onchange();
  expect(inboxReads.at(-1).get('status')).toBe('answered'); expect(inboxReads.at(-1).get('q')).toBe('未提交');
  await inbox.querySelector('.search-field-clear').onclick();
  expect(inboxReads.at(-1).get('q')).toBe(''); expect(inboxReads.at(-1).get('status')).toBe('answered');
  await decision.onclick(); expect(JSON.parse(inboxReads.at(-1).get('categories'))).toEqual([]);
  expect(deepText(inbox)).toContain('未勾选收件箱分类');
  await notice.onclick(); await decision.onclick(); expect(JSON.parse(inboxReads.at(-1).get('categories'))).toEqual(['notice', 'decision']);
  dom.location.hash = '#notices-read'; await dom.fire('hashchange');
  expect(dom.node('detail').dataset.view).toBe('global-inbox'); expect(inboxReads.at(-1).get('status')).toBe('read');
  dom.location.hash = '#notices-project-aaaaaaaaaaaaaaaa-answered'; await dom.fire('hashchange');
  expect(inboxReads.at(-1).get('project_id')).toBe('aaaaaaaaaaaaaaaa'); expect(inboxReads.at(-1).get('status')).toBe('answered');
  dom.location.hash = '#administrator'; await dom.fire('hashchange');
  expect(dom.node('detail').dataset.view).toBe('administrator');
  expect(dom.node('detail').querySelector('.administrator-create')).toBeNull();
  expect(dom.node('detail').querySelector('.administrator-instruction')).toBeNull();
  dom.location.hash = '#model-sources-diagnostics?connection_id=deleted&model=historical%2Fmodel'; await dom.fire('hashchange');
  expect(dom.node('detail').dataset.view).toBe('model-sources');
  expect(dom.node('detail').querySelector('[data-model-sources-tab="diagnostics"]').getAttribute('aria-selected')).toBe('true');
  expect(diagnosticReads.at(-1).params.get('model')).toBe('historical/model');
  expect(deepText(dom.node('detail'))).toContain('额度观测变化');
  await dom.node('detail').querySelector('[data-model-sources-tab="models"]').onclick();
  expect(dom.location.hash).toBe('#model-sources');
  await dom.node('detail').querySelector('[data-model-sources-tab="diagnostics"]').onclick();
  expect(diagnosticReads.at(-1).params.get('connection_id')).toBe('deleted');
  await dom.node('projects-open').onclick(); expect(dom.node('detail').dataset.view).toBe('projects');
});

test('compiled project boot owns work pages and opens device settings separately', async () => {
  const projectDiagnostics = [];
  const project = installProjectDom({ fetch: async (url, options) => {
    if (String(url).includes('/api/diagnostics/query?')) {
      projectDiagnostics.push(String(url));
      const params = new URL(url, 'http://fixture').searchParams;
      return Response.json(finishDiagnosticQuery(emptyDiagnosticQuery(diagnosticsQuery(Object.fromEntries(params)))));
    }
    const response = await world.fetchImpl(url, options);
    if (/\/api\/worker\/1$/.test(String(url))) return Response.json({ ...await response.json(), task_kind: 'order', worker_number: 'W333' });
    return response;
  } });
  try {
    await boot(); expect(project.node('detail').dataset.view).toBe('overview');
    for (const view of ['task-graph', 'inputs', 'hooks']) {
      await project.node(`${view}-open`).onclick(); expect(project.node('detail').dataset.view).toBe(view);
    }
    for (const view of ['tasks', 'valets']) {
      await project.node('side-nav').querySelector(`[data-side="${view}"]`).onclick();
      expect(project.node('detail').dataset.view).toBe(view);
    }
    project.node('input').value = 'unsent'; project.node('detail').scrollTop = 120;
    await project.node('settings-open').onclick();
    expect(project.node('settings-open').href).toBe('/#settings'); expect(project.node('settings-open').target).toBe('_blank');
    expect(project.node('input').value).toBe('unsent'); expect(project.node('detail').scrollTop).toBe(120);
    await project.node('skills-open').onclick();
    expect(project.node('skills-open').href).toBe('/#skills'); expect(project.node('skills-open').target).toBe('_blank');
    expect(project.node('input').value).toBe('unsent'); expect(project.node('detail').scrollTop).toBe(120);
    project.location.hash = '#administrator'; await project.fire('hashchange');
    expect(project.node('detail').dataset.view).toBe('workspace-link');
    expect(project.node('detail').querySelector('a').href).toBe('/#administrator');
    project.location.hash = '#skills'; await project.fire('hashchange');
    expect(project.node('detail').dataset.view).toBe('workspace-link');
    expect(project.node('detail').querySelector('a').href).toBe('/#skills');
    for (const hash of ['#notices-read', '#model-sources-connections']) {
      project.location.hash = hash; await project.fire('hashchange');
      expect(project.node('detail').dataset.view).toBe('workspace-link');
      expect(project.node('detail').querySelector('a').href).toBe(`/${hash}`);
    }
    project.location.hash = '#model-sources-diagnostics?model=%40unknown'; await project.fire('hashchange');
    expect(project.node('detail').dataset.view).toBe('model-sources');
    expect(projectDiagnostics.at(-1)).toStartWith('/api/diagnostics/query?');
    expect(project.requests.filter(row => row.path.includes('/diagnostics/query?')).at(-1).path).toStartWith('/p/aaaaaaaaaaaaaaaa/api/diagnostics/query?');
    expect(project.node('detail').querySelector('[data-diagnostic-filter="project_id"]')).toBeNull();
    expect(deepText(project.node('detail'))).toContain('额度观测变化');
    project.location.hash = '#worker-1-cli'; await project.fire('hashchange');
    expect(project.node('detail').dataset.view).toBe('execution');
    const panel = project.document.body.querySelector('.transcript-dialog');
    expect(panel.querySelectorAll('[role="tab"]')).toHaveLength(4);
    expect(panel.querySelector('.worker-cli')).not.toBeNull();
    expect(panel.querySelector('.transcript-back')).toBeNull();
    project.location.hash = '#worker-1-execution-cli'; await project.fire('hashchange');
    expect(project.document.body.querySelector('.transcript-dialog').querySelector('.worker-cli')).not.toBeNull();
  } finally { project.restore(); await boot(); }
});
