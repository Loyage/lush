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
  return { version: 1, scope: 'project', revision: 'r1', groups: MANAGEMENT_GROUPS, methods,
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
      if (body.params.expected_revision !== value.revision) return Response.json({ error: 'management permissions revision changed; reload before editing' }, { status: 400 });
      value = { ...value, revision: 'r2', permissions: body.params.permissions,
        methods: value.methods.map(item => ({ ...item, access: body.params.permissions[item.method] })) };
    }
    return Response.json(value);
  } });
  dom.location.pathname = '/p/1111111111111111/'; activateDetailView({ view: 'overview' });
});
afterEach(() => { ui.disposeValetSettings?.(); dom.restore(); });
const root = () => dom.node('detail');
const btn = text => root().querySelectorAll('button').find(node => node.textContent === text);
const results = () => root().querySelector('.cli-results');
const input = () => root().querySelector('input');
const search = text => { input().value = text; input().oninput({}); };
const choose = path => root().querySelectorAll('.cli-command-link').find(node => node.dataset.command === path).onclick();
const select = method => root().querySelectorAll('.cli-permission-method').find(node => node.dataset.method === method).querySelector('select');
const change = (method, access) => { const node = select(method); node.value = access; node.onchange(); };
const save = () => btn('保存管家默认权限');
const openOrder = () => { search('order'); choose('order'); };

test('empty search lists only top-level commands, local live matching/IME and directory -> detail preserve query/results/draft', async () => {
  await open(); expect(reads).toEqual(['/p/1111111111111111/api/cli/catalog', '/p/1111111111111111/api/management/permissions']);
  expect(results().querySelectorAll('.cli-command-link').map(node => node.dataset.command)).toEqual(cliCatalog().commands.filter(item => !item.parent).map(item => item.path));
  expect(root().querySelectorAll('select').length).toBe(0);
  choose('worker'); expect(deepText(root().querySelector('.cli-command-detail'))).toContain('子命令'); choose('worker resume');
  expect(deepText(root().querySelector('.cli-command-detail'))).toContain('lush worker resume ID');
  expect(select('worker.resume').value).toBe('automatic'); change('worker.resume', 'confirmation');
  await btn('返回顶层目录').onclick(); search('继续');
  const matches = results().querySelectorAll('.cli-command-link').map(node => node.dataset.command); expect(matches).toContain('worker resume');
  input().listeners.compositionstart[0](); input().value = '删除'; input().oninput({ isComposing: true });
  expect(results().querySelectorAll('.cli-command-link').map(node => node.dataset.command)).toEqual(matches);
  input().listeners.compositionend[0](); expect(results().querySelectorAll('.cli-command-link').map(node => node.dataset.command)).toContain('worker delete');
  search('lush worker RESUME'); choose('worker resume'); expect(select('worker.resume').value).toBe('confirmation');
  const heldRoot = root().querySelector('.cli-interfaces-page'); await open(); expect(root().querySelector('.cli-interfaces-page')).toBe(heldRoot); expect(input().value).toBe('lush worker RESUME'); expect(reads.length).toBe(2);
  await btn('返回搜索结果').onclick(); expect(input().value).toBe('lush worker RESUME'); expect(results().querySelectorAll('.cli-command-link').map(node => node.dataset.command)).toEqual(['worker resume']);
  search('没有此命令'); expect(deepText(results())).toContain('没有匹配'); await btn('清空').onclick(); expect(results().querySelectorAll('.cli-command-link').length).toBe(cliCatalog().commands.filter(item => !item.parent).length);
});

test('multi-RPC command uses real allowed choices/ceilings, unavailable cannot elevate; complete save preserves unexposed methods', async () => {
  await open(); openOrder();
  for (const method of cliCatalog().commands.find(item => item.path === 'order').rpc.map(item => item.method)) {
    expect(select(method).querySelectorAll('option').map(node => node.value)).toEqual(value.methods.find(item => item.method === method).allowed_access);
  }
  expect(select('management.submit').disabled).toBe(true); change('management.submit', 'automatic'); expect(select('management.submit').value).toBe('unavailable');
  expect(deepText(root())).toContain('固有不可用'); expect(deepText(root())).toContain('多个 RPC');
  change('draft.add', 'unavailable'); expect(deepText(root())).toContain('当前草稿禁止此能力');
  change('draft.add', 'confirmation'); expect(deepText(root())).not.toContain('当前草稿禁止此能力'); await save().onclick();
  expect(writes[0]).toEqual({ method: 'management.permissions_update', params: { permissions: value.permissions, expected_revision: 'r1' } });
  expect(Object.keys(writes[0].params.permissions).length).toBe(value.methods.length);
  expect(writes[0].params.permissions['manager.catalog']).toBe('read'); expect(writes[0].params.permissions['cli.catalog']).toBe('unavailable');
  expect(save().classList.contains('agent-call')).toBe(false); expect(deepText(root())).toContain('已保存'); expect(reads.length).toBe(2); expect(save().disabled).toBe(true);
  search('worker delete'); choose('worker delete'); change('worker.delete','automatic'); expect(select('worker.delete').value).toBe('confirmation');
  search('host start'); choose('host start'); expect(root().querySelectorAll('select').length).toBe(0); expect(deepText(root())).toContain('不可提权');
});

