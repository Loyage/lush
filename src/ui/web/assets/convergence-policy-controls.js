import { el, button } from './dom.js';
import { api, action } from './api.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { show } from './messages.js';

const text = value => typeof value === 'string' && value.length > 0;
const common = value => value?.version === 1 && typeof value.mounted === 'boolean' && typeof value.enabled === 'boolean'
  && typeof value.editable === 'boolean' && text(value.revision) && (value.reason === null || typeof value.reason === 'string');
export const validConvergencePolicy = (value, branch = value?.branch) => common(value) && text(branch) && value.branch === branch
  && Number.isSafeInteger(value.owner_id) && value.owner_id > 0 && (value.mounted || !value.enabled);
export const validConvergenceDefaults = common;
export const CONVERGENCE_ENABLE_HELP = agentHelp('开启目标分支的新交付归并；冲突时可能创建整合 Worker，每批形成一个单父 Squash 提交。不改变 Worker 自动合并或验收授权，不自动运行最终验证快捷指令。');
export const CONVERGENCE_DISABLE_HELP = '关闭未来归并，目标系统工具仍以普通串行处理合法的已授权交付；已固定批次继续收口，不撤回交付或删除历史，不改变 Worker 自动合并或验收授权。';
export const CONVERGENCE_COMPATIBILITY = '归并自动化数据不可用或版本不兼容，请更新项目后台与界面服务后重新读取。';

/** Non-success facts must remain visible even when display policy folds the feature. */
export function convergenceDiagnostic(model) {
  const errors = ['awaiting', 'failed', 'blocked'].filter(key => Number.isSafeInteger(model?.counts?.[key]) && model.counts[key] > 0);
  const counts = errors.map(key => `${({ awaiting: '待决定', failed: '失败', blocked: '落地待核查' })[key]} ${model.counts[key]}`).join(' · ');
  return [model?.reason || '', counts ? `${counts}；在对应 Worker 自动化查看交付处理记录。` : ''].filter(Boolean).join(' · ');
}

/** Same target strategy as the protected delivery handler; completion authorization stays independent. */
export function workerConvergenceControl(task, { ownsPage, refresh, onEditing = () => {}, onPolicyChange = () => {}, busy = () => false }) {
  const policy = task.hooks?.convergence;
  if (policy === null) return null;
  const node = el('div', undefined, 'hook-completion-control worker-convergence-control');
  if (!validConvergencePolicy(policy, task.branch) || policy.owner_id !== task.id) {
    node.append(el('span', '归并自动化状态不可用；请刷新或更新服务，不推断默认挂载。', 'hint')); return node;
  }
  if (!policy.mounted) return null;
  let model = policy, saving = false, acknowledgedUnknown = false;
  const status = el('span', undefined, 'hint convergence-worker-status'); status.setAttribute('role', 'status');
  const choices = [];
  const group = el('div', undefined, 'hook-completion-levels'); group.setAttribute('aria-label', '归并合并启停'); group.setAttribute('role', 'group');
  function paint() {
    if (!ownsPage()) return;
    for (const { enabled, control, host } of choices) {
      const reason = saving || busy() ? '正在确认或保存。' : acknowledgedUnknown ? '保存已确认，请只读刷新核查，不要重复提交。' : !model.editable ? model.reason || '这个分支当前不可编辑。' : '';
      control.disabled = !!reason || enabled === model.enabled;
      control.setAttribute('aria-pressed', String(enabled === model.enabled)); control.classList.toggle('is-selected', enabled === model.enabled);
      const help = enabled ? CONVERGENCE_ENABLE_HELP : CONVERGENCE_DISABLE_HELP;
      control.setAttribute('data-help', help); host.setAttribute('data-help', `${reason} ${help}`); host.tabIndex = control.disabled ? 0 : -1;
    }
    const diagnostic = convergenceDiagnostic(model);
    status.textContent = diagnostic || (saving ? '正在保存归并设置…' : `归并合并：${model.enabled ? '开启' : '关闭'}`);
    status.classList.toggle('error', !!diagnostic);
  }
  async function save(enabled) {
    if (!ownsPage() || saving || busy() || acknowledgedUnknown || !model.editable || enabled === model.enabled) return;
    saving = true; onEditing(true); paint(); let acknowledged = false;
    try {
      if (enabled && !await confirmDialog({ title: `开启 ${model.branch} 的归并？`, message: CONVERGENCE_ENABLE_HELP,
        confirmLabel: '确认开启归并', agent: true, confirmHelp: CONVERGENCE_ENABLE_HELP })) return;
      if (!ownsPage()) return;
      const result = await action('branch.convergence_set', { branch: model.branch, mounted: true, enabled, expected_revision: model.revision }, { refresh: false });
      acknowledged = true;
      if (!ownsPage()) return;
      if (!validConvergencePolicy(result, task.branch) || result.owner_id !== task.id) {
        acknowledgedUnknown = true; throw new Error('保存已确认，但返回策略不兼容；请只读刷新核查。');
      }
      model = result; onPolicyChange(model); paint(); show('归并设置已保存；不改变自动合并或验收授权。');
      try { await refresh(); } catch (error) { if (ownsPage()) show(`归并设置已保存，但刷新失败：${error.message}；不要重复提交。`, 'error'); }
    } catch (error) { if (ownsPage()) show(acknowledged ? error.message : `保存失败：${error.message}；版本冲突请刷新，原策略保留。`, 'error'); }
    finally { saving = false; onEditing(false); paint(); }
  }
  for (const enabled of [false, true]) {
    const control = button(enabled ? '开启归并' : '关闭归并', () => save(enabled), `hook-completion-level${enabled ? '' : ' convergence-disable'}`,
      { agent: enabled, help: enabled ? CONVERGENCE_ENABLE_HELP : CONVERGENCE_DISABLE_HELP });
    const host = el('span', undefined, 'help-host'); host.append(control); group.append(host); choices.push({ enabled, control, host });
    const click = control.onclick; control.onclick = async () => { await click(); paint(); };
  }
  node.append(el('span', '归并合并', 'hook-completion-label'), group, status); paint(); return node;
}

