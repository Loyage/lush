import { test, expect } from 'bun:test';
import { installDom, findByText } from '../dom-stub.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

const at = n => `2026-10-12T08:${String(n).padStart(2, '0')}:00Z`;
const keys = root => root.querySelectorAll('.conversation-message').map(node => node.dataset.conversationKey);

test('input/output reader uses category toggles without duplicate shortcuts and preserves reading state on refresh', async () => {
  const dom = installDom(); resetUiState(); ui.hostSession = { status: 'ready', username: '测试用户' };
  try {
    const task = { id: 7, worker_number: 'W232', input_id: 232, goal: '原始输入', created_at: at(0),
      result: '本轮结果', runs: [{ id: 3, result: '本轮结果', ended_at: at(3) }],
      messages: [{ id: 20, task_id: 7, sender_id: null, body: '追加输入', append_number: 'A232-1' }] };
    const events = [{ id: 2, type: 'message', task_id: 7, created_at: at(2), data: { sender: null, message_id: 20, body: '追加输入' } },
      { id: 3, type: 'invocation.completed', task_id: 7, created_at: at(3), data: { run_id: 3, result: '本轮结果' } }];
    const root = renderConversation(task, { events });
    expect(root.querySelector('h2').textContent).toBe('输入输出');
    expect(keys(root)).toEqual(['run:3', 'input:2', 'goal']);
    const search = root.querySelector('.conversation-search'), searchToggle = root.querySelector('.conversation-search-toggle'), keyword = search.querySelector('input');
    expect(searchToggle.getAttribute('aria-expanded')).toBe('false'); expect(searchToggle.getAttribute('aria-controls')).toBe(search.id);
    await searchToggle.click(); keyword.value = '本轮';
    expect(root.classList.contains('conversation-search-open')).toBe(true);
    await searchToggle.click(); root.updateConversation(task, { events });
    expect(searchToggle.getAttribute('aria-expanded')).toBe('false'); expect(keyword.value).toBe('本轮');
    expect(root.querySelector('.conversation-search')).toBe(search); expect(keys(root)).toEqual(['run:3', 'input:2', 'goal']);
    await searchToggle.click(); await search.querySelector('.search-field-submit').click();
    expect(keys(root)).toEqual(['run:3']); expect(searchToggle.textContent).toBe('搜索 · 已筛选');
    await searchToggle.click(); root.updateConversation(task, { events });
    expect(searchToggle.textContent).toBe('搜索 · 已筛选'); expect(keys(root)).toEqual(['run:3']);
    await searchToggle.click(); await search.querySelector('.search-field-clear').click(); await searchToggle.click();
    expect(searchToggle.textContent).toBe('搜索'); expect(keys(root)).toEqual(['run:3', 'input:2', 'goal']);
    await findByText(root, '正序').onclick(); expect(keys(root)).toEqual(['goal', 'input:2', 'run:3']);
    const reply = root.querySelector('[data-conversation-key="run:3"]'); reply.revealReadingContent();
    expect(root.querySelector('.conversation-filters').querySelectorAll('button')).toHaveLength(4);
    for (const text of ['只看 Agent 回复', '只看我的输入', '恢复默认内容']) expect(findByText(root, text)).toBeNull();
    const toggle = category => root.querySelector(`[data-conversation-filter="${category}"]`).onclick();
    await toggle('input'); await toggle('decision'); expect(keys(root)).toEqual(['run:3']);
    root.updateConversation(task, { events });
    expect(root.querySelector('[data-conversation-key="run:3"]')).toBe(reply); expect(reply.expanded).toBe(true);
    expect(root.querySelector('[data-conversation-filter="input"]').getAttribute('aria-pressed')).toBe('false');
    await toggle('input'); await toggle('output'); expect(keys(root)).toEqual(['goal', 'input:2']);
    await toggle('output'); await toggle('decision'); expect(keys(root)).toEqual(['goal', 'input:2', 'run:3']);
  } finally { resetUiState(); dom.restore(); }
});
