import { setTimeout as delay } from 'node:timers/promises';
import { loadNativePi, watchTerminalColors } from './native-pi.js';

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
    this.items = []; this.pairs = new Map(); this.expanded = false;
    this.anchor = null; this.help = false; this.status = '读取已有记录…'; this.cache = null;
    this.scroll = new runtime.tui.ScrollView(this, { follow: 'end', primary: true, scrollbar: 'always',
      scrollbarTrackStyle: text => runtime.appearance?.theme.fg('scrollbarTrack', text) ?? text,
      scrollbarThumbStyle: text => runtime.appearance?.theme.fg('scrollbarThumb', text) ?? text });
    const line = get => ({ invalidate() {}, render: width => [runtime.tui.truncateToWidth(get(), width)] });
    this.header = line(() => `Lush ${this.label} · 只读 Pi${this.after ? ` · 已跳过前 ${this.after} 步` : ''} · ${this.following ? '跟随' : '暂停阅读'} · ${this.status}`);
    this.footer = line(() => this.help
      ? '滚轮/↑↓/j k/PgUp/PgDn/Home：滚动 · f/End：跟随 · 空格：暂停 · Ctrl-O：工具 · q/Esc/Ctrl-C：退出（Worker继续）'
      : '完成记录，非逐字流 · 滚轮/PgUp翻页 · Ctrl-O展开 · ?帮助 · q退出');
    // Pi owns the viewport, mouse routing and scrollbar; fixed chrome consumes at most two rows.
    this.root = new runtime.tui.VStack([
      { component: this.header, basis: 1, shrink: 0, visible: viewport => viewport.height >= 2 },
      { component: this.scroll, basis: 0, grow: 1, minSize: 1 },
      { component: this.footer, basis: 1, shrink: 0, visible: viewport => viewport.height >= 4 },
    ]);
  }
  get following() { return this.scroll.isFollowingEnd; }
  get top() { return this.scroll.scrollTop; }
  captureAnchor() {
    if (this.following || this.anchor) return;
    const line = this.cache?.lines[this.top];
    if (line) this.anchor = { seq: line.seq, row: line.row };
  }
  invalidate() { this.captureAnchor(); this.cache = null; for (const item of this.items) item.component?.invalidate(); }
  text(text) { return new this.runtime.tui.Text(text, 0, 0); }
  add(record) {
    this.captureAnchor();
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
      const message = { role: 'assistant', content: [content] };
      container.addChild(this.runtime.assistant ? this.runtime.assistant(message) : new pi.AssistantMessageComponent(message));
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
      this.captureAnchor(); this.expanded = !this.expanded;
      for (const item of this.items) item.tool?.setExpanded(this.expanded);
      this.cache = null;
    } else if (data === '?' || data === 'h') this.help = !this.help;
    else if (data === 'f' || matchesKey(data, 'end')) { this.anchor = null; this.scroll.scrollToEnd(); }
    else if (data === ' ' || data === 'p') {
      this.anchor = null;
      if (this.following) this.scroll.scrollTo(this.top, { disableFollow: true });
      else this.scroll.scrollToEnd();
    } else {
      let move = 0;
      if (matchesKey(data, 'up') || data === 'k') move = -1;
      if (matchesKey(data, 'down') || data === 'j') move = 1;
      if (matchesKey(data, 'pageUp')) move = -Math.max(1, this.scroll.viewportHeight - 1);
      if (matchesKey(data, 'pageDown')) move = Math.max(1, this.scroll.viewportHeight - 1);
      this.anchor = null;
      if (matchesKey(data, 'home')) this.scroll.scrollTo(0, { disableFollow: true });
      else if (move) this.scroll.scrollBy(move);
      else return;
    }
    this.ui.requestRender();
  }
  layout(width) {
    if (this.cache?.width === width) return this.cache.lines;
    this.captureAnchor();
    const lines = [];
    for (const item of this.items) {
      if (item.hidden) continue;
      const rendered = item.component.render(Math.max(1, width));
      if (lines.length + rendered.length > this.limits.lines) fail(`渲染超过 ${this.limits.lines} 行，原生观看器拒绝继续`);
      for (let row = 0; row < rendered.length; row++) lines.push({ seq: item.step.seq, row, text: rendered[row] });
    }
    this.cache = { width, lines };
    if (this.anchor) {
      // Record-local rows survive earlier growth, pair replacement and width reflow. If the
      // anchored independent result was paired away, locate its call rather than jump to bottom.
      const paired = this.items.find(item => item.result?.seq === this.anchor.seq);
      const seq = paired?.step.seq ?? this.anchor.seq;
      let at = lines.findIndex(line => line.seq === seq && line.row >= this.anchor.row);
      if (at < 0) at = lines.findLastIndex(line => line.seq === seq);
      if (at >= 0) {
        this.scroll.updateLayout(lines.length, this.scroll.viewportHeight, () => this.ui.requestRender());
        this.scroll.scrollTo(at, { disableFollow: true });
      }
      this.anchor = null;
    }
    return lines;
  }
  render(width) {
    // This is the bounded document, not a second manually cropped viewport. Native ScrollView
    // handles clipping, wheel/drag input and layout. Keep even one-column layouts safe.
    try { return this.layout(width).map(line => this.runtime.tui.truncateToWidth(line.text, width)); }
    catch (error) { this.quit(error); return []; }
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
  let ui, terminal, colors, started = false, fatal = null;
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
    // Exit keys belong to the viewer even when native search/selection has input focus.
    // Wrap only Terminal.start's input callback; other terminal operations keep their receiver.
    const displayTerminal = new Proxy(terminal, { get(target, key) {
      if (key === 'start') return (onInput, onResize) => target.start(data => {
        if (data === 'q' || runtime.tui.matchesKey(data, 'ctrl+c') || runtime.tui.matchesKey(data, 'escape')) stop();
        else onInput(data);
      }, onResize);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    ui = new runtime.tui.TuiAltScreen(displayTerminal, false, undefined, { wheelScrollLines: 'auto', copyOnSelect: false });
    const view = new NativeRecordView(runtime, ui, terminal, error => { if (error) fatal = error; stop(); }, limits,
      sanitizeTerminalText(options.label || `#${taskId}`), after);
    const assembler = new RecordAssembler(limits, after);
    ui.setLayoutRoot(view.root); ui.setFocus(view); started = true; ui.start();
    if (controller.signal.aborted) return;
    if (runtime.appearance) {
      colors = watchTerminalColors(runtime, ui, () => { view.invalidate(); ui.requestRender(); }, error => { fatal = error; stop(); });
      await cancellable(colors.ready, controller.signal);
    }
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
      view.layout(view.scroll.getContentWidth(Math.max(1, terminal.columns || 80))); ui.requestRender();
      // Yield even during a long initial scan so q/Ctrl-C/resize remain responsive.
      await cancellable(sleep(page.has_more ? 0 : options.intervalMs ?? 1000, controller.signal), controller.signal);
    }
  } catch (error) { if (!controller.signal.aborted) fatal = error; }
  finally {
    controller.abort();
    options.signal?.removeEventListener('abort', externalAbort);
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    try { colors?.dispose(); } catch (error) { if (!fatal) fatal = error; }
    if (started) {
      try { ui.stop({ preserveScreen: true }); }
      catch (error) {
        if (!fatal) fatal = error;
        try { terminal?.stop(); } catch { /* Preserve the original cleanup failure. */ }
      }
    }
  }
  if (fatal) throw new Error(sanitizeTerminalText(fatal.message || fatal));
}
