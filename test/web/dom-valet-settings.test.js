import { test, expect, beforeEach, afterEach } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';
import { openCliInterfaces as openEditor } from '../../src/ui/web/assets/render-valet-settings.js';
import { cliCatalog } from '../../src/rpc/cli-catalog.js';
import { MANAGEMENT_GROUPS, managementPermissionMethods } from '../../src/rpc/management-policy.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { navTo } from '../../src/ui/web/assets/sidebar-init.js';
import { requestPageLeave, registerPageLeaveGuard } from '../../src/ui/web/assets/page-leave-guard.js';
const open = () => openEditor({ registerPageLeaveGuard });
const catalogue = () => {
  const methods = managementPermissionMethods();
  return { version: 1, scope: 'device', configured: true, revision: 'r1', groups: MANAGEMENT_GROUPS, methods,
    permissions: Object.fromEntries(methods.map(item => [item.method, item.access])) };
};
let dom, value, intercept, reads, writes;
beforeEach(() => {
  value = catalogue(); intercept = null; reads = []; writes = [];
  dom = installDom({ fetch: async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (body) writes.push(body); else reads.push(String(url));
    const special = intercept?.(String(url), body); if (special) return special;
    if (String(url).endsWith('/cli/catalog')) return Response.json(cliCatalog());
    if (body) {
      if (body.expected_revision !== value.revision) return Response.json({ error: 'management permissions revision changed; reload before editing' }, { status: 400 });
      value = { ...value, configured: true, revision: 'r2', permissions: body.permissions,
        methods: value.methods.map(item => ({ ...item, access: body.permissions[item.method] })) };
    }
    return Response.json(value);
  } });
  dom.location.pathname = '/'; activateDetailView({ view: 'overview' });
});
afterEach(() => { ui.disposeValetSettings?.(); dom.restore(); });
const root = () => dom.node('detail');
const btn = text => root().querySelectorAll('button').find(node => node.textContent === text);
const results = () => root().querySelector('.cli-results');
const input = () => root().querySelector('input');
const search = text => { input().value = text; input().oninput({}); };
const choose = path => root().querySelectorAll('.cli-command-link').find(node => node.dataset.command === (path.startsWith('lush') ? path : `lush ${path}`)).onclick();
const select = method => root().querySelectorAll('.cli-permission-method').find(node => node.dataset.method === method).querySelector('select');
const change = (method, access) => { const node = select(method); node.value = access; node.onchange(); };
const save = () => btn('保存全局管家权限');
const loadPermissions = () => (btn('重新读取全局权限') ?? btn('读取全局权限')).onclick();
const openOrder = () => { search('order'); choose('order'); };
const sorted = items => [...items].sort((a, b) => a.command_path.split(' ').length - b.command_path.split(' ').length).map(item => item.path);
const commands = () => cliCatalog().commands;

test('permission copy describes all device-user projects new and existing Valets without submitting new operations', async () => {
  const currentCopy = () => {
    const text = deepText(root()) + root().querySelectorAll('[data-help]').map(node => node.getAttribute('data-help')).join(' ');
    expect(text).not.toMatch(/未来新管家|之后新建的管家|已有管家不变|已有权限快照不变|管家默认权限|本项目默认选择|权限改变不会自行执行操作|浏览与保存不执行 CLI/);
    return text;
  };
  await open();
  const footer = deepText(root().querySelector('.cli-permissions-save'));
  for (const text of ['此设备用户所有项目的新旧管家统一使用最新权限', '排队或待确认但尚未开始的操作，执行前重新检查',
    '已开始的操作不强行中断', '已执行的不撤销', '失败不自动重放', '危险操作仍须逐次确认', '权限改变不新建操作', '已有未开始的请求可能继续或受阻']) expect(footer).toContain(text);
  currentCopy(); expect(reads).toHaveLength(1); expect(writes).toEqual([]);
  await loadPermissions();
  expect(root().querySelector('.cli-settings-status').textContent).toBe('已读取设备全局管家权限；适用于此设备用户所有项目的新旧管家。');
  search('worker resume');
  expect(results().querySelector('.cli-command-access').getAttribute('data-help')).toContain('保存后对此设备用户所有项目新旧管家生效，不新建操作；已有未开始的请求按最新权限重新检查');
  choose('worker resume');
  expect(deepText(root().querySelector('.cli-command-permissions'))).toContain('设备全局管家权限');
  expect(select('worker.resume').getAttribute('aria-label')).toBe('worker.resume 管家权限');
  expect(currentCopy()).toContain('全局权限选择');
  change('worker.resume', 'unavailable');
  expect(currentCopy()).toContain('当前草稿禁止此能力；保存后对此设备用户所有项目新旧管家生效。');
  expect(writes).toEqual([]);
  await save().onclick();
  const status = root().querySelector('.cli-settings-status').textContent;
  for (const text of ['已保存设备全局管家权限，此设备用户所有项目的新旧管家均生效', '未开始的操作执行前重新检查',
    '已开始的不强行中断', '已执行的不撤销', '权限改变不新建操作', '已有未开始的请求可能继续或受阻']) expect(status).toContain(text);
  expect(currentCopy()).toContain('当前全局权限禁止此能力。');
  expect(Object.keys(writes[0])).toEqual(['permissions', 'expected_revision']);
  expect(Object.keys(writes[0].permissions)).toEqual(Object.keys(value.permissions));
  expect(writes[0].expected_revision).toBe('r1'); expect(reads).toHaveLength(2);
});

