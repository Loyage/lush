import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { openNotice, renderNotices } from '../../src/ui/web/assets/render-notices.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

const option = (root, label) => root.querySelectorAll('.decision-option').find(node => deepText(node).includes(label));
const click = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label).onclick();

test('questionnaire advances choices and settles the reviewed answer independently of follow-up reads', async () => {
  const calls = [];
  const questions = [
    { header: 'Layout', question: 'Which layout?', options: [{ label: 'Sidebar', description: 'Side categories' }, { label: 'Tabs', description: 'Wide content' }] },
    { header: 'Features', question: 'Which features?', multiSelect: true, options: [{ label: 'Search', description: 'Find settings' }, { label: 'Shortcuts', description: 'Keyboard support' }] },
  ];
  const notice = { id: 7, task_id: 22, kind: 'questionnaire', status: 'open', title: 'Choose settings', created_at: '2026-01-01',
    body: JSON.stringify({ version: 1, questions }) };
  const dom = installDom({ fetch: async (url, options) => {
    if (options?.method === 'POST') {
      const { method, params } = JSON.parse(options.body); expect(method).toBe('notice.answer'); calls.push(params.answer);
      return Response.json({ ...notice, status: 'answered', answer_source: 'user',
        answer: JSON.stringify({ version: 1, answers: params.answer.answers.map((answer, i) => ({ ...answer, question: questions[i].question })) }) });
    }
    if (calls.length) return Response.json({ error: 'controlled follow-up read failure' }, { status: 500 });
    if (String(url).includes('/api/notices?')) return Response.json({ notices: [notice] });
    if (String(url).endsWith('/api/worker/22')) return Response.json({ id: 22 });
    throw Error(`unexpected questionnaire read: ${url}`);
  } });
  const restore = registerNavigation({ refresh: async () => { throw Error('controlled refresh failure'); }, detail: async () => true, overview: async () => {} });
  try {
    resetUiState(); await openNotice(notice.id, { record: true }); const root = ui.noticePage.focus;
    expect(root.querySelector('.decision-status').textContent).toContain('0 / 2');
    expect(root.querySelector('.decision-progress').querySelectorAll('button')).toHaveLength(3);
    await option(root, 'Tabs').onclick(); expect(deepText(root)).toContain('Which features?');
    expect(document.activeElement?.textContent).toBe('Which features?');
    expect(root.querySelector('.decision-status').textContent).toContain('1 / 2');
    await option(root, 'Search').onclick(); await option(root, 'Shortcuts').onclick();
    expect(document.activeElement).toBe(option(root, 'Shortcuts'));
    await click(root, '查看全部选择'); expect(deepText(root)).toContain('确认你的全部选择'); expect(calls).toEqual([]);
    await click(root, '确认全部选择并继续 Worker');
    expect(calls).toEqual([{ answers: [{ selected: [1], custom: '' }, { selected: [0, 1], custom: '' }] }]);
    expect(deepText(root)).toContain('已提交选择'); expect(deepText(root)).not.toContain('未提交成功');
    expect(root.querySelector('textarea')).toBeNull(); expect(ui.questionDrafts.size).toBe(0);
    // An overview request started before the ACK must not restore the writable form.
    renderNotices({ notices: [notice] });
    expect(deepText(root)).toContain('已提交选择'); expect(root.querySelector('textarea')).toBeNull();
    await new Promise(resolve => setImmediate(resolve));
    expect(dom.node('error').textContent).toContain('事项已处理，但页面刷新失败');
  } finally { restore(); dom.restore(); }
});
