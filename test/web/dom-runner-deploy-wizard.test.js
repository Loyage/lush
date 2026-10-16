import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { createRunnerDeployWizard } from '../../src/ui/web/assets/runner-deploy-wizard.js';
const HOST = 'aaaaaaaaaaaaaaaa', OTHER = 'bbbbbbbbbbbbbbbb';
const ID = '11111111-1111-4111-8111-111111111111', ID2 = '22222222-2222-4222-8222-222222222222';
const clone = value => structuredClone(value);
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const field = (root, key) => root.querySelector(`[data-deploy-field="${key}"]`);
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
function receipt(patch = {}) {
  return { id: ID, revision: 1, status: 'planned', ssh_alias: 'lab', name: 'Lab', project_id: 'paired-stable', created_at: '2026-10-16T00:00:00Z', updated_at: '2026-10-16T00:00:00Z',
    plan: { target: { os: 'linux', arch: 'x64', user: 'remote-user', uid: 1001, home: '/home/remote-user' }, install_root: '/home/remote-user/.local/lush-runner',
      runtime: { version: '1.4', source: 'central-verified-upload', sha256: 'a'.repeat(64), size: 12 }, runner: { version: '0.2', sha256: 'b'.repeat(64), size: 34 },
      files: ['/home/remote-user/.local/bin/lush-runner', '/home/remote-user/.local/lush-runner/runtime'],
      actions: [{ id: 'upload', label: '上传中央校验安装包', privileged: false },
        { id: 'cgroup', label: '创建专用 cgroup 子树', privileged: true, unit_path: '/etc/systemd/system/lush-cgroup-1001.service', unit_sha256: 'c'.repeat(64), unit_summary: '仅为 UID 1001 准备专属子树', effect: '启动后创建 Runner 专属 cgroup 并授予指定账户控制' },
        { id: 'git_install', label: '安装 Git 及固定依赖', privileged: true, unit_path: '/etc/systemd/system/lush-git-1001.service', unit_sha256: 'd'.repeat(64), unit_summary: '仅安装本次列出的固定版本包', effect: '启动后安装 Git 与下列全部依赖包', packages_truncated: false,
          packages: [{ name: 'git', version: '1:2.43.0-1ubuntu7.3', operation: 'install' }, { name: 'git-man', version: '1:2.43.0-1ubuntu7.3', operation: 'install' }, { name: 'liberror-perl', version: '0.17029-2', operation: 'install' }] }], blockers: [], supported: true }, stages: [], ...patch };
}
function changedAck(change) { const value = receipt({ revision: 2, status: 'ready' }); change(value); return value; }
function fixture(options = {}) {
  const calls = [], state = { policy: { revision: 1, project_id: 'paired-stable', allowed_node_ids: [], default_node_id: 'local' },
    projects: [{ id: HOST, name: '来源 Alpha', running: true }, { id: OTHER, name: '离线 Beta', running: false }], history: [], truncated: false, changed: 0, ...options.state };
  const methods = {
    discover: () => ({ aliases: ['lab', { alias: 'second-host' }], status: 'ok', limited: true }),
    projects: () => ({ projects: state.projects }), project: () => state.policy,
    initializeProject: () => (state.policy = { ...state.policy, revision: state.policy.revision + 1, project_id: 'new-stable' }),
    plan: target => receipt(target),
    apply: params => { const next = receipt({ revision: params.expected_revision + 1, status: 'ready', runner_id: 'installation-1', node_id: 'node-1', stages: [{ id: 'upload', status: 'completed', message: '中央校验上传完成' }, { id: 'controlled-stop', status: 'completed', message: '受控执行组已空' }] }); state.history = [next]; return next; },
    receipts: () => ({ version: 1, items: state.history, truncated: state.truncated }),
    reconcile: params => receipt({ revision: params.expected_revision + 1, status: 'ready', runner_id: 'installation-1', node_id: 'node-1' }),
    confirm: params => receipt({ revision: params.expected_revision + 1, status: 'confirmed', runner_id: params.runner_id, node_id: 'node-1' }),
    ...options.methods,
  };
  const adapter = Object.fromEntries(Object.keys(methods).map(key => [key, async (...args) => { calls.push({ method: key, args: clone(args) }); return clone(await methods[key](...args)); }]));
  const dom = installDom({ fetch: () => { throw new Error('pure UI must never fetch'); } });
  dom.node('detail').textContent = 'parent-owned content';
  let owned = true;
  const wizard = createRunnerDeployWizard({ adapter, projectId: options.projectId === undefined ? HOST : options.projectId, ownsPage: () => owned,
    onChanged: () => { state.changed++; if (options.onChanged) return options.onChanged(); } });
  const input = (key, value) => { const node = field(wizard.root, key); node.value = value; return node.oninput?.(); };
  const choose = id => { const node = field(wizard.root, 'project'); node.value = id; return node.onchange(); };
  async function fill() { await wizard.ready; input('ssh_alias', 'lab'); input('name', 'Lab'); }
  async function plan() { await fill(); await button(wizard.root, '检查远端环境').onclick(); }
  function approve() { for (const node of wizard.root.querySelectorAll('input').filter(node => node.dataset.deployAction)) { node.checked = true; node.onchange(); } }
  return { state, calls, dom, wizard, root: wizard.root, methods, adapter, input, choose, fill, plan, approve, leave() { owned = false; }, close() { wizard.dispose(); dom.restore(); } };
}

test('pure embeddable startup reads only injected sources/policy/history, preserves parent DOM/routes and keeps manual alias input', async () => {
  const f = fixture();
  try {
    await f.wizard.ready;
    expect(f.dom.node('detail').textContent).toBe('parent-owned content'); expect(f.dom.location.hash).toBe('');
    expect(f.calls.map(call => call.method)).toEqual(['discover', 'projects', 'project', 'receipts']);
    expect(deepText(f.root)).toContain('未执行配置命令或读取私钥');
    expect(f.root.querySelectorAll('.runner-deploy-step')).toHaveLength(4);
    expect(button(f.root, '检查远端环境').disabled).toBe(true);
    field(f.root, 'aliases').value = 'second-host'; field(f.root, 'aliases').onchange(); f.input('name', 'Lab');
    expect(field(f.root, 'ssh_alias').value).toBe('second-host'); expect(button(f.root, '检查远端环境').disabled).toBe(false);
    f.input('ssh_alias', 'hand-entered'); expect(field(f.root, 'aliases').value).toBe('');
    expect(f.root.querySelectorAll('button').some(node => node.classList.contains('agent-call'))).toBe(false);
    expect(deepText(f.root)).toContain('每 SSH 账户仅支持一套 Runner'); expect(deepText(f.root)).toContain('已有安装明确阻塞');
    expect(f.root.querySelectorAll('button').some(node => /升级|重装|解除保护/.test(node.textContent))).toBe(false);
  } finally { f.close(); }
});

