import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { createRunnerRecoveryWizard } from '../../src/ui/web/assets/runner-recovery-wizard.js';
const INSTALL = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const RID = 'recovery-1', OLD = 'old-recovery';
const clone = value => structuredClone(value);
const button = (root, name) => root.querySelectorAll('button').find(node => node.textContent === name);
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
function recovery(patch = {}) {
  return { id: RID, status: 'planned', created_at: '2026-10-16T09:00:00Z', updated_at: '2026-10-16T09:00:00Z',
    plan: { from_generation: 2, to_generation: 3, boot_changed: true, cgroup: { previous_path: '/sys/fs/cgroup/old-runner', observed_path: '/sys/fs/cgroup/original-runner', changed: true },
      actions: [{ id: 'verify_original', label: '核验原安装新运行能力', privileged: false },
        { id: 'start_original_unit', label: '启动原受管 unit', privileged: true, unit_path: '/etc/systemd/system/lush-runner-1001.service', unit_sha256: 'a'.repeat(64), unit_summary: '只启动原 UID 1001 专属 unit', effect: '启动原 unit，为原安装准备新的受控 cgroup' }],
      blockers: [], supported: true, verification_budgets: { max_commands: 1, timeout_ms: 1000, output_bytes: 4096 }, old_commands: { status: 'stopped', message: '旧命令已确认停止，组为空' } }, stages: [], ...patch };
}
function receipt(patch = {}) {
  return { id: INSTALL, revision: 12, status: 'confirmed', managed: true, ssh_alias: 'original-host', name: '原受管安装', project_id: 'paired-stable', node_id: 'node-original', runner_id: 'installation-original', runtime_generation: 2,
    created_at: '2026-10-16T08:00:00Z', updated_at: '2026-10-16T08:00:00Z', plan: { install_root: '/home/runner/.local/lush-runner', runtime: { version: '1.4', sha256: 'b'.repeat(64) }, runner: { version: '0.2', sha256: 'c'.repeat(64) } },
    stages: [{ id: 'install', status: 'completed', message: '原安装已验证' }], recoveries: [], recoveries_truncated: false, ...patch };
}
function planned(patch = {}) { return receipt({ revision: 13, recoveries: [recovery()], ...patch }); }
function readyReceipt(patch = {}) { return receipt({ revision: 14, runtime_generation: 3, recoveries: [recovery({ status: 'ready', stages: [{ id: 'verify', status: 'completed', message: '新代次验证完成' }] })], ...patch }); }
function fixture(options = {}) {
  const state = { items: [receipt(), receipt({ id: OTHER, name: '另一原安装', runner_id: 'second-installation', node_id: 'second-node' })], truncated: false, changed: 0, ...options.state }, calls = [];
  const methods = { receipts: () => ({ version: 1, items: state.items, truncated: state.truncated }),
    plan: params => { const original = state.items.find(item => item.id === params.id); const next = { ...original, revision: params.expected_revision + 1, recoveries: [...original.recoveries, recovery()] }; state.items = state.items.map(item => item.id === next.id ? next : item); return next; },
    apply: params => { const original = state.items.find(item => item.id === params.id); const next = { ...original, revision: params.expected_revision + 1, runtime_generation: 3,
      recoveries: original.recoveries.map(item => item.id === params.recovery_id ? { ...item, status: 'ready', approved_actions: params.approved_actions, stages: [{ id: 'verify', status: 'completed', message: '新代次验证完成' }] } : item) }; state.items = state.items.map(item => item.id === next.id ? next : item); return next; },
    reconcile: params => { const original = state.items.find(item => item.id === params.id); const next = { ...original, revision: params.expected_revision + 1, runtime_generation: 3,
      recoveries: original.recoveries.map(item => item.id === params.recovery_id ? { ...item, status: 'ready', stages: [{ id: 'verify', status: 'completed', message: '核对同一原操作新代次' }] } : item) }; state.items = state.items.map(item => item.id === next.id ? next : item); return next; }, ...options.methods };
  const adapter = Object.fromEntries(Object.keys(methods).map(method => [method, async (...args) => { calls.push({ method, args: clone(args) }); return clone(await methods[method](...args)); }]));
  const dom = installDom({ fetch: () => { throw new Error('pure UI must never fetch'); } }); dom.node('detail').textContent = 'parent-owned';
  dom.window.addEventListener = globalThis.addEventListener; dom.window.removeEventListener = globalThis.removeEventListener;
  let owned = true;
  const wizard = createRunnerRecoveryWizard({ adapter, ownsPage: () => owned, onChanged: () => { state.changed++; return options.onChanged?.(); } });
  const select = () => wizard.root.querySelector('[data-recovery-field="installation"]');
  const choose = async (id = INSTALL) => { await wizard.ready; select().value = id; await select().onchange(); };
  const check = async () => { await choose(); await button(wizard.root, '检查原安装恢复条件').onclick(); };
  const approve = () => { for (const node of wizard.root.querySelectorAll('input').filter(node => node.dataset.recoveryAction)) { node.checked = true; node.onchange(); } };
  return { state, calls, methods, adapter, dom, wizard, root: wizard.root, select, choose, check, approve, leave() { owned = false; }, close() { wizard.dispose(); dom.restore(); } };
}

