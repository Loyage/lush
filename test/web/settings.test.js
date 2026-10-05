import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

// 设置页：入口 / #settings 路由 / 轮询不覆盖、偏好默认值与老键回落、每项即时生效并持久化、恢复默认。
// 每个 DOM 测试文件自给自足：自己建 world、装 stub，再显式装配一次当前 DOM。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { boot } = await import('../../src/ui/web/assets/app.js');
const prefs = await import('../../src/ui/web/assets/prefs.js');
const state = await import('../../src/ui/web/assets/state.js');
const { renderSettings, renderAgentSettings } = await import('../../src/ui/web/assets/render-settings.js');
dom.node('side-nav').replaceChildren();
await boot();

afterAll(() => {
  // 系统设置页签是模块级的：离开前切回界面，避免跨测试污染。
  const tab = panel().querySelector('button.settings-tab[data-settings-tab="interface"]');
  if (tab) tab.onclick();
  dom.restore();
});

const panel = () => dom.node('detail');
const openSettings = () => dom.node('settings-open').onclick();
const openTab = id => panel().querySelector(`button.settings-tab[data-settings-tab="${id}"]`).onclick();
const openInterface = () => { openSettings(); openTab('interface'); };
const openSystem = () => { openSettings(); openTab('system'); };
const openAgent = () => {
  dom.node('agent-status-open').onclick();
  return panel().querySelector('button[data-agent-tab="settings"]').onclick();
};
const systemBlock = () => [...panel().querySelectorAll('.block')]
  .find(node => node.querySelector('h2')?.textContent === '运行状态') || null;
const runtimeBlock = () => [...panel().querySelectorAll('.block')]
  .find(node => node.querySelector('h2')?.textContent === '并发额度') || null;
const limitsBlock = () => [...panel().querySelectorAll('.block')]
  .find(node => node.querySelector('h2')?.textContent === '调用与拆解限额') || null;
const environmentBlock = () => [...panel().querySelectorAll('.block')]
  .find(node => node.querySelector('h2')?.textContent === '环境变量') || null;

test('设置入口：侧栏工作区导航进入 #settings，后退回概览，1.5s 轮询不覆盖该视图', async () => {
  await dom.intervalFor(1500)();
  expect(panel().dataset.view).toBe('overview');

  openInterface();
  expect(dom.location.hash).toBe('#settings');
  expect(panel().dataset.view).toBe('settings');
  expect(dom.node('view-title').textContent).toBe('系统设置');
  expect(panel().querySelector('h1').textContent).toBe('系统设置');
  expect(panel().querySelectorAll('button.settings-tab').map(node => node.dataset.settingsTab)).toEqual(['interface', 'system']);
  expect(panel().querySelector('.agent-settings')).toBeNull();
  expect(deepText(panel())).toContain('Markdown 渲染');
  expect(deepText(panel())).toContain('执行过程排序');
  expect(deepText(panel())).toContain('跟随系统');

  // 轮询照旧更新左栏与连接状态，但不把设置页换成概览。
  await dom.intervalFor(1500)();
  expect(panel().dataset.view).toBe('settings');
  expect(deepText(panel())).not.toContain('项目概览');

  // 后退到无 hash：回概览。
  dom.location.hash = '';
  await dom.fire('hashchange');
  expect(panel().dataset.view).toBe('overview');
});

test('告知设置提供三类两渠道独立复选项，默认全选，不改系统通知总开关或项目数据', async () => {
  prefs.resetPrefs(); openInterface();
  const controls = () => panel().querySelectorAll('input').filter(node => node.dataset.pref === 'noticeChannels');
  expect(controls()).toHaveLength(6); expect(controls().every(node => node.checked)).toBe(true);
  expect(controls().every(node => node.getAttribute('aria-label'))).toBe(true);
  expect(deepText(panel())).toContain('待决事项始终独立显示');
  expect(deepText(panel())).toContain('不改变历史或未读列表计数');
  const before = world.state.actions.length;
  const checkbox = controls().find(node => node.dataset.noticeType === 'analysis' && node.dataset.channel === 'banner');
  checkbox.checked = false;
  for (const handler of checkbox.listeners.change) handler();
  expect(prefs.readPref('noticeChannels').analysis).toEqual({ banner: false, system: true });
  expect(controls().find(node => node.dataset.noticeType === 'analysis' && node.dataset.channel === 'banner').checked).toBe(false);
  expect(prefs.readPref('noticeNotifications')).toBe(false);
  expect(world.state.actions).toHaveLength(before);
  await dom.intervalFor(1500)(); expect(controls()).toHaveLength(6);
  prefs.resetPrefs(); expect(controls().every(node => node.checked)).toBe(true);
});

