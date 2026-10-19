import { test, expect } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { gate, until } from '../helpers.js';
import { renderWorkerCli } from '../../src/ui/web/assets/worker-cli.js';
import { openTranscriptView, closeTranscriptView } from '../../src/ui/web/assets/transcript-view.js';
import { closeDialog, confirmDialog } from '../../src/ui/web/assets/dialog.js';
import { ui, resetUiState, transcriptCache } from '../../src/ui/web/assets/state.js';
import { openResource } from '../../src/ui/web/assets/sidebar-ui.js';

const task = { id: 77, worker_number: 'W348', task_kind: 'order', workspace: '/owned/worktree' };
const entry = (id, extra = {}) => ({ id, created_at: `2026-10-19T03:00:${String(id % 60).padStart(2, '0')}Z`,
  command: `lush worker inspect ${id}`, workspace: task.workspace, stdout: `output ${id}`, stderr: '',
  exit_code: 0, signal: null, timed_out: false, truncated: false, duration_ms: 5, status: 'succeeded', ...extra });
const adapters = {
  preview: async command => ({ id: 77, command, workspace: task.workspace, argv: ['status'], executable: 'lush', path: 'status', kind: 'read', requires_confirmation: false, revision: 'r1' }),
  execute: async () => ({ ...entry(11), history_id: 11 }),
};
function controls(root) {
  const input = root.querySelector('textarea');
  return {
    edit(value) { input.value = value; for (const fn of input.listeners.input) fn(); }, input,
    run: () => root.querySelector('.worker-cli-run').listeners.click[0](),
    older: () => root.querySelector('.worker-cli-history-tools').querySelector('button').listeners.click[0](),
    clear: () => root.querySelector('.danger').listeners.click[0](),
    commands: () => root.querySelectorAll('.worker-cli-result-command').map(node => node.textContent.split('\n')[1]),
  };
}
function mount(options = {}) {
  const dom = installDom(), root = renderWorkerCli(task, { ...adapters, ...options });
  dom.node('detail').append(root);
  return { dom, root, ...controls(root), cleanup() { root.dispose(); closeDialog(); dom.restore(); } };
}

test('history first reads latest page, manually prepends older entries, deduplicates ids and retains exact nodes', async () => {
  const calls = [];
  const f = mount({ loadHistory: async params => {
    calls.push(params);
    return params.before ? { entries: [entry(1), entry(2), entry(3)], before: 1, has_more: false }
      : { entries: [entry(3), entry(4)], before: 3, has_more: true };
  } });
  try {
    await f.root.ready; expect(calls).toEqual([{ limit: 10 }]);
    const node = f.root.querySelector('.worker-cli-result');
    f.edit('lush help'); f.root.querySelector('.worker-cli-advanced').open = true;
    await f.older(); expect(calls).toEqual([{ limit: 10 }, { before: 3, limit: 10 }]);
    expect(f.commands()).toEqual([1, 2, 3, 4].map(id => `$ lush worker inspect ${id}`));
    expect(f.root.querySelectorAll('.worker-cli-result')[2]).toBe(node);
    expect(f.input.value).toBe('lush help'); expect(f.root.querySelector('.worker-cli-advanced').open).toBe(true);
    expect(deepText(f.root)).toContain('密文和密钥一起泄露');
    await f.older(); expect(calls).toHaveLength(2);
    expect(f.root.querySelector('.danger').disabled).toBe(true); // never claim local deletion cleared server history
  } finally { f.cleanup(); }
});

test('retained history is readable without a live workspace and unproven running outcomes remain unknown', async () => {
  const dom = installDom();
  const root = renderWorkerCli({ ...task, workspace: null }, { ...adapters,
    loadHistory: async () => ({ entries: [entry(1, { status: 'running' })], before: 1, has_more: false }) });
  try {
    await root.ready;
    expect(root.querySelector('.worker-cli-run').disabled).toBe(true);
    expect(root.querySelector('.worker-cli-result-meta').textContent).toContain('结果未知');
    expect(root.querySelector('.worker-cli-result-meta').textContent).not.toContain('正在真实执行');
  } finally { root.dispose(); dom.restore(); }
});