test('injected startup is read-only, owns no parent DOM/route, and requires explicit managed selection before checking', async () => {
  const f = fixture();
  try {
    await f.wizard.ready; expect(f.calls.map(item => item.method)).toEqual(['receipts']); expect(f.dom.node('detail').textContent).toBe('parent-owned'); expect(f.dom.location.hash).toBe('');
    expect(button(f.root, '检查原安装恢复条件').disabled).toBe(true); await f.choose(); expect(f.calls).toHaveLength(1);
    expect(button(f.root, '检查原安装恢复条件').disabled).toBe(false);
    for (const value of ['原 Runner 身份：installation-original', '当前已发布代次：2', '不重装、不升级', '不重跑旧命令', 'confirmed 不是恢复成功']) expect(deepText(f.root)).toContain(value);
    expect(f.root.querySelectorAll('button').some(node => node.classList.contains('agent-call'))).toBe(false);
    expect(f.root.querySelectorAll('input')).toHaveLength(0);
  } finally { f.close(); }
});

for (const patch of [{ managed: false }, { managed: undefined }, { status: 'ready' }, { runner_id: null }, { node_id: '' }]) test(`unqualified/manual installation ${JSON.stringify(patch)} cannot be checked or recovered`, async () => {
  const f = fixture({ state: { items: [receipt(patch)] } });
  try {
    await f.choose(); expect(deepText(f.root)).toContain('手动节点不能假定可恢复');
    for (const name of ['检查原安装恢复条件', '确认恢复原安装', '核对原恢复操作']) { expect(button(f.root, name).disabled).toBe(true); await button(f.root, name).onclick(); }
    expect(f.calls.map(item => item.method)).toEqual(['receipts']);
  } finally { f.close(); }
});

test('explicit preview shows original identity, generation, boot, cgroup, stop evidence and each original unit authorization before apply', async () => {
  const f = fixture({ onChanged: () => Promise.reject(new Error('parent refresh failure')) });
  try {
    await f.check(); expect(f.calls.find(item => item.method === 'plan').args).toEqual([{ id: INSTALL, expected_revision: 12 }]);
    const preview = f.root.querySelector('.runner-recovery-preview');
    for (const value of ['2 → 3', 'boot 是否变化：已变化', '/sys/fs/cgroup/old-runner', '/sys/fs/cgroup/original-runner', '旧命令已确认停止', '/etc/systemd/system/lush-runner-1001.service', '启动原 unit，为原安装准备新的受控 cgroup']) expect(deepText(preview)).toContain(value);
    const input = preview.querySelector('input'); expect(input.checked).toBe(false); expect(button(f.root, '确认恢复原安装').disabled).toBe(true);
    const unit = preview.querySelectorAll('details').find(node => deepText(node).includes('unit SHA256')); expect(unit.open === true).toBe(false); expect(deepText(unit)).toContain('a'.repeat(64));
    const budgets = preview.querySelectorAll('details').find(node => deepText(node).includes('验证预算')); expect(budgets.open === true).toBe(false); expect(deepText(budgets)).toContain('验证 timeout_ms：1000');
    f.approve(); expect(button(f.root, '确认恢复原安装').disabled).toBe(false); await button(f.root, '确认恢复原安装').onclick();
    expect(f.calls.find(item => item.method === 'apply').args).toEqual([{ id: INSTALL, expected_revision: 13, recovery_id: RID, approved_actions: ['verify_original', 'start_original_unit'], confirm: true }]);
    expect(deepText(f.root)).toContain('同一恢复操作 ready：新运行能力已恢复'); expect(deepText(f.root)).toContain('不代表旧 Run 已对账'); expect(f.state.changed).toBe(1);
    await button(f.root, '确认恢复原安装').onclick(); expect(f.calls.filter(item => item.method === 'apply')).toHaveLength(1);
    expect(f.root.querySelectorAll('input').every(node => !node.checked)).toBe(true);
  } finally { f.close(); }
});

for (const status of ['running', 'unknown', 'failed', 'blocked']) test(`root confirmed plus recovery ${status} or activated observation never means restored`, async () => {
  const item = recovery({ status, observation: { complete: true, remote_status: 'activated', secret: 'never-show-secret' } });
  const f = fixture({ state: { items: [planned({ recoveries: [item] })] } });
  try {
    await f.choose(); if (!['running', 'unknown'].includes(status)) await button(f.root, '查看此恢复操作').onclick();
    expect(deepText(f.root)).toContain('原安装 confirmed 不是恢复成功'); expect(deepText(f.root)).not.toContain('同一恢复操作 ready：');
    expect(deepText(f.root)).toContain('仅是观测，不是成功、解锁或重试依据'); expect(deepText(f.root)).not.toContain('never-show-secret');
    if (['running', 'unknown'].includes(status)) { expect(deepText(f.root)).toContain('普通连接／新 Worker 保持阻塞'); expect(button(f.root, '检查原安装恢复条件').disabled).toBe(true); }
    expect(f.state.changed).toBe(0); expect(f.calls.map(item => item.method)).toEqual(['receipts']);
  } finally { f.close(); }
});

