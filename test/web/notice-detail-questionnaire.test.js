import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { initNoticeRecords, openNotice, renderNotices } from '../../src/ui/web/assets/render-notices.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';

test('standalone questionnaire confirms once and stays on its original read-only decision, not the next Worker', async () => {
  const rows = [{ id: 9, task_id: 1, title: '页面布局', kind: 'questionnaire', status: 'open', created_at: '2026-01-01T00:00:00Z',
    body: JSON.stringify({ version: 1, questions: [{ header: '布局', question: '采用哪种布局？', options: [
      { label: '独立页面', description: '完整记录' }, { label: '内联展开', description: '保留列表' },
    ] }] }) }, { id: 10, task_id: 2, title: '下一问题', kind: 'question', status: 'open' }];
  const writes = [];
  const dom = installDom({ fetch: async (url, options = {}) => {
    const json = value => ({ ok: true, json: async () => structuredClone(value) });
    if (url === '/api/worker/1') return json({ id: 1, worker_number: 'W238' });
    if (url.startsWith('/api/notices?')) return json({ notices: [rows[0]], has_more: false });
    if (url === '/api/action') {
      const { method, params } = JSON.parse(options.body); writes.push({ method, params });
      rows[0].status = 'answered'; rows[0].answer = JSON.stringify(params.answer); rows[0].answer_source = 'user';
      return json(rows[0]);
    }
    throw new Error(`unexpected ${url}`);
  } });
  resetUiState(); initNoticeRecords();
  const restore = registerNavigation({ refresh: async () => renderNotices({ notices: rows }), detail: async () => { throw new Error('must stay on decision'); } });
  try {
    await openNotice(9, { record: true });
    const focus = dom.node('detail').querySelector('.notice-record-detail');
    const panel = focus.querySelector('.notice');
    await panel.querySelector('.decision-option').click();
    expect(writes).toHaveLength(0);
    await findByText(panel, '确认全部选择并继续 Worker').click();
    expect(writes).toEqual([{ method: 'notice.answer', params: { id: 9, answer: { answers: [{ selected: [0], custom: '' }] } } }]);
    expect(ui.view.id).toBe('notice'); expect(ui.noticePage.id).toBe(9); expect(dom.location.hash).toBe('#notices-9');
    expect(deepText(focus)).toContain('独立页面'); expect(deepText(focus)).toContain('内联展开');
    expect(deepText(focus)).toContain('用户答复'); expect(focus.querySelector('textarea')).toBeNull();
    expect(focus.querySelectorAll('button').some(node => /提交|继续|忽略/.test(node.textContent))).toBe(false);
    expect(rows[1].status).toBe('open');
  } finally { restore(); dom.restore(); }
});
