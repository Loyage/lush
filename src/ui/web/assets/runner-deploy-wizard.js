import { el } from './dom.js';
import { formDialog } from './dialog.js';
import { runnerButton, runnerDetails, runnerLifetime, closeRunnerDialog } from './runner-settings-controls.js';
import { runnersLink } from './runner-page-route.js';
import { canonicalPreview as canonical, previewText as text, sameRunnerActions as sameActions, runnerPlanIssues as planIssues, renderRunnerActions } from './runner-action-preview.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const STATES = { planned: '待确认计划', blocked: '已阻塞', running: '执行中', ready: '等待确认身份', confirmed: '身份已确认', failed: '已失败', unknown: '结果未知' };
const DEPENDENCY_STATES = { ready: '已就绪（观测）', needs_install: '待安装', unsupported: '不支持', unknown: '未知' };
const CGROUP_STATES = { ready: '已就绪（观测）', needs_setup: '待配置', unsupported: '不支持', unknown: '未知' };
const unresolved = value => ['unknown', 'running'].includes(value?.status);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const sameTarget = (a, b) => a.ssh_alias === b.ssh_alias && a.name === b.name && a.project_id === b.project_id;
function validReceipt(value) {
  return value && UUID.test(value.id) && revision(value.revision) && Object.hasOwn(STATES, value.status)
    && typeof value.ssh_alias === 'string' && ALIAS.test(value.ssh_alias) && typeof value.name === 'string'
    && typeof value.project_id === 'string' && Boolean(value.project_id) && Array.isArray(value.stages)
    && value.plan && Array.isArray(value.plan.blockers) && Array.isArray(value.plan.files);
}