test('manual alias survives discovery failure, offline/missing/failed project policy cannot inspect or start anything', async () => {
  const f = fixture({ methods: { discover: () => { throw new Error('private SSH details'); } } });
  try {
    await f.fill(); expect(deepText(f.root)).toContain('仍可手填安全别名'); expect(deepText(f.root)).not.toContain('private SSH details');
    await f.choose(OTHER); expect(button(f.root, '检查远端环境').disabled).toBe(true);
    expect(f.calls.filter(call => call.method === 'project')).toHaveLength(1);
    await button(f.root, '检查远端环境').onclick(); expect(f.calls.some(call => call.method === 'plan')).toBe(false);
    f.methods.project = () => { throw new Error('raw-token'); }; await f.choose(HOST);
    expect(deepText(f.root)).toContain('来源项目读取失败'); expect(deepText(f.root)).not.toContain('raw-token');
    expect(button(f.root, '检查远端环境').disabled).toBe(true);
    await f.choose('cccccccccccccccc'); expect(button(f.root, '检查远端环境').disabled).toBe(true);
  } finally { f.close(); }
});

test('empty policy requires an independent source-bound initialization confirmation; Host route ID is never used for pairing', async () => {
  const f = fixture({ state: { policy: { revision: 7, project_id: null, allowed_node_ids: [], default_node_id: 'local' } } });
  try {
    await f.fill(); expect(button(f.root, '检查远端环境').disabled).toBe(true);
    const cancelling = button(f.root, '初始化来源项目配对身份').onclick();
    expect(deepText(f.dom.node('modal'))).toContain(`来源 Alpha（${HOST}）`);
    await button(f.dom.node('modal'), '取消').onclick(); await cancelling;
    expect(f.calls.some(call => call.method === 'initializeProject')).toBe(false);
    const initializing = button(f.root, '初始化来源项目配对身份').onclick();
    await button(f.dom.node('modal'), '确认初始化配对身份').onclick(); await initializing;
    expect(f.calls.find(call => call.method === 'initializeProject').args).toEqual([HOST, 7]);
    await button(f.root, '检查远端环境').onclick();
    expect(f.calls.find(call => call.method === 'plan').args).toEqual([{ ssh_alias: 'lab', name: 'Lab', project_id: 'new-stable' }]);
    expect(f.state.policy.allowed_node_ids).toEqual([]); expect(f.state.policy.default_node_id).toBe('local'); expect(f.state.changed).toBe(0);
  } finally { f.close(); }
});

test('initialization false ACK or nonempty authorization blocks blind replay until explicit project reread', async () => {
  const f = fixture({ state: { policy: { revision: 2, project_id: null, allowed_node_ids: [], default_node_id: 'local' } }, methods: { initializeProject: () => ({ ok: true }) } });
  try {
    await f.fill(); const pending = button(f.root, '初始化来源项目配对身份').onclick();
    await button(f.dom.node('modal'), '确认初始化配对身份').onclick(); await pending;
    expect(deepText(f.root)).toContain('初始化结果未确认'); expect(button(f.root, '初始化来源项目配对身份').disabled).toBe(true);
    await button(f.root, '初始化来源项目配对身份').onclick(); expect(f.calls.filter(call => call.method === 'initializeProject')).toHaveLength(1);
    f.state.policy = { revision: 3, project_id: 'new-stable', allowed_node_ids: [], default_node_id: 'local' };
    await button(f.root, '刷新别名与项目').onclick(); expect(button(f.root, '检查远端环境').disabled).toBe(false);
    f.state.policy = { revision: 4, project_id: null, allowed_node_ids: ['existing-node'], default_node_id: 'local' };
    await button(f.root, '刷新别名与项目').onclick(); expect(button(f.root, '初始化来源项目配对身份').disabled).toBe(true);
  } finally { f.close(); }
});

test('visible plan shows exact files/system actions/blockers; summaries stay advanced and sudo is individually revision-bound', async () => {
  const f = fixture();
  try {
    await f.plan();
    for (const text of ['linux / x64', 'remote-user', '/home/remote-user/.local/lush-runner', 'central-verified-upload', 'cgroup v2 状态', '确切文件改动', '系统动作']) expect(deepText(f.root)).toContain(text);
    const advanced = f.root.querySelectorAll('details').find(node => deepText(node).includes('版本、摘要与高级信息'));
    expect(advanced.open === true).toBe(false);
    const approvals = f.root.querySelectorAll('input').filter(node => node.dataset.deployAction);
    expect(approvals).toHaveLength(2); expect(approvals.every(node => !node.checked)).toBe(true);
    expect(button(f.root, '确认部署').disabled).toBe(true);
    approvals[0].checked = true; approvals[0].onchange(); expect(button(f.root, '确认部署').disabled).toBe(true);
    approvals[1].checked = true; approvals[1].onchange(); expect(button(f.root, '确认部署').disabled).toBe(false);
    await button(f.root, '确认部署').onclick();
    expect(f.calls.find(call => call.method === 'apply').args).toEqual([{ id: ID, expected_revision: 1, approved_actions: ['upload', 'cgroup', 'git_install'], confirm: true }]);
    expect(deepText(f.root)).toContain('受控执行组已空'); expect(f.state.changed).toBe(1);
    expect(f.calls.some(call => call.method === 'confirm')).toBe(false);
    await button(f.root, '确认此安装身份').onclick();
    expect(f.calls.find(call => call.method === 'confirm').args).toEqual([{ id: ID, expected_revision: 2, runner_id: 'installation-1', confirm: true }]);
    expect(deepText(f.root)).toContain('项目授权和默认节点尚未改变'); expect(f.state.changed).toBe(2);
    expect(f.state.policy.allowed_node_ids).toEqual([]); expect(f.state.policy.default_node_id).toBe('local');
    expect(f.root.querySelector('.nav-link').href).toBe(`/#runners-project-${HOST}`);
  } finally { f.close(); }
});

