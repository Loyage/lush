import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { installDom, deepText } from '../dom-stub.js';
import { iterationControls } from '../../src/ui/web/assets/render-iteration.js';
import { renderTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';

setDefaultTimeout(20000);
const get = async (f, route) => (await fetch(f.url + route)).json();
async function post(f, method, params, status = 200) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.url },
    body: JSON.stringify({ method, params }) });
  expect(response.status).toBe(status); return response.json();
}
async function idle(f, task, accepted = false) {
  await f.project.workspaces.finish(task);
  f.store.update(task.id, { status: accepted ? 'completed' : 'waiting', reservation: null, result: '完整保留的回答' });
  if (accepted) f.store.event(task.id, 'task.accepted', { accepted_by: 'user', head_commit: f.store.task(task.id).head_commit });
}
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);

for (const dirty of [false, true]) test(`real HTTP and UI accept an unchanged answer in one request without losing history (dirty=${dirty})`, async () => {
  const f = await setup(); f.project.stopping = true; let dom, restore;
  try {
    await repo(f.root);
    const { task } = await post(f, 'order.submit', { content: '只读回答的验收', start: false });
    await idle(f, f.store.task(task.id));
    const session = path.join(f.config.home, 'sessions', `task-${task.id}-retained.txt`);
    fs.mkdirSync(path.dirname(session), { recursive: true }); fs.writeFileSync(session, '会话运行文档');
    if (dirty) fs.writeFileSync(path.join(task.workspace, 'unsaved.txt'), '不可静默删除');
    const before = await get(f, `/api/worker/${task.id}`);
    const requests = [];
    dom = installDom({ fetch: (url, options) => {
      if (options?.body) requests.push(JSON.parse(options.body));
      return fetch(f.url + url, options);
    } });
    resetUiState(); restore = registerNavigation({ refresh: async () => {}, detail: async () => {} });
    activateDetailView({ view: 'task', key: `task-${task.id}` });
    const controls = iterationControls(before), accept = button(controls, '验收');
    dom.node('detail').append(controls);
    expect(accept).toBeTruthy(); expect(accept.disabled).toBe(false);
    expect(deepText(controls)).toContain('归档并删除');
    await accept.onclick();
    if (dirty) {
      expect(f.store.task(task.id).status).toBe('waiting');
      expect(fs.readFileSync(path.join(task.workspace, 'unsaved.txt'), 'utf8')).toBe('不可静默删除');
      expect(f.store.history(task.id).some(event => event.type === 'task.accepted')).toBe(false);
      fs.unlinkSync(path.join(task.workspace, 'unsaved.txt'));
      await accept.onclick();
    }
    await accept.onclick(); // Successful ACK suppresses duplicate mutation even if stale UI remains.
    expect(requests).toHaveLength(dirty ? 2 : 1);
    expect(requests.every(request => request.method === 'worker.accept')).toBe(true);
    const after = await get(f, `/api/worker/${task.id}`);
    expect(after).toMatchObject({ status: 'completed', workspace: null, accepted: true, acceptance_recovery: false,
      integration: 'none', result: '完整保留的回答' });
    expect(fs.existsSync(task.workspace)).toBe(false);
    expect(await git(f.root, 'show-ref', '--verify', `refs/heads/${task.branch}`).catch(() => null)).toBeNull();
    expect(fs.readFileSync(session, 'utf8')).toBe('会话运行文档');
    const events = await get(f, `/api/worker/${task.id}/history`);
    expect(events.filter(event => event.type === 'task.accepted')).toHaveLength(1);
    expect(dom.node('error').textContent).toContain('开发资源已归档回收');
  } finally { restore?.(); resetUiState(); dom?.restore(); await f.close(); }
});

test('real partial subtree reclamation stays visible in the graph and resumes through the same acceptance endpoint', async () => {
  const f = await setup(); f.project.stopping = true; let dom, restore;
  try {
    await repo(f.root);
    const { task } = await post(f, 'order.submit', { content: '部分资源回收的恢复', start: false });
    const child = await f.project.spawn(task.id, '历史已验收后代');
    await idle(f, child, true); await idle(f, f.store.task(task.id));
    const original = f.project.workspaces.git.bind(f.project.workspaces); let removes = 0;
    f.project.workspaces.git = async (cwd, ...args) => {
      if (args[0] === 'worktree' && args[1] === 'remove' && ++removes === 2) throw new Error('controlled second-resource failure');
      return original(cwd, ...args);
    };
    expect((await post(f, 'worker.accept', { id: task.id }, 400)).error).toContain('reclamation incomplete');
    const inspected = await get(f, `/api/worker/${task.id}`), graph = await get(f, '/api/worker-graph');
    const row = graph.nodes.find(node => node.id === task.id);
    expect(inspected).toMatchObject({ status: 'waiting', workspace: null, accepted: false, acceptance_recovery: true });
    expect(row).toMatchObject({ archived: false, acceptance_recovery: true, branch_info: { archived: true } });
    expect(f.store.history(task.id).some(event => event.type === 'task.accepted')).toBe(false);
    const requests = [];
    dom = installDom({ fetch: (url, options) => {
      if (options?.body) requests.push(JSON.parse(options.body));
      return fetch(f.url + url, options);
    } });
    resetUiState(); restore = registerNavigation({ refresh: async () => {}, detail: async () => {} });
    ui.taskGraphShowArchived = false; ui.taskGraphMinimal = false;
    activateDetailView({ view: 'task-graph' }); renderTaskGraph(graph);
    const resume = button(dom.node('detail'), '续办验收');
    expect(resume).toBeTruthy(); expect(resume.disabled).toBe(false); expect(removes).toBe(2);
    await resume.onclick(); await resume.onclick();
    expect(requests).toEqual([{ method: 'worker.accept', params: { id: task.id } }]); expect(removes).toBe(3);
    expect((await get(f, `/api/worker/${task.id}`))).toMatchObject({ status: 'completed', workspace: null,
      accepted: true, acceptance_recovery: false });
    expect(f.store.branch(child.branch).status).toBe('archived');
    const current = (await get(f, '/api/worker-graph')).nodes.find(node => node.id === task.id);
    expect(current.archived).toBe(true); expect(current.acceptance_recovery).toBe(false);
  } finally { restore?.(); resetUiState(); dom?.restore(); await f.close(); }
});