for (const [name, change, reason] of [
  ['unit path missing', p => { delete p.actions[1].unit_path; }, 'unit 路径'],
  ['unit hash missing', p => { delete p.actions[1].unit_sha256; }, 'SHA256'],
  ['unit hash invalid', p => { p.actions[1].unit_sha256 = 'xyz'; }, 'SHA256'],
  ['unit summary missing', p => { delete p.actions[1].unit_summary; }, '摘要说明'],
  ['unit effect missing', p => { delete p.actions[1].effect; }, '启动后果'],
  ['unit path traversal', p => { p.actions[1].unit_path = '/etc/../bad.service'; }, 'unit 路径'],
  ['missing action set', p => { delete p.actions; }, '动作集合缺失'],
  ['empty action set', p => { p.actions = []; }, '动作集合缺失'],
  ['truncated action set', p => { p.actions_truncated = true; }, '动作集合已截断'],
  ['duplicate action ID', p => { p.actions.push(clone(p.actions[1])); }, '动作 ID 重复'],
  ['unknown privileged action', p => { p.actions[1].id = 'install_new_unit'; }, '只允许逐项启动原安装 unit'],
  ['sudo disguised nonprivileged', p => { p.actions[1].privileged = false; }, '必须逐项授予特权'],
  ['Git install action', p => { p.actions[0].id = 'git_install'; }, '不允许新增系统安装动作'],
  ['unknown action ID', p => { p.actions[0].id = '../unknown'; }, '动作 ID'],
  ['duplicate unit', p => { p.actions.push({ ...p.actions[1], id: 'second_unit' }); }, '同一 unit 路径重复'],
  ['unsupported permission', p => { p.supported = false; }, '环境或权限未确认支持'],
  ['old commands unknown', p => { p.old_commands.status = 'unknown'; }, '停止证据不足'],
  ['old commands running', p => { p.old_commands.status = 'running'; }, '停止证据不足'],
  ['old commands observed only', p => { p.old_commands = { status: 'complete', message: 'observed only' }; }, '停止证据不足'],
  ['old commands absent', p => { delete p.old_commands; }, '停止证据不足'],
  ['stop message missing', p => { delete p.old_commands.message; }, '停止证据不足'],
  ['missing boot evidence', p => { delete p.boot_changed; }, 'boot 变化未确认'],
  ['missing cgroup evidence', p => { delete p.cgroup.observed_path; }, 'cgroup 原路径'],
  ['unknown cgroup change', p => { delete p.cgroup.changed; }, '变化状态未确认'],
  ['empty previous cgroup path', p => { p.cgroup.previous_path = ''; }, 'cgroup 原路径'],
  ['empty observed cgroup path', p => { p.cgroup.observed_path = ' '; }, '观测路径'],
  ['invalid next generation', p => { p.to_generation = p.from_generation; }, '拟新代次缺失或无效'],
]) test(`unsafe/incomplete recovery plan ${name} stays visible but cannot submit`, async () => {
  const model = planned(); change(model.recoveries[0].plan);
  // Generation shape is blocked by the plan ACK guard itself, not silently accepted as a recovery.
  const f = fixture({ methods: { plan: () => model } });
  try {
    await f.check();
    if (name !== 'invalid next generation') { expect(deepText(f.root)).toContain('恢复 ID：recovery-1'); expect(deepText(f.root)).toContain(reason); }
    else expect(deepText(f.root)).toContain('检查结果未确认');
    f.approve(); expect(button(f.root, '确认恢复原安装').disabled).toBe(true); await button(f.root, '确认恢复原安装').onclick();
    expect(f.calls.some(item => item.method === 'apply')).toBe(false);
    for (const node of f.root.querySelectorAll('input').filter(node => node.disabled)) expect(node.parentNode.dataset.help).toBeTruthy();
  } finally { f.close(); }
});

test('unchanged boot/cgroup and no privileged action do not invent a restart or automatic approval', async () => {
  const model = planned(), p = model.recoveries[0].plan; p.boot_changed = false; p.cgroup.changed = false; p.cgroup.observed_path = p.cgroup.previous_path;
  const f = fixture({ methods: { plan: () => model } });
  try { await f.check(); expect(deepText(f.root)).toContain('boot 是否变化：未变化'); expect(deepText(f.root)).toContain('变化：否'); expect(f.root.querySelector('input').checked).toBe(false); expect(button(f.root, '确认恢复原安装').disabled).toBe(true); }
  finally { f.close(); }
});

test('backend blockers remain outside advanced summaries and prevent submission even with supported metadata', async () => {
  const model = planned(); model.recoveries[0].status = 'blocked'; model.recoveries[0].plan.blockers = [{ code: 'permission_denied', message: '没有启动原unit权限' }];
  const f = fixture({ methods: { plan: () => model } });
  try { await f.check(); const line = f.root.querySelector('.runner-recovery-preview').querySelectorAll('p').find(node => node.textContent.includes('没有启动原unit权限')); expect(line.parentNode.className).toBe('runner-recovery-preview'); f.approve(); expect(button(f.root, '确认恢复原安装').disabled).toBe(true); }
  finally { f.close(); }
});

for (const [name, change] of [
  ['false ACK', () => ({ ok: true })],
  ['wrong installation ID', value => { value.id = OTHER; }],
  ['old revision', value => { value.revision = 13; }],
  ['different runner', value => { value.runner_id = 'replacement'; }],
  ['different node', value => { value.node_id = 'replacement'; }],
  ['different project', value => { value.project_id = 'replacement'; }],
  ['different SSH target', value => { value.ssh_alias = 'replacement'; }],
  ['changed install plan', value => { value.plan.runtime.version = 'upgraded'; }],
  ['changed credentials', value => { value.credentials = { machine_token: 'never-show-secret' }; }],
  ['changed root status', value => { value.status = 'ready'; }],
  ['changed recovery plan', value => { value.recoveries[0].plan.actions[1].effect = 'replace unit'; }],
  ['wrong recovery ID', value => { value.recoveries[0].id = 'replacement'; }],
  ['missing recovery ID', value => { value.recoveries = []; }],
  ['wrong generation', value => { value.runtime_generation = 4; }],
  ['unpublished generation', value => { value.runtime_generation = 2; }],
  ['changed from generation', value => { value.recoveries[0].plan.from_generation = 1; }],
  ['changed approved set', value => { value.recoveries[0].approved_actions = ['start_original_unit']; }],
  ['duplicate approved set', value => { value.recoveries[0].approved_actions = ['verify_original', 'start_original_unit', 'start_original_unit']; }],
  ['unknown approved ID', value => { value.recoveries[0].approved_actions = ['verify_original', 'unknown']; }],
]) test(`apply ${name} cannot change original evidence or unlock another installation`, async () => {
  const model = readyReceipt(); const replacement = change(model);
  const f = fixture({ methods: { apply: () => replacement || model } });
  try {
    await f.check(); f.approve(); await button(f.root, '确认恢复原安装').onclick();
    expect(deepText(f.root)).toContain('恢复结果未确认'); expect(deepText(f.root)).not.toContain('never-show-secret'); expect(deepText(f.root)).not.toContain('同一恢复操作 ready：');
    expect(button(f.root, '确认恢复原安装').disabled).toBe(true); expect(button(f.root, '检查原安装恢复条件').disabled).toBe(true);
    await f.choose(OTHER); expect(f.select().value).toBe(INSTALL);
    await button(f.root, '确认恢复原安装').onclick(); await button(f.root, '检查原安装恢复条件').onclick();
    expect(f.calls.filter(item => item.method === 'apply')).toHaveLength(1); expect(f.calls.filter(item => item.method === 'plan')).toHaveLength(1); expect(f.state.changed).toBe(0);
    expect(f.root.querySelectorAll('input').every(node => !node.checked)).toBe(true);
    await button(f.root, '核对原恢复操作').onclick(); expect(f.calls.find(item => item.method === 'reconcile').args).toEqual([{ id: INSTALL, expected_revision: 13, recovery_id: RID }]);
    expect(deepText(f.root)).toContain('同一恢复操作 ready：');
  } finally { f.close(); }
});

