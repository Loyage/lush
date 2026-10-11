import { afterAll, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText } from '../dom-stub.js';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const at = '2026-10-01T09:00:00.000Z';
const metric = (extra = {}) => ({ id: 'cash', kind: 'balance', scope: 'account', label: '账户现金', unit: 'USD', remaining: 12.5,
  total: null, used: null, used_percent: null, reset_at: null, window_seconds: null, models: [], ...extra });
const observation = (extra = {}) => ({ status: 'available', source: 'usage_api', checked_at: at, resources: [metric()], ...extra });
const connection = (extra = {}) => ({ id: ids[0], label: '个人账户', provider: 'deepseek', endpoint: 'https://api.deepseek.com', enabled: true,
  observation: observation(), last_success: null, consumers: [{ task_id: 999 }], ...extra });
const json = value => ({ ok: true, status: 200, json: async () => structuredClone(value) });
const fail = error => ({ ok: false, status: 409, json: async () => ({ error }) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let config, connections, current, intercept;
const requests = [];
const dom = installDom({ fetch: async (url, options) => {
  requests.push({ url, options });
  const custom = intercept?.(url, options); if (custom !== undefined) return custom;
  if (url === '/api/host/dashboard') {
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body);
      if (body.expected_revision !== config.revision) return fail('dashboard revision conflict');
      config = { version: 1, revision: `${config.revision}-next`, cards: body.cards }; return json(config);
    }
    return json(config);
  }
  if (url === '/api/host/settings/agent/connections?scope=device') return json({ connections,
    configuration_scope: { selected: 'device', source: 'device', project_override: false } });
  throw new Error(`unexpected fetch ${url}`);
} });
const { loadAccountCards, renderAccountCard, createDashboardCardSettings } = await import('../../src/ui/web/assets/dashboard-cards.js');
const { resetUiState } = await import('../../src/ui/web/assets/state.js');
afterAll(() => dom.restore());
beforeEach(() => {
  resetUiState();
  config = { version: 1, revision: 'r1', cards: ids.slice(0, 2).map(connection_id => ({ type: 'account', connection_id })) };
  connections = [connection(), connection({ id: ids[1], label: '工作账户' })]; current = true; intercept = null; requests.length = 0;
  dom.location.pathname = '/';
});
const row = (entry = connection()) => ({ id: `account:${entry.id}`, type: 'account', connection_id: entry.id, connection: entry });
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const checkbox = (root, id = ids[0]) => root.querySelector(`input[data-connection-id="${id}"]`);
const select = (root, id, value) => { const input = checkbox(root, id); input.checked = value; input.onchange(); };
const writes = () => requests.filter(entry => entry.options?.method === 'POST');
async function settings() { const panel = createDashboardCardSettings({ ownsPage: () => current }); await panel.ready; return panel; }

test('多账户各有稳定ID，不按服务商合并，只读Host设备缓存且项目路由不改请求', async () => {
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
  const rows = await loadAccountCards();
  expect(rows.map(entry => entry.id)).toEqual(ids.slice(0, 2).map(id => `account:${id}`));
  expect(rows.map(entry => entry.connection.label)).toEqual(['个人账户', '工作账户']);
  expect(requests.map(entry => entry.url)).toEqual(['/api/host/dashboard', '/api/host/settings/agent/connections?scope=device']);
  expect(writes()).toHaveLength(0);
  const root = renderAccountCard(rows[0]); expect(root.tagName).toBe('LI');
  expect(root.classList.contains('project-item')).toBe(true); expect(root.dataset.cardId).toBe(rows[0].id);
  const content = deepText(root); expect(content).toContain('个人账户'); expect(content).toContain('DeepSeek');
  expect(content).toContain('现金余额'); expect(content).toContain('12.5 USD'); expect(content).not.toContain('999');
});

