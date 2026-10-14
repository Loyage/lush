import { test, expect, beforeEach, afterEach } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';
import { openValetSettings as openEditor } from '../../src/ui/web/assets/render-valet-settings.js';
import { MANAGEMENT_GROUPS, managementPermissionMethods } from '../../src/rpc/management-policy.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { navTo } from '../../src/ui/web/assets/sidebar-init.js';
import { requestPageLeave, registerPageLeaveGuard } from '../../src/ui/web/assets/page-leave-guard.js';
const openValetSettings = () => openEditor({ registerPageLeaveGuard });
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
const select = method => root().querySelectorAll('.valet-permission-method').find(node => node.dataset.method === method).querySelector('select');
const change = (method, access) => { const node = select(method); node.value = access; node.onchange(); };
const save = () => btn('保存管家默认权限');
const quick = (group, label) => root().querySelector(`.valet-permission-group[data-group="${group}"]`).querySelectorAll('button').find(node => node.textContent === label);

test('real catalogue drives every group/option and complete save mapping, fixed and forbidden methods cannot be elevated', async () => {
  await openValetSettings(); expect(reads).toEqual(['/p/1111111111111111/api/management/permissions']);
  expect(root().querySelectorAll('.valet-permission-group').length).toBe(value.groups.length);
  expect(root().querySelectorAll('details').every(node => !node.open)).toBe(true);
  for (const item of value.methods) expect(select(item.method).querySelectorAll('option').map(node => node.value)).toEqual(item.allowed_access);
  expect(select('manager.catalog').disabled).toBe(true); expect(select('worker.transcript').disabled).toBe(true);
  expect(deepText(root())).toContain('固有不可用'); expect(deepText(root())).toContain('混合策略');
  change('worker.transcript', 'read'); expect(select('worker.transcript').value).toBe('unavailable');
  change('worker.delete', 'automatic'); expect(select('worker.delete').value).toBe('confirmation');
  change('draft.add', 'confirmation'); await save().onclick();
  expect(writes[0]).toEqual({ method: 'management.permissions_update', params: { permissions: value.permissions, expected_revision: 'r1' } });
  expect(Object.keys(writes[0].params.permissions).length).toBe(value.methods.length);
  expect(writes[0].params.permissions['manager.catalog']).toBe('read'); expect(save().classList.contains('agent-call')).toBe(false);
  expect(deepText(root())).toContain('已保存'); expect(reads.length).toBe(1); expect(save().disabled).toBe(true);
});

test('group shortcuts apply their exact range and preserve mixed policies/required catalogue', async () => {
  await openValetSettings(); change('manager.query', 'unavailable');
  await quick('workers', '可确认的写操作需确认').onclick();
  expect(select('worker.resume').value).toBe('confirmation'); expect(select('manager.query').value).toBe('unavailable'); expect(select('worker.inspect').value).toBe('read');
  await quick('workers', '禁止可调能力').onclick(); expect(select('manager.catalog').value).toBe('read'); expect(select('worker.inspect').value).toBe('unavailable');
  expect(deepText(root())).toContain('禁止'); expect(deepText(root())).toContain('固有不可用');
  await quick('workers', '恢复审核上限').onclick(); expect(select('worker.resume').value).toBe('automatic'); expect(select('worker.delete').value).toBe('confirmation');
  expect(save().disabled).toBe(true);
});

test('retained shell preserves expanded sections and custom draft on repeat opening; double save is blocked', async () => {
  await openValetSettings(); const details = root().querySelector('details'); details.open = true; change('draft.add', 'unavailable');
  await openValetSettings(); expect(root().querySelector('details')).toBe(details); expect(select('draft.add').value).toBe('unavailable'); expect(reads.length).toBe(1);
  let release; intercept = (_path, body) => body ? new Promise(resolve => release = resolve) : null;
  const saving = save().onclick(); await until(() => release); expect(select('draft.add').disabled).toBe(true); await save().onclick(); expect(writes.length).toBe(1);
  release(Response.json({ error: 'offline' }, { status: 503 })); await saving;
  expect(select('draft.add').value).toBe('unavailable'); expect(details.open).toBe(true); expect(save().disabled).toBe(true); expect(deepText(root())).toContain('结果可能未知');
  const reload = btn('重新读取').onclick(); await dialogButton(dom, '取消').onclick(); await reload; expect(select('draft.add').value).toBe('unavailable');
  intercept = null; const check = btn('重新读取').onclick(); await dialogButton(dom, '放弃并读取').onclick(); await check;
  expect(select('draft.add').value).toBe('automatic'); expect(root().querySelector('details').open).toBe(true); expect(writes.length).toBe(1);
});