test('static browsing combines reads and writes at every level without requesting global permissions', async () => {
  await open(); expect(reads).toEqual(['/api/host/cli/catalog']);
  expect(results().querySelectorAll('.cli-command-link').map(node => node.dataset.command)).toEqual(sorted(commands().filter(item => !item.parent)));
  expect(root().querySelector('.cli-operation-filters')).toBeNull();
  const page = root().querySelector('.cli-interfaces-page');
  expect(page.children[0].classList.contains('resource-hero')).toBe(true);
  expect(page.children.indexOf(results())).toBe(page.children.indexOf(page.querySelector('.cli-search')) + 1);
  expect(page.querySelector('.cli-catalog-notice').hidden).toBe(true);
  expect(page.querySelector('.cli-search-field').children).toEqual([page.querySelector('.cli-search-icon'), input(), btn('清空')]);
  choose('worker'); const children = root().querySelector('.cli-command-detail').querySelectorAll('.cli-command-link').map(node => node.dataset.command);
  expect(children).toEqual(sorted(commands().filter(item => item.parent === 'lush worker')));
  expect(children).toContain('lush worker resume');
  expect(children).toContain('lush worker inspect');
  search('lush status'); choose('status'); expect(select('system.status').disabled).toBe(true); expect(select('system.status').value).toBe('');
  expect(deepText(root())).toContain('审核上限：只读'); expect(deepText(root())).toContain('全局权限尚未读取');
  search('继续'); const matches = results().querySelectorAll('.cli-command-link').map(node => node.dataset.command); expect(matches).toContain('lush worker resume');
  input().listeners.compositionstart[0](); input().value = '删除'; input().oninput({ isComposing: true });
  expect(results().querySelectorAll('.cli-command-link').map(node => node.dataset.command)).toEqual(matches);
  input().listeners.compositionend[0](); expect(results().querySelectorAll('.cli-command-link').map(node => node.dataset.command)).toContain('lush worker delete');
  expect(reads).toHaveLength(1); expect(writes).toEqual([]);
});

test('unified searches expose read/write command pairs and current merge names, never retired CLI spellings', async () => {
  await open();
  const paths = () => results().querySelectorAll('.cli-command-link').map(node => node.dataset.command);
  search('worker delete'); expect(paths()).toEqual(['lush worker delete-preview', 'lush worker delete']);
  search('agent sources models'); expect(paths()).toEqual(['lush agent sources models', 'lush agent sources models-refresh']);
  search('config migrate'); expect(paths()).toEqual(['lush config migrate-preview', 'lush config migrate']);
  search('lush worker merge'); expect(paths()).toEqual(['lush worker merge', 'lush worker merge-all', 'lush worker merge-cancel']);
  const retired = ['reserve', 'reserve-all', 'unreserve', 'integrate', 'resolve-child-divergence', 'resolve-divergence', 'approve-merge', 'resolve'];
  expect(cliCatalog().commands.some(item => retired.some(name => item.path === `lush worker ${name}`))).toBe(false);
  expect(reads).toEqual(['/api/host/cli/catalog']); expect(writes).toEqual([]);
});