test('late initial history cannot overwrite a new execution ACK or its next draft; history save failure never replays', async () => {
  const ready = gate(); let executes = 0;
  const f = mount({ loadHistory: async () => { await ready.promise; return { entries: [entry(10), entry(11, { stdout: 'stale snapshot' })], before: 10, has_more: false }; },
    execute: async () => { executes++; return { ...entry(11, { stdout: 'fresh output' }), history_id: 11, history_error: 'disk error' }; } });
  try {
    f.edit('lush status'); await f.run(); f.edit('lush help'); ready.resolve(); await f.root.ready;
    expect(f.commands()).toEqual(['$ lush worker inspect 10', '$ lush status']);
    expect(deepText(f.root)).toContain('fresh output'); expect(deepText(f.root)).not.toContain('stale snapshot');
    expect(deepText(f.root)).toContain('历史保存失败'); expect(f.input.value).toBe('lush help'); expect(executes).toBe(1);
    expect(f.root.querySelector('.worker-cli-status').textContent).toBe('执行成功。');
  } finally { ready.resolve(); f.cleanup(); }
});

test('history failures retain entries, retry explicitly, and bounded pagination stops at 100 recent entries', async () => {
  let calls = 0, fail = true;
  const f = mount({ loadHistory: async ({ before }) => {
    calls++; if (fail) throw Error('locked');
    const end = before ?? 201;
    return { entries: Array.from({ length: 10 }, (_, i) => entry(end - 10 + i)), before: end - 10, has_more: true };
  } });
  try {
    await f.root.ready; expect(deepText(f.root)).toContain('历史读取失败');
    fail = false; await f.older();
    for (let i = 0; i < 9; i++) await f.older();
    expect(f.root.querySelectorAll('.worker-cli-result')).toHaveLength(100);
    await f.older(); expect(calls).toBe(11);
    f.edit('lush status'); await f.run();
    expect(f.root.querySelectorAll('.worker-cli-result')).toHaveLength(100);
    expect(f.commands().at(-1)).toBe('$ lush status');
  } finally { f.cleanup(); }
});

test('destructive clear confirms, blocks execution races, preserves on failure and invalidates late reads on success', async () => {
  const oldRead = gate(), executeGate = gate(); let clears = 0, fail = true, reads = 0;
  const f = mount({ loadHistory: async () => {
    if (++reads === 1) return { entries: [entry(10)], before: 10, has_more: true };
    await oldRead.promise; return { entries: [entry(1)], before: 1, has_more: false };
  }, clearHistory: async () => { clears++; if (fail) throw Error('denied'); },
  execute: async () => { await executeGate.promise; return { ...entry(11), history_id: 11 }; } });
  let pending;
  try {
    await f.root.ready;
    pending = f.clear(); await Promise.resolve();
    expect(dialogButton(f.dom, '永久清除').classList.contains('danger')).toBe(true);
    expect(dialogButton(f.dom, '永久清除').dataset.help).toContain('永久删除');
    f.edit('lush status'); await f.run(); // editing dismisses confirmation; no execution while busy
    await pending; expect(clears).toBe(0);
    pending = f.clear(); await Promise.resolve(); await dialogButton(f.dom, '永久清除').onclick(); await pending;
    expect(clears).toBe(1); expect(f.commands()).toHaveLength(1); expect(deepText(f.root)).toContain('清除失败');
    const read = f.older();
    fail = false; pending = f.clear(); await Promise.resolve(); await dialogButton(f.dom, '永久清除').onclick(); await pending;
    oldRead.resolve(); await read; expect(f.commands()).toEqual([]); expect(clears).toBe(2);
    f.edit('lush status'); pending = f.run(); await Promise.resolve();
    await f.clear(); expect(clears).toBe(2); expect(f.dom.node('modal').hidden).toBe(true);
    expect(f.root.querySelector('.danger').parentNode.dataset.help).toContain('在途');
    executeGate.resolve(); await pending; expect(f.commands()).toEqual(['$ lush status']);
  } finally { oldRead.resolve(); executeGate.resolve(); f.cleanup(); await pending; }
});

test('Worker/workspace change and dispose invalidate old history without leaking identity data', async () => {
  for (const phase of ['worker', 'workspace', 'dispose']) {
    const ready = gate(); let calls = 0;
    const f = mount({ loadHistory: async () => {
      if (++calls > 1) return { entries: [], before: null, has_more: false };
      await ready.promise; return { entries: [entry(1, { stdout: 'old identity secret' })], before: 1, has_more: false };
    } });
    const old = f.root.ready;
    try {
      if (phase === 'dispose') f.root.dispose();
      else f.root.update({ ...task, ...(phase === 'worker' ? { id: 78 } : { workspace: '/new/workspace' }) });
      ready.resolve(); await old; await f.root.ready;
      expect(deepText(f.root)).not.toContain('old identity secret');
    } finally { ready.resolve(); f.cleanup(); }
  }
});

