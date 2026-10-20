import { el, button, badge } from './dom.js';
import { api, action } from './api.js';
import { detail } from './navigate.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { workerLabel } from './worker-label.js';
import { createHookForm, COMMAND_WARNING } from './render-hooks.js';

export const registryOrigin = origin => ({ builtin: '内置', custom: '自定义', system: '系统' })[origin] || '未知来源';
const field = (label, tag = 'input', value = '') => {
  const wrap = el('label', label, 'hook-field'), input = el(tag); input.setAttribute('aria-label', label); input.value = value; wrap.append(input); return { wrap, input };
};
const option = (id, text) => { const node = el('option', text); node.value = String(id); return node; };
const agentDefinition = (definition, catalogue) => !definition || definition.actions?.some(item => catalogue.actions?.find(action => action.type === item.type)?.agent_call !== false && (item.type !== 'create_worker' || item.start !== false));
const locked = (control, reason) => {
  const host = el('span', undefined, 'help-host'); host.append(control);
  host.sync = () => { const why = reason(); control.disabled = Boolean(why); host.tabIndex = why ? 0 : -1; host.setAttribute('data-help', `${why || ''} ${control.getAttribute('data-help') || ''}`); };
  const click = control.onclick; control.onclick = async () => { try { await click(); } finally { host.sync(); } };
  host.sync(); return host;
};
export function registryFacts(item) {
  const node = el('section', undefined, 'registry-facts');
  node.append(el('h1', item.name), ...(item.temporary ? [badge('临时'), ...(item.lifecycle === 'reclaimed' ? [badge('已回收 · 只读')] : [])] : []), el('p', item.purpose), badge(registryOrigin(item.origin)), badge(`当前登记 v${item.version}`), badge(`${item.mount_count} 个真实挂载`));
  if (item.reason) node.append(el('p', item.reason, item.readonly ? 'hint' : 'error'));
  const targets = el('details', undefined, 'registry-targets'); targets.append(el('summary', '挂载目标与版本'));
  targets.append(el('p', item.targets_complete ? `已列出全部 ${item.mount_count} 个挂载。` : `目标未列全：仅列出 ${item.targets.length} / ${item.mount_count} 个挂载（上限 100）；不能据此判断其他 Worker 未挂载。`, item.targets_complete ? 'hint' : 'error'));
  for (const target of item.targets) targets.append(button(`${workerLabel(target.worker_id, target.worker_number)} · v${target.version ?? '未知'} · ${target.hook_id}`, () => detail(target.worker_id), 'nav-link', { worker: target.worker_id }));
  node.append(targets); return node;
}

