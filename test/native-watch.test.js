import { test, expect } from 'bun:test';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UIClient } from '../src/ui/client.js';
import { watchWorker, RecordAssembler, NativeRecordView, WATCH_LIMITS, sanitizeTerminalText } from '../src/cli/native-watch.js';
import { transcriptPage } from '../src/core/transcript-reader.js';
import { sessionFixture, sessionFile } from './session-fixture.js';

function fixture() {
  const instances = [], tools = [], messages = [];
  class Text { constructor(text) { this.text = text; } render() { return this.text.split('\n'); } invalidate() {} }
  class Container { constructor() { this.children = []; } addChild(child) { this.children.push(child); } render(width) { return this.children.flatMap(child => child.render(width)); } invalidate() {} }
  class Assistant extends Text { constructor(message) { messages.push(message); super(message.content.map(part => part.text ?? part.thinking).join('\n')); } }
  class User extends Text { constructor(text) { messages.push(text); super(text); } }
  class Tool extends Text {
    constructor(name, id, args, options, definition) { super(`tool ${name} ${JSON.stringify(args)}`); Object.assign(this, { name, id, args, options, definition }); tools.push(this); }
    setArgsComplete() {} updateResult(result) { this.result = result; } setExpanded(expanded) { this.expanded = expanded; }
    render() { return [this.text, ...(this.result ? this.result.content.map(part => part.text) : [])]; }
  }
  const terminal = { rows: 16, columns: 80, started: 0, stopped: 0,
    start(input, resize) { this.started++; this.input = input; this.resize = resize; }, stop() { this.stopped++; } };
  // Dependency-free fixture for the public layout API. Real Pi layout/mouse routing is
  // covered by opt-in smoke; unit fixtures focus on read, pairing and record-local anchors.
  class ScrollView {
    constructor(child) { this.child = child; this.scrollTop = 0; this.viewportHeight = 0; this.isFollowingEnd = true; this.contentHeight = 0; }
    getContentWidth(width) { return width > 1 ? width - 1 : width; }
    updateLayout(height, viewport) {
      this.contentHeight = height; this.viewportHeight = viewport;
      this.scrollTop = this.isFollowingEnd ? Math.max(0, height - viewport) : Math.min(this.scrollTop, Math.max(0, height - viewport));
    }
    scrollTo(top, options = {}) {
      this.scrollTop = Math.max(0, Math.min(Math.max(0, this.contentHeight - this.viewportHeight), top));
      this.isFollowingEnd = !options.disableFollow && this.scrollTop === Math.max(0, this.contentHeight - this.viewportHeight);
    }
    scrollToEnd() { this.scrollTo(this.contentHeight); }
    scrollBy(delta) { this.scrollTo(this.scrollTop + delta); }
  }
  class VStack { constructor(entries) { this.entries = entries; } }
  const screen = (view, width = terminal.columns) => {
    const height = Math.max(1, terminal.rows - (terminal.rows >= 2 ? 1 : 0) - (terminal.rows >= 4 ? 1 : 0));
    const lines = view.render(view.scroll.getContentWidth(width));
    view.scroll.updateLayout(lines.length, height);
    return [...(terminal.rows >= 2 ? view.header.render(width) : []), ...lines.slice(view.top, view.top + height),
      ...(terminal.rows >= 4 ? view.footer.render(width) : [])];
  };
  class TUI {
    constructor(term) { this.terminal = term; instances.push(this); } setLayoutRoot(root) { this.root = root; } setFocus(view) { this.focus = this.view = view; }
    start() { this.terminal.start(data => this.focus.handleInput(data), () => this.requestRender()); this.requestRender(); }
    requestRender() { this.output = screen(this.view); }
    stop(options) { this.stopOptions = options; this.stopped = true; this.terminal.stop(); }
  }
  const keyMap = { 'ctrl+c': '\x03', escape: '\x1b', 'ctrl+o': '\x0f', up: '\x1b[A', down: '\x1b[B',
    pageUp: '\x1b[5~', pageDown: '\x1b[6~', home: '\x1b[H', end: '\x1b[F' };
  const runtime = { pi: { UserMessageComponent: User, AssistantMessageComponent: Assistant, ToolExecutionComponent: Tool },
    tui: { Text, Container, ScrollView, VStack, TuiAltScreen: TUI, matchesKey: (data, key) => data === keyMap[key], truncateToWidth: text => text }, renderers: new Map() };
  return { runtime, terminal, instances, tools, messages, screen, options: { runtime, terminal, stdin: { isTTY: true }, stdout: { isTTY: true } } };
}
function segment(seq, body, extra = {}) { return { seq, kind: 'text', title: '回答', file: 'a.jsonl', line: seq, body, body_length: body.length, offset: 0, ...extra }; }
function page(steps, seq, offset = 0, more = false) { return { steps, next_seq: seq, next_offset: offset, has_more: more, files: [] }; }
function reader(pages) {
  const requests = [];
  return { requests, config: { env: {} }, async request(method, params) { requests.push({ method, ...params }); if (!pages.length) throw Error('unexpected request'); return pages.shift(); } };
}

