import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until, gate } from '../helpers.js';

const json = value => ({ ok: true, json: async () => structuredClone(value) });
const fail = error => ({ ok: false, json: async () => ({ error }) });
const emptyCounts = () => ({ preparing: 0, resolving: 0, awaiting: 0, validating: 0, ready: 0, landing: 0, failed: 0, blocked: 0 });
const policy = (branch = 'main', patch = {}) => ({ version: 1, branch, owner_id: branch === 'main' ? 1 : 10,
  mounted: branch === 'main', enabled: false, validation: null, revision: `${branch}-v1`, editable: true, reason: null, counts: emptyCounts(), ...patch });
const defaultsModel = patch => ({ version: 1, mounted: false, enabled: false, revision: 'defaults-v1', editable: true, reason: null, ...patch });
const run = patch => ({ id: 55, revision: 'run-v1', parent_id: 1, target_branch: 'main', state: 'preparing', baseline: 'a'.repeat(40), commit: 'b'.repeat(40),
  member_count: 2, members: [{ id: 21, worker_number: 'W205-1', title: '来源一', delivery_id: 101, source_commit: 'c'.repeat(40) }, { id: 22, worker_number: null, title: '<script>来源二</script>' }],
  members_truncated: false, validation: null, integration_worker: { id: 23, worker_number: null, status: 'running' }, error: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:01:00Z', ...patch });
let policies, defaults, runs, intercept, actions, reads, own, globalBusy, editing;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) actions.push(body); else reads.push(path);
  const override = intercept?.(path, body); if (override) return override;
  const parsed = new URL(path, 'http://localhost');
  if (parsed.pathname.endsWith('/api/hooks')) return json({ version: 1, revision: 'hooks-v1', triggers: [], actions: [], templates: [], commands: null });
  if (parsed.pathname.endsWith('/api/branch-convergence/defaults')) return json(defaults);
  if (parsed.pathname.endsWith('/api/branch-convergence/runs')) {
    const branch = parsed.searchParams.get('branch'); return json({ version: 1, branch, items: runs.filter(item => item.target_branch === branch), next_before: null, has_more: false });
  }
  if (parsed.pathname.endsWith('/api/branch-convergence')) {
    const branch = parsed.searchParams.get('branch'); return json(branch ? policies.find(item => item.branch === branch) : { version: 1, items: policies, defaults, count: policies.length, truncated: false });
  }
  if (body?.method === 'branch.convergence_set') {
    const current = policies.find(item => item.branch === body.params.branch);
    Object.assign(current, { mounted: body.params.mounted, enabled: body.params.enabled, revision: `${current.branch}-v2` }); return json(current);
  }
  if (body?.method === 'branch.convergence_defaults_set') { Object.assign(defaults, body.params, { revision: 'defaults-v2' }); delete defaults.expected_revision; return json(defaults); }
  if (body?.method === 'branch.convergence_retry') return json({ ...runs.find(item => item.id === body.params.id), state: 'preparing', revision: 'run-v2' });
  throw new Error(`unexpected request ${path} ${body?.method || ''}`);
} });
const { renderBranchConvergence, renderConvergenceRun } = await import('../../src/ui/web/assets/branch-convergence.js');
const { workerHooks, openHooks: openAutomation } = await import('../../src/ui/web/assets/render-hooks.js');
const openHooks = options => openAutomation({ feature: 'convergence', ...options });
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const root = () => dom.node('detail');
const field = (label, node = root()) => node.querySelector(`[aria-label="${label}"]`);
const btn = (label, node = root()) => node.querySelectorAll('button').find(item => item.textContent === label);
const check = (label, value = true) => { const input = field(label); input.checked = value; return input.onchange(); };
const enable = (value = true) => check('对新交付开启归并', value);
async function component() {
  const node = renderBranchConvergence({ ownsPage: () => own, busy: () => globalBusy,
    setBusy(value) { globalBusy = value; }, setEditing(value) { editing = value; } });
  root().replaceChildren(node); await node.ready; return node;
}
const task = (p = policies[1], patch = {}) => ({ id: p.owner_id, branch: p.branch, task_kind: p.branch === 'main' ? 'main' : 'order', status: 'waiting',
  hooks: { version: 1, worker_id: p.owner_id, revision: 'hooks-v1', mounts: [], convergence: p }, ...patch });
