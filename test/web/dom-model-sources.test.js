import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { createAgentConnections } from '../../src/ui/web/assets/render-agent-connections.js';
import { createDiagnosticsPage } from '../../src/ui/web/assets/diagnostics-page.js';
import { amount } from '../../src/ui/web/assets/diagnostics-render.js';
import { diagnosticsQuery, emptyDiagnosticQuery, finishDiagnosticQuery } from '../../src/core/diagnostics-query.js';

const source = id => ({ id, label: `来源 ${id}`, provider: 'deepseek', auth_type: 'api_key', endpoint: 'https://api.deepseek.com',
  enabled: true, models: ['deepseek-chat'], credential: { status: 'configured' },
  observation: { status: 'unknown', source: 'none', resources: [] }, consumers: [] });

test('model source overview opens details and the editor on demand', async () => {
  const requests = [];
  let rejectSave, writes = 0, failSave = true;
  const connections = [source('a'), source('b')];
  const dom = installDom({ fetch: async (url, options) => {
    requests.push(String(url));
    if (options?.body) {
      writes++; if (failSave) return new Promise((_, reject) => { rejectSave = reject; });
      const action = JSON.parse(options.body); expect(action.method).toBe('agent.connections.save');
      connections.push({ ...source('c'), ...action.params.connection, id: 'c', credential: { status: 'unconfigured' } });
      return Response.json(connections.at(-1));
    }
    return Response.json({ version: 1, sampling: { enabled: false, interval_minutes: 5, retention_days: 90 }, connections,
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
    await button(root, '返回来源列表').onclick(); await button(root, '添加连接').onclick();
    expect(root.querySelector('[data-connection-field="label"]').value).toBe('retained public draft');
    expect(root.querySelector('[data-connection-field="api_key"]').value).toBe('');
    expect(root.querySelector('.model-source-editor-advanced').open).toBe(true);
    failSave = false; await button(root, '保存连接').onclick();
    expect(writes).toBe(2); expect(root.querySelectorAll('.model-source-row')).toHaveLength(3);
    expect(root.querySelector('.agent-connections-feedback').textContent).toContain('连接已保存');
    expect(root.children[0].classList.contains('agent-connections-feedback')).toBe(true);
    panel.dispose();
    const reads = []; let held, fail = false;
    const diagnostic = createDiagnosticsPage({ ownsPage: () => true, client: { read: async () => ({ connections: [], models: [] }) },
      request: async (url, options) => {
        if (url === '/api/host/projects') return { projects: [{ id: 'aaaaaaaaaaaaaaaa', name: 'Fixture' }] };
        reads.push({ url, signal: options.signal });
        if (fail) throw Error('controlled read failure');
        if (held) return new Promise(resolve => { held = resolve; });
        const range = diagnosticsQuery(Object.fromEntries(new URL(url, 'http://fixture').searchParams), Date.now(), true);
        const value = finishDiagnosticQuery(emptyDiagnosticQuery(range));
        Object.assign(value.coverage, { unknown_runs: 2, projects_total: 0, projects_reporting: 0 });
        return value;
      } });
    dom.node('detail').append(diagnostic.node); diagnostic.resume();
    diagnostic.setFilters({ connection_id: 'deleted-source', model: 'old/model' }); await diagnostic.load();
    expect(deepText(diagnostic.node)).toContain('已知用量／估价小计是下界');
    expect(deepText(diagnostic.node)).toContain('未知调用 2');
    expect(deepText(diagnostic.node)).toContain('legacy_backfill:false');
    expect(deepText(diagnostic.node)).toContain('无已登记项目');
    expect(deepText(diagnostic.node.querySelector('.diagnostic-metrics'))).toContain('未知');
    expect(diagnostic.node.querySelectorAll('.diagnostic-chart svg')).toHaveLength(0); // Unknown zero subtotals are not zero-flow lines.
    expect(amount(0.000012)).not.toBe('0'); expect(amount(null)).toBe('未知');
    const input = key => diagnostic.node.querySelector(`[data-diagnostic-filter="${key}"]`);
    expect(input('model').value).toBe('old/model'); expect(reads.at(-1).url).toContain('connection_id=deleted-source');
    input('period').value = '7d'; input('period').onchange();
    input('project_id').value = 'aaaaaaaaaaaaaaaa'; await diagnostic.load();
    const query = new URL(reads.at(-1).url, 'http://fixture').searchParams;
    expect(Date.parse(query.get('to')) - Date.parse(query.get('from'))).toBe(7 * 86400000);
    expect(query.get('model')).toBe('old/model'); expect(query.get('project_id')).toBe('aaaaaaaaaaaaaaaa');
    fail = true; await diagnostic.load(); expect(deepText(diagnostic.node)).toContain('保留上次旧结果'); fail = false;
    held = true; const pending = diagnostic.load(), oldSignal = reads.at(-1).signal;
    const release = held; held = null;
    input('model').value = '@unknown'; input('model').onchange(); await diagnostic.load();
    expect(oldSignal.aborted).toBe(true); expect(reads.at(-1).url).toContain('model=%40unknown');
    release({ invalid: true }); await pending;
    expect(deepText(diagnostic.node)).not.toContain('后台诊断协议不可用');
    held = true; const leaving = diagnostic.load(); diagnostic.dispose();
    expect(reads.at(-1).signal.aborted).toBe(true); held({ invalid: true }); await leaving;
  } finally { dom.restore(); }
});