test('cross-page reassembly retains all original characters, uses exact cursor, and includes next session', async () => {
  const f = fixture(), signal = new AbortController();
  const c = reader([page([segment(1, '中\n', { body_length: 6 })], 1, 2, true),
    page([segment(1, '文\t😀', { offset: 2, body_length: 6 }), segment(2, 'next', { file: 'b.jsonl' })], 3)]);
  let sleeps = 0;
  await watchWorker(c, 7, { ...f.options, signal: signal.signal, sleep: async () => { if (++sleeps === 2) signal.abort(); } });
  expect(f.messages.map(message => message.content[0].text)).toEqual(['中\n文\t😀', 'next']);
  expect(c.requests).toEqual([{ method: 'worker.transcript_page', id: 7, seq: 1, offset: 0 }, { method: 'worker.transcript_page', id: 7, seq: 1, offset: 2 }]);
  expect(f.terminal.stopped).toBe(1);
});

test('after starts exactly at after+1, reassembles pages and persistently discloses skipped history', async () => {
  const f = fixture(), signal = new AbortController();
  const c = reader([page([segment(8, 'unpaired', { kind: 'result', call_id: 'skipped-call', tool_name: 'bash' }),
    segment(9, 'ab', { body_length: 4 })], 9, 2, true), page([segment(9, 'cd', { offset: 2, body_length: 4 })], 10), page([], 10)]);
  let sleeps = 0;
  await watchWorker(c, 7, { ...f.options, after: 7, limits: { records: 2 }, signal: signal.signal,
    sleep: async () => { if (++sleeps === 3) signal.abort(); } });
  expect(c.requests.map(request => [request.seq, request.offset])).toEqual([[8, 0], [9, 2], [10, 0]]);
  const view = f.instances[0].view;
  expect(view.items.map(item => item.step.seq)).toEqual([8, 9]);
  expect(view.items[0].hidden).toBe(false); expect(view.items[0].result).toBeNull();
  expect(f.tools).toEqual([]); expect(f.messages[0].content[0].text).toBe('abcd');
  expect(view.header.render(80).join('\n')).toContain('已跳过前 7 步');
  view.handleInput('?'); expect(view.header.render(80).join('\n')).toContain('已跳过前 7 步');
});

test('after empty scans keep the explicit future cursor instead of guessing newest or exiting', async () => {
  const f = fixture(), signal = new AbortController(), c = reader([page([], 51), page([], 51)]);
  let sleeps = 0;
  await watchWorker(c, 1, { ...f.options, after: 50, signal: signal.signal, sleep: async () => { if (++sleeps === 2) signal.abort(); } });
  expect(c.requests.map(request => request.seq)).toEqual([51, 51]);
  expect(f.instances[0].output.join('\n')).toContain('已跳过前 50 步');
  expect(f.instances[0].output.join('\n')).toContain('继续等待');
});

