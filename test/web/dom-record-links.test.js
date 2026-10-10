import { test, expect } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { el } from '../../src/ui/web/assets/dom.js';
import { noticeNumber } from '../../src/ui/web/assets/format.js';
import { linkWorkerNumbers } from '../../src/ui/web/assets/worker-links.js';
import { sourceWorkerLinks } from '../../src/ui/web/assets/global-inbox-model.js';
import { agentText } from '../../src/ui/web/assets/text.js';
import { noticePanel } from '../../src/ui/web/assets/render-notices.js';
import { questionnairePanel } from '../../src/ui/web/assets/render-questionnaire.js';
import { renderTaskMessage } from '../../src/ui/web/assets/render-task-message.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
const text = node => node.childNodes.length ? node.childNodes.map(text).join('') : node.textContent;
const links = node => node.querySelectorAll('.record-link');

test('D/N depend on explicit kind only, not status or misleading titles', () => {
  for (const kind of ['question', 'questionnaire', 'plan'])
    for (const status of ['open', 'answered', 'dismissed']) expect(noticeNumber({ id: 454, kind, status })).toBe('D454');
  for (const kind of ['info', 'unknown', undefined]) expect(noticeNumber({ id: 7, kind, title: '用户决定' })).toBe('N7');
});

test('D/N/O prose links preserve text, reject partial names and unsafe IDs, skip code/forms/existing links', () => {
  const dom = installDom({ fetch: () => { throw new Error('render must not fetch'); } });
  try {
    const source = '决定D454、告知N9，输入O190。 D0 N01 O0 O12-1 AD2 file-N3 D4.txt /O5 https://x/N6 #D7 O9007199254740992';
    const root = el('div', source); linkWorkerNumbers(root);
    expect(text(root)).toBe(source);
    expect(links(root).map(a => a.textContent)).toEqual(['D454', 'N9', 'O190']);
    expect(links(root).map(a => a.getAttribute('href'))).toEqual(['#notices-454', '#notices-9', '#input-input-190']);
    expect(links(root)[0].getAttribute('aria-label')).toContain('用户决定 D454');
    linkWorkerNumbers(root); expect(links(root)).toHaveLength(3);
    for (const tag of ['a', 'button', 'textarea', 'input', 'select', 'pre', 'code']) {
      const node = el(tag, 'D454 N9 O190'); root.append(node); linkWorkerNumbers(root); expect(links(node)).toHaveLength(0);
    }
    const off = el('div', 'D454 N9 O190'); off.setAttribute('data-worker-links', 'off'); root.append(off);
    const editable = el('div', 'O190'); editable.setAttribute('contenteditable', 'true'); root.append(editable);
    linkWorkerNumbers(root); expect(links(off)).toHaveLength(0); expect(links(editable)).toHaveLength(0);
    expect(links(agentText('**D454** N9 O190 `D8`')).map(a => a.textContent)).toEqual(['D454', 'N9', 'O190']);
    localStorage.setItem('lush.markdown', '0');
    expect(text(agentText('D454\nO190', { plain: 'pre' }))).toBe('D454\nO190');
    expect(links(agentText('D454\nO190', { plain: 'pre' }))).toHaveLength(2);
  } finally { dom.restore(); }
});

test('global record and Worker links always retain the originating project, including repeated enhancement', () => {
  const dom = installDom();
  try {
    const root = el('div', 'W190 D454 N9 O190'); sourceWorkerLinks(root, 'bbbbbbbbbbbbbbbb'); sourceWorkerLinks(root, 'bbbbbbbbbbbbbbbb');
    expect(root.querySelectorAll('a').map(a => a.getAttribute('href'))).toEqual([
      '/p/bbbbbbbbbbbbbbbb/#worker-number-W190', '/p/bbbbbbbbbbbbbbbb/#notices-454',
      '/p/bbbbbbbbbbbbbbbb/#notices-9', '/p/bbbbbbbbbbbbbbbb/#input-input-190']);
    for (const a of root.querySelectorAll('a')) { expect(a.getAttribute('target')).toBe('_blank'); expect(a.getAttribute('rel')).toBe('noopener'); }
  } finally { dom.restore(); }
});

test('decision option links do not select or submit; Notice panels and answer messages display prefixed identity', () => {
  const dom = installDom(); resetUiState(); let writes = 0;
  try {
    const notice = { id: 454, task_id: 352, kind: 'questionnaire', status: 'open', title: '选择',
      body: JSON.stringify({ version: 1, body: '比较 O190', questions: [{ header: '方案', question: '参考 D453？',
        options: [{ label: '参考 D453', description: '比较 N9 与 O190' }, { label: '保持', description: '不变' }] }] }) };
    const root = questionnairePanel(notice, { settle: () => writes++ });
    const choice = root.querySelector('.decision-option-card'); let stopped = 0;
    links(choice)[0].onclick({ stopPropagation: () => stopped++ });
    expect(stopped).toBe(1); expect(writes).toBe(0); expect([...ui.questionDrafts.values()][0].answers[0].selected).toEqual([]);
    expect(links(choice.querySelector('button'))).toHaveLength(0);
    expect(links(noticePanel(notice)).map(a => a.textContent)).toContain('D454');
    expect(links(noticePanel({ id: 9, task_id: 352, kind: 'info', status: 'sent', title: '完成', body: '查看 O190' })).map(a => a.textContent)).toEqual(['N9', 'O190']);
    const message = renderTaskMessage({ id: 1, task_id: 352, body: JSON.stringify({ notice_id: 454, notice_kind: 'questionnaire', dismissed: true, answer: '' }) }, 352);
    expect(links(message).map(a => a.textContent)).toEqual(['D454']);
  } finally { dom.restore(); }
});