/** Shared mount-only selector. Never collects a raw rule or reconstructs private profiles. */
export function registeredMountPicker({ catalogue, workerId, model, mount = null, templateId = null, ownsPage = () => true, onSaved = () => {} }) {
  const node = el('div', undefined, 'hook-editor registered-mount-picker'), status = el('p', '', 'hint'); status.setAttribute('role', 'status');
  const feature = field('已登记功能', 'select'), version = field('授权版本', 'select'), enabled = field('启用挂载'); enabled.input.type = 'checkbox'; enabled.input.checked = mount ? mount.enabled : false;
  const items = [], seen = new Set(); let cursor = catalogue.registry?.next_cursor, reading = false;
  const addItems = directory => {
    for (const item of directory.registry?.items || []) if (!seen.has(item.id) && item.mountable && (!templateId || item.id === templateId) && (!mount || item.id === mount.registry_id)) {
      seen.add(item.id); items.push(item); feature.input.append(option(item.id, `${item.name} · ${item.temporary ? '临时 · ' : ''}${registryOrigin(item.origin)}`));
    }
  };
  feature.input.append(option('', '请选择登记功能')); addItems(catalogue);
  feature.input.value = mount?.registry_id || templateId || '';
  const preview = el('p', '', 'hint'); let busy = false, submitted = false, saved = false;
  const selected = () => items.find(item => item.id === feature.input.value);
  const definition = () => catalogue.templates?.find(item => item.id === feature.input.value && item.version === Number(version.input.value));
  const hasAgent = () => enabled.input.checked && agentDefinition(definition(), catalogue);
  const paint = () => {
    const item = selected(), known = definition();
    preview.textContent = !item ? '选择已登记功能及明确版本；不会默认挂到 main。' : `${registryOrigin(item.origin)} · ${item.purpose} · 固定 v${version.input.value || '待选择'}。${known ? `触发：${known.trigger}；${known.mode === 'persistent' ? '持续' : '一次性'}。` : '历史版本完整定义未在当前读面提供；授权前请核对原登记记录，不能把当前定义当历史定义。'} 修改登记不会改变此授权。`;
    save.classList.toggle('agent-call', !!hasAgent()); save.setAttribute('data-help', hasAgent() ? agentHelp('授权固定登记版本；未来条件满足时可能启动或唤醒 Agent。') : '只授权所选登记版本；挂载不立即执行，未来条件满足后按原安全门执行。'); host.sync();
    feature.input.disabled = busy || submitted; version.input.disabled = busy || submitted; enabled.input.disabled = busy || submitted;
  };
  const versions = () => { const item = selected(); version.input.replaceChildren(option('', '请选择固定版本'), ...(item?.versions || []).map(value => option(value, `v${value}${value === item.version ? '（当前登记）' : ''}`))); version.input.value = mount ? String(mount.registry_version || '') : ''; paint(); };
  const save = button(mount ? '确认升级挂载版本' : '确认挂载', async () => {
    if (!ownsPage() || busy || submitted || !selected()?.versions.includes(Number(version.input.value)) || !version.input.value || (mount ? mount.editable !== true || mount.locked : model.can_attach === false)) return;
    busy = true; paint();
    try {
      const item = selected(), agent = hasAgent(), def = definition();
      if (!await confirmDialog({ title: mount ? '升级此挂载的授权版本？' : '确认单独挂载？', message: `${workerLabel(workerId)} · ${item.name} · v${version.input.value} · ${enabled.input.checked ? '启用' : '停用'}。${def?.actions?.some(item => item.type === 'command') ? COMMAND_WARNING : ''} 仅改变这个 Worker 的未来授权，不重放旧触发；登记与挂载是两次独立操作。`, confirmLabel: mount ? '授权升级版本' : '授权挂载', agent, confirmHelp: agent ? agentHelp('授权所选固定版本在未来节点执行，可能安排 Agent 调用。') : '保存当前目标的固定版本授权，不立即执行，不扩大到其他 Worker。' }) || !ownsPage()) return;
      submitted = true;
      const result = await action(mount ? 'worker.hook_update' : 'worker.hook_attach', { id: workerId, ...(mount ? { hook_id: mount.id } : {}), hook: { template_id: item.id, template_version: Number(version.input.value), enabled: enabled.input.checked }, expected_revision: model.revision }, { refresh: false });
      if (result?.worker_id !== workerId || !result.revision || !result.mounts?.some(next => next.registry_id === item.id && next.registry_version === Number(version.input.value) && next.enabled === enabled.input.checked && (!mount || next.id === mount.id))) throw Error('未收到匹配的挂载授权结果。');
      saved = true;
      if (!ownsPage()) return;
      status.textContent = '挂载授权已保存；未立即执行。';
      try { await onSaved(result); } catch (error) { if (ownsPage()) status.textContent = `挂载已保存，但刷新失败：${error.message}；不要重复挂载。`; }
    } catch (error) { if (ownsPage()) { status.className = 'error'; status.textContent = `${error.message}；${submitted ? '结果须只读核验，不自动重发；请刷新 Worker 挂载。' : '未提交挂载。'}`; } }
    finally { busy = false; if (ownsPage()) paint(); }
  }, 'hook-button');
  const host = locked(save, () => busy ? '正在确认或保存。' : submitted ? saved ? '已保存；不重复提交。' : '结果待核验，请刷新 Worker 挂载，不自动重发。' : !selected() || !version.input.value ? '须先选择登记功能及明确版本。' : model.can_attach === false && !mount ? '当前 Worker 不允许新增挂载。' : mount && (mount.editable !== true || mount.locked) ? mount.reason || '挂载已锁定。' : null);
  const pageStatus = el('p', '', 'hint');
  const more = button('继续读取可挂载功能', async () => {
    if (!ownsPage() || reading || submitted || !cursor) return; reading = true; more.disabled = true;
    try {
      const next = await api(`/api/hooks?include_reclaimed=${catalogue.registry.include_reclaimed === true}&after=${encodeURIComponent(cursor)}`); if (!ownsPage()) return;
      if (next.registry.revision !== catalogue.registry.revision) throw Error('目录已变化，请关闭选择并重新读取。');
      addItems(next); catalogue.templates = [...(catalogue.templates || []), ...(next.templates || [])]; cursor = next.registry.next_cursor; paintPage();
    } catch (error) { if (ownsPage()) { pageStatus.className = 'error'; pageStatus.textContent = `续读失败：${error.message}；当前选择列表不代表全部。`; } }
    finally { reading = false; more.disabled = submitted; }
  }, 'ghost');
  const paintPage = () => { more.hidden = !cursor; pageStatus.textContent = cursor ? '可选目录未列全，可显式继续读取；已回收项不可挂载。' : '当前目录已读完；活动临时定义虽不可编辑，仍可固定版本挂载。'; };
  feature.input.onchange = versions; version.input.onchange = paint; enabled.input.onchange = paint;
  node.append(feature.wrap, version.wrap, enabled.wrap, preview, host, status, pageStatus, more); versions(); paintPage();
  node.hasDraft = () => !!feature.input.value || submitted; return node;
}