test('fixed node budgets use exact frozen values in the visible approval preview, never device defaults', async () => {
  const model = receipt(); model.plan.node_budgets = { max_commands: 3, timeout_ms: 43210, output_bytes: 765432 };
  const f = fixture({ methods: { plan: () => model } });
  try {
    await f.plan();
    const limits = f.root.querySelector('.runner-deploy-node-budgets');
    expect(limits.parentNode.className).toBe('runner-deploy-plan');
    for (const line of ['并发命令：3 条', '单命令时限：43210 毫秒', '单命令输出：765432 字节', '不是 CPU／内存配额']) expect(deepText(limits)).toContain(line);
    f.approve(); expect(button(f.root, '确认部署').disabled).toBe(false);
    const changed = clone(model); changed.revision = 2; changed.status = 'ready'; changed.plan.node_budgets.timeout_ms++;
    f.methods.apply = () => changed;
    await button(f.root, '确认部署').onclick();
    expect(deepText(f.root)).toContain('部署结果未确认'); expect(deepText(f.root)).toContain('单命令时限：43210 毫秒');
    expect(button(f.root, '检查远端环境').disabled).toBe(true);
  } finally { f.close(); }
});

for (const budgets of [null, { max_commands: 0, timeout_ms: '60000', output_bytes: -1 }, {}]) test(`missing or invalid frozen budget values are not replaced by defaults: ${JSON.stringify(budgets)}`, async () => {
  const model = receipt(); model.plan.node_budgets = budgets;
  const f = fixture({ methods: { plan: () => model } });
  try {
    await f.plan(); const limits = f.root.querySelector('.runner-deploy-node-budgets');
    expect(limits.querySelectorAll('p').filter(node => node.textContent.includes('未提供或无效'))).toHaveLength(3);
    expect(deepText(limits)).not.toContain('60000 毫秒'); expect(deepText(limits)).not.toContain('1048576 字节');
  } finally { f.close(); }
});

test('legacy receipt without fixed budget metadata does not invent an execution ceiling', async () => {
  const f = fixture();
  try { await f.plan(); expect(f.root.querySelector('.runner-deploy-node-budgets')).toBeNull(); }
  finally { f.close(); }
});

test('each sudo action shows unit path/effect and complete exact Git dependencies by default; only hashes/summaries are advanced', async () => {
  const model = receipt(), git = model.plan.actions[2];
  git.effect = '<img src=x onerror=alert(1)> 启动后安装固定包';
  git.script = 'never-show-script'; git.unit_body = 'never-show-unit-body'; git.argv = ['never-show-argv'];
  git.repository_url = 'https://never-show-repository'; git.credentials = { token: 'never-show-token' };
  const f = fixture({ methods: { plan: () => model } });
  try {
    await f.plan();
    const cards = f.root.querySelectorAll('.runner-deploy-action'); expect(cards).toHaveLength(3);
    for (const [index, item] of model.plan.actions.entries()) {
      if (!item.privileged) continue;
      const card = cards[index], detail = card.querySelector('details');
      expect(card.querySelectorAll('p').find(node => node.textContent.includes(item.unit_path)).parentNode).toBe(card);
      expect(card.querySelectorAll('p').find(node => node.textContent.includes(item.effect)).parentNode).toBe(card);
      expect(detail.open === true).toBe(false); expect(deepText(detail)).toContain(item.unit_sha256); expect(deepText(detail)).toContain(item.unit_summary);
      expect(card.querySelector('input').checked).toBe(false);
    }
    for (const pkg of git.packages) {
      const line = cards[2].querySelectorAll('p').find(node => node.textContent.includes(`包 ${pkg.name} ·`));
      expect(line.textContent).toContain(pkg.version); expect(line.parentNode).toBe(cards[2]);
    }
    expect(cards[2].querySelector('img')).toBeNull(); expect(deepText(cards[2])).toContain('<img src=x onerror=alert(1)>');
    expect(deepText(f.root)).not.toContain('never-show-'); expect(button(f.root, '确认部署').disabled).toBe(true);
  } finally { f.close(); }
});

for (const [label, change, reason] of [
  ['unit path missing', action => { delete action.unit_path; }, 'unit 路径'],
  ['unit path traversal', action => { action.unit_path = '/etc/../tmp/unsafe.service'; }, 'unit 路径'],
  ['hash missing', action => { delete action.unit_sha256; }, 'SHA256'],
  ['hash invalid', action => { action.unit_sha256 = 'g'.repeat(64); }, 'SHA256'],
  ['summary missing', action => { delete action.unit_summary; }, '摘要说明'],
  ['effect missing', action => { action.effect = ''; }, '启动后果'],
  ['packages missing', action => { delete action.packages; }, '包表缺失'],
  ['packages empty', action => { action.packages = []; }, '包表缺失'],
  ['truncated packages', action => { action.packages_truncated = true; }, '包表截断'],
  ['unknown package completeness', action => { delete action.packages_truncated; }, '完整性未确认'],
  ['missing dependency version', action => { delete action.packages[1].version; }, '确切版本'],
  ['missing dependency name', action => { delete action.packages[1].name; }, '包名'],
  ['floating package version', action => { action.packages[1].version = 'latest'; }, '确切版本'],
  ['missing install operation', action => { delete action.packages[1].operation; }, '安装操作'],
  ['package upgrade', action => { action.packages[0].previous_version = '1:2.40.0-1'; }, '既有包升级'],
  ['dependency downgrade', action => { action.packages[2].previous_version = '9.0'; }, '版本变更'],
  ['explicit upgrade operation', action => { action.packages[0].operation = 'upgrade'; }, '安装操作'],
  ['invalid previous version', action => { action.packages[0].previous_version = ''; }, '既有包版本信息无效'],
  ['duplicate package', action => { action.packages.push(clone(action.packages[0])); }, '重复依赖'],
  ['Git itself missing', action => { action.packages.shift(); }, '未包含 Git 本身'],
  ['nonprivileged Git install', action => { action.privileged = false; }, '必须逐项授予特权'],
]) test(`incomplete authorization ${label} preserves visible plan and blocks every submit path`, async () => {
  const model = receipt(); change(model.plan.actions[2]);
  const f = fixture({ methods: { plan: () => model } });
  try {
    await f.plan(); expect(deepText(f.root)).toContain(`收据 ${ID}`); expect(deepText(f.root)).toContain('确切文件改动');
    expect(deepText(f.root)).toContain(reason); expect(f.root.querySelector('.runner-deploy-plan-issue').parentNode.className).toBe('runner-deploy-plan');
    f.approve(); expect(button(f.root, '确认部署').disabled).toBe(true); await button(f.root, '确认部署').onclick();
    expect(f.calls.filter(call => call.method === 'apply')).toHaveLength(0);
    for (const node of f.root.querySelectorAll('input').filter(node => node.dataset.deployAction)) { expect(node.disabled).toBe(true); expect(node.parentNode.dataset.help).toBeTruthy(); }
  } finally { f.close(); }
});

