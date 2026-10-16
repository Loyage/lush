import { test, expect } from 'bun:test';
import { fixture, repo, until, gate } from '../helpers.js';
import { RPCServer } from '../../src/rpc/server.js';
import { RPCClient } from '../../src/rpc/client.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
import { startTestWeb, fetch as httpFetch } from './auth-fixture.js';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

// Real registered RPC/HTTP, Project scheduling and SQLite evidence feed the actual two-module detail.
// The controllable Provider does not call a model; all services and Git workspaces are temporary.
test('real invocation → questionnaire wait → user answer → continuation renders phase/time/source and precise reader links', async () => {
  const calls = [], provider = { run(ctx) { const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('parked'), { once: true }); return done.promise; } };
  const f = fixture(provider); await repo(f.root);
  const server = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await server.start();
  const client = new RPCClient(f.config.socket), web = startTestWeb(f.config, 0), base = `http://127.0.0.1:${web.port}`;
  const get = async route => { const response = await httpFetch(base + route); expect(response.status).toBe(200); return response.json(); };
  let dom;
  try {
    const task = (await client.request('order.submit', { content: '请确认后继续执行', start: false })).task;
    await client.request('worker.resume', { id: task.id });
    await until(() => calls.length === 1);
    const notice = await client.request('notice.post', { _token: calls[0].token, title: '确认范围', questions: [{ header: '范围', question: '继续吗？',
      options: [{ label: '继续', description: '执行' }, { label: '暂停', description: '等待' }] }] });
    await until(() => !f.project.running.has(task.id));
    const waiting = await get(`/api/worker/${task.id}`), waitingHistory = await get(`/api/worker/${task.id}/history-page`);
    const reads = [];
    dom = installDom({ fetch: (url, options) => { reads.push(String(url)); return httpFetch(base + url, options); } });
    resetUiState(); ui.view = { id: 'task', key: `task-${task.id}` }; ui.hostSession = { status: 'ready', username: '测试用户' };
    renderDetail(waiting, waitingHistory, null, null);
    const panel = dom.node('detail'), timeline = panel.querySelector('.worker-timeline-panel'), inputOutput = panel.querySelector('.conversation-panel');
    expect(inputOutput.querySelector('h2').textContent).toBe('输入输出'); expect(timeline.querySelector('h2').textContent).toBe('时间线');
    expect(deepText(timeline.querySelector('.lifecycle-current'))).toContain('等待决定');
    expect(deepText(timeline)).toContain('暂停等待决定（非失败）'); expect(reads).toHaveLength(0);
    const response = await httpFetch(`${base}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ method: 'notice.answer', params: { id: notice.id, answer: { answers: [{ selected: [0] }] } } }) });
    expect(response.status).toBe(200); await until(() => calls.length === 2);
    calls[1].done.resolve('已按答复继续执行'); await until(() => !f.project.running.has(task.id));
    const updated = await get(`/api/worker/${task.id}`), history = await get(`/api/worker/${task.id}/history-page`);
    renderDetail(updated, history, null, null);
    expect(panel.querySelector('.worker-timeline-panel')).toBe(timeline); expect(panel.querySelector('.conversation-panel')).toBe(inputOutput);
    const runId = updated.runs.at(-1).id, row = timeline.querySelector(`[data-lifecycle-key="call:${runId}"]`);
    expect(deepText(row)).toContain(`你答复 D${notice.id}`); expect(deepText(row)).toContain('不代表唯一触发者');
    const waitRow = timeline.querySelectorAll('.lifecycle-phase').find(node => deepText(node).includes(`D${notice.id}`));
    expect(waitRow).toBeTruthy(); expect(deepText(waitRow)).not.toContain('结束边界未知');
    await findByText(row, `你答复 D${notice.id}`).onclick();
    const evidenceId = history.events.find(event => event.type === 'notice.answered').id;
    expect(timeline.querySelector('.lifecycle-advanced').open).toBe(true);
    expect(timeline.querySelector(`[data-lifecycle-record="event:${evidenceId}"]`).expanded).toBe(true);
    await findByText(inputOutput, '只看我的输入').onclick();
    expect(inputOutput.querySelectorAll('.conversation-output')).toHaveLength(0);
    await findByText(row, '查看对应输入输出').onclick();
    expect(inputOutput.querySelector(`[data-conversation-key="run:${runId}"]`)).toBeTruthy();
    expect(deepText(inputOutput)).toContain('已按答复继续执行');
    expect(inputOutput.querySelector('[data-conversation-filter="lifecycle"]')).toBeNull();
    expect(f.project.running.size).toBe(0); expect(calls).toHaveLength(2);
    expect(reads.filter(url => url.includes('reading-page'))).toHaveLength(0);
  } finally { resetUiState(); dom?.restore(); web.stop(true); await server.close(); await f.close(); }
});