test('unified directory/detail navigation preserves query and loaded permission drafts across reads and writes', async () => {
  await open(); await loadPermissions(); choose('worker'); choose('worker resume');
  expect(select('worker.resume').value).toBe('automatic'); change('worker.resume', 'confirmation');
  await btn('返回顶层目录').onclick(); search('lush worker RESUME'); choose('worker resume');
  expect(select('worker.resume').value).toBe('confirmation');
  const heldRoot = root().querySelector('.cli-interfaces-page'); await open();
  expect(root().querySelector('.cli-interfaces-page')).toBe(heldRoot); expect(input().value).toBe('lush worker RESUME'); expect(reads.length).toBe(2);
  await btn('返回搜索结果').onclick(); expect(results().querySelectorAll('.cli-command-link').map(node => node.dataset.command)).toEqual(['lush worker resume']);
  search('status'); choose('status'); change('system.status', 'unavailable');
  openOrder(); expect(select('draft.add').value).toBe('automatic');
  search('worker resume'); choose('worker resume'); expect(select('worker.resume').value).toBe('confirmation');
  search('没有此命令'); expect(deepText(results())).toContain('没有匹配'); await btn('清空').onclick();
  expect(results().querySelectorAll('.cli-command-link').map(node => node.dataset.command)).toEqual(sorted(commands().filter(item => !item.parent)));
});

test('compact real executable rows keep stable relative word ordering and distinguish unknown, actual and draft permissions', async () => {
  await open(); expect(root().querySelector('.cli-search-prefix')).toBeNull();
  const rows = () => results().querySelectorAll('.cli-command-link');
  expect(rows().every(node => node.children.length === 4 && node.children.at(-1).classList.contains('cli-command-access'))).toBe(true);
  expect(rows().find(node => node.dataset.command === 'lush worker').children.at(-1).textContent).toBe('分类 · 查看子命令');
  expect(rows().find(node => node.dataset.command === 'lush log').children.at(-1).textContent).toBe('本地 · 不可授权');
  search('worker'); expect(rows().map(node => node.dataset.command)).toEqual(sorted(commands().filter(item => `${item.path} ${item.name} ${item.description}`.toLowerCase().includes('worker'))));
  for (const row of rows()) {
    const item = commands().find(item => item.path === row.dataset.command);
    expect(row.querySelector('.cli-command-operation').textContent).toBe(item.operations.length > 1 ? '读／写' : item.operations.includes('write') ? '写' : '读');
  }
  search('lushc'); choose('lushc worker'); choose('lushc worker spawn');
  expect(deepText(root().querySelector('.cli-command-detail'))).toContain("lushc worker spawn '目标'");
  search('worker resume'); expect(rows()[0].children.at(-1).textContent).toBe('全局权限未读取');
  await loadPermissions(); expect(rows()[0].children.at(-1).textContent).toBe('多项权限（2）');
  expect(rows()[0].children.at(-1).getAttribute('data-help')).toContain('worker.resume：自动执行');
  search('status'); const statusRow = () => rows().find(node => node.dataset.command === 'lush status');
  expect(statusRow().children.at(-1).textContent).toBe('只读'); choose('status'); change('system.status', 'unavailable');
  expect(statusRow().children.at(-1).textContent).toBe('禁止 · 草稿'); await btn('返回搜索结果').onclick();
  expect(statusRow().children.at(-1).textContent).toBe('禁止 · 草稿'); await save().onclick(); expect(statusRow().children.at(-1).textContent).toBe('禁止');
  openOrder(); const order = cliCatalog().commands.find(item => item.path === 'lush order');
  expect(rows().find(node => node.dataset.command === order.path).children.at(-1).getAttribute('data-help')).toContain('management.submit：固有不可用');
  expect(writes.length).toBe(1);
});