test('偏好默认值与老键值：全部走默认，旧键继续生效，坏值回落', () => {
  for (const name of prefs.PREF_NAMES) globalThis.localStorage.removeItem(prefs.PREF_DEFS[name].key);
  expect(prefs.readPref('markdown')).toBe(true);
  expect(prefs.readPref('theme')).toBe('system');
  expect(prefs.readPref('sidebarSort')).toBe('smart');
  expect(prefs.readPref('reduceMotion')).toBe(false);
  expect(prefs.readPref('polling')).toBe('standard');
  expect(prefs.readPref('toastDuration')).toBe('standard');
  // 执行过程排序默认倒序（最新在前）；坏值回落 desc，显式值被认出。
  expect(prefs.readPref('transcriptOrder')).toBe('desc');
  globalThis.localStorage.setItem(prefs.TRANSCRIPT_ORDER_KEY, 'sideways');
  expect(prefs.readPref('transcriptOrder')).toBe('desc');
  globalThis.localStorage.setItem(prefs.TRANSCRIPT_ORDER_KEY, 'asc');
  expect(prefs.readPref('transcriptOrder')).toBe('asc');
  globalThis.localStorage.removeItem(prefs.TRANSCRIPT_ORDER_KEY);
  // 标准档严格等于改造前写死的间隔
  expect(prefs.pollingIntervals('standard')).toMatchObject({ snapshot: 1500, live: 3000 });
  expect(prefs.toastDurations('standard')).toMatchObject({ info: 4000, error: 8000 });
  // 左栏排序从 lush.treeSort 迁到 lush.sidebarSort：旧键仍被识别，坏值回落 smart。
  globalThis.localStorage.setItem(prefs.LEGACY_TREE_SORT_KEY, 'updated');
  expect(prefs.readPref('sidebarSort')).toBe('updated');
  globalThis.localStorage.setItem(prefs.SIDEBAR_SORT_KEY, 'nonsense');
  expect(prefs.readPref('sidebarSort')).toBe('smart');
  globalThis.localStorage.removeItem(prefs.SIDEBAR_SORT_KEY);
  globalThis.localStorage.removeItem(prefs.LEGACY_TREE_SORT_KEY);
  // 主题老键（light / dark）继续生效；坏值回落跟随系统。
  globalThis.localStorage.setItem(prefs.THEME_KEY, 'dark');
  expect(prefs.readPref('theme')).toBe('dark');
  globalThis.localStorage.setItem(prefs.THEME_KEY, 'sepia');
  expect(prefs.readPref('theme')).toBe('system');
  globalThis.localStorage.removeItem(prefs.THEME_KEY);
});

test('偏好快照与变更通知：setPref 只通知对应偏好', () => {
  let seen = null;
  const off = prefs.onPrefChange('polling', value => { seen = value; });
  prefs.setPref('polling', 'fast');
  expect(seen).toBe('fast');
  off();
  prefs.setPref('polling', 'standard');
  expect(seen).toBe('fast');   // 取消注册后不再收到
  const snapshot = prefs.prefsSnapshot();
  for (const name of prefs.PREF_NAMES) expect(snapshot).toHaveProperty(name);
  expect(prefs.prefsSnapshot().polling).toBe('standard');
});

test('Markdown 偏好只在设置页管理，并立即影响 Agent 输出', async () => {
  const { agentText, markdownEnabled } = await import('../../src/ui/web/assets/text.js');
  openInterface();
  let toggle = panel().querySelector('input.pref-toggle[data-pref="markdown"]');
  expect(toggle.checked).toBe(true);

  toggle.checked = false;
  await toggle.listeners.change[0]();
  expect(globalThis.localStorage.getItem(prefs.MARKDOWN_KEY)).toBe('0');
  expect(markdownEnabled()).toBe(false);
  const plain = agentText('**粗** 和 *斜*');
  expect(plain.tagName).toBe('DIV');
  expect(plain.className).toBe('');
  expect(plain.textContent).toBe('**粗** 和 *斜*');

  openInterface();
  toggle = panel().querySelector('input.pref-toggle[data-pref="markdown"]');
  toggle.checked = true;
  await toggle.listeners.change[0]();
  expect(markdownEnabled()).toBe(true);
});