for (const [name, change] of [
  ['original ID', value => { value.id = OTHER; }],
  ['original plan', value => { value.plan.runner.version = 'replacement'; }],
  ['original identity', value => { value.runner_id = 'replacement'; }],
  ['original credentials', value => { value.credentials = { token: 'never-show-token' }; }],
  ['stale revision', value => { value.revision = 12; }],
  ['no new recovery', value => { value.recoveries = []; }],
  ['two new recoveries', value => { value.recoveries.push(recovery({ id: 'second-new' })); }],
  ['changed runtime', value => { value.runtime_generation = 3; }],
  ['wrong from generation', value => { value.recoveries[0].plan.from_generation = 1; }],
  ['running plan ACK', value => { value.recoveries[0].status = 'running'; }],
]) test(`plan ACK cannot replace ${name} or silently establish a different request`, async () => {
  const model = planned(); change(model);
  const f = fixture({ methods: { plan: () => model } });
  try {
    await f.check(); expect(deepText(f.root)).toContain('检查结果未确认'); expect(button(f.root, '检查原安装恢复条件').disabled).toBe(true);
    expect(button(f.root, '核对原恢复操作').disabled).toBe(true); await f.choose(OTHER); expect(f.select().value).toBe(INSTALL);
    expect(deepText(f.root)).not.toContain('never-show-token'); expect(f.calls.filter(item => item.method === 'plan')).toHaveLength(1);
    f.state.items = [planned()]; await button(f.root, '刷新恢复收据').onclick();
    expect(deepText(f.root)).toContain('已找到原未知请求的新恢复操作'); expect(f.root.querySelector('input').checked).toBe(false);
  } finally { f.close(); }
});

test('a selected installation disappearing before any check blocks instead of reusing a stale roster entry', async () => {
  const f = fixture();
  try {
    await f.choose(); f.state.items = []; await button(f.root, '刷新恢复收据').onclick();
    expect(button(f.root, '检查原安装恢复条件').disabled).toBe(true); expect(deepText(f.root)).toContain('缺记录不代表未执行');
    await button(f.root, '检查原安装恢复条件').onclick(); expect(f.calls.some(item => item.method === 'plan')).toBe(false);
  } finally { f.close(); }
});

for (const [name, patch] of [
  ['historic generation', { runtime_generation: 4 }],
  ['unqualified installation', { managed: false }],
  ['invalid frozen evidence', {}],
]) test(`restored historical ready with ${name} is not current runtime success`, async () => {
  const model = readyReceipt(patch); if (name === 'invalid frozen evidence') model.recoveries[0].plan.old_commands.status = 'unknown';
  const f = fixture({ state: { items: [model] } });
  try {
    await f.choose(); await button(f.root, '查看此恢复操作').onclick(); expect(deepText(f.root)).not.toContain('同一恢复操作 ready：');
    expect(deepText(f.root)).toContain('ready 证据未确认'); expect(f.state.changed).toBe(0);
  } finally { f.close(); }
});

test('valid historical ready can be viewed without triggering checks, applies or callbacks', async () => {
  const f = fixture({ state: { items: [readyReceipt()] } });
  try { await f.choose(); await button(f.root, '查看此恢复操作').onclick(); expect(deepText(f.root)).toContain('同一恢复操作 ready：'); expect(f.calls.map(item => item.method)).toEqual(['receipts']); expect(f.state.changed).toBe(0); }
  finally { f.close(); }
});

test('nonprivileged recovery needs explicit total confirmation but no automatic sudo authorization', async () => {
  const model = planned(); model.recoveries[0].plan.actions = model.recoveries[0].plan.actions.filter(item => !item.privileged);
  const f = fixture({ methods: { plan: () => model, apply: params => ({ ...model, revision: 14, runtime_generation: 3, recoveries: [{ ...model.recoveries[0], status: 'ready', approved_actions: params.approved_actions }] }) } });
  try {
    await f.check(); expect(f.root.querySelectorAll('input')).toHaveLength(0); expect(f.calls.some(item => item.method === 'apply')).toBe(false);
    expect(button(f.root, '确认恢复原安装').disabled).toBe(false); await button(f.root, '确认恢复原安装').onclick();
    expect(f.calls.find(item => item.method === 'apply').args[0].approved_actions).toEqual(['verify_original']); expect(f.state.changed).toBe(1);
  } finally { f.close(); }
});