/** Pure UI only: every read and effect is supplied by the embedding page's adapter. */
export function createRunnerDeployWizard({ adapter, ownsPage = () => true, onChanged = () => {}, projectId = '' } = {}) {
  for (const method of ['discover', 'projects', 'project', 'initializeProject', 'plan', 'apply', 'receipts', 'reconcile', 'confirm'])
    if (typeof adapter?.[method] !== 'function') throw new Error(`部署向导缺少 adapter.${method}`);
  const life = runnerLifetime(ownsPage), current = life.current, ownerWindow = globalThis.window;
  const root = el('section', undefined, 'runner-deploy-wizard block');
  const heading = el('div', undefined, 'section-title'); heading.append(el('h2', '连接并部署Runner'));
  const feedback = el('p', '', 'runner-deploy-feedback'); feedback.setAttribute('role', 'status'); feedback.hidden = true;
  root.append(heading, el('p', '先检查环境，再逐项确认改动。读取 SSH 别名、项目和收据不连接远端；部署不调用模型、不创建 Worker、不自动授权项目。', 'hint'),
    el('p', '首版每 SSH 账户仅支持一套 Runner；已有安装明确阻塞，不提供升级、重装或解除保护。', 'hint'), feedback);
  const steps = ['连接与来源项目', '检查环境与确认改动', '部署与验证阶段', '确认安装身份'].map((title, i) => {
    const section = el('section', undefined, 'runner-deploy-step'); section.dataset.deployStep = String(i + 1);
    section.append(el('h3', `${i + 1}. ${title}`)); root.append(section); return section;
  });
  let busy = false, writeBusy = false, generation = 0, projects = [], policy = null, policyUncertain = false;
  let selectedProject = projectId, receipt = null, uncertain = false, history = [], historyReady = false;
  let pendingTarget = null, pendingKnown = new Map(), confirmation = null, approved = new Set();
  const submittedActions = new Map();
  const buttons = [], fields = [];
  let historyControls = [], receiptPaint = 0;
  function field(parent, labelText, key, tag = 'input') {
    const label = el('label', undefined, 'runner-deploy-field'), host = el('span', undefined, 'help-host'), control = el(tag);
    control.dataset.deployField = key; control.setAttribute('aria-label', labelText);
    if (tag === 'input') { control.type = 'text'; control.autocomplete = 'off'; control.spellcheck = false; }
    host.append(control); label.append(el('span', labelText), host); parent.append(label); fields.push({ control, host }); return control;
  }
  function action(parent, label, fn, allowed, reason, help = '') {
    const item = runnerButton(label, () => current() && !busy && allowed() ? fn() : undefined, help);
    buttons.push({ ...item, allowed, reason }); parent.append(item.host); return item;
  }
  function status(message, error = false) { feedback.textContent = message; feedback.className = `runner-deploy-feedback${error ? ' error' : ''}`; feedback.hidden = !message; }
  const connection = el('div', undefined, 'runner-deploy-fields'); steps[0].append(connection);
  const aliases = field(connection, 'SSH 配置中的别名（可选）', 'aliases', 'select');
  const alias = field(connection, 'SSH 别名（支持手填）', 'ssh_alias'); alias.maxLength = 128;
  const name = field(connection, '节点名称', 'name'); name.maxLength = 80;
  const project = field(connection, '已登记的来源项目', 'project', 'select');
  const discovery = el('p', '', 'hint'), source = el('p', '', 'runner-deploy-source'); steps[0].append(discovery, source);
  const sourceActions = el('div', undefined, 'runner-deploy-actions'); steps[0].append(sourceActions);
  const planBody = el('div', undefined, 'runner-deploy-plan'); steps[1].append(planBody);
  const deployment = el('div', undefined, 'runner-deploy-stages'); steps[2].append(deployment);
  const identity = el('div', undefined, 'runner-deploy-identity'); steps[3].append(identity);
  const historyBox = runnerDetails('最近操作与恢复'); historyBox.className = 'runner-deploy-history';
  const historyStatus = el('p', '', 'runner-deploy-history-status'), historyList = el('ul'); historyBox.append(historyStatus, historyList); root.append(historyBox);
  const planActions = el('div', undefined, 'runner-deploy-actions'); steps[1].append(planActions);
  const recoveryActions = el('div', undefined, 'runner-deploy-actions'); steps[2].append(recoveryActions);
  const identityActions = el('div', undefined, 'runner-deploy-actions'); steps[3].append(identityActions);
  const row = () => projects.find(item => item.id === selectedProject);
  const online = () => row()?.running === true && !row()?.error;
  const recoveryRequired = () => uncertain || unresolved(receipt) || history.some(unresolved);
  const inputsValid = () => ALIAS.test(alias.value) && name.value.trim().length > 0 && name.value.trim().length <= 80;
  const canPlan = () => historyReady && !recoveryRequired() && online() && policy?.project_id && !policyUncertain && inputsValid();
  const deployable = () => deployablePlan() && !recoveryRequired()
    && online() && policy?.project_id === receipt.project_id && sameTarget(receipt, { ssh_alias: alias.value, name: name.value.trim(), project_id: policy.project_id })
    && sameActions([...approved], receipt.plan.actions.filter(item => item.privileged).map(item => item.id));
  action(sourceActions, '刷新别名与项目', loadSources, () => !recoveryRequired(), '请先核对原部署收据；不能更换来源绕过未知结果。');
  action(sourceActions, '初始化来源项目配对身份', initialize, () => online() && policy && !policy.project_id && !policyUncertain && !recoveryRequired()
    && policy.allowed_node_ids?.length === 0 && policy.default_node_id === 'local', '仅可在已确认在线、空授权且默认本机的未初始化项目上操作；结果未知时须先刷新来源。', '独立确认后初始化稳定配对 ID；保持空授权和本机默认，不启动后台、不授权节点。');
  action(sourceActions, '检查远端环境', plan, canPlan, '需要在线来源、稳定配对 ID、节点名称和安全 SSH 别名；未知操作必须先恢复核对。', '显式经 SSH 检查环境并取得部署计划；不安装、不配对、不自动接受未知主机密钥。');
  action(planActions, '确认部署', apply, deployable, '需要完整且无重复的当前计划与授权元数据，并逐项勾选全部 sudo 动作；旧计划、离线或未知结果不能部署。', '总确认覆盖冻结计划的全部动作，sudo 仍须逐项勾选；仅执行此收据与修订绑定的改动，不覆盖已有安装。');
  action(recoveryActions, '刷新收据', refreshReceipts, () => true, '', '只读取持久收据；不重发部署请求，不连接未知现场。');
  action(recoveryActions, '核对原部署现场', reconcile, () => Boolean(receipt) && receipt.status !== 'confirmed', '先从最近操作选择原收据；不会通过新计划替代原操作。', '核对同一收据的原部署结果，不重放安装，不自动确认身份。');
  action(identityActions, '确认此安装身份', confirmIdentity, () => receipt?.status === 'ready' && !uncertain && !history.some(unresolved) && Boolean(receipt.runner_id) && Boolean(receipt.node_id), '只有已验证 ready 收据且安装身份、节点 ID 完整时才能确认；未知结果须先核对。', '显式固定当前收据观测的 Runner 安装身份；不修改项目授权或默认节点。');

  function sync() {
    if (!current()) return;
    const locked = recoveryRequired();
    for (const { control, host } of fields) {
      control.disabled = busy || locked;
      if (control.disabled) { host.dataset.help = busy ? '请求尚未结束，请等待；不会重复提交。' : '原部署结果未知或仍在执行，先刷新收据或核对原现场。'; host.setAttribute('tabindex', '0'); }
      else { delete host.dataset.help; host.removeAttribute('tabindex'); }
    }
    for (const item of buttons) item.disable(busy || !item.allowed(), busy ? '请求尚未结束，请等待；不会重复提交或自动重试。' : item.reason);
    for (const item of historyControls) item.disable(busy);
    for (const input of planBody.querySelectorAll('input')) {
      input.disabled = busy || !deployablePlan();
      const host = input.parentNode;
      if (input.disabled) { host.dataset.help = busy ? '请求尚未结束，系统动作授权不能改变。' : '当前计划不可提交，请重新检查或核对收据。'; host.setAttribute('tabindex', '0'); }
      else { delete host.dataset.help; host.removeAttribute('tabindex'); }
    }
    source.textContent = row() ? `来源：${row().name || '未命名项目'} · Host ID ${row().id} · 配对 ID ${policy?.project_id || '尚未初始化或未确认'}${online() ? '' : ' · 未运行或不可达，不能检查或部署'}` : '请选择已登记的在线来源项目；Host 路由 ID 不是 Runner 配对 ID。';
  }
  function deployablePlan() { return receipt?.status === 'planned' && !uncertain && receipt.plan.supported === true && !receipt.plan.blockers.length && !planIssues(receipt.plan).length; }
  async function run(work, { write = false } = {}) {
    if (!current() || busy) return;
    busy = true; writeBusy = write; sync();
    try { await work(); }
    catch { if (current()) { status('部署向导请求未完成；保留当前输入，请显式核对后再操作。', true); } }
    finally { busy = false; writeBusy = false; sync(); }
  }
  function invalidate() {
    if (!current() || writeBusy || recoveryRequired()) return false;
    ++generation; receipt = null; pendingTarget = null; approved.clear(); renderReceipt(); status('输入已更改，旧部署计划和系统动作授权已失效。'); sync(); return true;
  }
  alias.oninput = () => { if (invalidate()) aliases.value = ''; };
  name.oninput = invalidate;
  aliases.onchange = () => { if (!invalidate()) return; alias.value = aliases.value; sync(); };
  project.onchange = () => {
    if (!invalidate()) return;
    selectedProject = project.value; policy = null; policyUncertain = false; sync();
    return run(async () => { await readPolicy(); });
  };
  function policyValid(value) { return value && revision(value.revision) && (value.project_id === null || typeof value.project_id === 'string') && Array.isArray(value.allowed_node_ids) && typeof value.default_node_id === 'string'; }
  async function readPolicy() {
    if (!online()) { policy = null; return; }
    const id = selectedProject, epoch = generation;
    try {
      const value = await adapter.project(id);
      if (!current() || epoch !== generation || selectedProject !== id) return;
      if (!policyValid(value)) throw new Error('invalid policy');
      policy = value; policyUncertain = false;
    } catch { if (current() && epoch === generation && selectedProject === id) { policy = null; status('来源项目读取失败；不会启动后台，也不能借用 Host ID 进行配对。', true); } }
  }
  async function loadSources() {
    return run(async () => {
      const epoch = ++generation; receipt = null; approved.clear(); renderReceipt();
      const results = await Promise.allSettled([Promise.resolve().then(() => adapter.discover()), Promise.resolve().then(() => adapter.projects())]);
      if (!current() || epoch !== generation) return;
      const discovered = results[0].status === 'fulfilled' ? results[0].value : null;
      aliases.replaceChildren(); const manual = el('option', '手填 SSH 别名'); manual.value = ''; aliases.append(manual);
      for (const item of Array.isArray(discovered?.aliases) ? discovered.aliases : []) {
        const value = typeof item === 'string' ? item : item?.alias;
        if (!ALIAS.test(value || '')) continue;
        const option = el('option', value); option.value = value; aliases.append(option);
      }
      discovery.textContent = discovered ? `SSH 配置：${text(discovered.status)}${discovered.limited ? ' · 仅受限发现，未执行配置命令或读取私钥' : ''}。选择或读取不连接 SSH，可手填别名。` : 'SSH 别名读取失败；仍可手填安全别名，不会自动连接。';
      const roster = results[1].status === 'fulfilled' ? results[1].value?.projects : null;
      projects = Array.isArray(roster) ? roster.filter(item => item && /^[a-f0-9]{16}$/.test(item.id)) : [];
      project.replaceChildren(); const empty = el('option', '请选择来源项目'); empty.value = ''; project.append(empty);
      for (const item of projects) { const option = el('option', `${item.name || '未命名项目'} · ${item.id}${item.running === true && !item.error ? '' : ' · 未运行或不可达'}`); option.value = item.id; project.append(option); }
      project.value = selectedProject; policy = null;
      if (!Array.isArray(roster)) status('项目列表读取失败；不能检查或部署，不会启动后台。', true);
      await readPolicy();
    });
  }
  async function initialize() {
    return run(async () => {
      const id = selectedProject, previous = policy, epoch = generation;
      const content = el('p', `仅初始化 ${row().name || '未命名项目'}（${id}）的配对身份；保持空授权、本机默认，不启动后台，不创建 Worker。`); confirmation = content;
      const accepted = await formDialog({ title: '初始化来源项目配对身份？', content, confirmLabel: '确认初始化配对身份' });
      confirmation = null;
      if (!accepted || !current() || epoch !== generation) return;
      writeBusy = true;
      try {
        const next = await adapter.initializeProject(id, previous.revision);
        if (!current() || epoch !== generation) return;
        if (!policyValid(next) || !next.project_id || next.revision <= previous.revision || next.allowed_node_ids.length || next.default_node_id !== 'local') throw new Error('unconfirmed initialization');
        policy = next; status('来源项目配对身份已初始化；仍为空授权、本机默认。');
      } catch { if (current()) { policyUncertain = true; status('初始化结果未确认；请显式刷新来源项目核对，不会自动重试或授权。', true); } }
    });
  }
  function accept(next, previous = null, mutation = false) {
    if (!validReceipt(next) || (previous && (next.id !== previous.id || !sameTarget(next, previous) || next.revision < previous.revision
      || (mutation && next.revision <= previous.revision) || (previous.runner_id && next.runner_id !== previous.runner_id) || (previous.node_id && next.node_id !== previous.node_id)))) throw new Error('unconfirmed receipt');
    if (previous && canonical(next.plan) !== canonical(previous.plan)) throw new Error('changed frozen plan');
    const submitted = submittedActions.get(next.id);
    if (submitted && (next.status === 'planned' || canonical(next.plan) !== submitted.plan)) throw new Error('changed submitted plan or stale pre-apply receipt');
    const expectedActions = submitted?.actions || (['planned', 'blocked'].includes(next.status) ? [] : (Array.isArray(next.plan.actions) ? next.plan.actions.map(item => item?.id) : []));
    if (Object.hasOwn(next, 'approved_actions') && !sameActions(next.approved_actions, expectedActions)) throw new Error('changed authorization');
    if (previous && Object.hasOwn(previous, 'approved_actions') && !Object.hasOwn(next, 'approved_actions')) throw new Error('missing authorization evidence');
    if (previous && next.revision === previous.revision && canonical(next) !== canonical(previous)) throw new Error('changed revision');
    receipt = structuredClone(next); uncertain = false; pendingTarget = null; approved.clear();
    history = history.filter(item => item.id !== next.id); history.unshift(receipt);
    renderReceipt(); renderHistory();
  }
  async function plan() {
    return run(async () => {
      const epoch = generation, target = { ssh_alias: alias.value, name: name.value.trim(), project_id: policy.project_id };
      pendingTarget = target; pendingKnown = new Map(history.map(item => [item.id, item.revision])); receipt = null; approved.clear(); renderReceipt();
      try {
        const next = await adapter.plan(target);
        if (!current() || epoch !== generation) return;
        if (!validReceipt(next) || !sameTarget(next, target) || !['planned', 'blocked'].includes(next.status)) throw new Error('unconfirmed plan');
        accept(next); status('环境检查已返回；请核对系统改动，尚未部署。');
      } catch { if (current() && epoch === generation) { uncertain = true; status('环境检查结果未确认；请刷新最近收据找到原操作，不能新开计划绕过未知结果。', true); } }
    });
  }
  async function apply() {
    return run(async () => {
      const previous = receipt, actions = previous.plan.actions.map(item => item.id);
      submittedActions.set(previous.id, { actions: [...actions], plan: canonical(previous.plan) });
      // Forget grants before awaiting; an unknown result never leaves a reusable sudo approval.
      approved.clear(); sync();
      try {
        const next = await adapter.apply({ id: previous.id, expected_revision: previous.revision, approved_actions: actions, confirm: true });
        if (!current()) return;
        if (!['running', 'ready', 'failed', 'unknown', 'blocked'].includes(next?.status)) throw new Error('false ACK');
        accept(next, previous, true); status(`部署收据：${STATES[receipt.status]}；不会自动重试或自动确认身份。`, ['failed', 'unknown', 'blocked'].includes(receipt.status)); notify();
      } catch { if (current()) { uncertain = true; renderReceipt(); status('部署结果未确认；已清空系统动作选择。只可刷新收据或核对原部署现场，不会重放安装。', true); } }
    }, { write: true });
  }
  async function reconcile() {
    return run(async () => {
      const previous = receipt;
      try { const next = await adapter.reconcile({ id: previous.id, expected_revision: previous.revision }); if (!current()) return; accept(next, previous); status(`已核对原操作：${STATES[receipt.status]}；没有重发部署。`, unresolved(receipt) || receipt.status === 'failed'); notify(); }
      catch { if (current()) { uncertain = true; status('原部署现场仍未确认；保留收据，不自动重试。', true); } }
    }, { write: true });
  }
  async function confirmIdentity() {
    return run(async () => {
      const previous = receipt;
      try {
        const next = await adapter.confirm({ id: previous.id, expected_revision: previous.revision, runner_id: previous.runner_id, confirm: true });
        if (!current()) return;
        if (next?.status !== 'confirmed') throw new Error('false identity ACK');
        accept(next, previous, true); status('安装身份已确认；项目授权和默认节点尚未改变，不会创建 Worker。'); notify();
      } catch { if (current()) { uncertain = true; status('身份确认结果未确认；请核对原收据，不会自动再次提交或修改授权。', true); } }
    }, { write: true });
  }
  function notify() {
    if (!receipt?.node_id || !['ready', 'confirmed'].includes(receipt.status)) return;
    try { Promise.resolve(onChanged()).catch(() => {}); } catch { /* Parent refresh is not a deployment ACK. */ }
  }
  async function readReceipts() {
    const result = await adapter.receipts();
    if (!current()) return;
    if (result?.version !== 1 || !Array.isArray(result.items) || typeof result.truncated !== 'boolean' || !result.items.every(validReceipt)) throw new Error('invalid receipts');
    historyReady = true; history = result.items.map(item => structuredClone(item));
    historyStatus.textContent = result.truncated ? '最近操作列表已截断，不代表完整历史。' : '最近操作；读取不连接远端，不重放部署。';
    if (receipt) {
      const found = history.find(item => item.id === receipt.id);
      if (found) { accept(found, receipt); status(`已读取原收据：${STATES[receipt.status]}；没有重发部署或自动确认身份。`, ['failed', 'unknown', 'blocked'].includes(receipt.status)); }
      else if (uncertain || unresolved(receipt)) status('最近列表未包含原收据；列表缺失不能证明部署未执行，请核对原部署现场。', true);
    }
    renderHistory();
    if (history.some(unresolved)) { historyBox.open = true; status('存在执行中或未知部署，先恢复原收据核对；不能新建计划绕过。', true); }
  }
  async function refreshReceipts() {
    return run(async () => {
      try { await readReceipts(); }
      catch { if (current()) { if (receipt || pendingTarget) { uncertain = true; approved.clear(); renderReceipt(); } status('收据读取失败或修订不一致；保留当前结果，不重发部署。', true); } }
    });
  }
  function restore(item) {
    if (!current() || busy) return;
    if ((uncertain || unresolved(receipt)) && receipt && receipt.id !== item.id) { status('请先核对当前原收据，不能用另一条操作替代未知结果。', true); return; }
    if (uncertain && !receipt && pendingTarget && (!sameTarget(item, pendingTarget) || (pendingKnown.has(item.id) && item.revision <= pendingKnown.get(item.id)))) { status('此收据不匹配原未知请求，或只是请求前的旧修订；不能代替原操作。', true); return; }
    try {
      if (receipt?.id === item.id) accept(item, receipt); else accept(item);
      alias.value = item.ssh_alias; name.value = item.name; aliases.value = '';
      if (policy?.project_id !== item.project_id) { selectedProject = ''; project.value = ''; policy = null; }
      status(`已恢复原收据：${STATES[receipt.status]}。刷新和核对不会重发部署。`, unresolved(receipt)); sync();
    } catch { status('无法采用此收据：身份或修订不一致。', true); }
  }
  function renderHistory() {
    historyList.replaceChildren(); historyControls = [];
    for (const item of history) {
      const li = el('li'); li.append(el('p', `${item.name} · ${item.ssh_alias} · ${STATES[item.status]} · 修订 ${item.revision}`));
      const control = runnerButton('恢复此操作', () => restore(item), '载入同一持久收据；不创建新计划、不安装、不自动确认身份。');
      historyControls.push(control); control.disable(busy); li.append(control.host); historyList.append(li);
    }
  }
  function renderReceipt() {
    const paint = ++receiptPaint;
    planBody.replaceChildren(); deployment.replaceChildren(); identity.replaceChildren();
    if (!receipt) { planBody.append(el('p', '显式检查后，在这里核对环境、文件改动和系统动作。')); deployment.append(el('p', '尚未提交部署；不会自动上传或安装。')); identity.append(el('p', '验证后显示观测安装身份，仍需独立确认。')); return; }
    planBody.append(el('p', `收据 ${receipt.id} · 修订 ${receipt.revision} · ${STATES[receipt.status]}`), el('p', `配对项目 ID：${receipt.project_id}`));
    const preview = receipt, p = preview.plan, target = p.target || {};
    for (const [key, value] of [['远端系统／架构', `${text(target.os)} / ${text(target.arch)}`], ['远端用户', `${text(target.user)} (UID ${text(target.uid)})`], ['安装目录', p.install_root], ['运行包来源', p.runtime?.source]]) planBody.append(el('p', `${key}：${text(value)}`));
    if (Object.hasOwn(p, 'node_budgets')) {
      const limits = el('div', undefined, 'runner-deploy-node-budgets');
      limits.append(el('h4', '固定节点执行上限'), el('p', '以下为本次冻结计划的上限，不是 CPU／内存配额；不会用当前设备默认值替代。', 'hint'));
      for (const [key, label, unit] of [['max_commands', '并发命令', '条'], ['timeout_ms', '单命令时限', '毫秒'], ['output_bytes', '单命令输出', '字节']]) {
        const value = p.node_budgets?.[key];
        limits.append(el('p', `${label}：${Number.isSafeInteger(value) && value > 0 ? `${value} ${unit}` : '未提供或无效'}`));
      }
      planBody.append(limits);
    }
    const observations = el('div', undefined, 'runner-deploy-observations');
    observations.append(el('h4', '依赖与 cgroup 环境观测'), el('p', '以下仅是环境观测，不构成系统动作授权、部署成功或进程停止证明。', 'hint'));
    const dependencies = Array.isArray(p.dependencies) ? p.dependencies.filter(item => item && typeof item.name === 'string' && item.name.trim()) : [];
    for (const required of ['Git', 'Bun']) if (!dependencies.some(item => item.name.trim().toLowerCase() === required.toLowerCase())) dependencies.push({ name: required, status: 'unknown' });
    for (const item of dependencies) {
      const observed = Object.hasOwn(DEPENDENCY_STATES, item.status) ? item.status : 'unknown';
      const line = el('p', `依赖 ${item.name}：${DEPENDENCY_STATES[observed]}${item.version ? ` · 版本 ${text(item.version)}` : ''}${item.message ? ` · ${text(item.message)}` : ''}`, ['unsupported', 'unknown'].includes(observed) ? 'error' : '');
      line.dataset.deployDependency = item.name; observations.append(line);
    }
    const cgroup = p.cgroup || {}, observed = Object.hasOwn(CGROUP_STATES, cgroup.status) ? cgroup.status : 'unknown';
    const cgroupLine = el('p', `cgroup v2 状态：${CGROUP_STATES[observed]}${cgroup.path ? ` · 路径 ${text(cgroup.path)}` : ''}${cgroup.message ? ` · ${text(cgroup.message)}` : ''}`, ['unsupported', 'unknown'].includes(observed) ? 'error' : '');
    cgroupLine.dataset.deployCgroup = ''; observations.append(cgroupLine); planBody.append(observations);
    if (p.supported !== true) planBody.append(el('p', '此环境未确认支持部署；请按阻塞指引处理，不能覆盖未知安装。', 'error'));
    for (const blocker of p.blockers) planBody.append(el('p', `${text(blocker.code)}：${text(blocker.message)}`, 'error'));
    for (const issue of planIssues(p)) planBody.append(el('p', `授权预览阻塞：${issue}`, 'runner-deploy-plan-issue error'));
    const files = el('div'); files.append(el('h4', '确切文件改动'));
    for (const file of p.files) files.append(el('p', text(file)));
    if (!p.files.length) files.append(el('p', '无文件改动；未提供的改动不得据此推定授权。')); planBody.append(files);
    planBody.append(renderRunnerActions(p, { prefix: 'runner-deploy', confirmLabel: '确认部署', onToggle(item, input) {
      if (!current() || busy || receipt !== preview || receiptPaint !== paint || !deployablePlan()) return;
      if (input.dataset.deployAction !== item.id) { approved.clear(); renderReceipt(); status('授权 ID 与冻结计划不一致；已清空选择，不能提交未知动作。', true); }
      else if (input.checked) approved.add(item.id); else approved.delete(item.id);
      sync();
    } }));
    const advanced = runnerDetails('版本、摘要与高级信息');
    for (const [label, value] of [['Runtime', p.runtime], ['Runner', p.runner]]) advanced.append(el('p', `${label}：版本 ${text(value?.version)} · SHA256 ${text(value?.sha256)} · 字节 ${text(value?.size)}`));
    advanced.append(el('p', `远端 home：${text(target.home)}`), el('p', `创建 ${text(receipt.created_at)} · 更新 ${text(receipt.updated_at)}`)); planBody.append(advanced);
    for (const stage of receipt.stages) deployment.append(el('p', `${text(stage.id)}：${text(stage.status)} · ${text(stage.message)}`, ['failed', 'unknown', 'blocked'].includes(stage.status) ? 'error' : ''));
    if (!receipt.stages.length) deployment.append(el('p', '上传／安装／凭据配对／握手／受控执行停止验证：尚无阶段结果。'));
    if (uncertain || unresolved(receipt)) deployment.prepend(el('p', '结果未知或仍在执行：不代表安装成功或进程已停止。只核对原收据，不重放安装。', 'error'));
    identity.append(el('p', `观测 Runner 安装身份：${text(receipt.runner_id)}`), el('p', `节点 ID：${text(receipt.node_id)}`), el('p', '确认身份不会授权项目、改默认节点或创建 Worker。'));
    if (selectedProject && policy?.project_id === receipt.project_id) { const link = el('a', `管理来源项目授权：${row()?.name || selectedProject}`, 'nav-link'); link.href = runnersLink(selectedProject); identity.append(link); }
    else identity.append(el('p', `请在执行节点页选择配对 ID 为 ${receipt.project_id} 的真实来源项目，单独管理授权和默认节点。`));
  }
  function dispose() { life.dispose(); ++generation; approved.clear(); submittedActions.clear(); closeRunnerDialog(confirmation); confirmation = null; ownerWindow?.removeEventListener?.('pagehide', dispose); }
  ownerWindow?.addEventListener?.('pagehide', dispose);
  renderReceipt();
  const ready = (async () => {
    await loadSources();
    if (!current()) return;
    await refreshReceipts();
  })();
  return { root, ready, dispose };
}
