import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { initNoticeRecords, loadNoticeRecords, renderNotices } from '../../src/ui/web/assets/render-notices.js';
import { transcriptReader, resetTranscriptReaders } from '../../src/ui/web/assets/transcript-reader.js';
import { createCodeTree } from '../../src/ui/web/assets/code-tree.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';

const json = value => new Response(JSON.stringify(value));
const enter = (input, extra = {}) => input.listeners.keydown[0]({ key: 'Enter', preventDefault() {}, ...extra });
const draft = (input, value) => { input.value = value; input.listeners.input[0](); };
const button = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);

test('notice local search preserves applied word through polls, status and older pages; no backend search or reply replacement', async () => {
  const base = { task_id: 1, kind: 'question', status: 'open', created_at: '2026-10-11T00:00:00Z', body: '正文' };
  const rows = [{ ...base, id: 2, title: '首页' }, { ...base, id: 1, title: '命中旧页' }], requests = [];
  const dom = installDom({ fetch: async url => {
    requests.push(String(url)); const more = String(url).includes('before=');
    return json({ notices: [rows[more ? 1 : 0]], cursor: more ? 1 : 2, has_more: !more });
  } }); resetUiState();
  try {
    initNoticeRecords(); ui.indexOpen = 'notices'; await loadNoticeRecords();
    const input = dom.node('side-notices-body').querySelector('.search-field-input');
    draft(input, '命中'); renderNotices({ notices: [rows[0]], revision: 1 });
    expect(dom.node('notices').children).toHaveLength(1);
    enter(input, { isComposing: true }); expect(dom.node('notices').children).toHaveLength(1);
    enter(input); expect(dom.node('notices').children).toHaveLength(0);
    expect(deepText(dom.node('notice-pagination'))).toContain('不代表全库无结果');
    draft(input, '尚未提交新词'); await loadNoticeRecords({ more: true });
    expect(deepText(dom.node('notices'))).toContain('命中旧页');
    await button(dom.node('side-notices-body'), '全部记录').onclick();
    expect(dom.node('notices').children).toHaveLength(0);
    await loadNoticeRecords({ more: true }); expect(dom.node('notices').children).toHaveLength(1);
    await button(dom.node('side-notices-body'), '清空').onclick(); expect(dom.node('notices').children).toHaveLength(2);
    expect(ui.noticeRecords.status).toBe('all'); expect(requests.every(url => !url.includes('q='))).toBe(true);
  } finally { resetUiState(); dom.restore(); }
});

test('reader instant filters do not apply draft keyword/tool; clear keeps nontext filters and rejects stale criteria', async () => {
  const requests = [], dom = installDom({ fetch: async url => { requests.push(new URL(String(url), 'http://fixture')); return json({ steps: [], files: ['a'], has_more: false }); } }); resetTranscriptReaders();
  try {
    const root = transcriptReader(7), form = root.querySelector('form'), inputs = form.querySelectorAll('input');
    draft(inputs[0], 'draft keyword'); draft(inputs[1], 'draft tool');
    const kind = form.querySelector('select'); kind.value = 'tool'; await kind.onchange();
    expect(requests.at(-1).searchParams.get('query')).toBe(''); expect(requests.at(-1).searchParams.get('tool')).toBe('');
    await enter(inputs[0]); expect(requests.at(-1).searchParams.get('query')).toBe('draft keyword'); expect(requests.at(-1).searchParams.get('tool')).toBe('draft tool');
    draft(inputs[0], 'new draft'); draft(inputs[1], 'new tool'); inputs[2].checked = true; await inputs[2].onchange();
    expect(requests.at(-1).searchParams.get('query')).toBe('draft keyword'); expect(requests.at(-1).searchParams.get('tool')).toBe('draft tool');
    await button(root, '清空').onclick();
    expect(requests.at(-1).searchParams.get('query')).toBe(''); expect(requests.at(-1).searchParams.get('kind')).toBe('tool');
    expect(requests.at(-1).searchParams.get('errors')).toBe('true'); expect(requests.at(-1).searchParams.get('tool')).toBe('draft tool');
  } finally { resetTranscriptReaders(); dom.restore(); }
});

test('code tree changed-only filter/reset/page uses applied path, never pending input; clear keeps changed-only', async () => {
  const dom = installDom(), requests = [];
  try {
    const tree = createCodeTree({ request: async (_method, params) => { requests.push(params); return { availability: 'available', revision: 'r', entries: [], has_more: false }; }, onSelect() {}, onStale() {} });
    const snapshot = { availability: 'available', revision: 'r', scope: 'task', files: [], base_commit: 'abc', summary: {} };
    await tree.reset(snapshot); const inputs = tree.root.querySelectorAll('input');
    draft(inputs[0], 'pending'); inputs[1].checked = true; await inputs[1].onchange();
    expect(requests.at(-1).query).toBe(''); expect(requests.at(-1).changed).toBe(true);
    await enter(inputs[0], { keyCode: 229 }); expect(requests.at(-1).query).toBe('');
    await enter(inputs[0]); expect(requests.at(-1).query).toBe('pending');
    draft(inputs[0], 'unsubmitted'); await tree.reset(snapshot); expect(requests.at(-1).query).toBe('pending');
    await button(tree.root, '清空').onclick(); expect(requests.at(-1).query).toBe(''); expect(requests.at(-1).changed).toBe(true);
  } finally { dom.restore(); }
});

test('input/results retain applied search through category/order and refresh; whole-history uses applied query', async () => {
  const reads = [], dom = installDom({ fetch: async url => { reads.push(new URL(String(url), 'http://fixture')); return json({ events: [], messages: [], has_more_events: false, has_more_messages: false }); } }); resetUiState(); ui.hostSession = { status: 'ready' };
  try {
    const task = { id: 7, goal: '目标', result: '结果命中' }, root = renderConversation(task), input = root.querySelector('.search-field-input');
    draft(input, '不存在'); await button(root, '正序').onclick(); root.updateConversation(task);
    expect(root.querySelectorAll('.conversation-message')).toHaveLength(2);
    await enter(input, { isComposing: true }); expect(root.querySelectorAll('.conversation-message')).toHaveLength(2);
    draft(input, '命中'); await enter(input); expect(root.querySelectorAll('.conversation-message')).toHaveLength(1);
    draft(input, '未提交'); root.updateConversation(task); await button(root, '查找全部历史').onclick();
    expect(reads.at(-1).searchParams.get('query')).toBe('命中'); expect(root.querySelectorAll('.conversation-message')).toHaveLength(1);
    await button(root, '清空').onclick(); expect(root.querySelectorAll('.conversation-message')).toHaveLength(2);
  } finally { resetUiState(); dom.restore(); }
});
