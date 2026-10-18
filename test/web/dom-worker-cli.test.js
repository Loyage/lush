import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText, dialogButton, dialogText } from '../dom-stub.js';
import { gate } from '../helpers.js';
import { renderWorkerCli } from '../../src/ui/web/assets/worker-cli.js';
import { closeDialog, confirmDialog } from '../../src/ui/web/assets/dialog.js';
import { agentHelp } from '../../src/ui/web/assets/help.js';

const task = { id: 883, worker_number: 'W324-2', task_kind: 'child', workspace: '/real/worktree/worker-cli' };
const plan = (command, extra = {}) => ({ id: task.id, command, workspace: task.workspace, argv: ['status'],
  executable: 'lush', path: 'status', kind: 'read', requires_confirmation: false, revision: 'r1', ...extra });
const outcome = (extra = {}) => ({ command: 'lush status', workspace: task.workspace, stdout: 'ready', stderr: '',
  exit_code: 0, signal: null, timed_out: false, truncated: false, duration_ms: 5, status: 'succeeded', ...extra });
function mount(options = {}, snapshot = task) {
  const requests = [], dom = installDom({ fetch: async () => { throw Error('Unexpected API import/call'); } });
  const root = renderWorkerCli(snapshot, {
    preview: async command => { requests.push(['preview', command]); return plan(command); },
    execute: async params => { requests.push(['execute', params]); return outcome(); }, ...options,
  });
  dom.node('detail').append(root);
  const input = root.querySelector('textarea'), run = root.querySelector('.worker-cli-run');
  return { dom, root, input, run, requests, status: root.querySelector('.worker-cli-status'),
    edit(value) { input.value = value; for (const handler of input.listeners.input || []) handler(); },
    click() { return run.listeners.click?.[0]?.(); },
    key(extra = {}) { return input.listeners.keydown?.[0]?.({ key: 'Enter', ctrlKey: true, preventDefault() {}, ...extra }); },
    cleanup() { root.dispose(); closeDialog(); dom.restore(); } };
}

test('CLI editor is directly visible, advanced help is collapsed, examples only fill, identity is explicit', async () => {
  const f = mount();
  try {
    expect(f.root.tagName).toBe('SECTION');
    expect(f.root.getAttribute('aria-label')).toBe('CLI 交互');
    expect(f.root.querySelector('.worker-cli-advanced').open).toBe(false);
    expect(f.input.getAttribute('aria-keyshortcuts')).toBe('Control+Enter');
    await Promise.resolve();
    expect(f.requests).toEqual([]); expect(f.run.disabled).toBe(true);
    expect(deepText(f.root)).toContain('W324-2');
    expect(deepText(f.root)).toContain(task.workspace);
    expect(deepText(f.root)).toContain('当前登录用户身份真实执行，不是沙箱');
    expect(deepText(f.root)).toContain('不借用 Worker 的 Agent token');
    const examples = f.root.querySelector('.worker-cli-examples').querySelectorAll('button');
    expect(examples).toHaveLength(3);
    for (const example of examples) for (const handler of example.listeners.click) handler();
    expect(f.input.value).toBe('lush worker inspect W324-2'); expect(f.requests).toEqual([]);
    expect(f.run.disabled).toBe(false);
  } finally { f.cleanup(); }
});

test('read-only preview executes exactly once, passes only revision/command/confirm and renders plain stdout/stderr', async () => {
  const f = mount({ execute: async params => { f.requests.push(['execute', params]); return outcome({ stdout: '<script>bad()</script>', stderr: 'warning' }); } });
  try {
    f.edit('lush status'); await f.click();
    expect(f.requests).toEqual([['preview', 'lush status'], ['execute', { command: 'lush status', revision: 'r1', confirm: false }]]);
    expect(f.status.textContent).toBe('执行成功。');
    expect(f.root.querySelectorAll('.worker-cli-output').map(node => node.textContent)).toEqual(['<script>bad()</script>', 'warning']);
    expect(f.root.querySelector('script')).toBeNull();
    expect(f.dom.node('modal').children).toHaveLength(0); expect(f.input.value).toBe('lush status');
    expect(f.root.querySelector('.worker-cli-result-meta').textContent).toContain('退出码：0');
  } finally { f.cleanup(); }
});

