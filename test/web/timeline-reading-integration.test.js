import { test, expect } from 'bun:test';
import { setup, fetch as httpFetch } from './harness.js';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';
import { projectHistoryEvent } from '../../src/persistence/store/reading.js';

test('automation operation status survives real history and reading projections without hidden failures or completion claims on submission', async () => {
  const f = await setup();
  const task = f.store.create({ role: 'agent', task_kind: 'order', goal: 'automation timeline integration' });
  const submitted = f.store.event(task.id, 'automation.operation_submitted', { tool: 'request_merge', worker_id: task.id, round: 0 });
  const failed = f.store.event(task.id, 'automation.operation_finished', { tool: 'request_merge', operation_id: submitted, status: 'failed', hooks: { private: 'PRIVATE-CONFIG' } });
  const target = f.store.event(task.id, 'delivery.requested', { tool: 'integrate_deliveries', delivery_id: submitted, strategy: 'serial' });
  const before = f.store.all('SELECT * FROM events');
  const dom = installDom(); resetUiState();
  try {
    const response = await httpFetch(`${f.url}/api/worker/${task.id}/reading-page?before_message=0`);
    expect(response.status).toBe(200); const page = await response.json();
    expect(JSON.stringify(page)).not.toContain('PRIVATE-CONFIG');
    for (const events of [f.store.history(task.id), page.events]) {
      const root = renderConversation(task, { events });
      expect(root.querySelector(`[data-conversation-key="history:${submitted}"]`).entry.kind).toBe('自动化操作请求已提交');
      const failure = root.querySelector(`[data-conversation-key="history:${failed}"]`);
      expect(failure.dataset.timelineCategory).toBe('failure'); expect(failure.entry.metadata.status).toBe('failed');
      expect(deepText(failure)).toContain('不自动重放');
      expect(root.querySelector(`[data-conversation-key="history:${target}"]`).entry.kind).toContain('未新增授权');
    }
    expect(f.store.all('SELECT * FROM events')).toEqual(before); expect(f.project.running.size).toBe(0);
  } finally { resetUiState(); dom.restore(); await f.close(); }
});

// Real Host -> RPC -> Store -> DOM. First-screen adapter uses the same projection exported for historyPage.
test('real timeline reads generic long error, full-history metadata/type hits and arbitrary references without external timeline', async () => {
  const f = await setup(), calls = [];
  const task = f.store.create({ role: 'agent', task_kind: 'order', goal: 'timeline integration' });
  const errorId = f.store.event(task.id, 'merge.failed', { error: 'x'.repeat(23980) + '😀\nErrorTailNeedle',
    retry_profile: { secret: 'SecretNeedle' }, nested: { hooks: { secret: 'HiddenHookNeedle' }, commit: 'SafeMetadataNeedle' } });
  const detailId = f.store.event(task.id, 'workspace.created', { branch: 'old-branch' });
  for (let i = 0; i < 111; i++) f.store.event(task.id, 'progress.completed', { key: String(i) });
  const dom = installDom({ fetch: (url, options) => { calls.push(String(url)); return httpFetch(new URL(String(url), f.url).href, options); } });
  resetUiState(); ui.hostSession = { status: 'ready', username: '测试用户' };
  try {
    const initial = projectHistoryEvent(f.store, task.id, errorId), root = renderConversation(task, { events: [initial], truncated: true });
    expect(calls).toHaveLength(0);
    const failure = root.querySelector(`[data-conversation-key="history:${errorId}"]`);
    expect(failure).toBeTruthy(); expect(deepText(failure)).toContain('正文尚未读完');
    expect(deepText(failure)).not.toContain('SecretNeedle'); expect(deepText(failure)).not.toContain('HiddenHookNeedle');
    await findByText(failure, '继续读取正文').onclick();
    expect(calls.at(-1)).toContain(`/reading-record?kind=event&record_id=${errorId}&offset=24000`);
    const original = failure.querySelector('.message-original'); original.open = true;
    for (const listener of original.listeners.toggle || []) listener();
    expect(original.querySelector('pre').textContent).toContain('ErrorTailNeedle');
    expect(original.querySelector('pre').textContent).not.toContain('SecretNeedle');
    root.updateConversation(task, { events: [initial] });
    expect(root.querySelector(`[data-conversation-key="history:${errorId}"]`)).toBe(failure);
    expect(failure.querySelector('.conversation-read-more')).toBeNull(); expect(failure.expanded).toBe(true);
    const submit = value => { const input = root.querySelector('.conversation-search').querySelector('input'); input.value = value; input.listeners.keydown[0]({ key: 'Enter', preventDefault() {} }); };
    submit('SafeMetadataNeedle'); await findByText(root, '查找全部历史').onclick();
    expect(deepText(root)).toContain('查找完成'); expect(deepText(root)).toContain('已扫描 114 个事件');
    expect(root.querySelectorAll('.conversation-event')).toHaveLength(1); expect(failure.querySelector('.conversation-read-more')).toBeNull();
    submit('merge.failed'); await findByText(root, '查找全部历史').onclick();
    expect(root.querySelectorAll('.conversation-event')).toHaveLength(1);
    submit('SecretNeedle'); await findByText(root, '查找全部历史').onclick();
    expect(root.querySelectorAll('.conversation-event')).toHaveLength(0); expect(deepText(root)).toContain('历史正文无命中');
    root.attachReferencedHistoryEvent = () => { throw new Error('external timeline no longer needed'); };
    const detail = await root.revealConversationReference({ kind: 'history_event', target: { task_id: task.id, event_id: detailId } });
    expect(detail.dataset.ref).toContain(`event-${detailId}`); expect(detail.expanded).toBe(true);
    expect(root.querySelector('[data-conversation-filter="detail"]').getAttribute('aria-pressed')).toBe('true');
    expect(calls.at(-1)).toContain(`before_event=${detailId + 1}`); expect(calls.at(-1)).toContain('before_message=0'); expect(calls.at(-1)).toContain('limit=1');
    expect(f.project.running.size).toBe(0);
  } finally { resetUiState(); dom.restore(); await f.close(); }
});