test('执行过程排序：默认最新在前，设置行切正序并持久化', async () => {
  openInterface();
  let select = panel().querySelector('select.pref-select[data-pref="transcriptOrder"]');
  expect(select.value).toBe('desc');
  const labels = [...select.children].map(option => option.textContent);
  expect(labels).toContain('最新在前（倒序）');
  expect(labels).toContain('最早在前（正序）');
  const row = [...panel().querySelectorAll('.settings-row')].find(node => deepText(node).includes('执行过程排序'));
  expect(row).toBeTruthy();
  expect(deepText(row)).toContain('全屏执行详情');

  select.value = 'asc';
  await select.listeners.change[0]();
  expect(globalThis.localStorage.getItem(prefs.TRANSCRIPT_ORDER_KEY)).toBe('asc');
  expect(prefs.readPref('transcriptOrder')).toBe('asc');
  openInterface();
  expect(panel().querySelector('select.pref-select[data-pref="transcriptOrder"]').value).toBe('asc');
  prefs.setPref('transcriptOrder', 'desc');
});

test('设置项即时生效并持久化：左栏排序、主题、动效、轮询频率', async () => {
  openInterface();
  // 左栏默认排序 = 左栏顶部下拉的同一个偏好。
  const sort = panel().querySelector('select.pref-select[data-pref="sidebarSort"]');
  expect(sort.value).toBe('smart');
  sort.value = 'updated';
  await sort.listeners.change[0]();
  expect(globalThis.localStorage.getItem(prefs.SIDEBAR_SORT_KEY)).toBe('updated');
  expect(dom.node('sidebar-sort').value).toBe('updated');

  // 外观：选中深色立刻改 <html data-theme> 并落盘。
  openInterface();
  const dark = panel().querySelector('input.pref-radio[data-value="dark"]');
  expect(dark.checked).toBe(false);
  dark.checked = true;
  await dark.listeners.change[0]();
  expect(globalThis.localStorage.getItem(prefs.THEME_KEY)).toBe('dark');
  expect(dom.document.documentElement.dataset.theme).toBe('dark');
  // 头部主题按钮写回偏好，设置页 radio 跟着走（下一次打开状态一致）。
  dom.node('theme-toggle').onclick();
  expect(globalThis.localStorage.getItem(prefs.THEME_KEY)).toBe('light');

  // 动效：覆盖系统偏好，写到 <html> 上让 CSS 生效。
  openInterface();
  const motion = panel().querySelector('input.pref-toggle[data-pref="reduceMotion"]');
  motion.checked = true;
  await motion.listeners.change[0]();
  expect(globalThis.localStorage.getItem(prefs.REDUCED_MOTION_KEY)).toBe('1');
  expect(dom.document.documentElement.dataset.reducedMotion).toBe('true');

  // 轮询频率：改动后立即按新间隔重建定时器（标准 1500/3000 → 快速 800/1600）。
  openInterface();
  const polling = panel().querySelector('select.pref-select[data-pref="polling"]');
  expect(polling.value).toBe('standard');
  polling.value = 'fast';
  await polling.listeners.change[0]();
  expect(globalThis.localStorage.getItem(prefs.POLLING_KEY)).toBe('fast');
  expect(dom.intervals.some(entry => entry.ms === 800)).toBe(true);
  expect(dom.intervals.some(entry => entry.ms === 1600)).toBe(true);
});

