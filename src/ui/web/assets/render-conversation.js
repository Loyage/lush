import { block, button, el, syncChildren } from './dom.js';
import { agentText, markdownEnabled } from './text.js';
import { absolute, inputNumber } from './format.js';
import { ui } from './state.js';
import { loadHostSession, usernameInitial } from './host-session.js';
import { loadReadingPage, loadReadingRecord } from './api.js';
import { referenceable } from './context-references.js';
import { workerLabel } from './worker-label.js';
import { renderTaskMessageBody } from './render-task-message.js';

const followup = event => event.type === 'message' && event.data?.sender === null && typeof event.data.body === 'string'
  && !event.data.signal_type && !event.message?.signal_type && event.message?.sender_id == null;
const appendNumber = value => typeof value === 'string' && /^A[1-9]\d*-[1-9]\d*$/.test(value) ? value : null;
const originalNumber = id => Number.isSafeInteger(id) && id > 0 ? inputNumber(id) : null;
const time = at => Number.isFinite(Date.parse(at)) ? Date.parse(at) : null;
const inputTime = delivery => delivery?.status === 'delivered' && time(delivery.at) !== null
  ? `输入时间：${absolute(delivery.at)}` : delivery?.status === 'pending' ? '待输入' : '输入时间未知';
const answerText = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const MAX_LOADED_CHARS = 4 * 1024 * 1024; // At most 8 MiB of UTF-16 reading text per panel.

