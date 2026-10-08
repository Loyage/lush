import { test, expect } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { el } from '../../src/ui/web/assets/dom.js';
import { linkWorkerNumbers, workerNumberTarget, resolveWorkerNumber } from '../../src/ui/web/assets/worker-links.js';
import { agentText } from '../../src/ui/web/assets/text.js';
import { questionnairePanel } from '../../src/ui/web/assets/render-questionnaire.js';
import { noticePanel } from '../../src/ui/web/assets/render-notices.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

const text = node => node.childNodes.length ? node.childNodes.map(text).join('') : node.textContent;
const links = root => root.querySelectorAll('.worker-link');
const record = status => ({ id: 7, task_id: 22, status, kind: 'questionnaire', created_at: '2026-01-01',
  body: JSON.stringify({ version: 1, body: '请查看 W141 的结果', questions: [{ header: '方案', question: '让 W141-1 继续吗？',
    options: [{ label: '采用 W141-1', description: '比较 W141-1-2 与 W142', preview: '**W142** 的方案' },
      { label: '保持现状', description: '不修改' }] }] }),
  answer: JSON.stringify({ answers: [{ selected: [0] }] }),
});

test('Worker links match complete numbers only, preserve text and never request metadata during render', () => {
  const dom = installDom({ fetch: () => { throw new Error('render must not fetch'); } });
  try {
    const source = '查看W141、（W141-1-2），W142. W143。 W0 W01 W1-0 W1-01 W1- W7x AW8 file-W9 W10.txt /W11 W12/path #8';
    const root = el('div', source);
    linkWorkerNumbers(root);
    expect(text(root)).toBe(source);
    expect(links(root).map(node => node.textContent)).toEqual(['W141', 'W141-1-2', 'W142', 'W143']);
    expect(links(root)[1].getAttribute('href')).toBe('#worker-number-W141-1-2');
    expect(links(root)[1].getAttribute('aria-label')).toContain('查看 Worker W141-1-2');
    linkWorkerNumbers(root);
    expect(links(root)).toHaveLength(4);
    for (const tag of ['button', 'a', 'textarea', 'input', 'select', 'code', 'pre', 'iframe']) {
      const node = el(tag, 'W141'); root.append(node);
      linkWorkerNumbers(root);
      expect(links(node)).toHaveLength(0);
    }
    const editable = el('div', 'W141'); editable.setAttribute('contenteditable', 'true'); root.append(editable);
    linkWorkerNumbers(root); expect(links(editable)).toHaveLength(0);
    for (const hash of ['#worker-141', '#worker-number-W0', '#worker-number-W1-0', '#worker-number-W1x'])
      expect(workerNumberTarget(hash)).toBeNull();
    expect(workerNumberTarget('#worker-number-W141-1')).toBe('W141-1');
  } finally { dom.restore(); }
});

test('Agent prose links Markdown and plain results but preserves code and existing external links', () => {
  const dom = installDom(); resetUiState();
  try {
    const source = '完成 **W141**；查看 W141-1。\n\n`W142`\n\n```text\nW143\n```\n\n[W144](https://example.com)';
    const rich = agentText(source);
    expect(links(rich).map(node => node.textContent)).toEqual(['W141', 'W141-1']);
    expect(rich.querySelectorAll('a').some(node => node.getAttribute('href') === 'https://example.com/')).toBe(true);
    localStorage.setItem('lush.markdown', '0');
    const plain = agentText('完成 W141-1\n下一步 W142', { plain: 'pre' });
    expect(links(plain).map(node => node.textContent)).toEqual(['W141-1', 'W142']);
    expect(text(plain)).toBe('完成 W141-1\n下一步 W142');
    const notice = noticePanel({ id: 8, task_id: 22, status: 'sent', kind: 'info', title: 'W141 完成', body: '查看 W141-1' });
    expect(links(notice).map(node => node.textContent)).toEqual(['W141', 'W141-1']);
  } finally { dom.restore(); }
});