function worker(p = policies[1], options = {}) { const node = workerHooks(task(p), { refresh() {}, ...options }); root().replaceChildren(node); return node; }
beforeEach(() => {
  closeDialog(); actions = []; reads = []; intercept = null; own = true; globalBusy = false; editing = false;
  policies = [policy('feature/x'), policy('main')]; defaults = defaultsModel(); runs = [];
  dom.location.pathname = '/'; ui.hooksPage = null; activateDetailView({ view: 'overview' }); root().replaceChildren();
});
afterAll(() => { closeDialog(); dom.restore(); });

test('retained feature re-reads inactive initial list and branch results without replaying writes', async () => {
  for (const stage of ['list', 'policy', 'runs']) {
    own = true; let release;
    intercept = path => {
      const url = new URL(path, 'http://localhost');
      const matches = stage === 'list' ? url.pathname.endsWith('/api/branch-convergence') && !url.search
        : stage === 'policy' ? url.pathname.endsWith('/api/branch-convergence') && !!url.search
        : url.pathname.endsWith('/api/branch-convergence/runs');
      return matches ? new Promise(resolve => release = resolve) : null;
    };
    const node = renderBranchConvergence({ ownsPage: () => own }); root().replaceChildren(node);
    await until(() => release);
    own = false;
    release(json(stage === 'list' ? { version: 1, items: policies, defaults, count: policies.length, truncated: false }
      : stage === 'policy' ? policy('main') : { version: 1, branch: 'main', items: [], next_before: null, has_more: false }));
    await node.ready;
    own = true; intercept = null; await node.setSubpage('history');
    expect(field('目标分支', node).value).toBe('main');
    expect(node.getAttribute('aria-busy')).toBe('false');
    expect(deepText(node)).toContain('这个分支尚无归并批次');
    node.dispose();
  }
  expect(actions).toHaveLength(0);
});

test('inactive acknowledged save cannot retain a replayable draft on feature return', async () => {
  const node = await component();
  check('在目标分支挂载归并', false);
  let release;
  intercept = (_path, body) => body?.method === 'branch.convergence_set' ? new Promise(resolve => release = resolve) : null;
  const saving = btn('保存分支归并设置').onclick(); await until(() => release);
  own = false;
  const saved = policy('main', { mounted: false, revision: 'main-v2' }); policies[1] = saved;
  release(json(saved)); await saving;
  own = true; intercept = null; await node.setSubpage('settings');
  expect(field('在目标分支挂载归并').checked).toBe(false);
  expect(btn('保存分支归并设置').disabled).toBe(true);
  expect(node.getAttribute('aria-busy')).toBe('false');
  expect(actions).toHaveLength(1); node.dispose();
});

test('project automation has independent actual mounts and future defaults, main directly selected without command catalogue', async () => {
  await openHooks(); await until(() => field('目标分支')?.value === 'main' && !field('对新交付开启归并').disabled);
  const node = root().querySelector('.branch-convergence');
  expect(field('目标分支').children.map(item => item.value)).toEqual(['main', 'feature/x']);
  expect(field('在目标分支挂载归并').checked).toBe(true); expect(field('对新交付开启归并').checked).toBe(false);
  expect(deepText(node)).toContain('main · 已保存：关闭'); expect(field('最终验证快捷指令')).toBeNull();
  expect(field('新 Worker 默认挂载归并').checked).toBe(false); expect(field('挂载后默认开启归并').checked).toBe(false);
  expect(node.querySelectorAll('textarea')).toHaveLength(0); expect(actions).toHaveLength(0);
  expect(btn('保存分支归并设置').disabled).toBe(true); expect(btn('保存分支归并设置').parentNode.classList.contains('help-host')).toBe(true);
  expect(reads.some(path => path.includes('/api/host/automation'))).toBe(false);
});

test('automation history hides mount and future default editors, retaining both unsaved drafts on return', async () => {
  runs = [run({ state: 'failed' })]; await openHooks();
  const node = root().querySelector('.branch-convergence'); await node.ready;
  enable(); check('新 Worker 默认挂载归并'); check('挂载后默认开启归并');
  const defaultsEditor = node.querySelector('.convergence-defaults');
  expect(defaultsEditor).not.toBeNull();
  await openHooks({ subpage: 'history' });
  expect(node.querySelector('.convergence-history').hidden).toBe(false);
  expect(field('最终验证快捷指令')).toBeNull();
  expect(field('在目标分支挂载归并').parentNode.hidden).toBe(true);
  expect(field('对新交付开启归并').parentNode.hidden).toBe(true);
  expect(defaultsEditor.hidden).toBe(true);
  expect(btn('保存分支归并设置').parentNode.hidden).toBe(true);
  expect(field('目标分支').parentNode.hidden).toBe(false);
  expect(deepText(node.querySelector('.convergence-runs'))).toContain('失败');
  const readsBefore = reads.length;
  await openHooks();
  expect(node.querySelector('.convergence-history').hidden).toBe(true);
  expect(field('对新交付开启归并').checked).toBe(true);
  expect(field('在目标分支挂载归并').checked).toBe(true);
  expect(field('在目标分支挂载归并').parentNode.hidden).toBe(false);
  expect(field('对新交付开启归并').parentNode.hidden).toBe(false);
  expect(defaultsEditor.hidden).toBe(false);
  expect(field('新 Worker 默认挂载归并').checked).toBe(true);
  expect(field('挂载后默认开启归并').checked).toBe(true);
  expect(btn('保存分支归并设置').disabled).toBe(false);
  expect(btn('保存新 Worker 归并默认').disabled).toBe(false);
  expect(reads).toHaveLength(readsBefore); expect(actions).toHaveLength(0);
});

