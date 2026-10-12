import { afterAll, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText } from './project-dom.js';
import { makeWorld } from './dom-world.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { appendToWorker, buffer } from '../../src/ui/web/assets/composer.js';
import { composerReferences, setComposerReferences } from '../../src/ui/web/assets/context-references.js';
import { settingsClient } from '../../src/ui/web/assets/settings-api.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';

const world = makeWorld(), calls = [];
const dom = installDom({ fetch: (url, options) => { calls.push(String(url)); return world.fetchImpl(url, options); } });
const { boot } = await import('../../src/ui/web/assets/app.js');
beforeEach(async () => {
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; dom.location.hash = '';
  dom.node('input').value = ''; world.state.actions = [];
  await boot(); calls.length = 0;
});
afterAll(() => dom.restore());
const retiredRequest = url => /quick[-_]chat|quick[-_]explain/.test(url);
const snapshot = () => ({ version: 1, kind: 'text', target: {}, label: '历史引用', quote: '当时所见',
  location: { view: 'quick-explain', task_id: 23 }, captured_at: '2026-01-01T00:00:00.000Z' });

test('入口、专属模块与模型调用帮助退役，没有僵尸依赖或 chat 样式', async () => {
  const assets = new URL('../../src/ui/web/assets/', import.meta.url);
  for (const name of ['quick-chat.js', 'quick-chat-model.js', 'render-quick-chat.js', 'styles-quick-chat.css'])
    expect(fs.existsSync(new URL(name, assets))).toBe(false);
  for (const name of fs.readdirSync(assets).filter(name => /\.(js|css|html)$/.test(name) && !name.endsWith('.min.js'))) {
    const source = await Bun.file(new URL(name, assets)).text();
    expect(source).not.toMatch(/quick[-_]chat|quick[-_]explain|composer-chat|composerChatMode|syncQuickChatReferences|data-mode="chat"|MODEL_NOTE|modelHelp\(/);
  }
  const html = await Bun.file(new URL('index.html', assets)).text();
  expect(html).not.toContain('快速对话');
  expect(html).toContain('id="input-start"'); expect(html).toContain('id="composer-reset"');
  expect(Object.hasOwn(ui, 'composerChatMode')).toBe(false);
});

test('旧对话深链接不加载模块、历史或 Prompt，普通输入正文与历史引用仍保留', async () => {
  dom.node('input').value = '未发送的普通指令';
  const reference = snapshot(); setComposerReferences([reference]);
  for (const hash of ['#quick-chat', '#quick-chat-settings', '#quick-chat-C1', '#quick-explain', '#quick-explain-history']) {
    dom.location.hash = hash; await dom.fire('hashchange');
    expect(ui.view.id).toBe('overview'); expect(dom.node('input-form').dataset.mode).toBe('create');
    expect(dom.node('input').value).toBe('未发送的普通指令'); expect(composerReferences()).toEqual([reference]);
  }
  expect(calls.some(retiredRequest)).toBe(false); expect(world.state.actions).toHaveLength(0);
});

test('项目与全局选区右键只提供引用，不读取配置或触发模型', async () => {
  const text = dom.document.createElement('p'); text.textContent = '页面原文'; dom.node('detail').append(text);
  for (const pathname of ['/p/aaaaaaaaaaaaaaaa/', '/']) {
    dom.location.pathname = pathname; dom.setSelection('选中的文字');
    await dom.fire('contextmenu', { target: text, clientX: 10, clientY: 20, preventDefault() {} });
    const menu = dom.node('context-menu'); expect(menu.hidden).toBe(false);
    expect(menu.querySelectorAll('button').every(node => node.textContent.startsWith('引用：'))).toBe(true);
    expect(menu.querySelector('.agent-call')).toBeNull(); expect(deepText(menu)).not.toContain('快速解释');
    await menu.querySelector('button').onclick();
    expect(composerReferences()[0].quote).toBe('选中的文字');
  }
  expect(calls).toHaveLength(0); expect(world.state.actions).toHaveLength(0);
});

test('退役后暂存、新建与显式追加仍走原有普通通道，引用快照不迁移', async () => {
  const input = dom.node('input'), reference = snapshot(); setComposerReferences([reference]); input.value = '先暂存';
  await buffer(); expect(world.state.actions.at(-1)).toMatchObject({ method: 'draft.add', params: { content: '先暂存', references: [reference] } });
  input.value = '新建指令'; input.oninput();
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(world.state.actions.at(-1)).toMatchObject({ method: 'order.submit', params: { content: '新建指令', start: false } });
  activateDetailView({ view: 'task' }); ui.selected = 1;
  appendToWorker({ id: 1, worker_number: 'W1', task_kind: 'order', status: 'waiting', branch: 'lush/1-x' });
  expect(dom.node('input-form').dataset.mode).toBe('append'); input.value = '继续开发'; input.oninput();
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  expect(world.state.actions.at(-1)).toMatchObject({ method: 'worker.message', params: { id: 1, body: '继续开发' } });
  expect(dom.node('input-form').dataset.mode).toBe('create'); expect(calls.some(retiredRequest)).toBe(false);
});

test('设备设置 transport 拒绝对话配置读写，正常 Agent 模型配置继续可读', async () => {
  const client = settingsClient();
  for (const url of ['/api/quick-explain/config', '/api/quick-chat/config'])
    await expect(client.read(url)).rejects.toThrow('不属于配置管理');
  await expect(client.action('quick_explain.configure', { config: {} })).rejects.toThrow('不属于配置管理');
  expect(calls).toHaveLength(0);
  expect(await client.read('/api/agent/config')).toHaveProperty('default');
  expect(await client.read('/api/agent/connections')).toHaveProperty('connections');
  expect(calls.every(url => url.startsWith('/api/host/settings/agent/'))).toBe(true);
});
