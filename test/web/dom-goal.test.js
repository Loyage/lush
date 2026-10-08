import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { renderGoal } from '../../src/ui/web/assets/render-goal.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { absolute } from '../../src/ui/web/assets/format.js';

const at = '2026-10-02T09:00:00Z';
const task = { id: 7, role: 'agent', task_kind: 'order', status: 'waiting', goal: '**原始目标**',
  created_at: at, updated_at: at, result: '最新结果' };
const event = (id, body, sender = null) => ({ id, task_id: 7, type: 'message', created_at: at,
  input_delivery: { status: 'pending', at: null }, data: { sender, body } });
const expand = node => { node.open = true; for (const handler of node.listeners.toggle || []) handler(); };

test('任务目标保留原文；只展开一层即见追加全文，重复输入不合并，不含 Agent 或决策消息', () => {
  const dom = installDom();
  try {
    const history = { events: [event(1, '**补充**\n\n- 新要求'), event(2, '**补充**\n\n- 新要求'),
      event(3, 'Agent 消息', 8), { id: 4, type: 'notice.answered', data: { answer: '决策答复' } },
      { id: 5, type: 'task.signal', message: { sender_id: null, body: '系统信号' } }], cursor: 1 };
    renderDetail({ ...task, messages: [{ id: 90, sender_id: null, body: '仅属于收件箱的系统消息' }] }, history, null, null);
    const panel = dom.node('detail'), goal = panel.querySelector('.goal-panel');
    expect(deepText(goal)).toContain('原始目标'); expect(goal.querySelector('strong')).toBeTruthy();
    const fold = goal.querySelector('.goal-history'); expect(fold.open).not.toBe(true);
    expect(deepText(goal)).toContain('追加输入（已加载 2 条）');
    for (const text of ['Agent 消息', '决策答复', '系统信号', '仅属于收件箱']) expect(deepText(goal)).not.toContain(text);
    const entries = goal.querySelectorAll('.goal-history-entry'); expect(entries).toHaveLength(2);
    expect(entries.map(node => node.dataset.eventId)).toEqual(['1', '2']);
    expand(fold);
    expect(entries[0].tagName).toBe('DIV'); expect(entries[0].querySelector('summary')).toBeNull();
    expect(goal.querySelectorAll('details')).toHaveLength(1);
    expect(entries[0].querySelector('strong')).toBeTruthy(); expect(deepText(entries[0])).toContain('新要求');
    expect(entries[0].dataset.ref).toBeTruthy();
    expect([...panel.children].indexOf(goal)).toBeLessThan([...panel.children].indexOf(panel.querySelector('.result-panel')));
    renderDetail(task, { ...history, events: [...history.events, event(6, '新的输入')] }, null, null);
    expect(panel.querySelector('.goal-panel')).toBe(goal); expect(fold.open).toBe(true);
    expect(goal.querySelectorAll('.goal-history-entry')[0]).toBe(entries[0]); expect(deepText(entries[0])).toContain('新要求');
    expect(goal.querySelectorAll('.goal-history-entry').map(node => node.dataset.eventId)).toEqual(['1', '2', '6']);
    expect(deepText(goal)).toContain('新的输入');
  } finally { dom.restore(); }
});