for (const [label, change, reason] of [
  ['missing action ID', actions => { delete actions[0].id; }, '动作 ID'],
  ['duplicate action ID', actions => { actions[1].id = actions[0].id; }, '动作 ID 重复'],
  ['unknown malformed ID', actions => { actions[0].id = '../unknown'; }, '动作 ID'],
  ['missing label', actions => { delete actions[1].label; }, '动作 ID、名称'],
  ['unknown privilege', actions => { delete actions[1].privileged; }, '权限类型'],
  ['duplicate unit', actions => { actions[2].unit_path = actions[1].unit_path; }, '同一 unit 路径重复'],
  ['missing action set', actions => { actions.length = 0; }, '动作集合缺失'],
  ['null action', actions => { actions[0] = null; }, '动作 ID'],
]) test(`invalid frozen action set ${label} remains visible but never authorizes`, async () => {
  const model = receipt(); change(model.plan.actions);
  const f = fixture({ methods: { plan: () => model } });
  try {
    await f.plan(); expect(deepText(f.root)).toContain(`收据 ${ID}`); expect(deepText(f.root)).toContain(reason);
    f.approve(); await button(f.root, '确认部署').onclick(); expect(button(f.root, '确认部署').disabled).toBe(true);
    expect(f.calls.some(call => call.method === 'apply')).toBe(false);
  } finally { f.close(); }
});

test('detached checkboxes cannot authorize a replacement plan even when action IDs are identical', async () => {
  const f = fixture();
  try {
    await f.plan(); const old = f.root.querySelectorAll('input').filter(node => node.dataset.deployAction);
    f.input('name', 'Replacement'); await button(f.root, '检查远端环境').onclick();
    for (const node of old) { node.checked = true; node.onchange(); }
    expect(button(f.root, '确认部署').disabled).toBe(true);
    expect(f.root.querySelectorAll('input').filter(node => node.dataset.deployAction).every(node => !node.checked)).toBe(true);
    await button(f.root, '确认部署').onclick(); expect(f.calls.some(call => call.method === 'apply')).toBe(false);
  } finally { f.close(); }
});

test('total confirmation sends only the entire frozen set, never auto-checks sudo or accepts tampered selection IDs', async () => {
  const f = fixture();
  try {
    await f.plan(); await button(f.root, '确认部署').onclick(); expect(f.calls.some(call => call.method === 'apply')).toBe(false);
    const sudo = f.root.querySelectorAll('input').filter(node => node.dataset.deployAction);
    expect(sudo.every(node => !node.checked)).toBe(true); f.approve();
    sudo[1].dataset.deployAction = 'unknown_action'; sudo[1].onchange();
    expect(button(f.root, '确认部署').disabled).toBe(true); expect(deepText(f.root)).toContain('不能提交未知动作');
    expect(f.root.querySelectorAll('input').filter(node => node.dataset.deployAction).every(node => !node.checked)).toBe(true);
    sudo[1].dataset.deployAction = 'git_install';
    for (const node of sudo) { node.checked = true; node.onchange(); }
    expect(button(f.root, '确认部署').disabled).toBe(true); // detached controls from the previous render cannot authorize
    f.approve(); await button(f.root, '确认部署').onclick();
    expect(f.calls.find(call => call.method === 'apply').args[0].approved_actions).toEqual(['upload', 'cgroup', 'git_install']);
    expect(f.root.querySelectorAll('input').filter(node => node.dataset.deployAction).every(node => !node.checked)).toBe(true);
  } finally { f.close(); }
});

for (const actions of [undefined, null, {}]) test(`missing action array ${String(actions)} preserves the preview but cannot submit`, async () => {
  const model = receipt(); model.plan.actions = actions;
  const f = fixture({ methods: { plan: () => model } });
  try {
    await f.plan(); expect(deepText(f.root)).toContain(`收据 ${ID}`); expect(deepText(f.root)).toContain('动作集合缺失');
    expect(button(f.root, '确认部署').disabled).toBe(true); await button(f.root, '确认部署').onclick();
    expect(f.calls.some(call => call.method === 'apply')).toBe(false);
  } finally { f.close(); }
});

test('planned empty authorization evidence advances only after total confirmation to the entire frozen set', async () => {
  const f = fixture({ methods: { plan: () => receipt({ approved_actions: [] }), apply: params => receipt({ revision: 2, status: 'ready', approved_actions: params.approved_actions }) } });
  try {
    await f.plan(); expect(button(f.root, '确认部署').disabled).toBe(true); f.approve(); await button(f.root, '确认部署').onclick();
    expect(deepText(f.root)).toContain('部署收据：等待确认身份'); expect(f.calls.find(call => call.method === 'apply').args[0].approved_actions).toEqual(['upload', 'cgroup', 'git_install']);
  } finally { f.close(); }
});

