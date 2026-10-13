import { test, expect, afterAll } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';

const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { ui } = await import('../../src/ui/web/assets/state.js');
const { parseFilters, filterTasks } = await import('../../src/ui/web/assets/sidebar.js');
const { renderTree } = await import('../../src/ui/web/assets/render-tree.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { managementReceipts } = await import('../../src/ui/web/assets/management-state.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { closeTranscriptView } = await import('../../src/ui/web/assets/transcript-view.js');
afterAll(() => { ui.disposeDetailRequests?.(); closeTranscriptView(); dom.restore(); });

test('real Valet projection renders in the shared list and detail with exact confirmation identity and no development controls', async () => {
  let f, target, receipt;
  f = fixture({ async run({ task, token }) {
    if (task.task_kind === 'management') receipt = await f.rpc.dispatch('manager.call', {
      method: 'worker.cancel', params: { id: target.id }, request_id: 'real-valet-confirmation', _token: token,
    });
    return '等待用户确认，尚未执行取消。';
  } });
  f.project.kick = () => {};
  try {
    await repo(f.root);
    f.rpc = new Dispatcher(f.project);
    target = (await f.project.order('开发目标', 'main', [], null, false)).task;
    const created = await f.rpc.dispatch('management.submit', {
      instruction: `取消 ${target.worker_number}`, client_request_id: 'real-valet-input',
    });
    f.project.pump();
    await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(receipt.status).toBe('pending_confirmation');
    expect(f.store.task(target.id).status).toBe('paused');
    const actualNotice = f.store.get('SELECT id,kind FROM notices WHERE id=?', receipt.notice_id);
    expect(actualNotice.kind).toBe('questionnaire');
    const inspected = await f.rpc.dispatch('worker.inspect', { id: created.task.id });
    expect(inspected.worker_number).toBe('V1');
    expect(inspected.management.pending_signal.control_calls[0]).toMatchObject({
      notice_id: actualNotice.id, notice_kind: actualNotice.kind, status: 'pending_confirmation',
    });
    const activity = await f.rpc.dispatch('worker.activity', { scope: 'all' });
    ui.workerNumbers = new Map(); ui.deletedWorkerIds = new Set(); ui.filters = parseFilters(null);
    ui.filters.tasks.type = 'valet'; ui.filters.tasks.text = 'V1'; ui.selected = null;
    const snapshot = { ...(await (await world.fetchImpl('/api/snapshot')).json()),
      tasks: activity.tasks, task_page: activity.page };
    ui.lastSnapshot = snapshot;
    activateDetailView({ view: 'tasks' }); renderTree(snapshot);
    expect(filterTasks(activity.tasks, ui.filters.tasks).map(task => task.id)).toEqual([created.task.id]);
    expect(dom.node('tasks').querySelectorAll('.task').map(node => Number(node.dataset.id))).toEqual([created.task.id]);
    expect(deepText(dom.node('tasks'))).toContain('Valet');
    activateDetailView({ view: 'task', key: `task-${inspected.id}` });
    renderDetail(inspected, { events: [] }, null, null);
    const panel = dom.node('detail'), text = deepText(panel);
    expect(text).toMatch(/Valet\s+V1/);
    expect(text).toMatch(new RegExp(`确认提醒\\s+D${actualNotice.id}(?!\\d)`));
    expect(text).toContain('待用户确认（尚未执行）');
    expect(panel.querySelector(`a[href="#notices-${actualNotice.id}"]`)).toBeTruthy();
    expect(panel.querySelector('.agent-panel')).toBeTruthy();
    expect(panel.querySelector('.worker-relations')).toBeNull();
    expect(panel.querySelector('.code-reader-open')).toBeNull();
    for (const label of ['追加输入', '合并', '验收', '删除 Worker', '开始 / 继续'])
      expect(panel.querySelectorAll('button').some(node => node.textContent === label)).toBe(false);
    expect(inspected.management.pending_signal.control_calls[0]).not.toHaveProperty('params');
    expect(f.store.task(target.id).status).toBe('paused');

    // Missing / cross-identity facts must remain unknown, not inherit a guessed D prefix.
    f.store.run('UPDATE notices SET task_id=? WHERE id=?', target.id, actualNotice.id);
    const unknown = f.project.inspect(inspected.id).management;
    expect(unknown.pending_signal.control_calls[0].notice_kind).toBeNull();
    expect(deepText(managementReceipts(unknown))).toContain(`确认提醒 N${actualNotice.id}`);
  } finally {
    ui.disposeDetailRequests?.(); closeTranscriptView();
    dom.node('detail').replaceChildren(); ui.lastSnapshot = { tasks: [] }; ui.composerTask = null;
    await f.close();
  }
});