test('automation history deep link keeps mount and defaults hidden after delayed branch loading', async () => {
  const pending = gate(); intercept = path => path.endsWith('/api/branch-convergence') ? pending.promise : null;
  const opening = openHooks({ subpage: 'history' });
  await until(() => !!root().querySelector('.branch-convergence'));
  const node = root().querySelector('.branch-convergence');
  expect(node.querySelector('.convergence-defaults').hidden).toBe(true);
  pending.resolve(json({ version: 1, items: policies, defaults, count: policies.length, truncated: false }));
  await node.ready; await opening;
  expect(field('目标分支').value).toBe('main');
  expect(field('在目标分支挂载归并').parentNode.hidden).toBe(true);
  expect(node.querySelector('.convergence-defaults').hidden).toBe(true);
  expect(node.querySelector('.convergence-history').hidden).toBe(false);
  expect(actions).toHaveLength(0);
});

test('enabling requires only full enable, confirms cost and submits no validation or Worker authorization', async () => {
  await component(); enable(); expect(btn('保存分支归并设置').disabled).toBe(false);
  const save = btn('保存分支归并设置'); expect(save.classList.contains('agent-call')).toBe(true); expect(save.getAttribute('data-help')).toContain('token');
  const pending = save.onclick(); expect(actions).toHaveLength(0); expect(deepText(dom.node('modal'))).toContain('单父 Squash');
  expect(dialogButton(dom, '确认开启归并').classList.contains('agent-call')).toBe(true);
  await dialogButton(dom, '确认开启归并').onclick(); await pending;
  expect(actions).toEqual([{ method: 'branch.convergence_set', params: { branch: 'main', mounted: true, enabled: true, expected_revision: 'main-v1' } }]);
  expect(deepText(root())).toContain('main · 已保存：开启'); expect(save.disabled).toBe(true); expect(editing).toBe(false);
});

test('cancel and stale revision preserve draft and exact branch revision', async () => {
  await component(); enable(); let pending = btn('保存分支归并设置').onclick(); await dialogButton(dom, '取消').onclick(); await pending;
  expect(actions).toHaveLength(0); expect(field('对新交付开启归并').checked).toBe(true);
  intercept = (_path, body) => body?.method === 'branch.convergence_set' ? fail('stale revision') : null;
  pending = btn('保存分支归并设置').onclick(); await dialogButton(dom, '确认开启归并').onclick(); await pending;
  expect(field('目标分支').value).toBe('main'); expect(field('对新交付开启归并').checked).toBe(true);
  expect(deepText(root())).toContain('版本冲突请先重新读取'); expect(actions[0].params.expected_revision).toBe('main-v1'); expect(editing).toBe(true);
});

test('mounted but closed differs from unmounted; mount closed is not purple; removal forces disabled and preserves legacy reference', async () => {
  policies[1].validation = { command_id: 'legacy', command_version: 1, authorized: false };
  await component(); field('目标分支').value = 'feature/x'; await field('目标分支').onchange();
  expect(field('对新交付开启归并').disabled).toBe(true); expect(deepText(root())).toContain('feature/x · 已保存：未挂载');
  check('在目标分支挂载归并'); expect(btn('保存分支归并设置').classList.contains('agent-call')).toBe(false);
  await btn('保存分支归并设置').onclick(); expect(actions[0].params).toMatchObject({ mounted: true, enabled: false });
  field('目标分支').value = 'main'; await field('目标分支').onchange(); enable(); check('在目标分支挂载归并', false);
  expect(field('对新交付开启归并').checked).toBe(false); await btn('保存分支归并设置').onclick();
  expect(actions[1].params).toMatchObject({ branch: 'main', mounted: false, enabled: false }); expect(actions[1].params.validation).toBeUndefined();
  expect(policies[1].validation.command_id).toBe('legacy'); expect(deepText(root())).toContain('移除不删除历史或自动重装');
});