test('exact unchanged installed dependency versions and explicit absent previous versions are not upgrades', async () => {
  const model = receipt(); model.plan.actions[2].packages[1].previous_version = model.plan.actions[2].packages[1].version;
  model.plan.actions[2].packages[2].previous_version = null;
  const f = fixture({ methods: { plan: () => model } });
  try {
    await f.plan(); expect(deepText(f.root)).not.toContain('授权预览阻塞'); f.approve(); expect(button(f.root, '确认部署').disabled).toBe(false);
    expect(deepText(f.root)).toContain(`既有版本 ${model.plan.actions[2].packages[1].version}`);
  } finally { f.close(); }
});

test('nonprivileged-only frozen plan uses explicit total confirmation, not an implicit approval', async () => {
  const model = receipt(); model.plan.actions = model.plan.actions.filter(item => !item.privileged);
  const f = fixture({ methods: { plan: () => model, apply: params => ({ ...model, revision: 2, status: 'ready', approved_actions: params.approved_actions }) } });
  try {
    await f.plan(); expect(f.root.querySelectorAll('input').filter(node => node.dataset.deployAction)).toHaveLength(0);
    expect(f.calls.some(call => call.method === 'apply')).toBe(false); expect(button(f.root, '确认部署').disabled).toBe(false);
    await button(f.root, '确认部署').onclick(); expect(f.calls.find(call => call.method === 'apply').args[0].approved_actions).toEqual(['upload']);
    expect(deepText(f.root)).toContain('部署收据：等待确认身份');
  } finally { f.close(); }
});

test('missing dependency/cgroup observations default to visible unknown, including individually missing Git or Bun', async () => {
  const f = fixture();
  try {
    await f.plan();
    expect(f.root.querySelector('[data-deploy-dependency="Git"]').textContent).toBe('依赖 Git：未知');
    expect(f.root.querySelector('[data-deploy-dependency="Bun"]').textContent).toBe('依赖 Bun：未知');
    expect(f.root.querySelector('[data-deploy-cgroup=""]').textContent).toBe('cgroup v2 状态：未知');
    expect(deepText(f.root)).toContain('不构成系统动作授权、部署成功或进程停止证明');
    const next = receipt(); next.plan.dependencies = [{ name: 'git', status: 'ready', version: '2.50' }];
    f.methods.plan = () => next; await button(f.root, '检查远端环境').onclick();
    expect(f.root.querySelector('[data-deploy-dependency="git"]').textContent).toContain('已就绪（观测）');
    expect(f.root.querySelector('[data-deploy-dependency="Git"]')).toBeNull();
    expect(f.root.querySelector('[data-deploy-dependency="Bun"]').textContent).toBe('依赖 Bun：未知');
    expect(button(f.root, '确认部署').disabled).toBe(true); expect(f.state.changed).toBe(0);
  } finally { f.close(); }
});

for (const [dependencyStatus, cgroupStatus, dependencyLabel, cgroupLabel] of [
  ['ready', 'ready', '已就绪（观测）', '已就绪（观测）'],
  ['needs_install', 'needs_setup', '待安装', '待配置'],
  ['unsupported', 'unsupported', '不支持', '不支持'],
  ['unknown', 'unknown', '未知', '未知'],
  ['unexpected', 'unexpected', '未知', '未知'],
]) test(`default preview renders dependency ${dependencyStatus}/cgroup ${cgroupStatus} without granting sudo or declaring deployment success`, async () => {
  const model = receipt();
  model.plan.dependencies = [{ name: 'Git', status: dependencyStatus, version: '2.50', message: '依赖观测说明' }, { name: 'Bun', status: dependencyStatus }];
  model.plan.cgroup = { status: cgroupStatus, path: '/sys/fs/cgroup/runner-user', message: 'cgroup 观测说明' };
  const f = fixture({ methods: { plan: () => model } });
  try {
    await f.plan();
    const git = f.root.querySelector('[data-deploy-dependency="Git"]'), bun = f.root.querySelector('[data-deploy-dependency="Bun"]'), group = f.root.querySelector('[data-deploy-cgroup=""]');
    expect(git.textContent).toContain(`依赖 Git：${dependencyLabel} · 版本 2.50 · 依赖观测说明`);
    expect(bun.textContent).toBe(`依赖 Bun：${dependencyLabel}`);
    expect(group.textContent).toContain(`cgroup v2 状态：${cgroupLabel} · 路径 /sys/fs/cgroup/runner-user · cgroup 观测说明`);
    expect(group.parentNode.className).toBe('runner-deploy-observations');
    expect(group.parentNode.parentNode.className).toBe('runner-deploy-plan');
    expect(git.parentNode).toBe(group.parentNode);
    expect(f.root.querySelector('[data-deploy-action="cgroup"]').checked).toBe(false);
    expect(button(f.root, '确认部署').disabled).toBe(true); expect(button(f.root, '确认此安装身份').disabled).toBe(true);
    expect(f.calls.some(call => call.method === 'apply' || call.method === 'confirm')).toBe(false); expect(f.state.changed).toBe(0);
  } finally { f.close(); }
});

test('unsupported/no-sudo/unknown installation is blocked visibly, and editing invalidates old plan and all system approvals', async () => {
  const blocked = receipt({ status: 'blocked' }); blocked.plan.supported = false; blocked.plan.blockers = [{ code: 'sudo_unavailable', message: '请先授予受限系统权限；现有未知安装不能覆盖' }];
  const f = fixture({ methods: { plan: () => blocked } });
  try {
    await f.plan(); expect(deepText(f.root)).toContain('现有未知安装不能覆盖'); expect(button(f.root, '确认部署').disabled).toBe(true);
    expect(f.root.querySelector('[data-deploy-action="cgroup"]').disabled).toBe(true);
    f.methods.plan = target => receipt(target); f.input('name', 'New name');
    expect(deepText(f.root)).not.toContain('sudo_unavailable'); await button(f.root, '检查远端环境').onclick(); f.approve();
    f.input('ssh_alias', 'new-host'); expect(f.root.querySelector('[data-deploy-action="cgroup"]')).toBeNull(); expect(button(f.root, '确认部署').disabled).toBe(true);
    await button(f.root, '检查远端环境').onclick(); expect(f.root.querySelector('[data-deploy-action="cgroup"]').checked).toBe(false);
    expect(f.calls.filter(call => call.method === 'apply')).toHaveLength(0);
  } finally { f.close(); }
});