test('Ctrl+Enter shares submit guards; plain Enter, IME and repeated keydown cannot send', async () => {
  const hold = gate();
  const f = mount({ execute: async params => { f.requests.push(['execute', params]); await hold.promise; return outcome(); } });
  let pending;
  try {
    await f.key(); expect(f.requests).toEqual([]);
    f.edit('lush status');
    for (const extra of [{ ctrlKey: false }, { isComposing: true }, { keyCode: 229 }, { repeat: true },
      { shiftKey: true }, { altKey: true }, { metaKey: true }, { key: 'x' }]) await f.key(extra);
    expect(f.requests).toEqual([]);
    let prevented = false;
    pending = f.key({ preventDefault() { prevented = true; } });
    await Promise.resolve(); await f.key(); await f.click();
    expect(prevented).toBe(true); expect(f.requests).toHaveLength(2);
    const body = f.root.querySelector('.worker-cli-body'), result = f.root.querySelector('.worker-cli-result');
    const children = [...body.children];
    expect(children.indexOf(result)).toBe(children.indexOf(f.status) + 1);
    expect(children.indexOf(f.root.querySelector('.worker-cli-advanced'))).toBe(children.indexOf(result) + 1);
    expect(result.hidden).toBe(false);
    expect(f.root.querySelector('.worker-cli-result-command').textContent).toContain('lush status');
    expect(f.root.querySelector('.worker-cli-result-meta').textContent).toContain('等待输出');
    f.edit('lush help'); hold.resolve(); await pending;
    expect(f.input.value).toBe('lush help'); expect(f.status.textContent).toBe('执行成功。');
    expect(f.root.querySelector('.worker-cli-result-command').textContent).toContain('lush status');
  } finally { hold.resolve(); f.cleanup(); await pending; }
});

test('nonzero exit, signals, timeout, truncation and unknown are never presented as success', async () => {
    for (const value of [outcome({ exit_code: 2, status: 'failed', stderr: 'denied' }),
      outcome({ exit_code: 7 }), outcome({ timed_out: true, signal: 'SIGTERM', truncated: true, exit_code: null }),
      outcome({ status: 'unknown', exit_code: null }), null]) {
      const other = mount({ execute: async () => value });
      try {
        other.edit('lush status'); await other.click();
        expect(other.status.textContent).not.toBe('执行成功。');
        const meta = other.root.querySelector('.worker-cli-result-meta').textContent;
        if (value?.timed_out) { expect(meta).toContain('已超时'); expect(meta).toContain('SIGTERM'); expect(meta).toContain('已截断'); }
        if (value?.status === 'unknown' || !value) expect(meta).toContain('结果未知');
        if (value?.stderr) expect(other.root.querySelectorAll('.worker-cli-output')[1].textContent).toBe(value.stderr);
      } finally { other.cleanup(); }
    }
});

test('write confirmation exposes exact command/workspace/argv and cancel never executes', async () => {
  const f = mount({ preview: async command => plan(command, { kind: 'write', requires_confirmation: true, argv: ['worker', 'cancel', 'W324-2'], path: 'worker cancel' }) });
  let pending;
  try {
    f.edit('lush worker cancel W324-2'); pending = f.click(); await Promise.resolve();
    expect(f.run.disabled).toBe(true);
    expect(dialogText(f.dom)).toContain('lush worker cancel W324-2');
    expect(dialogText(f.dom)).toContain(task.workspace); expect(dialogText(f.dom)).toContain('["worker","cancel","W324-2"]');
    expect(dialogText(f.dom)).toContain('可能修改文件、项目状态');
    expect(dialogButton(f.dom, '确认执行').classList.contains('agent-call')).toBe(false);
    await dialogButton(f.dom, '取消').onclick(); await pending;
    expect(f.requests).toEqual([]); expect(f.status.textContent).toBe('已取消，未执行。');
    expect(f.input.value).toBe('lush worker cancel W324-2');
  } finally { f.cleanup(); await pending; }
});

test('confirmed write executes only the exact preview revision; no unconfirmed mutation', async () => {
  const f = mount({ preview: async command => plan(command, { kind: 'write', requires_confirmation: true, revision: 'write-r2' }) });
  let pending;
  try {
    f.edit('lush worker cancel W324-2'); pending = f.click(); await Promise.resolve();
    expect(f.requests).toEqual([]); await dialogButton(f.dom, '确认执行').onclick(); await pending;
    expect(f.requests).toEqual([['execute', { command: 'lush worker cancel W324-2', revision: 'write-r2', confirm: true }]]);
  } finally { f.cleanup(); await pending; }
});