test('closing is not an Agent call and does not withdraw fixed delivery', async () => {
  policies[1].enabled = true; await component(); enable(false);
  expect(btn('保存分支归并设置').classList.contains('agent-call')).toBe(false); await btn('保存分支归并设置').onclick();
  expect(actions).toHaveLength(1); expect(actions[0].params).toMatchObject({ mounted: true, enabled: false }); expect(deepText(root())).toContain('关闭不撤回已固定交付');
});

test('save ACK then refresh failure keeps saved model and cannot resend mutation', async () => {
  await component(); enable(); let saved = false;
  intercept = (path, body) => { if (body?.method === 'branch.convergence_set') { saved = true; return json(policy('main', { enabled: true, revision: 'main-v2' })); }
    return saved && path.includes('/api/branch-convergence?') ? fail('offline after save') : null; };
  const pending = btn('保存分支归并设置').onclick(); await dialogButton(dom, '确认开启归并').onclick(); await pending;
  expect(actions).toHaveLength(1); expect(deepText(root())).toContain('设置已保存，但刷新失败'); expect(btn('保存分支归并设置').disabled).toBe(true);
  expect(field('对新交付开启归并').checked).toBe(true); expect(editing).toBe(false);
});

test('ACK with incompatible policy cannot invite another mutation', async () => {
  await component(); enable(); intercept = (_path, body) => body?.method === 'branch.convergence_set' ? json({}) : null;
  const pending = btn('保存分支归并设置').onclick(); await dialogButton(dom, '确认开启归并').onclick(); await pending;
  expect(btn('保存分支归并设置').disabled).toBe(true); expect(deepText(root())).toContain('保存已确认'); expect(actions).toHaveLength(1);
});

test('future default retains enabled preference while unmounted, does not mutate any existing policy or start Agent', async () => {
  await component(); check('挂载后默认开启归并'); expect(btn('保存新 Worker 归并默认').classList.contains('agent-call')).toBe(false);
  await btn('保存新 Worker 归并默认').onclick();
  expect(actions).toEqual([{ method: 'branch.convergence_defaults_set', params: { mounted: false, enabled: true, expected_revision: 'defaults-v1' } }]);
  expect(policies[0].mounted).toBe(false); expect(policies[1].enabled).toBe(false); expect(deepText(root())).toContain('仅之后实际创建的新 Worker 生效，不回写已有');
});

test('enabled mounted new default confirms future cost; cancel or save failure keeps default draft', async () => {
  await component(); check('新 Worker 默认挂载归并'); check('挂载后默认开启归并');
  const save = btn('保存新 Worker 归并默认'); expect(save.classList.contains('agent-call')).toBe(true); expect(save.getAttribute('data-help')).toContain('token');
  let pending = save.onclick(); await dialogButton(dom, '取消').onclick(); await pending; expect(actions).toHaveLength(0); expect(editing).toBe(true);
  intercept = (_path, body) => body?.method === 'branch.convergence_defaults_set' ? fail('revision conflict') : null;
  pending = save.onclick(); await dialogButton(dom, '确认开启新默认').onclick(); await pending;
  expect(field('新 Worker 默认挂载归并').checked).toBe(true); expect(field('挂载后默认开启归并').checked).toBe(true);
  expect(deepText(root())).toContain('选择保留，版本冲突'); expect(actions[0].params.expected_revision).toBe('defaults-v1');
});

test('new default ACK with failed read is not resent and does not overwrite main policy', async () => {
  await component(); check('新 Worker 默认挂载归并'); let saved = false;
  intercept = (path, body) => { if (body?.method === 'branch.convergence_defaults_set') { saved = true; return json(defaultsModel({ mounted: true, revision: 'defaults-v2' })); }
    return saved && path.endsWith('/api/branch-convergence/defaults') ? fail('offline') : null; };
  await btn('保存新 Worker 归并默认').onclick(); expect(deepText(root())).toContain('默认已保存，但刷新失败');
  expect(btn('保存新 Worker 归并默认').disabled).toBe(true); expect(field('对新交付开启归并').checked).toBe(false); expect(actions).toHaveLength(1);
});