for (const [label, result] of [
  ['false ACK', { ok: true }], ['wrong id', receipt({ id: ID2, revision: 2, status: 'ready' })],
  ['old revision', receipt({ revision: 1, status: 'ready' })], ['wrong target', receipt({ revision: 2, status: 'ready', project_id: HOST })],
  ['network failure', new Error('raw-machine-secret')],
  ['changed unit hash', changedAck(value => { value.plan.actions[1].unit_sha256 = 'e'.repeat(64); })],
  ['changed effect', changedAck(value => { value.plan.actions[1].effect = '启动另一个系统动作'; })],
  ['changed unit summary', changedAck(value => { value.plan.actions[1].unit_summary = '摘要已改变'; })],
  ['changed package version', changedAck(value => { value.plan.actions[2].packages[0].version = '2.99'; })],
  ['changed target metadata', changedAck(value => { value.plan.target.uid = 0; })],
  ['missing frozen action', changedAck(value => { value.plan.actions.pop(); })],
  ['duplicate frozen action', changedAck(value => { value.plan.actions.push(clone(value.plan.actions[0])); })],
  ['new unknown action', changedAck(value => { value.plan.actions.push({ id: 'unknown_new_action', label: '未确认动作', privileged: false }); })],
  ['changed privilege', changedAck(value => { value.plan.actions[1].privileged = false; })],
  ['incomplete approval ACK', changedAck(value => { value.approved_actions = ['cgroup', 'git_install']; })],
  ['unknown approval ACK', changedAck(value => { value.approved_actions = ['upload', 'cgroup', 'unknown']; })],
  ['duplicate approval ACK', changedAck(value => { value.approved_actions = ['upload', 'cgroup', 'git_install', 'git_install']; })],
]) test(`apply ${label} retains original receipt and blocks replay/new plans until same-operation reconciliation`, async () => {
  const f = fixture({ methods: { apply: () => { if (result instanceof Error) throw result; return result; } } });
  try {
    await f.plan(); f.approve(); await button(f.root, '确认部署').onclick();
    expect(deepText(f.root)).toContain('部署结果未确认'); expect(deepText(f.root)).not.toContain('raw-machine-secret');
    expect(button(f.root, '确认部署').disabled).toBe(true); expect(button(f.root, '检查远端环境').disabled).toBe(true);
    await button(f.root, '确认部署').onclick(); await button(f.root, '检查远端环境').onclick();
    expect(f.calls.filter(call => call.method === 'apply')).toHaveLength(1); expect(f.calls.filter(call => call.method === 'plan')).toHaveLength(1);
    expect(f.root.querySelectorAll('input').filter(node => node.dataset.deployAction).every(node => !node.checked)).toBe(true);
    await button(f.root, '核对原部署现场').onclick();
    expect(f.calls.find(call => call.method === 'reconcile').args).toEqual([{ id: ID, expected_revision: 1 }]);
    expect(button(f.root, '确认此安装身份').disabled).toBe(false);
    for (const node of f.root.querySelectorAll('input').filter(node => node.disabled)) expect(node.parentNode.dataset.help).toBeTruthy();
  } finally { f.close(); }
});

test('stale planned receipt after lost apply ACK cannot clear uncertainty or authorize replay', async () => {
  const f = fixture({ methods: { apply: () => { throw new Error('lost ACK'); } } });
  try {
    await f.plan(); f.approve(); await button(f.root, '确认部署').onclick(); f.state.history = [receipt()];
    await button(f.root, '刷新收据').onclick(); expect(deepText(f.root)).toContain('修订不一致');
    await button(f.root, '确认部署').onclick(); await button(f.root, '检查远端环境').onclick();
    expect(button(f.root, '确认部署').disabled).toBe(true); expect(button(f.root, '检查远端环境').disabled).toBe(true);
    expect(f.calls.filter(call => call.method === 'apply')).toHaveLength(1); expect(f.calls.filter(call => call.method === 'plan')).toHaveLength(1);
    expect(f.root.querySelectorAll('input').filter(node => node.dataset.deployAction).every(node => !node.checked)).toBe(true);
    await button(f.root, '核对原部署现场').onclick(); expect(button(f.root, '确认此安装身份').disabled).toBe(false);
  } finally { f.close(); }
});

test('valid reordered authorization ACK is accepted, but later confirmation cannot change or drop that evidence', async () => {
  const applied = receipt({ revision: 2, status: 'ready', runner_id: 'installation-1', node_id: 'node-1', approved_actions: ['git_install', 'upload', 'cgroup'] });
  applied.plan = Object.fromEntries(Object.entries(applied.plan).reverse());
  const f = fixture({ methods: { apply: () => applied, confirm: () => receipt({ revision: 3, status: 'confirmed', runner_id: 'installation-1', node_id: 'node-1' }) } });
  try {
    await f.plan(); f.approve(); await button(f.root, '确认部署').onclick();
    expect(button(f.root, '确认此安装身份').disabled).toBe(false);
    await button(f.root, '确认此安装身份').onclick(); expect(deepText(f.root)).toContain('身份确认结果未确认');
    expect(f.state.changed).toBe(1); expect(button(f.root, '检查远端环境').disabled).toBe(true);
    f.methods.reconcile = () => ({ ...applied, revision: 3 }); await button(f.root, '核对原部署现场').onclick();
    f.methods.confirm = () => ({ ...applied, revision: 4, status: 'confirmed', approved_actions: ['upload', 'cgroup', 'git_install'] });
    await button(f.root, '确认此安装身份').onclick(); expect(deepText(f.root)).toContain('安装身份已确认');
  } finally { f.close(); }
});

