import { test, expect } from 'bun:test';
import { loadNativePi, watchTerminalColors } from '../src/cli/native-pi.js';
import { NativeRecordView, watchWorker, sanitizeTerminalText } from '../src/cli/native-watch.js';

// Explicit opt-in evidence; normal tests never require a globally installed Pi.
const smoke = process.env.LUSH_NATIVE_PI_SMOKE === '1' ? test : test.skip;
function terminalFixture() {
  return { rows: 24, columns: 80, kittyProtocolActive: false, writes: [], stopped: 0,
    write(data) { this.writes.push(data); }, start(input, resize) { this.input = input; this.resize = resize; }, stop() { this.stopped++; },
    hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, moveBy() {},
    setTitle() {}, setProgress() {}, drainInput: async () => {} };
}
function viewer(runtime, terminal) {
  const ui = new runtime.tui.TuiAltScreen(terminal, false, undefined, { copyOnSelect: false, wheelScrollLines: 3 });
  const errors = [];
  const view = new NativeRecordView(runtime, ui, terminal, error => { if (error) errors.push(error); }, undefined, 'W7');
  ui.setLayoutRoot(view.root); ui.setFocus(view);
  let seq = 0;
  return { ui, view, errors,
    add(kind, body, extra = {}) { const record = { seq: ++seq, kind, body, file: 'fixture.jsonl', line: seq, title: kind, ...extra }; view.add(record); return record.seq; },
    frame(width = terminal.columns, rows = terminal.rows) { terminal.columns = width; terminal.rows = rows; ui.renderNow(true); return ui.getScreenLines(); },
  };
}

