import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { runBranchArchive } from '../../src/ui/web/assets/branch-archive.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';

let dom, requests, result, fail, gate;
const branch = { name: 'feature/failed', subtreeBranches: 2 };
beforeEach(() => {
  requests = []; fail = false; gate = null; result = { archived: true, count: 3, discarded: true, failed: [], remaining: [] };
  dom = installDom({ fetch: async (_url, options) => {
    if (options?.body) requests.push(JSON.parse(options.body));
    if (gate) await gate;
    return new Response(JSON.stringify(fail ? { error: '共享资源仍使用中' } : result), { status: fail ? 409 : 200 });
  } });
  closeDialog(); activateDetailView({ view: 'task', key: 'task-70' });
});
afterEach(() => { closeDialog(); dom.restore(); });

test('failed/cancelled resource cleanup confirms discard and never claims acceptance', async () => {
  let refreshed = 0;
  const pending = runBranchArchive(branch, { refresh: () => { refreshed++; } });
  expect(deepText(dom.node('modal'))).toContain('未提交改动会被丢弃');
  expect(deepText(dom.node('modal'))).toContain('这不是成果验收');
  expect(dialogButton(dom, '清理资源').classList.contains('agent-call')).toBe(false);
  expect(requests).toHaveLength(0);
  await dialogButton(dom, '清理资源').onclick(); await pending;
  expect(requests).toEqual([{ method: 'branch.archive', params: { branch: branch.name, discard: true } }]);
  expect(refreshed).toBe(1); expect(dom.node('error').textContent).toContain('这不是成果验收');
});

test('partial resource deletion is not reported as success', async () => {
  result.failed = [{ branch: 'feature/child', reason: 'busy' }]; result.remaining = ['feature/last'];
  const pending = runBranchArchive(branch);
  await dialogButton(dom, '清理资源').onclick(); await pending;
  expect(dom.node('error').textContent).toContain('未全部完成');
  expect(dom.node('error').textContent).toContain('未完成成果验收');
});

test('cleanup cancellation and navigation during confirmation never delete', async () => {
  let pending = runBranchArchive(branch);
  await dialogButton(dom, '保留').onclick(); await pending; expect(requests).toHaveLength(0);
  pending = runBranchArchive(branch); activateDetailView({ view: 'overview' });
  await dialogButton(dom, '清理资源').onclick(); await pending; expect(requests).toHaveLength(0);
});

test('late cleanup result does not toast or refresh another page', async () => {
  let release, refreshed = 0; gate = new Promise(resolve => { release = resolve; });
  const pending = runBranchArchive(branch, { refresh: () => { refreshed++; } });
  await dialogButton(dom, '清理资源').onclick();
  activateDetailView({ view: 'overview' }); dom.node('error').textContent = 'new page';
  release(); await pending;
  expect(refreshed).toBe(0); expect(dom.node('error').textContent).toBe('new page');
});

test('refused cleanup preserves diagnosis without acceptance or retry', async () => {
  fail = true; const pending = runBranchArchive(branch);
  await dialogButton(dom, '清理资源').onclick(); await pending;
  expect(requests).toHaveLength(1); expect(dom.node('error').textContent).toContain('共享资源仍使用中');
});