for (const method of ['receipts', 'reconcile', 'confirm']) test(`${method} cannot replace frozen metadata even with a higher revision`, async () => {
  const f = fixture();
  try {
    await f.plan(); f.approve(); await button(f.root, '确认部署').onclick();
    const changed = receipt({ revision: 3, status: method === 'confirm' ? 'confirmed' : 'ready', runner_id: 'installation-1', node_id: 'node-1' });
    changed.plan.actions[2].packages.push({ name: 'unexpected-package', version: '1.0', operation: 'install' });
    if (method === 'receipts') f.state.history = [changed]; else f.methods[method] = () => changed;
    await button(f.root, { receipts: '刷新收据', reconcile: '核对原部署现场', confirm: '确认此安装身份' }[method]).onclick();
    expect(deepText(f.root)).not.toContain('unexpected-package'); expect(button(f.root, '确认此安装身份').disabled).toBe(true);
    expect(button(f.root, '检查远端环境').disabled).toBe(true); expect(f.state.changed).toBe(1);
    expect(f.root.querySelectorAll('input').filter(node => node.dataset.deployAction).every(node => !node.checked)).toBe(true);
  } finally { f.close(); }
});

test('running/unknown receipts never poll or replay; explicit refresh advances stages and rejects older or changed same revision', async () => {
  const running = receipt({ revision: 2, status: 'running' });
  const f = fixture({ methods: { apply: () => running } });
  try {
    await f.plan(); f.approve(); await button(f.root, '确认部署').onclick();
    expect(deepText(f.root)).toContain('不代表安装成功或进程已停止'); expect(button(f.root, '检查远端环境').disabled).toBe(true);
    expect(f.calls.filter(call => call.method === 'receipts')).toHaveLength(1); expect(f.calls.filter(call => call.method === 'reconcile')).toHaveLength(0);
    f.state.history = [receipt({ revision: 3, status: 'ready', runner_id: 'installation-1', node_id: 'node-1' })];
    await button(f.root, '刷新收据').onclick(); expect(button(f.root, '确认此安装身份').disabled).toBe(false);
    f.state.history = [receipt({ revision: 2, status: 'ready', runner_id: 'installation-1', node_id: 'node-1' })];
    await button(f.root, '刷新收据').onclick(); expect(deepText(f.root)).toContain('修订不一致'); expect(button(f.root, '确认此安装身份').disabled).toBe(true);
    expect(f.calls.filter(call => call.method === 'apply')).toHaveLength(1);
  } finally { f.close(); }
});

test('same-revision receipt reads ignore key order but reject changed evidence; missing history gates new plans until explicit reread', async () => {
  const f = fixture();
  try {
    await f.plan();
    const original = receipt();
    f.state.history = [Object.fromEntries(Object.entries(original).reverse())];
    await button(f.root, '刷新收据').onclick(); expect(deepText(f.root)).toContain('已读取原收据：待确认计划');
    f.state.history = [receipt({ stages: [{ id: 'upload', status: 'completed', message: 'changed without revision' }] })];
    await button(f.root, '刷新收据').onclick(); expect(deepText(f.root)).toContain('修订不一致'); expect(button(f.root, '检查远端环境').disabled).toBe(true);
  } finally { f.close(); }
  const g = fixture({ methods: { receipts: () => { throw new Error('raw history error'); } } });
  try {
    await g.fill(); expect(button(g.root, '检查远端环境').disabled).toBe(true); expect(deepText(g.root)).not.toContain('raw history error');
    g.methods.receipts = () => ({ version: 1, items: [], truncated: false }); await button(g.root, '刷新收据').onclick();
    expect(button(g.root, '检查远端环境').disabled).toBe(false);
  } finally { g.close(); }
});

test('identity false ACK/change of observed identity never means pinned or authorized, and parent refresh failure cannot turn ACK into replay', async () => {
  const f = fixture({ methods: { confirm: () => receipt({ revision: 3, status: 'confirmed', node_id: 'node-1', runner_id: 'different-installation' }) }, onChanged: () => Promise.reject(new Error('parent refresh failed')) });
  try {
    await f.plan(); f.approve(); await button(f.root, '确认部署').onclick();
    await button(f.root, '确认此安装身份').onclick();
    expect(deepText(f.root)).toContain('身份确认结果未确认'); expect(f.state.changed).toBe(1);
    await button(f.root, '确认此安装身份').onclick(); expect(f.calls.filter(call => call.method === 'confirm')).toHaveLength(1);
    expect(f.state.policy.allowed_node_ids).toEqual([]);
    f.methods.reconcile = () => receipt({ revision: 3, status: 'ready', runner_id: 'installation-1', node_id: 'node-1' });
    await button(f.root, '核对原部署现场').onclick();
    f.methods.confirm = () => receipt({ revision: 4, status: 'confirmed', runner_id: 'installation-1', node_id: 'node-1' });
    await button(f.root, '确认此安装身份').onclick(); expect(deepText(f.root)).toContain('安装身份已确认');
    expect(button(f.root, '确认此安装身份').disabled).toBe(true);
  } finally { f.close(); }
});

test('recent unknown operation restores across mounting, truncation stays explicit, missing/other receipts do not unlock unknown', async () => {
  const old = receipt({ status: 'unknown', revision: 8 });
  const f = fixture({ state: { history: [old, receipt({ id: ID2, status: 'failed' })], truncated: true } });
  try {
    await f.fill(); expect(deepText(f.root)).toContain('列表已截断'); expect(button(f.root, '检查远端环境').disabled).toBe(true);
    let restore = f.root.querySelectorAll('button').filter(node => node.textContent === '恢复此操作');
    expect(restore.every(node => !node.disabled)).toBe(true); await restore[0].onclick();
    expect(deepText(f.root)).toContain('已恢复原收据：结果未知');
    restore = f.root.querySelectorAll('button').filter(node => node.textContent === '恢复此操作'); await restore[1].onclick();
    expect(deepText(f.root)).toContain('不能用另一条操作替代未知结果');
    f.state.history = []; await button(f.root, '刷新收据').onclick(); expect(deepText(f.root)).toContain('列表缺失不能证明部署未执行');
    expect(button(f.root, '检查远端环境').disabled).toBe(true);
    await button(f.root, '核对原部署现场').onclick();
    expect(f.calls.find(call => call.method === 'reconcile').args).toEqual([{ id: ID, expected_revision: 8 }]);
  } finally { f.close(); }
});