test('double save is blocked, unknown preserves draft and advanced state; reread never replays writes', async () => {
  await open(); openOrder(); const details = root().querySelector('details'); details.open = true; change('draft.add', 'unavailable');
  let release; intercept = (_path, body) => body ? new Promise(resolve => release = resolve) : null;
  const saving = save().onclick(); await until(() => release); expect(select('draft.add').disabled).toBe(true); await save().onclick(); expect(writes.length).toBe(1);
  release(Response.json({ error: 'offline' }, { status: 503 })); await saving;
  expect(select('draft.add').value).toBe('unavailable'); expect(details.open).toBe(true); expect(save().disabled).toBe(true); expect(deepText(root())).toContain('结果可能未知');
  const reload = btn('重新读取').onclick(); await dialogButton(dom, '取消').onclick(); await reload; expect(select('draft.add').value).toBe('unavailable');
  intercept = null; const check = btn('重新读取').onclick(); await dialogButton(dom, '放弃并读取').onclick(); await check;
  expect(select('draft.add').value).toBe('automatic'); expect(root().querySelector('details').open).toBe(true); expect(input().value).toBe('order'); expect(writes.length).toBe(1);
});

test('multi-tab revision conflict preserves draft, blocks replay and explains authoritative reload', async () => {
  await open(); openOrder(); value = { ...value, revision: 'another-tab' }; change('draft.add', 'confirmation'); await save().onclick();
  expect(deepText(root())).toContain('多标签或并发修改冲突'); expect(select('draft.add').value).toBe('confirmation'); expect(save().disabled).toBe(true);
  await save().onclick(); expect(writes.length).toBe(1);
  const checking = btn('重新读取').onclick(); await dialogButton(dom, '放弃并读取').onclick(); await checking;
  change('draft.add', 'unavailable'); await save().onclick(); expect(writes[1].params.expected_revision).toBe('another-tab');
});

test('read failures allow CLI browsing but not uninitialized edits; reread failure preserves prior draft', async () => {
  intercept = path => path.endsWith('/permissions') ? Promise.reject(Error('offline')) : null;
  await open(); openOrder(); expect(save().disabled).toBe(true); expect(select('draft.add').disabled).toBe(true); expect(deepText(root())).toContain('读取失败');
  intercept = null; await btn('重新读取').onclick(); change('draft.add', 'confirmation');
  intercept = () => Promise.reject(Error('still offline')); const reread = btn('重新读取').onclick(); await dialogButton(dom, '放弃并读取').onclick(); await reread;
  expect(select('draft.add').value).toBe('confirmation'); expect(writes).toEqual([]);
});

test('late directory/default responses after leave, project or replacement document cannot paint newer page', async () => {
  for (const replace of ['leave', 'project', 'document']) {
    const releases = []; intercept = path => new Promise(resolve => releases.push(() => resolve(Response.json(path.endsWith('/cli/catalog') ? cliCatalog() : value))));
    const loading = open(); await until(() => releases.length === 2); const before = root().querySelector('.cli-interfaces-page');
    let nextDom;
    if (replace === 'leave') activateDetailView({ view: 'overview' });
    if (replace === 'project') { dom.location.pathname = '/p/2222222222222222/'; activateDetailView({ view: 'overview' }); }
    if (replace === 'document') nextDom = installDom();
    for (const release of releases) release(); await loading;
    if (nextDom) { expect(nextDom.node('detail').querySelector('.cli-interfaces-page')).toBeNull(); nextDom.restore(); }
    else expect(before.querySelectorAll('.cli-command-link').length).toBe(0);
    intercept = null; dom.location.pathname = '/p/1111111111111111/'; activateDetailView({ view: 'overview' });
  }
});

test('late save ack cannot change newer page; dirty/busy guard covers sidebar/hash and beforeunload', async () => {
  await open(); openOrder(); change('draft.add', 'confirmation');
  let prevented = false; await dom.fire('beforeunload', { preventDefault() { prevented = true; } }); expect(prevented).toBe(true);
  const rejected = navTo('valets'); await dialogButton(dom, '取消').onclick(); await rejected; expect(ui.view.id).toBe('cli-interfaces');
  let release; intercept = (_path, body) => body ? new Promise(resolve => release = resolve) : null;
  const saving = save().onclick(); await until(() => release);
  expect(await requestPageLeave('#workers')).toBe(false); expect(dom.location.hash).toBe('#cli-interfaces');
  activateDetailView({ view: 'overview' }); const marker = dom.node('detail').textContent;
  release(Response.json(value)); await saving; expect(dom.node('detail').textContent).toBe(marker);
});

test('discard leave disposes listeners, global no-project reads only static catalogue and never saves', async () => {
  await open(); openOrder(); change('draft.add', 'unavailable');
  const leaving = navTo('valets'); await dialogButton(dom, '丢弃并离开').onclick(); await leaving;
  expect(ui.view.id).toBe('valets'); expect(ui.valetSettingsPage).toBeNull();
  let prevented = false; await dom.fire('beforeunload', { preventDefault() { prevented = true; } }); expect(prevented).toBe(false);
  dom.location.pathname = '/'; await open(); openOrder(); expect(select('draft.add').disabled).toBe(true); expect(save().disabled).toBe(true);
  expect(reads.at(-1)).toBe('/api/host/cli/catalog'); expect(reads.length).toBe(3); await save().onclick(); expect(writes.length).toBe(0);
  expect(deepText(root())).toContain('当前没有项目');
});