test('first unchanged reviewed defaults require explicit confirmation, cancel is inert and success removes unconfigured warnings', async () => {
  value.configured = false;
  await open(); await loadPermissions();
  expect(save().disabled).toBe(false); expect(writes).toEqual([]);
  const banner = root().querySelector('.cli-permissions-unconfigured');
  expect(banner.hidden).toBe(false); expect(root().children[0].children[1]).toBe(banner);
  expect(deepText(banner)).toContain('不代表任何项目的实际授权');
  search('status'); expect(results().querySelector('.cli-command-access').textContent).toContain('审核默认草稿 · 未生效');
  choose('status'); expect(deepText(root())).toContain('审核默认草稿 · 未生效');
  const defaults = { ...value.permissions };
  const cancelled = save().onclick();
  expect(deepText(dom.node('modal'))).toContain('此设备用户所有项目的新旧管家权限');
  await save().onclick(); expect(writes).toEqual([]); // No double confirmation / write.
  await dialogButton(dom, '取消').onclick(); await cancelled;
  expect(save().disabled).toBe(false); expect(value.configured).toBe(false); expect(writes).toEqual([]);
  const saving = save().onclick(); await dialogButton(dom, '确认全局生效').onclick(); await saving;
  expect(writes).toEqual([{ permissions: defaults, expected_revision: 'r1' }]);
  expect(value.configured).toBe(true); expect(banner.hidden).toBe(true); expect(save().disabled).toBe(true);
  expect(results().querySelector('.cli-command-access').textContent).toBe('只读');
  expect(deepText(root().querySelector('.cli-command-permissions'))).toContain('全局权限选择');
});

test('first-save modified draft survives cancellation and unknown write, reread never replays', async () => {
  value.configured = false; await open(); await loadPermissions(); openOrder(); change('draft.add', 'confirmation');
  const cancelled = save().onclick(); await dialogButton(dom, '取消').onclick(); await cancelled;
  expect(select('draft.add').value).toBe('confirmation'); expect(writes).toEqual([]);
  let prevented = false; await dom.fire('beforeunload', { preventDefault() { prevented = true; } }); expect(prevented).toBe(true);
  intercept = (_path, body) => body ? Promise.reject(Error('unknown outcome')) : null;
  const saving = save().onclick(); await dialogButton(dom, '确认全局生效').onclick(); await saving;
  expect(select('draft.add').value).toBe('confirmation'); expect(writes).toHaveLength(1); expect(save().disabled).toBe(true);
  await save().onclick(); expect(writes).toHaveLength(1);
  intercept = null; const reread = loadPermissions(); await dialogButton(dom, '放弃并读取').onclick(); await reread;
  expect(writes).toHaveLength(1); expect(save().disabled).toBe(false); expect(select('draft.add').value).toBe('automatic');
});

test('first confirmation arriving after leaving cannot submit on the replacement page', async () => {
  value.configured = false; await open(); await loadPermissions();
  const saving = save().onclick(); activateDetailView({ view: 'overview' });
  await dialogButton(dom, '确认全局生效').onclick(); await saving;
  expect(writes).toEqual([]); expect(ui.view.id).toBe('overview');
});

test('save ACK ceiling mismatch preserves draft and requires authoritative reread', async () => {
  await open(); await loadPermissions(); openOrder(); change('draft.add', 'confirmation');
  intercept = (_path, body) => body ? Response.json({ ...value, methods: value.methods.map(item => item.method === 'draft.add' ? { ...item, base_access: 'confirmation' } : item) }) : null;
  await save().onclick(); expect(select('draft.add').value).toBe('confirmation'); expect(save().disabled).toBe(true);
  expect(deepText(root())).toContain('版本不一致'); expect(writes).toHaveLength(1);
  await save().onclick(); expect(writes).toHaveLength(1);
});

test('incompatible scope/configuration/version/revision models never become editable', async () => {
  for (const patch of [{ scope: 'project' }, { configured: undefined }, { version: 2 }, { revision: '' }]) {
    value = { ...catalogue(), ...patch }; await open(); await loadPermissions(); openOrder();
    expect(save().disabled).toBe(true); expect(select('draft.add').disabled).toBe(true);
    expect(deepText(root())).toContain('不兼容'); ui.disposeValetSettings();
  }
});