test('recovery text remains textContent even in action effects, no unit body/argv/credentials/unknown fields are shown', async () => {
  const model = planned(), action = model.recoveries[0].plan.actions[1]; action.effect = '<img src=x onerror=alert(1)> 原unit启动';
  action.argv = ['never-show-argv']; action.unit_body = 'never-show-unit-body'; action.credentials = 'never-show-secret';
  const f = fixture({ methods: { plan: () => model } });
  try { await f.check(); expect(deepText(f.root)).toContain('<img src=x onerror=alert(1)>'); expect(f.root.querySelector('img')).toBeNull(); expect(deepText(f.root)).not.toContain('never-show-'); }
  finally { f.close(); }
});

test('lost apply ACK holds original operation through absent/stale reads, uses no polling and reconciles once without replay', async () => {
  const f = fixture({ methods: { apply: () => { throw new Error('private transport'); } } });
  try {
    await f.check(); f.approve(); await button(f.root, '确认恢复原安装').onclick(); expect(f.calls.filter(item => item.method === 'receipts')).toHaveLength(1);
    await button(f.root, '刷新恢复收据').onclick(); expect(deepText(f.root)).toContain('不能重复检查或换安装绕过');
    f.state.items = []; await button(f.root, '刷新恢复收据').onclick(); expect(deepText(f.root)).toContain('缺记录不代表未执行');
    expect(f.root.querySelectorAll('input').every(node => !node.checked)).toBe(true); expect(f.select().disabled).toBe(true);
    f.state.items = [planned()]; await button(f.root, '核对原恢复操作').onclick(); expect(deepText(f.root)).toContain('新运行能力已恢复'); expect(f.state.changed).toBe(1);
    expect(f.calls.filter(item => item.method === 'apply')).toHaveLength(1); expect(deepText(f.root)).not.toContain('private transport');
  } finally { f.close(); }
});

test('lost plan ACK cannot use old same-target history, missing records, ambiguous additions or unchanged revisions as a substitute', async () => {
  const original = receipt({ recoveries: [recovery({ id: OLD, status: 'failed' })] });
  const f = fixture({ state: { items: [original] }, methods: { plan: () => { throw new Error('lost plan'); } } });
  try {
    await f.check(); expect(deepText(f.root)).toContain('检查结果未确认'); expect(button(f.root, '核对原恢复操作').disabled).toBe(true);
    await button(f.root, '查看此恢复操作').onclick(); expect(deepText(f.root)).toContain('不能用其他历史操作替代');
    for (const next of [original, { ...original, revision: 13 }, { ...original, revision: 13, recoveries: [] }, { ...original, revision: 13, recoveries: [...original.recoveries, recovery(), recovery({ id: 'second-new' })] }]) {
      f.state.items = [next]; await button(f.root, '刷新恢复收据').onclick(); expect(button(f.root, '检查原安装恢复条件').disabled).toBe(true);
      expect(button(f.root, '核对原恢复操作').disabled).toBe(true);
    }
    f.state.items = [{ ...original, revision: 13, recoveries: [...original.recoveries, recovery()] }];
    await button(f.root, '刷新恢复收据').onclick(); expect(deepText(f.root)).toContain('已找到原未知请求的新恢复操作');
    expect(button(f.root, '核对原恢复操作').disabled).toBe(false); expect(f.root.querySelector('input').checked).toBe(false);
    expect(f.calls.filter(item => item.method === 'plan')).toHaveLength(1); expect(f.calls.some(item => item.method === 'apply')).toBe(false);
  } finally { f.close(); }
});

for (const kind of ['global', 'recovery']) test(`${kind} truncated history remains explicit and cannot justify new plan/apply`, async () => {
  const f = fixture({ state: { truncated: kind === 'global', items: [planned({ recoveries_truncated: kind === 'recovery' })] } });
  try {
    await f.choose(); await button(f.root, '查看此恢复操作').onclick(); expect(deepText(f.root)).toContain('已截断');
    expect(f.root.querySelector('.runner-recovery-history-status').parentNode).toBe(f.root);
    f.approve(); expect(button(f.root, '检查原安装恢复条件').disabled).toBe(true); expect(button(f.root, '确认恢复原安装').disabled).toBe(true);
    expect(button(f.root, '核对原恢复操作').disabled).toBe(false); expect(f.calls.map(item => item.method)).toEqual(['receipts']);
  } finally { f.close(); }
});

test('unknown history automatically selects original operation, blocks new plans across nodes, does not confuse failed history with success', async () => {
  const original = planned({ recoveries: [recovery({ status: 'unknown' }), recovery({ id: OLD, status: 'failed' })] });
  const f = fixture({ state: { items: [receipt({ id: OTHER }), original] } });
  try {
    await f.wizard.ready; expect(f.select().value).toBe(INSTALL); expect(button(f.root, '检查原安装恢复条件').disabled).toBe(true);
    await f.choose(OTHER); expect(f.select().value).toBe(INSTALL);
    const histories = f.root.querySelectorAll('button').filter(node => node.textContent === '查看此恢复操作'); await histories[1].onclick(); expect(deepText(f.root)).toContain('不能用其他历史操作替代');
    expect(f.calls.map(item => item.method)).toEqual(['receipts']); await button(f.root, '核对原恢复操作').onclick();
    expect(deepText(f.root)).toContain('同一恢复操作 ready：');
  } finally { f.close(); }
});