test('可逐页加载更早输入，失败可重试，刷新不丢已加载历史与阅读状态', async () => {
  const requests = []; let fail = true;
  const dom = installDom({ fetch: async url => {
    requests.push(String(url));
    if (fail) return new Response(JSON.stringify({ error: 'offline' }), { status: 500 });
    if (String(url).includes('before=50')) return new Response(JSON.stringify({ events: [event(25, 'Agent 消息', 8)], cursor: 20, has_more: true }));
    return new Response(JSON.stringify({ events: [event(1, '<script>old</script>\n第二行'), event(2, '旧输入')], cursor: 1, has_more: false }));
  } });
  try {
    const history = { events: [event(100, '新输入')], cursor: 50, truncated: true };
    const goal = renderGoal(task, history);
    expect(requests).toHaveLength(0);
    expect(deepText(goal)).toContain('还有更早历史');
    await findByText(goal, '加载更早输入').onclick(); expect(deepText(goal)).toContain('offline');
    fail = false;
    await findByText(goal, '加载更早输入').onclick();
    expect(requests.filter(url => url.includes('before=50'))).toHaveLength(2);
    expect(deepText(goal)).toContain('还有更早历史');
    await findByText(goal, '加载更早输入').onclick();
    expect(requests.some(url => url.includes('before=20'))).toBe(true);
    const old = goal.querySelectorAll('.goal-history-entry').find(node => node.dataset.eventId === '1');
    expect(deepText(old)).toContain('<script>old</script>'); expect(old.querySelector('script')).toBeNull();
    expect(deepText(goal)).toContain('已读取全部追加输入历史');
    expect(renderGoal(task, history, goal)).toBe(goal);
    expect(goal.querySelectorAll('.goal-history-entry').map(node => node.dataset.eventId)).toEqual(['1', '2', '100']);
    expect(deepText(old)).toContain('第二行');
    expect(goal.goalCursor).toBe(1); expect(goal.goalHasMore).toBe(false);
    expect(findByText(goal, '加载更早输入').hidden).toBe(true);
  } finally { dom.restore(); }
});

test('无追加输入时隐藏折叠栏；纯文本偏好保留换行，未知来源不冒充用户输入', () => {
  const dom = installDom();
  try {
    expect(renderGoal(task).querySelector('.goal-history').hidden).toBe(true);
    expect(renderGoal({ id: 7, goal: '' })).toBeNull();
    localStorage.setItem('lush.markdown', '0');
    const goal = renderGoal(task, { events: [event(1, '**原文**\n第二行'),
      { ...event(2, '未知发送者'), data: { body: '未知发送者' } }] });
    const entry = goal.querySelector('.goal-history-entry');
    expect(entry.querySelector('strong')).toBeNull(); expect(deepText(entry)).toContain('**原文**\n第二行');
    expect(goal.querySelectorAll('.goal-history-entry')).toHaveLength(1);
  } finally { localStorage.removeItem('lush.markdown'); dom.restore(); }
});

test('输入时间使用实际投递证据；待输入与未知明确显示，刷新保持展开和正文节点', () => {
  const dom = installDom();
  try {
    const deliveredAt = '2026-10-03T10:30:00Z';
    const followup = event(1, '尚未投递'); followup.data.message_id = 40;
    const pendingTask = { ...task, goal_input_delivery: { status: 'pending', at: null } };
    const goal = renderGoal(pendingTask, { events: [followup] });
    const fold = goal.querySelector('.goal-history'); expand(fold);
    const entry = goal.querySelector('.goal-history-entry'), body = entry.querySelector('.goal-text');
    expect(deepText(entry)).toContain('待输入'); expect(deepText(entry)).not.toContain(absolute(at));
    expect(goal.querySelector('.goal-input-time').textContent).toBe('待输入');
    const delivery = { status: 'delivered', at: deliveredAt };
    expect(renderGoal({ ...task, goal_input_delivery: delivery },
      { events: [{ id: 100, type: 'invocation.inputs_delivered',
        input_deliveries: [{ message_id: 40, ...delivery }] }] }, goal)).toBe(goal);
    expect(fold.open).toBe(true); expect(entry.querySelector('.goal-text')).toBe(body);
    expect(deepText(entry)).toContain(`输入时间：${absolute(deliveredAt)}`);
    expect(goal.querySelector('.goal-input-time').textContent).toBe(`输入时间：${absolute(deliveredAt)}`);
    expect(deepText(entry)).not.toContain(absolute(at));
    goal.updateGoalHistory({ events: [{ ...followup, input_delivery: { status: 'unknown', at: null } }] });
    expect(deepText(entry)).toContain('输入时间未知');
    expect(deepText(renderGoal(task))).toContain('输入时间未知');
  } finally { dom.restore(); }
});
