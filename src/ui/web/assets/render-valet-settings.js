import { $, el, button } from './dom.js';
import { api, projectApi } from './api.js';
import { ui } from './state.js';
import { activateDetailView } from './sidebar-ui.js';
import { projectRoute } from './route.js';
import { confirmDialog } from './dialog.js';

const labels = { read: '只读', automatic: '自动执行', confirmation: '逐次确认', unavailable: '禁止' };
const accessLabel = (item, access) => access === 'unavailable' && item.base_access === 'unavailable' ? '固有不可用' : labels[access];
function validate(value) {
  if (value?.version !== 1 || value.scope !== 'project' || typeof value.revision !== 'string'
    || !Array.isArray(value.groups) || !Array.isArray(value.methods) || !value.permissions
    || new Set(value.methods.map(item => item.method)).size !== value.methods.length
    || Object.keys(value.permissions).length !== value.methods.length
    || value.methods.some(item => !value.groups.some(group => group.id === item.group)
      || !Array.isArray(item.allowed_access) || !item.allowed_access.includes(item.access)
      || value.permissions[item.method] !== item.access || item.allowed_access.some(access => !labels[access]))) {
    throw Error('权限目录不完整或不兼容，请重新读取。');
  }
  return value;
}

/** Retained project-local editor. No RPC list or authorization policy is duplicated here.
 * The shell supplies its navigation guard: importing navigation from this lazy
 * page would add a separate startup shared chunk without any new capability.
 */
