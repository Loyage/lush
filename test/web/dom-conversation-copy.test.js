import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';
import { renderTaskMessageBody } from '../../src/ui/web/assets/render-task-message.js';
import { copyButton, copyText } from '../../src/ui/web/assets/clipboard.js';
import { clear } from '../../src/ui/web/assets/messages.js';
import { ui } from '../../src/ui/web/assets/state.js';

function clipboard(writeText) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: writeText ? { writeText } : undefined } });
  return () => { if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator; };
}
const task = { id: 7, worker_number: 'W313', input_id: 313, goal: '初始输入', result: '回复' };
const partial = { id: 8, task_id: 7, type: 'invocation.completed', data: { run_id: 2, result: '前缀' }, text_truncated: true, total_chars: 6 };
const response = page => new Response(JSON.stringify(page), { headers: { 'Content-Type': 'application/json' } });
function ready() { ui.hostSession = { status: 'ready', username: '测试用户' }; }

test('input/output copy uses exact raw source, code copies only its block, and refresh keeps the latest copy source', async () => {
  const dom = installDom(), copied = [], restore = clipboard(async text => copied.push(text)); ready();
  const source = '# 输入\n\n```unknown\n  <script>bad()</script>\n\nconst a = `W313`;  \n```\n\n```\n第二段\n```\n末尾  \n';
  try {
    const root = renderConversation({ ...task, goal: source, result: '**输出**\n\n```\necho 原文\n```', messages: [
      { id: 3, sender_id: null, append_number: 'A313-1', body: '  追加\n\n原文  ' },
    ] });
    expect(root.querySelectorAll('.message-original')).toHaveLength(0);
    expect(deepText(root)).not.toContain('查看完整原文');
    const input = root.querySelector('[data-conversation-key="goal"]');
    await input.querySelector('.conversation-copy').click(); expect(copied.pop()).toBe(source);
    const code = input.querySelectorAll('.code-copy'); expect(code).toHaveLength(2);
    await code[0].click(); expect(copied.pop()).toBe('  <script>bad()</script>\n\nconst a = `W313`;  ');
    await code[1].click(); expect(copied.pop()).toBe('第二段');
    const output = root.querySelector('.conversation-output');
    await output.querySelector('.conversation-copy').click(); expect(copied.pop()).toBe('**输出**\n\n```\necho 原文\n```');
    await output.querySelector('.code-copy').click(); expect(copied.pop()).toBe('echo 原文');
    await root.querySelector('[data-conversation-key="input:message:3"]').querySelector('.conversation-copy').click();
    expect(copied.pop()).toBe('  追加\n\n原文  ');
    input.revealReadingContent(); root.updateConversation({ ...task, goal: '新原文' });
    expect(root.querySelector('[data-conversation-key="goal"]')).toBe(input); expect(input.expanded).toBe(true);
    await input.querySelector('.conversation-copy').click(); expect(copied.pop()).toBe('新原文');
    dom.localStorage.setItem('lush.markdown', '0'); root.updateConversation({ ...task, goal: source });
    expect(root.querySelectorAll('.code-copy')).toHaveLength(0);
    await input.querySelector('.conversation-copy').click(); expect(copied.pop()).toBe(source);
  } finally { clear(); restore(); dom.restore(); }
});

test('decision and unknown content have no original fold, while the timeline shared renderer retains it', async () => {
  const dom = installDom(), copied = [], restore = clipboard(async text => copied.push(text)); ready();
  try {
    const answer = '```\n决策代码\n```';
    const root = renderConversation({ ...task, messages: [{ id: 5, body: '旧文本' }] }, { events: [
      { id: 4, type: 'notice.answered', data: { notice_id: 2, notice_kind: 'question', answer_source: 'user', answer } },
    ] });
    const decision = root.querySelector('[data-conversation-key="other:event:4"]');
    const details = decision.querySelector('.conversation-decision-details'); details.open = true;
    for (const listener of details.listeners.toggle) listener();
    await decision.querySelector('.code-copy').click(); expect(copied.pop()).toBe('决策代码');
    await decision.querySelector('.conversation-copy').click(); expect(copied.pop()).toBe(answer);
    await root.querySelector('[data-conversation-filter="unknown"]').click();
    await root.querySelector('[data-conversation-key="other:message:5"]').querySelector('.conversation-copy').click();
    expect(copied.pop()).toBe('旧文本'); expect(root.querySelectorAll('.message-original')).toHaveLength(0);
    expect(renderTaskMessageBody({ body: '通信' }).querySelector('.message-original')).not.toBeNull();
  } finally { clear(); restore(); dom.restore(); }
});

