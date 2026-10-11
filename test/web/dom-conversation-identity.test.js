import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';
import { loadHostSession, usernameInitial } from '../../src/ui/web/assets/host-session.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

const json = value => new Response(JSON.stringify(value));
const goal = { id: 900, worker_number: 'W198-3', input_id: 198, goal: '原始正文', result: 'Worker 结果' };
const event = (id, extra = {}, message = null) => ({ id, type: 'message', data: { sender: null, body: `追加正文 ${id}`, message_id: id + 50, ...extra }, message });
const entry = (root, key) => root.querySelectorAll('.conversation-message').find(node => node.dataset.conversationKey === key);
const drain = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

test('Host session is root-level single-flight; late identity patches headers without replacing reading nodes', async () => {
  let resolve; const reads = [];
  const dom = installDom({ fetch: url => { reads.push(String(url)); return new Promise(done => { resolve = done; }); } });
  try {
    resetUiState(); dom.location.pathname = '/p/0123456789abcdef/';
    const pending = loadHostSession();
    const root = renderConversation(goal, { events: [event(1, { append_number: 'A198-1' })] }); dom.node('detail').append(root);
    const user = entry(root, 'input:1'), prose = user.querySelector('.conversation-prose');
    await findByText(root, '正序').onclick(); user.revealReadingContent();
    expect(user.querySelector('.conversation-sender').textContent).toBe('账号名称未知');
    resolve(json({ username: '👩🏽‍💻<script>登录名</script>' })); await pending; await drain();
    expect(reads).toEqual(['/api/host/session']);
    expect(user.querySelector('.conversation-sender').textContent).toBe('👩🏽‍💻<script>登录名</script>');
    expect(user.querySelector('.conversation-avatar').textContent).toBe('👩🏽‍💻');
    expect(root.querySelector('script')).toBeNull(); expect(user.querySelector('.conversation-prose')).toBe(prose);
    expect(user.expanded).toBe(true); expect(root.dataset.order).toBe('asc');
    expect(entry(root, 'latest').querySelector('.conversation-avatar').textContent).toBe('🤖');
    renderConversation({ ...goal, id: 901 }); await loadHostSession(); expect(reads).toHaveLength(1);
  } finally { resetUiState(); dom.restore(); }
});

test('Unicode first character preserves supplementary, combining and emoji graphemes; W account differs from robot', async () => {
  expect(usernameInitial('𠮷姓名')).toBe('𠮷'); expect(usernameInitial('e\u0301clair')).toBe('e\u0301');
  expect(usernameInitial('👨‍👩‍👧‍👦名字')).toBe('👨‍👩‍👧‍👦'); expect(usernameInitial('')).toBe('?');
  const dom = installDom({ fetch: async () => json({ username: 'Wendy' }) });
  try {
    resetUiState(); await loadHostSession(); const root = renderConversation(goal);
    expect(entry(root, 'goal').querySelector('.conversation-avatar').textContent).toBe('W');
    expect(entry(root, 'latest').querySelector('.conversation-avatar').textContent).toBe('🤖');
  } finally { resetUiState(); dom.restore(); }
});

test('identity failures and missing login name remain explicitly unknown, cached without invented users', async () => {
  for (const value of [null, {}, { username: null }, { username: '' }, { username: 7 }, { username: '  ' }, 'failure']) {
    let reads = 0;
    const dom = installDom({ fetch: async () => { reads++; if (value === 'failure') throw new Error('offline'); return json(value); } });
    try {
      resetUiState(); const root = renderConversation(goal); await loadHostSession(); await drain();
      expect(ui.hostSession.status).toBe('unknown'); expect(ui.hostSession.username).toBeNull();
      expect(entry(root, 'goal').querySelector('.conversation-sender').textContent).toBe('账号名称未知');
      expect(entry(root, 'goal').querySelector('.conversation-avatar').textContent).toBe('?');
      await loadHostSession(); expect(reads).toBe(1);
    } finally { resetUiState(); dom.restore(); }
  }
});

test('previous boot and navigated conversation do not receive late session paint', async () => {
  let resolve;
  const dom = installDom({ fetch: () => new Promise(done => { resolve = done; }) });
  try {
    resetUiState(); ui.view = {}; const old = renderConversation(goal), oldRead = loadHostSession();
    ui.view = {}; resolve(json({ username: '迟到账号' })); await oldRead; await drain();
    expect(entry(old, 'goal').querySelector('.conversation-sender').textContent).toBe('账号名称未知');
    const current = renderConversation({ ...goal, id: 901 });
    expect(entry(current, 'goal').querySelector('.conversation-sender').textContent).toBe('迟到账号');
    resetUiState(); const pending = loadHostSession(); resetUiState(); resolve(json({ username: '旧 boot' })); await pending;
    expect(ui.hostSession.username).toBeNull(); expect(ui.hostSession.status).toBe('unread');
    expect(entry(current, 'goal').querySelector('.conversation-sender').textContent).toBe('迟到账号');
  } finally { resetUiState(); dom.restore(); }
});

test('original O uses actual Input; append A uses durable event/message evidence with history fallback and distinct system sender', async () => {
  const dom = installDom({ fetch: async () => json({ username: '实名账号' }) });
  try {
    resetUiState(); await loadHostSession();
    const history = { events: [event(1, { append_number: 'A198-7' }), event(2, {}, { id: 52, append_number: 'A198-8' }),
      event(3), event(4, { append_number: 'O198' }), event(5),
      event(6, {}, { id: 56, sender_id: null, signal_type: 'system', body: '系统信号' }),
      event(7, { append_number: 'A198-3-2' })] };
    const root = renderConversation({ ...goal, messages: [{ id: 55, sender_id: null, append_number: 'A198-12' }] }, history);
    expect(entry(root, 'goal').querySelector('.conversation-kind').textContent).toBe('原始目标 · O198');
    for (const [id, label] of [[1, 'A198-7'], [2, 'A198-8'], [3, '消息 #53'], [4, '消息 #54'], [5, 'A198-12'], [7, '消息 #57']]) {
      expect(entry(root, `input:${id}`).querySelector('.conversation-kind').textContent).toBe(`追加输入 · ${label}`);
    }
    expect(entry(root, 'input:6')).toBeUndefined();
    const others = root.querySelectorAll('input').find(node => node.dataset.conversationFilter === 'other');
    others.checked = true; others.onchange();
    expect(root.querySelector('.conversation-other').querySelector('.conversation-sender').textContent).toBe('系统');
    expect(root.querySelector('.conversation-other').querySelector('.conversation-avatar').textContent).toBe('信');
    const originalProse = entry(root, 'input:3').querySelector('.conversation-prose');
    root.updateConversation({ ...goal, messages: [{ id: 53, append_number: 'A198-99' }] }, {});
    expect(entry(root, 'input:3').querySelector('.conversation-kind').textContent).toContain('A198-99');
    expect(entry(root, 'input:3').querySelector('.conversation-prose')).toBe(originalProse);
    for (const input_id of [null, undefined, 0, -1, '198']) {
      const noInput = renderConversation({ ...goal, input_id });
      expect(entry(noInput, 'goal').querySelector('.conversation-kind').textContent).toBe('原始目标');
      expect(deepText(noInput)).not.toContain('O900');
    }
  } finally { resetUiState(); dom.restore(); }
});