test('消息提示停留时长偏好对之后出现的提示生效', async () => {
  const { show, clear, setTimers } = await import('../../src/ui/web/assets/messages.js');
  let clock = 0, nextId = 1;
  const pending = new Map();
  setTimers({
    setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: id => pending.delete(id),
    now: () => clock,
  });
  const advance = ms => { clock += ms; for (const [id, entry] of [...pending]) if (entry.at <= clock) { pending.delete(id); entry.fn(); } };
  try {
    openInterface();
    const toast = panel().querySelector('select.pref-select[data-pref="toastDuration"]');
    toast.value = 'short';
    await toast.listeners.change[0]();
    expect(globalThis.localStorage.getItem(prefs.TOAST_DURATION_KEY)).toBe('short');

    clear();
    show('短提示');
    advance(1999); expect(dom.node('toast').hidden).toBe(false);
    advance(1); expect(dom.node('toast').hidden).toBe(true);

    // 错误类走错误档（短＝4s），并且对之后出现的提示生效。
    show('短错误', 'error');
    advance(3999); expect(dom.node('toast').hidden).toBe(false);
    advance(1); expect(dom.node('toast').hidden).toBe(true);
  } finally {
    setTimers(null);
    clear();
    prefs.setPref('toastDuration', 'standard');
  }
});

test('恢复默认设置：删掉所有偏好键（含历史键）并就地重画', async () => {
  for (const name of prefs.PREF_NAMES) globalThis.localStorage.setItem(prefs.PREF_DEFS[name].key, 'x');
  globalThis.localStorage.setItem(prefs.MARKDOWN_KEY, '0');
  globalThis.localStorage.setItem(prefs.THEME_KEY, 'dark');
  globalThis.localStorage.setItem(prefs.SIDEBAR_SORT_KEY, 'id');
  globalThis.localStorage.setItem(prefs.REDUCED_MOTION_KEY, '1');
  globalThis.localStorage.setItem(prefs.POLLING_KEY, 'fast');
  globalThis.localStorage.setItem(prefs.TOAST_DURATION_KEY, 'long');
  globalThis.localStorage.setItem(prefs.LEGACY_TREE_SORT_KEY, 'updated');

  openInterface();
  await panel().querySelector('button.pref-reset').onclick();

  for (const name of prefs.PREF_NAMES) expect(globalThis.localStorage.getItem(prefs.PREF_DEFS[name].key)).toBeNull();
  expect(globalThis.localStorage.getItem(prefs.LEGACY_TREE_SORT_KEY)).toBeNull();
  expect(prefs.readPref('markdown')).toBe(true);
  expect(prefs.readPref('theme')).toBe('system');
  expect(prefs.readPref('sidebarSort')).toBe('smart');
  expect(prefs.readPref('reduceMotion')).toBe(false);
  expect(prefs.readPref('polling')).toBe('standard');
  expect(prefs.readPref('toastDuration')).toBe('standard');
  expect(prefs.readPref('transcriptOrder')).toBe('desc');
  // 重画把控件与页面同步回默认值。
  expect(dom.node('sidebar-sort').value).toBe('smart');
  expect(dom.document.documentElement.dataset.reducedMotion).toBeUndefined();
  expect(panel().querySelector('input.pref-toggle[data-pref="markdown"]').checked).toBe(true);
});