test('after strictly rejects invalid/overflowing cursors before loading Pi, reading or attaching handlers', async () => {
  const f = fixture(), c = reader([]), signal = new AbortController(), before = process.listenerCount('SIGINT');
  for (const after of [-1, 1.5, '1', null, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(watchWorker(c, 1, { ...f.options, after, signal: signal.signal })).rejects.toThrow('after');
  }
  expect(c.requests).toEqual([]); expect(f.terminal.started).toBe(0);
  expect(process.listenerCount('SIGINT')).toBe(before); expect(getEventListeners(signal.signal, 'abort')).toHaveLength(0);
  await watchWorker(c, 1, { ...f.options, after: 0, signal: AbortSignal.abort() });
  const upper = reader([page([], Number.MAX_SAFE_INTEGER)]);
  await watchWorker(upper, 1, { ...f.options, after: Number.MAX_SAFE_INTEGER - 1, sleep: async () => { f.terminal.input('q'); } });
  expect(upper.requests[0].seq).toBe(Number.MAX_SAFE_INTEGER);
});

test('real transcript_page after skips oversized earlier viewer bodies without spending local caps', async () => {
  const world = sessionFixture(), f = fixture();
  const record = text => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  try {
    sessionFile(world.root, 7, [record('x'.repeat(WATCH_LIMITS.body + 1)), record('selected')]);
    const requests = [];
    const c = { request: async (method, params) => { requests.push({ method, ...params }); return transcriptPage(world.config, params.id, params.seq, params.offset); } };
    await watchWorker(c, 7, { ...f.options, after: 1, limits: { records: 1 }, sleep: async () => { f.terminal.input('q'); } });
    expect(requests).toEqual([{ method: 'worker.transcript_page', id: 7, seq: 2, offset: 0 }]);
    expect(f.messages).toHaveLength(1); expect(f.messages[0].content[0].text).toBe('selected');
    expect(f.instances[0].view.items[0].step.seq).toBe(2);
  } finally { world.close(); }
});

test('real transcript_page projection, 96K page boundary, cross-page tool pairing and appended invocation', async () => {
  const world = sessionFixture(), f = fixture(), signal = new AbortController(), requests = [];
  const body = '中文\n'.repeat(33000);
  const record = message => ({ type: 'message', message });
  try {
    sessionFile(world.root, 7, [record({ role: 'assistant', content: [{ type: 'toolCall', id: 'same-id', name: 'bash', arguments: { command: 'echo 中文' } }] }),
      record({ role: 'toolResult', toolCallId: 'same-id', toolName: 'bash', isError: false, content: [{ type: 'text', text: body }] })]);
    const client = { request: async (method, params) => { requests.push({ method, ...params }); return transcriptPage(world.config, params.id, params.seq, params.offset); } };
    let tails = 0;
    await watchWorker(client, 7, { ...f.options, signal: signal.signal, sleep: async ms => {
      if (ms === 0) return;
      if (++tails === 1) sessionFile(world.root, 7, [record({ role: 'assistant', content: [{ type: 'toolCall', id: 'same-id', name: 'bash', arguments: { command: 'second' } }] }),
        record({ role: 'toolResult', toolCallId: 'same-id', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'failure' }] })], '2026-01-02_lush-task-7.jsonl');
      else signal.abort();
    } });
    expect(requests).toHaveLength(3);
    expect(requests[1].seq).toBe(2); expect(requests[1].offset).toBeGreaterThan(0);
    const calls = f.instances[0].view.items.filter(item => item.step.kind === 'tool');
    expect(calls).toHaveLength(2); expect(calls[0].tool.result.content[0].text).toBe(body); expect(calls[1].tool.result.isError).toBe(true);
  } finally { world.close(); }
});

test('empty scans keep waiting at the same cursor, then show new files without latest/tail skipping', async () => {
  const f = fixture(), signal = new AbortController(), waits = [];
  const c = reader([page([], 1), page([], 1), page([segment(1, 'first', { file: 'new.jsonl' })], 2), page([], 2)]);
  await watchWorker(c, 1, { ...f.options, signal: signal.signal, sleep: async ms => { waits.push(ms); if (waits.length === 4) signal.abort(); } });
  expect(c.requests.map(request => request.seq)).toEqual([1, 1, 1, 2]);
  expect(waits).toEqual([1000, 1000, 1000, 1000]);
  expect(f.messages).toHaveLength(1);
  expect(f.instances[0].output.join('\n')).toContain('等待新记录');
});