/** Future actual order/child creation defaults. Never applies retroactively to branch policies. */
export function convergenceDefaultsEditor({ ownsPage, busy = () => false, setBusy = () => {}, setEditing = () => {} }) {
  const node = el('section', undefined, 'convergence-defaults'); node.append(el('h3', '未来新 Worker 默认'));
  const mounted = el('input'), enabled = el('input'); mounted.type = enabled.type = 'checkbox';
  const label = (name, input) => { input.setAttribute('aria-label', name); const row = el('label', name, 'hook-field'); row.append(input); return row; };
  const status = el('p', '默认设置尚未成功读取，不推断默认值。', 'hint'); status.setAttribute('role', 'status');
  let model = null, draft = null, saving = false, reading = false, generation = 0, acceptedUnknown = false;
  const dirty = () => !!draft && (draft.mounted !== model.mounted || draft.enabled !== model.enabled);
  const help = () => draft?.mounted && draft?.enabled ? agentHelp('给之后实际创建的 order/child 挂载并开启归并，未来冲突时可能启动整合 Agent；不修改已有 Worker 或合并/验收授权。')
    : '只保存之后实际创建的 order/child 的归并挂载默认，不修改已有 Worker。未挂载时记住开启偏好但不执行。';
  const save = button('保存新 Worker 归并默认', saveDefaults, 'hook-button'); const host = el('span', undefined, 'help-host'); host.append(save);
  function paint() {
    if (!ownsPage()) return;
    const reason = saving || reading || busy() ? '正在读取或保存。' : acceptedUnknown ? '保存已确认，请只读刷新，不要重发。' : !model ? CONVERGENCE_COMPATIBILITY : !model.editable ? model.reason || '默认设置当前不可编辑。' : !dirty() ? '默认设置没有变化。' : '';
    mounted.disabled = enabled.disabled = !model || saving || reading || busy() || !model.editable || acceptedUnknown;
    mounted.checked = draft?.mounted === true; enabled.checked = draft?.enabled === true;
    save.disabled = !!reason; save.classList.toggle('agent-call', draft?.mounted === true && draft?.enabled === true);
    save.setAttribute('data-help', help()); host.setAttribute('data-help', `${reason} ${help()}`); host.tabIndex = save.disabled ? 0 : -1;
    refresh.disabled = saving || reading || busy(); refreshHost.tabIndex = refresh.disabled ? 0 : -1;
    refreshHost.setAttribute('data-help', refresh.disabled ? '正在读取或保存，请稍候。' : '只读取默认策略，不修改已有 Worker 或安排 Agent。');
    setEditing(dirty());
  }
  function receive(value) {
    if (!ownsPage()) return;
    ++generation;
    if (!validConvergenceDefaults(value)) { model = draft = null; status.className = 'error'; status.textContent = CONVERGENCE_COMPATIBILITY; }
    else { model = value; draft = { mounted: value.mounted, enabled: value.enabled }; acceptedUnknown = false;
      status.className = value.reason ? 'error' : 'hint'; status.textContent = value.reason || `已保存默认：${value.mounted ? '挂载' : '不挂载'} · 挂载后${value.enabled ? '开启' : '关闭'}；仅之后实际创建的新 Worker 生效，不回写已有。`; }
    paint();
  }
  async function reload() {
    if (!ownsPage() || saving || reading || busy()) return;
    if (dirty() && !await confirmDialog({ title: '放弃未保存默认并刷新？', message: '只重新读取未来新 Worker 默认，未保存选择会丢失。', confirmLabel: '放弃并刷新' })) return;
    if (!ownsPage()) return;
    const request = ++generation; reading = true; paint();
    try { const value = await api('/api/branch-convergence/defaults'); if (ownsPage() && request === generation) receive(value); }
    catch (error) { if (ownsPage() && request === generation) { status.textContent = `默认读取失败：${error.message}；已有选择保留。`; status.className = 'error'; } }
    finally { reading = false; paint(); }
  }
  async function saveDefaults() {
    if (!ownsPage() || saving || reading || busy() || acceptedUnknown || !model?.editable || !dirty()) return;
    const request = generation, params = { ...draft, expected_revision: model.revision }; saving = true; setBusy(true); paint(); let acknowledged = false;
    try {
      if (params.mounted && params.enabled && !await confirmDialog({ title: '开启未来新 Worker 的归并默认？', message: help(), confirmLabel: '确认开启新默认', agent: true, confirmHelp: help() })) return;
      if (!ownsPage() || request !== generation) return;
      const result = await action('branch.convergence_defaults_set', params, { refresh: false }); acknowledged = true;
      if (!ownsPage() || request !== generation) return;
      if (!validConvergenceDefaults(result)) { acceptedUnknown = true; throw new Error('保存已确认，但默认数据不兼容，请只读刷新，不要重发。'); }
      receive(result); const readRequest = generation;
      try { const fresh = await api('/api/branch-convergence/defaults'); if (ownsPage() && readRequest === generation) {
        if (!validConvergenceDefaults(fresh)) throw new Error(CONVERGENCE_COMPATIBILITY); receive(fresh);
      } } catch (error) { if (ownsPage() && readRequest === generation) { status.className = 'error'; status.textContent = `默认已保存，但刷新失败：${error.message}；不要重复保存。`; } }
    } catch (error) { if (ownsPage() && request === generation) { status.className = 'error'; status.textContent = acknowledged ? error.message : `保存失败：${error.message}；选择保留，版本冲突请先重新读取。`; } }
    finally { saving = false; setBusy(false); paint(); }
  }
  const refresh = button('重新读取归并默认', reload, 'ghost hook-button'), refreshHost = el('span', undefined, 'help-host'); refreshHost.append(refresh);
  for (const [input, key] of [[mounted, 'mounted'], [enabled, 'enabled']]) input.onchange = () => { if (!ownsPage() || input.disabled || !draft) return; draft[key] = input.checked; paint(); };
  for (const control of [save, refresh]) { const click = control.onclick; control.onclick = async () => { await click(); paint(); }; }
  node.append(label('新 Worker 默认挂载归并', mounted), label('挂载后默认开启归并', enabled), status, host, refreshHost);
  node.setModel = receive; node.syncControls = paint; paint(); return node;
}