test('Agent 页：模型目录、双 Prompt、角色覆盖与替换警告都可用', async () => {
  await dom.intervalFor(1500)();
  await openAgent();
  expect(dom.location.hash).toBe('#agent-status');
  expect(dom.node('view-title').textContent).toBe('Agent 配置');
  expect(state.ui.settingsOpen).toBe(false);
  let card = panel().querySelector('[data-agent-target="default"]');
  expect(deepText(card)).toContain('修改会替换内置 Prompt');
  const defaultPrompt = card.querySelector('textarea[data-agent-field="default_prompt"]');
  expect(defaultPrompt.value).toBe('');
  expect(defaultPrompt.placeholder).toContain('每个角色');
  expect(findByText(card, '恢复默认 Prompt')).toBeTruthy();
  await findByText(card, '读取已安装项').onclick();
  const extension = card.querySelector('input[data-resource-kind="extensions"]');
  const skill = card.querySelector('input[data-resource-kind="skills"]');
  extension.checked = true; await extension.listeners.change[0]();
  skill.checked = true; await skill.listeners.change[0]();
  const backend = card.querySelector('select[data-agent-field="agent"]');
  const model = card.querySelector('input[data-agent-field="model"]');
  const thinking = card.querySelector('select[data-agent-field="thinking"]');
  backend.value = 'codex';
  await backend.listeners.change[0]();
  await findByText(card, '读取 CLI 模型').onclick();
  const catalog = card.querySelector('.model-choices').querySelector('select.model-catalog');
  expect(catalog.children).toHaveLength(3);
  catalog.value = 'gpt-5.4-mini'; await catalog.listeners.change[0]();
  expect(model.value).toBe('gpt-5.4-mini');
  thinking.value = 'high';
  card.querySelector('textarea[data-agent-field="append_prompt"]').value = '保持改动可审阅。';
  await findByText(card, '保存配置').onclick();
  expect(world.state.actions.at(-1).method).toBe('agent.configure');
  expect(world.state.agentConfig.default).toMatchObject({ agent: 'codex', model: 'gpt-5.4-mini', thinking: 'high', append_prompt: '保持改动可审阅。',
    extensions: ['/tmp/demo/.lush/pi/extensions/review.ts'], skills: ['/tmp/demo/.lush/pi/skills/browser/SKILL.md'] });

  openAgent();
  card = panel().querySelector('[data-agent-target="default"]');
  card.querySelector('textarea[data-agent-field="default_prompt"]').value = '完整替代规则。';
  const saving = findByText(card, '保存配置').onclick();
  expect(dom.node('modal').hidden).toBe(false);
  await findByText(dom.node('modal'), '仍然替换并保存').onclick();
  await saving;
  expect(world.state.agentConfig.default.default_prompt).toBe('完整替代规则。');

  openAgent();
  card = panel().querySelector('[data-agent-target="default"]');
  await findByText(card, '恢复默认 Prompt').onclick();
  expect(card.querySelector('textarea[data-agent-field="default_prompt"]').value).toBe('');
  await findByText(card, '保存配置').onclick();
  expect(world.state.agentConfig.default.default_prompt).toBe('');

  openAgent();
  const agentRole = panel().querySelector('[data-agent-target="agent"]');
  await findByText(agentRole, '单独配置').onclick();
  expect(world.state.agentConfig.roles.agent).toMatchObject({ agent: 'codex', model: 'gpt-5.4-mini', thinking: 'high' });
  card = panel().querySelector('[data-agent-target="agent"]');
  const prompt = card.querySelector('textarea[data-agent-field="append_prompt"]'); prompt.value = '先列风险。';
  await findByText(card, '保存配置').onclick();
  expect(world.state.agentConfig.roles.agent.append_prompt).toBe('先列风险。');
});

test('Pi配置缺来源/模型或凭证时不保存，不显示CLI默认目录且保留草稿', async () => {
  const settings = structuredClone(world.state.agentConfig); settings.roles = {};
  settings.default = { ...settings.default, agent: 'pi', connection_id: '', model: '', default_prompt: '' };
  const root = renderAgentSettings(settings, () => {}), card = root.querySelector('[data-agent-target="default"]');
  const choice = card.querySelector('[data-agent-field="connection_id"]'), model = card.querySelector('[data-agent-field="model"]');
  const prompt = card.querySelector('[data-agent-field="append_prompt"]'); prompt.value = '未保存工作方式';
  const before = world.state.actions.length;
  const cli = findByText(card, '读取 CLI 模型'); expect(cli.hidden).toBe(true); expect(cli.disabled).toBe(true);
  expect(card.querySelectorAll('.model-preset')).toHaveLength(0); expect(model.placeholder).toContain('请选择来源内模型');
  await cli.onclick(); expect(card.querySelector('.model-choices').querySelector('.model-catalog')).toBeNull();
  await findByText(card, '保存配置').onclick(); expect(world.state.actions).toHaveLength(before);
  expect(dom.node('error').textContent).toContain('请选择 Lush 模型来源');
  await findByText(card, '读取项目连接').onclick(); choice.value = world.state.agentConnections.connections[0].id; choice.onchange();
  await findByText(card, '保存配置').onclick(); expect(world.state.actions).toHaveLength(before);
  expect(dom.node('error').textContent).toContain('请选择来源内模型');
  model.value = 'wrong/model'; await findByText(card, '保存配置').onclick(); expect(world.state.actions).toHaveLength(before);
  model.value = 'openai-compatible/fixture-model';
  const source = world.state.agentConnections.connections[0], credential = source.credential;
  try {
    source.credential = { status: 'unconfigured' }; await findByText(card, '读取项目连接').onclick();
    await findByText(card, '保存配置').onclick(); expect(world.state.actions).toHaveLength(before);
    expect(dom.node('error').textContent).toContain('凭证不可用'); expect(prompt.value).toBe('未保存工作方式');
  } finally { source.credential = credential; }
  await findByText(card, '读取项目连接').onclick(); await findByText(card, '保存配置').onclick();
  expect(world.state.actions.at(-1).params.config.default).toMatchObject({ connection_id: source.id, model: 'openai-compatible/fixture-model', append_prompt: '未保存工作方式' });
});

