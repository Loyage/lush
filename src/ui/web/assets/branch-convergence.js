import { el, button, badge, block } from './dom.js';
import { api, action } from './api.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { show } from './messages.js';
import { absolute } from './format.js';
import { workerLabel } from './worker-label.js';
import { bindWorkerPreview } from './entity-preview.js';
import { validCommands } from './shortcut-command-model.js';

export const CONVERGENCE_STATES = {
  preparing: '归并中', resolving: '整合中', awaiting: '等待决定', validating: '验证中', ready: '等待落地',
  landing: '发布中', integrated: '已合并', failed: '失败', blocked: '落地待核查', withdrawn: '已撤回', stale: '已失效',
};
const ACTIVE_STATES = ['preparing', 'resolving', 'awaiting', 'validating', 'ready', 'landing', 'failed', 'blocked'];
const VALIDATION_STATES = {
  pending: '等待验证', waiting: '等待验证', running: '验证中', validating: '验证中',
  succeeded: '通过', passed: '通过', pass: '通过', failed: '失败', fail: '失败',
  blocked: '验证受阻', not_started: '尚未执行', unknown: '结果未知', cancelled: '已中断',
};
const positive = value => Number.isSafeInteger(value) && value > 0;
const string = value => typeof value === 'string' && value.length > 0;
const reference = value => value === null || (string(value?.command_id) && positive(value.command_version));
const refKey = value => value ? `${value.command_id}:${value.command_version}` : '';
const refOnly = value => value ? { command_id: value.command_id, command_version: value.command_version } : null;
const sameRef = (a, b) => refKey(a) === refKey(b);
const validPolicy = (value, branch = value?.branch) => value?.version === 1 && string(branch) && value.branch === branch
  && positive(value.owner_id) && typeof value.enabled === 'boolean' && typeof value.editable === 'boolean'
  && string(value.revision) && reference(value.validation);
const COMPATIBILITY = '分支归并数据不可用或版本不兼容，请更新项目后台与界面服务后重新读取。';
const ENABLE_HELP = agentHelp('为这个目标分支启用新交付的归并；冲突时可能创建专用整合 Worker，最终验证通过后每批产生一个提交。不改变 Worker 的合并或验收授权。');
const DISABLE_HELP = '关闭这个分支未来新交付的归并；已经固定或开始的归并仍按原协议收口，不撤回交付，不修改 Worker 自动合并或验收授权。';
const REFRESH_HELP = '只重新读取所选分支的配置与批次，不运行归并、验证或 Agent；放弃未保存选择前会确认。';
const MORE_HELP = '按这个分支的持久游标读取更早批次，只读历史，不运行归并、验证或 Agent。';

function field(label, input) {
  const node = el('label', label, 'hook-field'); input.setAttribute('aria-label', label); node.append(input); return node;
}
function workerLink(row, prefix = '') {
  const link = el('a', `${prefix}${workerLabel(row)}${row.title ? ` · ${row.title}` : ''}`, 'convergence-worker-link');
  link.href = `#worker-${row.id}`; link.setAttribute('href', link.href); bindWorkerPreview(link, row); return link;
}