test('multi-tab revision conflict preserves draft, blocks replay and explains authoritative reload', async () => {
  await openValetSettings(); value = { ...value, revision: 'another-tab' }; change('draft.add', 'confirmation'); await save().onclick();
  expect(deepText(root())).toContain('多标签或并发修改冲突'); expect(select('draft.add').value).toBe('confirmation'); expect(save().disabled).toBe(true);
  await save().onclick(); expect(writes.length).toBe(1);
  const checking = btn('重新读取').onclick(); await dialogButton(dom, '放弃并读取').onclick(); await checking;
  change('draft.add', 'unavailable'); await save().onclick(); expect(writes[1].params.expected_revision).toBe('another-tab');
});

test('initial read and explicit reread failures are retryable without losing draft or replaying writes', async () => {
  intercept = () => Promise.reject(Error('offline')); await openValetSettings(); expect(save().disabled).toBe(true); expect(deepText(root())).toContain('读取失败');
  intercept = null; await btn('重新读取').onclick(); change('draft.add', 'confirmation');
  intercept = () => Promise.reject(Error('still offline')); const reread = btn('重新读取').onclick(); await dialogButton(dom, '放弃并读取').onclick(); await reread;
  expect(select('draft.add').value).toBe('confirmation'); expect(writes).toEqual([]);
});

test('late responses after leave, project change and replacement document never overwrite the newer page', async () => {
  for (const replace of ['leave', 'project', 'document']) {
    let release; intercept = () => new Promise(resolve => release = resolve);
    const loading = openValetSettings(); await until(() => release); const before = root().querySelector('.valet-settings-page');
    let nextDom;
    if (replace === 'leave') activateDetailView({ view: 'overview' });
    if (replace === 'project') { dom.location.pathname = '/p/2222222222222222/'; activateDetailView({ view: 'overview' }); }
    if (replace === 'document') { nextDom = installDom(); }
    release(Response.json(value)); await loading;
    if (nextDom) { expect(nextDom.node('detail').querySelector('.valet-settings-page')).toBeNull(); nextDom.restore(); }
    else expect(before.querySelectorAll('select').length).toBe(0);
    intercept = null; dom.location.pathname = '/p/1111111111111111/'; activateDetailView({ view: 'overview' });
  }
});

test('late save acknowledgement cannot affect newer page; dirty/busy leave guard covers sidebar and beforeunload', async () => {
  await openValetSettings(); change('draft.add', 'confirmation');
  let prevented = false; await dom.fire('beforeunload', { preventDefault() { prevented = true; } }); expect(prevented).toBe(true);
  const rejected = navTo('valets'); await dialogButton(dom, '取消').onclick(); await rejected; expect(ui.view.id).toBe('valet-settings');
  let release; intercept = (_path, body) => body ? new Promise(resolve => release = resolve) : null;
  const saving = save().onclick(); await until(() => release);
  expect(await requestPageLeave('#workers')).toBe(false); expect(dom.location.hash).toBe('#valet-settings');
  activateDetailView({ view: 'overview' }); const marker = dom.node('detail').textContent;
  release(Response.json(value)); await saving; expect(dom.node('detail').textContent).toBe(marker);
});

test('discard leave accepts latest attempt only and releases listeners on navigation', async () => {
  await openValetSettings(); change('draft.add', 'unavailable');
  const leaving = navTo('valets'); await dialogButton(dom, '丢弃并离开').onclick(); await leaving;
  expect(ui.view.id).toBe('valets'); expect(ui.valetSettingsPage).toBeNull();
  let prevented = false; await dom.fire('beforeunload', { preventDefault() { prevented = true; } }); expect(prevented).toBe(false);
});