test('four reader tabs retain CLI history/draft, own top-layer confirmation, invalidate dispatched responses on navigation', async () => {
  const pendingExecution = gate(); let executions = 0;
  const dom = installDom({ fetch: async url => {
    if (String(url).includes('code-state')) return Response.json({ availability: 'unavailable', reason: 'fixture', changes: [] });
    if (String(url).endsWith('/77')) return Response.json(task);
    return Response.json({ steps: [], files: [], next: 0, oldest: 0, has_more: false, has_older: false });
  } });
  resetUiState(); dom.location.hash = '#worker-77-execution-cli';
  let send;
  try {
    await openTranscriptView(77, undefined, { mode: 'cli', task, standalone: true, cli: { ...adapters,
      execute: async () => { if (++executions > 1) await pendingExecution.promise; return { ...entry(executions), history_id: executions }; } } });
    const state = ui.transcriptView, root = state.cli, c = controls(root), tabs = state.panel.querySelectorAll('[role="tab"]');
    expect(tabs.map(tab => tab.textContent)).toEqual(['执行记录', '代码与改动', '性能分析', 'CLI 交互']);
    expect(dom.node('modal').parentNode).toBe(state.panel); expect(state.panel.querySelector('.transcript-back')).toBeNull();
    c.edit('lush status'); await c.run(); c.edit('lush help');
    const first = root.querySelector('.worker-cli-result');
    for (const index of [0, 1, 2, 3]) await tabs[index].onclick();
    expect(state.cli).toBe(root); expect(root.hidden).toBe(false); expect(c.input.value).toBe('lush help');
    expect(root.querySelector('.worker-cli-result')).toBe(first);
    tabs[3].onkeydown({ key: 'End', preventDefault() {} }); expect(dom.document.activeElement).toBe(tabs[3]);
    send = c.run(); await Promise.resolve(); c.edit('lush next');
    openResource('tasks'); expect(ui.transcriptView).toBeNull();
    pendingExecution.resolve(); await send; expect(deepText(root)).not.toContain('output 2');
    expect(dom.node('modal').parentNode).not.toBe(state.panel);
  } finally { pendingExecution.resolve(); closeDialog(); closeTranscriptView(); await send; transcriptCache.delete(77); resetUiState(); dom.restore(); }
});

test('leaving reader cancels only its own confirmation, and Valet never gets a CLI tab', async () => {
  const dom = installDom({ fetch: async () => Response.json({ steps: [], files: [], next: 0, has_more: false }) });
  let pending, replacement;
  try {
    await openTranscriptView(77, undefined, { task, mode: 'cli', cli: { ...adapters, preview: async command => ({ ...await adapters.preview(command), kind: 'agent' }) } });
    const c = controls(ui.transcriptView.cli); c.edit('lush order example'); pending = c.run(); await until(() => dialogButton(dom, '确认并调用 Agent'));
    expect(dialogButton(dom, '确认并调用 Agent').classList.contains('agent-call')).toBe(true);
    closeTranscriptView(); await pending; expect(dom.node('modal').hidden).toBe(true);
    await openTranscriptView(77, undefined, { task, mode: 'cli', cli: { ...adapters, preview: async command => ({ ...await adapters.preview(command), kind: 'agent' }) } });
    const d = controls(ui.transcriptView.cli); d.edit('lush order example'); pending = d.run(); await until(() => dialogButton(dom, '确认并调用 Agent'));
    replacement = confirmDialog({ title: 'other feature' }); closeTranscriptView(); await pending;
    expect(dom.node('modal').hidden).toBe(false); await dialogButton(dom, '取消').onclick(); await replacement;
    await openTranscriptView(78, undefined, { task: { ...task, id: 78, task_kind: 'management', worker_number: 'V9' }, mode: 'cli' });
    expect(ui.transcriptView.panel.querySelectorAll('[role="tab"]').map(tab => tab.textContent)).toEqual(['执行记录']);
    expect(ui.transcriptView.cli).toBeUndefined();
  } finally { closeDialog(); closeTranscriptView(); await pending; await replacement; transcriptCache.delete(77); transcriptCache.delete(78); dom.restore(); }
});
