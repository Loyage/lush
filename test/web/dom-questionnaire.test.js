import { test, expect } from 'bun:test';
import { installDom, deepText, findByText, answerDialog, dialogText } from '../dom-stub.js';
import { questionnairePanel } from '../../src/ui/web/assets/render-questionnaire.js';
import { noticePanel, renderNotices } from '../../src/ui/web/assets/render-notices.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';

function notice(id = 7, task = 22) {
  return { id, task_id: task, title: 'Choose settings', status: 'open', kind: 'questionnaire', created_at: '2026-01-01T00:00:00Z',
    body: JSON.stringify({ version: 1, body: '**Settings proposal**', questions: [
      { header: 'Layout', question: 'Which layout?', options: [
        { label: 'Sidebar', description: 'Categories on the side', previewHtml: '<nav>Account</nav>' },
        { label: 'Tabs', description: 'Wider content', preview: '```text\nAccount | Security\n```' },
      ] },
      { header: 'Features', question: 'Which features?', multiSelect: true, options: [
        { label: 'Search', description: 'Find settings' }, { label: 'Shortcuts', description: 'Keyboard support' },
      ] },
    ] }) };
}
const option = (root, label) => root.querySelectorAll('.decision-option').find(node => deepText(node).includes(label));
const click = async (root, label) => { const node = root.querySelectorAll('button').find(node => node.textContent === label); expect(node).toBeTruthy(); expect(node.disabled).toBe(false); await node.onclick(); };

test('single click advances; previews do not select; multi-select, review, edit and one final submit', async () => {
  const dom = installDom(); resetUiState(); const calls = [];
  try {
    const root = questionnairePanel(notice(), { settle: async answer => calls.push(answer) });
    expect(root.querySelector('iframe').getAttribute('sandbox')).toBe('');
    expect(root.querySelector('iframe').getAttribute('src')).toBe('/api/task/22/notice/7/preview/0/0');
    await click(root, '预览'); expect(deepText(root)).toContain('Which layout?'); expect(calls).toEqual([]);
    await option(root, 'Tabs').onclick();
    expect(deepText(root)).toContain('Which features?'); expect(deepText(root)).not.toContain('Which layout?');
    await option(root, 'Search').onclick(); await option(root, 'Shortcuts').onclick();
    expect(root.querySelectorAll('.selected').length).toBe(2);
    await click(root, '查看全部选择');
    expect(deepText(root)).toContain('确认你的全部选择'); expect(deepText(root)).toContain('Search、Shortcuts');
    expect(calls).toEqual([]);
    await click(root, '修改'); await option(root, 'Sidebar').onclick(); await click(root, '查看全部选择');
    await click(root, '确认全部选择并继续任务');
    expect(calls).toEqual([{ answers: [{ selected: [0], custom: '' }, { selected: [0, 1], custom: '' }] }]);
  } finally { dom.restore(); }
});

test('custom answer, polling rebuild, session refresh recovery, failure retry and project isolation', async () => {
  const dom = installDom(), saved = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), storage = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) } });
  resetUiState(); ui.lastSnapshot = { status: { project: '/project-a' } };
  let attempts = 0;
  const settle = async answer => { attempts++; if (attempts === 1) throw new Error('offline'); expect(answer.answers[0]).toEqual({ selected: [], custom: 'Use a drawer' }); };
  try {
    let root = questionnairePanel(notice(), { settle });
    const input = root.querySelector('textarea'); input.value = 'Use a drawer';
    for (const handler of input.listeners.input) handler();
    expect(ui.detailDirty).toBe(true);
    await click(root, '下一题'); await option(root, 'Search').onclick(); await click(root, '查看全部选择');
    ui.questionDrafts.clear(); // equivalent to refreshing the browser's module state
    root = questionnairePanel(notice(), { settle });
    expect(deepText(root)).toContain('Use a drawer');
    await click(root, '确认全部选择并继续任务');
    expect(deepText(root)).toContain('选择已保留');
    await click(root, '确认全部选择并继续任务'); expect(attempts).toBe(2); expect(storage.size).toBe(0);
    ui.lastSnapshot = { status: { project: '/project-b' } };
    root = questionnairePanel(notice(), { settle });
    expect(deepText(root)).toContain('Which layout?'); expect(root.querySelector('textarea').value).toBe('');
  } finally { if (saved) Object.defineProperty(globalThis, 'sessionStorage', saved); else delete globalThis.sessionStorage; dom.restore(); }
});

test('incomplete questionnaire cannot submit, custom answer clears selection, dismissal is explicit', async () => {
  const dom = installDom(); resetUiState(); let dismissed = 0, submitted = 0;
  try {
    const root = questionnairePanel(notice(), { settle: () => submitted++, dismiss: () => dismissed++ });
    await click(root, '汇总确认');
    expect(findByText(root, '确认全部选择并继续任务').disabled).toBe(true);
    await click(root, '修改'); await option(root, 'Tabs').onclick();
    await option(root, 'Search').onclick();
    const input = root.querySelector('textarea'); input.value = 'Neither'; input.listeners.input[0]();
    expect(root.querySelectorAll('.selected').length).toBe(0);
    const pending = findByText(root, '忽略问卷').onclick();
    expect(dialogText(dom)).toContain('不代表批准任何选项');
    expect(dismissed).toBe(0);
    await answerDialog(dom, '忽略问卷');
    await pending;
    expect(dismissed).toBe(1); expect(submitted).toBe(0);
  } finally { dom.restore(); }
});