function projectMount({ catalogue, item, ownsPage, onSaved }) {
  const node = el('div', undefined, 'registry-mount'), worker = field('选择目标 Worker', 'select'), status = el('p', '', 'hint'), host = el('div');
  worker.input.append(option('', '请选择 Worker（不默认选择 main）'));
  let cursor = null, generation = 0, loading = false, loaded = false;
  const seen = new Set();
  const load = button('读取 Worker 列表', async () => {
    if (!ownsPage() || loading) return; loading = true;
    const epoch = ownsPage.epoch?.(), current = () => ownsPage() && epoch === ownsPage.epoch?.();
    try {
      // worker.page contains older terminal rows only; the overview supplies live targets first.
      const data = await api(loaded ? `/api/workers?scope=all&limit=100&before=${encodeURIComponent(cursor)}` : '/api/overview'); if (!current()) return;
      if (!Array.isArray(data.tasks)) throw Error('Worker 列表读面不兼容。');
      for (const task of data.tasks) if (!seen.has(task.id) && ['main', 'owner', 'order', 'child'].includes(task.task_kind)) { seen.add(task.id); worker.input.append(option(task.id, `${workerLabel(task)} · ${task.display_title || task.auto_title || task.goal || task.status}`)); }
      loaded = true; const page = data.task_page || data;
      cursor = page.has_more ? page.cursor : null; load.hidden = !page.has_more; load.textContent = '读取更多 Worker'; status.textContent = page.has_more ? '目标列表未列全，可继续读取。' : '目标列表已完整读取；实际可挂载性仍由 Worker 安全门校验。';
    } catch (error) { if (ownsPage()) { status.textContent = `Worker 列表读取失败：${error.message}`; status.className = 'error'; } }
    finally { loading = false; }
  }, 'ghost');
  worker.input.onchange = async () => {
    const request = ++generation, epoch = ownsPage.epoch?.(), current = () => ownsPage() && request === generation && epoch === ownsPage.epoch?.(); host.replaceChildren(); if (!worker.input.value) return;
    const id = Number(worker.input.value); status.textContent = '正在读取目标授权版本…';
    try {
      const model = await api(`/api/worker/${id}/hooks`); if (!current()) return;
      if (model.worker_id !== id || !model.revision) throw Error('目标身份或版本不匹配。');
      status.textContent = model.can_attach === false ? '此 Worker 当前不允许新增挂载。' : '';
      host.replaceChildren(registeredMountPicker({ catalogue, templateId: item.id, workerId: id, model, ownsPage: current, onSaved }));
    } catch (error) { if (current()) { status.textContent = `目标读取失败：${error.message}`; status.className = 'error'; } }
  };
  node.append(el('h2', '单独挂载到 Worker'), worker.wrap, load, status, host); return node;
}

