import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';

const run = (id, result, ended_at = `2026-10-02T10:${String(id).padStart(2, '0')}:00Z`) => ({ id, result, ended_at });
const event = (id, result) => ({ id: id + 100, type: 'invocation.completed', created_at: run(id).ended_at, data: { run_id: id, result } });
const keys = root => root.querySelectorAll('.conversation-message').map(node => node.dataset.conversationKey);

test('results merge runs/events without dropping repeated text; latest reference migrates to the latest occurrence', () => {
  const dom = installDom();
  try {
    const task = { id: 7, result: '**latest**', runs: [run(1, 'same'), run(2, 'same'), run(3, '**latest**')] };
    const root = renderConversation(task, { events: [event(3, '**latest**')] });
    expect(keys(root)).toEqual(['run:3', 'run:2', 'run:1']);
    const first = root.querySelector('.conversation-message');
    expect(first.dataset.ref).toContain('result-7'); expect(first.dataset.ref).toContain('event-103');
    const body = first.querySelector('.conversation-prose');
    renderConversation(task, { events: [event(3, '**latest**')] }, root);
    expect(root.querySelector('.conversation-message')).toBe(first); expect(first.querySelector('.conversation-prose')).toBe(body);
    renderConversation({ ...task, runs: [...task.runs, run(4, '**latest**')] }, { events: [event(4, '**latest**')] }, root);
    expect(keys(root)).toEqual(['run:4', 'run:3', 'run:2', 'run:1']);
    expect(first.dataset.ref).toBe('event-103'); expect(root.querySelector('.conversation-message').dataset.ref).toContain('result-7');
    expect(renderConversation({ id: 1, runs: [run(1, 'retained after retry')] })).toBeTruthy();
    expect(renderConversation({ id: 1, runs: [] })).toBeNull();
  } finally { dom.restore(); }
});

test('input/output timeline sorts by real timestamps rather than IDs, and both orders reuse nodes', async () => {
  const dom = installDom();
  try {
    const task = { id: 7, goal: '目标', created_at: '2026-10-02T09:00:00Z', goal_input_delivery: { status: 'delivered', at: '2026-10-02T09:00:00Z' },
      result: '最新', runs: [run(90, '较早', '2026-10-02T09:10:00Z'), run(2, '最新', '2026-10-02T10:30:00Z')] };
    const history = { events: [{ id: 9, type: 'message', created_at: '2026-10-02T09:15:00Z',
      data: { sender: null, body: '补充' }, input_delivery: { status: 'delivered', at: '2026-10-02T10:00:00Z' } }] };
    const root = renderConversation(task, history);
    expect(keys(root)).toEqual(['run:2', 'input:9', 'run:90', 'goal']);
    const nodes = [...root.querySelector('.conversation-list').children];
    await findByText(root, '正序').onclick();
    expect(keys(root)).toEqual(['goal', 'run:90', 'input:9', 'run:2']);
    expect(root.querySelector('.conversation-list').children).toEqual([...nodes].reverse());
    expect(deepText(root)).not.toContain('2026-10-02 09:15');
  } finally { dom.restore(); }
});

test('pagination retains output text, references and cursor when task result changes or latest page refreshes', async () => {
  const dom = installDom({ fetch: async () => new Response(JSON.stringify({ events: [event(1, 'older')], cursor: 1, has_more: false })) });
  try {
    const task = { id: 7, result: 'latest', runs: [run(3, 'latest')] };
    const root = renderConversation(task, { events: [event(3, 'latest')], cursor: 50, has_more: true });
    await findByText(root, '加载更早对话').onclick();
    const older = root.querySelectorAll('.conversation-message').find(node => node.dataset.conversationKey === 'run:1');
    expect(older.dataset.ref).toBe('event-101');
    root.updateConversation({ ...task, result: 'new latest', runs: [run(4, 'new latest')] }, { events: [event(4, 'new latest')], cursor: 80, has_more: true });
    expect(keys(root)).toEqual(['run:4', 'run:3', 'run:1']);
    expect(root.querySelectorAll('.conversation-message')[2]).toBe(older);
    expect(findByText(root, '加载更早对话').hidden).toBe(true);
    expect(deepText(root)).toContain('older');
  } finally { dom.restore(); }
});

test('loading/unavailable are not empty history; latest result without completion evidence has unknown time', () => {
  const dom = installDom();
  try {
    const root = renderConversation({ id: 7, result: 'legacy', updated_at: '2026-10-02T12:00:00Z' }, { loading: true });
    expect(deepText(root)).toContain('历史加载中'); expect(deepText(root)).toContain('结果时间未知');
    root.updateConversation({ id: 7, result: 'legacy' }, { unavailable: true });
    expect(deepText(root)).toContain('历史不可用'); expect(deepText(root)).not.toContain('历史加载中');
    expect(renderConversation({ id: 9 }, { has_more: true, cursor: 5 })).toBeTruthy();
  } finally { dom.restore(); }
});
