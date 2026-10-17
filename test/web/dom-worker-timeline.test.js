import { test, expect } from 'bun:test';
import { installDom, findByText } from '../dom-stub.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

const at = n => `2026-10-12T08:${String(n).padStart(2, '0')}:00Z`;
const keys = root => root.querySelectorAll('.conversation-message').map(node => node.dataset.conversationKey);

test('input/output reader changes order and quick filters while preserving an expanded reply on refresh', async () => {
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
    await findByText(root, '正序').onclick(); expect(keys(root)).toEqual(['goal', 'input:2', 'run:3']);
    const reply = root.querySelector('[data-conversation-key="run:3"]'); reply.revealReadingContent();
    await findByText(root, '只看 Agent 回复').onclick(); expect(keys(root)).toEqual(['run:3']);
    root.updateConversation(task, { events });
    expect(root.querySelector('[data-conversation-key="run:3"]')).toBe(reply); expect(reply.expanded).toBe(true);
    await findByText(root, '只看我的输入').onclick(); expect(keys(root)).toEqual(['goal', 'input:2']);
  } finally { resetUiState(); dom.restore(); }
});
