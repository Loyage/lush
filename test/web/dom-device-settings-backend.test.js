import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { setup, fetch as httpFetch } from './harness.js';
import { openAgentStatus } from '../../src/ui/web/assets/render-agent-status.js';
import { openQuickExplanationPage } from '../../src/ui/web/assets/render-quick-explanation.js';
import { openModelSources } from '../../src/ui/web/assets/render-model-sources.js';
import { settingsClient } from '../../src/ui/web/assets/settings-api.js';
import { agentPrompt } from '../../src/agent/prompts.js';

// Exercise DOM settings against this worktree's HTTP/RPC/storage implementation, never live roots.
// This validates the fixed parent backend plus repaired frontend; it does not replace final acceptance.
// Unrelated Worker/history/bootstrap projections remain controlled DOM fixtures.
const world = makeWorld(), requests = [];
let f, registeredSource;
const dom = installDom({ fetch: async (url, options = {}) => {
  const raw = String(url);
  // Separate app-wide read-only observers from this configuration transport ledger.
  if (!/^\/api\/host\/(preferences|automation|inbox)(?:[/?]|$)/.test(raw)) requests.push({ url: raw, options });
  if (raw.startsWith(`/p/${registeredSource}/api/`)) return httpFetch(f.url + raw, options);
  if (raw.startsWith('/api/host/') || raw.startsWith('/api/settings/')
    || /^\/api\/agent\/(config|connections|environment|network)(?:[/?]|$)/.test(raw)
    || raw.startsWith('/api/quick-explain/config') || raw === '/api/action') return httpFetch(f.url + raw, options);
  return world.fetchImpl(raw, options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const detail = () => dom.node('detail');
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const input = (node, value) => { node.value = value; node.oninput?.(); for (const listener of node.listeners.input || []) listener(); };
const system = async () => { await dom.node('settings-open').onclick(); await detail().querySelector('button[data-settings-tab="system"]').onclick(); };

beforeEach(async () => {
  f = await setup();
  const host = await (await httpFetch(f.url + '/api/host')).json(); registeredSource = host.projects[0].id;
  dom.location.pathname = '/'; dom.location.hash = ''; await boot(); requests.length = 0;
});
afterEach(async () => { await f.web.stop(true); await f.close(); });

// Legacy migration sources must be written explicitly, never through discontinued project-scope APIs.
function writeLegacy(relative, body) {
  const file = path.join(f.config.home, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, body, { mode: 0o600 });
  return { file, body };
}
function expectLegacyPreserved({ file, body }) {
  expect(fs.readFileSync(file, 'utf8')).toBe(body);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
}
const source = { label: '临时共享来源', provider: 'deepseek', auth_type: 'api_key', enabled: true, models: ['deepseek-chat'] };
async function saveSource() {
  return settingsClient().action('agent.connections.save', { connection: source, credential: { api_key: 'TEMPORARY-TEST-KEY' } });
}

test('真实设备运行设置混合环境默认，无项目编辑层，保存/重置只修改设备文件', async () => {
  const legacy = writeLegacy('settings.json', JSON.stringify({ version: 1, concurrency: 11 }) + '\n');
  const device = settingsClient(); await device.action('system.configure', { settings: { concurrency: 5 } });
  await system(); expect(deepText(detail())).toContain('设备设置与环境 / 内置默认');
  expect(detail().querySelector('select[data-settings-scope=""]')).toBeNull();
  expect(detail().querySelector('[data-runtime-source="concurrency"]').textContent).toBe('设备配置');
  expect(detail().querySelector('input[data-runtime-input="concurrency"]').value).toBe('5');
  input(detail().querySelector('input[data-runtime-input="concurrency"]'), '7');
  await detail().querySelector('button[data-runtime-action="save"]').onclick();
  expect(f.config.runtimeSettings.get('device').concurrency.value).toBe(7);
  expectLegacyPreserved(legacy);
  await detail().querySelector('button[data-runtime-action="reset"]').onclick();
  expect(f.config.runtimeSettings.get('device').concurrency).toMatchObject({ value: f.config.concurrencyDefault, source: 'default', overridden: false });
  expect(detail().querySelector('input[data-runtime-input="concurrency"]').value).toBe(String(f.config.concurrencyDefault));
  expectLegacyPreserved(legacy);
});

test('真实 Host 投影可供无项目来源编辑及快捷解释保存，不将只读字段写回凭证文档', async () => {
  const saved = await saveSource();
  const profile = f.project.agentConfig('device');
  await settingsClient().action('agent.configure', { config: { version: 1, default: { ...profile.default, agent: 'pi', config_mode: 'pi' }, roles: {} } });
  const original = world.fetchImpl;
  world.fetchImpl = async (url, options) => url === '/api/host'
    ? { ok: true, status: 200, json: async () => ({ mode: 'host', projects: [] }) } : original(url, options);
  try {
    await boot(); requests.length = 0;
    await openAgentStatus(); expect(deepText(detail())).not.toContain('后台未确认所选设置作用域');
    await openModelSources();
    const row = detail().querySelector(`[data-source-id="${saved.id}"]`); expect(deepText(row)).toContain('设备共享');
    await button(row, '详情').onclick(); await button(detail().querySelector('.agent-connection-card'), '编辑').onclick();
    input(detail().querySelector('[data-connection-field="label"]'), '更新临时共享来源'); await button(detail(), '保存连接').onclick();
    const document = JSON.parse(fs.readFileSync(path.join(f.config.deviceHome, 'credentials', 'agent-connections.json'), 'utf8'));
    expect(document.connections[0].label).toBe('更新临时共享来源');
    for (const key of ['configuration_scope', 'storage_scope', 'consumers', 'observation']) expect(document.connections[0]).not.toHaveProperty(key);
    await openQuickExplanationPage();
    const connection = detail().querySelector('[data-quick-field="connection_id"]'); connection.value = saved.id; connection.onchange();
    input(detail().querySelector('[data-quick-field="model"]'), 'deepseek-chat');
    input(detail().querySelector('[data-quick-field="prompt"]'), '临时共享解释规则'); await button(detail(), '保存解释设置').onclick();
    expect(f.project.quickExplanationConfig('device')).toMatchObject({ ready: true, prompt: '临时共享解释规则' });
    expect(requests.every(row => row.url.startsWith('/api/host/settings/'))).toBe(true);
    expect(button(detail(), '刷新历史')).toBeUndefined();
  } finally { world.fetchImpl = original; }
});

test('真实环境编辑仅设备公共/角色表，不导入旧项目变量，也不清旧文件', async () => {
  const legacy = writeLegacy(path.join('agent', 'agent.env'), 'PROJECT_VALUE=local\n');
  await settingsClient().action('agent.environment.configure', { target: 'common', values: { SHARED_VALUE: 'shared' } });
  await openAgentStatus(); let env = detail().querySelector('.agent-env-block');
  await (button(env, '读取变量') || button(env, '重新读取')).onclick(); env = detail().querySelector('.agent-env-block');
  expect(env.querySelectorAll('input.agent-env-name').map(node => node.value)).toEqual(['SHARED_VALUE']);
  expect(env.querySelectorAll('button').some(node => Object.hasOwn(node.dataset, 'clearOverride'))).toBe(false);
  expectLegacyPreserved(legacy);
  input(env.querySelector('input.agent-env-value'), 'updated'); await env.querySelector('[data-env-action="save"]').onclick();
  expect(f.project.agentEnvironment('common', 'device').values).toEqual({ SHARED_VALUE: 'updated' });
  expectLegacyPreserved(legacy);
});

test('真实迁移拒绝空预检和变更后的 revision；新预检确认后保留原文私有备份', async () => {
  await system(); const select = detail().querySelector('[data-migration-source=""]'); select.value = registeredSource; select.onchange(); await button(detail(), '预检迁移范围').onclick();
  expect(button(detail(), '确认迁移到设备设置').disabled).toBe(true);
  expect(deepText(detail())).toContain('所选项目没有可迁移的设置；未修改任何配置。');
  const conventions = ['AGENTS.md', path.join('.lush-agent', 'common.md'), path.join('.lush-agent', 'agent.md')].map(relative => {
    const file = path.join(f.root, relative), body = `# Keep fixture project conventions: ${relative}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, body, { mode: 0o600 });
    return { file, body };
  });
  const legacy = writeLegacy('settings.json', JSON.stringify({ version: 1, concurrency: 6 }) + '\n');
  const legacyEnv = writeLegacy(path.join('agent', 'agent.env'), 'MIGRATED_VALUE=legacy\n');
  expect(f.project.agentEnvironment('common', 'device').values).toEqual({});
  await button(detail(), '预检迁移范围').onclick();
  expect(button(detail(), '确认迁移到设备设置').disabled).toBe(false);
  expect(deepText(detail())).toContain(path.join(f.config.deviceHome, 'settings.json'));
  const itemsText = detail().querySelectorAll('.settings-migration-item').map(node => deepText(node)).join('\n');
  for (const convention of conventions) { expect(itemsText).not.toContain(convention.file); expect(deepText(detail())).not.toContain(convention.body); expectLegacyPreserved(convention); }
  const changed = writeLegacy('settings.json', JSON.stringify({ version: 1, concurrency: 7 }) + '\n');
  const stale = button(detail(), '确认迁移到设备设置').onclick(); await dialogButton(dom, '备份并迁移').onclick(); await stale;
  expect(deepText(detail())).toContain('迁移未确认完成');
  expect(button(detail(), '确认迁移到设备设置').disabled).toBe(true);
  expectLegacyPreserved(changed); expectLegacyPreserved(legacyEnv);
  expect(f.project.agentEnvironment('common', 'device').values).toEqual({});
  expect(fs.existsSync(path.join(f.config.deviceHome, 'settings.json'))).toBe(false);
  expect(fs.existsSync(path.join(f.config.home, 'device-migration', 'current.json'))).toBe(false);
  await button(detail(), '预检迁移范围').onclick();
  expect(button(detail(), '确认迁移到设备设置').disabled).toBe(false);
  const applying = button(detail(), '确认迁移到设备设置').onclick(); await dialogButton(dom, '备份并迁移').onclick(); await applying;
  const attempts = requests.filter(row => row.url === `/p/${registeredSource}/api/action`).map(row => JSON.parse(row.options.body));
  expect(attempts).toHaveLength(2);
  expect(attempts.every(row => row.method === 'settings.migration.apply' && row.params.confirm === true)).toBe(true);
  expect(typeof attempts[0].params.revision).toBe('string'); expect(typeof attempts[1].params.revision).toBe('string');
  expect(attempts[1].params.revision).not.toBe(attempts[0].params.revision);
  expect(deepText(detail())).toContain('迁移完成，所有项目使用设备设置');
  expect(deepText(detail())).toContain(path.join(f.config.home, 'device-migration'));
  expect(fs.existsSync(path.join(f.config.home, 'settings.json'))).toBe(false);
  // The device setting is explicitly stored, not an inherited project override.
  const model = f.config.runtimeSettings.get('device');
  expect(model.concurrency).toMatchObject({ value: 7, source: 'device', overridden: true });
  expect(model.configuration_scope).toMatchObject({ selected: 'device', project_override: false });
  const pointer = JSON.parse(fs.readFileSync(path.join(f.config.home, 'device-migration', 'current.json'), 'utf8'));
  const journalHome = path.join(f.config.home, 'device-migration', pointer.id), backup = path.join(journalHome, 'files');
  expectLegacyPreserved({ file: path.join(backup, 'settings.json'), body: changed.body });
  expectLegacyPreserved({ file: path.join(backup, 'agent', 'agent.env'), body: legacyEnv.body });
  expect(f.project.agentEnvironment('common', 'device').values).toEqual({ MIGRATED_VALUE: 'legacy' });
  expect(fs.existsSync(legacyEnv.file)).toBe(false);
  expect(fs.statSync(backup).mode & 0o777).toBe(0o700);
  expect(JSON.parse(fs.readFileSync(path.join(journalHome, 'journal.json'), 'utf8')).status).toBe('complete');
  expect(fs.existsSync(legacy.file)).toBe(false);
  for (const convention of conventions) expectLegacyPreserved(convention);
  expect(fs.existsSync(path.join(f.config.deviceHome, 'AGENTS.md'))).toBe(false);
  expect(fs.existsSync(path.join(f.config.deviceHome, '.lush-agent'))).toBe(false);
});

for (const mode of ['import', 'reuse', 'conflict']) test(`真实 Markdown 迁移 ${mode}：固定来源确认、原件保留及设备运行消费`, async () => {
  const privateBody = '\ufeffTEMPORARY-PRIVATE-MARKDOWN common\n  exact whitespace  \n';
  const roleBody = 'TEMPORARY-PRIVATE-MARKDOWN agent\n';
  const originals = [writeLegacy('agent/common.md', privateBody), writeLegacy('agent/agent.md', roleBody)];
  const originalStats = originals.map(({ file }) => fs.statSync(file));
  const conventionFile = path.join(f.root, '.lush-agent', 'common.md'), conventionBody = 'REPOSITORY-ONLY-CONVENTION';
  fs.mkdirSync(path.dirname(conventionFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(conventionFile, conventionBody, { mode: 0o600 });
  const agentsFile = path.join(f.root, 'AGENTS.md'); fs.writeFileSync(agentsFile, '# Repository contract\n', { mode: 0o600 });
  const deviceFiles = originals.map(({ file }) => path.join(f.config.deviceHome, 'agent', path.basename(file)));
  let reusedStat;
  if (mode !== 'import') {
    fs.mkdirSync(path.dirname(deviceFiles[0]), { recursive: true, mode: 0o700 });
    fs.writeFileSync(deviceFiles[0], mode === 'reuse' ? privateBody : 'DEVICE-EXISTING-DIFFERENT', { mode: 0o600 });
    reusedStat = fs.statSync(deviceFiles[0]);
  }
  const before = agentPrompt(f.config, 'agent').text;
  expect(before).toContain(conventionBody);
  expect(before).not.toContain('TEMPORARY-PRIVATE-MARKDOWN agent');
  if (mode !== 'reuse') expect(before).not.toContain('TEMPORARY-PRIVATE-MARKDOWN common');
  await system(); const select = detail().querySelector('[data-migration-source=""]');
  select.value = registeredSource; select.onchange(); await button(detail(), '预检迁移范围').onclick();
  const preview = await f.project.settingsMigrationPreview(), text = deepText(detail());
  expect(JSON.stringify(preview)).not.toContain('TEMPORARY-PRIVATE-MARKDOWN');
  expect(text).not.toContain('TEMPORARY-PRIVATE-MARKDOWN');
  expect(text).toContain('所有项目后续调用'); expect(text).toContain('原件保留');
  const itemText = detail().querySelectorAll('.settings-migration-item').map(node => node.textContent + deepText(node)).join('\n');
  for (const { file } of mode === 'conflict' ? originals.slice(1) : originals) expect(itemText).toContain(file);
  for (const file of [conventionFile, agentsFile]) expect(itemText).not.toContain(file);
  if (mode === 'conflict') {
    expect(button(detail(), '确认迁移到设备设置').disabled).toBe(true);
    expect(preview.can_migrate).toBe(false); expect(text).toContain('阻挡：');
    expect(fs.readFileSync(deviceFiles[0], 'utf8')).toBe('DEVICE-EXISTING-DIFFERENT');
    expect(fs.existsSync(deviceFiles[1])).toBe(false);
    expect(fs.existsSync(path.join(f.config.home, 'device-migration'))).toBe(false);
    expect(requests.some(row => row.options.method === 'POST')).toBe(false);
  } else {
    expect(button(detail(), '确认迁移到设备设置').disabled).toBe(false);
    if (mode === 'reuse') expect(itemText).toContain('复用');
    const applying = button(detail(), '确认迁移到设备设置').onclick();
    const modalText = deepText(dom.node('modal'));
    expect(modalText).toContain('所有项目后续调用'); expect(modalText).toContain('保留不活跃的项目原件');
    expect(modalText).not.toContain('TEMPORARY-PRIVATE-MARKDOWN');
    expect(fs.existsSync(deviceFiles[1])).toBe(false);
    await dialogButton(dom, '备份并迁移').onclick(); await applying;
    expect(deepText(detail())).toContain('迁移完成，所有项目使用设备设置');
    const writes = requests.filter(row => row.url === `/p/${registeredSource}/api/action`).map(row => JSON.parse(row.options.body));
    expect(writes).toEqual([{ method: 'settings.migration.apply', params: { revision: preview.revision, confirm: true } }]);
    const pointer = JSON.parse(fs.readFileSync(path.join(f.config.home, 'device-migration/current.json'), 'utf8'));
    const journalHome = path.join(f.config.home, 'device-migration', pointer.id);
    const journal = JSON.parse(fs.readFileSync(path.join(journalHome, 'journal.json'), 'utf8'));
    expect(journal.status).toBe('complete'); expect(journal.entries.every(row => row.phase === 'retained')).toBe(true);
    expect(JSON.stringify(journal)).not.toContain('TEMPORARY-PRIVATE-MARKDOWN');
    expect(fs.statSync(path.join(journalHome, 'files')).mode & 0o777).toBe(0o700);
    for (const { file, body } of originals) {
      expectLegacyPreserved({ file: path.join(journalHome, 'files', 'agent', path.basename(file)), body });
      expectLegacyPreserved({ file: path.join(f.config.deviceHome, 'agent', path.basename(file)), body });
    }
    if (mode === 'reuse') expect(fs.statSync(deviceFiles[0]).ino).toBe(reusedStat.ino);
    const prompt = agentPrompt(f.config, 'agent').text;
    expect(prompt).toContain('TEMPORARY-PRIVATE-MARKDOWN common'); expect(prompt).toContain('TEMPORARY-PRIVATE-MARKDOWN agent');
    expect(prompt).toContain(conventionBody);
    // Another project reads the same device supplements, without inheriting the source repository convention.
    const otherProject = path.join(f.root, 'other-repository'); fs.mkdirSync(otherProject, { mode: 0o700 });
    const otherPrompt = agentPrompt({ ...f.config, project: otherProject, home: path.join(otherProject, '.lush') }, 'agent').text;
    expect(otherPrompt).toContain('TEMPORARY-PRIVATE-MARKDOWN common'); expect(otherPrompt).toContain('TEMPORARY-PRIVATE-MARKDOWN agent');
    expect(otherPrompt).not.toContain(conventionBody);
    // Retained source files remain inactive: deleting the device copy must not revive them.
    fs.unlinkSync(deviceFiles[0]); expect(agentPrompt(f.config, 'agent').text).not.toContain('TEMPORARY-PRIVATE-MARKDOWN common');
    expect(await f.project.settingsMigrationPreview()).toMatchObject({ already_migrated: true, items: [] });
  }
  originals.forEach((original, index) => {
    expectLegacyPreserved(original); const stat = fs.statSync(original.file);
    expect(stat.ino).toBe(originalStats[index].ino); expect(stat.mtimeMs).toBe(originalStats[index].mtimeMs);
  });
  expectLegacyPreserved({ file: conventionFile, body: conventionBody });
  expectLegacyPreserved({ file: agentsFile, body: '# Repository contract\n' });
  expect(fs.existsSync(path.join(f.config.deviceHome, 'AGENTS.md'))).toBe(false);
  expect(fs.existsSync(path.join(f.config.deviceHome, '.lush-agent'))).toBe(false);
});

// Each suite runs in its own DOM process; release the installed globals once all cases finish.
afterAll(() => dom.restore());
