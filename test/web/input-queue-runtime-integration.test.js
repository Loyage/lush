import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git, gate, until } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { installDom, deepText } from '../dom-stub.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { appendInputAcknowledgement } from '../../src/ui/web/assets/worker-input.js';
setDefaultTimeout(20000);

const get = async (f, route) => (await fetch(f.url + route)).json();
async function post(f, method, params, status = 200) {
  const response = await fetch(f.url + '/api/action', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: f.url }, body: JSON.stringify({ method, params }) });
  const result = await response.json(); expect(response.status).toBe(status); return result;
}

// Exercise real SQLite/Git → Project → RPC → HTTP → detail/composer semantics.
// The controlled provider does not start a model or touch the user's daemon.
test('HTTP frozen append is persisted, rendered and delivered only after the fixed landing, before automatic acceptance', async () => {
  const f = await setup(); f.project.stopping = true;
  const prepared = gate(), landing = gate(), received = gate(), returned = gate();
  const calls = []; let dom;
  try {
    await repo(f.root);
    const { task } = await post(f, 'order.submit', { content: 'frozen HTTP append', start: false });
    fs.writeFileSync(path.join(task.workspace, 'first.txt'), 'fixed first delivery');
    await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'first delivery');
    await f.project.workspaces.finish(f.store.task(task.id));
    f.store.update(task.id, { status: 'waiting', result: 'first result' });
    const hooks = await get(f, `/api/worker/${task.id}/hooks`);
    await post(f, 'worker.completion', { id: task.id, level: 'archive', expected_revision: hooks.revision });
    const prepare = f.project.workspaces.prepareTaskSquashUnsafe.bind(f.project.workspaces);
    f.project.workspaces.prepareTaskSquashUnsafe = async (...args) => {
      const receipt = await prepare(...args); prepared.resolve(); await landing.promise; return receipt;
    };
    f.project.provider = { resolve() { return { agent: 'mock' }; }, async run({ messages }) {
      calls.push(messages.map(message => message.body)); received.resolve(); await returned.promise; return 'followup handled';
    } };
    f.project.stopping = false; f.project.scheduleTaskMerge(task.parent_id);
    await prepared.promise;
    const before = f.store.task(task.id).reservation;
    expect(JSON.parse(before).status).toBe('executing');
    const first = await post(f, 'worker.message', { id: task.id, body: 'first additional requirement' });
    const second = await post(f, 'worker.message', { id: task.id, body: 'second additional requirement' });
    expect(first.input_queue.buffered).toBe(1); expect(second.input_queue.buffered).toBe(2);
    expect(f.store.task(task.id).reservation).toBe(before); expect(calls).toHaveLength(0);
    expect(JSON.stringify(second)).not.toContain('"authorization"');
    const inspected = await get(f, `/api/worker/${task.id}`);
    const graph = await get(f, '/api/worker-graph?details=0');
    expect(inspected.input_queue).toEqual(second.input_queue);
    expect(graph.nodes.find(node => node.id === task.id).input_queue).toEqual(second.input_queue);
    const history = await get(f, `/api/worker/${task.id}/history`);
    const messages = history.filter(event => event.type === 'message');
    expect(messages).toHaveLength(2);
    expect(messages.every(event => event.input_delivery.status === 'pending' && event.input_delivery.at === null)).toBe(true);
    expect(appendInputAcknowledgement(inspected, second)).toContain('等待投递');
    dom = installDom({ fetch: (url, options) => fetch(f.url + url, options) });
    resetUiState(); ui.view = { id: 'task', task: task.id }; ui.selected = task.id;
    renderDetail(inspected, [], history);
    expect(deepText(dom.node('detail'))).toContain('已暂存 2 条追加输入');
    const append = [...dom.node('detail').querySelectorAll('button')].find(button => button.textContent === '向该 Worker 追加输入');
    expect(append.disabled).toBe(false); // Selecting append mode itself does not call an Agent.
    await append.click();
    expect(dom.node('input').disabled).toBe(false); expect(dom.node('input').placeholder).toContain('等待投递');
    resetUiState(); dom.restore(); dom = null;
    landing.resolve(); await received.promise;
    expect(calls).toEqual([['first additional requirement', 'second additional requirement']]);
    expect(await git(f.root, 'show', 'main:first.txt')).toBe('fixed first delivery');
    expect(f.store.history(task.id).some(event => event.type === 'task.accepted')).toBe(false);
    expect(f.store.branch(task.branch).status).toBe('active');
    const delivered = await get(f, `/api/worker/${task.id}/history`);
    expect(delivered.filter(event => event.type === 'message').every(event => event.input_delivery.status === 'delivered')).toBe(true);
    expect((await get(f, `/api/worker/${task.id}`)).input_queue).toEqual({ buffered: 0, reason: null });
    returned.resolve();
    await until(() => f.store.branch(task.branch).status === 'archived', 12000);
    expect(f.store.unread(task.id)).toHaveLength(0);
    expect(f.store.history(task.id).filter(event => event.type === 'task.merge_integrated')).toHaveLength(1);
    expect(f.store.history(task.id).some(event => event.type === 'completion.execution_failed')).toBe(false);
  } finally { landing.resolve(); returned.resolve(); resetUiState(); dom?.restore(); await f.close(); }
});

test('HTTP buffering does not relax owner, terminal or archived admission and reads never release a held message', async () => {
  const f = await setup(); f.project.stopping = true;
  try {
    await repo(f.root);
    const { task } = await post(f, 'order.submit', { content: 'blocked HTTP append', start: false });
    f.store.update(task.id, { status: 'waiting', reservation: JSON.stringify({ version: 2, kind: 'merge',
      queue_protocol: 1, status: 'blocked', parent_id: task.parent_id, commit: task.base_commit }) });
    const result = await post(f, 'worker.message', { id: task.id, body: 'preserve while landing is unknown' });
    expect(result.input_queue.buffered).toBe(1);
    for (let i = 0; i < 3; i++) {
      expect((await get(f, `/api/worker/${task.id}`)).input_queue.buffered).toBe(1);
      expect((await get(f, '/api/worker-graph?details=0')).nodes.find(node => node.id === task.id).input_queue.buffered).toBe(1);
    }
    expect(f.store.unread(task.id)[0].delivery_hold).toBe('frozen');
    expect(f.store.unreadPage(task.id).messages).toHaveLength(0);
    expect((await post(f, 'worker.message', { id: task.parent_id, body: 'not an owner inbox' }, 400)).error).toContain('branch owner');
    f.store.update(task.id, { status: 'completed', reservation: null });
    expect((await post(f, 'worker.message', { id: task.id, body: 'not silently reopened' }, 400)).error).toContain('ended');
    f.store.update(task.id, { status: 'waiting' });
    f.store.run("UPDATE branches SET status='archived' WHERE branch=?", task.branch);
    expect((await post(f, 'worker.message', { id: task.id, body: 'not silently recreated' }, 400)).error).toContain('archived');
    expect(f.store.unread(task.id)).toHaveLength(1);
    expect(f.project.releaseTaskInputs(task.id)).toBe(false);
  } finally { await f.close(); }
});