test('multi-RPC ceilings cannot elevate and complete saves retain unexposed methods', async () => {
  await open(); await loadPermissions(); openOrder();
  for (const method of cliCatalog().commands.find(item => item.path === 'lush order').rpc.map(item => item.method)) {
    expect(select(method).querySelectorAll('option').map(node => node.value)).toEqual(value.methods.find(item => item.method === method).allowed_access);
  }
  expect(select('management.submit').disabled).toBe(true); change('management.submit', 'automatic'); expect(select('management.submit').value).toBe('unavailable');
  expect(deepText(root())).toContain('固有不可用'); expect(deepText(root())).toContain('多个 RPC');
  change('draft.add', 'unavailable'); expect(deepText(root())).toContain('当前草稿禁止此能力');
  change('draft.add', 'confirmation'); expect(deepText(root())).not.toContain('当前草稿禁止此能力'); await save().onclick();
  expect(writes[0]).toEqual({ permissions: value.permissions, expected_revision: 'r1' });
  expect(Object.keys(writes[0].permissions).length).toBe(value.methods.length);
  expect(writes[0].permissions['manager.catalog']).toBe('read'); expect(writes[0].permissions['cli.catalog']).toBe('unavailable');
  expect(save().classList.contains('agent-call')).toBe(false); expect(deepText(root())).toContain('已保存'); expect(reads.length).toBe(2); expect(save().disabled).toBe(true);
  search('worker delete'); choose('worker delete'); change('worker.delete', 'automatic'); expect(select('worker.delete').value).toBe('confirmation');
  search('host start'); choose('host start'); expect(root().querySelectorAll('select').length).toBe(0); expect(deepText(root())).toContain('不可提权');
});

test('double save blocked, unknown preserves draft/advanced; explicit reread never replays writes', async () => {
  await open(); await loadPermissions(); openOrder(); const details = root().querySelector('details'); details.open = true; change('draft.add', 'unavailable');
  let release; intercept = (_path, body) => body ? new Promise(resolve => release = resolve) : null;
  const saving = save().onclick(); await until(() => release); expect(select('draft.add').disabled).toBe(true); await save().onclick(); expect(writes.length).toBe(1);
  release(Response.json({ error: 'offline' }, { status: 503 })); await saving;
  expect(select('draft.add').value).toBe('unavailable'); expect(details.open).toBe(true); expect(save().disabled).toBe(true); expect(deepText(root())).toContain('结果可能未知');
  const reload = loadPermissions(); await dialogButton(dom, '取消').onclick(); await reload; expect(select('draft.add').value).toBe('unavailable');
  intercept = null; const check = loadPermissions(); await dialogButton(dom, '放弃并读取').onclick(); await check;
  expect(select('draft.add').value).toBe('automatic'); expect(root().querySelector('details').open).toBe(true); expect(input().value).toBe('order'); expect(writes.length).toBe(1);
});

test('multi-tab conflict blocks replay and authoritative reread uses new revision', async () => {
  await open(); await loadPermissions(); openOrder(); value = { ...value, revision: 'another-tab' }; change('draft.add', 'confirmation'); await save().onclick();
  expect(deepText(root())).toContain('多标签或并发修改冲突'); expect(select('draft.add').value).toBe('confirmation'); expect(save().disabled).toBe(true);
  await save().onclick(); expect(writes.length).toBe(1);
  const checking = loadPermissions(); await dialogButton(dom, '放弃并读取').onclick(); await checking;
  change('draft.add', 'unavailable'); await save().onclick(); expect(writes[1].expected_revision).toBe('another-tab');
});

test('permission read failures and mismatched catalog/Host ceilings never masquerade as current global permissions', async () => {
  intercept = path => path.endsWith('/permissions') ? Promise.reject(Error('offline')) : null;
  await open(); openOrder(); expect(reads).toHaveLength(1); await loadPermissions();
  expect(save().disabled).toBe(true); expect(select('draft.add').disabled).toBe(true); expect(select('draft.add').value).toBe(''); expect(deepText(root())).toContain('全局权限未知');
  intercept = null; await loadPermissions(); change('draft.add', 'confirmation');
  intercept = path => path.endsWith('/permissions') ? Promise.reject(Error('still offline')) : null;
  const reread = loadPermissions(); await dialogButton(dom, '放弃并读取').onclick(); await reread;
  expect(select('draft.add').value).toBe('confirmation'); expect(select('draft.add').disabled).toBe(true); expect(save().disabled).toBe(true);
  expect(deepText(root())).toContain('不代表当前权限'); expect(writes).toEqual([]);
  intercept = null; const check = loadPermissions(); await dialogButton(dom, '放弃并读取').onclick(); await check;
  value = { ...value, methods: value.methods.map(item => item.method === 'draft.add' ? { ...item, base_access: 'confirmation' } : item) };
  await loadPermissions(); expect(deepText(root())).toContain('版本不一致'); expect(select('draft.add').disabled).toBe(true);
});