test('全部结构化指标独立展示，不限两项、不混币种、分类单位窗口模型与原始读数完整', () => {
  const root = renderAccountCard(row(connection({ observation: observation({ status: 'partial', resources: [
    metric(), metric({ id: 'cny', label: '人民币余额', unit: 'CNY', remaining: 80 }),
    metric({ id: 'key', kind: 'quota', scope: 'key', label: 'Key消费', unit: 'USD', remaining: 7, total: 10, used: 3, used_percent: 30, window_seconds: 3600, reset_at: at, models: ['vendor/a'] }),
    metric({ id: 'plan', kind: 'quota', scope: 'account', label: '套餐窗口', unit: '%', remaining: 60, used_percent: 40, window_seconds: 604800, reset_at: at }),
    metric({ id: 'model', kind: 'quota', scope: 'model', label: '模型token', unit: 'tokens', remaining: 150, total: 200, used: 50 }),
  ] }) })));
  expect(root.querySelectorAll('.dashboard-account-metric')).toHaveLength(5);
  expect(root.querySelectorAll('progress')).toHaveLength(3);
  const content = deepText(root);
  for (const expected of ['部分指标可用', '12.5 USD', '80 CNY', 'Key 预算（非现金余额）', '套餐 / 额度（非现金余额）', '模型额度（非现金余额）',
    '总量 10 USD', '已用 3 USD', '原始已用比例：30 %', '1 小时窗口', '7 天（周）窗口', 'vendor/a', '重置时间：', '到期不代表额度已恢复', '百分比不是实际 token']) expect(content).toContain(expected);
  expect(root.querySelectorAll('progress').map(node => node.value)).toEqual([30, 40, 25]);
});

test('未知数值不填零、不画伪进度，不按窗口顺序推断期限', () => {
  const root = renderAccountCard(row(connection({ observation: observation({ resources: [metric({ kind: 'quota', remaining: null })] }) })));
  const content = deepText(root); expect(content).toContain('剩余 未知 USD'); expect(content).not.toContain('剩余 0');
  expect(content).toContain('已用比例未知'); expect(content).toContain('窗口时长未知'); expect(content).toContain('重置时间未知');
  expect(root.querySelectorAll('progress')).toHaveLength(0);
});

test('比例推导仅用结构化数值，0为真实零，超范围原值不被展示截断', () => {
  const root = renderAccountCard(row(connection({ observation: observation({ resources: [
    metric({ kind: 'quota', remaining: 0, total: 10 }), metric({ id: 'odd', kind: 'quota', used_percent: 120 }),
    metric({ id: 'bad', kind: 'quota', remaining: NaN, total: Infinity, used: '0' }),
  ] }) })));
  const content = deepText(root); expect(content).toContain('剩余 0 USD'); expect(content).toContain('已用 100%'); expect(content).toContain('已用 120%');
  expect(root.querySelectorAll('progress').map(node => node.value)).toEqual([100, 100]);
});

test('失败不展示当前值，不拿历史成功冒充现状；历史折叠且有时间口径', () => {
  const root = renderAccountCard(row(connection({ observation: observation({ status: 'error', error_code: 'rate_limited', resources: [metric({ remaining: 999 })] }),
    last_success: { checked_at: at, observation: observation() } })));
  expect(deepText(root)).toContain('查询失败（不代表余额为零或资源耗尽）'); expect(deepText(root)).toContain('HTTP 429');
  expect(deepText(root)).not.toContain('999 USD');
  const old = root.querySelector('.dashboard-account-old'); expect(old).not.toBeNull(); expect(old.open).not.toBe(true);
  expect(deepText(old)).toContain('历史成功观测（非当前值）'); expect(deepText(old)).toContain('12.5 USD');
  expect(root.querySelector('.dashboard-account-observation').querySelectorAll('.dashboard-account-metric')).toHaveLength(0);
});

test('source:none的列表读取时间不冒充观测时间，未知状态也不把旧成功显示为当前', () => {
  const root = renderAccountCard(row(connection({ observation: observation({ status: 'unknown', source: 'none', checked_at: at }),
    last_success: { checked_at: at, observation: observation() } })));
  const current = root.querySelector('.dashboard-account-observation');
  expect(deepText(current)).toContain('时间未知（尚无观测）'); expect(deepText(current)).toContain('未知不等于零');
  expect(current.querySelectorAll('.dashboard-account-metric')).toHaveLength(0);
  expect(deepText(root.querySelector('.dashboard-account-old'))).toContain('历史成功观测（非当前值）');
});

test('未观测、无指标、禁用来源与安全文本准确显示', () => {
  let root = renderAccountCard(row(connection({ label: '<script>evil</script>', enabled: false, observation: null })));
  expect(deepText(root)).toContain('<script>evil</script>'); expect(root.querySelector('script')).toBeNull();
  expect(deepText(root)).toContain('来源已停用'); expect(deepText(root)).toContain('未知不等于零'); expect(deepText(root)).toContain('时间未知');
  root = renderAccountCard(row(connection({ observation: observation({ resources: [] }) })));
  expect(deepText(root)).toContain('暂无可展示指标');
});

