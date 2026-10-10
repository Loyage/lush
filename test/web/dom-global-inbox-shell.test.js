import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { makeWorld } from './dom-world.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { startGlobalNoticeObserver } from '../../src/ui/web/assets/global-notice-notifications.js';
import { inboxMatches } from '../../src/ui/web/assets/global-inbox-model.js';
import { setPref } from '../../src/ui/web/assets/prefs.js';

const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb';
const json = value => ({ ok: true, status: 200, json: async () => structuredClone(value) });
const source = id => ({ id, name: `项目 ${id[0]}`, online: true, complete: true, checked_at: '2026-10-09T10:00:00Z', error: null });
const row = (id, extra = {}) => ({ project_id: B, project_name: '项目 b', project: '/tmp/source-b', online: true,
  checked_at: '2026-10-09T10:00:00Z', notice: { id, task_id: 21, task_worker_number: 'W162-3', kind: 'question', status: 'open',
    title: '来源 B 的事项', body: '请查看 W162-3 后作出决定。', created_at: '2026-10-09T09:00:00Z', ...extra } });
let app, dom, world, requests, rows, delayPreferences;
beforeEach(() => {
  world = makeWorld(); requests = []; delayPreferences = null;
  rows = [row(9, { status: 'answered', answer_source: 'lush', answer: '请由 Agent 自行判断并继续。' }),
    row(8, { kind: 'info', status: 'sent', source_event_id: 28, lifecycle_type: 'failed', read_at: null }), row(7)];
  dom = installDom({ fetch: async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const target = new URL(String(url), 'http://fixture.test');
    if (target.pathname === '/api/host/preferences' && delayPreferences) return delayPreferences;
    if (target.pathname === '/api/host/inbox') return json({ version: 1, cursor: null, has_more: false, complete: true,
      projects: [source(A), source(B)], items: rows.filter(item => inboxMatches(item, target.searchParams.get('status') || 'all')) });
    if (target.pathname === '/api/host/inbox/notice') {
      expect(target.searchParams.get('project_id')).toBe(B);
      return json(rows.find(item => item.notice.id === Number(target.searchParams.get('id'))));
    }
    return world.fetchImpl(url, options);
  } });
});
afterEach(() => {
  // The shell owns a private disposer. Replace/dispose the singleton so no notifier timer outlives this DOM.
  const dispose = startGlobalNoticeObserver({ read: async () => ({ version: 1, items: [], projects: [], cursor: null, has_more: false, complete: true }),
    setTimeout: () => 0, clearTimeout: () => {} }); dispose();
  dom.restore();
});
async function boot() { if (!app) app = await import('../../src/ui/web/assets/app.js'); else await app.boot(); }

test('real shell and inbox agree on root defaults and every filter survives hash dispatch without extra history', async () => {
  dom.location.hash = '#notices'; await boot();
  expect(ui.view.id).toBe('global-inbox'); expect(ui.globalInboxPage.status).toBe('all'); expect(dom.location.hash).toBe('#notices');
  expect(dom.node('detail').querySelectorAll('.global-inbox-row')).toHaveLength(3);
  activateDetailView({ view: 'docs', hash: '#docs' }); const before = dom.pushed();
  await dom.node('global-inbox-open').onclick({ preventDefault() {} });
  expect(dom.pushed()).toBe(before + 1); expect(ui.globalInboxPage.status).toBe('all');
  const labels = { open: '需要我决定', unread: '未读告知', failed: '异常与受阻', automatic: '自动选择', all: '全部记录' };
  for (const [status, label] of Object.entries(labels)) {
    await dom.node('detail').querySelectorAll('button').find(node => node.textContent === label).onclick();
    const hash = status === 'all' ? '#notices' : `#notices-${status}`, length = dom.pushed();
    expect(dom.location.hash).toBe(hash); await dom.fire('hashchange');
    expect(dom.location.hash).toBe(hash); expect(ui.globalInboxPage.status).toBe(status); expect(dom.pushed()).toBe(length);
    expect(ui.globalInboxPage.current()).toBe(true);
  }
  expect(requests.filter(request => request.url !== '/api/host' && !request.url.startsWith('/api/host/')).map(request => request.url)).toEqual([]);
  expect(requests.some(request => request.options.method === 'POST')).toBe(false);
});

test('source notice deep link runs through the real root shell, keeps source Worker tabs and full global counts', async () => {
  dom.location.hash = `#inbox-notice-${B}-7`; await boot();
  await until(() => dom.node('global-inbox-count').textContent === '2');
  expect(ui.globalInboxPage.selected.project_id).toBe(B); expect(ui.globalInboxPage.selected.notice.id).toBe(7);
  expect(dom.location.hash).toBe(`#inbox-notice-${B}-7`);
  const worker = dom.node('detail').querySelector('.global-inbox-worker');
  expect(worker.getAttribute('href')).toBe(`/p/${B}/#worker-21`); expect(worker.getAttribute('target')).toBe('_blank');
  expect(dom.node('detail').querySelector('textarea')).not.toBeNull();
  expect(deepText(dom.node('global-inbox-summary'))).toBe('');
  expect(dom.node('global-inbox-count').getAttribute('aria-label')).toContain('1 项待答问题，1 条未读告知');
  expect(requests.some(request => request.url.startsWith('/p/'))).toBe(false);
});

test('backend overview source filter survives global shell routing and status changes, with an explicit all-projects exit', async () => {
  dom.location.hash = `#notices-project-${B}`; await boot();
  expect(ui.globalInboxPage.projectId).toBe(B); expect(dom.location.hash).toBe(`#notices-project-${B}`);
  expect(deepText(dom.node('detail'))).toContain('当前来源：项目 b');
  await dom.node('detail').querySelectorAll('button').find(node => node.textContent === '需要我决定').onclick();
  expect(dom.location.hash).toBe(`#notices-project-${B}-open`); await dom.fire('hashchange');
  expect(ui.globalInboxPage.projectId).toBe(B); expect(ui.globalInboxPage.status).toBe('open');
  await dom.node('detail').querySelectorAll('button').find(node => node.textContent === '查看所有项目').onclick();
  expect(dom.location.hash).toBe('#notices-open'); expect(ui.globalInboxPage.projectId).toBeNull();
  expect(requests.some(request => request.options.method === 'POST')).toBe(false);
});

test('shell waits for authoritative preferences before starting open/unread observer, never seeds them from cache', async () => {
  let release; delayPreferences = new Promise(resolve => { release = resolve; });
  setPref('noticeNotifications', true); dom.location.hash = '#notices'; await boot();
  expect(requests.some(request => /status=(open|unread)/.test(request.url))).toBe(false);
  expect(dom.node('global-inbox-count').textContent).toBe('…');
  release(json(world.state.devicePreferences)); await until(() => dom.node('global-inbox-count').textContent === '2');
  expect(requests.some(request => request.url.includes('status=open&limit=30'))).toBe(true);
  expect(requests.some(request => request.url.includes('status=unread&limit=30'))).toBe(true);
  expect(requests.filter(request => request.url === '/api/host/preferences').every(request => request.options.method !== 'POST')).toBe(true);
  expect(world.state.devicePreferences.values.noticeNotifications).toBe(false);
});