test('Agent kind always requires purple Agent-marked confirmation with the shared agentHelp cost', async () => {
  const f = mount({ preview: async command => plan(command, { kind: 'agent', requires_confirmation: false }) });
  let pending;
  try {
    expect(f.run.classList.contains('agent-call')).toBe(false);
    f.edit('lush order hello'); pending = f.click(); await Promise.resolve();
    const confirm = dialogButton(f.dom, '确认并调用 Agent');
    expect(confirm.classList.contains('agent-call')).toBe(true);
    expect(confirm.dataset.help).toContain(agentHelp()); expect(f.requests).toEqual([]);
    await confirm.onclick(); await pending;
    expect(f.requests).toEqual([['execute', { command: 'lush order hello', revision: 'r1', confirm: true }]]);
  } finally { f.cleanup(); await pending; }
});

test('preview errors are explicitly not executed; execution transport failure is unknown without retry', async () => {
  const f = mount({ preview: async () => { throw Error('workspace missing'); } });
  try {
    f.edit('lush status'); await f.click(); expect(f.requests).toEqual([]);
    expect(f.status.textContent).toContain('预览失败，未执行'); expect(f.status.textContent).toContain('workspace missing');
  } finally { f.cleanup(); }
  let calls = 0;
  const g = mount({ execute: async () => { calls++; throw Error('connection lost'); } });
  try {
    g.edit('lush status'); await g.click(); await Promise.resolve();
    expect(calls).toBe(1); expect(g.status.textContent).toContain('结果未知');
    expect(g.status.textContent).toContain('命令可能已执行'); expect(g.status.textContent).toContain('不会自动重试');
    expect(g.root.querySelector('.worker-cli-result').hidden).toBe(false);
    expect(g.root.querySelector('.worker-cli-result-command').textContent).toContain(task.workspace);
  } finally { g.cleanup(); }
});

test('mismatched or malformed preview fails closed', async () => {
  for (const extra of [{ id: 99 }, { command: 'lush order unexpected' }, { revision: '' }, { workspace: null },
    { requires_confirmation: undefined }, { argv: null }, { argv: [5] }, { path: null }, { executable: null }, { kind: null }]) {
    const f = mount({ preview: async command => plan(command, extra) });
    try { f.edit('lush status'); await f.click(); expect(f.requests).toEqual([]); expect(f.status.textContent).toContain('预览失败，未执行'); }
    finally { f.cleanup(); }
  }
});

test('double clicks cannot duplicate preview or execution, and execution keeps the next draft', async () => {
  const previewGate = gate(), executeGate = gate(); let previews = 0, executions = 0;
  const f = mount({ preview: async command => { previews++; await previewGate.promise; return plan(command); },
    execute: async () => { executions++; await executeGate.promise; return outcome(); } });
  let pending;
  try {
    f.edit('lush status'); pending = f.click(); await f.click(); expect(previews).toBe(1);
    previewGate.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(executions).toBe(1); await f.click(); expect(previews).toBe(1);
    expect(f.input.disabled).toBe(false); f.edit('lush help');
    executeGate.resolve(); await pending;
    expect(f.input.value).toBe('lush help'); expect(executions).toBe(1); expect(f.run.disabled).toBe(false);
  } finally { previewGate.resolve(); executeGate.resolve(); f.cleanup(); await pending; }
});

test('editing while preview is in flight invalidates it even if draft changes back', async () => {
  const hold = gate(); const f = mount({ preview: async command => { await hold.promise; return plan(command); } });
  let pending;
  try {
    f.edit('lush status'); pending = f.click(); f.edit('lush help'); f.edit('lush status'); hold.resolve(); await pending;
    expect(f.requests).toEqual([]); expect(f.status.textContent).toContain('旧预览未执行');
  } finally { hold.resolve(); f.cleanup(); await pending; }
});

test('editing during confirmation dismisses it and cannot execute the old command, even via stale button', async () => {
  const f = mount({ preview: async command => plan(command, { kind: 'write', requires_confirmation: true }) });
  let pending;
  try {
    f.edit('lush worker cancel W324-2'); pending = f.click(); await Promise.resolve();
    const oldConfirm = dialogButton(f.dom, '确认执行');
    f.edit('lush help'); await oldConfirm.onclick(); await pending;
    expect(f.requests).toEqual([]); expect(f.input.value).toBe('lush help');
    expect(f.status.textContent).toContain('旧预览未执行'); expect(f.dom.node('modal').hidden).toBe(true);
  } finally { f.cleanup(); await pending; }
});

test('editing immediately after confirming still prevents execution before the promise continuation', async () => {
  const f = mount({ preview: async command => plan(command, { kind: 'write', requires_confirmation: true }) }); let pending;
  try {
    f.edit('lush worker cancel W324-2'); pending = f.click(); await Promise.resolve();
    const confirmation = dialogButton(f.dom, '确认执行').onclick();
    f.edit('lush help'); await confirmation; await pending;
    expect(f.requests).toEqual([]); expect(f.input.value).toBe('lush help');
    expect(f.status.textContent).toContain('旧预览未执行');
  } finally { f.cleanup(); await pending; }
});