test('single-flight reads and initial scans are cancellable; late response cannot render or start a new request', async () => {
  const f = fixture(), signal = new AbortController();
  let resolve, count = 0;
  const c = { config: {}, request() { count++; return new Promise(done => { resolve = done; signal.abort(); }); } };
  const before = process.listenerCount('SIGINT');
  await watchWorker(c, 3, { ...f.options, signal: signal.signal });
  expect(count).toBe(1); expect(f.terminal.stopped).toBe(1); expect(f.messages).toEqual([]);
  resolve(page([segment(1, 'late')], 2)); await Promise.resolve();
  expect(f.messages).toEqual([]); expect(count).toBe(1);
  expect(process.listenerCount('SIGINT')).toBe(before);
  expect(getEventListeners(signal.signal, 'abort')).toHaveLength(0);
});

test('optional transport signal releases an in-flight read without adding RPC parameters', async () => {
  const f = fixture(); let closed = false, params;
  const client = { request(_method, value, transport) {
    params = value;
    return new Promise((_resolve, reject) => {
      transport.signal.addEventListener('abort', () => { closed = true; reject(Error('transport cancelled')); }, { once: true });
      f.terminal.input('q');
    });
  } };
  await watchWorker(client, 9, f.options);
  expect(params).toEqual({ id: 9, seq: 1, offset: 0 }); expect(closed).toBe(true); expect(f.terminal.stopped).toBe(1);
});

