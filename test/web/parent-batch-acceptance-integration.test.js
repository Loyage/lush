import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { installDom } from '../dom-stub.js';
import { iterationControls } from '../../src/ui/web/assets/render-iteration.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { resetUiState } from '../../src/ui/web/assets/state.js';

setDefaultTimeout(30000);
const get = async (f, route) => (await fetch(f.url + route)).json();
async function post(f, method, params, status = 200) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.url },
    body: JSON.stringify({ method, params }) });
  expect(response.status).toBe(status); return response.json();
}
async function delivered(f, row, status = 'awaiting_acceptance') {
  await f.project.workspaces.finish(f.store.task(row.id));
  f.store.update(row.id, { status, reservation: null, result: `retained-${row.id}` });
}
async function tree(f) {
  await repo(f.root);
  const { task: parent } = await post(f, 'order.submit', { content: 'retain delegated workers', start: false });
  f.store.update(parent.id, { status: 'waiting' });
  const child = await f.project.spawn(parent.id, 'child answer');
  f.store.update(child.id, { status: 'waiting' });
  const grandchild = await f.project.spawn(child.id, 'nested answer');
  await delivered(f, grandchild); await delivered(f, child); await delivered(f, parent, 'waiting');
  return [parent, child, grandchild];
}
const button = root => root.querySelectorAll('button').find(node => node.textContent === '验收');

for (const obstacle of [null, 'unread child input', 'independent order']) {
  test(`real HTTP/UI parent acceptance safely handles a multilevel delegated tree (${obstacle ?? 'success'})`, async () => {
    const f = await setup(); f.project.stopping = true; let dom, restore;
    try {
      const rows = await tree(f), [parent, child, grandchild] = rows;
      for (const row of rows) {
        const file = path.join(f.config.home, 'sessions', `task-${row.id}-retained.txt`);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `session-${row.id}`);
      }
      let message;
      if (obstacle === 'unread child input') message = f.store.message(grandchild.id, 'a new requirement');
      if (obstacle === 'independent order') {
        const { task } = await post(f, 'order.submit', { content: 'independent user goal', branch: parent.branch, start: false });
        await delivered(f, task);
      }
      const before = await get(f, `/api/worker/${parent.id}`), requests = [];
      expect(before.children.find(row => row.id === child.id)).toMatchObject({ task_kind: 'child', status: 'awaiting_acceptance' });
      dom = installDom({ fetch: (url, options) => {
        if (options?.body) requests.push(JSON.parse(options.body));
        return fetch(f.url + url, options);
      } });
      resetUiState(); restore = registerNavigation({ refresh: async () => {}, detail: async () => {} });
      activateDetailView({ view: 'task', key: `task-${parent.id}` });
      const controls = iterationControls(before), accept = button(controls);
      dom.node('detail').append(controls);
      expect(accept.classList.contains('agent-call')).toBe(false);
      expect(accept.getAttribute('data-help')).toContain('一并安全验收已交付的派生 child');
      if (obstacle === 'independent order') {
        expect(accept.disabled).toBe(true); expect(requests).toHaveLength(0);
        expect((await post(f, 'worker.accept', { id: parent.id }, 400)).error).toContain('descendants');
      } else {
        expect(accept.disabled).toBe(false); await accept.onclick();
        if (message) {
          expect(dom.node('error').textContent).toContain('unread input');
          for (const row of rows) {
            expect(fs.existsSync(row.workspace)).toBe(true);
            expect(f.store.history(row.id).some(event => event.type === 'task.accepted')).toBe(false);
          }
          // Model the next invocation processing the input; no deletion is authorized until then.
          f.store.run('UPDATE messages SET consumed=1 WHERE id=?', message);
          await accept.onclick();
        }
        await accept.onclick();
        expect(requests).toEqual(Array.from({ length: message ? 2 : 1 }, () => ({ method: 'worker.accept', params: { id: parent.id } })));
        const rootHistory = await get(f, `/api/worker/${parent.id}/history`);
        const execution = rootHistory.find(event => event.type === 'task.accepted').data.acceptance_execution;
        for (const row of rows) {
          expect(await get(f, `/api/worker/${row.id}`)).toMatchObject({ status: 'completed', workspace: null, accepted: true, result: `retained-${row.id}` });
          expect(fs.existsSync(row.workspace)).toBe(false);
          expect(await git(f.root, 'show-ref', '--verify', `refs/heads/${row.branch}`).catch(() => null)).toBeNull();
          expect(fs.readFileSync(path.join(f.config.home, 'sessions', `task-${row.id}-retained.txt`), 'utf8')).toBe(`session-${row.id}`);
          const accepted = (await get(f, `/api/worker/${row.id}/history`)).filter(event => event.type === 'task.accepted');
          expect(accepted).toHaveLength(1);
          expect(accepted[0].data).toMatchObject({ accepted_by: 'user', acceptance_execution: execution, resources_reclaimed: true });
          if (row.id !== parent.id) expect(accepted[0].data).toMatchObject({ via: 'parent_acceptance', acceptance_root_id: parent.id, delegator_id: row.parent_id });
        }
        expect(f.store.get('SELECT consumed FROM messages WHERE id=?', message ?? -1)?.consumed ?? 1).toBe(1);
      }
    } finally { restore?.(); resetUiState(); dom?.restore(); await f.close(); }
  });
}

test('numbered HTTP child appends survive batch rejection and partial recovery never consumes a new append number', async () => {
  const f = await setup(); f.project.stopping = true;
  try {
    const [parent, child, grandchild] = await tree(f);
    await post(f, 'worker.message', { id: grandchild.id, body: 'retain this numbered revision' });
    const saved = f.store.unread(grandchild.id).find(row => row.body === 'retain this numbered revision');
    expect(saved.append_number).toBe(`A${parent.input_id}-1`);
    // The queued revision is not delivered, and a returned answer cannot bypass its unread input.
    expect((await post(f, 'worker.accept', { id: parent.id }, 400)).error).toContain('descendants');
    await delivered(f, grandchild);
    expect((await post(f, 'worker.accept', { id: parent.id }, 400)).error).toContain('unread input');
    expect((await get(f, `/api/worker/${grandchild.id}`)).messages.find(row => row.id === saved.id))
      .toMatchObject({ consumed: 0, append_number: saved.append_number, body: saved.body });
    f.store.run('UPDATE messages SET consumed=1 WHERE id=?', saved.id);
    const original = f.project.workspaces.git.bind(f.project.workspaces); let fail = true;
    f.project.workspaces.git = async (cwd, ...args) => {
      if (fail && args[0] === 'worktree' && args[1] === 'remove' && args[2] === child.workspace) throw new Error('controlled partial batch');
      return original(cwd, ...args);
    };
    expect((await post(f, 'worker.accept', { id: parent.id }, 400)).error).toContain('reclamation incomplete');
    expect((await post(f, 'worker.message', { id: grandchild.id, body: 'must remain unsent' }, 400)).error).toContain('回收未完成');
    expect(f.store.get('SELECT value FROM meta WHERE key=?', `input_append_high:${parent.input_id}`).value).toBe('1');
    expect(f.store.get('SELECT id FROM messages WHERE body=?', 'must remain unsent')).toBeNull();
    fail = false; await post(f, 'worker.accept', { id: parent.id });
    const history = await get(f, `/api/worker/${grandchild.id}/history`);
    expect(history.find(event => event.type === 'message' && event.data.message_id === saved.id).data.append_number).toBe(saved.append_number);
    expect((await get(f, `/api/worker/${grandchild.id}`))).toMatchObject({ status: 'completed', accepted: true });
  } finally { await f.close(); }
});
