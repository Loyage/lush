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
  } finally { dom.restore(); await f.close(); }
});