test('answered questionnaire replays chosen options and previews with no submit path', async () => {
  const dom = installDom(); resetUiState();
  try {
    const answered = questionnairePanel({ ...notice(), status: 'answered', answer: JSON.stringify({ version: 1, answers: [
      { question: 'Which layout?', header: 'Layout', selected: [0], labels: ['Sidebar'], custom: '' },
      { question: 'Which features?', header: 'Features', selected: [1], labels: ['Shortcuts'], custom: '' },
    ] }) });
    expect(deepText(answered)).toContain('已提交选择');
    // 选中项被明确标出，previewHtml 选中项默认渲染 sandbox iframe 预览。
    const sidebar = option(answered, 'Sidebar');
    expect(sidebar.classList.contains('selected')).toBe(true);
    expect(sidebar.getAttribute('aria-pressed')).toBe('true');
    expect(answered.querySelectorAll('.decision-picked-mark').length).toBe(2);
    const frame = answered.querySelector('iframe');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('src')).toBe('/api/task/22/notice/7/preview/0/0');
    // 未选中项不冒充选择，但点它仍能看到自己的预览（Tabs 走 Markdown 预览）。
    const tabs = option(answered, 'Tabs');
    expect(tabs.classList.contains('selected')).toBe(false);
    expect(tabs.getAttribute('aria-pressed')).toBe('false');
    await tabs.onclick();
    expect(deepText(answered)).toContain('Account | Security');
    // 只读回放：不出现提交 / 回写按钮。
    expect(answered.querySelectorAll('.actions').length).toBe(0);
    expect(answered.querySelectorAll('button').every(node => !/提交|继续|忽略/.test(node.textContent))).toBe(true);
  } finally { dom.restore(); }
});

test('label-only answers backfill to options; dismissed notices never fake a selection', () => {
  const dom = installDom(); resetUiState();
  try {
    const legacy = questionnairePanel({ ...notice(), status: 'answered', answer: JSON.stringify({ answers: [
      { question: 'Which layout?', labels: ['Tabs'], custom: '' },
    ] }) });
    expect(option(legacy, 'Tabs').classList.contains('selected')).toBe(true);
    expect(deepText(legacy)).toContain('已选：Tabs');
    const dismissed = questionnairePanel({ ...notice(), status: 'dismissed', answer: null });
    expect(deepText(dismissed)).toContain('已忽略');
    expect(deepText(dismissed)).toContain('未选择任何选项');
    expect(dismissed.querySelectorAll('.decision-option').filter(node => node.classList.contains('selected')).length).toBe(0);
    expect(dismissed.querySelectorAll('.decision-picked-mark').length).toBe(0);
    // 忽略不默认加载任何预览。
    expect(dismissed.querySelectorAll('iframe').length).toBe(0);
  } finally { dom.restore(); }
});

test('different branches share the notice queue and final confirmation advances to the next task', async () => {
  const first = notice(), second = notice(8, 99), sent = [], navigated = [];
  const dom = installDom({ fetch: async (_url, opts) => { sent.push(JSON.parse(opts.body)); return Response.json({ status: 'answered' }); } });
  resetUiState();
  const restoreNavigation = registerNavigation({ refresh: async () => renderNotices({ notices: [second] }), detail: async id => navigated.push(id), overview: async () => {} });
  try {
    renderNotices({ notices: [first, second] }); ui.noticeFocus = first.id;
    const root = noticePanel(first, { role: 'worker' });
    await option(root, 'Tabs').onclick(); await option(root, 'Search').onclick(); await click(root, '查看全部选择');
    await click(root, '确认全部选择并继续任务');
    expect(sent).toEqual([{ method: 'notice.answer', params: { id: 7, answer: { answers: [{ selected: [1], custom: '' }, { selected: [0], custom: '' }] } } }]);
    expect(navigated).toEqual([99]); expect(ui.noticeFocus).toBe(8);
    const answered = questionnairePanel({ ...first, status: 'answered', answer: JSON.stringify({ answers: [{ question: 'Which layout?', labels: ['Tabs'], custom: '' }] }) });
    expect(deepText(answered)).toContain('已提交选择'); expect(deepText(answered)).toContain('Tabs');
    // 回放只提供预览切换，不出现提交 / 回写按钮。
    expect(answered.querySelectorAll('.actions').length).toBe(0);
    expect(answered.querySelectorAll('button').every(node => !/提交|继续|忽略/.test(node.textContent))).toBe(true);
  } finally { restoreNavigation(); dom.restore(); }
});