export function registrationEditor({ catalogue, item = null, ownsPage, onSaved }) {
  const node = el('section', undefined, 'registry-registration'), status = el('p', '', 'hint'); status.setAttribute('role', 'status');
  const initial = item ? catalogue.templates?.find(template => template.id === item.id) : null;
  if (item && !initial) { node.append(el('p', '当前完整登记定义不可用；不能从摘要重建定义。', 'error')); return node; }
  const kind = field('登记方式', 'select'); kind.input.append(option('rule', '登记规则（引用已登记指令或受控动作）'), option('shell', '登记新 Shell 指令和功能（不挂载）')); kind.input.value = 'rule';
  const purpose = field('用途说明', 'textarea', item?.purpose || ''); purpose.input.maxLength = 2000;
  const shellName = field('功能名称'), commandName = field('指令名称'), command = field('Shell 指令正文', 'textarea'), trigger = field('Shell 触发节点', 'select'), mode = field('Shell 规则方式', 'select');
  // The register-only endpoint is narrower than the general Shell action catalogue.
  // Use its actual shared schema rather than offering triggers the RPC will reject.
  const registerProperties = catalogue.registration?.schema?.properties?.hook?.properties;
  const triggerSpec = registerProperties?.trigger, registerTriggers = triggerSpec?.const ? [triggerSpec.const] : triggerSpec?.enum || [];
  for (const entry of catalogue.triggers || []) if (registerTriggers.includes(entry.id)) trigger.input.append(option(entry.id, entry.label));
  trigger.input.value = registerTriggers[0] || '';
  for (const value of registerProperties?.mode?.enum || []) mode.input.append(option(value, value === 'persistent' ? '持续' : '一次性'));
  mode.input.value = registerProperties?.mode?.enum?.includes('persistent') ? 'persistent' : registerProperties?.mode?.enum?.[0] || '';
  const shell = el('div', undefined, 'hook-form'); shell.append(shellName.wrap, commandName.wrap, command.wrap, trigger.wrap, mode.wrap, el('p', COMMAND_WARNING, 'hint'));
  const form = createHookForm(catalogue, { initial: initial || { enabled: false, trigger: 'agent.returned', mode: 'once', actions: [{ type: 'notify' }] }, ownsPage });
  let busy = false, submitted = false, saved = false, retryRequest = null;
  const clientId = globalThis.crypto.randomUUID();
  const paint = () => { shell.hidden = kind.input.value !== 'shell'; form.node.hidden = kind.input.value === 'shell'; purpose.wrap.hidden = kind.input.value === 'shell'; kind.wrap.hidden = !!item; saveHost.sync(); };
  const save = button(item ? '登记新版本' : '确认登记功能', async () => {
    if (!ownsPage() || busy || saved || submitted && !retryRequest) return;
    const isShell = kind.input.value === 'shell';
    if (!retryRequest && (isShell ? !trigger.input.value || !mode.input.value || !shellName.input.value.trim() || !commandName.input.value.trim() || !command.input.value.trim() : form.validate())) { status.textContent = '请完整填写登记定义。'; return; }
    busy = true; paint();
    try {
      if (!retryRequest) {
        if (!await confirmDialog({ title: item ? '登记修订版本？' : '只登记，不挂载？', message: '本操作仅保存功能定义；不选择 Worker、不执行、不改变已有挂载。挂载须完成登记后单独选择目标和版本确认。', confirmLabel: '只登记功能', confirmHelp: '保存登记定义，不启动 Agent，不安装到 main 或任何 Worker。' }) || !ownsPage()) return;
        if (!isShell && form.replacesPrompt() && !await confirmDialog({ title: '登记自定义 Prompt 覆盖？', message: '自定义 Prompt 会影响未来采用此版本的运行权限和协作约束；现有挂载不变。', confirmLabel: '确认登记覆盖', danger: true, confirmHelp: '登记完整私有覆盖，不从脱敏摘要重建；挂载仍须另行授权。' })) return;
        if (!ownsPage()) return;
        retryRequest = isShell ? { method: 'hooks.register', params: { command: { name: commandName.input.value.trim(), kind: 'shell', command: command.input.value }, hook: { name: shellName.input.value.trim(), trigger: trigger.input.value, mode: mode.input.value, enabled: false }, expected_revisions: { commands: catalogue.commands.revision, registry: catalogue.registry.revision }, client_request_id: clientId } }
          : { method: 'hooks.save', params: { template: { ...form.collect(), ...(item ? { id: item.id } : {}), purpose: purpose.input.value }, expected_revision: catalogue.registry.revision } };
      }
      submitted = true; form.setBusy(true); for (const input of node.querySelectorAll('input')) input.disabled = true; for (const input of node.querySelectorAll('textarea')) input.disabled = true; for (const input of node.querySelectorAll('select')) input.disabled = true;
      const request = retryRequest;
      // Only hooks.register has a durable idempotent receipt. The exact request stays frozen on retry.
      if (request.method !== 'hooks.register') retryRequest = null;
      const result = await action(request.method, request.params, { refresh: false });
      const registered = request.method === 'hooks.register' ? result?.registered === true && typeof result.template_id === 'string' && Number.isSafeInteger(result.template_version)
        : result?.templates?.some(next => item ? next.id === item.id && next.version > item.version : next.name === request.params.template.name && !catalogue.templates?.some(previous => previous.id === next.id));
      if (!registered) throw Error('登记响应未确认，请只读核验目录或按原幂等请求核验。');
      saved = true; retryRequest = null;
      if (!ownsPage()) return;
      const id = result.template_id || item?.id || result.templates?.find(template => template.name === request.params.template?.name && !catalogue.templates?.some(previous => previous.id === template.id))?.id;
      status.textContent = '登记成功；当前未增加挂载、未执行。请返回目录，单独选择目标和版本挂载。';
      if (id) status.append(button('查看登记功能（另行挂载）', async () => { const { openProjectAutomation } = await import('./render-project-automation.js'); if (ownsPage()) return openProjectAutomation({ feature: id }); }, 'nav-link'));
      try { const refreshed = await onSaved(); if (!refreshed) throw Error('目录读取未成功'); } catch (error) { if (ownsPage()) status.append(el('span', ` 登记已成功，但刷新失败：${error.message}；仅刷新目录，不重新登记。`, 'error')); }
    } catch (error) { if (ownsPage()) { status.className = 'error'; status.textContent = `${error.message}；${retryRequest ? '同一草稿可按原请求重试，client_request_id 与参数保持不变；不会重复注册。' : '结果须先只读核验；请返回目录刷新，不自动重新登记。'}`; } }
    finally { busy = false; if (ownsPage()) paint(); }
  }, 'hook-button', { help: '只登记新定义或修订版本，不挂载、不执行，不改变已有固定授权。' });
  const saveHost = locked(save, () => busy ? '正在确认或登记。' : saved ? '已登记成功；不要重复注册。' : submitted && !retryRequest ? '写结果须先核验，请只读刷新目录。' : null);
  kind.input.onchange = paint;
  node.append(el('h2', item ? '修订登记定义' : '登记新功能'), el('p', '登记和挂载是两次独立明确操作。私有运行覆盖未重设且动作位置、类型不变时保留；不从安全摘要重建。', 'hint'), kind.wrap, purpose.wrap, form.node, shell, saveHost, status); paint(); return node;
}