test('same Worker refresh leaves confirmation intact and authoritative preview directory visible', async () => {
  const f = mount({ preview: async command => plan(command, { workspace: '/canonical/real/worktree', kind: 'write', requires_confirmation: true }) }); let pending;
  try {
    f.edit('lush status'); pending = f.click(); await Promise.resolve();
    const confirm = dialogButton(f.dom, '确认执行');
    f.root.update({ ...task, status: 'running' });
    expect(dialogButton(f.dom, '确认执行')).toBe(confirm);
    expect(f.root.querySelector('.worker-cli-workspace').textContent).toBe('/canonical/real/worktree');
    await confirm.onclick(); await pending; expect(f.requests).toHaveLength(1);
  } finally { f.cleanup(); await pending; }
});

test('same Worker update preserves exact nodes, input/output/advanced disclosure and in-flight request', async () => {
  const hold = gate(); const f = mount({ execute: async () => { await hold.promise; return outcome(); } });
  let pending;
  try {
    f.root.querySelector('.worker-cli-advanced').open = true; f.edit('lush status');
    pending = f.click(); await Promise.resolve();
    f.root.update({ ...task, status: 'awaiting_acceptance' }); expect(f.root.querySelector('textarea')).toBe(f.input);
    expect(f.input.value).toBe('lush status');
    expect(f.root.querySelector('.worker-cli-advanced').open).toBe(true); expect(f.run.disabled).toBe(true);
    hold.resolve(); await pending; const output = f.root.querySelectorAll('.worker-cli-output')[0];
    f.edit('lush help'); f.root.update({ ...task, status: 'running' });
    expect(f.root.querySelectorAll('.worker-cli-output')[0]).toBe(output); expect(output.textContent).toBe('ready');
    expect(f.input.value).toBe('lush help');
  } finally { hold.resolve(); f.cleanup(); await pending; }
});

test('changing Worker invalidates late preview and late execution without polluting the new panel', async () => {
  for (const phase of ['preview', 'execute']) {
    const hold = gate(), f = mount({
      preview: async command => { if (phase === 'preview') await hold.promise; return plan(command); },
      execute: async () => { f.requests.push('execute'); await hold.promise; return outcome({ stdout: 'old worker secret' }); },
    }); let pending;
    try {
      f.edit('lush status'); pending = f.click(); await Promise.resolve();
      f.root.update({ ...task, id: 884, worker_number: 'W324-3', workspace: '/new/workspace' });
      f.edit('lush help'); hold.resolve(); await pending;
      expect(f.input.value).toBe('lush help'); expect(f.status.textContent).toBe('');
      expect(deepText(f.root)).not.toContain('old worker secret'); expect(deepText(f.root)).not.toContain(task.workspace);
      if (phase === 'preview') expect(f.requests).toEqual([]);
    } finally { hold.resolve(); f.cleanup(); await pending; }
  }
});

test('switching Worker during confirmation closes it and rejects a stale confirm button', async () => {
  const f = mount({ preview: async command => plan(command, { kind: 'write', requires_confirmation: true }) }); let pending;
  try {
    f.edit('lush status'); pending = f.click(); await Promise.resolve(); const oldConfirm = dialogButton(f.dom, '确认执行');
    f.root.update({ ...task, id: 884, worker_number: 'W324-3' }); await oldConfirm.onclick(); await pending;
    expect(f.requests).toEqual([]); expect(f.status.textContent).toBe(''); expect(f.dom.node('modal').hidden).toBe(true);
  } finally { f.cleanup(); await pending; }
});

test('late rejection after Worker change cannot overwrite the new status', async () => {
  const hold = gate(); const f = mount({ preview: async () => { await hold.promise; throw Error('old error'); } }); let pending;
  try {
    f.edit('lush status'); pending = f.click(); f.root.update({ ...task, id: 884 });
    hold.resolve(); await pending; expect(f.status.textContent).toBe(''); expect(f.requests).toEqual([]);
  } finally { hold.resolve(); f.cleanup(); await pending; }
});

test('workspace removal invalidates pending preview, fails closed and never falls back to project', async () => {
  const hold = gate(), f = mount({ preview: async command => { await hold.promise; return plan(command); } }); let pending;
  try {
    f.edit('lush status'); pending = f.click(); f.root.update({ ...task, workspace: null }); hold.resolve(); await pending;
    expect(f.run.disabled).toBe(true); expect(f.input.disabled).toBe(true); expect(f.requests).toEqual([]);
    expect(deepText(f.root)).toContain('不会回落到项目目录'); expect(f.input.value).toBe('lush status');
    expect(f.run.parentNode.classList.contains('help-host')).toBe(true); expect(f.run.parentNode.dataset.help).toContain('不可用');
  } finally { hold.resolve(); f.cleanup(); await pending; }
});

