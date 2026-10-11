// Explicit installed-Pi + POSIX PTY integration check; never starts a daemon/Agent/model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config.js';
import { transcriptPage } from '../src/core/transcript-reader.js';
import { encode } from '../src/rpc/protocol.js';
import { resolveNativePi } from '../src/cli/native-pi.js';

if (process.platform === 'win32') throw Error('PTY check requires POSIX (Windows: use WSL2) and python3');
const nativeEntry = resolveNativePi(process.env);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-native-pty-fixture-'));
const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-native-pty-logs-'));
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) if (key.startsWith('LUSH_') || key.startsWith('PI_')) delete childEnv[key];
Object.assign(childEnv, { HOME: path.join(root, 'user'), XDG_CONFIG_HOME: path.join(root, 'device'),
  LUSH_PROVIDER: 'mock', TERM: 'xterm-256color' });
// If the caller selected a non-PATH Pi install, retain only its executable selector.
if (process.env.LUSH_PI_COMMAND) childEnv.LUSH_PI_COMMAND = process.env.LUSH_PI_COMMAND;
for (const dir of [childEnv.HOME, childEnv.XDG_CONFIG_HOME, path.join(root, '.lush', 'sessions')]) fs.mkdirSync(dir, { recursive: true });
const config = new Config({ project: root, env: childEnv });
fs.mkdirSync(config.socketDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(root, '.lush', 'project.json'), JSON.stringify({ version: 2, path: root }));
const session = path.join(root, '.lush', 'sessions', '2026-10-11_fixture_lush-task-7.jsonl');
const record = message => JSON.stringify({ type: 'message', timestamp: '2026-10-11T00:00:00Z', message }) + '\n';
const initial = record({ role: 'user', content: '中文用户：只读观看测试' })
  + record({ role: 'assistant', content: [{ type: 'thinking', thinking: '检查接口，不调用模型。' },
    { type: 'text', text: '## 原生观看\n**正文**\n```js\nconst nativeCode = 123;\n```\n' + Array.from({ length: 40 }, (_, i) => `历史行 ${i}`).join('\n') },
    { type: 'toolCall', id: 'fixture-call', name: 'bash', arguments: { command: 'echo fixture-native' } }] })
  + record({ role: 'toolResult', toolCallId: 'fixture-call', toolName: 'bash', isError: false,
    content: [{ type: 'text', text: 'fixture-native\n' + Array.from({ length: 15 }, (_, i) => `工具输出 ${i}`).join('\n') + '\n\x1b]52;c;INJECTED_CONTROL\x07' }] });
let active;
const server = Bun.listen({ unix: config.socket, socket: {
  data(handle, bytes) {
    handle.data ??= { buffer: '' };
    handle.data.buffer += bytes.toString();
    const at = handle.data.buffer.indexOf('\n');
    if (at < 0) return;
    const request = JSON.parse(handle.data.buffer.slice(0, at));
    active.requests.push(request);
    const reply = result => handle.write(encode({ jsonrpc: '2.0', id: request.id, result }));
    if (request.method === 'worker.lookup') return reply({ id: 7, worker_number: 'W195' });
    if (request.method === 'worker.inspect') return reply({ id: 7, worker_number: 'W195' });
    if (request.method !== 'worker.transcript_page') return reply({ unexpected: request.method });
    handle.data.read = true; active.pages++;
    if (active.stall) { fs.writeFileSync(path.join(root, 'read-started'), 'ready'); return; }
    if (active.pages === 2) fs.appendFileSync(session, record({ role: 'assistant', content: [{ type: 'text', text: '最新到达：增量读取' }] }));
    transcriptPage(config, 7, request.params.seq, request.params.offset).then(reply).catch(error => {
      handle.write(encode({ jsonrpc: '2.0', id: request.id, error: { code: -32009, message: error.message } }));
    });
  },
  close(handle) { if (handle.data?.read) active.closedReads++; }, error() {},
} });