function temporaryUsage({ catalogue, item, ownsPage, onSaved, onState }) {
  const node = el('section', undefined, 'temporary-usage'), usage = el('p', '正在核验使用状态…', 'hint'), status = el('p', '', 'hint'); status.setAttribute('role', 'status');
  const audit = el('details', undefined, 'registry-targets'), rows = el('ol'), auditStatus = el('p', '', 'hint'); audit.append(el('summary', '使用审计（只读摘要）'), auditStatus, rows);
  let history = null, cursor = null, loading = false, submitted = false, saved = false, readRequest = 0;
  const clientId = globalThis.crypto.randomUUID();
  const blocked = () => {
    if (loading) return '正在核验使用状态。';
    if (submitted) return saved ? '已回收；保留只读历史，不重复提交。' : '回收结果待只读核验，不自动重发。';
    if (!history) return '尚无最新使用读面，须先核验。';
    if (history.lifecycle === 'reclaimed') return '已回收，不可再挂载。';
    const u = history.usage, reasons = [];
    if (u.mount_count) reasons.push(`${u.mount_count} 个残留挂载（含停用），须先在对应 Worker 显式移除`);
    if (u.pending_count) reasons.push(`${u.pending_count} 项待执行`);
    if (u.running_count) reasons.push(`${u.running_count} 项执行或收尾中`);
    if (u.unknown_count) reasons.push(`${u.unknown_count} 项结果未知，只读核验，不自动重放`);
    return reasons.join('；') || (!u.reclaimable ? '后台尚未确认可回收。' : null);
  };
  const paint = () => {
    if (history) {
      onState?.(history);
      const u = history.usage;
      usage.textContent = `创建 ${history.created_at}${history.reclaimed_at ? ` · 回收 ${history.reclaimed_at}` : ''} · 固定 v${history.template_version} · ${history.lifecycle === 'reclaimed' ? '已回收 · 只读' : '活动临时定义（不可修改，可另行挂载）'}。实际挂载 ${u.mount_count} · 待执行 ${u.pending_count} · 执行／收尾 ${u.running_count} · 结果未知 ${u.unknown_count}。累计挂载 ${u.attached_total} · 成功 ${u.succeeded_total} · 失败 ${u.failed_total} · 跳过 ${u.skipped_total}。成功只表示对应动作提交或执行收口，不表示 Agent 工作完成。`;
      usage.className = u.unknown_count || u.failed_total ? 'error' : 'hint';
    }
    reason.textContent = blocked() || '当前可申请安全回收；提交时后台会重检全部引用和执行事实。'; reclaimHost.sync();
  };
  const read = async (append = false) => {
    if (!ownsPage() || loading || append && !cursor) return;
    const request = ++readRequest, epoch = ownsPage.epoch?.(); loading = true; more.disabled = true; paint();
    try {
      const next = await api(`/api/hooks/temporary/history?id=${encodeURIComponent(item.id)}${append ? `&before=${cursor}` : ''}`);
      if (!ownsPage() || request !== readRequest || epoch !== ownsPage.epoch?.()) return;
      if (next.id !== item.id || next.temporary !== true || !next.usage || !Array.isArray(next.audit?.items)) throw Error('临时使用读面不匹配。');
      history = next; cursor = next.audit.next_before;
      if (!append) rows.replaceChildren();
      for (const entry of next.audit.items) {
        const row = el('li', `Event ${entry.seq} · ${entry.type} · ${entry.created_at}${entry.template_version ? ` · 固定 v${entry.template_version}` : ''}${entry.execution_id ? ` · 执行 ${entry.execution_id}` : ''}${entry.effects_unknown ? ' · 结果未知，不重放' : ''}`);
        if (entry.worker_id) row.append(button(workerLabel(entry.worker_id, entry.worker_number), () => detail(entry.worker_id), 'nav-link', { worker: entry.worker_id }));
        rows.append(row);
      }
      auditStatus.textContent = `仅安全事件摘要，不是完整执行记录。${next.audit.has_more ? '仍有更早记录，请显式续读。' : '当前可用审计页已读完。'}${next.audit.truncated ? '本页因字节预算截断。' : ''}`;
      more.hidden = !next.audit.has_more;
      status.textContent = '使用状态已只读核验；没有执行或重放动作。';
    } catch (error) { if (ownsPage() && epoch === ownsPage.epoch?.()) { history = null; status.className = 'error'; status.textContent = `使用审计读取失败：${error.message}；不能据此判断未使用或可回收。`; } }
    finally { loading = false; more.disabled = false; if (ownsPage()) paint(); }
  };
  const reason = el('p', '', 'hint temporary-reclaim-reason');
  const reclaim = button('安全回收临时功能', async () => {
    if (!ownsPage() || blocked()) return;
    const epoch = ownsPage.epoch?.(), current = () => ownsPage() && epoch === ownsPage.epoch?.();
    loading = true; paint();
    try {
      if (!await confirmDialog({ title: '显式安全回收临时功能？', message: `${item.name} · 固定 v${history.template_version}。回收后不可再挂载；保留固定定义、命令版本及使用审计，不删除历史，不重放未知动作。后台将重新核验全部挂载（含停用）、待执行、执行收尾与未知事实。`, confirmLabel: '确认安全回收', danger: true, confirmHelp: '仅在无引用、无在途及无未知副作用时标记已回收；历史只读保留，不可撤销。' }) || !current()) return;
      submitted = true;
      const result = await action('hooks.temporary_reclaim', { id: item.id, expected_revision: catalogue.registry.revision, client_request_id: clientId }, { refresh: false });
      if (result?.reclaimed !== true || result.template_id !== item.id || result.history_preserved !== true) throw Error('未收到匹配的回收收据。');
      saved = true;
      if (!current()) return;
      history = { ...history, lifecycle: 'reclaimed', reclaimed_at: result.reclaimed_at }; status.textContent = '安全回收成功；默认目录隐藏，包含已回收项后可查只读定义与审计。';
      try { if (!await onSaved()) throw Error('目录未刷新'); } catch (error) { if (current()) status.textContent += ` 刷新失败：${error.message}；回收已成功，不要重复提交。`; }
    } catch (error) { if (current()) { status.className = 'error'; status.textContent = `${error.message}；只读刷新核验，不自动重发回收。`; } }
    finally { loading = false; if (ownsPage()) paint(); }
  }, 'hook-button', { help: '显式回收临时定义，保留审计；有挂载、待执行、运行或未知结果时拒绝，之后不可再挂载。' });
  const reclaimHost = locked(reclaim, blocked), more = button('读取更早使用审计', () => read(true), 'ghost'); more.hidden = true;
  node.append(el('h2', '临时功能使用状态'), usage, reason, reclaimHost, status, button('只读刷新使用状态', () => read(), 'ghost'), audit); audit.append(more);
  node.invalidate = () => { history = null; status.textContent = '已离开此功能；返回后请只读刷新使用状态，旧响应不作为新核验。'; };
  node.refresh = () => read(); node.ready = read(); return node;
}