for (const method of ['refresh', 'reconcile']) test(`${method} rejects higher-revision changes to frozen plans and root installation evidence`, async () => {
  const f = fixture({ methods: { apply: () => planned({ revision: 14, recoveries: [recovery({ status: 'running' })] }) } });
  try {
    await f.check(); f.approve(); await button(f.root, '确认恢复原安装').onclick();
    const changed = readyReceipt({ revision: 15 }); changed.recoveries[0].plan.actions[1].unit_sha256 = 'f'.repeat(64);
    if (method === 'refresh') f.state.items = [changed]; else f.methods.reconcile = () => changed;
    await button(f.root, method === 'refresh' ? '刷新恢复收据' : '核对原恢复操作').onclick();
    expect(deepText(f.root)).not.toContain('同一恢复操作 ready：'); expect(button(f.root, '检查原安装恢复条件').disabled).toBe(true); expect(f.state.changed).toBe(0);
  } finally { f.close(); }
});

test('same-revision reads accept reordered keys, reject changed evidence and never render unknown secrets/scripts/URLs', async () => {
  const model = planned(); model.credentials = { machine_token: 'never-show-machine' }; model.plan.script = 'never-show-script';
  model.recoveries[0].plan.actions[1].unit_body = 'never-show-body'; model.recoveries[0].plan.repository_url = 'never-show-repository';
  const f = fixture({ state: { items: [model] } });
  try {
    await f.choose(); await button(f.root, '查看此恢复操作').onclick(); expect(deepText(f.root)).not.toContain('never-show-');
    f.state.items = [Object.fromEntries(Object.entries(model).reverse())]; await button(f.root, '刷新恢复收据').onclick(); expect(button(f.root, '确认恢复原安装').disabled).toBe(true);
    const changed = clone(model); changed.recoveries[0].stages = [{ id: 'verify', status: 'completed', message: 'changed without revision' }]; f.state.items = [changed];
    await button(f.root, '刷新恢复收据').onclick(); expect(deepText(f.root)).toContain('修订／身份不一致'); expect(button(f.root, '检查原安装恢复条件').disabled).toBe(true);
  } finally { f.close(); }
});

for (const advance of [0, 1]) test(`independent root/recovery observations and update times may change with revision +${advance} without granting sudo`, async () => {
  const model = planned({ observation: { complete: false, checked_at: 'old', private: 'never-show-root-secret' } });
  model.recoveries[0].observation = { complete: false, remote_status: 'unknown' };
  const f = fixture({ state: { items: [model] } });
  try {
    await f.choose(); await button(f.root, '查看此恢复操作').onclick(); f.approve();
    const observed = clone(model); observed.revision += advance; observed.updated_at = 'new-root-read-time';
    observed.observation = { complete: true, remote_status: 'activated', checked_at: 'new', private: 'never-show-new-secret' };
    observed.recoveries[0].updated_at = 'new-recovery-read-time'; observed.recoveries[0].observation = { complete: true, remote_status: 'activated' };
    f.state.items = [observed]; await button(f.root, '刷新恢复收据').onclick();
    expect(deepText(f.root)).not.toContain('修订／身份不一致'); expect(deepText(f.root)).not.toContain('同一恢复操作 ready：');
    expect(deepText(f.root)).not.toContain('never-show-'); expect(f.root.querySelector('input').checked).toBe(false);
    expect(button(f.root, '确认恢复原安装').disabled).toBe(true); expect(f.state.changed).toBe(0);
    f.approve(); expect(button(f.root, '确认恢复原安装').disabled).toBe(false);
  } finally { f.close(); }
});

for (const method of ['apply', 'reconcile']) test(`valid ${method} ACK tolerates independent root observations while preserving identity and completion evidence`, async () => {
  const f = fixture();
  try {
    await f.check(); const result = readyReceipt({ observation: { complete: true, remote_status: 'activated', checked_at: 'latest', private: 'never-show-secret' } });
    result.recoveries[0].observation = { complete: true, remote_status: 'activated' }; result.recoveries[0].updated_at = 'latest';
    f.methods[method] = () => result;
    if (method === 'apply') f.approve();
    await button(f.root, method === 'apply' ? '确认恢复原安装' : '核对原恢复操作').onclick();
    expect(deepText(f.root)).toContain('同一恢复操作 ready：'); expect(deepText(f.root)).not.toContain('never-show-secret'); expect(f.state.changed).toBe(1);
  } finally { f.close(); }
});

for (const recoveryStatus of ['running', 'unknown']) test(`observation-only activated reads cannot complete or unlock ${recoveryStatus} recovery`, async () => {
  const original = planned({ recoveries: [recovery({ status: recoveryStatus })] });
  const f = fixture({ state: { items: [original] } });
  try {
    await f.wizard.ready; const observed = clone(original); observed.observation = { complete: true, remote_status: 'activated' };
    observed.recoveries[0].observation = { complete: true, remote_status: 'activated' }; f.state.items = [observed];
    await button(f.root, '刷新恢复收据').onclick();
    expect(deepText(f.root)).toContain('普通连接／新 Worker 保持阻塞'); expect(deepText(f.root)).not.toContain('同一恢复操作 ready：');
    expect(button(f.root, '检查原安装恢复条件').disabled).toBe(true); expect(button(f.root, '确认恢复原安装').disabled).toBe(true);
    await f.choose(OTHER); expect(f.select().value).toBe(INSTALL); expect(f.state.changed).toBe(0);
  } finally { f.close(); }
});