test('incompatible default ACK and Worker ACK block repeating the confirmed mutation', async () => {
  await component(); check('新 Worker 默认挂载归并');
  intercept = (_path, body) => body?.method === 'branch.convergence_defaults_set' ? json({}) : null;
  await btn('保存新 Worker 归并默认').onclick(); expect(btn('保存新 Worker 归并默认').disabled).toBe(true); expect(deepText(root())).toContain('保存已确认');
  worker(); intercept = (_path, body) => body?.method === 'branch.convergence_set' ? json({}) : null;
  const pending = btn('开启归并').onclick(); await dialogButton(dom, '确认开启归并').onclick(); await pending;
  expect(btn('开启归并').disabled).toBe(true); expect(btn('关闭归并').disabled).toBe(true); expect(actions).toHaveLength(2);
});

test('unknown or noneditable defaults do not guess permissions, and read retry restores explicitly provided model', async () => {
  defaults = { version: 1, enabled: false }; await component(); expect(field('新 Worker 默认挂载归并').disabled).toBe(true);
  expect(btn('保存新 Worker 归并默认').disabled).toBe(true); defaults = defaultsModel({ editable: false, reason: '默认写权限不可用' });
  await btn('重新读取归并默认').onclick(); expect(field('新 Worker 默认挂载归并').disabled).toBe(true); expect(deepText(root())).toContain('默认写权限不可用');
  defaults = defaultsModel(); await btn('重新读取归并默认').onclick(); expect(field('新 Worker 默认挂载归并').disabled).toBe(false); expect(actions).toHaveLength(0);
});

test('main collapsed automation has same branch toggle, project changes and Worker changes share one policy', async () => {
  let node = worker(); expect(node.getAttribute('aria-label')).toBe('Worker 自动化'); expect(node.querySelector('.hook-management').hidden).toBe(true);
  expect(btn('开启归并')).not.toBeUndefined(); const pending = btn('开启归并').onclick(); await dialogButton(dom, '确认开启归并').onclick(); await pending;
  expect(actions[0]).toEqual({ method: 'branch.convergence_set', params: { branch: 'main', mounted: true, enabled: true, expected_revision: 'main-v1' } });
  await component(); expect(field('对新交付开启归并').checked).toBe(true); enable(false); await btn('保存分支归并设置').onclick();
  node = worker(); expect(btn('关闭归并').getAttribute('aria-pressed')).toBe('true'); expect(btn('开启归并').getAttribute('aria-pressed')).toBe('false');
  const compact = workerHooks(task(), { compact: true }); expect(deepText(compact)).toContain('自动化'); expect(deepText(compact)).not.toContain('Hooks');
});

test('unmounted Worker has no convergence switch, nonapplicable null hides policy, missing old fields never invent main defaults', () => {
  worker(policies[0]); expect(root().querySelector('.worker-convergence-control')).toBeNull(); expect(btn('开启归并')).toBeUndefined();
  const node = workerHooks(task(policies[0], { hooks: { mounts: [], convergence: null } })); root().replaceChildren(node); expect(deepText(node)).not.toContain('归并自动化状态不可用');
  const old = task(); delete old.hooks.convergence; root().replaceChildren(workerHooks(old)); expect(btn('开启归并')).toBeUndefined(); expect(deepText(root())).toContain('不推断默认挂载');
  const missing = task(); delete missing.hooks.convergence.mounted; root().replaceChildren(workerHooks(missing)); expect(btn('开启归并')).toBeUndefined(); expect(actions).toHaveLength(0);
});

test('mounted order and child expose convergence without changing child completion lock; diagnostics remain outside fold', () => {
  const p = policy('feature/x', { mounted: true, editable: false, reason: '分支正在发布', counts: { ...emptyCounts(), failed: 2, blocked: 1 } });
  const child = task(p, { task_kind: 'child', auto_merge: { enabled: true, locked: true } });
  root().replaceChildren(workerHooks(child)); expect(btn('开启归并').disabled).toBe(true); expect(btn('开启归并').parentNode.classList.contains('help-host')).toBe(true);
  expect(btn('开启归并').parentNode.getAttribute('data-help')).toContain('分支正在发布');
  expect(root().querySelector('.convergence-worker-status').textContent).toContain('失败 2'); expect(deepText(root())).toContain('落地待核查 1');
  expect(root().querySelector('.hook-management').hidden).toBe(true); expect(actions).toHaveLength(0);
});

test('Worker ACK followed by refresh failure preserves saved state and does not resend', async () => {
  const node = worker(policies[1], { async refresh() { throw new Error('offline'); } });
  const pending = btn('开启归并').onclick(); await dialogButton(dom, '确认开启归并').onclick(); await pending;
  expect(btn('开启归并').disabled).toBe(true); expect(btn('关闭归并').disabled).toBe(false); expect(node.dataset.convergenceEditing).toBe('false');
  expect(dom.node('error').textContent).toContain('已保存，但刷新失败'); expect(actions).toHaveLength(1);
});