export function renderRegistryAutomation({ catalogue, item, ownsPage, onSaved, mode }) {
  const node = el('div', undefined, 'registry-automation');
  let disposed = false, active = true, epoch = 0;
  const owns = () => !disposed && active && ownsPage(); owns.epoch = () => epoch;
  node.setActive = value => { if (active !== value) { active = value; epoch++; if (!active) node.onInactive?.(); } };
  node.dispose = () => { disposed = true; epoch++; };
  if (mode === 'register') { node.append(registrationEditor({ catalogue, ownsPage: owns, onSaved })); return node; }
  if (mode === 'upgrade') {
    const status = el('p', `未登记挂载：${catalogue.registry.legacy_mount_count}。读取不会迁移。`, 'hint'); let submitted = false;
    const upgrade = button('显式升级旧规则', async () => {
      if (!owns() || submitted || !await confirmDialog({ title: '补登记并关联旧规则？', message: '保留挂载身份、启停、历史与去重证据，不执行、不重放。执行中规则或旧内联 Shell 会拒绝；请先结算或在 Worker 导入旧指令。', confirmLabel: '确认补登记', confirmHelp: '原子补登记旧模板和挂载，固定当前有效命令版本，不扩大授权。' }) || !owns()) return;
      submitted = true;
      try { await action('hooks.upgrade', { expected_revision: catalogue.registry.upgrade_revision }, { refresh: false }); if (owns()) { status.textContent = '旧规则已升级，身份与历史保留，未执行或重放。'; await onSaved(); } }
      catch (error) { if (owns()) { status.textContent = `${error.message}；现场保留，请只读刷新核对，不自动重试。`; status.className = 'error'; } }
      finally { host.sync(); }
    }, 'hook-button', { help: '显式补登记并关联旧规则；不重放，旧内联 Shell 与执行中规则会拒绝。' });
    const host = locked(upgrade, () => submitted ? '已提交，请返回目录只读核验，不重复升级。' : null); node.append(el('h1', '升级旧规则'), status, host); return node;
  }
  const facts = registryFacts(item); node.append(facts);
  if (item.temporary) {
    const mountOwns = () => owns() && item.lifecycle !== 'reclaimed'; mountOwns.epoch = owns.epoch;
    const updateFacts = () => { const open = facts.querySelector('details')?.open; facts.replaceChildren(...registryFacts(item).childNodes); facts.querySelector('details').open = open; };
    const mountNode = item.mountable ? projectMount({
      catalogue: { ...catalogue, registry: { ...catalogue.registry, items: [item] } }, item, ownsPage: mountOwns,
      onSaved: async () => {
        const epoch = owns.epoch(), result = await onSaved();
        if (!mountOwns() || epoch !== owns.epoch()) return result;
        const latest = result?.registry?.items?.find(next => next.id === item.id);
        if (latest) { Object.assign(item, latest); updateFacts(); }
        await usage.refresh(); return result;
      },
    }) : null;
    const advanced = el('details', undefined, 'registry-advanced'), definition = el('pre', '', 'registry-definition'); definition.setAttribute('data-worker-links', 'off');
    advanced.append(el('summary', '高级：固定安全定义（不可修改）'), el('p', '私有运行覆盖不回读；此处仅为固定版本的安全定义。', 'hint'), definition);
    const usage = temporaryUsage({ catalogue, item, ownsPage: owns, onSaved, onState: history => {
      const changed = item.lifecycle !== history.lifecycle || item.mount_count !== history.usage.mount_count;
      item.lifecycle = history.lifecycle;
      if (item.mount_count !== history.usage.mount_count) { item.targets = []; item.targets_complete = history.usage.mount_count === 0; }
      item.mount_count = history.usage.mount_count;
      if (changed) updateFacts();
      definition.textContent = JSON.stringify(history.definition, null, 2);
      if (mountNode) mountNode.hidden = history.lifecycle === 'reclaimed';
    } });
    node.ready = usage.ready; node.onInactive = usage.invalidate; node.append(usage);
    if (mountNode) node.append(mountNode);
    node.append(advanced); return node;
  }
  if (item.readonly) { node.append(el('p', '系统登记只读，不能通过通用编辑或挂载绕过专用授权。输入条件信号仍从输入／草稿管理。', 'hint')); return node; }
  if (item.mountable) node.append(projectMount({ catalogue, item, ownsPage: owns, onSaved }));
  else node.append(el('p', item.reason || '此功能当前不可挂载。', 'error'));
  const advanced = el('details', undefined, 'registry-advanced'); advanced.append(el('summary', '高级：规则、版本与修订'));
  const definition = catalogue.templates?.find(template => template.id === item.id);
  if (definition) { const preview = el('pre', JSON.stringify(definition, null, 2), 'registry-definition'); preview.setAttribute('data-worker-links', 'off'); advanced.append(el('p', `仅当前 v${item.version} 安全定义；私有运行覆盖不回读。历史版本：${item.versions.map(v => `v${v}`).join('、')}`, 'hint'), preview); }
  advanced.append(registrationEditor({ catalogue, item, ownsPage: owns, onSaved }));
  let removed = false;
  const remove = button('删除登记功能', async () => {
    if (!owns() || removed || item.mount_count || !await confirmDialog({ title: '删除此登记功能？', message: '仅允许没有挂载的功能删除，执行历史保留；不能撤销已经开始的动作。', confirmLabel: '删除登记', danger: true, confirmHelp: '删除未挂载的登记功能；仍有挂载时后台拒绝。' }) || !owns()) return;
    removed = true;
    try { await action('hooks.remove', { id: item.id, expected_revision: catalogue.registry.revision }, { refresh: false }); if (owns()) { remove.textContent = '已删除登记'; await onSaved(); } }
    catch (error) { if (owns()) node.append(el('p', `${error.message}；请返回目录核验，不自动重发。`, 'error')); }
    finally { removeHost.sync(); }
  }, 'ghost', { help: '仅删除未挂载的登记定义，历史保留；已有挂载时拒绝。' });
  const removeHost = locked(remove, () => item.mount_count ? '仍有挂载，须先从各 Worker 移除。' : removed ? '删除已提交，请只读核验。' : null);
  advanced.append(removeHost); node.append(advanced); return node;
}