smoke('installed native fullscreen, wheel, scrollbar, keyboard and resize remain bounded (not PTY)', async () => {
  const runtime = await loadNativePi(process.env), terminal = terminalFixture(), f = viewer(runtime, terminal);
  console.log(`native Pi smoke module: ${runtime.entry}`);
  f.add('input', '中文用户 **请求**\n第二行'); f.add('thinking', '检查接口与 `只读` 边界');
  f.add('text', '## 回答\n中文 **宽字符** 😀\n```js\nconst value = 1;\n```');
  for (const name of ['read', 'bash', 'edit', 'write', 'unknown']) {
    f.add('tool', JSON.stringify({ command: 'printf 中文\n\x1b]52;c;log-injection\x07', path: '/this-file-must-not-be-read',
      content: '历史正文', edits: [{ oldText: '旧', newText: '新' }] }), { call_id: name, tool_name: name });
    f.add('result', '完成记录\n第二行', { call_id: name, tool_name: name, is_error: name === 'unknown' });
  }
  f.add('text', Array.from({ length: 100 }, (_, i) => `历史中文 ${i}`).join('\n'));
  f.ui.start();
  try {
    for (const width of [80, 40, 20, 8, 1]) {
      f.view.invalidate(); const lines = f.frame(width);
      expect(lines).toHaveLength(24);
      for (const line of lines) expect(runtime.tui.visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(lines.join('\n')).not.toContain('log-injection');
    }
    f.frame(80); expect(f.view.following).toBe(true);
    expect(sanitizeTerminalText(f.ui.getScreenLines().join('\n'))).toMatch(/[┃│]/);
    const bottom = f.view.top;
    terminal.input('\x1b[<64;20;10M'); f.frame(); // Native SGR wheel up over the transcript.
    expect(f.view.top).toBeLessThan(bottom); expect(f.view.following).toBe(false);
    expect(sanitizeTerminalText(f.ui.getScreenLines()[0])).toContain('暂停阅读');
    terminal.input('\x1b[5~'); f.frame(); expect(f.view.top).toBeLessThan(bottom - 3);
    terminal.input('\x1b[H'); f.frame(); expect(f.view.top).toBe(0);
    expect(sanitizeTerminalText(f.ui.getScreenLines().join('\n'))).toContain('中文用户');
    terminal.input('\x0f'); f.frame(); expect(f.view.expanded).toBe(true);
    const anchor = f.view.layout(79)[f.view.top].seq;
    f.add('text', '新增记录不抢位置'); f.frame(); expect(f.view.layout(79)[f.view.top].seq).toBe(anchor);
    f.frame(32, 12); expect(f.view.layout(31)[f.view.top].seq).toBe(anchor);
    terminal.input('f'); f.frame(); expect(f.view.following).toBe(true);
    const chromeRows = f.view.root.entries.filter(entry => entry.component !== f.view.scroll).length;
    expect(chromeRows).toBe(2); expect(f.errors).toEqual([]);
  } finally { f.ui.stop({ preserveScreen: true }); }
  const ansi = terminal.writes.join(''); expect(ansi).toContain('\x1b[?1049h'); expect(ansi).toContain('\x1b[?1049l');
  expect(ansi).toContain('\x1b[?1006h'); expect(ansi).toContain('\x1b[?1006l');
});

smoke('system color queries, late light colors and assistant fences preserve backgrounds and native syntax', async () => {
  const runtime = await loadNativePi(process.env), terminal = terminalFixture(), f = viewer(runtime, terminal);
  f.add('text', '正文无面板\n\n```js\nconst 中文 = 123;\n\n// next\n```\n\n结束正文');
  f.add('tool', '{"command":"echo native"}', { tool_name: 'bash', call_id: 'bg' });
  f.add('result', 'native result', { tool_name: 'bash', call_id: 'bg' });
  f.ui.start();
  const colors = watchTerminalColors(runtime, f.ui, () => { f.view.invalidate(); f.ui.requestRender(); });
  try {
    await colors.ready; // No terminal replies: bounded fallback still has visible backgrounds.
    const dark = runtime.appearance.theme.getBgAnsi('toolSuccessBg');
    expect(dark).not.toBe('\x1b[49m');
    // No reply must not falsely claim a default foreground: a light terminal could
    // otherwise put its black default title/user text on a guessed dark panel.
    expect(runtime.appearance.theme.getFgAnsi('toolTitle')).not.toBe('\x1b[39m');
    expect(runtime.appearance.theme.getFgAnsi('userMessageText')).not.toBe('\x1b[39m');
    let lines = f.view.render(79);
    const code = lines.find(line => sanitizeTerminalText(line).includes('const 中文'));
    expect(code).toContain(dark); expect(code).toMatch(/\x1b\[(?:38;|3[0-7]m)/);
    expect(lines.find(line => sanitizeTerminalText(line).includes('```js'))).toContain(dark);
    expect(lines.find(line => sanitizeTerminalText(line).includes('正文无面板'))).not.toContain(dark);
    expect(lines.find(line => sanitizeTerminalText(line).includes('native result'))).toContain(dark);
    terminal.input('\x1b]11;rgb:ffff/ffff/ffff\x07'); f.frame();
    const light = runtime.appearance.theme.getBgAnsi('toolSuccessBg'); expect(light).not.toBe(dark);
    expect(runtime.appearance.theme.appearance).toBe('light');
    const foreground = runtime.tui.colorToRgb(runtime.appearance.theme.colors.toolTitle);
    expect(Math.max(foreground.r, foreground.g, foreground.b)).toBeLessThan(128);
    lines = f.view.render(31); expect(lines.find(line => sanitizeTerminalText(line).includes('const 中文'))).toContain(light);
    terminal.input('\x1b[?997;1n'); f.frame(); // Native theme notification triggers a new bounded query.
    expect(runtime.appearance.theme.appearance).toBe('dark');
    terminal.input('\x1b]11;#ffffff\x1b\\'); f.frame(); expect(runtime.appearance.theme.appearance).toBe('light');
    expect(f.errors).toEqual([]);
  } finally { colors.dispose(); f.ui.stop({ preserveScreen: true }); }
});

smoke('cross-page result growth and native expansion do not pull a paused later record to the end', async () => {
  const runtime = await loadNativePi(process.env), terminal = terminalFixture(), f = viewer(runtime, terminal);
  f.add('tool', '{"command":"echo native"}', { tool_name: 'bash', call_id: 'later-result' });
  const reading = f.add('text', Array.from({ length: 100 }, (_, i) => `正在阅读 ${i}`).join('\n'));
  f.add('text', '末尾'); f.ui.start();
  try {
    f.frame(); terminal.input('\x1b[H'); f.frame();
    f.view.scroll.scrollTo(30, { disableFollow: true }); f.frame();
    const before = f.view.layout(79)[f.view.top]; expect(before.seq).toBe(reading);
    f.add('result', Array.from({ length: 180 }, (_, i) => `迟到输出 ${i}`).join('\n'), { tool_name: 'bash', call_id: 'later-result' });
    f.frame(); expect(f.view.layout(79)[f.view.top]).toMatchObject({ seq: before.seq, row: before.row });
    terminal.input('\x0f'); f.frame(); expect(f.view.following).toBe(false);
    expect(f.view.layout(79)[f.view.top]).toMatchObject({ seq: before.seq, row: before.row });
    f.frame(32, 12); expect(f.view.layout(31)[f.view.top].seq).toBe(reading);
    expect(f.errors).toEqual([]);
  } finally { f.ui.stop({ preserveScreen: true }); }
});

smoke('watch exits close read-only fullscreen and color timers/notifications without printing the transcript', async () => {
  const runtime = await loadNativePi(process.env);
  for (const key of ['q', '\x03', '\x1b', 'SIGTERM']) {
    const terminal = terminalFixture(); let reads = 0;
    await watchWorker({ config: {}, request: async () => { reads++; return { steps: [], next_seq: 1, next_offset: 0, has_more: false }; } }, 7,
      { runtime, terminal, stdin: { isTTY: true }, stdout: { isTTY: true }, sleep: async () => {
        if (key === 'SIGTERM') process.emit('SIGTERM');
        else { terminal.input('\x06'); terminal.input(key); } // Exit still wins over native Ctrl-F search focus.
      } });
    expect(reads).toBe(1); expect(terminal.stopped).toBe(1);
    const ansi = terminal.writes.join(''); expect(ansi).toContain('\x1b[?1049l'); expect(ansi).toContain('\x1b[?2031l');
  }
});

smoke('exit during the initial color query cancels its budget before any Worker read', async () => {
  const runtime = await loadNativePi(process.env), terminal = terminalFixture();
  const write = terminal.write;
  terminal.write = function(data) {
    write.call(this, data);
    if (data.includes('\x1b]10;?')) queueMicrotask(() => this.input('q'));
  };
  let reads = 0;
  await watchWorker({ config: {}, request: async () => { reads++; throw Error('must not read'); } }, 7,
    { runtime, terminal, stdin: { isTTY: true }, stdout: { isTTY: true } });
  expect(reads).toBe(0); expect(terminal.stopped).toBe(1);
  const ansi = terminal.writes.join(''); expect(ansi).toContain('\x1b[?2031l'); expect(ansi).toContain('\x1b[?1049l');
});

smoke('failure disabling color notifications cannot prevent raw/fullscreen cleanup', async () => {
  const runtime = await loadNativePi(process.env), terminal = terminalFixture();
  const write = terminal.write;
  terminal.write = function(data) {
    if (data === '\x1b[?2031l') throw Error('notification teardown failed');
    write.call(this, data);
  };
  await expect(watchWorker({ config: {}, request: async () => ({ steps: [], next_seq: 1, next_offset: 0, has_more: false }) }, 7,
    { runtime, terminal, stdin: { isTTY: true }, stdout: { isTTY: true }, sleep: async () => terminal.input('q') }))
    .rejects.toThrow('notification teardown failed');
  expect(terminal.stopped).toBe(1); expect(terminal.writes.join('')).toContain('\x1b[?1049l');
});
