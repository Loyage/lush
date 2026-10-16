import { block, button, el, syncChildren } from './dom.js';
import { absolute, eventLabel } from './format.js';
import { ui } from './state.js';
import { searchField } from './search-field.js';
import { loadReadingPage, loadReadingRecord } from './api.js';
import { previewHistoryEvent } from './reading-projection.js';
import { lifecycleModel } from './worker-lifecycle-model.js';
import { referenceable } from './context-references.js';
import { revealDetailPreview } from './detail-preview.js';

const MAX_RECORDS = 5000, MAX_CHARS = 4 * 1024 * 1024;
const timestamp = value => value && Number.isFinite(Date.parse(value)) ? absolute(value) : '时间未知';
export const lifecycleDuration = value => value == null ? '时长未知' : value < 1000 ? '不足 1 秒'
  : value < 60000 ? `${Math.floor(value / 1000)} 秒` : value < 3600000 ? `${Math.floor(value / 60000)} 分 ${Math.floor(value % 60000 / 1000)} 秒`
    : `${Math.floor(value / 3600000)} 小时 ${Math.floor(value % 3600000 / 60000)} 分`;
const RUN_STATUS = { completed: '本轮返回，不等于工作已交付', suspended: '暂停等待决定（非失败）', preempted: '安全收尾，等待下一轮',
  failed: '调用失败', cancelled: 'Run 记录为 cancelled（结束原因待核验）', running: '调用进行中', unknown: '结束原因未知' };
const textOf = event => event.reading_text ?? (['body', 'result', 'answer'].filter(key => event.data?.[key] != null)
  .map(key => typeof event.data[key] === 'string' ? event.data[key] : JSON.stringify(event.data[key])).join('\n') || event.message?.body || JSON.stringify(event.data || {}));