test('an uncertain reconcile cannot be resolved by observation/time/revision-only changes, but real ready evidence can resolve it', async () => {
  const f = fixture({ methods: { reconcile: () => { throw new Error('lost original reconcile ACK'); } } });
  try {
    await f.check(); await button(f.root, '核对原恢复操作').onclick(); expect(button(f.root, '检查原安装恢复条件').disabled).toBe(true);
    const observed = planned({ revision: 14, updated_at: 'new', observation: { complete: true, remote_status: 'activated' } });
    observed.recoveries[0].updated_at = 'new'; observed.recoveries[0].observation = { complete: true, remote_status: 'activated' };
    f.state.items = [observed]; await button(f.root, '刷新恢复收据').onclick();
    expect(deepText(f.root)).toContain('普通连接／新 Worker 保持阻塞'); expect(button(f.root, '确认恢复原安装').disabled).toBe(true);
    expect(f.root.querySelector('input').checked).toBe(false); await f.choose(OTHER); expect(f.select().value).toBe(INSTALL);
    f.methods.reconcile = () => readyReceipt({ revision: 15, observation: { complete: true } });
    await button(f.root, '核对原恢复操作').onclick(); expect(deepText(f.root)).toContain('同一恢复操作 ready：'); expect(f.state.changed).toBe(1);
  } finally { f.close(); }
});

test('updates to unrelated recovery history cannot resolve uncertainty for the selected original operation', async () => {
  const original = receipt({ recoveries: [recovery({ id: OLD, status: 'failed' })] });
  const f = fixture({ state: { items: [original] }, methods: { reconcile: () => { throw new Error('lost reconcile'); } } });
  try {
    await f.check(); await button(f.root, '核对原恢复操作').onclick();
    const updated = clone(f.state.items[0]); updated.revision++;
    updated.recoveries[0].stages.push({ id: 'old-check', status: 'completed', message: 'unrelated record update' });
    updated.observation = { complete: true, remote_status: 'activated' }; f.state.items = [updated];
    await button(f.root, '刷新恢复收据').onclick(); expect(button(f.root, '确认恢复原安装').disabled).toBe(true);
    expect(deepText(f.root)).toContain('普通连接／新 Worker 保持阻塞'); expect(f.state.changed).toBe(0);
  } finally { f.close(); }
});

for (const kind of ['plan', 'apply']) test(`lost ${kind} ACK stays locked despite activated observation and revision progress`, async () => {
  const f = fixture({ methods: { [kind]: () => { throw new Error('lost ACK'); } } });
  try {
    if (kind === 'plan') await f.check(); else { await f.check(); f.approve(); await button(f.root, '确认恢复原安装').onclick(); }
    const observed = kind === 'plan' ? receipt({ revision: 13 }) : planned({ revision: 14 });
    observed.observation = { complete: true, remote_status: 'activated' }; f.state.items = [observed];
    await button(f.root, '刷新恢复收据').onclick(); expect(button(f.root, '检查原安装恢复条件').disabled).toBe(true);
    expect(button(f.root, '确认恢复原安装').disabled).toBe(true); expect(f.state.changed).toBe(0);
    await f.choose(OTHER); expect(f.select().value).toBe(INSTALL);
  } finally { f.close(); }
});

for (const kind of ['installation', 'recovery']) test(`observation fields inside frozen ${kind} plans are not independent read data`, async () => {
  const model = planned(); (kind === 'installation' ? model.plan : model.recoveries[0].plan).observation = { effect: 'original' };
  const f = fixture({ state: { items: [model] } });
  try {
    await f.choose(); await button(f.root, '查看此恢复操作').onclick(); const changed = clone(model); changed.revision++;
    (kind === 'installation' ? changed.plan : changed.recoveries[0].plan).observation.effect = 'replacement'; f.state.items = [changed];
    await button(f.root, '刷新恢复收据').onclick(); expect(deepText(f.root)).toContain('修订／身份不一致'); expect(button(f.root, '确认恢复原安装').disabled).toBe(true);
  } finally { f.close(); }
});

for (const kind of ['omitted', 'tampered']) test(`independent observations never permit ${kind} managed qualification`, async () => {
  const f = fixture();
  try {
    await f.check(); const changed = readyReceipt({ observation: { complete: true, remote_status: 'activated' } });
    if (kind === 'omitted') delete changed.managed; else changed.managed = false;
    f.methods.apply = () => changed; f.approve(); await button(f.root, '确认恢复原安装').onclick();
    expect(deepText(f.root)).toContain('恢复结果未确认'); expect(deepText(f.root)).not.toContain('同一恢复操作 ready：'); expect(f.state.changed).toBe(0);
  } finally { f.close(); }
});

test('an external ready publication is accepted only with one corresponding recovery and unchanged original evidence', async () => {
  const f = fixture();
  try {
    await f.choose(); f.state.items = [readyReceipt()]; await button(f.root, '刷新恢复收据').onclick();
    expect(deepText(f.root)).toContain('当前已发布代次：3'); expect(deepText(f.root)).not.toContain('同一恢复操作 ready：');
    await button(f.root, '查看此恢复操作').onclick(); expect(deepText(f.root)).toContain('同一恢复操作 ready：');
    expect(f.calls.some(item => item.method !== 'receipts')).toBe(false);
  } finally { f.close(); }
});

test('runtime generation cannot advance on activated-only observation without ready evidence', async () => {
  const f = fixture();
  try {
    await f.choose(); f.state.items = [readyReceipt({ recoveries: [recovery({ status: 'unknown', observation: { complete: true, remote_status: 'activated' } })] })];
    await button(f.root, '刷新恢复收据').onclick(); expect(deepText(f.root)).toContain('当前已发布代次：2'); expect(deepText(f.root)).not.toContain('同一恢复操作 ready：');
    expect(button(f.root, '检查原安装恢复条件').disabled).toBe(true);
  } finally { f.close(); }
});