test('detail refresh retains expanded automation and in-flight convergence edit with its original revision', async () => {
  activateDetailView({ view: 'task', key: 'task-1' });
  const inspected = { ...task(), goal: '目标', deps: [], dependents: [], children: [], messages: [], notices: [] };
  renderDetail(inspected, null, null, null); const section = root().querySelector('.worker-hooks');
  section.querySelector('.hook-management-toggle').onclick(); expect(section.querySelector('.hook-management').hidden).toBe(false);
  const pending = btn('开启归并').onclick();
  renderDetail({ ...inspected, hooks: { ...inspected.hooks, convergence: policy('main', { revision: 'main-v9' }) } }, null, null, null);
  expect(root().querySelector('.worker-hooks')).toBe(section); expect(section.querySelector('.hook-management').hidden).toBe(false);
  await dialogButton(dom, '确认开启归并').onclick(); await pending;
  expect(actions[0].params.expected_revision).toBe('main-v1'); expect(section.dataset.convergenceEditing).toBe('false');
});

test('late Worker mutation does not update or refresh another Worker or project', async () => {
  const slow = gate(); let refreshed = false; worker(policies[1], { refresh() { refreshed = true; } });
  intercept = (_path, body) => body?.method === 'branch.convergence_set' ? slow.promise : null;
  const pending = btn('开启归并').onclick(); await dialogButton(dom, '确认开启归并').onclick(); await until(() => actions.length === 1);
  activateDetailView({ view: 'task', key: 'task-10' }); const next = worker(policies[0]); dom.location.pathname = '/p/2222222222222222/';
  slow.resolve(json(policy('main', { enabled: true, revision: 'main-v2' }))); await pending;
  expect(root().children[0]).toBe(next); expect(refreshed).toBe(false); expect(btn('开启归并')).toBeUndefined(); expect(actions).toHaveLength(1);
});

test('late defaults read or mutation after disposal never overwrites the new page', async () => {
  const node = await component(); const slow = gate(); intercept = (_path, body) => body?.method === 'branch.convergence_defaults_set' ? slow.promise : null;
  check('新 Worker 默认挂载归并'); const pending = btn('保存新 Worker 归并默认').onclick(); await until(() => actions.length === 1);
  own = false; node.dispose(); root().replaceChildren(document.createElement('article')); const next = root().children[0];
  slow.resolve(json(defaultsModel({ mounted: true, revision: 'defaults-v2' }))); await pending;
  expect(root().children[0]).toBe(next); expect(reads.filter(path => path.endsWith('/defaults'))).toHaveLength(0);
});

test('late default read cannot paint another project page or revive a disposed editor', async () => {
  const node = await component(); const slow = gate(); intercept = path => path.endsWith('/api/branch-convergence/defaults') ? slow.promise : null;
  const pending = btn('重新读取归并默认').onclick(); own = false; node.dispose(); dom.location.pathname = '/p/2222222222222222/';
  root().replaceChildren(document.createElement('article')); const next = root().children[0];
  slow.resolve(json(defaultsModel({ mounted: true, enabled: true }))); await pending;
  expect(root().children[0]).toBe(next); expect(actions).toHaveLength(0);
});

test('late incompatible branch ACK drops only its acknowledged draft instead of offering an obsolete resend', async () => {
  await component(); enable(); const slow = gate(); intercept = (_path, body) => body?.method === 'branch.convergence_set' ? slow.promise : null;
  const pending = btn('保存分支归并设置').onclick(); await dialogButton(dom, '确认开启归并').onclick(); await until(() => actions.length === 1);
  field('目标分支').value = 'feature/x'; await field('目标分支').onchange(); policies[1] = policy('main', { enabled: true, revision: 'main-v2' });
  slow.resolve(json({})); await pending; field('目标分支').value = 'main'; await field('目标分支').onchange();
  expect(field('对新交付开启归并').checked).toBe(true); expect(btn('保存分支归并设置').disabled).toBe(true); expect(actions).toHaveLength(1);
});