const driver = String.raw`
import os, sys, pty, termios, fcntl, struct, subprocess, select, time, signal, json, re
bun, cli, project, scenario, logfile = sys.argv[1:]
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
def size(rows, cols):
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
size(24, 80)
def setup():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
process = subprocess.Popen([bun, cli, 'worker', 'watch', 'W195', '--project', project], stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup)
captured = bytearray()
def background_before(needle, section):
    at = section.rfind(needle.encode())
    assert at >= 0, 'expected visible code/output did not reach PTY'
    background = None
    for match in re.finditer(rb'\x1b\[([0-9;]*)m', section[:at]):
        values = [int(v) for v in match.group(1).split(b';') if v] or [0]
        i = 0
        while i < len(values):
            value = values[i]
            if value in (0, 49): background = None
            elif 40 <= value <= 47 or 100 <= value <= 107: background = (value,)
            elif value in (38, 48) and i + 1 < len(values):
                count = 4 if values[i + 1] == 2 else 2
                if value == 48: background = tuple(values[i:i + count + 1])
                i += count
            i += 1
    assert background is not None, 'code/tool output was rendered without a background'
    return background
def background_changed(needle, section, original):
    try: return background_before(needle, section) != original
    except AssertionError: return False
def read_until(predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate(): return
        readable, _, _ = select.select([master], [], [], .05)
        if readable:
            try: data = os.read(master, 65536)
            except OSError: data = b''
            captured.extend(data)
        if process.poll() is not None:
            if predicate(): return
            raise AssertionError('viewer exited before expected state: ' + str(process.returncode))
    raise AssertionError('PTY state timed out')
try:
    read_until(lambda: '只读 Pi'.encode() in captured)
    if scenario == 'normal':
        read_until(lambda: '最新到达'.encode() in captured)
        assert b'\x1b[?1049h' in captured and b'\x1b[?1006h' in captured, 'native fullscreen/mouse mode was not enabled'
        assert b'\x1b]10;?' in captured and b'\x1b]11;?' in captured, 'terminal palette was not queried'
        captured_at = len(captured)
        os.write(master, b'\x1b[<64;20;10M')
        read_until(lambda: '暂停阅读'.encode() in captured[captured_at:])
        captured_at = len(captured)
        os.write(master, b'\x1b[5~')
        read_until(lambda: '历史行'.encode() in captured[captured_at:])
        captured_at = len(captured)
        os.write(master, b'\x0f')
        os.write(master, b'\x1b[F')
        read_until(lambda: '工具输出 14'.encode() in captured[captured_at:])
        background_before('工具输出 14', bytes(captured[captured_at:]))
        captured_at = len(captured)
        os.write(master, b'\x1b[H')
        read_until(lambda: 'nativeCode'.encode() in captured[captured_at:])
        assert '中文用户'.encode() in captured[captured_at:], 'Home did not reveal oldest input'
        dark = background_before('nativeCode', bytes(captured[captured_at:]))
        # Real PTY has no terminal to answer OSC: exercise fallback, then a late light-color reply.
        captured_at = len(captured)
        os.write(master, b'\x1b]10;rgb:1818/1818/1818\x07\x1b]11;rgb:ffff/ffff/ffff\x07')
        read_until(lambda: background_changed('nativeCode', bytes(captured[captured_at:]), dark))
        light = background_before('nativeCode', bytes(captured[captured_at:]))
        assert light != dark, 'late light terminal palette did not repaint code background'
        captured_at = len(captured)
        size(16, 32); os.kill(process.pid, signal.SIGWINCH)
        read_until(lambda: '中文用户'.encode() in captured[captured_at:])
        assert '中文用户'.encode() in captured[captured_at:], 'resize pulled paused reading to the end'
        captured_at = len(captured)
        os.write(master, b'\x1b[6~')
        read_until(lambda: '历史行'.encode() in captured[captured_at:])
        os.write(master, b'\x1b[F')
    else:
        read_until(lambda: os.path.exists(os.path.join(project, 'read-started')))
    started = time.monotonic()
    os.write(master, b'\x03' if scenario == 'stall_ctrl_c' else b'q')
    read_until(lambda: process.poll() is not None, 2)
    elapsed = time.monotonic() - started
    assert process.returncode == 0, 'viewer failed: ' + str(process.returncode)
    assert elapsed < 2, 'exit waited for pending RPC'
    restored = termios.tcgetattr(slave)
    # Bun may normalize platform-specific cflag speed bits on first stdin access.
    # Input/output/local flags and control characters must leave raw mode exactly.
    assert restored[:2] == original[:2] and restored[3:] == original[3:], 'raw terminal flags were not restored: before=' + repr(original) + ' after=' + repr(restored)
    assert b'INJECTED_CONTROL' not in captured, 'log OSC reached terminal'
    assert b'lush:' not in captured, 'CLI emitted an error'
    assert b'\x1b[?1049l' in captured, 'exit did not restore main screen'
    assert b'\x1b[?1006l' in captured and b'\x1b[?2031l' in captured, 'exit left mouse/theme notifications enabled'
    print(json.dumps({'scenario': scenario, 'exit_ms': round(elapsed * 1000), 'raw_mode_restored': True,
        'main_screen_restored': True, 'fullscreen_wheel_and_code_background': scenario == 'normal', 'bytes': len(captured)}))
finally:
    if process.poll() is None:
        process.kill(); process.wait()
    with open(logfile, 'wb') as stream: stream.write(captured)
    os.close(master); os.close(slave)
`;
let success = false;
try {
  for (const scenario of ['normal', 'stall_q', 'stall_ctrl_c']) {
    fs.writeFileSync(session, initial); fs.rmSync(path.join(root, 'read-started'), { force: true });
    active = { requests: [], pages: 0, closedReads: 0, stall: scenario !== 'normal' };
    const proc = Bun.spawn(['python3', '-c', driver, process.execPath, path.resolve(import.meta.dir, '../bin/lush'), root,
      scenario, path.join(logs, `${scenario}.ansi`)], { env: childEnv, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    fs.writeFileSync(path.join(logs, `${scenario}.log`), out + err);
    if (code !== 0) throw Error(`${scenario} failed (${code}); ${err}; logs: ${logs}`);
    if (!active.pages || active.closedReads < 1 || active.requests.some(request => !['worker.lookup', 'worker.inspect', 'worker.transcript_page'].includes(request.method))) {
      throw Error(`${scenario}: read-only connection contract failed; logs: ${logs}`);
    }
    if (fs.readFileSync(session, 'utf8') !== (scenario === 'normal' ? initial + record({ role: 'assistant', content: [{ type: 'text', text: '最新到达：增量读取' }] }) : initial)) {
      throw Error('viewer changed the fixture session');
    }
    console.log(`PASS ${out.trim()}`);
  }
  success = true;
  console.log(`Pi module: ${nativeEntry}\nPTY logs: ${logs}\nNo daemon, Agent or model was started.`);
} finally {
  server.stop(true); fs.rmSync(config.socket, { force: true });
  if (success) fs.rmSync(root, { recursive: true, force: true });
  else console.error(`Retained fixture: ${root}; logs: ${logs}`);
}
