import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { initNoticeRecords, loadNoticeRecords, openNotice, renderNotices, noticePanel } from '../../src/ui/web/assets/render-notices.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { setup, fetch as httpFetch } from './harness.js';

const base = { task_id: 1, created_at: '2026-01-01T00:00:00Z', kind: 'question', body: '原始问题正文' };

test('records HTTP endpoint validates filters and exposes stored history beyond snapshot limit', async () => {
  const f = await setup();
  try {
    const task = f.store.create({ input_id: null, role: 'worker', goal: 'notice route' });
    for (let i = 0; i < 205; i++) f.store.run("INSERT INTO notices(task_id,title,body,status,answer) VALUES (?,?,?,'answered',?)", task.id, `record ${i}`, 'body', 'decision');
    const first = await (await httpFetch(f.url + '/api/notices?status=answered&limit=100')).json();
    expect(first.notices).toHaveLength(100); expect(first.has_more).toBe(true);
    const second = await (await httpFetch(f.url + `/api/notices?status=answered&limit=100&before=${first.cursor}`)).json();
    const last = await (await httpFetch(f.url + `/api/notices?status=answered&limit=100&before=${second.cursor}`)).json();
    expect(last.notices).toHaveLength(5); expect(last.has_more).toBe(false);
    expect(last.notices.at(-1).answer).toBe('decision');
    expect((await httpFetch(f.url + '/api/notices?status=unknown')).status).toBe(400);
    expect((await httpFetch(f.url + '/api/notices?before=nope')).status).toBe(400);
  } finally { await f.close(); }
});

test('decision panel loads history, preserves edits across polls, answers inline and renders history read-only', async () => {
  let rows = [
    { ...base, id: 5, title: '待决问题', status: 'open' },
    { ...base, id: 4, title: '旧答案', status: 'answered', answer: '保留设计 A' },
    { ...base, id: 3, title: '被忽略', status: 'dismissed', answer: '' },
    { ...base, id: 2, title: '计划审批', status: 'open', kind: 'plan' },
    { ...base, id: 1, title: '完成提醒', status: 'sent', kind: 'info' },
  ];
  const calls = [];
  const dom = installDom({ fetch: async (url, options = {}) => {
    const json = value => ({ ok: true, status: 200, json: async () => structuredClone(value) });
    if (url.startsWith('/api/notices?')) {
      const params = new URL(url, 'http://localhost').searchParams;
      const status = params.get('status') || 'all';
      const before = Number(params.get('before') || Infinity);
      const matching = rows.filter(row => row.id < before && (status === 'all' || row.status === status));
      const notices = matching.slice(0, 2);
      return json({ notices, cursor: notices.at(-1)?.id, has_more: matching.length > notices.length });
    }
    if (url === '/api/task/1') return json({ id: 1, notices: rows });
    if (url === '/api/action') {
      const { method, params } = JSON.parse(options.body); calls.push({ method, params });
      const target = rows.find(row => row.id === params.id);
      target.status = method.endsWith('dismiss') ? 'dismissed' : 'answered'; target.answer = params.answer || '已批准';
      return json(target);
    }
    throw new Error(`unexpected ${url}`);
  } });
  resetUiState(); initNoticeRecords(); ui.indexOpen = 'notices';
  const snapshot = () => ({ notices: structuredClone(rows) });
  const restoreNav = registerNavigation({ refresh: async () => renderNotices(snapshot()), detail: async () => { throw new Error('should stay in panel'); } });
  try {
    renderNotices(snapshot()); await loadNoticeRecords();
    await openNotice(5);
    const focus = dom.node('notice-record-detail');
    const textarea = focus.querySelector('textarea'); textarea.value = '用户的选择';
    renderNotices(snapshot()); await loadNoticeRecords({ preserve: true });
    expect(focus.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe('用户的选择');
    await findByText(focus, '回复并继续任务').onclick();
    expect(calls.at(-1)).toEqual({ method: 'notice.answer', params: { id: 5, answer: '用户的选择' } });
    expect(ui.indexOpen).toBe('notices');
    expect(deepText(focus)).toContain('用户的选择'); expect(focus.querySelector('textarea')).toBeNull();
    await findByText(dom.node('side-notices-body'), '全部记录').onclick();
    await findByText(dom.node('notice-pagination'), '加载更早记录').onclick();
    expect(deepText(dom.node('notices'))).toContain('被忽略');
    await openNotice(4); expect(deepText(focus)).toContain('保留设计 A');
    await openNotice(3); expect(deepText(focus)).toContain('不代表批准'); expect(focus.querySelector('textarea')).toBeNull();
    await openNotice(2); await findByText(focus, '批准并开发').onclick();
    expect(calls.at(-1).method).toBe('plan.approve');
    expect(calls.at(-1).params.id).toBe(2);
    // A remotely settled record immediately loses its write controls.
    rows[0].status = 'open'; await openNotice(5);
    rows[0].status = 'dismissed'; renderNotices(snapshot());
    await loadNoticeRecords({ preserve: true });
    expect(focus.querySelector('textarea')).toBeNull();
  } finally { ui.noticeRecords = null; restoreNav(); dom.restore(); }
});

test('closed questionnaires retain original options and normalized answers, without decision controls', () => {
  const dom = installDom();
  try {
    const panel = noticePanel({ ...base, id: 1, status: 'answered', kind: 'questionnaire', title: '选择设计',
      body: JSON.stringify({ version: 1, questions: [{ header: '布局', question: '采用哪种布局？', options: [{ label: '方案 A', description: '简单' }, { label: '方案 B', description: '灵活' }] }] }),
      answer: JSON.stringify({ answers: [{ question: '采用哪种布局？', labels: ['方案 A'], custom: '' }] }),
    });
    expect(deepText(panel)).toContain('方案 A'); expect(deepText(panel)).toContain('方案 B');
    expect(panel.querySelector('textarea')).toBeNull(); expect(panel.querySelector('button')).toBeNull();
  } finally { dom.restore(); }
});