test('switch branch keeps separate drafts, discards late reads, and late ACK updates only its cache', async () => {
  await component(); enable(); const slowRead = gate();
  intercept = path => path.includes('/api/branch-convergence?branch=feature%2Fx') ? slowRead.promise : null;
  field('目标分支').value = 'feature/x'; const loading = field('目标分支').onchange();
  field('目标分支').value = 'main'; await field('目标分支').onchange(); slowRead.resolve(json(policy('feature/x'))); await loading;
  expect(field('对新交付开启归并').checked).toBe(true); expect(deepText(root())).toContain('main · 已保存：关闭');
  const slowSave = gate(); intercept = (_path, body) => body?.method === 'branch.convergence_set' ? slowSave.promise : null;
  const pending = btn('保存分支归并设置').onclick(); await dialogButton(dom, '确认开启归并').onclick(); await until(() => actions.length === 1);
  field('目标分支').value = 'feature/x'; await field('目标分支').onchange(); policies[1] = policy('main', { enabled: true, revision: 'main-v2' });
  slowSave.resolve(json(policies[1])); await pending; expect(field('目标分支').value).toBe('feature/x');
  field('目标分支').value = 'main'; await field('目标分支').onchange(); expect(btn('保存分支归并设置').disabled).toBe(true); expect(editing).toBe(false);
});

test('late list and history reads are discarded after disposal or branch switch', async () => {
  const slow = gate(); intercept = path => path.endsWith('/api/branch-convergence') ? slow.promise : null;
  const node = renderBranchConvergence({ ownsPage: () => own }); root().replaceChildren(node); own = false; node.dispose(); root().replaceChildren(document.createElement('article'));
  slow.resolve(json({ version: 1, items: policies, defaults, count: 2, truncated: false })); await node.ready; expect(root().querySelector('.branch-convergence')).toBeNull();
  own = true; const history = gate(); intercept = path => path.includes('/api/branch-convergence/runs?branch=main') ? history.promise : null;
  const next = renderBranchConvergence({ ownsPage: () => own }); root().replaceChildren(next); await until(() => reads.some(path => path.includes('/runs?branch=main')));
  field('目标分支').value = 'feature/x'; await field('目标分支').onchange(); history.resolve(json({ version: 1, branch: 'main', items: [run({ validation: { state: 'passed' } })], next_before: null, has_more: false })); await next.ready;
  expect(root().querySelector('.convergence-run')).toBeNull(); expect(actions).toHaveLength(0);
});

test('old policy missing mounted or permission fields cannot guess defaults or block feature navigation', async () => {
  delete policies[1].mounted; await openHooks(); await until(() => deepText(root()).includes('无法确认分支归并策略'));
  expect(btn('保存分支归并设置').disabled).toBe(true); expect(btn('← 返回自动化功能列表')).not.toBeUndefined(); expect(deepText(root())).not.toContain('main · 已保存：关闭');
  policies[1] = policy(); delete policies[1].editable; await component(); expect(field('在目标分支挂载归并').disabled).toBe(true); expect(actions).toHaveLength(0);
});

test('failed policy read or noneditable branch is conservative; read retry restores real selector', async () => {
  intercept = path => path.endsWith('/api/branch-convergence') ? fail('offline') : null; await component(); expect(field('目标分支').disabled).toBe(true);
  intercept = null; await btn('重新读取分支归并').onclick(); expect(field('目标分支').disabled).toBe(false);
  policies[1] = policy('main', { editable: false, reason: '父分支正在安全发布' }); await component(); expect(btn('保存分支归并设置').parentNode.getAttribute('data-help')).toContain('安全发布');
  intercept = path => path.includes('/api/branch-convergence?') ? fail('unreadable') : null; await component(); expect(deepText(root())).toContain('不使用默认值覆盖已有配置'); expect(actions).toHaveLength(0);
});

test('batch cards retain members, helpers, commits, legacy validation and visible failures; no-validation never implies pass', async () => {
  runs = [run({ state: 'awaiting', error: '需要产品决定', members_truncated: true }), run({ id: 54, state: 'integrated', validation: { state: 'passed', command_name: '旧验证' } })]; await component();
  const cards = root().querySelectorAll('.convergence-run'); expect(deepText(cards[0])).toContain('需要产品决定'); expect(deepText(cards[0])).toContain('不代表测试通过');
  expect(deepText(cards[0])).toContain(`交付 101 · 源提交：${'c'.repeat(40)}`); expect(deepText(cards[0])).toContain('候选提交（尚未确认落地）'); expect(deepText(cards[1])).toContain('落地提交');
  expect(cards[1].querySelector('.convergence-validation').textContent).toBe('最终验证：旧验证 · 通过');
  expect(cards[0].querySelectorAll('a').map(link => link.href)).toEqual(['#worker-21', '#worker-22', '#worker-23']); expect(deepText(cards[0])).toContain('W205-1'); expect(deepText(cards[0])).toContain('#22');
  expect(cards[0].querySelector('script')).toBeNull(); expect(deepText(cards[0])).toContain('<script>来源二</script>'); expect(deepText(cards[0])).toContain('已截断');
});