/** Read-only cards: an intermediate combination never masquerades as a landed delivery. */
export function renderConvergenceRun(run, { retry, unavailable = () => null } = {}) {
  const card = el('article', undefined, 'hook-mount convergence-run'); card.dataset.runId = String(run.id);
  const head = el('div', undefined, 'hook-mount-head');
  head.append(el('strong', `归并批次 ${run.id}`), badge(Object.hasOwn(CONVERGENCE_STATES, run.state) ? CONVERGENCE_STATES[run.state] : `未知阶段：${run.state ?? '未提供'}`,
    run.state === 'integrated' ? 'b-completed' : ['failed', 'blocked', 'awaiting'].includes(run.state) ? 'b-awaiting' : 'b-neutral'));
  card.append(head, el('p', `目标：${run.target_branch} · ${Number.isSafeInteger(run.member_count) && run.member_count >= 0 ? run.member_count : '未知数量的'} 项成果 · ${absolute(run.updated_at || run.created_at)}`, 'hint'));
  const members = el('ul', undefined, 'convergence-members');
  for (const row of Array.isArray(run.members) ? run.members : []) {
    if (!positive(row?.id)) continue;
    const item = el('li'); item.append(workerLink(row)); members.append(item);
  }
  card.append(members);
  if (!Array.isArray(run.members)) card.append(el('p', '成员摘要尚未提供，不能推断完整交付范围。', 'hint'));
  if (run.members_truncated) card.append(el('p', '成员摘要已截断，不能据此推断完整交付范围。', 'hint'));
  if (run.error) card.append(el('p', run.error, 'error convergence-run-error'));
  if (run.state === 'blocked') card.append(el('p', '父侧落地结果需核查；不能通过重试盲目重放。', 'error'));
  if (run.validation) {
    card.append(el('p', `最终验证：${run.validation.command_name || '名称未知'} · ${Object.hasOwn(VALIDATION_STATES, run.validation.state) ? VALIDATION_STATES[run.validation.state] : `未知状态：${run.validation.state ?? '未提供'}`}`, 'convergence-validation'));
    if (run.validation.started_at || run.validation.finished_at) card.append(el('p', `开始 ${absolute(run.validation.started_at)} · 结束 ${absolute(run.validation.finished_at)}`, 'hint'));
    if (run.validation.error) card.append(el('p', run.validation.error, 'error'));
  } else card.append(el('p', '最终验证记录尚未提供，不代表验证通过。', 'hint'));
  if (positive(run.integration_worker?.id)) card.append(workerLink(run.integration_worker, '整合 Worker：'));
  const sources = (Array.isArray(run.members) ? run.members : []).filter(row => positive(row?.id) && string(row.source_commit));
  if (run.baseline || run.commit || sources.length) {
    const evidence = el('details', undefined, 'convergence-evidence'); evidence.append(el('summary', '固定提交'));
    if (run.baseline) evidence.append(el('p', `父基线：${run.baseline}`, 'convergence-sha'));
    if (run.commit) evidence.append(el('p', `${run.state === 'integrated' ? '落地提交' : '候选提交（尚未确认落地）'}：${run.commit}`, 'convergence-sha'));
    for (const row of sources) evidence.append(el('p', `成员 ${workerLabel(row)} · 交付 ${positive(row.delivery_id) || string(row.delivery_id) ? row.delivery_id : '编号未知'} · 源提交：${row.source_commit}`, 'convergence-sha'));
    card.append(evidence);
  }
  if (retry && ['failed', 'awaiting', 'stale'].includes(run.state)) {
    const help = agentHelp('按这份批次的精确版本重新核验来源和验证授权，必要时调用整合 Worker；不重放未知落地副作用。');
    const host = el('span', undefined, 'help-host'), control = button('重试归并', () => retry(run), 'ghost hook-button', { agent: true, help });
    const sync = () => { const reason = unavailable() || (!string(run.revision) ? '批次版本不可用，请重新读取。' : null); control.disabled = !!reason; host.tabIndex = reason ? 0 : -1; host.setAttribute('data-help', `${reason || ''} ${help}`); };
    const click = control.onclick; control.onclick = async () => { await click(); sync(); }; sync(); host.append(control); card.append(host); card.syncControls = sync;
  }
  return card;
}

