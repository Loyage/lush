import { test, expect } from 'bun:test';
import { loadNativePi } from '../src/cli/native-pi.js';
import { NativeRecordView, watchWorker, sanitizeTerminalText } from '../src/cli/native-watch.js';

// Explicit opt-in evidence; normal tests never require a globally installed Pi.
const smoke = process.env.LUSH_NATIVE_PI_SMOKE === '1' ? test : test.skip;
smoke('installed public Pi components, built-in renderers, narrow Chinese layouts and terminal cleanup (not PTY)', async () => {
  const runtime = await loadNativePi(process.env);
  console.log(`native Pi smoke module: ${runtime.entry}`);
  const terminal = { rows: 24, columns: 80, kittyProtocolActive: false, writes: [], stopped: 0,
    write(data) { this.writes.push(data); }, start(input, resize) { this.input = input; this.resize = resize; }, stop() { this.stopped++; },
    hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, moveBy() {},
    setTitle() {}, setProgress() {}, drainInput: async () => {} };
  const renderingErrors = [];
  const view = new NativeRecordView(runtime, { requestRender() {} }, terminal, error => { if (error) renderingErrors.push(error); }, undefined, 'W7');
  let seq = 0;
  const add = (kind, body, extra = {}) => view.add({ seq: ++seq, kind, body, file: 'fixture.jsonl', line: seq, title: kind, ...extra });
  add('input', '中文用户 **请求**\n第二行'); add('thinking', '检查接口与 `只读` 边界'); add('text', '## 回答\n中文 **宽字符** 😀\n```js\nconst value = 1;\n```');
  for (const name of ['read', 'bash', 'edit', 'write', 'unknown']) {
    add('tool', JSON.stringify({ command: 'printf 中文\n\x1b]52;c;log-injection\x07', path: '/this-file-must-not-be-read',
      content: '历史正文', edits: [{ oldText: '旧', newText: '新' }] }), { call_id: name, tool_name: name });
    add('result', '完成记录\n第二行', { call_id: name, tool_name: name, is_error: name === 'unknown' });
  }
  for (const width of [80, 40, 20, 8, 1]) {
    view.invalidate();
    const lines = view.render(width);
    expect(lines).toHaveLength(24);
    for (const line of lines) expect(runtime.tui.visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(lines.join('\n')).not.toContain('log-injection');
  }
  expect(renderingErrors).toEqual([]);
  view.handleInput('\x0f'); view.handleInput('\x1b[H');
  expect(view.expanded).toBe(true); expect(view.following).toBe(false);
  expect(sanitizeTerminalText(view.render(80).join('\n'))).toContain('中文用户');
  let reads = 0;
  await watchWorker({ config: {}, request: async () => { reads++; return { steps: [], next_seq: 1, next_offset: 0, has_more: false }; } }, 7,
    { runtime, terminal, stdin: { isTTY: true }, stdout: { isTTY: true }, sleep: async () => { terminal.input('q'); } });
  expect(reads).toBe(1); expect(terminal.stopped).toBe(1);
});