test('配置无卡片且设备无账户是真空态；已删除选中来源仍有占位', async () => {
  connections = []; const rows = await loadAccountCards(); expect(rows).toHaveLength(2); expect(rows[0].connection).toBeNull();
  expect(deepText(renderAccountCard(rows[0]))).toContain('账户来源已删除或不可用');
  config.cards = []; expect(await loadAccountCards()).toEqual([]);
  const panel = await settings(); expect(deepText(panel.root)).toContain('尚无设备托管账户'); expect(writes()).toHaveLength(0);
});

test('配置或缓存读取失败必须拒绝，绝不冒称无卡片', async () => {
  intercept = url => url === '/api/host/dashboard' ? fail('unsafe config') : undefined;
  await expect(loadAccountCards()).rejects.toThrow('卡片配置读取失败');
  intercept = url => url.includes('/agent/connections') ? fail('unsafe cache') : undefined;
  await expect(loadAccountCards()).rejects.toThrow('设备账户 / 余额缓存读取失败');
});

test('无效配置响应与错误设备作用域拒绝，不初始化写回', async () => {
  config.cards.push(config.cards[0]); await expect(loadAccountCards()).rejects.toThrow('未将其视为无卡片');
  config.cards = [];
  intercept = url => url.includes('/agent/connections') ? json({ connections, configuration_scope: { selected: 'project', source: 'project' } }) : undefined;
  await expect(loadAccountCards()).rejects.toThrow('Host 未确认设备设置来源');
  const panel = await settings(); expect(button(panel.root, '保存卡片选择').disabled).toBe(true); expect(writes()).toHaveLength(0);
});

test('设置初次读取所有账户复选，已删除来源可取消并显式保存；仅提交ID和revision', async () => {
  connections = [connection(), connection({ id: ids[2], label: '另一账户', enabled: false })];
  const panel = await settings(); expect(panel.root.querySelectorAll('input')).toHaveLength(3);
  expect(checkbox(panel.root, ids[1]).checked).toBe(true); expect(checkbox(panel.root, ids[2]).checked).toBe(false);
  select(panel.root, ids[1], false); select(panel.root, ids[2], true);
  await button(panel.root, '保存卡片选择').click();
  expect(JSON.parse(writes()[0].options.body)).toEqual({ expected_revision: 'r1', cards: [
    { type: 'account', connection_id: ids[0] }, { type: 'account', connection_id: ids[2] },
  ] });
  expect(deepText(panel.root)).toContain('已保存到设备'); expect(checkbox(panel.root, ids[1])).toBeNull();
  expect(panel.root.querySelectorAll('.agent-call')).toHaveLength(0);
  expect(localStorage.getItem('lush.dashboard')).toBeNull();
});

test('双独立页面共享后端选择；重新读取前草稿不互相覆盖', async () => {
  const first = await settings(), second = await settings(); select(first.root, ids[1], false);
  await button(first.root, '保存卡片选择').click();
  expect(checkbox(second.root, ids[1]).checked).toBe(true);
  expect(button(second.root, '重新读取').dataset.help).toContain('替换此页未保存的选择');
  await button(second.root, '重新读取').click(); expect(checkbox(second.root, ids[1]).checked).toBe(false);
  expect(writes()).toHaveLength(1);
});

test('跨浏览器revision冲突保留编辑，禁重试，显式重新读取后才能保存', async () => {
  const first = await settings(), second = await settings(); select(first.root, ids[1], false); await button(first.root, '保存卡片选择').click();
  select(second.root, ids[0], false); await button(second.root, '保存卡片选择').click();
  expect(checkbox(second.root, ids[0]).checked).toBe(false); expect(checkbox(second.root, ids[1]).checked).toBe(true);
  expect(deepText(second.root)).toContain('本页选择已保留'); const save = button(second.root, '保存卡片选择'); expect(save.disabled).toBe(true);
  expect(save.parentNode.dataset.help).toContain('先重新读取'); expect(save.parentNode.getAttribute('tabindex')).toBe('0');
  await save.click(); expect(writes()).toHaveLength(2);
  await button(second.root, '重新读取').click(); expect(checkbox(second.root, ids[0]).checked).toBe(true); expect(checkbox(second.root, ids[1]).checked).toBe(false);
  expect(save.disabled).toBe(false); expect(save.parentNode.getAttribute('tabindex')).toBeNull();
});

test('保存ACK与后续账户缓存失败分开报告，不重发成功写入，后续保存使用ACK revision', async () => {
  const panel = await settings(); select(panel.root, ids[1], false);
  intercept = url => url.includes('/agent/connections') ? fail('cache damaged') : undefined;
  await button(panel.root, '保存卡片选择').click(); expect(writes()).toHaveLength(1);
  expect(deepText(panel.root)).toContain('已保存到设备；后续'); expect(deepText(panel.root)).toContain('不必再次保存');
  intercept = null; select(panel.root, ids[0], false); await button(panel.root, '保存卡片选择').click();
  expect(JSON.parse(writes()[1].options.body).expected_revision).toBe('r1-next');
});