test('running recovery advances only by explicit read of same ID and matching generation, onChanged fires on ready evidence', async () => {
  const f = fixture({ methods: { apply: () => planned({ revision: 14, recoveries: [recovery({ status: 'running' })] }) } });
  try {
    await f.check(); f.approve(); await button(f.root, '确认恢复原安装').onclick(); expect(f.calls.filter(item => item.method === 'receipts')).toHaveLength(1);
    f.state.items = [readyReceipt({ revision: 15 })]; await button(f.root, '刷新恢复收据').onclick();
    expect(deepText(f.root)).toContain('同一恢复操作 ready：'); expect(f.state.changed).toBe(1);
    await button(f.root, '刷新恢复收据').onclick(); expect(f.state.changed).toBe(1); expect(f.calls.filter(item => item.method === 'apply')).toHaveLength(1);
  } finally { f.close(); }
});

test('single-flight, disabled help hosts, unknown IDs and detached old checkboxes cannot authorize a fresh plan', async () => {
  const wait = deferred(), f = fixture({ methods: { plan: () => wait.promise } });
  try {
    await f.choose(); const pending = button(f.root, '检查原安装恢复条件').onclick(); await button(f.root, '检查原安装恢复条件').onclick();
    for (const node of [...f.root.querySelectorAll('button'), f.select()].filter(node => node.disabled)) expect(node.parentNode.dataset.help).toBeTruthy();
    expect(f.calls.filter(item => item.method === 'plan')).toHaveLength(1); wait.resolve(planned()); await pending;
    const old = f.root.querySelector('input'); old.dataset.recoveryAction = 'unknown'; old.checked = true; old.onchange();
    expect(deepText(f.root)).toContain('不能提交未知动作'); expect(button(f.root, '确认恢复原安装').disabled).toBe(true);
    old.dataset.recoveryAction = 'start_original_unit'; old.checked = true; old.onchange(); expect(button(f.root, '确认恢复原安装').disabled).toBe(true);
    const fresh = f.root.querySelector('input'); fresh.checked = true; fresh.onchange(); expect(button(f.root, '确认恢复原安装').disabled).toBe(false);
  } finally { f.close(); }
});

for (const method of ['receipts', 'plan', 'apply', 'reconcile']) test(`late ${method} after dispose/ownership loss cannot repaint or notify`, async () => {
  const f = fixture(); const slow = deferred();
  try {
    await f.wizard.ready;
    let pending;
    if (method === 'receipts') { f.methods.receipts = () => slow.promise; pending = button(f.root, '刷新恢复收据').onclick(); }
    else if (method === 'plan') { await f.choose(); f.methods.plan = () => slow.promise; pending = button(f.root, '检查原安装恢复条件').onclick(); }
    else { await f.check(); f.approve(); f.methods[method] = () => slow.promise; pending = button(f.root, method === 'apply' ? '确认恢复原安装' : '核对原恢复操作').onclick(); }
    f.leave(); f.wizard.dispose(); const before = deepText(f.root); slow.resolve(method === 'receipts' ? { version: 1, items: [readyReceipt()], truncated: false } : method === 'plan' ? planned() : readyReceipt()); await pending;
    expect(deepText(f.root)).toBe(before); expect(f.state.changed).toBe(0); expect(f.dom.node('detail').textContent).toBe('parent-owned');
  } finally { f.close(); }
});

test('pagehide disposes once and late apply stays silent; mounting history failure recovers through explicit refresh only', async () => {
  const f = fixture({ methods: { receipts: () => { throw new Error('private roster'); } } });
  try {
    await f.wizard.ready; expect(deepText(f.root)).not.toContain('private roster'); expect(button(f.root, '检查原安装恢复条件').disabled).toBe(true);
    f.methods.receipts = () => ({ version: 1, items: [receipt()], truncated: false }); await button(f.root, '刷新恢复收据').onclick(); await f.choose();
    expect(button(f.root, '检查原安装恢复条件').disabled).toBe(false);
    const slow = deferred(); await button(f.root, '检查原安装恢复条件').onclick(); f.approve(); f.methods.apply = () => slow.promise;
    const pending = button(f.root, '确认恢复原安装').onclick(); await f.dom.fire('pagehide'); const before = deepText(f.root); slow.resolve(readyReceipt()); await pending;
    expect(deepText(f.root)).toBe(before); expect(f.state.changed).toBe(0);
  } finally { f.close(); }
});

test('scoped vertical/narrow UI, shared sudo rules and browser bundle contain no backend/API/network coupling', async () => {
  const source = await Bun.file(new URL('../../src/ui/web/assets/runner-recovery-wizard.js', import.meta.url)).text();
  expect(source).not.toMatch(/\bfetch\s*\(|\/api\/|settings-api|render-runners|from ['"].*backend/);
  expect(source).toContain("from './runner-action-preview.js'");
  const deploy = await Bun.file(new URL('../../src/ui/web/assets/runner-deploy-wizard.js', import.meta.url)).text(); expect(deploy).toContain("from './runner-action-preview.js'"); expect(deploy).not.toContain('function planIssues');
  const css = await Bun.file(new URL('../../src/ui/web/assets/styles-runner-recovery.css', import.meta.url)).text();
  expect(css).toContain('@media(max-width:600px)'); expect(css).toContain('flex-direction:column'); expect(css).toContain('min-height:44px'); expect(css).not.toMatch(/overflow:\s*hidden|max-height/);
  const styles = await Bun.file(new URL('../../src/ui/web/assets/styles.css', import.meta.url)).text(); expect(styles).not.toContain('styles-runner-recovery.css');
  expect(() => createRunnerRecoveryWizard({ adapter: {} })).toThrow('adapter.receipts');
  const build = await Bun.build({ entrypoints: [new URL('../../src/ui/web/assets/runner-recovery-wizard.js', import.meta.url).pathname], target: 'browser', write: false }); expect(build.success).toBe(true); expect(build.outputs).toHaveLength(1);
});
