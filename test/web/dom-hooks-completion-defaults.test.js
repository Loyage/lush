import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';

const json = value => ({ ok: true, json: async () => structuredClone(value) });
const defaults = (enabled = false, level = 'merge', revision = 'defaults-v1') => ({ version: 1, enabled, level, revision });
const list = model => ({ version: 1, revision: 'templates-v1', triggers: [], actions: [], templates: [], completion_defaults: model });
let catalogue, actions, reads, intercept;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) actions.push({ path, ...body }); else reads.push(path);
  const custom = intercept?.(path, body); if (custom) return custom;
  if (path.endsWith('/api/hooks')) return json(catalogue);
  if (body?.method === 'hooks.completion_defaults') {
    catalogue = { ...catalogue, completion_defaults: defaults(body.params.enabled, body.params.level, 'defaults-v2') };
    return json(catalogue);
  }
  throw new Error(`unexpected request ${path}`);
} });
const { openHooks } = await import('../../src/ui/web/assets/render-hooks.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const root = () => dom.node('detail');
const section = () => root().querySelector('.completion-defaults');
const btn = (label, node = root()) => node.querySelectorAll('button').find(button => button.textContent === label);
const enabled = () => section().querySelector('input');
const stages = () => section().querySelectorAll('.hook-completion-level');
const level = () => stages().find(control => control.getAttribute('aria-pressed') === 'true')?.dataset.level;
const save = () => btn('保存项目默认', section());
function edit(on, endpoint) {
  if (endpoint) stages().find(control => control.dataset.level === endpoint).onclick();
  if (on !== undefined) { enabled().checked = on; enabled().onchange(); }
}
beforeEach(() => {
  closeDialog(); dom.node('modal').hidden = true; catalogue = list(defaults()); actions = []; reads = []; intercept = null;
  dom.location.pathname = '/'; ui.hooksPage = null; ui.hookCatalogue = null;
  activateDetailView({ view: 'overview' });
});
afterAll(() => { closeDialog(); dom.restore(); });

test('project defaults start off/merge, separate controls only save explicitly and describe scope and non-review acceptance', async () => {
  await openHooks();
  expect(enabled().checked).toBe(false); expect(level()).toBe('merge'); expect(save().disabled).toBe(true);
  expect(stages().map(control => [control.dataset.level, control.textContent])).toEqual([['merge', '合并'], ['accept', '验收'], ['archive', '归档']]);
  expect(deepText(section())).toContain('仅之后新建的指令 Worker');
  expect(deepText(section())).toContain('已有 Worker 不变');
  expect(section().querySelector('.hook-completion-levels').getAttribute('aria-label')).toBe('默认最高自动环节');
  expect(section().querySelector('.hook-help-link').href).toBe('#doc-docs-hooks');
  edit(true, 'accept');
  expect(actions).toHaveLength(0); expect(catalogue.completion_defaults).toEqual(defaults());
  expect(deepText(section())).toContain('已保存：关闭'); expect(deepText(section())).toContain('有未保存更改');
  expect(save().classList.contains('agent-call')).toBe(true); expect(save().getAttribute('data-help')).toContain('token');
  await save().onclick();
  expect(actions).toEqual([{ path: '/api/action', method: 'hooks.completion_defaults', params: { enabled: true, level: 'accept', expected_revision: 'defaults-v1' } }]);
  expect(enabled().checked).toBe(true); expect(level()).toBe('accept'); expect(save().disabled).toBe(true);
  expect(deepText(section())).toContain('已保存：启用 · 默认到验收'); expect(dom.node('error').textContent).toContain('已有 Worker 不变');
  expect(ui.hookCatalogue).toEqual(catalogue); expect(reads).toEqual(['/api/hooks']);
});

test('shared stage visuals mark the draft highest level and included steps, never execute on selection', async () => {
  await openHooks();
  await stages().find(control => control.dataset.level === 'archive').onclick();
  expect(level()).toBe('archive');
  expect(stages().filter(control => control.classList.contains('is-included')).map(control => control.dataset.level)).toEqual(['merge', 'accept']);
  expect(stages().find(control => control.classList.contains('is-selected')).dataset.level).toBe('archive');
  expect(stages().every(control => !control.classList.contains('agent-call'))).toBe(true);
  expect(stages().every(control => control.getAttribute('data-help').includes('保存后才生效'))).toBe(true);
  expect(deepText(section())).toContain('已保存：关闭 · 默认到合并');
  expect(actions).toHaveLength(0);
});

test('reads and writes stay on the selected project route', async () => {
  dom.location.pathname = '/p/1111111111111111/'; await openHooks(); edit(true, 'merge'); await save().onclick();
  expect(reads).toEqual(['/p/1111111111111111/api/hooks']);
  expect(actions[0].path).toBe('/p/1111111111111111/api/action');
  expect(actions[0].params.expected_revision).toBe('defaults-v1');
});

test('closed defaults remember the selected stage, including archive without cleanup authorization until enabled', async () => {
  await openHooks(); edit(false, 'archive');
  expect(save().classList.contains('agent-call')).toBe(false);
  await save().onclick(); expect(dom.node('modal').hidden).toBe(true);
  expect(actions[0].params).toEqual({ enabled: false, level: 'archive', expected_revision: 'defaults-v1' });
  expect(level()).toBe('archive'); expect(enabled().checked).toBe(false);
  edit(true); const saving = save().onclick();
  expect(actions).toHaveLength(1); expect(deepText(dom.node('modal'))).toContain('清理新 Worker 及后代的 worktree/ref');
  expect(deepText(dom.node('modal'))).toContain('不丢弃脏改动'); expect(deepText(dom.node('modal'))).toContain('不是质量评审');
  expect(deepText(dom.node('modal'))).toContain('保留 Worker、会话和 Git 历史');
  expect(dialogButton(dom, '授权并保存默认').classList.contains('agent-call')).toBe(true);
  expect(dialogButton(dom, '授权并保存默认').getAttribute('data-help')).toContain('token');
  await dialogButton(dom, '取消').onclick(); await saving;
  expect(actions).toHaveLength(1); expect(enabled().checked).toBe(true); expect(level()).toBe('archive');
  expect(save().disabled).toBe(false); expect(deepText(section())).toContain('已保存：关闭');
  const confirmed = save().onclick(); await dialogButton(dom, '授权并保存默认').onclick(); await confirmed;
  expect(actions.at(-1).params).toEqual({ enabled: true, level: 'archive', expected_revision: 'defaults-v2' });
  expect(deepText(section())).toContain('已保存：启用 · 默认到归档');
});

test('all saved stages render honestly; disabling never changes the remembered stage or touches existing Workers', async () => {
  for (const endpoint of ['merge', 'accept', 'archive']) {
    catalogue = list(defaults(true, endpoint)); ui.hooksPage = null; activateDetailView({ view: 'overview' });
    await openHooks(); expect(enabled().checked).toBe(true); expect(level()).toBe(endpoint);
    expect(save().disabled).toBe(true); expect(save().parentNode.tabIndex).toBe(0);
    expect(save().parentNode.getAttribute('data-help')).toContain('没有未保存更改');
    edit(false); expect(save().classList.contains('agent-call')).toBe(false); await save().onclick();
    expect(actions.at(-1).params).toEqual({ enabled: false, level: endpoint, expected_revision: 'defaults-v1' });
    expect(level()).toBe(endpoint); expect(dom.node('modal').hidden).toBe(true);
  }
  expect(actions.every(call => call.method === 'hooks.completion_defaults')).toBe(true);
});

test('failed and stale saves preserve edits and independent revision; refresh requires explicit discard confirmation', async () => {
  await openHooks(); edit(true, 'accept');
  intercept = (_path, body) => body ? { ok: false, json: async () => ({ error: 'stale revision <script>unsafe</script>' }) } : null;
  await save().onclick();
  expect(enabled().checked).toBe(true); expect(level()).toBe('accept'); expect(save().disabled).toBe(false);
  expect(deepText(section())).toContain('已保存：关闭'); expect(deepText(section())).toContain('请刷新目录');
  expect(deepText(section())).toContain('<script>unsafe</script>'); expect(section().querySelector('script')).toBeNull();
  await save().onclick(); expect(actions.at(-1).params.expected_revision).toBe('defaults-v1');
  const refreshing = btn('刷新目录').onclick(); expect(reads).toHaveLength(1);
  await dialogButton(dom, '取消').onclick(); await refreshing; expect(level()).toBe('accept'); expect(reads).toHaveLength(1);
  intercept = null; catalogue = list(defaults(false, 'archive', 'defaults-new'));
  const discarding = btn('刷新目录').onclick(); await dialogButton(dom, '放弃并刷新').onclick(); await discarding;
  expect(level()).toBe('archive'); expect(enabled().checked).toBe(false); expect(save().disabled).toBe(true);
  edit(undefined, 'merge'); await save().onclick(); expect(actions.at(-1).params.expected_revision).toBe('defaults-new');
});

test('busy controls and page lock prevent duplicate writes; no global refresh or extra Agent action occurs', async () => {
  let resolve, refreshed = 0;
  const restore = registerNavigation({ refresh() { refreshed++; } });
  try {
    await openHooks(); edit(true, 'merge');
    intercept = (_path, body) => body ? new Promise(done => { resolve = done; }) : null;
    const saving = save().onclick(); await until(() => resolve);
    expect(enabled().disabled).toBe(true); expect(stages().every(control => control.disabled)).toBe(true); expect(save().disabled).toBe(true);
    expect(save().parentNode.getAttribute('data-help')).toContain('正在确认或保存');
    await save().onclick(); await btn('刷新目录').onclick(); await btn('新建模板').onclick();
    expect(actions).toHaveLength(1); expect(reads).toHaveLength(1); expect(root().querySelector('.hook-form')).toBeNull();
    resolve(json(list(defaults(true, 'merge', 'defaults-v2')))); await saving;
    expect(refreshed).toBe(0); expect(enabled().disabled).toBe(false); expect(save().disabled).toBe(true);
  } finally { restore(); }
});

test('unrelated template save repaints do not lose default draft or use the template revision', async () => {
  // Minimal directory permits the existing template editor to create a notify rule.
  catalogue.triggers = [{ id: 'agent.failed', label: '异常', description: '异常' }];
  catalogue.actions = [{ type: 'notify', label: '告知', description: '告知', triggers: [], modes: ['once', 'persistent'], agent_call: false }];
  await openHooks(); edit(true, 'accept'); await btn('新建模板').onclick();
  const form = root().querySelector('.hook-form'); form.querySelector('[aria-label="Hook 名称"]').value = '模板';
  form.querySelector('[aria-label="告知标题"]').value = '提醒';
  form.querySelector('[aria-label="消息或告知正文"]').value = '正文';
  intercept = (_path, body) => body?.method === 'hooks.save' ? json({ ...catalogue, revision: 'templates-v2' }) : null;
  await btn('保存模板').onclick();
  expect(enabled().checked).toBe(true); expect(level()).toBe('accept'); expect(save().disabled).toBe(false);
  await save().onclick(); expect(actions.at(-1).params.expected_revision).toBe('defaults-v1');
});

test('old, null or malformed defaults are unavailable rather than a fake off state', async () => {
  for (const model of [undefined, null, {}, defaults(false, 'off'), { ...defaults(), version: 2 }, { ...defaults(), enabled: 0 }, { ...defaults(), revision: '' }]) {
    catalogue = list(model); ui.hooksPage = null; activateDetailView({ view: 'overview' }); await openHooks();
    expect(deepText(section())).toContain('状态暂不可用'); expect(deepText(section())).toContain('未假定此功能已关闭');
    expect(section().querySelector('input')).toBeNull(); expect(section().querySelector('select')).toBeNull(); expect(save()).toBeUndefined();
  }
  expect(actions).toHaveLength(0);
});

test('malformed save response does not invent success and blocks duplicate submission until refresh', async () => {
  await openHooks(); edit(true, 'accept');
  intercept = (_path, body) => body ? json({ ...catalogue, completion_defaults: null }) : null;
  await save().onclick();
  expect(deepText(section())).toContain('勿重复提交'); expect(ui.hooksPage.completionDraft).toMatchObject({ enabled: true, level: 'accept' });
  expect(ui.hookCatalogue.completion_defaults).toEqual(defaults()); expect(save().disabled).toBe(true);
  expect(enabled().checked).toBe(true); expect(level()).toBe('accept');
  await save().onclick(); expect(actions).toHaveLength(1);
});

test('late reads and saves cannot overwrite a different page or project, update catalogue or toast', async () => {
  for (const saving of [false, true]) for (const projectChange of [false, true]) {
    dom.location.pathname = '/p/1111111111111111/'; ui.hooksPage = null; activateDetailView({ view: 'overview' });
    catalogue = list(defaults()); intercept = null;
    let resolve;
    if (saving) { await openHooks(); edit(true, 'accept'); }
    intercept = (_path, body) => (saving ? !!body : !body) ? new Promise(done => { resolve = done; }) : null;
    const pending = saving ? save().onclick() : openHooks(); await until(() => resolve);
    const oldCatalogue = ui.hookCatalogue;
    if (projectChange) dom.location.pathname = '/p/2222222222222222/';
    else activateDetailView({ view: 'overview' });
    root().replaceChildren(document.createElement('article')); dom.node('error').textContent = 'new page';
    resolve(json(list(defaults(true, 'archive', 'late')))); await pending;
    expect(root().querySelector('.completion-defaults')).toBeNull(); expect(dom.node('error').textContent).toBe('new page');
    expect(ui.hookCatalogue).toBe(oldCatalogue);
  }
});

test('navigation or project change during archive confirmation prevents POST', async () => {
  for (const next of [null, '/p/2222222222222222/', '/p/invalid/']) {
    dom.location.pathname = '/p/1111111111111111/'; ui.hooksPage = null; activateDetailView({ view: 'overview' });
    catalogue = list(defaults()); await openHooks(); edit(true, 'archive');
    const saving = save().onclick(); const count = actions.length;
    if (next) dom.location.pathname = next; else activateDetailView({ view: 'overview' });
    await dialogButton(dom, '授权并保存默认').onclick(); await saving;
    expect(actions).toHaveLength(count);
  }
});