test('保存网络失败保留草稿且明确未知写入，不自动重试；重读失败仍保留', async () => {
  const panel = await settings(); select(panel.root, ids[1], false);
  intercept = (_url, options) => options?.method === 'POST' ? Promise.reject(new Error('network lost')) : undefined;
  await button(panel.root, '保存卡片选择').click(); expect(writes()).toHaveLength(1);
  expect(deepText(panel.root)).toContain('保存未获确认'); expect(checkbox(panel.root, ids[1]).checked).toBe(false);
  intercept = url => url === '/api/host/dashboard' ? fail('broken') : undefined;
  await panel.reload(); expect(checkbox(panel.root, ids[1]).checked).toBe(false); expect(deepText(panel.root)).toContain('保留已有选择');
});

test('读取和写入单飞，迟到离页读取不绘制或初始化配置', async () => {
  const delayed = deferred(); intercept = url => url === '/api/host/dashboard' ? delayed.promise : undefined;
  const panel = createDashboardCardSettings({ ownsPage: () => current });
  await panel.reload(); await button(panel.root, '保存卡片选择').click(); expect(requests).toHaveLength(2);
  current = false; delayed.resolve(json(config)); await panel.ready;
  expect(panel.root.querySelectorAll('input')).toHaveLength(0); expect(writes()).toHaveLength(0);
});

test('在途保存禁止编辑和重复写入，离页ACK不更新旧DOM也不启动后读', async () => {
  const panel = await settings(), delayed = deferred(); select(panel.root, ids[1], false);
  intercept = (_url, options) => options?.method === 'POST' ? delayed.promise : undefined;
  const save = button(panel.root, '保存卡片选择'), saving = save.click();
  expect(save.disabled).toBe(true); expect(checkbox(panel.root).disabled).toBe(true);
  await save.click(); await panel.reload(); expect(writes()).toHaveLength(1);
  const before = deepText(panel.root), count = requests.length; current = false;
  delayed.resolve(json({ ...config, revision: 'r2', cards: [] })); await saving;
  expect(deepText(panel.root)).toBe(before); expect(requests).toHaveLength(count);
});

test('离页总览读取不返回旧结果，未拥有页面不请求；dispose阻止设置迟到渲染', async () => {
  current = false; await expect(loadAccountCards({ ownsPage: () => current })).rejects.toMatchObject({ name: 'AbortError' }); expect(requests).toHaveLength(0);
  current = true; const delayed = deferred(); intercept = url => url === '/api/host/dashboard' ? delayed.promise : undefined;
  const pending = loadAccountCards({ ownsPage: () => current }); current = false; delayed.resolve(json(config));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  current = true; const read = deferred(); intercept = url => url === '/api/host/dashboard' ? read.promise : undefined;
  const panel = createDashboardCardSettings(); panel.dispose(); read.resolve(json(config)); await panel.ready;
  expect(panel.root.querySelectorAll('input')).toHaveLength(0);
});

test('固定父基线的独立项目管理动态接入卡片设置，保留设备读写契约', async () => {
  intercept = url => url === '/api/host/projects' ? json({ projects: [] })
    : url === '/api/host' ? json({ mode: 'bound', projects: [], restart_supported: false }) : undefined;
  const { openProjectManager } = await import('../../src/ui/web/assets/project-picker.js');
  await openProjectManager({ push: false }); await new Promise(setImmediate);
  const root = dom.node('detail').querySelector('.dashboard-card-settings');
  expect(dom.node('detail').dataset.view).toBe('project-management'); expect(root).not.toBeNull();
  expect(checkbox(root, ids[0]).checked).toBe(true); expect(writes()).toHaveLength(0);
  select(root, ids[1], false); await button(root, '保存卡片选择').click();
  expect(config.cards).toEqual([{ type: 'account', connection_id: ids[0] }]);
  expect(writes().map(entry => entry.url)).toEqual(['/api/host/dashboard']);
});

