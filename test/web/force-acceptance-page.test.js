import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { setup, fetch as authenticatedFetch } from './harness.js';
import { acceptanceFixture } from '../acceptance-fixture.js';
import { installDom, dialogText, answerDialog, dialogButton } from './project-dom.js';
import { until } from '../helpers.js';

const find = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);

test('real shared detail/graph control -> authenticated HTTP/RPC -> preview -> explicit confirm -> resource reclamation, with ACK/refresh separation', async () => {
  const f = await setup(), calls = [];
  const { parent, child, signal } = await acceptanceFixture(f);
  const dom = installDom({ fetch: async (url, options) => {
    if (String(url).endsWith('/api/action')) calls.push(JSON.parse(options.body));
    return authenticatedFetch(f.url + String(url), options);
  } });
  try {
    const { iterationControls } = await import('../../src/ui/web/assets/render-iteration.js');
    const refresh = async () => { throw Error('refresh unavailable after ACK'); };
    let panel = iterationControls(parent, { refresh });
    dom.node('detail').append(panel);
    expect(find(panel, '强制验收…')).toBeUndefined();
    await find(panel, '验收').onclick();
    panel = iterationControls(parent, { refresh }); dom.node('detail').replaceChildren(panel);
    const forceButton = find(panel, '强制验收…'); expect(forceButton).toBeDefined();
    expect(forceButton.classList.contains('agent-call')).toBe(false);
    expect(forceButton.getAttribute('data-help')).toContain('不调用 Agent');
    let ended = false;
    let pending = forceButton.onclick().finally(() => { ended = true; });
    await until(() => dialogButton(dom, '跳过所列通知并验收回收') || ended);
    expect({ dialog: Boolean(dialogButton(dom, '跳过所列通知并验收回收')), error: dom.node('error').textContent, calls: calls.map(call => call.method) })
      .toEqual({ dialog: true, error: `Worker ${child.worker_number}: unread input must be processed before acceptance`, calls: ['worker.accept', 'worker.accept_preview'] });
    expect(calls.map(call => call.method)).toEqual(['worker.accept', 'worker.accept_preview']);
    const repaint = iterationControls(parent, { refresh });
    await find(repaint, '验收').onclick(); await find(repaint, '强制验收…').onclick();
    expect(calls).toHaveLength(2);
    expect(dialogText(dom)).toContain(child.worker_number);
    expect(dialogText(dom)).toContain('child.cancelled');
    expect(dialogText(dom)).toContain(`消息 #${signal.id}`);
    expect(dialogText(dom)).toContain(parent.workspace);
    expect(dialogText(dom)).toContain('失败/取消后代不会被改成成功');
    expect(dialogButton(dom, '跳过所列通知并验收回收').classList.contains('agent-call')).toBe(false);
    await answerDialog(dom, '取消'); await pending;
    expect(fs.existsSync(parent.workspace)).toBe(true);
    pending = forceButton.onclick();
    await until(() => dialogButton(dom, '跳过所列通知并验收回收'));
    await answerDialog(dom, '跳过所列通知并验收回收'); await pending;
    expect(calls.filter(call => call.method === 'worker.accept_force')).toHaveLength(1);
    expect(calls.at(-1)).toMatchObject({ method: 'worker.accept_force', params: { id: parent.id, confirm: true } });
    expect(calls.at(-1).params.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(parent.workspace)).toBe(false);
    expect(f.store.task(child.id).status).toBe('cancelled');
    await forceButton.onclick(); await find(panel, '验收').onclick();
    expect(calls.filter(call => call.method === 'worker.accept_force')).toHaveLength(1);
    expect(dom.node('error').textContent).toContain('刷新失败');
    // A pinned append editor can outlive acceptance; its next read must not offer an impossible reopen.
    const { resetUiState } = await import('../../src/ui/web/assets/state.js');
    const { initComposer } = await import('../../src/ui/web/assets/composer.js');
    const { selectComposerMode } = await import('../../src/ui/web/assets/composer-workspace.js');
    resetUiState(); await initComposer();
    const { api } = await import('../../src/ui/web/assets/api.js');
    const accepted = await api(`/api/worker/${parent.id}`);
    expect(accepted.accepted).toBe(true);
    expect(iterationControls(accepted)).toBeNull();
    await selectComposerMode('append', accepted);
    expect(dom.node('composer-mode-behavior').textContent).toContain('已验收完成，不能恢复开发');
    expect(dom.node('composer-mode-behavior').textContent).toContain('请新发指令');
    expect(dom.node('input').disabled).toBe(false); // original destination is blocked, but local editing/recovery stays available
    expect(dom.node('draft-commit').disabled).toBe(true);
    // Valet uses this same control and authenticated user entrance, without a Git delivery.
    f.project.kick = () => {};
    f.project.provider = { async run() { return 'Valet 正常收口'; } };
    const future = new Date(f.project.hookClock() + 3600000).toISOString();
    const signals = f.project.saveHookSignal({ name: '保留共享信号', enabled: true,
      schedule: { kind: 'once', at: future, timezone: 'UTC' } }, f.project.hookSignals().revision);
    const binding = await f.project.createManagementWorker({ name: '验收管理成果', instruction: '检查管理状态',
      signal_id: signals.signals.items[0].id, mode: 'persistent' });
    f.project.submitManagementSignal(binding.id, { id: f.store.event(binding.id, 'test.signal', {}),
      signal_id: binding.management.signal_id, name: 'test', due_at: future, submitted_at: future });
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const valet = f.project.inspect(binding.id), workspace = valet.workspace;
    expect(valet.management).toMatchObject({ accepted: false, can_accept: true, enabled: true, requires_confirmation: true });
    const post = params => authenticatedFetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'worker.accept', params }) });
    expect((await authenticatedFetch(f.url + '/api/action', { method: 'POST', anonymous: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'worker.accept', params: { id: valet.id } }) })).status).toBe(401);
    expect((await post({ id: valet.id })).status).toBe(400); // Cannot silently end future authorization.
    const beforeRuns = f.store.all('SELECT * FROM agent_runs WHERE task_id=?', valet.id);
    const valetPanel = iterationControls(valet, { refresh }); dom.node('detail').replaceChildren(valetPanel);
    expect(find(valetPanel, '强制验收…')).toBeUndefined();
    expect(find(valetPanel, '验收').classList.contains('agent-call')).toBe(false);
    pending = find(valetPanel, '验收').onclick();
    await until(() => dialogButton(dom, '结束未来绑定并验收'));
    expect(dialogText(dom)).toContain('不删除共享信号');
    expect(dialogText(dom)).toContain(workspace);
    await answerDialog(dom, '结束未来绑定并验收'); await pending;
    expect(f.project.inspect(valet.id)).toMatchObject({ accepted: true, archived: true, workspace: null,
      management: { enabled: false, accepted: true, archived: true, can_append: false, requires_confirmation: false } });
    expect(fs.existsSync(workspace)).toBe(false);
    expect(f.store.all('SELECT * FROM agent_runs WHERE task_id=?', valet.id)).toEqual(beforeRuns);
    expect(f.project.hookSignals().items.some(item => item.id === binding.management.signal_id)).toBe(true);
    expect(f.store.task(child.id).status).toBe('cancelled');
    await find(valetPanel, '验收').onclick();
    expect(calls.filter(call => call.method === 'worker.accept' && call.params.id === valet.id)).toHaveLength(1);
    expect(iterationControls(f.project.inspect(valet.id)).querySelector('.iteration-phase').textContent).toContain('已验收归档');
  } finally { dom.restore(); await f.close(); }
});