test('Agent 页：环境变量按公共/角色文件读取，默认遮罩并可用键值表保存', async () => {
  openAgent();
  let env = environmentBlock();
  expect(env).toBeTruthy();
  expect(deepText(env)).toContain('尚未把变量值读入浏览器');
  expect(env.querySelector('select.agent-env-target').value).toBe('common');

  await findByText(env, '读取变量').onclick();
  env = environmentBlock();
  const values = env.querySelectorAll('input.agent-env-value');
  expect(values).toHaveLength(2);
  expect(values.every(input => input.type === 'password')).toBe(true);
  const reveal = env.querySelector('button.agent-env-reveal');
  await reveal.onclick();
  expect(values[0].type).toBe('text');
  expect(reveal.textContent).toBe('隐藏');

  await env.querySelector('button[data-env-action="add"]').onclick();
  env = environmentBlock();
  const names = env.querySelectorAll('input.agent-env-name');
  const nextValues = env.querySelectorAll('input.agent-env-value');
  const addedName = names.at(-1), addedValue = nextValues.at(-1);
  addedName.value = 'EXTRA_FLAG'; await addedName.listeners.input[0]();
  addedValue.value = 'enabled'; await addedValue.listeners.input[0]();
  await env.querySelector('button[data-env-action="save"]').onclick();
  expect(world.state.actions.at(-1).method).toBe('agent.environment.configure');
  expect(world.state.actions.at(-1).params.target).toBe('common');
  expect(world.state.agentEnvironments.common).toMatchObject({ API_KEY: 'secret-value', EXTRA_FLAG: 'enabled' });

  env = environmentBlock();
  const target = env.querySelector('select.agent-env-target'); target.value = 'worker'; await target.listeners.change[0]();
  env = environmentBlock();
  expect(deepText(env)).toContain('尚未把变量值读入浏览器');
  await findByText(env, '读取变量').onclick();
  expect(deepText(environmentBlock())).toContain('这个文件还没有变量');
});

test('Agent 页：环境变量拒绝保留名，不发送写请求', async () => {
  openAgent();
  let env = environmentBlock();
  const target = env.querySelector('select.agent-env-target'); target.value = 'verifier'; await target.listeners.change[0]();
  env = environmentBlock();
  if (findByText(env, '读取变量')) await findByText(env, '读取变量').onclick();
  env = environmentBlock();
  await env.querySelector('button[data-env-action="add"]').onclick();
  env = environmentBlock();
  const name = env.querySelector('input.agent-env-name'); name.value = 'LUSH_PROJECT'; await name.listeners.input[0]();
  const before = world.state.actions.length;
  await env.querySelector('button[data-env-action="save"]').onclick();
  expect(world.state.actions.length).toBe(before);
  expect(env.querySelector('.settings-error').textContent).toContain('由 Lush 保留');
});