test('父管理页身份变更保护迟到账户设置读取，不将旧来源挂回新页面', async () => {
  const delayed = deferred();
  intercept = url => url === '/api/host/projects' ? json({ projects: [] })
    : url === '/api/host' ? json({ mode: 'bound', projects: [], restart_supported: false })
      : url === '/api/host/dashboard' ? delayed.promise : undefined;
  const { openProjectManager } = await import('../../src/ui/web/assets/project-picker.js');
  const { ui } = await import('../../src/ui/web/assets/state.js');
  await openProjectManager({ push: false }); await new Promise(setImmediate);
  const root = dom.node('detail').querySelector('.dashboard-card-settings'); expect(root).not.toBeNull();
  const before = deepText(root); ui.view = { id: 'settings', key: 'new-page' };
  dom.node('detail').replaceChildren(); delayed.resolve(json(config)); await new Promise(setImmediate);
  expect(deepText(root)).toBe(before); expect(root.querySelectorAll('input')).toHaveLength(0);
  expect(dom.node('detail').querySelector('.dashboard-card-settings')).toBeNull(); expect(writes()).toHaveLength(0);
});

test('全局总览混排项目与账户，配色只读并无管理/刷新/新指令操作', async () => {
  const projectId = 'abcdef0123456789';
  intercept = url => url === '/api/host/projects' ? json({ projects: [{ id: projectId, name: '彩色项目', project: '/tmp/demo', running: false }] })
    : url === `/api/host/projects/${projectId}/appearance` ? json({ id: projectId, appearance: { version: 1, color: 'rose' } })
      : url === '/api/host' ? json({ mode: 'host', projects: [] }) : undefined;
  const { openProjectOverview } = await import('../../src/ui/web/assets/project-picker.js');
  await openProjectOverview({ push: false });
  const panel = dom.node('detail'), board = panel.querySelector('.project-board');
  expect(panel.dataset.view).toBe('projects'); expect(board.children).toHaveLength(3);
  expect(board.querySelector('[data-project-id="abcdef0123456789"]').getAttribute('data-board-color')).toBe('rose');
  expect(board.querySelectorAll('.dashboard-account-card')).toHaveLength(2);
  expect(panel.querySelector('.project-manager-form')).toBeNull(); expect(panel.querySelector('.project-order')).toBeNull();
  expect(panel.querySelector('.workbench-service-restart')).toBeNull(); expect(panel.querySelector('.dashboard-card-settings')).toBeNull();
  expect(panel.querySelectorAll('button').every(node => node.classList.contains('project-board-handle'))).toBe(true);
  expect(board.querySelector('.project-open').target).toBe('_blank'); expect(writes()).toHaveLength(0);
  expect(requests.filter(entry => entry.url.endsWith('/appearance')).map(entry => entry.url)).toEqual([`/api/host/projects/${projectId}/appearance`]);
});

test('项目列表不可达仍显示已配置账户，不把失败默认为无卡片', async () => {
  intercept = url => url === '/api/host/projects' ? fail('offline') : undefined;
  const { openProjectOverview } = await import('../../src/ui/web/assets/project-picker.js');
  await openProjectOverview({ push: false });
  const panel = dom.node('detail');
  expect(panel.querySelectorAll('.dashboard-account-card')).toHaveLength(2);
  expect(deepText(panel)).toContain('项目卡片暂不可用'); expect(panel.querySelector('.workbench-empty')).toBeNull();
  expect(writes()).toHaveLength(0);
});

test('总览读取迟到不能替换刚打开的管理页，账户请求不自动重试', async () => {
  const delayed = deferred(); let first = true;
  intercept = url => {
    if (url === '/api/host/projects') return json({ projects: [] });
    if (url === '/api/host/dashboard' && first) { first = false; return delayed.promise; }
  };
  const { openProjectOverview, openProjectManager } = await import('../../src/ui/web/assets/project-picker.js');
  const pending = openProjectOverview({ push: false }); await new Promise(setImmediate);
  await openProjectManager({ push: false });
  delayed.resolve(json(config)); await pending;
  expect(dom.node('detail').dataset.view).toBe('project-management'); expect(dom.node('detail').querySelector('.project-board')).toBeNull();
  expect(writes()).toHaveLength(0);
});

test('源码不引入管理台或浏览器持久化，CSS沿用双主题token并包含320px适用窄屏规则', () => {
  const source = fs.readFileSync(new URL('../../src/ui/web/assets/dashboard-cards.js', import.meta.url), 'utf8');
  expect(source).not.toContain('render-agent-connections'); expect(source).not.toContain('localStorage'); expect(source).not.toContain('.query(');
  const css = fs.readFileSync(new URL('../../src/ui/web/assets/styles-dashboard-cards.css', import.meta.url), 'utf8');
  expect(css).toContain('var(--panel)'); expect(css).toContain('var(--text)'); expect(css).toContain('@media(max-width:640px)');
  expect(css).toContain('min-width:0'); expect(css).toContain('overflow-wrap:anywhere'); expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});