export async function openValetSettings({ registerPageLeaveGuard }) {
  if (!projectRoute()) return;
  const view = activateDetailView({ view: 'valet-settings' });
  const owner = globalThis.document, project = projectApi('/api/management/permissions');
  const existing = ui.valetSettingsPage;
  if (existing?.view === view && existing.owner === owner && existing.project === project) return existing.ready;
  ui.disposeValetSettings?.();
  const state = { view, owner, project, disposed: false, generation: 0, data: null, draft: null, busy: false, uncertain: false };
  ui.valetSettingsPage = state;
  const owns = () => !state.disposed && globalThis.document === owner && ui.view === view
    && ui.valetSettingsPage === state && projectApi('/api/management/permissions') === project;
  const dirty = () => state.data && state.data.methods.some(item => state.draft[item.method] !== state.data.permissions[item.method]);
  const root = el('div', undefined, 'valet-settings-page');
  const hero = el('header', undefined, 'resource-hero');
  hero.append(el('h1', '管家设置'), el('p', '本项目新建管家的默认权限。按功能查看策略，具体接口按需展开；只能收紧已审核的权限上限。'));
  const groups = el('div', undefined, 'valet-permission-groups');
  const footer = el('section', undefined, 'valet-settings-save resource-card');
  const status = el('p', '正在读取权限…', 'valet-settings-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const save = el('button', '保存管家默认权限', 'primary'); save.type = 'button'; save.onclick = saveDraft;
  const reload = el('button', '重新读取', 'ghost'); reload.type = 'button'; reload.onclick = () => load(true);
  reload.setAttribute('data-help', '只读核对当前项目设置；有未保存草稿时先确认放弃，不重放任何保存请求。');
  footer.append(el('h2', '保存与生效'), el('p', '统一保存不调用 Agent。仅影响本项目之后新建的 Valet；已有管家的权限快照不变。危险操作始终逐次确认，原有安全门不变。', 'hint'), status, save, reload);
  root.append(hero, groups, footer); $('detail').replaceChildren(root);
  const selects = new Map(), summaries = new Map(), quickButtons = [];
  function setStatus(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
  function sync() {
    save.disabled = !state.data || state.busy || state.uncertain || !dirty(); reload.disabled = state.busy;
    for (const [method, select] of selects) {
      const item = state.data.methods.find(item => item.method === method);
      select.value = state.draft[method]; select.disabled = state.busy || item.allowed_access.length < 2;
    }
    for (const node of quickButtons) node.disabled = state.busy;
    for (const [group, summary] of summaries) {
      const items = state.data.methods.filter(item => item.group === group), counts = new Map();
      for (const item of items) { const text = accessLabel(item, state.draft[item.method]); counts.set(text, (counts.get(text) || 0) + 1); }
      summary.textContent = `${items.length} 项接口 · ${[...counts].map(([text, count]) => `${text} ${count}`).join(' / ')}${counts.size > 1 ? ' · 混合策略，展开查看' : ''}`;
    }
  }
  function paint() {
    const expanded = new Set([...groups.querySelectorAll('details')].filter(node => node.open).map(node => node.dataset.group));
    groups.replaceChildren(); selects.clear(); summaries.clear(); quickButtons.length = 0;
    for (const group of state.data.groups) {
      const items = state.data.methods.filter(item => item.group === group.id);
      const card = el('section', undefined, 'valet-permission-group resource-card'); card.dataset.group = group.id;
      const summary = el('p', undefined, 'valet-policy-summary'); summaries.set(group.id, summary);
      card.append(el('h2', group.label), el('p', group.description, 'hint'), summary);
      const tools = el('div', undefined, 'valet-group-tools');
      const quick = (label, help, choose) => {
        const node = button(label, () => {
          if (!owns() || state.busy) return;
          for (const item of items) { const access = choose(item); if (item.allowed_access.includes(access)) state.draft[item.method] = access; }
          setStatus('草稿已修改，尚未保存。'); sync();
        }, 'ghost', { help }); tools.append(node); quickButtons.push(node);
      };
      quick('恢复审核上限', '仅将本组接口恢复到后台审核上限，固有不可用不开放，危险操作仍需逐次确认。', item => item.base_access);
      quick('可确认的写操作需确认', '仅将本组允许 confirmation 的写操作设为逐次确认；只读、固定条目及固有不可用不变。', () => 'confirmation');
      quick('禁止可调能力', '仅禁止本组 allowed_access 允许 unavailable 的能力；必要目录固定只读，不被禁用。', () => 'unavailable');
      const details = el('details', undefined, 'valet-methods'); details.dataset.group = group.id; details.open = expanded.has(group.id);
      details.append(el('summary', `具体接口与精细设置（${items.length}）`));
      for (const item of items) {
        const row = el('div', undefined, 'valet-permission-method'); row.dataset.method = item.method;
        const copy = el('div'); copy.append(el('strong', item.label), el('code', item.method), el('p', item.description, 'hint'));
        const label = el('label', '默认策略'); const select = el('select'); select.setAttribute('aria-label', `${item.label}（${item.method}）默认策略`);
        for (const access of item.allowed_access) { const option = el('option', accessLabel(item, access)); option.value = access; select.append(option); }
        select.onchange = () => {
          if (!owns() || state.busy || !item.allowed_access.includes(select.value)) { sync(); return; }
          state.draft[item.method] = select.value; setStatus('草稿已修改，尚未保存。'); sync();
        };
        selects.set(item.method, select); label.append(select);
        const host = el('span', undefined, 'help-host');
        if (item.allowed_access.length === 1) host.setAttribute('data-help', item.base_access === 'unavailable' ? (item.reason || '后台未开放此能力，不能通过默认设置提权。') : '此条目是必要能力，后台固定其权限，不可禁用。');
        host.append(label); row.append(copy, host); details.append(row);
      }
      card.append(tools, details); groups.append(card);
    }
    sync();
  }
  async function load(discard = false) {
    if (!owns() || state.busy) return;
    if (discard && (dirty() || state.uncertain)) {
      const accepted = await confirmDialog({ title: '放弃草稿并重新读取？', message: '将用当前项目权威设置替换本地草稿。若上次保存结果未知，只读取核对，不自动重放。', confirmLabel: '放弃并读取', danger: true });
      if (!accepted || !owns() || state.busy) return;
    }
    const generation = ++state.generation; state.busy = true; sync(); setStatus('正在读取权限…');
    try {
      const value = validate(await api('/api/management/permissions'));
      if (!owns() || generation !== state.generation) return;
      state.data = value; state.draft = { ...value.permissions }; state.uncertain = false; paint(); setStatus('已读取当前项目默认权限。');
    } catch (error) { if (owns() && generation === state.generation) setStatus(`读取失败：${error.message}。草稿保留，请重新读取。`, true); }
    finally { if (owns() && generation === state.generation) { state.busy = false; sync(); } }
  }
  async function saveDraft() {
    if (!owns() || state.busy || state.uncertain || !dirty()) return;
    state.busy = true; sync(); setStatus('正在保存…'); const generation = ++state.generation;
    try {
      const value = validate(await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        method: 'management.permissions_update', params: { permissions: { ...state.draft }, expected_revision: state.data.revision },
      }) }));
      if (!owns() || generation !== state.generation) return;
      state.data = value; state.draft = { ...value.permissions }; state.uncertain = false;
      setStatus('已保存。之后新建的管家使用此默认权限，已有管家不变。');
    } catch (error) {
      if (owns() && generation === state.generation) {
        state.uncertain = true;
        setStatus(/revision|修订|conflict/i.test(error.message)
          ? `多标签或并发修改冲突：${error.message}。草稿保留，请重新读取后编辑，不自动覆盖。`
          : `保存未确认：${error.message}。草稿保留；结果可能未知，请重新读取核对，不自动重放。`, true);
      }
    } finally { if (owns() && generation === state.generation) { state.busy = false; sync(); } }
  }
  const unregister = registerPageLeaveGuard(target => {
    if (!owns() || target === '#valet-settings') return true;
    if (state.busy) { setStatus('请求尚未结束，请等待后离开。'); return false; }
    if (!dirty() && !state.uncertain) return true;
    return confirmDialog({ title: '离开并丢弃未保存更改？', message: '离开将丢弃本地权限草稿；未确认的保存建议先重新读取核对。', confirmLabel: '丢弃并离开', danger: true }).then(accepted => accepted && owns());
  }, { stay: () => { if (owns()) window.history.replaceState(null, '', '#valet-settings'); return false; } });
  const beforeUnload = event => { if (owns() && (dirty() || state.busy || state.uncertain)) { event.preventDefault?.(); event.returnValue = ''; } };
  globalThis.addEventListener?.('beforeunload', beforeUnload);
  ui.disposeValetSettings = () => { state.disposed = true; ++state.generation; unregister(); globalThis.removeEventListener?.('beforeunload', beforeUnload); if (ui.valetSettingsPage === state) ui.valetSettingsPage = null; };
  state.ready = load(); return state.ready;
}
