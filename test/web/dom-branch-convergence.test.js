import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until, gate } from '../helpers.js';

const id = '81818181-8181-4181-8181-818181818181', otherId = '82828282-8282-4282-8282-828282828282';
const json = value => ({ ok: true, json: async () => structuredClone(value) });
const fail = error => ({ ok: false, json: async () => ({ error }) });
const emptyCounts = () => ({ preparing: 0, resolving: 0, awaiting: 0, validating: 0, ready: 0, landing: 0, failed: 0, blocked: 0 });
const policy = (branch = 'main', patch = {}) => ({ version: 1, branch, owner_id: branch === 'main' ? 1 : 10, owner_worker_number: null,
  enabled: false, validation: null, revision: `${branch}-v1`, editable: true, reason: null, counts: emptyCounts(), ...patch });
const validation = (version = 1, authorized = true) => ({ command_id: id, command_version: version, name: '最终全量验证', authorized });
const run = patch => ({ id: 55, revision: 'run-v1', parent_id: 1, target_branch: 'main', state: 'validating', baseline: 'a'.repeat(40), commit: 'b'.repeat(40),
  member_count: 2, members: [{ id: 21, worker_number: 'W205-1', title: '来源一', delivery_id: 101, source_commit: 'c'.repeat(40) }, { id: 22, worker_number: null, title: '<script>来源二</script>' }],
  members_truncated: false, validation: { state: 'running', command_name: '最终全量验证', started_at: '2026-01-01T00:00:00Z', finished_at: null, error: null },
  integration_worker: { id: 23, worker_number: null, status: 'running' }, error: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:01:00Z', ...patch });
// Same safe JSON fields as Runtime convergenceRunView (W205 parent 1aa2a14), not runner output.
const runtimeValidationRun = (state, patch = {}) => run({
  member_count: 1, members: [run().members[0]], integration_worker: null,
  validation: { state, command_name: '固定验证名称',
    started_at: ['waiting', 'not_started'].includes(state) ? null : '2026-01-01T00:00:00Z',
    finished_at: ['passed', 'failed'].includes(state) ? '2026-01-01T00:01:00Z' : null,
    error: ['failed', 'blocked'].includes(state) ? '归并未完成，请检查固定来源、授权和执行记录' : null },
  ...patch,
});
let commands, policies, runs, intercept, actions, reads, own, globalBusy, editing;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) actions.push(body); else reads.push(path);
  const override = intercept?.(path, body); if (override) return override;
  const parsed = new URL(path, 'http://localhost');
  if (parsed.pathname.endsWith('/api/hooks')) return json({ version: 1, revision: 'hooks-v1', triggers: [], actions: [], templates: [], commands });
  if (parsed.pathname.endsWith('/api/branch-convergence/runs')) {
    const branch = parsed.searchParams.get('branch'); return json({ version: 1, branch, items: runs.filter(item => item.target_branch === branch), next_before: null, has_more: false });
  }
  if (parsed.pathname.endsWith('/api/branch-convergence')) {
    const branch = parsed.searchParams.get('branch'); return json(branch ? policies.find(item => item.branch === branch) : { version: 1, items: policies, count: policies.length, truncated: false });
  }
  if (body?.method === 'branch.convergence_set') {
    const { branch, enabled, validation: ref } = body.params;
    const current = policies.find(item => item.branch === branch);
    Object.assign(current, { enabled, validation: ref ? { ...ref, name: '最终全量验证', authorized: true } : null, revision: `${branch}-v2` }); return json(current);
  }
  if (body?.method === 'branch.convergence_retry') return json({ ...runs.find(item => item.id === body.params.id), state: 'preparing', revision: 'run-v2' });
  throw new Error(`unexpected request ${path} ${body?.method || ''}`);
} });
const { renderBranchConvergence, renderConvergenceRun } = await import('../../src/ui/web/assets/branch-convergence.js');
const { openHooks } = await import('../../src/ui/web/assets/render-hooks.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const root = () => dom.node('detail');
const field = (label, node = root()) => node.querySelector(`[aria-label="${label}"]`);
const btn = (label, node = root()) => node.querySelectorAll('button').find(item => item.textContent === label);
async function component() {
  const node = renderBranchConvergence({ catalogue: { commands }, ownsPage: () => own, busy: () => globalBusy,
    setBusy(value) { globalBusy = value; }, setEditing(value) { editing = value; } });
  root().replaceChildren(node); await node.ready; return node;
}
function choose(ref = id, version = 1) { const control = field('最终验证快捷指令'); control.value = `${ref}:${version}`; control.onchange(); }
function enable(value = true) { const control = field('对新交付开启归并'); control.checked = value; control.onchange(); }
beforeEach(() => {
  closeDialog(); actions = []; reads = []; intercept = null; own = true; globalBusy = false; editing = false;
  policies = [policy('feature/x'), policy('main')]; runs = [];
  commands = { version: 1, revision: 'commands-v1', items: [
    { id, name: '最终全量验证', command: 'bun run test', version: 1, authorized: true },
    { id: otherId, name: '未授权指令', command: 'git push', version: 1, authorized: false },
  ] };
  dom.location.pathname = '/'; ui.hooksPage = null; activateDetailView({ view: 'overview' }); root().replaceChildren();
});
afterAll(() => { closeDialog(); dom.restore(); });

test('project automation includes independent default-off branch policy and directly selects main', async () => {
  await openHooks(); await until(() => field('目标分支')?.value === 'main' && !field('对新交付开启归并').disabled);
  const node = root().querySelector('.branch-convergence');
  expect(node).not.toBeNull(); expect(field('目标分支').children.map(item => item.value)).toEqual(['main', 'feature/x']);
  expect(field('对新交付开启归并').checked).toBe(false); expect(deepText(node)).toContain('已保存：关闭');
  expect(node.querySelectorAll('textarea')).toHaveLength(0); expect(actions).toHaveLength(0);
  expect(btn('保存分支归并设置').disabled).toBe(true); expect(btn('保存分支归并设置').parentNode.classList.contains('help-host')).toBe(true);
  expect(node.querySelectorAll('input')).toHaveLength(1); expect(reads.some(path => path.includes('/api/host/automation'))).toBe(false);
});

test('only explicitly authorized exact command versions are selectable, no Shell input or implicit authorization', async () => {
  const node = await component(); const options = field('最终验证快捷指令').children;
  expect(options.map(item => item.value)).toEqual(['', `${id}:1`]);
  enable(); expect(btn('保存分支归并设置').disabled).toBe(true);
  expect(btn('保存分支归并设置').parentNode.getAttribute('data-help')).toContain('精确版本');
  choose(); expect(btn('保存分支归并设置').disabled).toBe(false);
  expect(btn('保存分支归并设置').classList.contains('agent-call')).toBe(true);
  expect(btn('保存分支归并设置').getAttribute('data-help')).toContain('token');
  expect(deepText(node)).not.toContain('git push'); expect(actions).toHaveLength(0);
});

test('enabling confirms effects and saves complete branch-specific contract without touching Worker automation', async () => {
  await component(); choose(); enable(); const saving = btn('保存分支归并设置').onclick();
  expect(actions).toHaveLength(0); expect(deepText(dom.node('modal'))).toContain('单父 Squash'); expect(deepText(dom.node('modal'))).toContain('不是沙箱');
  expect(deepText(dom.node('modal'))).toContain('消耗 token');
  expect(dialogButton(dom, '确认开启归并').classList.contains('agent-call')).toBe(true);
  await dialogButton(dom, '确认开启归并').onclick(); await saving;
  expect(actions).toEqual([{ method: 'branch.convergence_set', params: { branch: 'main', enabled: true,
    validation: { command_id: id, command_version: 1 }, expected_revision: 'main-v1' } }]);
  expect(deepText(root())).toContain('已保存：开启'); expect(btn('保存分支归并设置').disabled).toBe(true); expect(editing).toBe(false);
});

test('cancelling enabling retains edited fields and never emits a mutation', async () => {
  await component(); choose(); enable(); const saving = btn('保存分支归并设置').onclick(); await dialogButton(dom, '取消').onclick(); await saving;
  expect(actions).toHaveLength(0); expect(field('对新交付开启归并').checked).toBe(true); expect(field('最终验证快捷指令').value).toBe(`${id}:1`);
  expect(btn('保存分支归并设置').disabled).toBe(false); expect(globalBusy).toBe(false);
});

test('disabling retains expired reference and is not an Agent call or withdrawal', async () => {
  policies[1] = policy('main', { enabled: true, validation: validation(1, false) }); commands.items[0].version = 2;
  await component(); expect(field('最终验证快捷指令').value).toBe(`${id}:1`);
  expect(deepText(root())).toContain('不可用，不会自动升级'); enable(false);
  expect(btn('保存分支归并设置').classList.contains('agent-call')).toBe(false);
  await btn('保存分支归并设置').onclick();
  expect(actions).toHaveLength(1); expect(actions[0].params).toMatchObject({ enabled: false, validation: { command_id: id, command_version: 1 } });
  expect(actions[0].method).toBe('branch.convergence_set'); expect(deepText(root())).toContain('关闭不撤回已固定交付');
});

test('saved outdated command is never upgraded on catalogue change and enabling remains blocked', async () => {
  policies[1] = policy('main', { validation: validation() }); const node = await component();
  commands.items[0].version = 2; node.updateCommands(commands); enable();
  expect(field('最终验证快捷指令').value).toBe(`${id}:1`); expect(btn('保存分支归并设置').disabled).toBe(true);
  choose(id, 2); expect(btn('保存分支归并设置').disabled).toBe(false); expect(editing).toBe(true);
});

test('failed save preserves target, command, checkbox and optimistic revision', async () => {
  await component(); choose(); enable(); intercept = (_path, body) => body?.method === 'branch.convergence_set' ? fail('revision conflict') : null;
  const saving = btn('保存分支归并设置').onclick(); await dialogButton(dom, '确认开启归并').onclick(); await saving;
  expect(field('目标分支').value).toBe('main'); expect(field('对新交付开启归并').checked).toBe(true); expect(field('最终验证快捷指令').value).toBe(`${id}:1`);
  expect(deepText(root())).toContain('选择已保留'); expect(dom.node('error').textContent).toContain('revision conflict');
  expect(btn('保存分支归并设置').disabled).toBe(false); expect(actions[0].params.expected_revision).toBe('main-v1');
});

test('mutation ACK followed by failed refresh is saved, not an invitation to repeat the mutation', async () => {
  await component(); choose(); enable(); let saved = false;
  intercept = (path, body) => { if (body?.method === 'branch.convergence_set') { saved = true; return json(policy('main', { enabled: true, validation: validation(), revision: 'main-v2' })); }
    return saved && path.includes('/api/branch-convergence?') ? fail('offline after save') : null; };
  const saving = btn('保存分支归并设置').onclick(); await dialogButton(dom, '确认开启归并').onclick(); await saving;
  expect(actions).toHaveLength(1); expect(deepText(root())).toContain('设置已保存，但刷新失败'); expect(btn('保存分支归并设置').disabled).toBe(true);
  expect(field('对新交付开启归并').checked).toBe(true); expect(editing).toBe(false);
});

test('switching branches preserves independent drafts and discards late policy reads', async () => {
  await component(); choose(); enable(); const slow = gate();
  intercept = path => path.includes('/api/branch-convergence?branch=feature%2Fx') ? slow.promise : null;
  field('目标分支').value = 'feature/x'; const loading = field('目标分支').onchange();
  field('目标分支').value = 'main'; await field('目标分支').onchange();
  slow.resolve(json(policy('feature/x', { enabled: true, validation: validation() }))); await loading;
  expect(field('目标分支').value).toBe('main'); expect(field('对新交付开启归并').checked).toBe(true); expect(field('最终验证快捷指令').value).toBe(`${id}:1`);
  expect(deepText(root())).toContain('main · 已保存：关闭'); expect(actions).toHaveLength(0); expect(editing).toBe(true);
});

test('late mutation after branch switch never replaces the selected branch or sends another mutation', async () => {
  await component(); choose(); enable(); const slow = gate();
  intercept = (_path, body) => body?.method === 'branch.convergence_set' ? slow.promise : null;
  const saving = btn('保存分支归并设置').onclick(); await dialogButton(dom, '确认开启归并').onclick(); await until(() => actions.length === 1);
  field('目标分支').value = 'feature/x'; await field('目标分支').onchange();
  slow.resolve(json(policy('main', { enabled: true, validation: validation(), revision: 'main-v2' }))); await saving;
  expect(field('目标分支').value).toBe('feature/x'); expect(deepText(root())).toContain('feature/x · 已保存：关闭'); expect(actions).toHaveLength(1);
});

test('late list responses after disposal or navigation do not mutate the new page', async () => {
  const slow = gate(); intercept = path => path.endsWith('/api/branch-convergence') ? slow.promise : null;
  const node = renderBranchConvergence({ catalogue: { commands }, ownsPage: () => own }); root().replaceChildren(node);
  own = false; node.dispose(); root().replaceChildren(document.createElement('article'));
  slow.resolve(json({ version: 1, items: policies, count: 2, truncated: false })); await node.ready;
  expect(root().querySelector('.branch-convergence')).toBeNull(); expect(reads.filter(path => path.includes('branch=')).length).toBe(0); expect(actions).toHaveLength(0);
});

test('missing legacy API fields disable policy editing without inventing a default or blocking Hooks', async () => {
  intercept = path => path.endsWith('/api/branch-convergence') ? json({ branches: [] }) : null;
  await openHooks(); await until(() => deepText(root()).includes('无法确认分支归并策略'));
  expect(btn('保存分支归并设置').disabled).toBe(true); expect(btn('新建模板')).not.toBeUndefined();
  expect(deepText(root().querySelector('.branch-convergence'))).not.toContain('已保存：关闭'); expect(actions).toHaveLength(0);
});

test('failed single policy read cannot submit an assumed default over existing settings', async () => {
  intercept = path => path.includes('/api/branch-convergence?') ? fail('policy unreadable') : null;
  await component(); expect(btn('保存分支归并设置').disabled).toBe(true); expect(field('对新交付开启归并').disabled).toBe(true);
  expect(deepText(root())).toContain('不使用默认值覆盖已有配置'); expect(actions).toHaveLength(0);
});

test('batch cards show actual member identifiers, validation, errors, helper and candidate vs landed commits safely', async () => {
  runs = [run({ state: 'awaiting', error: '需要产品决定', members_truncated: true }), run({ id: 54, state: 'integrated', validation: { state: 'succeeded', command_name: '最终全量验证' } })];
  await component(); const cards = root().querySelectorAll('.convergence-run'); expect(cards).toHaveLength(2);
  expect(deepText(cards[0])).toContain('等待决定'); expect(deepText(cards[0])).toContain('需要产品决定'); expect(deepText(cards[0])).toContain('最终验证：最终全量验证 · 验证中');
  expect(deepText(cards[0])).toContain(`交付 101 · 源提交：${'c'.repeat(40)}`);
  expect(deepText(cards[0])).toContain('候选提交（尚未确认落地）'); expect(deepText(cards[1])).toContain('落地提交');
  const links = cards[0].querySelectorAll('a'); expect(links.map(link => link.href)).toEqual(['#worker-21', '#worker-22', '#worker-23']);
  expect(links.map(link => link.textContent).join(' ')).toContain('W205-1'); expect(links[1].textContent).toContain('#22'); expect(links[2].textContent).toContain('#23');
  expect(cards[0].querySelector('script')).toBeNull(); expect(deepText(cards[0])).toContain('<script>来源二</script>'); expect(deepText(cards[0])).toContain('已截断');
});

test('read-only paging uses exact branch and returned cursor; failed page preserves records and supports retry', async () => {
  let calls = 0;
  intercept = path => {
    if (!path.includes('/api/branch-convergence/runs')) return null;
    calls++;
    if (calls === 1) return json({ version: 1, branch: 'main', items: [run()], next_before: 55, has_more: true });
    if (calls === 2) return fail('page failure');
    return json({ version: 1, branch: 'main', items: [run({ id: 54 })], next_before: null, has_more: false });
  };
  await component(); await btn('加载更早归并批次').onclick(); expect(root().querySelectorAll('.convergence-run')).toHaveLength(1);
  expect(deepText(root())).toContain('已加载旧记录保留'); await btn('加载更早归并批次').onclick(); expect(root().querySelectorAll('.convergence-run')).toHaveLength(2);
  expect(reads.at(-1)).toContain('branch=main&limit=20&before=55'); expect(btn('加载更早归并批次').hidden).toBe(true); expect(actions).toHaveLength(0);
});

test('retry is Agent-marked, confirmation-bound and pinned to the run revision; blocked landing is never retryable', async () => {
  runs = [run({ state: 'failed', error: '验证失败' }), run({ id: 54, state: 'blocked' })]; await component();
  expect(root().querySelectorAll('button').filter(item => item.textContent === '重试归并')).toHaveLength(1);
  const retry = btn('重试归并'); expect(retry.classList.contains('agent-call')).toBe(true); expect(retry.getAttribute('data-help')).toContain('token');
  const pending = retry.onclick(); expect(actions).toHaveLength(0); await dialogButton(dom, '确认重试归并').onclick(); await pending;
  expect(actions).toEqual([{ method: 'branch.convergence_retry', params: { id: 55, expected_revision: 'run-v1' } }]);
  expect(deepText(root())).toContain('不能通过重试盲目重放');
});

test('read-only refresh asks before discarding a draft and no counts are inferred from a partial run page', async () => {
  policies[1].counts = undefined; const node = await component(); expect(deepText(node)).toContain('统计不可用');
  choose(); enable(); const pending = btn('重新读取分支归并').onclick(); await dialogButton(dom, '取消').onclick(); await pending;
  expect(field('对新交付开启归并').checked).toBe(true); expect(actions).toHaveLength(0);
  const refreshing = btn('重新读取分支归并').onclick(); await dialogButton(dom, '放弃并刷新').onclick(); await refreshing;
  expect(field('对新交付开启归并').checked).toBe(false); expect(editing).toBe(false);
});

test('project-scoped endpoints encode the complete branch name and never fall back to device configuration', async () => {
  dom.location.pathname = '/p/0123456789abcdef/'; policies = [policy('lush/example/branch')]; await component();
  expect(reads).toContain('/p/0123456789abcdef/api/branch-convergence?branch=lush%2Fexample%2Fbranch');
  expect(reads.every(path => path.startsWith('/p/0123456789abcdef/'))).toBe(true); expect(actions).toHaveLength(0);
});

test('revocation or version changes while enabling confirmation is open abort before the mutation', async () => {
  const node = await component(); choose(); enable(); const pending = btn('保存分支归并设置').onclick();
  commands.items[0].authorized = false; node.updateCommands(commands);
  await dialogButton(dom, '确认开启归并').onclick(); await pending;
  expect(actions).toHaveLength(0); expect(deepText(root())).toContain('失效或撤权'); expect(field('最终验证快捷指令').value).toBe(`${id}:1`);
  expect(btn('保存分支归并设置').disabled).toBe(true);
});

test('noneditable branch retains server policy and explains the disabled action through its help host', async () => {
  policies[1] = policy('main', { editable: false, reason: '父分支正在安全发布，暂不能更改策略。' }); await component();
  expect(field('对新交付开启归并').disabled).toBe(true); expect(btn('保存分支归并设置').disabled).toBe(true);
  expect(btn('保存分支归并设置').parentNode.getAttribute('data-help')).toContain('安全发布'); expect(actions).toHaveLength(0);
});

test('missing nonessential run fields show unknown evidence and disable unversioned retry', async () => {
  const card = renderConvergenceRun({ id: 55, target_branch: 'main', state: 'failed', error: '旧投影缺少版本' }, { retry() { throw new Error('must not run'); } });
  root().replaceChildren(card); expect(deepText(card)).toContain('未知数量'); expect(deepText(card)).toContain('成员摘要尚未提供');
  expect(deepText(card)).toContain('不代表验证通过'); expect(btn('重试归并').disabled).toBe(true);
  expect(btn('重试归并').parentNode.getAttribute('data-help')).toContain('批次版本不可用'); expect(actions).toHaveLength(0);
});

test('late history read is discarded after switching the target branch', async () => {
  const slow = gate(); intercept = path => path.includes('/api/branch-convergence/runs?branch=main') ? slow.promise : null;
  const node = renderBranchConvergence({ catalogue: { commands }, ownsPage: () => own }); root().replaceChildren(node);
  await until(() => reads.some(path => path.includes('/api/branch-convergence/runs?branch=main')));
  field('目标分支').value = 'feature/x'; await field('目标分支').onchange();
  slow.resolve(json({ version: 1, branch: 'main', items: [run()], next_before: null, has_more: false })); await node.ready;
  expect(field('目标分支').value).toBe('feature/x'); expect(root().querySelectorAll('.convergence-run')).toHaveLength(0); expect(actions).toHaveLength(0);
});

test('acknowledged retry with failed refresh cannot replay the old batch revision', async () => {
  runs = [run({ state: 'failed' })]; await component(); let requested = false;
  intercept = (path, body) => { if (body?.method === 'branch.convergence_retry') { requested = true; return json({}); }
    return requested && path.includes('/api/branch-convergence/runs') ? fail('refresh offline') : null; };
  const pending = btn('重试归并').onclick(); await dialogButton(dom, '确认重试归并').onclick(); await pending;
  expect(actions).toHaveLength(1); expect(dom.node('error').textContent).toContain('重试已接受，但批次刷新失败');
  expect(btn('重试归并').disabled).toBe(true); expect(btn('重试归并').parentNode.getAttribute('data-help')).toContain('重试已接受');
});

test('late save acknowledgement clears only its own cached draft when viewing another branch', async () => {
  await component(); choose(); enable(); const slow = gate();
  intercept = (_path, body) => body?.method === 'branch.convergence_set' ? slow.promise : null;
  const pending = btn('保存分支归并设置').onclick(); await dialogButton(dom, '确认开启归并').onclick(); await until(() => actions.length === 1);
  field('目标分支').value = 'feature/x'; await field('目标分支').onchange();
  policies[1] = policy('main', { enabled: true, validation: validation(), revision: 'main-v2' }); slow.resolve(json(policies[1])); await pending;
  expect(field('目标分支').value).toBe('feature/x'); field('目标分支').value = 'main'; await field('目标分支').onchange();
  expect(field('对新交付开启归并').checked).toBe(true); expect(btn('保存分支归并设置').disabled).toBe(true); expect(editing).toBe(false); expect(actions).toHaveLength(1);
});

test('explicit return to a saved obsolete version follows the visible selection and cannot silently save the newer version', async () => {
  policies[1] = policy('main', { validation: validation(1, false) }); commands.items[0].version = 2;
  await component(); choose(id, 2); choose(id, 1); enable();
  expect(field('最终验证快捷指令').value).toBe(`${id}:1`); expect(btn('保存分支归并设置').disabled).toBe(true);
  await btn('保存分支归并设置').onclick(); expect(actions).toHaveLength(0);
});

test('a successful read retry restores the branch selector after an initial list failure', async () => {
  intercept = path => path.endsWith('/api/branch-convergence') ? fail('offline') : null; await component();
  expect(field('目标分支').disabled).toBe(true); intercept = null; await btn('重新读取分支归并').onclick();
  expect(field('目标分支').disabled).toBe(false); expect(field('目标分支').value).toBe('main');
  field('目标分支').value = 'feature/x'; await field('目标分支').onchange(); expect(deepText(root())).toContain('feature/x · 已保存：关闭');
});

test('Runtime integrated run with passed validation displays exact success, fixed name and landed evidence', async () => {
  runs = [runtimeValidationRun('passed', { state: 'integrated' })]; await component();
  const card = root().querySelector('.convergence-run');
  expect(card.querySelector('.convergence-validation').textContent).toBe('最终验证：固定验证名称 · 通过');
  expect(deepText(card)).toContain('已合并'); expect(deepText(card)).toContain(`落地提交：${'b'.repeat(40)}`);
  expect(deepText(card)).not.toContain('未知状态'); expect(btn('重试归并', card)).toBeUndefined();
  expect(actions).toHaveLength(0);
});

for (const [state, label, runState] of [
  ['failed', '失败', 'failed'], ['blocked', '验证受阻', 'blocked'],
  ['waiting', '等待验证', 'preparing'], ['not_started', '尚未执行', 'preparing'],
]) {
  test(`Runtime validation ${state} is explicit and never mistaken for passing or landing`, async () => {
    runs = [runtimeValidationRun(state, { state: runState })]; await component();
    const card = root().querySelector('.convergence-run'), result = card.querySelector('.convergence-validation');
    expect(result.textContent).toBe(`最终验证：固定验证名称 · ${label}`);
    expect(result.textContent).not.toContain('通过'); expect(deepText(card)).not.toContain('已合并');
    if (['failed', 'blocked'].includes(state)) expect(deepText(card)).toContain('归并未完成，请检查固定来源、授权和执行记录');
    if (state === 'blocked') expect(btn('重试归并', card)).toBeUndefined();
    expect(actions).toHaveLength(0);
  });
}

test('unknown validation values stay explicit even on a landed run, without inferring pass from integration', async () => {
  runs = [runtimeValidationRun('future_validation_state', { state: 'integrated' })]; await component();
  const result = root().querySelector('.convergence-validation');
  expect(result.textContent).toBe('最终验证：固定验证名称 · 未知状态：future_validation_state');
  expect(result.textContent).not.toContain('通过'); expect(actions).toHaveLength(0);
});

test('late Runtime passed history cannot paint success on a different selected branch', async () => {
  const slow = gate(); intercept = path => path.includes('/api/branch-convergence/runs?branch=main') ? slow.promise : null;
  const node = renderBranchConvergence({ catalogue: { commands }, ownsPage: () => own }); root().replaceChildren(node);
  await until(() => reads.some(path => path.includes('/api/branch-convergence/runs?branch=main')));
  field('目标分支').value = 'feature/x'; await field('目标分支').onchange();
  slow.resolve(json({ version: 1, branch: 'main', items: [runtimeValidationRun('passed', { state: 'integrated' })], next_before: null, has_more: false }));
  await node.ready;
  expect(field('目标分支').value).toBe('feature/x'); expect(root().querySelector('.convergence-validation')).toBeNull();
  expect(deepText(root())).not.toContain('固定验证名称'); expect(actions).toHaveLength(0);
});

test('counts come from the complete persistent projection, not displayed batches, and unknown stages stay unknown', async () => {
  policies[1].counts = { ...emptyCounts(), preparing: 25, resolving: 4 }; runs = [run({ state: 'constructor', validation: { state: 'constructor' } })];
  await component(); expect(root().querySelector('.convergence-counts').textContent).toContain('归并中 25 · 整合中 4');
  expect(deepText(root())).toContain('未知阶段：constructor'); expect(deepText(root())).toContain('未知状态：constructor');
  expect(btn('重试归并')).toBeUndefined(); expect(actions).toHaveLength(0);
});
