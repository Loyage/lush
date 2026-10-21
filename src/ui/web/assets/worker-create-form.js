import { $, el } from './dom.js';
import { api, action, projectApi } from './api.js';
import { formDialog, closeDialog, syncDialog } from './dialog.js';
import { createEmissionWorkerPicker } from './emission-form.js';
import { createChildSourcePicker } from './worker-child-source.js';
import { createProfileForm } from './agent-profile-form.js';
import { workerLabel } from './worker-label.js';
import { taskTitle } from './format.js';
import { ui } from './state.js';
import { detail, refresh } from './navigate.js';
import { show } from './messages.js';

const field = (label, control) => {
  control.setAttribute('aria-label', label);
  const node = el('label', undefined, 'worker-create-field'); node.append(el('span', label), control); return node;
};
/** One dialog owns the exact form for its lifetime. No nested settings dialog or write retry on reads. */
export async function openWorkerCreate({ source = null, parent: parentWorker = null } = {}) {
  ui.disposeWorkerCreation?.();
  const view = ui.view, project = projectApi('/api/'), boot = ui.workerNumbers;
  let active = true, busy = false, created = null, profileForm = null, profileKey = null, profileReady = false, profileGeneration = 0;
  let sourceDetails = null, sourceState = 'empty', sourceError = '', sourceGeneration = 0;
  const current = () => active && ui.view === view && ui.workerNumbers === boot && projectApi('/api/') === project;
  const content = el('div', undefined, 'worker-create-form');
  const dispose = () => { active = false; if ($('modal')?.querySelector('.worker-create-form') === content) closeDialog(); };
  ui.disposeWorkerCreation = dispose;
  const mode = el('select'); mode.append(el('option', 'spawn · 空白创建'), el('option', 'fork · 复制创建'));
  mode.children[0].value = 'spawn'; mode.children[1].value = 'fork'; mode.value = !parentWorker && source ? 'fork' : 'spawn';
  mode.dataset.createField = 'mode';
  const title = el('input'); title.type = 'text'; title.maxLength = 200; title.dataset.createField = 'title';
  const error = el('p', undefined, 'error worker-create-error'); error.setAttribute('role', 'alert');
  const parent = el('select'); parent.dataset.createField = 'parent';
  const main = el('option', 'main（默认交付父）'); main.value = ''; parent.append(main);
  const parentField = field('交付父', parent), fixedParent = el('p', undefined, 'hint worker-create-parent');
  fixedParent.setAttribute('role', 'status');
  const sourcePicker = parentWorker
    ? createChildSourcePicker({ parent: parentWorker, ownsPage: current, onChange: () => verifySource() })
    : createEmissionWorkerPicker({ label: 'fork 来源 Worker', initial: source, ownsPage: current, onChange: () => verifySource() });
  sourcePicker.select.dataset.createField = 'source';
  const advanced = el('details', undefined, 'worker-create-advanced');
  const override = el('input'); override.type = 'checkbox'; override.dataset.createField = 'override';
  const overrideField = field('自定义本次运行参数', override); overrideField.classList.add('worker-create-override');
  const profileBox = el('div', undefined, 'worker-create-profile'); profileBox.hidden = true;
  const profileNote = el('p', undefined, 'hint');
  advanced.append(el('summary', '高级运行参数'), profileNote, overrideField, profileBox);
  const note = el('p', '只创建 Worker 与工作区，不创建 Input、不调用 Agent。fork 必须实际继承有效 Pi 会话；不支持或缺少检查点时拒绝，表单保留，不自动改用 spawn。', 'hint');
  content.append(field('创建方式', mode), sourcePicker.node, parentField, fixedParent, field('标题（可选）', title), advanced, note, error);
  function paint() {
    const fork = mode.value === 'fork', selected = sourcePicker.value();
    sourcePicker.node.hidden = !fork; parentField.hidden = Boolean(parentWorker) || fork; fixedParent.hidden = !parentWorker && !fork;
    fixedParent.dataset.sourceState = sourceState;
    fixedParent.classList.toggle('error', sourceState === 'failed');
    const sourceStatus = sourceState === 'ready' ? `交付父：${workerLabel(sourceDetails.parent_id, sourceDetails.parent_worker_number)}（固定为来源的直接父，与来源同父独立工作）`
      : sourceState === 'loading' ? `正在读取来源 ${workerLabel(selected)} 的详情并核验交付父；完成前不能复制创建。`
        : sourceState === 'failed' ? `来源详情读取失败：${sourceError}；交付父尚未核验，不能复制创建。请${parentWorker ? '重新选择来源或加载直接子 Worker' : '重新选择来源或按编号定位'}重试，表单保留。`
          : '选择来源后读取真实详情并核验交付父；不能改投其它父 Worker。';
    fixedParent.textContent = parentWorker
      ? `父 Worker：${workerLabel(parentWorker)}（固定为当前 Worker）${fork ? sourceState === 'ready' ? ` · 复制来源：${workerLabel(sourceDetails)}（已核验为当前 Worker 或直接子 Worker）` : ` · ${sourceStatus}` : ' · 空白创建，不继承会话。'}`
      : sourceStatus;
    profileNote.textContent = fork ? '默认继承来源 Worker 的有效运行参数；不读取并覆盖为项目默认。只有勾选自定义才提交完整覆盖。' : '默认沿用项目有效运行参数；只有勾选自定义才提交完整覆盖。';
    syncDialog(content);
  }
  async function verifySource() {
    const generation = ++sourceGeneration, selected = sourcePicker.value();
    sourceDetails = null; sourceError = ''; sourceState = mode.value === 'fork' && selected ? 'loading' : 'empty';
    profileGeneration++; paint();
    if (sourceState !== 'loading') return;
    const ownsSource = () => current() && generation === sourceGeneration && mode.value === 'fork' && sourcePicker.value()?.id === selected.id;
    try {
      const details = await api(`/api/worker/${selected.id}`);
      if (!ownsSource()) return;
      if (details.id !== selected.id || (selected.worker_number && details.worker_number !== selected.worker_number)
        || !['order', 'child'].includes(details.task_kind) || !Number.isSafeInteger(details.parent_id) || details.parent_id <= 0)
        throw new Error('来源身份或直接父信息不完整，请核对 Worker');
      if (parentWorker && details.id !== parentWorker.id && details.parent_id !== parentWorker.id)
        throw new Error('来源不再是当前 Worker 的直接子 Worker，请重新选择');
      sourceDetails = details; sourcePicker.update(details); sourceState = 'ready'; paint();
      if (override.checked) void loadProfile();
    } catch (failure) { if (ownsSource()) { sourceState = 'failed'; sourceError = failure.message; paint(); } }
  }
  async function loadProfile() {
    const key = mode.value === 'fork' ? sourceState === 'ready' && sourceDetails?.id : 'spawn';
    if (!override.checked || !key || !current()) return;
    if (profileForm && profileKey === key) return;
    const generation = ++profileGeneration;
    // Changing a source never overwrites edits to an explicit override. It remains visibly explicit.
    if (profileForm) { profileNote.textContent += ' 已保留当前自定义覆盖，不自动替换为新来源参数。'; return; }
    profileBox.textContent = '正在读取完整运行参数…';
    try {
      const settings = await api('/api/agent/config');
      const inherited = key === 'spawn' ? settings.resolved?.agent || settings.default : (await api(`/api/worker/${key}/run-settings`))?.profile;
      if (!inherited) throw new Error('有效运行参数不可用，不会改用项目默认');
      if (!current() || generation !== profileGeneration) return;
      profileForm = createProfileForm({ profile: inherited, settings, role: 'agent', ownsPage: current, collapseAdvanced: true });
      profileKey = key; profileBox.replaceChildren(profileForm.node); await profileForm.ready; profileReady = true; syncDialog(content);
    } catch (failure) { if (current() && generation === profileGeneration) { profileBox.textContent = `读取失败：${failure.message}；取消勾选后可重试。`; } }
  }
  mode.onchange = () => { if (busy) return; void verifySource(); if (mode.value === 'spawn' && override.checked) void loadProfile(); };
  override.onchange = () => { profileBox.hidden = !override.checked; if (override.checked) void loadProfile(); syncDialog(content); };
  void verifySource();
  // The default main choice is valid without this optional complete parent list. Read errors stay visible.
  if (!parentWorker) void api('/api/input-parents').then(data => {
    if (!current()) return;
    if (!Array.isArray(data.items)) throw new Error('父 Worker 列表格式不兼容');
    for (const worker of data.items) {
      if (worker.branch === 'main') continue;
      const option = el('option', `${workerLabel(worker)} ${taskTitle(worker)} · ${worker.branch}`); option.value = String(worker.id); parent.append(option);
    }
  }).catch(failure => { if (current()) error.textContent = `交付父列表读取失败：${failure.message}；现有字段保留，可取消后重新打开。`; });
  try {
    await formDialog({ title: parentWorker ? '创建子 Worker' : '创建 Worker', content, initialFocus: mode, cardClass: 'worker-create-modal', confirmLabel: parentWorker ? '创建子 Worker' : '创建 Worker',
      confirmHelp: '固定当前已提交代码并创建独立 Worker 与工作区，不创建 Input、不调用 Agent。',
      canConfirm: () => current() && !created && (mode.value !== 'fork' || (sourceState === 'ready' && sourceDetails?.id === sourcePicker.value()?.id)),
      onConfirm: async () => {
        if (!current() || busy || created) return false;
        error.textContent = '';
        const fork = mode.value === 'fork', selected = sourceDetails;
        if (fork && (sourceState !== 'ready' || !selected || selected.id !== sourcePicker.value()?.id)) { error.textContent = 'fork 来源详情与交付父尚未核验，不能提交。'; return false; }
        if (override.checked && (!profileForm || !profileReady)) { error.textContent = '运行参数尚未读取完成，请检查高级设置。'; return false; }
        if (override.checked) { const invalid = profileForm.validate(); if (invalid) { error.textContent = invalid; return false; } }
        const params = { mode: mode.value, ...(fork ? { source: selected.id } : {}),
          ...(parentWorker ? { parent: parentWorker.id } : !fork && parent.value ? { parent: Number(parent.value) } : {}),
          ...(title.value.trim() ? { title: title.value.trim() } : {}), ...(override.checked ? { profile: profileForm.collect() } : {}) };
        busy = true;
        const controls = [...content.querySelectorAll('input'), ...content.querySelectorAll('select'), ...content.querySelectorAll('textarea'), ...content.querySelectorAll('button')];
        const disabled = controls.map(node => node.disabled); controls.forEach(node => { node.disabled = true; }); sourcePicker.setBusy(true);
        try {
          const result = await action('worker.create', params, { refresh: false });
          // A successful write is consumed before any refresh/detail read, even after navigation or dismissal.
          created = result?.task || {};
          if (!Number.isSafeInteger(created.id)) {
            show('创建请求已成功，但响应缺少 Worker 身份；请刷新项目树核验，不要重复创建。', 'error');
          } else if (projectApi('/api/') === project && ui.workerNumbers === boot) {
            show(`已创建 Worker ${workerLabel(created)}，等待首条输入 · 尚未调用 Agent。`);
          }
          return true;
        } catch (failure) {
          if (current()) error.textContent = `创建未完成：${failure.message}；字段已保留，不会自动重试或切换模式。`;
          return false;
        } finally {
          busy = false;
          if (current() && !created) { controls.forEach((node, index) => { node.disabled = disabled[index]; }); sourcePicker.setBusy(false); }
        }
      } });
    const navigate = current() && Number.isSafeInteger(created?.id);
    active = false;
    if (ui.disposeWorkerCreation === dispose) ui.disposeWorkerCreation = null;
    if (navigate) {
      try { await detail(created.id); }
      catch (failure) { show(`Worker ${workerLabel(created)} 已创建，但详情读取失败：${failure.message}；请刷新，不要重复创建。`, 'error'); }
      // Refresh owns its own navigation guard; it must never resubmit creation.
      try { await refresh(); } catch { show('Worker 已创建，但列表更新失败；请稍后刷新。', 'error'); }
    }
    return created;
  } finally { active = false; if (ui.disposeWorkerCreation === dispose) ui.disposeWorkerCreation = null; }
}