test('lost plan ACK cannot be replaced by an old same-target receipt, and new matching operation can be explicitly recovered', async () => {
  const f = fixture({ state: { history: [receipt({ status: 'failed' })] }, methods: { plan: () => { throw new Error('lost plan ACK'); } } });
  try {
    await f.fill(); await button(f.root, '检查远端环境').onclick();
    await button(f.root, '恢复此操作').onclick(); expect(deepText(f.root)).toContain('请求前的旧修订');
    expect(button(f.root, '检查远端环境').disabled).toBe(true);
    f.state.history = [receipt({ id: ID2 })]; await button(f.root, '刷新收据').onclick();
    await button(f.root, '恢复此操作').onclick(); expect(deepText(f.root)).toContain('已恢复原收据：待确认计划');
    expect(f.root.querySelector('[data-deploy-action="cgroup"]').checked).toBe(false);
  } finally { f.close(); }
});

test('busy is single-flight, all disabled controls have hosts, input changes invalidate late plans and dispose prevents late ACK/callbacks', async () => {
  const slow = deferred(), f = fixture({ methods: { plan: () => slow.promise } });
  try {
    await f.fill(); const checking = button(f.root, '检查远端环境').onclick();
    await button(f.root, '检查远端环境').onclick(); expect(f.calls.filter(call => call.method === 'plan')).toHaveLength(1);
    for (const node of [...f.root.querySelectorAll('input'), ...f.root.querySelectorAll('select'), ...f.root.querySelectorAll('button')].filter(node => node.disabled)) expect(node.parentNode.dataset.help).toBeTruthy();
    f.input('name', 'Newer draft'); slow.resolve(receipt()); await checking;
    expect(deepText(f.root)).not.toContain(`收据 ${ID}`); expect(field(f.root, 'name').value).toBe('Newer draft');
    f.methods.plan = target => receipt(target); await button(f.root, '检查远端环境').onclick(); f.approve();
    const applying = deferred(); f.methods.apply = () => applying.promise;
    const posting = button(f.root, '确认部署').onclick(); f.wizard.dispose();
    const before = deepText(f.root); applying.resolve(receipt({ name: 'Newer draft', revision: 2, status: 'ready', runner_id: 'installation-1', node_id: 'node-1' })); await posting;
    expect(deepText(f.root)).toBe(before); expect(f.state.changed).toBe(0);
  } finally { f.close(); }
});

test('leaving during source read never overwrites new ownership; disposal closes only its own initialization dialog', async () => {
  const slow = deferred(), f = fixture({ methods: { project: () => slow.promise } });
  try {
    await until(() => f.calls.some(call => call.method === 'project')); f.leave();
    const before = deepText(f.root); slow.resolve({ revision: 1, project_id: 'late', allowed_node_ids: [], default_node_id: 'local' }); await f.wizard.ready;
    expect(deepText(f.root)).toBe(before); expect(f.calls.some(call => call.method === 'receipts')).toBe(false);
  } finally { f.close(); }
  const g = fixture({ state: { policy: { revision: 0, project_id: null, allowed_node_ids: [], default_node_id: 'local' } } });
  try {
    await g.fill(); const opening = button(g.root, '初始化来源项目配对身份').onclick(); g.wizard.dispose(); await opening;
    expect(g.dom.node('modal').children).toHaveLength(0); expect(g.calls.some(call => call.method === 'initializeProject')).toBe(false);
  } finally { g.close(); }
});

test('failed deployment preserves report and inputs without retry; offline refresh invalidates plans; missing identity cannot confirm', async () => {
  const f = fixture({ methods: { apply: () => receipt({ revision: 2, status: 'failed', stages: [{ id: 'install', status: 'failed', message: '安装失败，保留原现场' }] }) } });
  try {
    await f.plan(); f.approve(); await button(f.root, '确认部署').onclick();
    expect(deepText(f.root)).toContain('安装失败，保留原现场'); expect(field(f.root, 'name').value).toBe('Lab');
    await button(f.root, '确认部署').onclick(); expect(f.calls.filter(call => call.method === 'apply')).toHaveLength(1);
    f.state.projects[0].running = false; await button(f.root, '刷新别名与项目').onclick();
    expect(button(f.root, '检查远端环境').disabled).toBe(true); expect(f.root.querySelector('[data-deploy-action="cgroup"]')).toBeNull();
  } finally { f.close(); }
  const g = fixture({ state: { history: [receipt({ status: 'ready', credentials: { machine_token: 'never-show-machine', control_token: 'never-show-control' } })] } });
  try { await g.wizard.ready; await button(g.root, '恢复此操作').onclick(); expect(button(g.root, '确认此安装身份').disabled).toBe(true); expect(deepText(g.root)).not.toContain('never-show-machine'); expect(deepText(g.root)).not.toContain('never-show-control'); }
  finally { g.close(); }
});

test('standalone CSS stays scoped, narrow steps are vertical, essential errors are not clipped and no HTTP/backend import exists', async () => {
  const css = await Bun.file(new URL('../../src/ui/web/assets/styles-runner-deploy.css', import.meta.url)).text();
  expect(css).toContain('@media(max-width:600px)'); expect(css).toContain('grid-template-columns:minmax(0,1fr)'); expect(css).toContain('flex-direction:column'); expect(css).toContain('min-height:44px');
  expect(css).not.toMatch(/max-height|overflow:\s*hidden|display:\s*none(?!\!important)/);
  const source = await Bun.file(new URL('../../src/ui/web/assets/runner-deploy-wizard.js', import.meta.url)).text();
  expect(source).not.toMatch(/\bfetch\s*\(|\/api\/|settings-api|render-runners|from ['"].*backend/);
  const styles = await Bun.file(new URL('../../src/ui/web/assets/styles.css', import.meta.url)).text(); expect(styles).not.toContain('styles-runner-deploy.css');
  expect(() => createRunnerDeployWizard({ adapter: {} })).toThrow('adapter.discover');
  const build = await Bun.build({ entrypoints: [new URL('../../src/ui/web/assets/runner-deploy-wizard.js', import.meta.url).pathname], target: 'browser', write: false });
  expect(build.success).toBe(true); expect(build.outputs).toHaveLength(1);
});