/** Two independent readers share the authoritative reading APIs, never a new Worker state machine. */
export function renderWorkerTimeline(task, history = {}, previous = null, options = {}) {
  history ||= {};
  if (previous?.timelineTaskId === task.id) { previous.timelineOptions = options; previous.updateTimeline(task, history); return previous; }
  const root = block('时间线'); root.classList.add('worker-timeline-panel'); root.timelineTaskId = task.id; root.timelineOptions = options;
  const owner = globalThis.document, boot = ui.workerNumbers;
  let current = task, view = ui.view, lifetime = null, live = null, active = null, generation = 0, direction = 'desc', query = '';
  let eventCursor = null, messageCursor = null, complete = false, windows = [], notice = '', historyState = '';
  const events = new Map(), messages = new Map(), modelIds = new Set(), full = new Map(), rows = new Map(), cards = new Map(), remoteHits = new Set();
  let pendingPaint = false;
  const inside = node => { for (let parent = node; parent; parent = parent.parentNode) if (parent === root) return true; return false; };
  const selecting = () => { const selection = globalThis.window?.getSelection?.(); return selection && !selection.isCollapsed && (inside(selection.anchorNode) || inside(selection.focusNode)); };
  const flushSelection = () => {
    if (!alive() || !selecting()) { owner?.removeEventListener?.('selectionchange', flushSelection); pendingPaint = false; if (alive()) paint(); }
  };
  const currentNode = el('div', undefined, 'lifecycle-current'), list = el('div', undefined, 'lifecycle-list');
  const status = el('p', '历史范围尚未读完；缺少旧证据的等待原因与起点保持未知。', 'hint lifecycle-status'); status.setAttribute('role', 'status');
  const order = el('div', undefined, 'lifecycle-order'); order.setAttribute('role', 'group'); order.setAttribute('aria-label', '生命周期排序');
  const asc = button('正序', () => { direction = 'asc'; paint(); }, 'ghost');
  const desc = button('倒序', () => { direction = 'desc'; paint(); }, 'ghost'); order.append(asc, desc); root.querySelector('.section-title').append(order);
  const more = button('加载更早时间线', () => loadMore(), 'ghost lifecycle-more');
  const advanced = el('details', undefined, 'lifecycle-advanced'); advanced.append(el('summary', '完整事件与通信（按需展开）'));
  const records = el('div', undefined, 'lifecycle-records');
  const search = searchField({ label: '搜索事件与通信', placeholder: '正文、事件类型与安全元数据',
    scope: '默认仅筛选已加载事件与入站消息；全历史查找须显式启动，不含执行过程。',
    onSubmit: value => { cancelRead(); query = value.toLowerCase(); remoteHits.clear(); paint(); } });
  const scan = button('查找全部历史', () => scanAll(), 'ghost');
  const cancel = button('取消读取', () => { cancelRead(); notice = '读取已取消，历史范围未完成；可重试。'; paint(); }, 'ghost'); cancel.hidden = true;
  advanced.append(search.root, scan, records); root.append(currentNode, list, status, more, cancel, advanced);
  const alive = () => globalThis.document === owner && ui.workerNumbers === boot && ui.view === view && !lifetime?.aborted && (!live || live());
  function cancelRead() { generation++; active?.abort(); active = null; cancel.hidden = true; more.disabled = false; scan.disabled = false; }
  function beginRead() { cancelRead(); const controller = new AbortController(); active = controller; const ticket = generation;
    cancel.hidden = false; return { signal: controller.signal, valid: () => ticket === generation && alive() && !controller.signal.aborted }; }
  function finishRead(read) { if (read.valid()) { active = null; cancel.hidden = true; more.disabled = false; scan.disabled = false; } }
  root.bindTimelineLifetime = (signal, isCurrent) => { lifetime = signal; live = isCurrent; view = ui.view;
    owner?.removeEventListener?.('selectionchange', flushSelection);
    if (pendingPaint) owner?.addEventListener?.('selectionchange', flushSelection);
    signal?.addEventListener('abort', () => { if (signal === lifetime) { cancelRead(); pendingPaint = false; owner?.removeEventListener?.('selectionchange', flushSelection); } }, { once: true }); };
  function addWindow(low, high) {
    windows.push([low, high]); windows.sort((a, b) => a[0] - b[0]);
    windows = windows.reduce((out, range) => { const last = out.at(-1); if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else out.push([...range]); return out; }, []);
  }
  function checkBudget(added = 0, eventMap = events, messageMap = messages) {
    if (eventMap.size + messageMap.size > MAX_RECORDS) throw new Error('达到 5000 条阅读预算,历史范围未完成;请缩小检索范围');
    const chars = [...eventMap.values()].reduce((sum, event) => sum + textOf(event).length, 0)
      + [...messageMap.values()].reduce((sum, message) => sum + String(message.body ?? '').length, 0)
      + [...full.values()].reduce((sum, item) => sum + item.text.length, 0);
    if (chars + added > MAX_CHARS) throw new Error('达到 8 MiB 正文阅读预算，历史范围未完成；请缩小检索范围');
  }
  function ingest(page, { continuous = false, upper = null, hits = false } = {}) {
    const incomingEvents = new Map(events), incomingMessages = new Map(messages);
    for (const raw of page.events || []) {
      if (raw.task_id != null && raw.task_id !== current.id) continue;
      const event = previewHistoryEvent(raw), cached = full.get(`event:${event.id}`);
      if (cached?.complete && ['worker.phase_changed', 'invocation.started'].includes(event.type)) {
        try { event.data = JSON.parse(cached.text); event.limitations = []; } catch { /* full record remains readable, not fabricated metadata */ }
      }
      incomingEvents.set(event.id, event);
    }
    for (const message of page.messages || []) {
      if (message.task_id != null && message.task_id !== current.id) continue;
      incomingMessages.set(message.id, message);
    }
    checkBudget(0, incomingEvents, incomingMessages);
    for (const [id, event] of incomingEvents) events.set(id, event);
    for (const [id, message] of incomingMessages) messages.set(id, message);
    const ids = (page.events || []).filter(event => event.task_id == null || event.task_id === current.id).map(event => event.id);
    if (continuous) for (const id of ids) modelIds.add(id);
    if (hits) { for (const id of ids) remoteHits.add(`event:${id}`); for (const message of page.messages || []) if (messages.has(message.id)) remoteHits.add(`message:${message.id}`); }
    if (continuous && ids.length) addWindow(Math.min(...ids), Math.max(...ids, ...(upper ? [upper] : [])));
  }
  const senderLabel = (id, number) => number || current.children?.find(child => child.id === id)?.worker_number
    || ui.workerNumbers?.get?.(id) || `#${id}`;
  function rawEntries() {
    const linked = new Set([...events.values()].map(event => event.data?.message_id).filter(Number.isSafeInteger));
    return [...events.values()].map(event => ({ key: `event:${event.id}`, kind: 'event', id: event.id, at: event.created_at,
      title: `${eventLabel(event)} · ${event.type}${Number.isSafeInteger(event.data?.sender) ? ` · 来自 Worker ${senderLabel(event.data.sender, event.message?.sender_worker_number)}` : ''}`, text: textOf(event), metadata: event.data, message_id: event.data?.message_id, event }))
      .concat([...messages.values()].filter(message => !linked.has(message.id)).map(message => ({ key: `message:${message.id}`, kind: 'message', id: message.id,
        at: message.created_at, title: message.signal_type ? `系统信号 ${message.signal_type}` : message.sender_id != null
          ? `来自 Worker ${senderLabel(message.sender_id, message.sender_worker_number)}` : '收件箱消息 · 来源请查看证据', text: String(message.body ?? ''), message })))
      .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0) || a.key.localeCompare(b.key));
  }
  async function reveal(reference) {
    const target = reference.target || {}; if (target.task_id != null && target.task_id !== current.id) return null;
    const match = entry => reference.kind === 'history_event' ? entry.kind === 'event' && entry.id === target.event_id
      : reference.kind === 'message' ? entry.kind === 'message' && entry.id === target.message_id || entry.message_id === target.message_id : false;
    let entry = rawEntries().find(match);
    if (!entry && ['message', 'history_event'].includes(reference.kind)) {
      const read = beginRead(), isMessage = reference.kind === 'message', id = isMessage ? target.message_id : target.event_id;
      try {
        const page = await loadReadingPage(current.id, { before_event: isMessage ? 0 : id + 1, before_message: isMessage ? id + 1 : 0, limit: 1 }, { signal: read.signal });
        if (!read.valid()) return null;
        if (!Array.isArray(page.events) || !Array.isArray(page.messages) || page.errors?.length) throw new Error('证据读面不可用或记录不可读');
        ingest(page); entry = rawEntries().find(match);
      } catch (error) { if (read.valid()) { notice = `证据读取未完成：${error.message}`; paint(); } return null; }
      finally { finishRead(read); }
    }
    if (!entry) { notice = '当前读面未找到这条证据，不能补猜来源'; paint(); return null; }
    cancelRead(); query = ''; remoteHits.clear(); search.setValue(''); advanced.open = true; paint();
    const card = cards.get(entry.key); card?.revealReadingContent(); revealDetailPreview(card); return card;
  }
  root.revealTimelineReference = reveal;
  function evidenceReference(eventId) { return { kind: 'history_event', target: { task_id: current.id, event_id: eventId } }; }
  function sourceButton(source) {
    return button(source.label, async () => {
      const reference = source.event_id ? evidenceReference(source.event_id) : { kind: 'message', target: { task_id: current.id, message_id: source.message_id } };
      const node = await reveal(reference); node?.scrollIntoView?.({ block: 'center' });
    }, 'ghost', { help: '展开这条来源证据；本轮收到的输入不等于唯一唤醒者，不调用 Agent。' });
  }
  function renderRow(row, model) {
    let node = rows.get(row.key); const signature = JSON.stringify({ ...row, duration_ms: row.open ? null : row.duration_ms, end: row.open ? null : row.end });
    if (!node) { node = el('article', undefined, `lifecycle-row lifecycle-${row.kind}`); node.dataset.lifecycleKey = row.key; rows.set(row.key, node); }
    if (node.signature === signature) {
      const duration = node.querySelector('.lifecycle-duration'), text = `${row.open ? '已持续 ' : ''}${lifecycleDuration(row.duration_ms)}`;
      if (duration && duration.textContent !== text) duration.textContent = text;
      return node;
    }
    node.signature = signature;
    const label = row.kind === 'call' ? row.call != null ? `第 ${row.call} 次调用` : row.run_id ? `调用 #${row.run_id}（轮次未知）` : '调用（轮次未知）' : row.label;
    const header = el('div', undefined, 'lifecycle-row-head'); header.append(el('strong', label));
    if (row.kind !== 'event') header.append(el('span', `${row.open ? '已持续 ' : ''}${lifecycleDuration(row.duration_ms)}`, 'lifecycle-duration'));
    const span = el('div', row.kind === 'event' ? timestamp(row.start) : `${timestamp(row.start)}${row.end && !row.open ? ` → ${timestamp(row.end)}` : row.open ? ' → 现在' : ' · 结束边界未知'}`, 'hint');
    node.replaceChildren(header, span);
    if (row.kind === 'call') {
      node.append(el('p', RUN_STATUS[row.status] || '调用状态未知', `lifecycle-outcome${row.status === 'failed' ? ' error' : ''}`));
      if (row.suspension_evidence === 'serial_window') node.append(el('p', '旧暂停事件没有 Run ID，已按完整的单 Worker 调用窗口核验（非按时间邻近猜测）。', 'hint'));
      const inputs = el('div', undefined, 'lifecycle-inputs');
      inputs.append(el('span', row.initial_input ? `来源：原始输入 O${current.input_id}` : row.inputs.length ? '本轮输入来源：' : '输入来源证据尚未加载／未知'));
      for (const source of row.inputs) inputs.append(sourceButton(source));
      node.append(inputs);
      if (row.inputs.length) node.append(el('p', `这是所选输入批次，不代表唯一触发者。${row.inputs_delivered ? '已找到同 Run 的输入投递记录。' : '尚未加载同 Run 的输入投递确认。'}`, 'hint'));
      if (row.run_id) node.append(button('查看对应输入输出', async () => { await root.timelineOptions.onOutput?.(row); }, 'ghost'));
    } else if (row.kind === 'phase') {
      if (row.child_ids.length) node.append(el('p', `等待对象：${row.child_ids.map(id => model.workerName(id, row.children.find(child => child.id === id)?.worker_number)).join('、')}`));
      if (row.notice_ids.length) node.append(el('p', `等待决定：${row.notice_ids.map(id => `${['question', 'questionnaire', 'plan'].includes(row.notices.find(notice => notice.id === id)?.kind) ? 'D' : 'N'}${id}`).join('、')}`));
      if (row.state === 'queued') node.append(el('p', '具体准入门未知；不猜测是容量、冻结或依赖。', 'hint'));
      if (row.state === 'idle') node.append(el('p', '没有已知等待对象，不表示已交付或必在等你。', 'hint'));
      if (row.boundary_unknown) node.append(el('p', '历史窗口不连续，结束时间与完整时长未知。', 'hint'));
    } else if (row.kind === 'event') node.append(el('p', row.detail, row.category === 'failure' ? 'error' : 'hint'));
    else node.append(el('p', 'Run 时间仅证明两次调用之间的间隔；其中可能包含交付活动，不能倒推等待对象。', 'hint'));
    if (row.evidence_limited) node.append(el('p', '来源／等待对象的安全元数据受限，未显示的部分不等于不存在；可读取完整安全原文。', 'hint'));
    for (const id of row.event_ids || []) node.append(button('查看事件证据', async () => { const target = await reveal(evidenceReference(id)); target?.scrollIntoView?.({ block: 'center' }); }, 'ghost'));
    return node;
  }
  function renderRecord(entry) {
    let node = cards.get(entry.key);
    if (!node) {
      node = el('article', undefined, 'lifecycle-evidence-record'); node.dataset.lifecycleRecord = entry.key;
      const title = el('strong'), when = el('span', '', 'hint'), preview = el('p', '', 'lifecycle-record-preview');
      const body = el('pre', '', 'lifecycle-record-body'); body.hidden = true;
      const open = button('展开记录', () => { node.expanded = !node.expanded; paintRecord(); }, 'ghost');
      const load = button('读取完整原文', async () => {
        const read = beginRead(); load.disabled = true;
        try {
          const cached = full.get(entry.key), offset = cached?.next_offset ?? 0;
          const page = await loadReadingRecord(current.id, entry.kind, entry.id, offset, { signal: read.signal });
          if (!read.valid()) return;
          if (page.offset !== offset || page.next_offset <= offset && page.has_more) throw new Error('原文游标未前进');
          checkBudget(page.text.length);
          const text = (cached?.text || '') + page.text;
          full.set(entry.key, { text, next_offset: page.next_offset, complete: !page.has_more });
          if (!page.has_more && entry.kind === 'event' && ['worker.phase_changed', 'invocation.started'].includes(entry.event.type)) {
            try { const value = JSON.parse(text); const source = events.get(entry.id); source.data = value; source.limitations = []; } catch { /* visible original is still authoritative */ }
          }
          node.expanded = true; paint();
        } catch (error) { if (read.valid()) { notice = `原文读取未完成：${error.message}`; paint(); } }
        finally { load.disabled = false; finishRead(read); }
      }, 'ghost');
      function paintRecord() {
        const value = node.entry, cached = full.get(value.key), text = cached?.text || value.text;
        if (title.textContent !== value.title) title.textContent = value.title;
        if (when.textContent !== timestamp(value.at)) when.textContent = timestamp(value.at);
        const excerpt = text.slice(0, 240) + (text.length > 240 ? '…' : '');
        if (preview.textContent !== excerpt) preview.textContent = excerpt;
        if (body.textContent !== text) body.textContent = text;
        body.hidden = !node.expanded; preview.hidden = Boolean(node.expanded);
        open.textContent = node.expanded ? '收起记录' : '展开记录'; load.hidden = Boolean(cached?.complete);
        load.textContent = cached ? cached.complete ? '完整原文已读完' : '继续读取原文' : '读取完整原文';
      }
      node.paintRecord = paintRecord; node.revealReadingContent = () => { node.expanded = true; paintRecord(); };
      node.append(title, when, preview, open, body, load); cards.set(entry.key, node);
    }
    node.entry = entry; node.paintRecord();
    referenceable(node, { kind: entry.kind === 'event' ? 'history_event' : 'message',
      target: { task_id: current.id, [entry.kind === 'event' ? 'event_id' : 'message_id']: entry.id }, label: entry.title, quote: entry.text });
    return node;
  }
  function paint() {
    if (selecting()) { pendingPaint = true; owner?.addEventListener?.('selectionchange', flushSelection); return; }
    pendingPaint = false; owner?.removeEventListener?.('selectionchange', flushSelection);
    const model = lifecycleModel(current, [...events.values()].filter(event => modelIds.has(event.id)), [...messages.values()], { ranges: windows });
    const state = model.current;
    currentNode.replaceChildren(el('strong', `当前：${state.label}`), el('span', state.start
      ? state.duration_ms == null ? ` · 状态记录于 ${timestamp(state.start)}` : ` · 已持续 ${lifecycleDuration(state.duration_ms)}` : ' · 阶段起点未知，不能计算时长', 'hint'));
    if (state.child_ids?.length) currentNode.append(el('div', `已知等待对象：${state.child_ids.map(id => model.workerName(id, state.children?.find(child => child.id === id)?.worker_number)).join('、')}`));
    if (state.notice_ids?.length) currentNode.append(el('div', `已知等待决定：${state.notice_ids.map(id => `${['question', 'questionnaire', 'plan'].includes(state.notices?.find(notice => notice.id === id)?.kind) ? 'D' : 'N'}${id}`).join('、')}`));
    if (state.evidence_limited) currentNode.append(el('p', '当前快照元数据受限，等待对象可能未列全。', 'hint'));
    const ordered = direction === 'desc' ? [...model.rows].reverse() : model.rows;
    syncChildren(list, ordered.map(row => renderRow(row, model)));
    const all = rawEntries(), filtered = all.filter(entry => !query || remoteHits.has(entry.key) || `${entry.title}\n${full.get(entry.key)?.text || entry.text}\n${JSON.stringify(entry.metadata || {})}`.toLowerCase().includes(query));
    syncChildren(records, (direction === 'desc' ? [...filtered].reverse() : filtered).map(renderRecord));
    asc.setAttribute('aria-pressed', String(direction === 'asc')); desc.setAttribute('aria-pressed', String(direction === 'desc')); root.dataset.order = direction;
    const message = [historyState, notice].filter(Boolean).join(' · ');
    status.textContent = `${message}${message ? ' · ' : ''}已加载 ${model.calls.length} 次调用、${model.phases.length} 个阶段，${all.length} 条事件／通信；${complete ? '历史已遍历，长原文仍可分段读取' : '历史范围未完成'}。`;
    more.hidden = complete;
  }
  function checkPage(page, beforeEvent, beforeMessage) {
    if (!Array.isArray(page.events) || !Array.isArray(page.messages)) throw new Error('完整历史读面不可用，请更新后台');
    if (page.has_more_events && (page.event_cursor == null || page.event_cursor === beforeEvent)
      || page.has_more_messages && (page.message_cursor == null || page.message_cursor === beforeMessage)) throw new Error('历史游标未前进');
  }
  async function loadMore() {
    const read = beginRead(); more.disabled = true; scan.disabled = true;
    try {
      const beforeEvent = eventCursor, beforeMessage = messageCursor;
      const page = await loadReadingPage(current.id, { before_event: beforeEvent, before_message: beforeMessage }, { signal: read.signal });
      if (!read.valid()) return; checkPage(page, beforeEvent, beforeMessage); ingest(page, { continuous: true, upper: beforeEvent });
      if (page.errors?.length) throw new Error('部分历史记录不可读');
      eventCursor = page.has_more_events ? page.event_cursor : 0; messageCursor = page.has_more_messages ? page.message_cursor : 0;
      complete = !page.has_more_events && !page.has_more_messages; notice = ''; paint();
    } catch (error) { if (read.valid()) { notice = `读取未完成：${error.message}；可重试`; paint(); } }
    finally { finishRead(read); }
  }
  async function scanAll() {
    const read = beginRead(); scan.disabled = true; more.disabled = true; remoteHits.clear();
    let beforeEvent = null, beforeMessage = null, scanned = 0;
    try {
      do {
        const page = await loadReadingPage(current.id, { before_event: beforeEvent, before_message: beforeMessage, query }, { signal: read.signal });
        if (!read.valid()) return; checkPage(page, beforeEvent, beforeMessage); scanned += (page.scanned_events || 0) + (page.scanned_messages || 0);
        ingest(page, { continuous: !query, upper: beforeEvent, hits: true });
        if (page.errors?.length) throw new Error('部分记录不可读，不能报告无命中');
        beforeEvent = page.has_more_events ? page.event_cursor : 0; beforeMessage = page.has_more_messages ? page.message_cursor : 0;
        notice = `已扫描 ${scanned} 条事件／消息，查找尚未完成`; paint();
      } while ((beforeEvent || beforeMessage) && read.valid());
      if (!query) { complete = true; eventCursor = 0; messageCursor = 0; }
      notice = `查找完成：扫描 ${scanned} 条事件／消息，历史命中 ${remoteHits.size} 条（不含执行过程；新记录需重新查找）`; paint();
    } catch (error) { if (read.valid()) { notice = `查找未完成：${error.message}；已扫描 ${scanned} 条，可重试`; paint(); } }
    finally { finishRead(read); }
  }
  root.updateTimeline = (nextTask, page = {}) => {
    page ||= {};
    if (complete && current.updated_at !== nextTask.updated_at) { complete = false; eventCursor = null; messageCursor = null; }
    current = nextTask; view = ui.view;
    const initial = !events.size;
    try { ingest({ ...page, messages: [...(nextTask.messages || []), ...(page.messages || [])] }, { continuous: true }); }
    catch (error) { historyState = ''; notice = `接收新记录未完成：${error.message}；保留已有阅读内容`; paint(); return; }
    if (initial && page.events?.length) eventCursor = page.cursor ?? Math.min(...page.events.map(event => event.id));
    historyState = page.unavailable ? '历史不可用，可重试读取' : page.loading && !modelIds.size ? '历史加载中' : '';
    paint();
  };
  root.updateTimeline(task, history); return root;
}
