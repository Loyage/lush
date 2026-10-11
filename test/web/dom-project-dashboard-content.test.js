import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb';
const requests = []; let intercept = null;
const question = { id: 7, task_id: 92, task_worker_number: 'W204-3', kind: 'questionnaire', status: 'open', title: '<img src=x>待决' };
const info = { id: 7, task_id: 20, task_worker_number: 'W98', kind: 'info', status: 'sent', source_event_id: 8, read_at: null, title: '已交付' };
const dom = installDom({ fetch: async (url, options = {}) => {
  requests.push({ url: String(url), options });
  const value = intercept?.(String(url)); if (value) return value;
  const id = String(url).includes(`/p/${A}/`) ? A : B;
  return Response.json({ notices: String(url).includes('status=open') ? (id === A ? [question] : []) : (id === B ? [info] : []), has_more: false });
} });
afterAll(() => dom.restore());
const { loadProjectCardMessages, projectDashboardContent } = await import('../../src/ui/web/assets/project-dashboard-content.js');
const development = { workers_total: 12, active: 2, awaiting_acceptance: 3, agents_running: 1, parent_confirmation: 4,
  pending_merges: 1, merging: 0, merge_conflicts: 0, counts: [{ status: 'running', count: 2 }], recent_workers: [] };
const row = id => ({ id, name: id === A ? 'A' : 'B', running: true, summary: { notices: 1, development } });

test('项目消息按来源读取各最多3条，Notice ID相同仍按项目隔离，导航不答复或已读', async () => {
  requests.length = 0;
  const messages = await loadProjectCardMessages([row(A), row(B)]);
  expect(requests.map(entry => entry.url).sort()).toEqual([A, B].flatMap(id => ['open', 'unread'].map(status => `/p/${id}/api/notices?status=${status}&limit=3`)).sort());
  const a = projectDashboardContent(row(A), { messages: messages.get(A) });
  const b = projectDashboardContent(row(B), { messages: messages.get(B) });
  const pending = a.querySelector('.project-dashboard-message'), sent = b.querySelector('.project-dashboard-message');
  expect(pending.href).toBe(`/p/${A}/#notices-7`); expect(sent.href).toBe(`/p/${B}/#notices-7`);
  expect(deepText(pending)).toContain('D7'); expect(deepText(pending)).toContain('W204-3');
  expect(deepText(sent)).toContain('N7'); expect(deepText(sent)).toContain('W98');
  expect(pending.classList.contains('tone-amber')).toBe(true); expect(sent.classList.contains('tone-blue')).toBe(true);
  expect(pending.target).toBe('_blank'); expect(sent.rel).toBe('noopener');
  expect(pending.querySelector('img')).toBeNull(); expect(pending.querySelector('button')).toBeNull();
  expect(requests.every(request => !request.options.method || request.options.method === 'GET')).toBe(true);
});

test('内容开关独立且空数组隐藏所有模块；指标保留项目概览语义颜色与快捷来源链接', () => {
  const full = projectDashboardContent(row(A), { messages: { notices: [], complete: true } });
  expect(full.querySelectorAll('.project-development-metric').map(node => node.className)).toEqual([
    'project-development-metric tone-blue', 'project-development-metric tone-violet',
    'project-development-metric tone-violet', 'project-development-metric tone-green']);
  expect(full.querySelector('.project-dashboard-shortcuts').querySelectorAll('a').map(link => link.href)).toEqual([
    `/p/${A}/#workers`, `/p/${A}/#inputs`, `/p/${A}/#versions`]);
  expect(projectDashboardContent(row(A), { sections: [] }).children).toHaveLength(0);
  const recentOnly = projectDashboardContent(row(A), { sections: ['recent'] });
  expect(recentOnly.querySelector('.project-development-metrics')).toBeNull();
  expect(recentOnly.querySelector('.project-development-recent')).not.toBeNull();
  expect(recentOnly.querySelector('.project-dashboard-messages')).toBeNull();
});

test('离线不访问来源API、不显示旧摘要为当前状态，分页或部分失败不冒称没有消息', async () => {
  requests.length = 0;
  const offline = { ...row(A), running: false };
  const messages = await loadProjectCardMessages([offline]); expect(requests).toHaveLength(0);
  const card = projectDashboardContent(offline, { messages: messages.get(A) });
  expect(deepText(card)).toContain('当前开发状态未确认'); expect(deepText(card)).toContain('消息未确认');
  expect(card.querySelector('.project-development-metrics')).toBeNull();
  intercept = url => url.includes('status=unread') ? Response.json({ error: 'offline' }, { status: 503 })
    : Response.json({ notices: [question], has_more: true });
  try {
    const model = (await loadProjectCardMessages([row(A)])).get(A);
    expect(model.error).toBe(true); expect(model.complete).toBe(false);
    const failed = projectDashboardContent(row(A), { messages: model });
    expect(deepText(failed)).toContain('部分消息读取失败'); expect(deepText(failed)).not.toContain('暂无待决');
    expect(failed.querySelectorAll('.project-dashboard-message')).toHaveLength(1);
  } finally { intercept = null; }
});

test('消息加载按三项目并发有界；离页不开始剩余请求或回填迟到响应', async () => {
  let current = true, release;
  const delayed = new Promise(resolve => { release = resolve; });
  requests.length = 0; intercept = () => delayed;
  const rows = Array.from({ length: 5 }, (_, i) => row((i + 1).toString(16).padStart(16, '0')));
  try {
    const pending = loadProjectCardMessages(rows, { ownsPage: () => current });
    await Bun.sleep(0); expect(requests).toHaveLength(6);
    current = false; release(Response.json({ notices: [], has_more: false }));
    expect((await pending).size).toBe(0); expect(requests).toHaveLength(6);
  } finally { intercept = null; }
});