test('系统页：只读展示 daemon 状态与项目路径，运行设置改为可编辑表单', () => {
  openSystem();
  const block = systemBlock();
  expect(block).toBeTruthy();
  const value = field => block.querySelector(`[data-system-field="${field}"]`).textContent;
  expect(value('provider')).toBe('mock');
  // 调用超时 / 调用上限 / 拆解深度不再是只读行；那句「其余参数在 daemon 启动时从环境变量读取」也不再出现。
  expect(block.querySelector('[data-system-field="call_timeout"]')).toBeNull();
  expect(block.querySelector('[data-system-field="concurrency"]')).toBeNull();
  expect(deepText(block)).not.toContain('daemon 启动时从环境变量读取');
  expect(panel().querySelector('.agent-network-block')).toBeTruthy();
  expect(deepText(panel())).toContain('不是模型端点');

  const runtime = runtimeBlock();
  expect(runtime).toBeTruthy();
  const input = key => runtime.querySelector(`input[data-runtime-input="${key}"]`);
  const stateText = key => runtime.querySelector(`[data-runtime-state="${key}"]`).textContent;
  expect(input('concurrency').value).toBe('2');
  expect(input('control_concurrency').value).toBe('1');
  expect(input('concurrency').max).toBe('64');
  expect(input('control_concurrency').max).toBe('16');
  expect(stateText('concurrency')).toContain('生效 2');
  expect(stateText('concurrency')).toContain('环境默认 2');
  expect(runtime.querySelector('[data-runtime-source="concurrency"]').textContent).toBe('环境默认');
  expect(runtime.querySelector('[data-runtime-source="control_concurrency"]').textContent).toBe('环境默认');
  expect(runtime.querySelector('.settings-path').textContent).toBe('/tmp/demo/.lush/settings.json');
  expect(runtime.querySelector('button[data-runtime-action="save"]')).toBeTruthy();
  expect(runtime.querySelector('button[data-runtime-action="reset"]')).toBeTruthy();

  const limits = limitsBlock();
  expect(limits).toBeTruthy();
  const limitInput = key => limits.querySelector(`input[data-runtime-input="${key}"]`);
  expect(limitInput('call_timeout').value).toBe('900');
  expect(limitInput('task_call_limit').value).toBe('24');
  expect(limitInput('max_depth').value).toBe('8');
  expect(limitInput('call_timeout').max).toBe('86400');
  expect(limitInput('task_call_limit').max).toBe('1000');
  expect(limitInput('max_depth').max).toBe('64');
  expect(limits.querySelector('[data-runtime-state="call_timeout"]').textContent).toContain('生效 900 秒');
  expect(limits.querySelector('[data-runtime-state="call_timeout"]').textContent).toContain('环境默认 900 秒');
  expect(limits.querySelector('[data-runtime-source="max_depth"]').textContent).toBe('环境默认');
  expect(limits.querySelector('button[data-runtime-action="save"]')).toBeTruthy();
  expect(limits.querySelector('button[data-runtime-action="reset"]')).toBeTruthy();
});

test('系统页：保存写回并发额度并立即反映到快照；越界或非整数在页面报错且不落盘', async () => {
  openSystem();
  let runtime = runtimeBlock();
  runtime.querySelector('input[data-runtime-input="concurrency"]').value = '8';
  runtime.querySelector('input[data-runtime-input="control_concurrency"]').value = '5';
  await runtime.querySelector('button[data-runtime-action="save"]').onclick();

  expect(world.state.actions.at(-1)).toEqual({ method: 'system.configure', params: { settings: { concurrency: 8, control_concurrency: 5 } } });
  expect(world.state.runtimeSettings.concurrency).toEqual({ value: 8, default: 2, overridden: true });
  expect(world.state.runtimeSettings.control_concurrency).toEqual({ value: 5, default: 1, overridden: true });
  // 内存里立刻镜像到快照，不必等下一次轮询。
  expect(state.ui.lastSnapshot.status.concurrency).toBe(8);
  expect(state.ui.lastSnapshot.status.settings.concurrency.overridden).toBe(true);
  runtime = runtimeBlock();
  expect(runtime.querySelector('input[data-runtime-input="concurrency"]').value).toBe('8');
  expect(runtime.querySelector('[data-runtime-source="concurrency"]').textContent).toBe('已覆盖');

  // 越界（65 > 64）：页面报错、不发写请求、磁盘状态保持上一次成功写入的值。
  const before = world.state.actions.length;
  runtime.querySelector('input[data-runtime-input="concurrency"]').value = '65';
  await runtime.querySelector('button[data-runtime-action="save"]').onclick();
  expect(world.state.actions.length).toBe(before);
  expect(world.state.runtimeSettings.concurrency.value).toBe(8);
  expect(runtimeBlock().querySelector('.settings-error').hidden).toBe(false);
  expect(runtimeBlock().querySelector('.settings-error').textContent).toContain('1 到 64');

  // 非整数同样被拦下（先把上一个越界值改回合法值，否则先撞上执行通道的错）。
  const blocked = runtimeBlock();
  blocked.querySelector('input[data-runtime-input="concurrency"]').value = '8';
  blocked.querySelector('input[data-runtime-input="control_concurrency"]').value = '2.5';
  await blocked.querySelector('button[data-runtime-action="save"]').onclick();
  expect(world.state.actions.length).toBe(before);
  expect(world.state.runtimeSettings.control_concurrency.value).toBe(5);
  expect(runtimeBlock().querySelector('.settings-error').textContent).toContain('1 到 16');
});