test('viewer exit through real UIClient closes the fixed-parent cancellable socket without stopping Worker', async () => {
  const f = fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-native-cancel-'));
  const socket = path.join(root, 'rpc.sock'), requests = [], closed = Promise.withResolvers();
  let frame = '';
  const server = Bun.listen({ unix: socket, socket: {
    data(_handle, bytes) {
      frame += bytes.toString();
      if (!frame.includes('\n')) return;
      requests.push(JSON.parse(frame.slice(0, frame.indexOf('\n'))));
      f.terminal.input('q'); // A read is already dispatched; never reply, so cancellation must close it.
    },
    close() { closed.resolve(); }, error() {},
  } });
  try {
    const started = performance.now();
    await watchWorker(new UIClient({ socket }), 7, f.options);
    await closed.promise;
    expect(performance.now() - started).toBeLessThan(1000);
    expect(requests).toEqual([{ jsonrpc: '2.0', id: 1, method: 'worker.transcript_page', params: { id: 7, seq: 1, offset: 0 } }]);
    expect(f.terminal.stopped).toBe(1); expect(f.messages).toEqual([]);
  } finally { server.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});

test('terminal startup failure cleans raw terminal and signal handlers', async () => {
  const f = fixture(), Original = f.runtime.tui.TuiAltScreen;
  f.runtime.tui.TuiAltScreen = class extends Original { start() { super.start(); throw Error('terminal startup failed'); } };
  const before = process.listenerCount('SIGINT');
  await expect(watchWorker(reader([]), 1, f.options)).rejects.toThrow('terminal startup failed');
  expect(f.terminal.stopped).toBe(1); expect(process.listenerCount('SIGINT')).toBe(before);
});

for (const key of ['q', '\x03', '\x1b']) test(`exit ${JSON.stringify(key)} only stops reader and cleans pending sleep`, async () => {
  const f = fixture(), c = reader([page([], 1)]);
  await watchWorker(c, 1, { ...f.options, sleep: async () => { f.terminal.input(key); } });
  expect(c.requests).toHaveLength(1); expect(f.terminal.stopped).toBe(1);
});

test('pre-abort does not load runtime or enter terminal', async () => {
  const f = fixture(), signal = new AbortController(); signal.abort();
  await watchWorker(reader([]), 1, { ...f.options, signal: signal.signal });
  expect(f.terminal.started).toBe(0);
});

test('permissions and nonTTY are rejected before any read or Pi load, even with injected reader', async () => {
  const f = fixture(), c = reader([]);
  for (const token of ['', 'agent']) await expect(watchWorker({ token }, 1, f.options)).rejects.toThrow('token');
  await expect(watchWorker(c, 1, { ...f.options, client: { token: 'agent' } })).rejects.toThrow('token');
  await expect(watchWorker(c, 1, { ...f.options, stdin: { isTTY: false } })).rejects.toThrow('TTY');
  await expect(watchWorker(c, 1, { ...f.options, stdout: { isTTY: false } })).rejects.toThrow('TTY');
  expect(f.terminal.started).toBe(0); expect(c.requests).toEqual([]);
});

test('read errors are visible, sanitized, never retried, and finally restore terminal/listeners', async () => {
  const f = fixture(); let count = 0;
  const before = process.listenerCount('SIGTERM');
  await expect(watchWorker({ request: async () => { count++; throw Error('rpc \x1b]52;clipboard\x07failed'); } }, 1, f.options)).rejects.toThrow('rpc failed');
  expect(count).toBe(1); expect(f.terminal.stopped).toBe(1); expect(process.listenerCount('SIGTERM')).toBe(before);
});

test('body/history/record/render limits and malformed cursors fail instead of growing forever', async () => {
  const tests = [
    { pages: [page([segment(1, '12345')], 2)], limits: { body: 4 }, error: '正文超过' },
    { pages: [page([segment(1, 'x')], 2)], limits: { history: 1 }, error: '历史超过' },
    { pages: [page([segment(1, 'a'), segment(2, 'b')], 3)], limits: { records: 1 }, error: '历史超过' },
    { pages: [page([segment(1, 'a\nb\nc')], 2)], limits: { lines: 2 }, error: '渲染超过' },
    { pages: [page([segment(1, 'a')], 1)], error: '游标' },
    { pages: [page([], 1, 0, true)], error: '游标' },
  ];
  for (const scenario of tests) {
    const f = fixture(), c = reader(scenario.pages);
    await expect(watchWorker(c, 1, { ...f.options, limits: scenario.limits })).rejects.toThrow(scenario.error);
    expect(f.terminal.stopped).toBe(1); expect(c.requests).toHaveLength(1);
  }
});

test('assembler refuses missing segments, cross-page identity changes and nonprogress segments', () => {
  const assembler = new RecordAssembler();
  assembler.push(segment(1, 'ab', { body_length: 4 }));
  expect(() => assembler.push(segment(1, 'cd', { offset: 3, body_length: 4 }))).toThrow('分页');
  expect(() => assembler.push(segment(1, 'cd', { offset: 2, body_length: 4, file: 'b' }))).toThrow('身份');
  expect(() => new RecordAssembler().push(segment(1, '', { body_length: 2 }))).toThrow('分页');
  expect(() => new RecordAssembler().push(segment(2, 'x'))).toThrow('分页');
});

test('pair by file and call_id across pages, preserve unmatched/errors, and undo duplicate identities conservatively', () => {
  const f = fixture(), view = new NativeRecordView(f.runtime, { requestRender() {} }, f.terminal, () => {});
  const tool = (seq, id, file = 'a.jsonl') => segment(seq, '{"command":"echo ok"}', { kind: 'tool', call_id: id, tool_name: 'bash', file });
  const result = (seq, id, file = 'a.jsonl', is_error = false) => segment(seq, 'output', { kind: 'result', call_id: id, tool_name: 'bash', file, is_error });
  view.add(tool(1, 'id')); view.add(result(2, 'id', 'b.jsonl', true));
  expect(view.items[0].result).toBeNull(); expect(view.items[1].hidden).toBe(false);
  view.add(result(3, 'id'));
  expect(view.items[0].tool.result.isError).toBe(false); expect(view.items[2].hidden).toBe(true);
  view.add(tool(4, 'id'));
  expect(view.items[0].result).toBeNull(); expect(view.items[2].hidden).toBe(false);
  expect(view.items[0].tool.result).toBeUndefined(); expect(view.render(80).join('\n')).toContain('重复调用身份');
  view.add(tool(5, null)); view.add(result(6, null));
  expect(view.items[4].result).toBeNull(); expect(view.items[5].hidden).toBe(false);
  view.add(result(7, 'reverse', 'c.jsonl', true)); view.add(tool(8, 'reverse', 'c.jsonl'));
  expect(view.items[7].tool.result.isError).toBe(true); expect(view.items[6].hidden).toBe(true);
});

test('duplicate results and tool-name mismatch never synthesize success', () => {
  const f = fixture(), view = new NativeRecordView(f.runtime, { requestRender() {} }, f.terminal, () => {});
  view.add(segment(1, '{}', { kind: 'tool', tool_name: 'read', call_id: 'id' }));
  view.add(segment(2, 'one', { kind: 'result', tool_name: 'write', call_id: 'id' }));
  expect(view.items[0].result).toBeNull();
  view.add(segment(3, 'two', { kind: 'result', tool_name: 'read', call_id: 'id' }));
  expect(view.items.every(item => !item.hidden && !item.result)).toBe(true);
});

test('sanitize command arguments after JSON decode; unknown tools fall back; malformed JSON stays raw', () => {
  const f = fixture(), view = new NativeRecordView(f.runtime, { requestRender() {} }, f.terminal, () => {});
  view.add(segment(1, JSON.stringify({ command: 'echo\n\t\x1b[2Jok\x1b]52;c;secret\x07', nested: { '\x00key': '\x9b31mred' } }), { kind: 'tool', tool_name: 'custom' }));
  expect(f.tools[0].args.command).toBe('echo\n\tok');
  expect(f.tools[0].args.nested).toEqual({ key: 'red' }); expect(f.tools[0].definition).toBeUndefined(); expect(f.tools[0].options.showImages).toBe(false);
  view.add(segment(2, '{not json', { kind: 'tool' }));
  expect(view.render(80).join('\n')).toContain('参数不是完整 JSON');
  expect(sanitizeTerminalText('A\x1b]title\x1b\\B\x1bPpayload\x1b\\C\r\b\x00\x9d8;url\x9cD\n\t中')).toBe('ABCD\n\t中');
});

test('Ctrl-O expands tools; navigation pauses and anchors old content through appended pairs and resize', () => {
  const f = fixture(), ui = { requestRender() {} }, view = new NativeRecordView(f.runtime, ui, f.terminal, () => {}, WATCH_LIMITS, 'W7');
  for (let seq = 1; seq <= 20; seq++) view.add(segment(seq, `record-${seq}`));
  view.add(segment(21, '{"command":"ls"}', { kind: 'tool', tool_name: 'bash' }));
  f.screen(view, 80); view.handleInput('\x0f'); expect(view.items.at(-1).tool.expanded).toBe(true);
  view.handleInput('\x1b[H'); const before = f.screen(view, 80).slice(1, -1); expect(view.following).toBe(false);
  view.add(segment(22, 'new')); expect(f.screen(view, 80).slice(1, -1)).toEqual(before);
  f.terminal.columns = 24; f.terminal.rows = 12; view.invalidate();
  expect(f.screen(view, 24).join('\n')).toContain('record-1');
  view.handleInput('?'); expect(f.screen(view, 24).join('\n')).toContain('Ctrl-O');
  view.handleInput('f'); expect(view.following).toBe(true);
});

test('SIGTERM releases only the reader; fullscreen cleanup preserves the preexisting main screen', async () => {
  const f = fixture(), c = reader([page([], 1)]), before = process.listenerCount('SIGTERM');
  await watchWorker(c, 1, { ...f.options, sleep: async () => { process.emit('SIGTERM'); } });
  expect(c.requests).toHaveLength(1); expect(f.terminal.stopped).toBe(1);
  expect(f.instances[0].stopOptions).toEqual({ preserveScreen: true });
  expect(process.listenerCount('SIGTERM')).toBe(before);
});

test('fullscreen stop failure still restores the raw terminal and reports a sanitized error', async () => {
  const f = fixture(), Original = f.runtime.tui.TuiAltScreen;
  f.runtime.tui.TuiAltScreen = class extends Original { stop() { throw Error('stop\x1b]52;c;secret\x07 failed'); } };
  await expect(watchWorker(reader([page([], 1)]), 1, { ...f.options, sleep: async () => { f.terminal.input('q'); } }))
    .rejects.toThrow('stop failed');
  expect(f.terminal.stopped).toBe(1);
});