/** Page-owned, retained component; no background polling or implicit command authorization. */
export function renderBranchConvergence({ catalogue, ownsPage, busy = () => false, setBusy = () => {}, setEditing = () => {} }) {
  const node = block('分支归并'); node.classList.add('branch-convergence');
  const branch = el('select'), enabled = el('input'); enabled.type = 'checkbox';
  const command = el('select');
  const status = el('p', '正在读取分支…', 'hint convergence-policy-status'); status.setAttribute('role', 'status');
  const feedback = el('p', undefined, 'convergence-feedback'); feedback.setAttribute('role', 'status');
  const summary = el('p', undefined, 'hint convergence-counts');
  const editor = el('div', undefined, 'convergence-editor');
  const history = el('div', undefined, 'convergence-history');
  const historyStatus = el('p', undefined, 'hint convergence-history-status'); historyStatus.setAttribute('role', 'status');
  const list = el('div', undefined, 'convergence-runs');
  const drafts = new Map(), acknowledgedRetries = new Set();
  let disposed = false, generation = 0, listRequest = 0, historyRequest = 0, selected = '', model = null, draft = null;
  let commands = catalogue.commands, commandChoices = new Map(), loaded = false, loading = false, saving = false, runsLoading = false, cursor = null, hasMore = false, cards = [];
  const owns = () => !disposed && ownsPage();
  const current = (target, request) => owns() && target === selected && request === generation;
  const dirtyDraft = value => !!value && (value.enabled !== value.baseEnabled || !sameRef(value.validation, value.baseValidation));
  const newDraft = policy => ({ enabled: policy.enabled, validation: refOnly(policy.validation), revision: policy.revision,
    baseEnabled: policy.enabled, baseValidation: refOnly(policy.validation) });
  const dirty = () => dirtyDraft(draft);
  const chosenCommand = () => validCommands(commands) ? commands.items.find(item => refKey({ command_id: item.id, command_version: item.version }) === refKey(draft?.validation) && item.authorized) : null;
  function updateEditing() { if (owns()) setEditing([...drafts.values()].some(dirtyDraft)); }
  function saveIssue() {
    if (saving || busy()) return '正在确认或保存，请稍候。';
    if (!loaded || !model || !draft || loading) return '请先成功读取这个分支的配置。';
    if (!model.editable) return model.reason || '这个分支当前不可编辑。';
    if (draft.enabled && !chosenCommand()) return validCommands(commands) ? '请明确选择已授权快捷指令的精确版本；不会自动升级或授权。' : '快捷指令目录不可用，请刷新后再启用。';
    if (!dirty()) return '配置没有变化。';
    return null;
  }
  function sync() {
    if (!owns()) return;
    enabled.disabled = command.disabled = !model || loading || saving || busy() || model.editable !== true;
    const reason = saveIssue(); save.disabled = !!reason; saveHost.tabIndex = reason ? 0 : -1;
    const agent = draft?.enabled === true;
    save.classList.toggle('agent-call', agent);
    const help = agent ? ENABLE_HELP : DISABLE_HELP; save.setAttribute('data-help', help); saveHost.setAttribute('data-help', `${reason || ''} ${help}`);
    refresh.disabled = saving || busy(); refreshHost.tabIndex = refresh.disabled ? 0 : -1;
    refreshHost.setAttribute('data-help', `${refresh.disabled ? '正在确认或保存，请稍候。' : ''} ${REFRESH_HELP}`);
    more.disabled = runsLoading || saving || busy() || !hasMore; more.hidden = moreHost.hidden = !hasMore;
    moreHost.tabIndex = more.disabled && hasMore ? 0 : -1; moreHost.setAttribute('data-help', `${more.disabled && hasMore ? '正在读取或处理操作，请稍候。' : ''} ${MORE_HELP}`);
    node.setAttribute('aria-busy', String(loading || runsLoading || saving));
    for (const card of cards) card.syncControls?.();
    updateEditing();
  }
  function paintCommands() {
    const choices = [el('option', '请选择已授权验证指令')]; choices[0].value = '';
    const available = validCommands(commands) ? commands.items.filter(item => item.authorized) : [];
    commandChoices = new Map();
    for (const item of available) {
      const ref = { command_id: item.id, command_version: item.version }, key = refKey(ref);
      const option = el('option', `${item.name} · v${item.version}`); option.value = key; choices.push(option); commandChoices.set(key, ref);
    }
    for (const ref of [model?.validation, draft?.validation]) {
      const key = refKey(ref); if (!key || commandChoices.has(key)) continue;
      const option = el('option', `${sameRef(ref, model?.validation) ? model.validation.name || ref.command_id : ref.command_id} · v${ref.command_version}（不可用，不会自动升级）`);
      option.value = key; choices.push(option); commandChoices.set(key, refOnly(ref));
    }
    command.replaceChildren(...choices); command.value = refKey(draft?.validation);
  }
  function paintPolicy() {
    enabled.checked = draft?.enabled === true; paintCommands();
    status.textContent = model ? `${selected} · 已保存：${model.enabled ? '开启' : '关闭'}${model.validation ? ` · 验证：${model.validation.name || model.validation.command_id} v${model.validation.command_version}${model.validation.authorized === false ? '（未授权或版本已失效）' : ''}` : ' · 尚未配置验证指令'}` : `${selected || '目标分支'} · 配置尚未成功读取`;
    const counts = model?.counts;
    summary.textContent = counts && ACTIVE_STATES.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
      ? ACTIVE_STATES.filter(key => counts[key] > 0).map(key => `${CONVERGENCE_STATES[key]} ${counts[key]}`).join(' · ') || '当前没有活动归并批次。'
      : '完整批次统计不可用，不从当前页记录推断。';
    if (model?.reason) feedback.textContent = model.reason;
    sync();
  }
  async function loadRuns(morePage = false, target = selected, request = generation) {
    if (!current(target, request) || (morePage && (runsLoading || !hasMore))) return;
    const historyId = ++historyRequest, before = morePage ? cursor : null;
    runsLoading = true; historyStatus.textContent = morePage ? '正在读取更早批次…' : '正在读取批次记录…'; sync();
    try {
      const page = await api(`/api/branch-convergence/runs?branch=${encodeURIComponent(target)}&limit=20${before ? `&before=${before}` : ''}`);
      if (!current(target, request) || historyId !== historyRequest) return;
      if (page?.version !== 1 || page.branch !== target || !Array.isArray(page.items) || typeof page.has_more !== 'boolean'
        || (page.has_more && (!positive(page.next_before) || (before && page.next_before >= before)))
        || !page.items.every((run, index) => positive(run?.id) && run.target_branch === target && (!before || run.id < before) && (!index || run.id < page.items[index - 1].id))) throw new Error(COMPATIBILITY);
      const nextCards = page.items.map(run => renderConvergenceRun(run, { retry: retryRun, unavailable: () =>
        acknowledgedRetries.has(`${run.id}:${run.revision}`) ? '这份批次的重试已接受；请重新读取最新批次版本，不要重发。' : saving || busy() || !owns() ? '正在处理操作或页面已离开。' : null }));
      if (!morePage) { list.replaceChildren(); cards = []; }
      list.append(...nextCards); cards.push(...nextCards); cursor = page.next_before; hasMore = page.has_more;
      historyStatus.textContent = cards.length ? `已显示 ${cards.length} 个批次${hasMore ? '，可加载更早记录。' : '。'} 只读刷新，不执行动作。` : '这个分支尚无归并批次。';
      historyStatus.className = 'hint convergence-history-status'; return true;
    } catch (error) {
      if (current(target, request) && historyId === historyRequest) { historyStatus.textContent = `批次读取失败：${error.message}${cards.length ? '；已加载旧记录保留。' : ''}`; historyStatus.className = 'error convergence-history-status'; }
      return false;
    } finally { if (current(target, request) && historyId === historyRequest) { runsLoading = false; sync(); } }
  }
  async function selectBranch(target, { reset = false } = {}) {
    if (!owns() || !target) return;
    selected = target; branch.value = target; const request = ++generation; ++historyRequest;
    model = null; draft = null; loading = true; runsLoading = false; cursor = null; hasMore = false; cards = []; list.replaceChildren(); feedback.textContent = ''; historyStatus.textContent = '';
    if (reset) drafts.delete(target);
    paintPolicy();
    try {
      const policy = await api(`/api/branch-convergence?branch=${encodeURIComponent(target)}`);
      if (!current(target, request)) return;
      if (!validPolicy(policy, target)) throw new Error(COMPATIBILITY);
      model = policy; const previous = drafts.get(target); draft = dirtyDraft(previous) ? previous : newDraft(policy);
      drafts.set(target, draft); paintPolicy();
      await loadRuns(false, target, request);
    } catch (error) { if (current(target, request)) { feedback.textContent = `配置读取失败：${error.message}；不使用默认值覆盖已有配置。`; feedback.className = 'error convergence-feedback'; } }
    finally { if (current(target, request)) { loading = false; paintPolicy(); } }
  }
  async function refreshSelected() {
    if (!owns() || saving || busy()) return;
    const target = selected, request = generation;
    if (dirty() && !await confirmDialog({ title: '放弃未保存的分支归并设置并刷新？', message: '只重新读取这个分支的配置与批次，不执行归并；当前未保存选择会丢失。', confirmLabel: '放弃并刷新' })) return;
    if (!current(target, request)) return;
    await selectBranch(target, { reset: true });
  }
  async function savePolicy() {
    if (!owns() || saveIssue()) return;
    const target = selected, request = generation, params = { branch: target, enabled: draft.enabled, validation: refOnly(draft.validation), expected_revision: draft.revision };
    saving = true; setBusy(true); sync(); let acknowledged = false;
    try {
      if (params.enabled && !await confirmDialog({ title: `开启 ${target} 的归并？`,
        message: agentHelp('新固定的交付成果会在隔离区归并，每批在这个目标分支形成一个单父 Squash 提交；冲突时可能创建整合 Worker。最终验证在隔离检出中以 daemon 用户权限执行，不是沙箱。不会改变任何 Worker 的合并或验收授权。'),
        detail: `验证指令：${chosenCommand()?.name || '未知'} · v${params.validation.command_version}\n已开始的旧协议请求仍按原协议收口。`,
        confirmLabel: '确认开启归并', agent: true, confirmHelp: ENABLE_HELP })) return;
      if (!current(target, request)) return;
      if (params.enabled && !chosenCommand()) throw new Error('所选指令的精确版本已失效或撤权，请明确重新选择已授权版本。');
      const result = await action('branch.convergence_set', params, { refresh: false }); acknowledged = true;
      if (!current(target, request)) {
        if (owns() && validPolicy(result, target)) {
          drafts.set(target, newDraft(result));
          if (selected === target) await selectBranch(target, { reset: true });
        }
        return;
      }
      if (!validPolicy(result, target)) throw new Error('保存已确认，但返回配置不兼容，请只读刷新核查。');
      model = result; draft = newDraft(result); drafts.set(target, draft);
      feedback.className = 'convergence-feedback hint'; feedback.textContent = '分支归并设置已保存；关闭不撤回已固定交付。'; paintPolicy(); show(feedback.textContent);
      // Keep the acknowledged model/draft even if the authoritative post-save read fails.
      try {
        const fresh = await api(`/api/branch-convergence?branch=${encodeURIComponent(target)}`);
        if (!current(target, request)) return;
        if (!validPolicy(fresh, target)) throw new Error(COMPATIBILITY);
        model = fresh; draft = newDraft(fresh); drafts.set(target, draft); paintPolicy();
        if (await loadRuns(false, target, request) === false && current(target, request)) {
          feedback.className = 'error convergence-feedback'; feedback.textContent = '设置已保存，但批次刷新失败；请只读刷新记录，不要重复保存。';
        }
      } catch (error) { if (current(target, request)) { feedback.className = 'error convergence-feedback'; feedback.textContent = `设置已保存，但刷新失败：${error.message}；不要重复保存，请重新读取确认。`; show(feedback.textContent, 'error'); } }
    } catch (error) { if (current(target, request)) { feedback.className = 'error convergence-feedback'; feedback.textContent = acknowledged ? `保存已确认，但后续读取失败：${error.message}；请只读刷新核查，不要重复保存。` : `保存失败：${error.message}；分支与选择已保留，版本冲突请先重新读取。`; show(feedback.textContent, 'error'); } }
    finally { saving = false; setBusy(false); if (owns()) sync(); }
  }
  async function retryRun(run) {
    if (!owns() || saving || busy() || !string(run.revision) || acknowledgedRetries.has(`${run.id}:${run.revision}`) || !['failed', 'awaiting', 'stale'].includes(run.state)) return;
    const target = selected, request = generation; saving = true; setBusy(true); sync(); let acknowledged = false;
    try {
      if (!await confirmDialog({ title: `重试归并批次 ${run.id}？`, message: agentHelp('重新核验精确来源、批次版本与验证授权，必要时安排整合 Worker。未知落地副作用不会重放；未处理的待决须先明确答复。'), confirmLabel: '确认重试归并', agent: true, confirmHelp: agentHelp('重试这个固定批次的整合与验证，可能启动 Agent；不重放未知发布副作用。') }) || !current(target, request)) return;
      await action('branch.convergence_retry', { id: run.id, expected_revision: run.revision }, { refresh: false }); acknowledged = true;
      acknowledgedRetries.add(`${run.id}:${run.revision}`);
      if (current(target, request)) {
        show('归并重试请求已接受，不代表已经落地。');
        if (await loadRuns(false, target, request) === false && current(target, request)) show('重试已接受，但批次刷新失败；请只读刷新，不要重发。', 'error');
      }
    } catch (error) { if (current(target, request)) show(acknowledged ? `重试已接受，但刷新失败：${error.message}；请只读刷新，不要重发。` : `重试失败：${error.message}；已有记录保留。`, 'error'); }
    finally { saving = false; setBusy(false); if (owns()) sync(); }
  }
  async function loadBranches() {
    if (!owns()) return;
    const request = ++listRequest;
    try {
      const page = await api('/api/branch-convergence');
      if (!owns() || request !== listRequest) return;
      if (page?.version !== 1 || !Array.isArray(page.items) || !page.items.every(item => validPolicy(item)) || !Number.isSafeInteger(page.count) || typeof page.truncated !== 'boolean') throw new Error(COMPATIBILITY);
      const items = [...page.items].sort((a, b) => a.branch === 'main' ? -1 : b.branch === 'main' ? 1 : a.branch.localeCompare(b.branch));
      branch.replaceChildren(...items.map(item => { const option = el('option', item.branch); option.value = item.branch; return option; }));
      loaded = true; branch.disabled = false;
      if (page.truncated) node.append(el('p', `分支列表已截断：显示 ${items.length} / ${page.count}，不能据此推断全部策略。`, 'hint'));
      if (!items.length) { status.textContent = '没有可设置归并的活动本地分支。'; branch.disabled = true; sync(); return; }
      await selectBranch(items.find(item => item.branch === selected)?.branch || items[0].branch);
    } catch (error) { if (owns() && request === listRequest) { loaded = false; branch.disabled = true; feedback.textContent = `分支归并读取失败：${error.message}`; feedback.className = 'error convergence-feedback'; status.textContent = '无法确认分支归并策略；不会把缺字段当作默认关闭。'; sync(); } }
  }
  const save = button('保存分支归并设置', savePolicy, 'hook-button'), saveHost = el('span', undefined, 'help-host'); saveHost.append(save);
  const refresh = button('重新读取分支归并', () => loaded && selected ? refreshSelected() : loadBranches(), 'ghost hook-button', { help: REFRESH_HELP });
  const refreshHost = el('span', undefined, 'help-host'); refreshHost.append(refresh);
  const more = button('加载更早归并批次', () => loadRuns(true), 'ghost hook-button', { help: MORE_HELP }); more.hidden = true;
  const moreHost = el('span', undefined, 'help-host'); moreHost.append(more); moreHost.hidden = true;
  enabled.onchange = () => { if (!owns() || !draft || enabled.disabled) return; draft.enabled = enabled.checked; feedback.textContent = ''; sync(); };
  command.onchange = () => {
    if (!owns() || !draft || command.disabled) return;
    if (command.value && !commandChoices.has(command.value)) { command.value = refKey(draft.validation); return; }
    draft.validation = refOnly(commandChoices.get(command.value)); feedback.textContent = ''; sync();
  };
  branch.onchange = () => selectBranch(branch.value);
  const toggle = field('对新交付开启归并', enabled); toggle.classList.add('convergence-toggle');
  editor.append(field('目标分支', branch), field('最终验证快捷指令', command), toggle);
  const controls = el('div', undefined, 'actions'); controls.append(saveHost, refreshHost);
  history.append(el('h3', '当前与历史批次'), historyStatus, list, moreHost);
  node.append(el('p', '按目标分支设置，默认关闭、不继承。只处理交付到所选分支的新固定成果；不修改 Worker 自动合并或验收授权。', 'hint'),
    editor, status, summary, feedback, el('p', '选择已授权指令的精确版本作为组合后的最终验证；未配置、失败或授权失效时不落地。关闭不撤回已固定交付。', 'hint'), controls, history);
  node.updateCommands = next => { commands = next; if (owns()) { paintCommands(); sync(); } };
  node.syncControls = sync;
  node.dispose = () => { disposed = true; ++generation; ++listRequest; ++historyRequest; };
  for (const control of [save, refresh, more]) { const click = control.onclick; control.onclick = async () => { await click(); sync(); }; }
  sync(); node.ready = loadBranches(); return node;
}