for (const [state, label] of [['waiting', '等待验证'], ['not_started', '尚未执行'], ['failed', '失败'], ['blocked', '验证受阻'], ['future_state', '未知状态：future_state']]) {
  test(`legacy validation ${state} remains factual, never infers passing from landing`, () => {
    const node = renderConvergenceRun(run({ state: 'integrated', validation: { state, command_name: '旧验证' } }));
    expect(node.querySelector('.convergence-validation').textContent).toBe(`最终验证：旧验证 · ${label}`);
    expect(node.querySelector('.convergence-validation').textContent).not.toContain('通过'); expect(actions).toHaveLength(0);
  });
}

test('unknown evidence and unversioned retry remain conservative; complete counts are never inferred from current page', async () => {
  const card = renderConvergenceRun({ id: 55, target_branch: 'main', state: 'failed', error: '旧数据' }, { retry() { throw new Error('must not run'); } }); root().replaceChildren(card);
  expect(deepText(card)).toContain('未知数量'); expect(deepText(card)).toContain('成员摘要尚未提供'); expect(btn('重试归并').disabled).toBe(true);
  policies[1].counts = { ...emptyCounts(), preparing: 25, resolving: 4 }; runs = [run({ state: 'constructor', validation: { state: 'constructor' } })]; await component();
  expect(deepText(root())).toContain('归并中 25 · 整合中 4'); expect(deepText(root())).toContain('未知阶段：constructor'); expect(deepText(root())).toContain('未知状态：constructor');
});

test('read paging uses exact cursor, preserves old page on failure; refresh asks before discarding draft', async () => {
  let calls = 0; intercept = path => { if (!path.includes('/api/branch-convergence/runs')) return null; calls++;
    return calls === 1 ? json({ version: 1, branch: 'main', items: [run()], next_before: 55, has_more: true }) : calls === 2 ? fail('page failure')
      : json({ version: 1, branch: 'main', items: [run({ id: 54 })], next_before: null, has_more: false }); };
  await component(); await btn('加载更早归并批次').onclick(); expect(deepText(root())).toContain('已加载旧记录保留');
  await btn('加载更早归并批次').onclick(); expect(root().querySelectorAll('.convergence-run')).toHaveLength(2); expect(reads.at(-1)).toContain('branch=main&limit=20&before=55');
  enable(); const pending = btn('重新读取分支归并').onclick(); await dialogButton(dom, '取消').onclick(); await pending; expect(field('对新交付开启归并').checked).toBe(true); expect(actions).toHaveLength(0);
});

test('retry confirms exact batch revision, never replays blocked landing or an acknowledged retry after failed read', async () => {
  runs = [run({ state: 'failed' }), run({ id: 54, state: 'blocked' })]; await component(); const retry = btn('重试归并');
  expect(root().querySelectorAll('button').filter(item => item.textContent === '重试归并')).toHaveLength(1); expect(retry.classList.contains('agent-call')).toBe(true); expect(retry.getAttribute('data-help')).toContain('token');
  let accepted = false; intercept = (path, body) => { if (body?.method === 'branch.convergence_retry') { accepted = true; return json({}); }
    return accepted && path.includes('/runs?') ? fail('read offline') : null; };
  const pending = retry.onclick(); await dialogButton(dom, '确认重试归并').onclick(); await pending;
  expect(actions).toEqual([{ method: 'branch.convergence_retry', params: { id: 55, expected_revision: 'run-v1' } }]); expect(btn('重试归并').disabled).toBe(true);
  expect(deepText(root())).toContain('不能通过重试盲目重放'); expect(dom.node('error').textContent).toContain('重试已接受，但批次刷新失败');
});

test('all policies, defaults and encoded target reads remain project-scoped', async () => {
  dom.location.pathname = '/p/0123456789abcdef/'; policies = [policy('lush/example/branch')]; await component();
  await btn('重新读取归并默认').onclick(); expect(reads).toContain('/p/0123456789abcdef/api/branch-convergence?branch=lush%2Fexample%2Fbranch');
  expect(reads).toContain('/p/0123456789abcdef/api/branch-convergence/defaults'); expect(reads.every(path => path.startsWith('/p/0123456789abcdef/'))).toBe(true); expect(actions).toHaveLength(0);
});