test('catalogue loading is independently retryable and does not block leaving', async () => {
  intercept = path => path.endsWith('/cli/catalog') ? Promise.reject(Error('broken cache')) : null;
  await open(); expect(deepText(root())).toContain('目录加载失败'); expect(btn('重试读取目录').hidden).toBe(false); expect(btn('读取全局权限').disabled).toBe(true);
  intercept = null; await btn('重试读取目录').onclick(); expect(results().querySelectorAll('.cli-command-link').length).toBeGreaterThan(0); expect(reads).toHaveLength(2);
  ui.disposeValetSettings();
  // A new document simulates a cold load; a same-document visit reuses parsed data.
  const old = dom; let release;
  dom = installDom({ fetch: () => new Promise(resolve => { release = resolve; }) }); dom.location.pathname = '/';
  const loading = open(); await until(() => release); expect(await requestPageLeave('#workers')).toBe(true); ui.disposeValetSettings();
  release(Response.json(cliCatalog())); await loading; dom.restore(); dom = old;
});

test('late catalogue/permission responses cannot paint after leave, project switch or document replacement', async () => {
  for (const kind of ['catalogue', 'permissions']) for (const replace of ['leave', 'project', 'document']) {
    // Install an independent document to ensure a cold catalogue for each scenario.
    const outer = dom; dom = installDom({ fetch: async path => String(path).endsWith('/cli/catalog') ? Response.json(cliCatalog()) : Response.json(value) });
    dom.location.pathname = '/';
    let release;
    if (kind === 'permissions') await open();
    globalThis.fetch = path => new Promise(resolve => { release = () => resolve(Response.json(String(path).endsWith('/cli/catalog') ? cliCatalog() : value)); });
    const loading = kind === 'catalogue' ? open() : loadPermissions(); await until(() => release);
    const before = root().querySelector('.cli-interfaces-page'); let nextDom;
    if (replace === 'leave') activateDetailView({ view: 'overview' });
    if (replace === 'project') { dom.location.pathname = '/p/2222222222222222/'; activateDetailView({ view: 'overview' }); }
    if (replace === 'document') nextDom = installDom();
    release(); await loading;
    if (nextDom) { expect(nextDom.node('detail').querySelector('.cli-interfaces-page')).toBeNull(); nextDom.restore(); }
    else if (kind === 'catalogue') expect(before.querySelectorAll('.cli-command-link').length).toBe(0);
    else expect(before.querySelector('.cli-settings-status').textContent).toContain('正在读取');
    dom.restore(); dom = outer;
  }
});

test('late save cannot change newer page; dirty/busy guards cover navigation and beforeunload', async () => {
  await open(); await loadPermissions(); openOrder(); change('draft.add', 'confirmation');
  let prevented = false; await dom.fire('beforeunload', { preventDefault() { prevented = true; } }); expect(prevented).toBe(true);
  const rejected = navTo('valets'); await dialogButton(dom, '取消').onclick(); await rejected; expect(ui.view.id).toBe('cli-interfaces');
  let release; intercept = (_path, body) => body ? new Promise(resolve => release = resolve) : null;
  const saving = save().onclick(); await until(() => release);
  expect(await requestPageLeave('#workers')).toBe(false); expect(dom.location.hash).toBe('#cli-interfaces');
  activateDetailView({ view: 'overview' }); const marker = dom.node('detail').textContent;
  release(Response.json(value)); await saving; expect(dom.node('detail').textContent).toBe(marker);
});

test('discard leaves cleanly; no-project browsing reuses static data and reads global permissions on demand', async () => {
  await open(); await loadPermissions(); openOrder(); change('draft.add', 'unavailable');
  const leaving = navTo('valets'); await dialogButton(dom, '丢弃并离开').onclick(); await leaving;
  expect(ui.view.id).toBe('valets'); expect(ui.valetSettingsPage).toBeNull();
  let prevented = false; await dom.fire('beforeunload', { preventDefault() { prevented = true; } }); expect(prevented).toBe(false);
  dom.location.pathname = '/'; await open(); openOrder(); expect(select('draft.add').disabled).toBe(true); expect(select('draft.add').value).toBe(''); expect(save().disabled).toBe(true);
  expect(reads).toEqual(['/api/host/cli/catalog', '/api/host/management/permissions']); await save().onclick(); await loadPermissions(); expect(writes).toEqual([]);
  expect(select('draft.add').disabled).toBe(false); expect(select('draft.add').value).toBe('automatic');
  expect(reads.at(-1)).toBe('/api/host/management/permissions');
  expect(deepText(root())).toContain('无需选择项目，所有项目后台离线也可配置');
});
