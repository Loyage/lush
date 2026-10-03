import { test, expect } from 'bun:test';
import { installDom, deepText, findByText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { initNoticeRecords, loadNoticeRecords, openNotice, renderNotices, noticePanel } from '../../src/ui/web/assets/render-notices.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { setup, fetch as httpFetch } from './harness.js';

const base = { task_id: 1, created_at: '2026-01-01T00:00:00Z', kind: 'question', body: '原始问题正文' };

test('records HTTP endpoint forwards filters and continuation cursors across stored history', async () => {
  const f = await setup();
  try {
    const task = f.store.create({ input_id: null, role: 'worker', goal: 'notice route' });
    // The >200-record boundary belongs to project/notice-page; HTTP needs only three pages.
    f.store.transaction(() => {
      for (let i = 0; i < 7; i++) f.store.run("INSERT INTO notices(task_id,title,body,status,answer) VALUES (?,?,?,'answered',?)", task.id, `record ${i}`, 'body', 'decision');
      f.store.run("INSERT INTO notices(task_id,title,body,status) VALUES (?,?,?,'open')", task.id, 'not answered', 'body');
    });
    const first = await (await httpFetch(f.url + '/api/notices?status=answered&limit=3')).json();
    expect(first.notices).toHaveLength(3); expect(first.has_more).toBe(true);
    const second = await (await httpFetch(f.url + `/api/notices?status=answered&limit=3&before=${first.cursor}`)).json();
    expect(second.notices).toHaveLength(3); expect(second.has_more).toBe(true);
    const last = await (await httpFetch(f.url + `/api/notices?status=answered&limit=3&before=${second.cursor}`)).json();
    expect(last.notices).toHaveLength(1); expect(last.has_more).toBe(false);
    const rows = [...first.notices, ...second.notices, ...last.notices];
    expect(new Set(rows.map(row => row.id)).size).toBe(7);
    expect(rows.every(row => row.status === 'answered')).toBe(true);
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
    if (url === '/api/worker/1') return json({ id: 1, notices: rows });
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
    await findByText(focus, '回复并继续 Worker').onclick();
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

test('revision marks old pages stale without background reads; explicit reload preserves loaded depth and edits', async () => {
  // Short server pages exercise loaded depth/reload without rendering hundreds of mock cards.
  const rows = Array.from({ length: 8 }, (_, i) => ({ ...base, id: 8 - i, title: `问题 ${8 - i}`, status: 'open' }));
  let reads = 0, fail = false, onRead = null;
  const dom = installDom({ fetch: async url => {
    const json = value => ({ ok: true, json: async () => structuredClone(value) });
    if (url === '/api/worker/1') return json({ id: 1 });
    if (!url.startsWith('/api/notices?')) throw new Error(`unexpected ${url}`);
    reads++; onRead?.();
    if (fail) return { ok: false, status: 500, json: async () => ({ error: 'offline' }) };
    const params = new URL(url, 'http://localhost').searchParams;
    const before = Number(params.get('before') || Infinity), status = params.get('status') || 'all';
    const matching = rows.filter(row => row.id < before && (status === 'all' || row.status === status));
    const notices = matching.slice(0, Math.min(Number(params.get('limit') || 3), 3));
    return json({ notices, cursor: notices.at(-1)?.id, has_more: matching.length > notices.length });
  } });
  resetUiState(); initNoticeRecords(); ui.indexOpen = 'notices';
  const snapshot = revision => ({ revision, notices: structuredClone(rows.slice(0, 3)) });
  try {
    renderNotices(snapshot(1)); await until(() => !ui.noticeRecords.pending && ui.noticeRecords.page);
    await loadNoticeRecords({ more: true });
    expect(ui.noticeRecords.rows).toHaveLength(6);
    await openNotice(8);
    const input = dom.node('notice-record-detail').querySelector('textarea'); input.value = '不要丢弃这个答案';
    const list = dom.node('notices'); list.scrollTop = 77;
    rows.find(row => row.id === 3).status = 'answered';
    const beforePoll = reads;
    renderNotices(snapshot(2)); renderNotices(snapshot(2));
    expect(reads).toBe(beforePoll);
    expect(deepText(dom.node('notice-pagination'))).toContain('列表可能已过期');
    expect(ui.noticeRecords.rows.find(row => row.id === 3).status).toBe('open');
    expect(list.scrollTop).toBe(77);
    expect(dom.node('notice-record-detail').querySelector('textarea')).toBe(input);
    const reload = findByText(dom.node('notice-pagination'), '刷新已加载记录');
    expect(reload.dataset.help).toContain('不会提交答案');
    expect(reload.className).not.toContain('agent-call');
    await reload.onclick();
    expect(reads - beforePoll).toBe(2);
    expect(ui.noticeRecords.loadedPages).toBe(2);
    expect(ui.noticeRecords.rows).toHaveLength(6);
    expect(ui.noticeRecords.rows.some(row => row.id === 3)).toBe(false);
    expect(ui.noticeRecords.selected).toBe(8);
    expect(ui.noticeRecords.stale).toBe(false);
    expect(dom.node('notice-record-detail').querySelector('textarea')).toBe(input);
    expect(input.value).toBe('不要丢弃这个答案');
    expect(list.scrollTop).toBe(77);
    // A revision arriving during the explicit read must not falsely clear staleness.
    renderNotices(snapshot(3));
    onRead = () => { onRead = null; renderNotices(snapshot(4)); };
    await loadNoticeRecords({ reload: true });
    expect(ui.noticeRecords.stale).toBe(true);
    const preserved = ui.noticeRecords.rows;
    fail = true; await loadNoticeRecords({ reload: true });
    expect(ui.noticeRecords.rows).toBe(preserved);
    expect(ui.noticeRecords.stale).toBe(true);
    expect(input.value).toBe('不要丢弃这个答案');
    expect(deepText(dom.node('notice-pagination'))).toContain('offline');
  } finally { ui.noticeRecords = null; dom.restore(); }
});

test('Notice writes cannot navigate away from a newer page; failures also preserve page and edits', async () => {
  for (const [kind, label] of [['question', '回复并继续 Worker'], ['question', '忽略'],
    ['questionnaire', '确认全部选择并继续 Worker'], ['questionnaire', '忽略问卷'], ['plan', '批准并开发'], ['plan', '驳回']]) {
    for (const fail of [false, true]) {
      let release, writing = false, refreshes = 0;
      const pending = new Promise(resolve => { release = resolve; });
      const dom = installDom({ fetch: async url => {
        if (url === '/api/action') { writing = true; return pending; }
        throw new Error(`unexpected read ${url}`);
      } });
      resetUiState(); activateDetailView({ view: 'task', key: 'task-1' });
      ui.selected = 1; ui.noticeFocus = 5;
      const restoreNav = registerNavigation({ refresh: async () => { refreshes++; }, detail: async () => { throw new Error('stale write navigated'); } });
      try {
        const panel = noticePanel({ ...base, id: 5, title: '待决', kind, status: 'open',
          body: kind === 'questionnaire' ? JSON.stringify({ version: 1, questions: [{ header: '布局', question: '选择布局？',
            options: [{ label: '方案 A', description: '简单' }, { label: '方案 B', description: '复杂' }] }] }) : '' });
        dom.node('detail').replaceChildren(panel);
        if (kind === 'questionnaire' && label.startsWith('确认')) await panel.querySelector('.decision-option').onclick();
        const sending = findByText(panel, label).onclick();
        if (label === '忽略问卷') await dialogButton(dom, '忽略问卷').onclick();
        if (label === '驳回') { dom.node('modal').querySelector('input').value = '修改理由'; await dialogButton(dom, '驳回').onclick(); }
        await until(() => writing);
        const view = activateDetailView({ view: 'task-graph' });
        dom.node('detail').replaceChildren(document.createTextNode('新页面')); ui.detailDirty = true; ui.noticeFocus = 99;
        release({ ok: !fail, json: async () => fail ? { error: '请求失败' } : { id: 5, status: 'answered' } });
        await sending;
        expect(ui.view).toBe(view); expect(deepText(dom.node('detail'))).toBe('新页面');
        expect(ui.noticeFocus).toBe(99); expect(ui.detailDirty).toBe(true);
        expect(refreshes).toBe(fail ? 0 : 1);
      } finally { restoreNav(); dom.restore(); }
    }
  }
});

test('Notice settlement does not replace another selection on the same records page', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const dom = installDom({ fetch: async url => {
    if (url === '/api/action') return pending;
    throw new Error(`stale record read ${url}`);
  } });
  resetUiState(); initNoticeRecords(); ui.indexOpen = 'notices'; ui.noticeRecords.selected = 5;
  const restoreNav = registerNavigation({ refresh: async () => {}, detail: async () => { throw new Error('unexpected navigation'); } });
  try {
    const panel = noticePanel({ ...base, id: 5, title: '问题', status: 'open' });
    const sending = findByText(panel, '忽略').onclick();
    ui.noticeRecords.selected = 4; ui.detailDirty = true;
    dom.node('notice-record-detail').replaceChildren(document.createTextNode('另一个问题的编辑'));
    release({ ok: true, json: async () => ({ id: 5, status: 'dismissed' }) }); await sending;
    expect(ui.noticeRecords.selected).toBe(4); expect(ui.detailDirty).toBe(true);
    expect(deepText(dom.node('notice-record-detail'))).toBe('另一个问题的编辑');
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
    expect(panel.querySelector('textarea')).toBeNull();
    // 结算后只重放选项卡片供查看，不再出现决定 / 提交控件。
    expect(panel.querySelectorAll('.actions').length).toBe(0);
    expect(panel.querySelectorAll('.decision-progress').length).toBe(0);
    expect(panel.querySelectorAll('button').every(node => !/提交|继续|忽略|批准|驳回/.test(node.textContent))).toBe(true);
  } finally { dom.restore(); }
});