test('copy completes all record segments without changing the reading preview, and never copies failed or invalid reads', async () => {
  const calls = [], dom = installDom({ fetch: async url => {
    calls.push(String(url));
    const offset = Number(new URL(String(url), 'http://test').searchParams.get('offset'));
    return response({ offset, text: offset === 2 ? '中间' : '结尾', next_offset: offset + 2, has_more: offset === 2 });
  } }), copied = [], restore = clipboard(async text => copied.push(text)); ready();
  try {
    const root = renderConversation(task, { events: [partial] });
    const node = root.querySelector('[data-conversation-key="run:2"]'), copy = node.querySelector('.conversation-copy');
    await copy.click(); expect(copied).toEqual(['前缀中间结尾']); expect(calls).toHaveLength(2);
    expect(deepText(node)).not.toContain('中间'); expect(copy.disabled).toBe(false);
    copied.length = 0;
    globalThis.fetch = async () => response({ offset: 2, next_offset: 2, text: '', has_more: true });
    await copy.click(); expect(copied).toHaveLength(0); expect(dom.node('error').textContent).toContain('复制失败');
    globalThis.fetch = async () => response({ offset: 99, next_offset: 101, text: '错误', has_more: false });
    await copy.click(); expect(copied).toHaveLength(0);
    globalThis.fetch = async () => { throw new Error('读取断开'); };
    await copy.click(); expect(copied).toHaveLength(0); expect(dom.node('error').textContent).toContain('读取断开');
    globalThis.fetch = async () => response({ offset: 2, next_offset: 4 * 1024 * 1024 + 2, text: 'x'.repeat(4 * 1024 * 1024), has_more: false });
    await copy.click(); expect(copied).toHaveLength(0); expect(dom.node('error').textContent).toContain('预算');
  } finally { clear(); restore(); dom.restore(); }
});

test('cancellation and navigation discard delayed raw copy responses, and clipboard denial remains retryable', async () => {
  let resolve;
  const dom = installDom({ fetch: () => new Promise(done => { resolve = done; }) }); ready();
  const copied = [], restore = clipboard(async text => copied.push(text));
  try {
    const root = renderConversation(task, { events: [partial] });
    const copy = root.querySelector('[data-conversation-key="run:2"]').querySelector('.conversation-copy');
    let pending = copy.click(); expect(copy.disabled).toBe(true);
    const cancel = findByText(root, '取消复制');
    expect(root.querySelector('.conversation-search').querySelector('.conversation-cancel')).toBeNull();
    expect(cancel.hidden).toBe(false); expect(root.classList.contains('conversation-search-open')).toBe(false);
    await cancel.click();
    resolve(response({ offset: 2, next_offset: 4, text: '尾部', has_more: false })); await pending;
    expect(copied).toHaveLength(0); expect(copy.disabled).toBe(false);
    pending = copy.click(); ui.view = { id: 'other' };
    resolve(response({ offset: 2, next_offset: 4, text: '尾部', has_more: false })); await pending;
    expect(copied).toHaveLength(0);
    const loadedCopy = root.querySelector('[data-conversation-key="goal"]').querySelector('.conversation-copy');
    navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    await loadedCopy.click(); expect(dom.node('error').textContent).toContain('复制失败'); expect(loadedCopy.disabled).toBe(false);
    navigator.clipboard.writeText = async text => copied.push(text);
    await loadedCopy.click(); expect(copied).toEqual(['初始输入']);
  } finally { clear(); restore(); dom.restore(); }
});

test('a later copy action supersedes a pending raw read, including when the later action copies code', async () => {
  const dom = installDom(), copied = [], restore = clipboard(async text => copied.push(text));
  let resolve;
  try {
    const delayed = copyButton(() => new Promise(done => { resolve = done; }));
    const pending = delayed.click();
    await copyButton('后点的代码', { label: '复制代码' }).click();
    resolve('先点的长原文'); await pending;
    expect(copied).toEqual(['后点的代码']); expect(delayed.disabled).toBe(false);
  } finally { clear(); restore(); dom.restore(); }
});

test('non-secure clipboard fallback preserves focus, copies exact text and removes its temporary textarea even on failure', async () => {
  const dom = installDom(), restore = clipboard(null);
  try {
    const focus = document.createElement('button'); focus.focus();
    const create = document.createElement; let value;
    document.createElement = tag => { const node = create(tag); node.select = () => { value = node.value; node.focus(); }; return node; };
    document.execCommand = command => command === 'copy';
    expect(await copyText('  exact\n文本 ')).toBe(true); expect(value).toBe('  exact\n文本 ');
    expect(document.activeElement).toBe(focus); expect(document.body.querySelector('textarea')).toBeNull();
    document.execCommand = () => { throw new Error('blocked'); };
    expect(await copyText('失败')).toBe(false); expect(document.body.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(focus);
  } finally { restore(); dom.restore(); }
});