test('missing workspace, non-development kind and absent adapters all have accessible disabled explanations', async () => {
  for (const snapshot of [{ ...task, workspace: null }, { ...task, workspace: ' ' }, { ...task, task_kind: 'management' },
    { ...task, task_kind: 'owner' }, { ...task, task_kind: null }, { ...task, id: null }, { ...task, execution_retired: true }]) {
    const f = mount({}, snapshot);
    try {
      f.edit('lush status'); await f.click(); expect(f.requests).toEqual([]);
      expect(f.run.disabled).toBe(true); expect(f.input.disabled).toBe(true);
      expect(f.run.parentNode.dataset.help.length).toBeGreaterThan(0); expect(f.run.parentNode.getAttribute('tabindex')).toBe('0');
    } finally { f.cleanup(); }
  }
  const f = mount({ preview: null, execute: null }, { ...task, task_kind: 'order', worker_number: null });
  try { expect(deepText(f.root)).toContain('#883'); expect(deepText(f.root)).toContain('尚未连接'); }
  finally { f.cleanup(); }
});

test('dispose cleans handlers and invalidates late preview/execution; repeated disposal/update are harmless', async () => {
  for (const phase of ['preview', 'execute']) {
    const hold = gate(), f = mount({ preview: async command => { if (phase === 'preview') await hold.promise; return plan(command); },
      execute: async () => { f.requests.push('execute'); await hold.promise; return outcome({ stdout: 'late output' }); } }); let pending;
    try {
      f.edit('lush status'); pending = f.click(); await Promise.resolve(); f.root.dispose(); f.root.dispose();
      const oldStatus = f.status.textContent; f.root.update({ ...task, id: 884 }); hold.resolve(); await pending;
      expect(f.status.textContent).toBe(oldStatus); expect(deepText(f.root)).not.toContain('late output');
      expect(f.input.listeners.input).toHaveLength(0); expect(f.input.listeners.keydown).toHaveLength(0); expect(f.run.listeners.click).toHaveLength(0);
      for (const node of f.root.querySelector('.worker-cli-examples').querySelectorAll('button')) expect(node.listeners.click).toHaveLength(0);
      expect(f.run.disabled).toBe(true); if (phase === 'preview') expect(f.requests).toEqual([]);
    } finally { hold.resolve(); f.cleanup(); await pending; }
  }
});

test('dispose closes its own pending confirmation but never a replacement feature dialog', async () => {
  const f = mount({ preview: async command => plan(command, { requires_confirmation: true }) }); let pending, replacement;
  try {
    f.edit('lush status'); pending = f.click(); await Promise.resolve(); f.root.dispose(); await pending;
    expect(f.dom.node('modal').hidden).toBe(true); expect(f.requests).toEqual([]);
  } finally { f.cleanup(); await pending; }
  const g = mount({ preview: async command => plan(command, { requires_confirmation: true }) });
  try {
    g.edit('lush status'); pending = g.click(); await Promise.resolve();
    replacement = confirmDialog({ title: '其他功能确认' }); g.root.dispose(); await pending;
    expect(dialogText(g.dom)).toContain('其他功能确认'); expect(g.dom.node('modal').hidden).toBe(false);
    await dialogButton(g.dom, '取消').onclick(); await replacement;
  } finally { g.cleanup(); await pending; await replacement; }
});

test('long output remains exact plain text and CSS constrains narrow layout without wrapping output', async () => {
  const long = `${'x'.repeat(20000)}\n${'<b>not html</b>\n'.repeat(500)}`;
  const f = mount({ execute: async () => outcome({ stdout: long, truncated: true }) });
  try {
    f.edit('lush status'); await f.click(); expect(f.root.querySelectorAll('.worker-cli-output')[0].textContent).toBe(long);
    const css = fs.readFileSync(new URL('../../src/ui/web/assets/styles-worker-cli.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.worker-cli-workspace\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.worker-cli-output,[\s\S]*?overflow-x:\s*auto;[\s\S]*?white-space:\s*pre;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*600px\)[\s\S]*flex-direction:\s*column/);
    expect(css).toContain('min-width: 0;'); expect(css).toContain('min-height: 44px;');
    expect(css).toContain('var(--line)'); expect(css).not.toContain('var(--border)');
  } finally { f.cleanup(); }
});
