import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, env } from '../helpers.js';
import { installDom, deepText, findByText, dialogButton } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { startTestWeb, fetch as hostFetch } from './auth-fixture.js';
import { DeviceSettingsService } from '../../src/host/device-settings.js';
import { QuickChatService } from '../../src/host/quick-chat.js';

// Exercise the frontend's real request/response contract against authenticated HTTP and private
// project storage with shared device model settings. All model responses are controlled; no daemon or real model is involved.
test('frontend Prompt/composer/C followup/deletion work with real Host service and normalized snapshots', async () => {
  const root = temp(), environment = env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') });
  const settings = new DeviceSettingsService(environment), modelCalls = [], projectCalls = [];
  const source = settings.getManager().save({ label: 'DOM integration source', provider: 'openai-compatible', auth_type: 'api_key',
    endpoint: 'https://model.invalid/v1', models: ['original-model'] }, { api_key: 'synthetic-dom-test-key' });
  settings.explanation.save({ connection_id: source.id, model: 'original-model', prompt: '原解释 Prompt' });
  const home = path.join(root, 'project', '.lush', 'quick-chat');
  const service = new QuickChatService(environment, { home, settingsService: settings, fetch: async (_url, init) => {
    modelCalls.push(JSON.parse(init.body)); return Response.json({ choices: [{ message: { content: '受控模型回复' } }] });
  } });
  const projectHost = { launcher: true, chatHome(id) { expect(id).toBe('aaaaaaaaaaaaaaaa'); return home; },
    async require() { projectCalls.push('attach'); throw new Error('project offline'); },
    async openRoute() { projectCalls.push('start'); throw new Error('project offline'); } };
  const web = startTestWeb(null, 0, { env: environment, projectHost, deviceSettingsService: settings, quickChatService: service });
  const origin = `http://127.0.0.1:${web.port}`, world = makeWorld(), requests = [], tabs = [];
  const dom = installDom({ fetch: async (url, options = {}) => {
    const route = String(url); requests.push(route);
    return route.startsWith('/p/aaaaaaaaaaaaaaaa/api/quick-chat/') ? hostFetch(origin + route, options)
      : world.fetchImpl(route.replace(/^\/p\/[a-f0-9]{16}\/api\//, '/api/'), options);
  } });
  const { ui } = await import('../../src/ui/web/assets/state.js');
  const { boot } = await import('../../src/ui/web/assets/app.js');
  const { openComposerChat } = await import('../../src/ui/web/assets/composer.js');
  const { addComposerReference } = await import('../../src/ui/web/assets/context-references.js');
  const { openQuickChatSettings, openQuickChatConversation } = await import('../../src/ui/web/assets/render-quick-chat.js');
  const field = name => dom.node('detail').querySelector(`[data-chat-field="${name}"]`);
  const finish = () => Promise.all([...service.running.values()].map(entry => entry.promise));
  try {
    dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; await boot(); await openQuickChatSettings();
    expect(modelCalls).toHaveLength(0);
    field('name').value = '速记'; field('name').oninput();
    field('prompt').value = '  整理为笔记\n '; field('prompt').oninput();
    await findByText(dom.node('detail'), '保存 Prompt').onclick();
    const promptId = field('edit_prompt').value;
    expect(promptId).toMatch(/^[a-f0-9-]{36}$/); expect(field('prompt').value).toBe('整理为笔记');
    expect(service.config().revision).toMatch(/^[a-f0-9]{64}$/); expect(modelCalls).toHaveLength(0);

    dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; dom.location.hash = ''; await boot();
    const originalView = ui.view;
    addComposerReference({ version: 1, kind: 'text', target: {}, label: '引用资料', quote: '所见材料\n第二行',
      location: { view: 'docs' }, captured_at: '2026-10-11T00:00:00.000Z' });
    await openComposerChat(); dom.node('composer-chat-prompt').value = promptId; dom.node('composer-chat-prompt').onchange();
    dom.window.open = () => { const tab = { opener: {}, document: { body: {} }, location: { replace(href) { tab.href = href; } } }; tabs.push(tab); return tab; };
    await dom.node('input-form').onsubmit({ preventDefault() {} }); await finish();
    expect(tabs[0].href).toBe('/p/aaaaaaaaaaaaaaaa/#quick-chat-C1'); expect(tabs[0].opener).toBeNull(); expect(ui.view).toBe(originalView);
    const first = service.get(1);
    expect(first).toMatchObject({ number: 'C1', status: 'completed', model: 'original-model',
      prompt: { id: promptId, prompt: '整理为笔记' }, references: [{ project_id: 'aaaaaaaaaaaaaaaa', quote: '所见材料\n第二行' }] });
    expect(modelCalls).toHaveLength(1);

    dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; await openQuickChatConversation(1);
    expect(deepText(dom.node('detail'))).toContain('受控模型回复'); expect(deepText(dom.node('detail'))).toContain('DOM integration source');
    field('reply').value = '补充摘要'; field('reply').oninput();
    await dom.node('detail').querySelectorAll('button').find(node => node.textContent === '发送').onclick(); await finish();
    await findByText(dom.node('detail'), '刷新对话').onclick();
    expect(service.get(1).turns).toHaveLength(2); expect(ui.view.key).toBe('quick-chat-C1'); expect(field('reply').value).toBe('');
    expect(deepText(dom.node('detail'))).toContain('补充摘要'); expect(modelCalls).toHaveLength(2);
    expect(modelCalls[1].messages[0].content).toContain('整理为笔记');
    const deleting = findByText(dom.node('detail'), '删除对话').onclick();
    await dialogButton(dom, '删除').onclick(); await deleting;
    expect(ui.view.id).toBe('quick-chat'); expect(service.list().conversations).toEqual([]);
    expect(projectCalls).toEqual([]);
    expect(requests.some(route => route.includes('/api/host/quick-chat'))).toBe(false);
    expect(requests.filter(route => route.includes('/api/quick-chat/')).every(route => route.startsWith('/p/aaaaaaaaaaaaaaaa/'))).toBe(true);
    expect(fs.existsSync(path.join(settings.config.home, 'quick-chat.sqlite'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'quick-chat.sqlite'))).toBe(true);
    expect(world.state.actions).toEqual([]); expect(deepText(dom.node('detail'))).not.toContain('synthetic-dom-test-key');
  } finally {
    ui.disposeQuickChatPage?.(); dom.restore(); await web.stop(true); fs.rmSync(root, { recursive: true, force: true });
  }
});
