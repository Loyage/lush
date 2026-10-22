import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { createAgentConnections } from '../../src/ui/web/assets/render-agent-connections.js';

const source = id => ({ id, label: `来源 ${id}`, provider: 'deepseek', auth_type: 'api_key', endpoint: 'https://api.deepseek.com',
  enabled: true, models: ['deepseek-chat'], credential: { status: 'configured' },
  observation: { status: 'unknown', source: 'none', resources: [] }, consumers: [] });

test('model source overview opens details and the editor on demand', async () => {
  const requests = [];
  let rejectSave, writes = 0;
  const dom = installDom({ fetch: async (url, options) => {
    requests.push(String(url));
    if (options?.body) { writes++; return new Promise((_, reject) => { rejectSave = reject; }); }
    return Response.json({ version: 1, sampling: { enabled: false, interval_minutes: 5, retention_days: 90 }, connections: [source('a'), source('b')],
      configuration_scope: { selected: 'device', source: 'device', project_override: false } });
  } });
  const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
  try {
    const panel = createAgentConnections({ ownsPage: () => true }); await panel.load();
    const root = panel.node;
    expect(requests).toEqual(['/api/agent/connections']); expect(root.querySelectorAll('.model-source-row')).toHaveLength(2);
    expect(deepText(root.querySelector('[data-source-id="a"]'))).not.toContain('api.deepseek.com');
    expect(panel.selectedConnection()).toBe('a'); expect(root.dataset.sourceView).toBe('list');
    await button(root, '添加连接').onclick(); expect(root.dataset.sourceView).toBe('detail');
    const label = root.querySelector('[data-connection-field="label"]');
    expect(label.parentNode.parentNode.parentNode.parentNode.hidden).toBe(false);
    await button(root, '取消编辑').onclick();
    await button(root, '后台采样设置').onclick();
    expect(root.querySelector('[data-connection-field="sampling-enabled"]').parentNode.parentNode.parentNode.hidden).toBe(false);
    expect(requests).toHaveLength(1);
    await button(root, '添加连接').onclick();
    const editor = root.querySelector('.agent-connection-editor-feedback');
    const save = button(root, '保存连接'); await save.onclick(); expect(editor.textContent).toContain('连接名称');
    const name = root.querySelector('[data-connection-field="label"]'), key = root.querySelector('[data-connection-field="api_key"]');
    name.value = 'retained public draft'; name.oninput(); key.value = 'temporary test secret';
    const saving = save.onclick(); expect(save.textContent).toBe('保存中…'); expect(key.value).toBe('');
    await save.onclick(); expect(writes).toBe(1); rejectSave(Error('controlled connection failure')); await saving;
    expect(editor.textContent).toContain('保存连接失败'); expect(name.value).toBe('retained public draft');
    expect(key.value).toBe(''); expect(save.textContent).toBe('保存连接');
  } finally { dom.restore(); }
});
