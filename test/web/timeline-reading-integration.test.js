import { test, expect } from 'bun:test';
import { setup, fetch as httpFetch } from './harness.js';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';
import { projectHistoryEvent } from '../../src/persistence/store/reading.js';

test('real history and reading projections retain all automation facts for the timeline, but input/output never claims their references', async () => {
  const f = await setup(), calls = [];
  const task = f.store.create({ role: 'agent', task_kind: 'order', goal: 'automation boundary integration' });
  const submitted = f.store.event(task.id, 'automation.operation_submitted', { tool: 'request_merge', worker_id: task.id, round: 0 });
  const failed = f.store.event(task.id, 'automation.operation_finished', { tool: 'request_merge', operation_id: submitted, status: 'failed', hooks: { private: 'PRIVATE-CONFIG' } });
  const target = f.store.event(task.id, 'delivery.requested', { tool: 'integrate_deliveries', delivery_id: submitted, strategy: 'serial' });
  const before = f.store.all('SELECT * FROM events');
  const dom = installDom({ fetch: (url, options) => { calls.push(String(url)); return httpFetch(new URL(String(url), f.url).href, options); } }); resetUiState(); ui.hostSession = { status: 'ready', username: '测试用户' };
  try {
    const response = await httpFetch(`${f.url}/api/worker/${task.id}/reading-page?before_message=0`);
    expect(response.status).toBe(200); const page = await response.json();
    expect(JSON.stringify(page)).not.toContain('PRIVATE-CONFIG');
    expect(page.events.find(event => event.id === failed).data.status).toBe('failed');
    expect(page.events.find(event => event.id === submitted).data.tool).toBe('request_merge');
    expect(page.events.find(event => event.id === target).data.strategy).toBe('serial');
    for (const events of [f.store.history(task.id), page.events]) {
      const root = renderConversation(task, { events });
      expect(root.querySelectorAll('.conversation-message')).toHaveLength(1); expect(root.querySelector('.conversation-event')).toBeNull();
      for (const category of ['delivery', 'failure', 'lifecycle']) expect(root.querySelector(`[data-conversation-filter="${category}"]`)).toBeNull();
      for (const id of [submitted, failed, target]) expect(await root.revealConversationReference({ kind: 'history_event', target: { task_id: task.id, event_id: id } })).toBeNull();
      root.updateConversation(task, { events }); expect(root.querySelectorAll('.conversation-message')).toHaveLength(1);
    }
    expect(calls).toHaveLength(0); expect(f.store.all('SELECT * FROM events')).toEqual(before); expect(f.project.running.size).toBe(0);
  } finally { resetUiState(); dom.restore(); await f.close(); }
});

test('long safe event originals and metadata/type searches remain available to timeline read API, never leaked through content search', async () => {
  const f = await setup(), calls = [];
  const task = f.store.create({ role: 'agent', task_kind: 'order', goal: 'content boundary integration' });
  const errorId = f.store.event(task.id, 'merge.failed', { error: 'x'.repeat(23980) + '😀\nErrorTailNeedle',
    retry_profile: { secret: 'SecretNeedle' }, nested: { hooks: { secret: 'HiddenHookNeedle' }, commit: 'SafeMetadataNeedle' } });
  const detailId = f.store.event(task.id, 'workspace.created', { branch: 'old-branch' });
  for (let i = 0; i < 111; i++) f.store.event(task.id, 'progress.completed', { key: String(i) });
  const dom = installDom({ fetch: (url, options) => { calls.push(String(url)); return httpFetch(new URL(String(url), f.url).href, options); } });
  resetUiState(); ui.hostSession = { status: 'ready', username: '测试用户' };
  const get = path => httpFetch(`${f.url}/api/worker/${task.id}/${path}`).then(response => response.json());
  try {
    const initial = projectHistoryEvent(f.store, task.id, errorId), root = renderConversation(task, { events: [initial], truncated: true });
    expect(initial.text_truncated).toBe(true); expect(calls).toHaveLength(0); expect(root.querySelector('.conversation-event')).toBeNull();
    const first = await get(`reading-record?kind=event&record_id=${errorId}&offset=0`);
    const tail = await get(`reading-record?kind=event&record_id=${errorId}&offset=${first.next_offset}`);
    expect(first.text + tail.text).toContain('ErrorTailNeedle'); expect(tail.has_more).toBe(false);
    for (const text of ['SecretNeedle', 'HiddenHookNeedle']) expect(first.text + tail.text).not.toContain(text);
    for (const query of ['SafeMetadataNeedle', 'merge.failed', 'ErrorTailNeedle']) {
      let cursor = null, scanned = 0, found = [];
      do {
        const page = await get(`reading-page?before_message=0&query=${query}${cursor == null ? '' : `&before_event=${cursor}`}`);
        scanned += page.scanned_events; found.push(...page.events); cursor = page.has_more_events ? page.event_cursor : 0;
      } while (cursor !== 0);
      expect(scanned).toBe(f.store.get('SELECT count(*) AS n FROM events WHERE task_id=?', task.id).n); expect(found.map(event => event.id)).toEqual([errorId]);
      const input = root.querySelector('.conversation-search').querySelector('input'); input.value = query; input.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
      await findByText(root, '查找全部历史').onclick(); expect(root.querySelectorAll('.conversation-message')).toHaveLength(0);
      expect(deepText(root)).toContain('输入输出历史正文无命中'); expect(deepText(root)).toContain(`已扫描 ${scanned} 个事件`);
    }
    const secretPage = await get('reading-page?query=SecretNeedle&before_message=0'); expect(secretPage.events).toEqual([]);
    const detail = await root.revealConversationReference({ kind: 'history_event', target: { task_id: task.id, event_id: detailId } });
    expect(detail).toBeNull(); expect(calls.at(-1)).toContain(`before_event=${detailId + 1}`); expect(calls.at(-1)).toContain('limit=1');
    const exact = await get(`reading-page?before_event=${detailId + 1}&before_message=0&limit=1`);
    expect(exact.events[0].id).toBe(detailId); expect(exact.events[0].data.branch).toBe('old-branch');
    expect(deepText(root)).not.toContain('SafeMetadataNeedle'); expect(f.project.running.size).toBe(0);
  } finally { resetUiState(); dom.restore(); await f.close(); }
});
