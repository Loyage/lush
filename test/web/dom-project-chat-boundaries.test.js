import { afterAll, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { until } from '../helpers.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { openQuickChatPage, openQuickChatSettings, openQuickChatConversation } from '../../src/ui/web/assets/render-quick-chat.js';
import { quickChatAction, quickChatConfig, conversationHref, startSelectionChat } from '../../src/ui/web/assets/quick-chat.js';
import { openComposerChat } from '../../src/ui/web/assets/composer.js';

const a = 'aaaaaaaaaaaaaaaa', b = 'bbbbbbbbbbbbbbbb', world = makeWorld(), calls = [];
let intercept;
const json = data => ({ ok: true, status: 200, json: async () => data });
const dom = installDom({ fetch: async (url, options = {}) => {
  const raw = String(url); calls.push({ url: raw, options });
  if (intercept) { const result = intercept(raw, options); if (result) return result; }
  if (raw === '/api/host') return json({ mode: 'host', projects: [{ id: a, running: false }, { id: b, running: false }] });
  return world.fetchImpl(raw.replace(/^\/p\/[a-f0-9]{16}\/api\//, '/api/'), options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const row = (content = 'A 的内容') => ({ id: 1, number: 'C1', status: 'completed', content, references: [], prompt: { id: 'explain', name: '示例', prompt: '原 Prompt' },
  source: { label: '共用来源' }, model: 'fixture-model', turns: [{ id: 1, content, result: content, status: 'completed' }] });
beforeEach(async () => {
  intercept = null; ui.disposeQuickChatPage?.(); dom.location.pathname = `/p/${a}/`; dom.location.hash = ''; dom.setSelection('');
  world.state.quickChats.clear(); world.state.quickChatSeq = 0; world.state.quickChatActions = [];
  Object.assign(world.state.quickExplanationConfig, { ready: true, reason: null, connection_id: world.state.agentConnections.connections[0].id, model: 'fixture-model' });
  await boot(); calls.length = 0;
});
afterAll(() => { ui.disposeQuickChatPage?.(); dom.restore(); });

test('无项目的快速对话深链接不读取历史/Prompt，直接调用也拒绝，不开放全局模型菜单', async () => {
  dom.location.pathname = '/';
  for (const hash of ['#quick-chat', '#quick-chat-settings', '#quick-chat-C1', '#quick-explain-history', '#quick-explain']) {
    dom.location.hash = hash; await boot(); expect(ui.view.id).toBe('unavailable');
  }
  expect(calls.filter(call => call.url.includes('/quick-chat/'))).toHaveLength(0);
  expect(() => quickChatConfig()).toThrow('项目'); expect(() => quickChatAction('start', {})).toThrow('项目');
  await expect(openQuickChatPage()).rejects.toThrow('项目'); await expect(openQuickChatSettings()).rejects.toThrow('项目'); await expect(openQuickChatConversation(1)).rejects.toThrow('项目');
  await openComposerChat(); expect(ui.composerChatMode).toBeNull();
});

test('对话和设置导航属于项目，详情唯一选中对话导航，所有 C1 链接固定当前项目', async () => {
  world.state.quickChats.set(1, row()); await dom.node('quick-chat-open').onclick();
  expect(ui.view.id).toBe('quick-chat'); expect(dom.node('quick-chat-open').getAttribute('aria-current')).toBe('page');
  expect(dom.node('detail').querySelector('.quick-chat-history-row').querySelector('a').href).toBe(`/p/${a}/#quick-chat-C1`);
  await dom.node('quick-chat-settings-open').onclick(); expect(ui.view.id).toBe('quick-chat-settings');
  expect(dom.node('quick-chat-settings-open').getAttribute('aria-current')).toBe('page'); expect(dom.node('quick-chat-open').classList.contains('selected')).toBe(false);
  dom.location.hash = '#quick-chat-C1'; await dom.fire('hashchange'); expect(ui.view.key).toBe('quick-chat-C1');
  expect(dom.node('quick-chat-open').classList.contains('selected')).toBe(true); expect(dom.node('quick-chat-settings-open').classList.contains('selected')).toBe(false);
  expect(conversationHref(1)).toBe(`/p/${a}/#quick-chat-C1`);
  dom.location.pathname = `/p/${b}/`; expect(conversationHref(1)).toBe(`/p/${b}/#quick-chat-C1`);
});

test('两项目相同 C1 通过独立项目 API 读取，迟到 A 读取不能显示到 B', async () => {
  intercept = url => url.endsWith('/api/quick-chat/1') ? json(row(url.startsWith(`/p/${a}/`) ? 'A 独立历史' : 'B 独立历史')) : null;
  await openQuickChatConversation(1); expect(deepText(dom.node('detail'))).toContain('A 独立历史');
  dom.location.pathname = `/p/${b}/`; await openQuickChatConversation(1); expect(deepText(dom.node('detail'))).toContain('B 独立历史'); expect(deepText(dom.node('detail'))).not.toContain('A 独立历史');
  dom.location.pathname = `/p/${a}/`; let resolve;
  intercept = url => url.endsWith('/api/quick-chat/1') ? new Promise(done => { resolve = done; }) : null;
  const loading = openQuickChatConversation(1); await until(() => resolve);
  dom.location.pathname = `/p/${b}/`; dom.node('detail').replaceChildren(); resolve(json(row('A 迟到内容'))); await loading;
  expect(deepText(dom.node('detail'))).not.toContain('A 迟到内容');
});

test('菜单固定来源项目，项目切换后的旧动作和迟到菜单配置不能发到另一个项目', async () => {
  const target = dom.document.createElement('p'); target.textContent = '选区'; dom.setSelection('选中的内容');
  await dom.fire('contextmenu', { target, preventDefault() {} }); const action = findByText(dom.node('context-menu'), '快速解释'); expect(action).toBeTruthy();
  dom.location.pathname = `/p/${b}/`; await action.onclick(); expect(world.state.quickChatActions).toHaveLength(0);
  dom.location.pathname = `/p/${a}/`; let resolve;
  intercept = url => url.endsWith('/quick-chat/config') ? new Promise(done => { resolve = done; }) : null;
  const loading = dom.fire('contextmenu', { target, preventDefault() {} }); await until(() => resolve);
  dom.location.pathname = `/p/${b}/`; resolve(json({ prompts: world.state.quickChatPrompts, model: { ready: true } })); await loading;
  expect(findByText(dom.node('context-menu'), '快速解释')).toBeNull();
});

test('在途选区调用始终把预开标签送回来源项目，切换项目不会挂新项目结果宿主', async () => {
  const tab = { closed: false, document: { body: {} }, location: { replace(href) { tab.href = href; } }, close() { this.closed = true; } };
  dom.window.open = () => tab; let resolve;
  intercept = url => url.endsWith('/quick-chat/action') ? new Promise(done => { resolve = done; }) : null;
  const ref = { version: 1, kind: 'text', target: {}, label: '所选文字', quote: '选区', location: { view: 'overview' }, captured_at: '2026-10-01T00:00:00Z' };
  const sending = startSelectionChat('explain', '选区', ref); await until(() => resolve);
  dom.location.pathname = `/p/${b}/`; resolve(json(row())); await sending;
  expect(tab.href).toBe(`/p/${a}/#quick-chat-C1`); expect(dom.node('quick-chat-open-result').querySelector('a')).toBeNull();
  const sent = calls.find(call => call.options.method === 'POST'); expect(sent.url).toBe(`/p/${a}/api/quick-chat/action`);
  expect(JSON.parse(sent.options.body).params.references[0].project_id).toBe(a);
});