test('系统页：恢复环境默认清除两个覆盖', async () => {
  openSystem();
  const runtime = runtimeBlock();
  runtime.querySelector('input[data-runtime-input="concurrency"]').value = '7';
  await runtime.querySelector('button[data-runtime-action="save"]').onclick();
  expect(world.state.runtimeSettings.concurrency.overridden).toBe(true);

  await runtimeBlock().querySelector('button[data-runtime-action="reset"]').onclick();
  expect(world.state.actions.at(-1)).toEqual({ method: 'system.configure', params: { settings: { concurrency: null, control_concurrency: null } } });
  expect(world.state.runtimeSettings.concurrency).toEqual({ value: 2, default: 2, overridden: false });
  expect(world.state.runtimeSettings.control_concurrency).toEqual({ value: 1, default: 1, overridden: false });
  expect(state.ui.lastSnapshot.status.control_concurrency).toBe(1);
  expect(runtimeBlock().querySelector('[data-runtime-source="concurrency"]').textContent).toBe('环境默认');
});

test('系统页：保存写回调用与拆解限额并立即反映到快照；越界在页面报错且不落盘', async () => {
  openSystem();
  let limits = limitsBlock();
  limits.querySelector('input[data-runtime-input="call_timeout"]').value = '1200';
  limits.querySelector('input[data-runtime-input="task_call_limit"]').value = '40';
  limits.querySelector('input[data-runtime-input="max_depth"]').value = '10';
  await limits.querySelector('button[data-runtime-action="save"]').onclick();
  expect(world.state.actions.at(-1)).toEqual({ method: 'system.configure', params: { settings: { call_timeout: 1200, task_call_limit: 40, max_depth: 10 } } });
  expect(world.state.runtimeSettings.call_timeout).toEqual({ value: 1200, default: 900, overridden: true });
  expect(world.state.runtimeSettings.task_call_limit).toEqual({ value: 40, default: 24, overridden: true });
  // 内存里立刻镜像到快照，不必等下一次轮询。
  expect(state.ui.lastSnapshot.status.call_timeout).toBe(1200);
  limits = limitsBlock();
  expect(limits.querySelector('input[data-runtime-input="call_timeout"]').value).toBe('1200');
  expect(limits.querySelector('[data-runtime-source="max_depth"]').textContent).toBe('已覆盖');

  const before = world.state.actions.length;
  limits.querySelector('input[data-runtime-input="call_timeout"]').value = '86401';
  await limits.querySelector('button[data-runtime-action="save"]').onclick();
  expect(world.state.actions.length).toBe(before);
  expect(world.state.runtimeSettings.call_timeout.value).toBe(1200);
  expect(limitsBlock().querySelector('.settings-error').textContent).toContain('1 到 86400');
});

test('系统页：调用与拆解限额可恢复环境默认', async () => {
  openSystem();
  const limits = limitsBlock();
  limits.querySelector('input[data-runtime-input="max_depth"]').value = '20';
  await limits.querySelector('button[data-runtime-action="save"]').onclick();
  expect(world.state.runtimeSettings.max_depth.overridden).toBe(true);
  await limitsBlock().querySelector('button[data-runtime-action="reset"]').onclick();
  expect(world.state.actions.at(-1)).toEqual({ method: 'system.configure', params: { settings: { call_timeout: null, task_call_limit: null, max_depth: null } } });
  expect(world.state.runtimeSettings.call_timeout).toEqual({ value: 900, default: 900, overridden: false });
  expect(world.state.runtimeSettings.max_depth).toEqual({ value: 8, default: 8, overridden: false });
});

test('系统页：没有快照时显示占位', async () => {
  openSystem(); state.ui.lastSnapshot = null;
  expect(() => renderSettings()).not.toThrow();
  const block = systemBlock();
  expect(block).toBeTruthy();
  expect(block.querySelector('[data-system-field="provider"]')).toBeNull();
  expect(block.querySelector('.settings-placeholder')).toBeTruthy();
  expect(deepText(block)).toContain('尚未收到 daemon 快照');
  // 后面的前缀用例需要快照回来，重新拉一次。
  await dom.intervalFor(1500)();
});