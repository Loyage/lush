import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { openTranscriptTerminal, closeTranscriptTerminal } from '../../src/ui/web/assets/transcript-terminal.js';
import { renderAgent } from '../../src/ui/web/assets/render-agent.js';
import { ui, transcriptCache, transcriptOpen } from '../../src/ui/web/assets/state.js';
import { assertAllowed } from '../../src/rpc/registry.js';

const response = data => new Response(JSON.stringify(data));
const step = (seq, body, extra = {}) => ({ seq, kind: 'result', title: 'bash', file: 'session-a', line: seq, body, body_length: body.length, offset: 0, ...extra });
const page = (steps, next_seq, has_more = false, next_offset = 0) => ({ steps, files: ['session-a'], next_seq, next_offset, has_more });

test('terminal reads bounded full-text pages in order, preserves nodes and scroll, closes to the original focus', async () => {
  const requests = [];
  const pages = [page([step(1, 'first\n<script>bad()</script>'), step(2, JSON.stringify({ command: 'echo one\necho two', edits: [{ oldText: 'before\nline two', newText: 'after\nline two' }] }), { kind: 'tool' })], 3, true),
    page([step(3, 'failed\noutput', { is_error: true, file: 'session-b' })], 4), page([], 4)];
  const dom = installDom({ fetch: async (url, options) => { requests.push([String(url), options]); return response(pages.shift()); } });
  try {
    const trigger = dom.document.createElement('button'); trigger.focus(); dom.node('detail').scrollTop = 420;
    await openTranscriptTerminal(31);
    const panel = dom.document.body.querySelector('.terminal-dialog'), viewport = panel.querySelector('.terminal-viewport');
    viewport.scrollTop = 240;
    const first = panel.querySelector('.terminal-record');
    expect(ui.terminalOpen).toBe(true); expect(dom.node('project-app').inert).toBe(true);
    expect(deepText(panel)).toContain('不是 Pi 原生终端');
    expect(deepText(panel)).toContain('echo one\necho two');
    expect(deepText(panel)).toContain('before\n    line two');
    expect(deepText(panel)).toContain('after\n    line two');
    expect(panel.querySelector('script')).toBeNull();
    expect(panel.querySelector('.terminal-text').textContent).toContain('<script>bad()</script>');
    expect(panel.querySelector('.content-expand')).toBeNull();
    await findByText(panel, '继续读取后续记录').onclick();
    expect(requests[1][0]).toContain('seq=3&offset=0');
    expect(panel.querySelector('.terminal-record')).toBe(first);
    expect(viewport.scrollTop).toBe(240);
    expect(panel.querySelectorAll('.terminal-session')).toHaveLength(2);
    expect(deepText(panel.querySelector('.terminal-failed'))).toContain('失败');
    await [...panel.querySelectorAll('button')].find(node => node.textContent === '检查新记录').onclick();
    expect(panel.querySelectorAll('.terminal-record')).toHaveLength(3);
    panel.onkeydown({ key: 'Escape', preventDefault() {} });
    expect(ui.terminalOpen).toBe(false); expect(dom.node('project-app').inert).not.toBe(true);
    expect(dom.document.activeElement).toBe(trigger); expect(dom.node('detail').scrollTop).toBe(420);
    expect(requests.every(([url]) => url.includes('/transcript-page?'))).toBe(true);
  } finally { closeTranscriptTerminal(); dom.restore(); }
});

test('terminal failure retries unchanged cursor, partial JSON stays raw, and navigation invalidates pending responses', async () => {
  let calls = 0, finish;
  const dom = installDom({ fetch: async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: 'offline' }), { status: 500 });
    if (calls === 2) return response(page([step(88, '{"command":"head', { kind: 'tool', body_length: 30000 })], 88, true, 15));
    return new Promise(resolve => { finish = resolve; });
  } });
  try {
    await openTranscriptTerminal(32, 88);
    const panel = dom.document.body.querySelector('.terminal-dialog');
    expect(deepText(panel)).toContain('读取未完成：offline');
    await findByText(panel, '重试读取').onclick();
    expect(panel.querySelector('.terminal-text').textContent).toBe('{"command":"head');
    expect(deepText(panel)).toContain('原文分段');
    expect(findByText(panel, '前 50 步').hidden).toBe(false);
    const pending = findByText(panel, '继续读取后续记录').onclick();
    await dom.fire('hashchange');
    finish(response(page([step(88, 'late')], 89)));
    await pending;
    expect(dom.document.body.querySelector('.terminal-dialog')).toBeNull();
    expect(deepText(panel)).not.toContain('late');
  } finally { closeTranscriptTerminal(); dom.restore(); }
});

test('process starts collapsed even with cached records; only user expansion is remembered across redraws', async () => {
  const dom = installDom(); const id = 998;
  transcriptCache.set(id, { steps: [step(1, 'body')], files: ['session-a'], next: 1 });
  try {
    const task = { id }, usage = { files: ['session-a'], totals: {} };
    const first = renderAgent(task, usage);
    dom.node('detail').append(first);
    expect(first.querySelector('.transcript').hidden).toBe(true);
    expect(first.querySelector('.step')).toBeNull();
    await findByText(first, '展开执行过程').onclick();
    const holder = first.querySelector('.transcript');
    expect(holder.hidden).toBe(false); expect(holder.querySelector('.step')).toBeTruthy();
    expect(renderAgent(task, usage, holder).querySelector('.transcript').hidden).toBe(false);
    await findByText(first, '收起执行过程').onclick();
    expect(renderAgent(task, usage, holder).querySelector('.transcript').hidden).toBe(true);
    const list = holder.querySelector('[data-live="transcript-steps"]');
    await findByText(first, '展开执行过程').onclick();
    expect(holder.querySelector('[data-live="transcript-steps"]')).toBe(list);
    expect(renderAgent({ id: 999 }, usage).querySelector('.transcript').hidden).toBe(true);
  } finally { transcriptCache.delete(id); transcriptOpen.delete(id); dom.restore(); }
});

test('continuous transcript read is user-only', () => {
  expect(() => assertAllowed('task.transcript_page', { id: 1, seq: 1, offset: 0 }, 7)).toThrow('not an agent');
  expect(() => assertAllowed('task.transcript_page', { id: 1, seq: 1, offset: 0 }, null)).not.toThrow();
});

test('agent panel shows the follow command inline and copies it from a button', async () => {
  const dom = installDom();
  const copied = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async text => { copied.push(text); } } }, configurable: true });
  try {
    const panel = renderAgent({ id: 77, agent: { id: 5, active: true, pid: 1, wakes: 2, backend: 'pi' } }, { files: [] });
    const row = panel.querySelector('.terminal-command');
    expect(row).toBeTruthy();
    expect(deepText(row)).toContain('lush task transcript 77 --follow');
    await findByText(row, '复制命令').onclick();
    expect(copied).toEqual(['lush task transcript 77 --follow']);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator;
    dom.restore();
  }
});
