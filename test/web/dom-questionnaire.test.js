import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { questionnairePanel } from '../../src/ui/web/assets/render-questionnaire.js';
import { resetUiState } from '../../src/ui/web/assets/state.js';

const option = (root, label) => root.querySelectorAll('.decision-option').find(node => deepText(node).includes(label));
const click = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label).onclick();

test('questionnaire advances single choice, collects multiple choices and submits the reviewed answer', async () => {
  const dom = installDom(); resetUiState(); const calls = [];
  try {
    const notice = { id: 7, task_id: 22, kind: 'questionnaire', status: 'open', title: 'Choose settings',
      body: JSON.stringify({ version: 1, questions: [
        { header: 'Layout', question: 'Which layout?', options: [{ label: 'Sidebar', description: 'Side categories' }, { label: 'Tabs', description: 'Wide content' }] },
        { header: 'Features', question: 'Which features?', multiSelect: true, options: [{ label: 'Search', description: 'Find settings' }, { label: 'Shortcuts', description: 'Keyboard support' }] },
      ] }) };
    const root = questionnairePanel(notice, { settle: async answer => calls.push(answer) });
    await option(root, 'Tabs').onclick(); expect(deepText(root)).toContain('Which features?');
    await option(root, 'Search').onclick(); await option(root, 'Shortcuts').onclick();
    await click(root, '查看全部选择'); expect(deepText(root)).toContain('确认你的全部选择'); expect(calls).toEqual([]);
    await click(root, '确认全部选择并继续 Worker');
    expect(calls).toEqual([{ answers: [{ selected: [1], custom: '' }, { selected: [0, 1], custom: '' }] }]);
  } finally { dom.restore(); }
});