/** All incoming messages and result rounds share one read-only, bounded historical reader. */
export function renderConversation(task, history = {}, previous = null) {
  history ||= {};
  if (previous?.conversationTaskId === task.id) { previous.updateConversation(task, history); return previous; }
  if (!task.goal && !task.result && !(task.runs || []).some(run => run.result) && !(task.messages || []).length
    && !(history.events || []).length && !history.loading && !history.unavailable && !history.has_more && !history.truncated) return null;
  const session = ui.hostSession, ownerDocument = globalThis.document, boot = ui.workerNumbers;
  let view = ui.view, lifetime = null, live = null, active = null, generation = 0;
  const root = block('输入与结果'); root.classList.add('conversation-panel'); root.conversationTaskId = task.id;
  const head = root.querySelector('.section-title');
  const count = el('span', '', 'count'), ordering = el('div', undefined, 'conversation-order');
  ordering.setAttribute('role', 'group'); ordering.setAttribute('aria-label', '输入与结果排序');
  const list = el('div', undefined, 'conversation-list'), status = el('p', '', 'hint conversation-status');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  let current = task, direction = 'desc', historyState = '', query = '', remoteQuery = null;
  let eventCursor = null, messageCursor = null, complete = false, scannedEvents = 0, scannedMessages = 0;
  const inputs = new Map(), outputs = new Map(), others = new Map(), rendered = new Map(), remoteHits = new Set();
  const visible = { input: true, output: true, other: false }, checkboxes = {};
  const filters = el('div', undefined, 'conversation-filters');
  filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', '输入与结果显示内容');
  for (const [side, text] of [['input', '用户输入'], ['output', 'Worker 结果'], ['other', '系统与 Worker 通信']]) {
    const label = el('label'), checkbox = el('input');
    checkbox.type = 'checkbox'; checkbox.checked = visible[side]; checkbox.dataset.conversationFilter = side;
    checkbox.onchange = () => { visible[side] = checkbox.checked; paint(); };
    checkboxes[side] = checkbox; label.append(checkbox, el('span', text)); filters.append(label);
  }
  const asc = button('正序', () => { direction = 'asc'; paint(); }, 'ghost', { help: '按时间从早到晚阅读已加载的输入和结果，只改变显示顺序，不调用 Agent。' });
  const desc = button('倒序', () => { direction = 'desc'; paint(); }, 'ghost', { help: '按时间从晚到早阅读已加载的输入和结果，只改变显示顺序，不调用 Agent。' });
  ordering.append(asc, desc); head.append(count, ordering);
  const search = el('div', undefined, 'conversation-search'), keyword = el('input');
  keyword.type = 'search'; keyword.placeholder = '关键词：即时筛选已加载完整正文'; keyword.setAttribute('aria-label', '筛选输入与结果');
  keyword.oninput = () => {
    cancelRead(); query = keyword.value.trim().toLowerCase(); remoteQuery = null; remoteHits.clear();
    status.textContent = '仅筛选已加载完整正文；未加载或未读完的记录不计为无命中。'; paint();
  };
  const findAll = button('查找全部历史', () => scanAll(), 'ghost', {
    help: '显式分批检索此 Worker 的全部收件箱与事件正文，可取消；不读取执行过程、不启动 Agent，不自动后台扫描。',
  });
  const cancel = button('取消查找', () => {
    cancelRead(); status.textContent = `查找已取消，范围未完成：已扫描 ${scannedEvents} 个事件、${scannedMessages} 条消息；已读取的内容保留。`; paint();
  }, 'ghost'); cancel.hidden = true;
  const findHost = el('span', undefined, 'help-host'); findHost.setAttribute('data-help', '正在读取时可取消查找；取消只停止本页读取，不删除已加载记录。'); findHost.append(findAll);
  search.append(keyword, findHost, cancel);
  const more = button('加载更早输入与结果', () => loadMore(), 'ghost conversation-more');
  const moreHost = el('span', undefined, 'help-host'); moreHost.setAttribute('data-help', '逐批读取更早的收件箱与事件；其他读取进行中时请先取消或等待。'); moreHost.append(more);
  root.append(filters, search, list, status, moreHost);

  function alive() {
    return globalThis.document === ownerDocument && ui.workerNumbers === boot && ui.view === view
      && (!live || live()) && !lifetime?.aborted;
  }
  function cancelRead() {
    generation++; active?.abort(); active = null; cancel.hidden = true; findAll.disabled = false; more.disabled = false;
  }
  function beginRead() {
    cancelRead(); const controller = new AbortController(); active = controller;
    const ticket = generation;
    return { signal: controller.signal, valid: () => alive() && generation === ticket && !controller.signal.aborted };
  }
  function finishRead(read) {
    if (!read.valid()) return;
    active = null; cancel.hidden = true; findAll.disabled = false; more.disabled = false;
  }
  root.bindConversationLifetime = (signal, isCurrent) => {
    lifetime = signal; live = isCurrent; view = ui.view;
    signal?.addEventListener('abort', () => {
      if (lifetime === signal && active) {
        cancelRead(); status.textContent = '读取已取消，历史范围尚未完成；可重新查找。';
      }
    }, { once: true });
  };

  function message(entry, latestKey) {
    let node = rendered.get(entry.key);
    const notice = entry.decision && (current.notices || []).find(notice => notice.id === entry.decision.notice_id);
    const decision = entry.decision ? { ...entry.decision, notice_kind: entry.decision.notice_kind ?? notice?.kind,
      title: entry.decision.title ?? notice?.title } : null;
    const signature = JSON.stringify([entry.text, entry.side, entry.source, entry.truncated, entry.limitations, decision, markdownEnabled()]);
    if (!node) {
      node = el('article', undefined, `conversation-message conversation-${entry.side}`);
      node.dataset.conversationKey = entry.key;
      const meta = el('div', undefined, 'conversation-meta'), avatar = el('span', '', `conversation-avatar avatar-${entry.side}`);
      avatar.setAttribute('aria-hidden', 'true');
      meta.append(avatar, el('strong', '', 'conversation-sender'), el('span', '', 'conversation-kind'), el('time', '', 'conversation-time'));
      const body = el('div', undefined, 'conversation-body');
      const toggle = button('', () => {
        setExpanded(!node.expanded);
        if (!node.expanded) toggle.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
      }, 'ghost conversation-expand', { help: '就地展开或收起这条消息的已加载正文，只改变阅读长度，不删除内容，也不调用 Agent。' });
      body.id = `conversation-${current.id}-${entry.key.replace(/[^a-z0-9-]/gi, '-')}`; toggle.setAttribute('aria-controls', body.id);
      meta.append(toggle); node.append(meta, body); node.expanded = false;
      function setExpanded(value) {
        node.expanded = Boolean(value); node.classList.toggle('conversation-expanded', node.expanded);
        toggle.textContent = node.expanded ? '收起消息' : '展开消息'; toggle.setAttribute('aria-expanded', String(node.expanded));
      }
      body.addEventListener('focusin', () => setExpanded(true));
      node.revealReadingContent = () => setExpanded(true); node.updateExpansion = () => setExpanded(node.expanded);
      node.measureReadingContent = limit => {
        const height = body.querySelector('.conversation-prose')?.getBoundingClientRect?.().height;
        if (height == null || !limit) return;
        const long = height > Math.min(260, limit * 0.7) + 60;
        node.classList.toggle('conversation-long', long); toggle.hidden = !long;
      };
      rendered.set(entry.key, node);
    }
    node.entry = entry;
    if (node.bodySignature !== signature) {
      const originalOpen = node.querySelector('.message-original')?.open === true;
      const content = entry.side === 'other' ? el('div', undefined, 'conversation-prose conversation-communication')
        : agentText(entry.text, { className: 'conversation-prose', plain: 'div' });
      if (entry.side === 'other') content.append(renderTaskMessageBody({ body: entry.text, trustEnvelope: entry.source !== 'unknown' && !entry.truncated,
        originalLabel: entry.truncated ? '查看已加载原文（尚未完整）' : '查看完整原文', decision }));
      else {
        const original = el('details', undefined, 'message-original'); original.append(el('summary', entry.truncated ? '查看已加载原文（尚未完整）' : '查看完整原文'));
        original.addEventListener('toggle', () => { if (original.open && !original.querySelector('pre')) original.append(el('pre', entry.text, 'raw-value')); });
        content.append(original);
      }
      if (entry.limitations?.length) content.append(el('p', `附属字段采用有界预览或来源证据不完整：${entry.limitations.join('、')}；正文完整性另行标注。`, 'hint conversation-limitations'));
      if (entry.truncated) {
        content.append(el('p', `正文尚未读完：已加载 ${entry.text.length} / ${entry.totalChars ?? '未知'} 字；本地筛选不判定此记录无命中。`, 'hint conversation-incomplete'));
        const recordStatus = el('p', '', 'hint');
        const readMore = button('继续读取正文', async () => {
          const read = beginRead(), saved = node.entry; readMore.disabled = true;
          try {
            const page = await loadReadingRecord(current.id, saved.recordKind, saved.recordId, saved.text.length, { signal: read.signal });
            if (!read.valid()) return;
            if (typeof page.text !== 'string' || page.offset !== saved.text.length || page.next_offset <= page.offset && page.has_more) throw new Error('正文游标未前进');
            if (entries().all.reduce((sum, entry) => sum + entry.text.length, 0) + page.text.length > MAX_LOADED_CHARS) throw new Error('已加载正文达到 8 MiB 阅读预算；未读部分不能判为无命中');
            saved.text += page.text; saved.truncated = Boolean(page.has_more); saved.totalChars = page.total_chars;
            const map = saved.side === 'input' ? inputs : saved.side === 'output' ? outputs : others;
            map.set(saved.key, saved); paint(); node.revealReadingContent();
          } catch (error) { if (read.valid()) { recordStatus.textContent = `正文读取失败：${error.message}；可重试。`; readMore.disabled = false; } }
          finally { readMore.disabled = false; finishRead(read); }
        }, 'ghost conversation-read-more'); content.append(readMore, recordStatus);
      }
      node.classList.toggle('conversation-failed', Boolean(content.querySelector('.message-failed')));
      if (originalOpen) {
        const original = content.querySelector('.message-original');
        if (original) { original.open = true; if (!original.querySelector('pre')) original.append(el('pre', entry.text, 'raw-value')); }
      }
      node.querySelector('.conversation-body').replaceChildren(content); node.bodySignature = signature;
      const long = entry.truncated || entry.text.length > 1200 || entry.text.split('\n').length > 12;
      node.classList.toggle('conversation-long', long); node.querySelector('.conversation-expand').hidden = !long; node.updateExpansion();
    }
    const username = ui.hostSession.status === 'ready' ? ui.hostSession.username : null;
    for (const side of ['input', 'output', 'other']) {
      node.classList.toggle(`conversation-${side}`, entry.side === side);
      node.querySelector('.conversation-avatar').classList.toggle(`avatar-${side}`, entry.side === side);
    }
    node.querySelector('.conversation-avatar').textContent = entry.side === 'input' ? usernameInitial(username) : entry.side === 'other' ? '信' : '🤖';
    node.querySelector('.conversation-sender').textContent = entry.side === 'input' ? username || '账号名称未知'
      : entry.side === 'other' ? entry.source === 'unknown' ? '来源不明' : entry.senderId != null ? `Worker ${workerLabel(entry.senderId, entry.senderNumber)}`
        : entry.source === 'user' ? '用户答复' : entry.source === 'lush' ? 'Lush 自动选择' : '系统' : `Worker ${workerLabel(current)}`;
    const number = entry.key === 'goal' ? originalNumber(current.input_id) : entry.appendNumber;
    node.querySelector('.conversation-kind').textContent = entry.side === 'input'
      ? `${entry.kind}${number ? ` · ${number}` : entry.key !== 'goal' ? entry.messageId != null ? ` · 消息 #${entry.messageId}` : ' · 追加编号未知' : ''}` : entry.kind;
    const at = entry.side === 'input' ? entry.delivery?.at : entry.at, clock = node.querySelector('.conversation-time');
    clock.textContent = entry.side === 'input' ? inputTime(entry.delivery) : entry.side === 'other'
      ? time(at) === null ? '通信时间未知' : `通信时间：${absolute(at)}` : time(at) === null ? '结果时间未知' : absolute(at);
    if (time(at) !== null && (entry.side !== 'input' || entry.delivery?.status === 'delivered')) clock.setAttribute('datetime', at);
    else clock.removeAttribute('datetime');
    const refs = [];
    if (entry.key === latestKey) refs.push({ kind: 'result', target: { task_id: current.id, section: 'result' },
      label: `Worker 结果 ${workerLabel(current)}`, quote: entry.text, location: { view: 'task-detail', task_id: current.id, section: 'result' } });
    if (entry.eventId) refs.push({ kind: 'history_event', target: { task_id: current.id, event_id: entry.eventId },
      label: `${entry.kind} ${workerLabel(current)} · 事件 #${entry.eventId}`, quote: entry.text,
      location: { view: 'task-detail', task_id: current.id, section: 'history' } });
    if (entry.messageId != null) refs.push({ kind: 'message', target: { task_id: current.id, message_id: entry.messageId },
      label: `Worker ${workerLabel(current)} 的消息 · ${entry.kind}`, quote: entry.text, location: { view: 'task-detail', task_id: current.id, section: 'messages' } });
    referenceable(node, refs); return node;
  }

  function entries() {
    const results = [...outputs.values()].sort((a, b) => (time(b.at) ?? 0) - (time(a.at) ?? 0) || b.sequence - a.sequence);
    const matched = current.result && !results[0]?.truncated && results[0]?.text === current.result ? results[0].key : null;
    const latestKey = current.result ? matched || 'latest' : null;
    const all = [...inputs.values(), ...results, ...others.values()];
    if (current.goal) all.push({ key: 'goal', side: 'input', kind: '原始目标', text: current.goal,
      delivery: current.goal_input_delivery, at: current.created_at, sequence: 0 });
    if (current.result && !matched) all.push({ key: 'latest', side: 'output', kind: '最新结果', text: current.result, at: null, sequence: Infinity });
    return { all, latestKey };
  }
  function paint() {
    const { all, latestKey } = entries();
    all.sort((a, b) => {
      const aTime = time(a.side === 'input' && a.delivery?.status === 'delivered' ? a.delivery.at : a.at);
      const bTime = time(b.side === 'input' && b.delivery?.status === 'delivered' ? b.delivery.at : b.at);
      const rank = entry => entry.key === 'latest' ? Infinity : entry.key === 'goal' ? -Infinity : 0;
      const delta = (aTime ?? rank(a)) - (bTime ?? rank(b));
      return (Number.isNaN(delta) ? 0 : delta) || a.sequence - b.sequence || a.key.localeCompare(b.key);
    });
    if (direction === 'desc') all.reverse();
    const matches = entry => !query || !entry.truncated && entry.text.toLowerCase().includes(query)
      || remoteQuery === query && remoteHits.has(entry.key);
    const shown = all.filter(entry => visible[entry.side] && matches(entry));
    syncChildren(list, shown.map(entry => message({ ...entry, kind: entry.key === latestKey ? '最新结果' : entry.kind }, latestKey)));
    const incomplete = all.filter(entry => entry.truncated).length, limited = all.filter(entry => entry.limitations?.length).length;
    count.textContent = `显示 ${shown.length} / 已加载 ${all.length} 条 · ${complete ? '历史已遍历' : '历史范围未完成'}${incomplete ? ` · ${incomplete} 条正文未读完` : ''}${limited ? ` · ${limited} 条附属字段受限` : ''}${historyState}`;
    asc.setAttribute('aria-pressed', String(direction === 'asc')); desc.setAttribute('aria-pressed', String(direction === 'desc'));
    root.dataset.order = direction; more.hidden = complete;
  }
  function storeEntry(map, entry) {
    const old = map.get(entry.key);
    // Never replace a complete or longer body with a refresh's bounded preview.
    if (old && entry.truncated && (!old.truncated || old.text.length > entry.text.length)) {
      entry.text = old.text; entry.truncated = old.truncated; entry.totalChars = old.totalChars;
    }
    map.set(entry.key, { ...old, ...entry }); return entry.key;
  }
  function addInput(message, event = null) {
    const old = [...inputs.values()].find(entry => message.id != null && entry.messageId === message.id);
    const orphan = others.get(`other:message:${message.id}`), previous = old || orphan;
    const key = event ? `input:${event.id}` : old?.key ?? `input:message:${message.id}`;
    if (previous && previous.key !== key) {
      inputs.delete(previous.key); const node = rendered.get(previous.key);
      if (node) { rendered.delete(previous.key); rendered.set(key, node); node.dataset.conversationKey = key; }
      if (remoteHits.delete(previous.key)) remoteHits.add(key);
      inputs.set(key, { ...previous, key });
    }
    others.delete(`other:message:${message.id}`);
    return storeEntry(inputs, { ...previous, key, side: 'input', source: 'user', kind: '追加输入', text: message.body,
      messageId: message.id, eventId: event?.id ?? old?.eventId, appendNumber: appendNumber(message.append_number) || appendNumber(event?.data?.append_number) || old?.appendNumber,
      at: event?.created_at ?? message.created_at ?? old?.at, delivery: event?.input_delivery ?? message.input_delivery ?? old?.delivery,
      sequence: event?.id ?? message.id, truncated: Boolean(message.text_truncated), totalChars: message.total_chars,
      recordKind: event ? 'event' : 'message', recordId: event?.id ?? message.id,
      limitations: [...new Set([...(message.limitations || []), ...(event?.limitations || [])])] });
  }
  function addOther(message, eventId = null, source = null, kind = null, decision = null) {
    if (typeof message.body !== 'string') return null;
    const knownInput = message.id != null && [...inputs.values()].find(entry => entry.messageId === message.id);
    if (knownInput) return knownInput.key;
    const key = message.id != null ? `other:message:${message.id}` : `other:event:${eventId}`, old = others.get(key);
    source ||= message.sender_id != null ? 'worker' : message.signal_type ? 'system' : 'unknown';
    return storeEntry(others, { ...old, key, side: 'other', source, kind: kind || (source === 'unknown' ? '旧消息 · 来源不明'
      : message.sender_id != null ? 'Worker 通信' : '系统通信'), text: message.body,
      messageId: message.id, eventId: eventId ?? old?.eventId, senderId: message.sender_id,
      senderNumber: message.sender_worker_number ?? old?.senderNumber, at: message.created_at ?? old?.at,
      sequence: eventId ?? old?.sequence ?? message.id, truncated: Boolean(message.text_truncated), totalChars: message.total_chars,
      recordKind: message.id != null ? 'message' : 'event', recordId: message.id ?? eventId, decision,
      limitations: [...new Set([...(message.limitations || old?.limitations || []), ...(message.input_event?.limitations || [])])] });
  }
  function ingest(page = {}, markHits = false, includeCurrent = true) {
    const hits = [];
    if (includeCurrent) for (const run of current.runs || []) if (typeof run.result === 'string' && run.result) {
      const key = `run:${run.id}`, old = outputs.get(key);
      storeEntry(outputs, { ...old, key, side: 'output', kind: `调用 #${run.id}`, text: run.result,
        at: run.ended_at || old?.at || null, sequence: run.id, truncated: false });
    }
    for (const originalEvent of page.events || []) {
      // Legacy message events can keep their full body only in the exact linked inbox row.
      const event = originalEvent.type === 'message' && originalEvent.message && typeof originalEvent.data?.body !== 'string'
        ? { ...originalEvent, data: { ...originalEvent.data, body: originalEvent.message.body } } : originalEvent;
      const data = event.data || {};
      if (followup(event)) hits.push(addInput({ ...event.message, id: data.message_id ?? event.message?.id,
        body: data.body, append_number: data.append_number ?? event.message?.append_number,
        text_truncated: event.text_truncated ?? event.message?.text_truncated, total_chars: event.total_chars,
        limitations: event.limitations }, event));
      else if (event.type === 'message' && data.sender != null && typeof data.body === 'string') {
        hits.push(addOther({ id: data.message_id, sender_id: data.sender, body: data.body, created_at: event.created_at,
          text_truncated: event.text_truncated, total_chars: event.total_chars, limitations: event.limitations }, event.id));
      } else if (event.message && (event.message.task_id == null || event.message.task_id === current.id)
        && (event.message.sender_id != null || event.message.signal_type || event.type === 'task.signal')) hits.push(addOther(event.message, event.id));
      if (event.type === 'notice.answered') {
        const source = ['user', 'lush'].includes(data.answer_source) ? data.answer_source : 'unknown';
        hits.push(addOther({ body: answerText(data.answer), created_at: event.created_at, text_truncated: event.text_truncated,
          total_chars: event.total_chars, limitations: event.limitations }, event.id, source,
        `${data.dismiss ? '未做决定' : '决策答复'} · ${source === 'user' ? '用户' : source === 'lush' ? 'Lush 自动选择' : '来源不明'}`,
        Number.isSafeInteger(data.notice_id) ? { notice_id: data.notice_id, notice_kind: data.notice_kind, title: data.title, dismissed: data.dismiss === true } : null));
      }
      if (event.type === 'invocation.completed' && typeof data.result === 'string' && data.result) {
        const key = data.run_id ? `run:${data.run_id}` : `event:${event.id}`;
        hits.push(storeEntry(outputs, { key, side: 'output', kind: data.run_id ? `调用 #${data.run_id}` : `记录 #${event.id}`,
          eventId: event.id, text: data.result, at: event.created_at, sequence: event.id,
          truncated: Boolean(event.text_truncated), totalChars: event.total_chars, recordKind: 'event', recordId: event.id, limitations: event.limitations }));
      }
    }
    for (const message of [...(includeCurrent ? current.messages || [] : []), ...(page.messages || [])]) {
      if (message.task_id != null && message.task_id !== current.id || typeof message.body !== 'string') continue;
      const evidence = message.input_event;
      if (evidence?.type === 'message' && evidence.data?.sender === null && !message.signal_type) {
        hits.push(addInput(message, evidence));
      } else if (appendNumber(message.append_number) && !message.signal_type && message.sender_id == null) hits.push(addInput(message));
      else hits.push(addOther(message));
    }
    const deliveries = new Map((page.events || []).flatMap(event => event.input_deliveries || []).map(delivery => [delivery.message_id, delivery]));
    const messages = new Map((current.messages || []).map(message => [message.id, message]));
    for (const entry of inputs.values()) {
      if (deliveries.has(entry.messageId)) entry.delivery = deliveries.get(entry.messageId);
      entry.appendNumber ||= appendNumber(messages.get(entry.messageId)?.append_number);
    }
    if (markHits) for (const key of hits.filter(Boolean)) remoteHits.add(key);
  }
  root.updateConversation = (nextTask, page = {}) => {
    if (complete && current.updated_at !== nextTask.updated_at) { complete = false; eventCursor = null; messageCursor = null; }
    current = nextTask; view = ui.view;
    historyState = page.loading ? ' · 历史加载中' : page.unavailable ? ' · 历史不可用' : '';
    // Bounded legacy history is useful evidence, never proof that the whole reading range is complete.
    ingest(page); paint();
  };
  function checkPage(page, beforeEvent, beforeMessage) {
    if (!Array.isArray(page.events) || !Array.isArray(page.messages)) throw new Error('完整历史读面不可用；请更新后台，不使用有界旧历史冒充全部记录');
    if (page.has_more_events && (page.event_cursor == null || page.event_cursor === beforeEvent)
      || page.has_more_messages && (page.message_cursor == null || page.message_cursor === beforeMessage)) throw new Error('历史游标未前进');
    if (page.errors?.length || page.limitations?.length) throw new Error(`部分记录未能完整检索：${JSON.stringify(page.errors?.length ? page.errors : page.limitations)}`);
    const added = [...page.events, ...page.messages].reduce((sum, row) => sum + (row.body?.length || 0)
      + (typeof row.data?.body === 'string' ? row.data.body.length : 0) + (typeof row.data?.result === 'string' ? row.data.result.length : 0)
      + (row.type === 'notice.answered' ? answerText(row.data?.answer).length : 0), 0);
    if (entries().all.reduce((sum, entry) => sum + entry.text.length, 0) + added > MAX_LOADED_CHARS) throw new Error('已加载正文达到 8 MiB 阅读预算；历史范围未完成，请缩小关键词范围');
  }
  async function loadMore() {
    if (active) return;
    const read = beginRead(); more.disabled = true;
    status.textContent = '正在读取一批输入、结果与收件箱历史…';
    try {
      const page = await loadReadingPage(current.id, { before_event: eventCursor, before_message: messageCursor }, { signal: read.signal });
      if (!read.valid()) return;
      checkPage(page, eventCursor, messageCursor); ingest(page, false, false);
      eventCursor = page.has_more_events ? page.event_cursor : 0; messageCursor = page.has_more_messages ? page.message_cursor : 0;
      complete = !page.has_more_events && !page.has_more_messages;
      status.textContent = complete ? '历史已遍历；尚未读完的长正文仍需继续读取。' : '更早记录尚未读取，可继续加载。'; paint();
    } catch (error) { if (read.valid()) status.textContent = `读取未完成：${error.message}；可重试。`; }
    finally { finishRead(read); }
  }
  async function scanAll() {
    const read = beginRead(); findAll.disabled = true; more.disabled = true; cancel.hidden = false;
    const requested = query; remoteQuery = requested; remoteHits.clear(); scannedEvents = 0; scannedMessages = 0;
    let beforeEvent = null, beforeMessage = null, finished = false;
    try {
      do {
        status.textContent = `查找全部历史：已扫描 ${scannedEvents} 个事件、${scannedMessages} 条消息；范围尚未完成。`;
        const page = await loadReadingPage(current.id, { before_event: beforeEvent, before_message: beforeMessage, query: requested }, { signal: read.signal });
        if (!read.valid()) return;
        scannedEvents += page.scanned_events ?? 0; scannedMessages += page.scanned_messages ?? 0;
        checkPage(page, beforeEvent, beforeMessage); ingest(page, true, false);
        beforeEvent = page.has_more_events ? page.event_cursor : 0; beforeMessage = page.has_more_messages ? page.message_cursor : 0;
        finished = !page.has_more_events && !page.has_more_messages; paint();
      } while (!finished && read.valid());
      if (read.valid()) {
        if (!requested) { complete = true; eventCursor = 0; messageCursor = 0; }
        status.textContent = `查找完成：已扫描 ${scannedEvents} 个事件、${scannedMessages} 条消息（此 Worker 全部收件箱与事件，不含执行过程；新记录需重新查找）。${remoteHits.size ? `历史命中 ${remoteHits.size} 条；分类筛选可能隐藏命中，长正文可继续读取。` : '历史正文无命中；原始目标与最新结果另按已加载正文筛选。'}`;
      }
    } catch (error) { if (read.valid()) status.textContent = `查找失败，范围未完成：${error.message}；已扫描 ${scannedEvents} 个事件、${scannedMessages} 条消息。可重新查找，已读取内容保留。`; }
    finally { finishRead(read); paint(); }
  }
  root.revealConversationReference = async reference => {
    const target = reference.target || {}, wanted = entry => reference.kind === 'message' ? entry.messageId === target.message_id
      : reference.kind === 'history_event' ? entry.eventId === target.event_id : false;
    let entry = entries().all.find(wanted), fallback = null;
    if (!entry && ['message', 'history_event'].includes(reference.kind)) {
      const read = beginRead(), isMessage = reference.kind === 'message', id = isMessage ? target.message_id : target.event_id;
      try {
        const page = await loadReadingPage(current.id, { before_event: isMessage ? 0 : id + 1, before_message: isMessage ? id + 1 : 0, limit: 1 }, { signal: read.signal });
        if (!read.valid()) return null;
        checkPage(page); ingest(page, false, false); entry = entries().all.find(wanted);
        if (!isMessage) fallback = page.events.find(event => event.id === id);
      } finally { finishRead(read); }
    }
    if (reference.kind === 'result') { const data = entries(); entry = data.all.find(item => item.key === data.latestKey); }
    if (!entry) return fallback ? root.attachReferencedHistoryEvent?.(fallback) ?? null : null;
    cancelRead(); query = ''; keyword.value = ''; remoteQuery = null; remoteHits.clear();
    visible[entry.side] = true; checkboxes[entry.side].checked = true; paint();
    const node = rendered.get(entry.key); node?.revealReadingContent(); return node;
  };
  root.updateConversation(task, history);
  if (session.status === 'unread' || session.status === 'loading') void loadHostSession().then(() => {
    if (ui.hostSession === session && alive()) paint();
  });
  return root;
}