test('questionnaire links do not select, submit or erase drafts; selection/replay/preview remain accessible', async () => {
  const dom = installDom(); resetUiState(); let submitted = 0;
  try {
    const notice = record('open');
    const root = questionnairePanel(notice, { settle: () => submitted++ });
    expect(links(root).map(node => node.textContent)).toContain('W141-1-2');
    const choice = root.querySelector('.decision-option-card'), control = choice.querySelector('button');
    expect(control.getAttribute('aria-label')).toBe('采用 W141-1');
    expect(control.getAttribute('aria-pressed')).toBe('false');
    expect(links(control)).toHaveLength(0); // no nested interactive nodes
    let stopped = 0;
    links(choice)[0].onclick({ stopPropagation: () => stopped++ });
    expect(stopped).toBe(1);
    expect(submitted).toBe(0);
    expect([...ui.questionDrafts.values()][0].answers[0].selected).toEqual([]);
    // The native button is still the keyboard and whole-card selection path.
    await control.onclick();
    expect([...ui.questionDrafts.values()][0].answers[0].selected).toEqual([0]);
    expect(text(root)).toContain('确认你的全部选择');
    expect(links(root).map(node => node.textContent)).toContain('W141-1');
    expect(submitted).toBe(0);
    const rebuilt = questionnairePanel(notice, { settle: () => submitted++ });
    expect(text(rebuilt)).toContain('确认你的全部选择');
    const settled = questionnairePanel(record('answered'));
    const replay = settled.querySelector('.decision-option-card');
    expect(replay.querySelector('button').getAttribute('aria-pressed')).toBe('true');
    expect(links(settled).map(node => node.textContent)).toContain('W142');
    await replay.querySelector('button').onclick();
    expect(links(settled).map(node => node.textContent)).toContain('W142');
    expect(submitted).toBe(0);
  } finally { dom.restore(); }
});

test('Worker detail links Hook message targets but leaves Shell command literals untouched', () => {
  const dom = installDom({ fetch: () => { throw new Error('read-only rendering must not execute Hooks'); } });
  resetUiState(); ui.view = { id: 'task', key: 'task-1' };
  try {
    const command = 'printf "W141"\nprintf "W141-1"';
    const mount = { name: '命令与消息', trigger: 'worker.merge_received', mode: 'persistent', enabled: false,
      builtin: false, editable: true, removable: true, conditions: {}, state: 'idle', last_execution: null };
    renderDetail({ id: 1, task_kind: 'main', role: 'agent', branch: 'main', status: 'waiting', goal: '查看 W141',
      calls: 0, created_at: '2026-01-01', updated_at: '2026-01-01', children: [], deps: [], dependents: [],
      hooks: { version: 1, worker_id: 1, revision: 'main-hooks', can_attach: false, mounts: [
        { ...mount, id: 'command', actions: [{ type: 'command', command }] },
        { ...mount, id: 'message', actions: [{ type: 'message', target_id: 277, target_worker_number: 'W141', body: '比较 W141-1' }] },
      ] } }, { events: [] }, null, null);
    const previews = dom.node('detail').querySelectorAll('.hook-action-preview');
    expect(previews).toHaveLength(2);
    expect(text(previews[0])).toBe(`执行 Shell 命令：\n${command}`);
    expect(links(previews[0])).toHaveLength(0);
    expect(links(previews[1]).map(node => node.textContent)).toEqual(['W141', 'W141-1']);
    expect(links(dom.node('detail').querySelector('.goal-text')).map(node => node.textContent)).toEqual(['W141']);
  } finally { dom.restore(); }
});

test('lookup stays project scoped and validates the returned identity instead of guessing integer IDs', async () => {
  const reads = [];
  let response = { id: 277, worker_number: 'W141-1' };
  const dom = installDom({ fetch: async url => { reads.push(url); return { ok: true, json: async () => response }; } });
  try {
    dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
    expect(await resolveWorkerNumber('W141-1')).toBe(277);
    expect(reads).toEqual(['/p/aaaaaaaaaaaaaaaa/api/worker-lookup?number=W141-1']);
    response = { id: 141, worker_number: 'W142' };
    await expect(resolveWorkerNumber('W141-1')).rejects.toThrow('无法定位 Worker W141-1');
    await expect(resolveWorkerNumber('W0')).rejects.toThrow('无效的 Worker 编号');
    expect(reads).toHaveLength(2);
  } finally { dom.restore(); }
});
