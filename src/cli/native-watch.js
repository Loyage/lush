import { setTimeout as delay } from 'node:timers/promises';
import { loadNativePi } from './native-pi.js';

export const WATCH_LIMITS = Object.freeze({ body: 128 * 1024, history: 4 * 1024 * 1024, records: 2000, lines: 50000 });
const fail = message => { throw new Error(message); };

/** Log text is not terminal markup. Strip complete escape strings AND remaining C0/C1 controls.
 * Preserve LF and TAB only; CR/backspace/bidi controls cannot rewrite visible history. */
export function sanitizeTerminalText(value) {
  return String(value ?? '')
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b[P_X^]|[\x90\x98\x9e\x9f])[^\x1b\x9c]*(?:\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[@-Z\\-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

function safeArgs(body) {
  let value;
  try { value = JSON.parse(body); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let nodes = 0;
  function clean(item, depth) {
    if (++nodes > 10000 || depth > 40) fail('工具参数结构超限，无法安全渲染');
    if (typeof item === 'string') return sanitizeTerminalText(item);
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(child => clean(child, depth + 1));
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [sanitizeTerminalText(key), clean(child, depth + 1)]));
  }
  return clean(value, 0);
}

/** Bounded cross-page reassembly; offsets refer to original UTF-16 text, not sanitized output. */
export class RecordAssembler {
  constructor(limits = WATCH_LIMITS, after = 0) { this.limits = limits; this.pending = null; this.bytes = 0; this.count = 0; this.seq = after + 1; }
  push(segment) {
    const { seq, offset, body_length: length, body } = segment;
    if (!Number.isSafeInteger(seq) || seq !== this.seq || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(length) || length < 0 || typeof body !== 'string' || offset + body.length > length
      || (length > offset && body.length === 0)) fail('执行记录分页或正文游标不一致');
    if (length > this.limits.body) fail(`单条正文超过 ${this.limits.body} 字符，原生观看器拒绝继续；请用执行详情分段阅读原文`);
    if (!this.pending) {
      if (offset !== 0) fail('执行记录缺少首段');
      if (++this.count > this.limits.records) fail(`历史超过 ${this.limits.records} 条记录，原生观看器拒绝继续`);
      this.pending = { ...segment, body: '', offset: 0 };
    }
    const current = this.pending;
    if (offset !== current.body.length || seq !== current.seq || length !== current.body_length
      || segment.file !== current.file || segment.kind !== current.kind || segment.call_id !== current.call_id
      || segment.tool_name !== current.tool_name || segment.is_error !== current.is_error
      || segment.line !== current.line || segment.title !== current.title) fail('执行记录跨页内容身份不一致');
    this.bytes += Buffer.byteLength(JSON.stringify(segment));
    if (this.bytes > this.limits.history) fail(`历史超过 ${this.limits.history} 字节，原生观看器拒绝继续；未宣称显示完整历史`);
    current.body += body;
    if (current.body.length !== length) return null;
    this.pending = null; this.seq++;
    return current;
  }
  cursor() { return { seq: this.seq, offset: this.pending?.body.length || 0 }; }
}

const pairKey = step => step.call_id && typeof step.call_id === 'string' && typeof step.file === 'string'
  ? JSON.stringify([step.file, step.call_id]) : null;

/** One bounded record list, conservative (file,call_id) pairing. Late duplicates undo earlier pairs. */
export class NativeRecordView {
  constructor(runtime, ui, terminal, quit, limits = WATCH_LIMITS, label = '', after = 0) {
    this.runtime = runtime; this.ui = ui; this.terminal = terminal; this.quit = quit; this.limits = limits; this.label = label; this.after = after;
    this.items = []; this.pairs = new Map(); this.expanded = false; this.following = true; this.top = 0;
    this.anchor = null; this.help = false; this.status = '读取已有记录…'; this.cache = null; this.height = 1; this.total = 0;
  }
  invalidate() { this.cache = null; for (const item of this.items) item.component?.invalidate(); }
  text(text) { return new this.runtime.tui.Text(text, 0, 0); }
  add(record) {
    const step = { ...record, body: sanitizeTerminalText(record.body), title: sanitizeTerminalText(record.title),
      tool_name: sanitizeTerminalText(record.tool_name), file: sanitizeTerminalText(record.file) };
    const item = { step, key: pairKey(record), component: null, hidden: false, result: null };
    this.items.push(item);
    if (item.key && ['tool', 'result'].includes(step.kind)) {
      const group = this.pairs.get(item.key) || [];
      group.push(item); this.pairs.set(item.key, group);
      const calls = group.filter(entry => entry.step.kind === 'tool');
      const results = group.filter(entry => entry.step.kind === 'result');
      for (const entry of group) { entry.hidden = false; entry.result = null; }
      if (calls.length === 1 && results.length === 1 && calls[0].step.tool_name === results[0].step.tool_name) {
        calls[0].result = results[0].step; results[0].hidden = true;
      }
      for (const entry of group) this.build(entry, calls.length > 1 || results.length > 1);
    } else this.build(item, false);
    this.cache = null;
  }
  build(item, ambiguous) {
    const { pi, renderers } = this.runtime, step = item.step;
    const source = `${step.file}:${sanitizeTerminalText(step.line ?? '?')} · seq ${step.seq}`;
    const container = new this.runtime.tui.Container();
    container.addChild(this.text(source));
    if (step.kind === 'input') container.addChild(new pi.UserMessageComponent(step.body));
    else if (['text', 'thinking'].includes(step.kind)) {
      const content = step.kind === 'thinking' ? { type: 'thinking', thinking: step.body } : { type: 'text', text: step.body };
      // Projection has no model/usage/stopReason: do not invent those record facts.
      container.addChild(new pi.AssistantMessageComponent({ role: 'assistant', content: [content] }));
    } else if (step.kind === 'tool') {
      const args = safeArgs(step.body);
      if (args) {
        const component = new pi.ToolExecutionComponent(step.tool_name || 'tool', sanitizeTerminalText(step.call_id), args,
          { showImages: false }, renderers?.get(step.tool_name), this.ui, process.cwd());
        component.setArgsComplete();
        if (item.result) component.updateResult({ content: [{ type: 'text', text: item.result.body }], isError: Boolean(item.result.is_error) }, false);
        component.setExpanded(this.expanded);
        item.tool = component;
        container.addChild(component);
      } else {
        item.tool = null;
        container.addChild(this.text(`${step.tool_name}: 参数不是完整 JSON 对象，保留原文\n${step.body}`));
        if (item.result) container.addChild(this.text(`结果${item.result.is_error ? '（失败）' : ''}\n${item.result.body}`));
      }
      container.addChild(this.text(item.result ? `已记录结果 · seq ${item.result.seq} · ${item.result.file}:${sanitizeTerminalText(item.result.line ?? '?')}`
        : ambiguous ? '重复调用身份：不猜配结果' : '尚未见到结果（不表示仍在运行）'));
    } else {
      container.addChild(this.text(`${step.kind === 'result' ? '独立结果（未可靠配对）' : step.title}${step.is_error ? ' · 失败' : ''}\n${step.body}`));
    }
    item.component = container;
  }
  handleInput(data) {
    const { matchesKey } = this.runtime.tui;
    if (data === 'q' || matchesKey(data, 'ctrl+c') || matchesKey(data, 'escape')) { this.quit(); return; }
    if (matchesKey(data, 'ctrl+o')) {
      this.expanded = !this.expanded;
      for (const item of this.items) item.tool?.setExpanded(this.expanded);
      this.cache = null;
    } else if (data === '?' || data === 'h') this.help = !this.help;
    else if (data === 'f' || matchesKey(data, 'end')) { this.following = true; this.anchor = null; }
    else if (data === ' ' || data === 'p') { this.following = !this.following; }
    else {
      let move = 0;
      if (matchesKey(data, 'up') || data === 'k') move = -1;
      if (matchesKey(data, 'down') || data === 'j') move = 1;
      if (matchesKey(data, 'pageUp')) move = -this.height;
      if (matchesKey(data, 'pageDown')) move = this.height;
      if (matchesKey(data, 'home')) move = -this.total;
      if (!move) return;
      this.following = false;
      this.top = Math.max(0, Math.min(Math.max(0, this.total - this.height), this.top + move));
      this.rememberAnchor();
    }
    this.ui.requestRender();
  }
  layout(width) {
    if (this.cache?.width === width) return this.cache.lines;
    const lines = [];
    for (const item of this.items) {
      if (item.hidden) continue;
      const rendered = item.component.render(Math.max(1, width));
      if (lines.length + rendered.length > this.limits.lines) fail(`渲染超过 ${this.limits.lines} 行，原生观看器拒绝继续`);
      for (let row = 0; row < rendered.length; row++) lines.push({ seq: item.step.seq, row, text: rendered[row] });
    }
    this.cache = { width, lines };
    return lines;
  }
  rememberAnchor() { const line = this.cache?.lines[this.top]; this.anchor = line ? { seq: line.seq, row: line.row } : null; }
  render(width) {
    // Errors are caught by the watcher before scheduling a TUI render; bounded layout also handles resize.
    let lines;
    try { lines = this.layout(width); } catch (error) { this.quit(error); lines = []; }
    const { truncateToWidth } = this.runtime.tui;
    const chrome = [
      `Lush ${this.label} · 只读 Pi 观看器 · ${this.following ? '跟随' : '暂停阅读'} · ${this.status}`,
      'completed-records：完成记录，非逐字流；投影不含 details/图片/模型用量。',
      '↑↓/j k PgUp/PgDn Home：滚动 · f/End：跟随 · 空格/p：暂停 · Ctrl-O：工具展开 · ?：帮助 · q/Esc/Ctrl-C：退出',
    ];
    if (this.help) {
      chrome.splice(2, 1, '↑↓/j k：逐行滚动', 'PgUp/PgDn：翻页 · Home：开头', 'f/End：恢复跟随', '空格/p：暂停跟随',
        'Ctrl-O：展开/折叠全部工具', 'q/Esc/Ctrl-C：只退出读器', '?/h：开关帮助', 'Worker 不会停止；不执行日志命令。');
    }
    if (this.after > 0) chrome.splice(1, 0, `已跳过前 ${this.after} 步（未读取/未显示）；从 seq ${this.after + 1} 观看。`);
    const rows = Math.max(1, this.terminal.rows || 24);
    const header = chrome.slice(0, Math.max(0, rows - 1));
    this.height = Math.max(1, rows - header.length); this.total = lines.length;
    if (this.following) this.top = Math.max(0, lines.length - this.height);
    else if (this.anchor) {
      const at = lines.findIndex(line => line.seq === this.anchor.seq && line.row >= this.anchor.row);
      if (at >= 0) this.top = at;
    }
    this.top = Math.min(this.top, Math.max(0, lines.length - 1));
    this.rememberAnchor();
    const output = [...header.map(line => truncateToWidth(line, width)),
      ...lines.slice(this.top, this.top + this.height).map(line => truncateToWidth(line.text, width))];
    while (output.length < rows) output.push('');
    return output;
  }
}

function cancellable(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {}); // A transport can synchronously abort while creating its promise.
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** User-only entry. Injectable runtime/terminal/streams/signal/sleep for isolated tests.
 * Requests are strictly single-flight and contain only {id,seq,offset}; cancellation never mutates Worker.
 * options.after defaults to 0: start at seq=after+1 and explicitly disclose skipped earlier steps.
 * Forward an optional transport AbortSignal (not an RPC parameter). Clients without transport
 * cancellation can ignore it: the cancellation race still ignores late read responses, never retries. */
export async function watchWorker(client, taskId, options = {}) {
  if (client.token != null) fail('原生观看器仅供用户使用，不接受 Agent token');
  const reader = options.client || client;
  if (reader.token != null) fail('原生观看器不接受 Agent token');
  const stdin = options.stdin || process.stdin, stdout = options.stdout || process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) fail('原生观看器需要 stdin/stdout 都是真实 TTY；管道输出请使用 worker transcript');
  if (!Number.isSafeInteger(taskId) || taskId <= 0) fail('invalid worker id');
  const after = options.after === undefined ? 0 : options.after;
  if (!Number.isSafeInteger(after) || after < 0 || after >= Number.MAX_SAFE_INTEGER) {
    fail('after 必须是非负安全整数，且 after+1 仍须是安全整数');
  }
  const controller = new AbortController();
  const stop = error => controller.abort(error || new Error('viewer exited'));
  const externalAbort = () => stop();
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) stop();
  const interrupt = () => stop();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let ui, terminal, started = false, fatal = null;
  const limits = { ...WATCH_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(WATCH_LIMITS, key) || !Number.isSafeInteger(value) || value <= 0 || value > WATCH_LIMITS[key]) {
      options.signal?.removeEventListener('abort', externalAbort); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
      fail('观看器 limits 只能降低默认安全上限');
    }
  }
  try {
    if (controller.signal.aborted) return;
    const runtime = await cancellable(options.runtime || loadNativePi(options.env || client.config?.env || process.env), controller.signal);
    if (controller.signal.aborted) return;
    terminal = options.terminal || new runtime.tui.ProcessTerminal();
    const TUI = runtime.tui.TuiMainScreen || runtime.tui.TUI;
    ui = new TUI(terminal);
    const view = new NativeRecordView(runtime, ui, terminal, error => { if (error) fatal = error; stop(); }, limits,
      sanitizeTerminalText(options.label || `#${taskId}`), after);
    const assembler = new RecordAssembler(limits, after);
    ui.addChild(view); ui.setFocus(view); started = true; ui.start();
    let seq = after + 1, offset = 0;
    const sleep = options.sleep || ((ms, signal) => delay(ms, undefined, { signal }));
    while (!controller.signal.aborted) {
      const page = await cancellable(reader.request('worker.transcript_page', { id: taskId, seq, offset }, { signal: controller.signal }), controller.signal);
      if (!Array.isArray(page.steps) || page.steps.length > 50) fail('执行记录分页响应不兼容');
      for (const segment of page.steps) {
        const record = assembler.push(segment);
        if (record) view.add(record);
      }
      const expected = assembler.cursor();
      if (page.next_seq !== expected.seq || page.next_offset !== expected.offset
        || (page.has_more && page.steps.length === 0)) fail('执行记录分页游标未连续推进');
      seq = page.next_seq; offset = page.next_offset;
      view.status = page.has_more ? `读取历史 · ${assembler.count} 条` : assembler.count ? `等待新记录 · ${assembler.count} 条` : '尚无完成记录，继续等待…';
      view.layout(Math.max(1, terminal.columns || 80)); ui.requestRender();
      // Yield even during a long initial scan so q/Ctrl-C/resize remain responsive.
      await cancellable(sleep(page.has_more ? 0 : options.intervalMs ?? 1000, controller.signal), controller.signal);
    }
  } catch (error) { if (!controller.signal.aborted) fatal = error; }
  finally {
    controller.abort();
    options.signal?.removeEventListener('abort', externalAbort);
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    if (started) {
      try { ui.stop(); } catch (error) { terminal?.stop(); if (!fatal) fatal = error; }
    }
  }
  if (fatal) throw new Error(sanitizeTerminalText(fatal.message || fatal));
}
