import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { initNoticeRecords, loadNoticeRecords, openNotice, renderNotices } from '../../src/ui/web/assets/render-notices.js';
import { activateDetailView, openResource } from '../../src/ui/web/assets/sidebar-ui.js';

const row = (id, extra = {}) => ({ id, task_id: 1, task_worker_number: 'W238', kind: 'question', status: 'open',
  title: `决策 ${id}`, body: `原始正文 ${id}`, created_at: '2026-01-01T00:00:00Z', ...extra });
const json = value => ({ ok: true, json: async () => structuredClone(value) });
function fixture(rows, intercept = async () => null) {
  const calls = [];
  const dom = installDom({ fetch: async (url, options = {}) => {
    calls.push(url);
    const response = await intercept(url, options);
    if (response) return response;
    if (url === '/api/worker/1') return json({ id: 1, worker_number: 'W238' });
    const params = new URL(url, 'http://localhost').searchParams;
    const before = Number(params.get('before') || Infinity), limit = Number(params.get('limit') || 2);
    const matching = rows.filter(item => item.id < before && (!params.has('status') || params.get('status') === 'all' || item.status === params.get('status')));
    return json({ notices: matching.slice(0, limit), cursor: matching.slice(0, limit).at(-1)?.id, has_more: matching.length > limit });
  } });
  resetUiState(); initNoticeRecords();
  return { dom, calls, focus: () => dom.node('detail').querySelector('.notice-record-detail') };
}

test('native record links navigate to standalone details and return with filters, search and pagination intact', async () => {
  const rows = [row(4), row(3), row(2), row(1)];
  const { dom, calls, focus } = fixture(rows);
  try {
    openResource('notices'); await until(() => !ui.noticeRecords.pending);
    await loadNoticeRecords({ more: true });
    ui.noticeRecords.query = '决策'; renderNotices({ revision: 1, notices: rows });
    const records = ui.noticeRecords, link = dom.node('notices').children[0];
    expect(link.tagName).toBe('A'); expect(link.getAttribute('href')).toBe('#notices-4');
    const before = calls.length, view = ui.view;
    for (const gesture of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      let prevented = false;
      await link.onclick({ ...gesture, preventDefault() { prevented = true; } });
      expect(prevented).toBe(false); expect(ui.view).toBe(view); expect(calls.length).toBe(before);
    }
    await link.click();
    expect(ui.view.id).toBe('notice'); expect(ui.indexOpen).toBeNull(); expect(dom.location.hash).toBe('#notices-4');
    expect(dom.node('resource-panels').hidden).toBe(true); expect(dom.node('detail').hidden).toBe(false);
    expect(dom.node('side-notices-body').querySelector('.notice-record-detail')).toBeNull();
    expect(deepText(focus())).toContain('原始正文 4'); expect(deepText(dom.node('view-title')) || dom.node('view-title').textContent).toContain('D4');
    expect(dom.node('detail').querySelector('a[href="#worker-1"]')).not.toBeNull();
    await dom.node('detail').querySelector('a[href="#notices"]').click();
    expect(ui.view.id).toBe('notices'); expect(ui.noticeRecords).toBe(records);
    expect(records.loadedPages).toBe(2); expect(records.rows).toHaveLength(4); expect(records.query).toBe('决策');
    expect(calls.length).toBe(before + 2); // One exact Notice read plus its Worker, no automatic list reload.
  } finally { dom.restore(); }
});

test('detail revalidation preserves reply DOM; failures retain the page and allow retry', async () => {
  let fail = false, taskRevision = 0;
  const { dom, focus } = fixture([row(8)], async url => {
    if (url === '/api/worker/1') return json({ id: 1, worker_number: 'W238', updated_at: ++taskRevision });
    return fail && url.startsWith('/api/notices') ? { ok: false, json: async () => ({ error: '来源离线' }) } : null;
  });
  try {
    await openNotice(8, { record: true });
    const input = focus().querySelector('textarea'); input.value = '保留答复';
    await openNotice(8, { record: true });
    expect(focus().querySelector('textarea')).toBe(input); expect(input.value).toBe('保留答复');
    expect(dom.node('view-title').textContent).toContain('D8');
    fail = true; await openNotice(8, { record: true });
    expect(deepText(dom.node('detail'))).toContain('来源离线'); expect(focus().querySelector('textarea')).toBe(input);
    fail = false; await findByText(dom.node('detail'), '重试读取').click();
    expect(deepText(dom.node('detail'))).not.toContain('来源离线'); expect(input.value).toBe('保留答复');
  } finally { dom.restore(); }
});

test('failed initial detail is explicit and retry reads exact history outside the list filter', async () => {
  let fail = true;
  const { dom, focus } = fixture([row(9, { status: 'answered', answer: '保留最终答案', answer_source: 'user' })], async url =>
    fail && url.startsWith('/api/notices') ? { ok: false, json: async () => ({ error: '读取失败' }) } : null);
  try {
    await openNotice(9, { record: true });
    expect(ui.view.id).toBe('notice'); expect(focus().children).toHaveLength(0);
    expect(deepText(dom.node('detail'))).toContain('读取失败');
    fail = false; await findByText(dom.node('detail'), '重试读取').click();
    expect(deepText(focus())).toContain('保留最终答案'); expect(deepText(focus())).toContain('用户答复');
    expect(focus().querySelector('textarea')).toBeNull(); expect(ui.noticeRecords.status).toBe('open');
  } finally { dom.restore(); }
});

test('late Notice or Worker reads cannot overwrite a newer detail or resurrect deleted records', async () => {
  for (const delayed of ['notice', 'worker']) {
    let release, entered = false;
    const gate = new Promise(resolve => { release = resolve; });
    const { dom, focus } = fixture([row(8), row(7)], async url => {
      if ((delayed === 'notice' && url.includes('before=9')) || (delayed === 'worker' && url === '/api/worker/1' && !entered)) {
        entered = true; await gate;
      }
      return null;
    });
    try {
      const opening = openNotice(8, { record: true }); await until(() => entered);
      await openNotice(7, { record: true });
      const view = ui.view, content = focus(); release(); await opening;
      expect(ui.view).toBe(view); expect(ui.noticePage.id).toBe(7); expect(focus()).toBe(content);
      expect(deepText(content)).toContain('决策 7'); expect(ui.noticeIndex.has(8)).toBe(false);
    } finally { release(); dom.restore(); }
  }
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const { dom } = fixture([row(8)], async url => { if (url.includes('before=9')) { entered = true; await gate; } return null; });
  try {
    const opening = openNotice(8, { record: true }); await until(() => entered);
    ui.deletedWorkerIds.add(1); activateDetailView({ view: 'overview' });
    release(); await opening;
    expect(ui.noticeIndex.has(8)).toBe(false); expect(ui.view.id).toBe('overview');
  } finally { release(); dom.restore(); }
});
