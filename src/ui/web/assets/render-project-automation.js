import { $, el, button, badge } from './dom.js';
import { api, projectApi } from './api.js';
import { ui } from './state.js';
import { activateDetailView } from './sidebar-ui.js';
import { listEntry, listSurface } from './list-surface.js';
import { searchField } from './search-field.js';
import { show } from './messages.js';
import { confirmDialog } from './dialog.js';
import { automationFeature, automationHash } from './automation-features.js';

export const automationOrigin = origin => ({ builtin: '内置', custom: '自定义', system: '系统' })[origin] || '未知来源';
const builtinId = (feature, catalogue) => feature === 'completion' ? 'builtin:completion' : feature === 'acceptance_notice' ? 'builtin:acceptance-notice' : feature === 'push' ? catalogue?.command_example?.template_id : feature;
const builtinFeature = (id, catalogue) => id === 'builtin:completion' ? 'completion' : id === 'builtin:acceptance-notice' ? 'acceptance_notice' : id === catalogue?.command_example?.template_id ? 'push' : null;

/** Retained project/document/view shell. Definitions and builtin settings stay lazy. */
export async function openProjectAutomation({ feature = null, subpage = 'settings', push = true } = {}) {
  if (feature === 'emission') {
    const view = ui.view, owner = globalThis.document, project = projectApi('/api/hooks');
    const { openInputs } = await import('./render-inputs.js');
    if (ui.view !== view || globalThis.document !== owner || projectApi('/api/hooks') !== project) return;
    ui.disposeProjectAutomation?.(); return openInputs({ push });
  }
  if (feature === 'convergence') { feature = null; window.history.replaceState(null, '', '#hooks'); show('持续归并设置已退役；普通自动合并与已有历史保留。'); }
  const view = activateDetailView({ view: 'hooks', title: '项目自动化', hint: '先查可用功能；临时定义与长期登记均须单独挂载', hash: automationHash(feature), push });
  const project = projectApi('/api/hooks'), owner = globalThis.document, existing = ui.automationPage;
  if (existing?.view === view && existing.project === project && existing.owner === owner && !existing.disposed) return existing.select(feature, subpage);
  ui.disposeProjectAutomation?.();
  const state = { view, project, owner, feature: null, nodes: new Map(), request: 0, readRequest: 0, disposed: false, catalogue: null, includeReclaimed: false, nextCursor: null };
  ui.automationPage = state;
  const owns = () => !state.disposed && owner === globalThis.document && ui.view === view && ui.automationPage === state && projectApi('/api/hooks') === project;
  const root = el('div', undefined, 'hooks-page project-automation resource-page'), browse = el('section', undefined, 'automation-browse');
  const hero = el('header', undefined, 'resource-hero');
  hero.append(el('span', 'AUTOMATION', 'resource-kicker'), el('h1', '项目自动化'), el('p', '先查找可用功能；临时需求无需先建立长期项。选择 Worker 和固定版本另行确认挂载，创建或挂载不等于执行成功。'));
  let entries = [], keyword = '';
  const empty = el('p', '', 'hint'); empty.hidden = true;
  const filter = () => { let count = 0; for (const entry of entries) { entry.node.hidden = !entry.text.includes(keyword); if (!entry.node.hidden) count++; } empty.hidden = count !== 0; empty.textContent = keyword ? '没有匹配的自动化功能。' : '项目尚无登记功能。'; };
  const search = searchField({ label: '查找自动化功能', placeholder: '按名称、用途或来源查找', scope: '范围：已读取的项目登记目录（不含设备自动选择）', onSubmit: value => { keyword = value.toLowerCase(); filter(); } });
  const card = el('section', undefined, 'resource-card automation-directory'), heading = el('div', undefined, 'section-title'), count = el('span', '', 'count');
  heading.append(el('h2', '自动化功能'), count);
  const list = el('ol', undefined, 'automation-feature-list'); list.setAttribute('aria-label', '自动化功能');
  const status = el('p', '', 'hint'); status.setAttribute('role', 'status');
  const controls = el('div', undefined, 'actions hook-actions');
  const reclaimed = el('label', '包含已回收临时项', 'hook-field'), reclaimedInput = el('input'); reclaimedInput.type = 'checkbox'; reclaimedInput.setAttribute('aria-label', '包含已回收临时项'); reclaimed.append(reclaimedInput);
  reclaimedInput.onchange = () => { state.includeReclaimed = reclaimedInput.checked; return state.reload(); };
  const more = button('继续读取功能', () => state.reload(true), 'ghost'); more.hidden = true;
  controls.append(reclaimed, button('登记新功能', () => openProjectAutomation({ feature: 'register' }), 'nav-link'), button('刷新目录', () => state.reload(), 'ghost'));
  card.append(heading, status, list, empty, more); browse.append(hero, search.root, controls, card);
  listSurface({ root: browse, tools: search.root, card, heading, body: list });
  const panel = el('section', undefined, 'automation-feature-page'); panel.hidden = true;
  root.append(browse, panel); $('detail').replaceChildren(root);
  state.dispose = () => { state.disposed = true; ++state.request; for (const node of state.nodes.values()) node.dispose?.(); state.nodes.clear(); };
  ui.disposeProjectAutomation = state.dispose;
  const paintDirectory = () => {
    const registry = state.catalogue.registry; entries = []; list.replaceChildren();
    count.textContent = `${registry.items.length} / ${registry.total}`;
    status.textContent = `${registry.has_more ? '目录未列全，以下仅为已读取项；请显式继续读取。' : '当前筛选目录已完整读取。'}${registry.legacy_mount_count ? ` 另有 ${registry.legacy_mount_count} 个未登记挂载，须显式升级；读取不会迁移。` : ''}`;
    more.hidden = !registry.has_more; more.disabled = false;
    if (registry.legacy_mount_count || registry.items.some(item => !item.readonly && !item.mountable)) status.append(button('检查并升级旧规则', () => openProjectAutomation({ feature: 'upgrade' }), 'nav-link'));
    for (const item of registry.items) {
      const row = el('li', undefined, 'automation-feature'); row.dataset.feature = builtinFeature(item.id, state.catalogue) || item.id;
      const link = el('a', undefined, 'automation-feature-link'); link.href = automationHash(builtinFeature(item.id, state.catalogue) || item.id);
      const head = el('span', undefined, 'automation-feature-head'); head.append(el('strong', item.name), ...(item.temporary ? [badge('临时'), ...(item.lifecycle === 'reclaimed' ? [badge('已回收 · 只读')] : [])] : []), badge(automationOrigin(item.origin)), badge(`${item.mount_count} 个挂载`));
      link.append(head, el('span', item.purpose, 'automation-feature-description'), el('span', '查看详情 →', 'automation-feature-open'));
      if (item.reason && !item.readonly) link.append(el('span', item.reason, 'error'));
      link.onclick = event => { if (event?.button > 0 || event?.metaKey || event?.ctrlKey || event?.shiftKey || event?.altKey) return; event?.preventDefault?.(); return openProjectAutomation({ feature: builtinFeature(item.id, state.catalogue) || item.id }); };
      row.append(listEntry(link)); list.append(row); entries.push({ node: row, text: `${item.name} ${item.purpose} ${automationOrigin(item.origin)} ${item.temporary ? '临时' : ''} ${item.lifecycle === 'reclaimed' ? '已回收' : ''}`.toLowerCase() });
    }
    filter();
  };
  state.reload = async (append = false) => {
    const cursor = append ? state.nextCursor : null, previous = state.catalogue;
    if (append && !cursor) return;
    const request = ++state.readRequest; status.textContent = '正在读取登记目录…'; more.disabled = true;
    try {
      const catalogue = await api(`/api/hooks?include_reclaimed=${state.includeReclaimed}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`); if (!owns() || request !== state.readRequest) return;
      if (!Array.isArray(catalogue?.registry?.items)) throw Error('登记目录不可用，请更新服务。');
      if (append) {
        if (previous.registry.revision !== catalogue.registry.revision) throw Error('目录版本已变化，请刷新后重新续读。');
        catalogue.registry.items = [...previous.registry.items, ...catalogue.registry.items];
        catalogue.templates = [...previous.templates, ...catalogue.templates];
      }
      state.nextCursor = catalogue.registry.next_cursor;
      state.catalogue = catalogue; ui.hookCatalogue = catalogue; paintDirectory(); return catalogue;
    } catch (error) { if (owns() && request === state.readRequest) { more.disabled = false; status.replaceChildren(el('span', `登记目录读取失败：${error.message}；已读取内容不代表全部。`, 'error'), button('重新读取目录', () => state.reload(), 'ghost')); } }
  };
  state.select = async id => {
    if (!owns()) return;
    const request = ++state.request; state.feature = id;
    for (const [key, node] of state.nodes) { node.hidden = key !== id; node.setActive?.(key === id); }
    browse.hidden = Boolean(id); panel.hidden = !id;
    if (!id) { panel.replaceChildren(); return; }
    const current = () => owns() && state.feature === id && request === state.request;
    let node = state.nodes.get(id);
    const content = el('div', undefined, 'automation-feature-content');
    panel.replaceChildren(button('← 返回自动化功能列表', () => openProjectAutomation(), 'nav-link nav-back'), button('重新读取此功能', async () => {
      if (!current()) return;
      if (!await confirmDialog({ title: '重新读取功能？', message: '放弃此功能页面的未保存草稿并只读核验最新目录；不会重新提交登记或挂载。', confirmLabel: '放弃草稿并读取', confirmHelp: '只读刷新并释放当前草稿，不重放未知写请求。' }) || !current()) return;
      const next = await state.reload(); if (!current() || !next) return;
      state.nodes.get(id)?.dispose?.(); state.nodes.delete(id); return state.select(id);
    }, 'ghost'), content);
    if (node) { node.hidden = false; content.append(node); node.setSubpage?.('settings'); return node.ready; }
    content.append(el('p', '正在读取功能…', 'hint'));
    try {
      const catalogue = state.catalogue || await state.loading; if (!current()) return;
      if (!catalogue) throw Error('请返回目录重新读取。');
      let item = catalogue.registry.items.find(item => item.id === builtinId(id, catalogue));
      // A retained temporary bookmark remains readable even when reclaimed or outside this page.
      if (!item && /^[0-9a-f-]{36}$/i.test(id)) {
        const history = await api(`/api/hooks/temporary/history?id=${encodeURIComponent(id)}`); if (!current()) return;
        item = { ...history.definition, id, temporary: true, lifecycle: history.lifecycle, readonly: true, mountable: history.lifecycle === 'active', origin: 'custom', version: history.template_version, versions: [history.template_version], purpose: history.purpose, usage: history.usage, mount_count: history.usage.mount_count, targets: [], targets_complete: history.usage.mount_count === 0 };
      }
      const builtin = item && builtinFeature(item.id, catalogue);
      if (!item && !['register', 'upgrade'].includes(id)) throw Error('功能未登记或不在已读取目录中；请返回列表继续读取。');
      const options = { catalogue, item, ownsPage: () => owns() && state.feature === id, onSaved: () => state.reload() };
      if (builtin) {
        const render = await automationFeature(builtin).load(); if (!current()) return;
        node = render(options);
        const { registryFacts, registrationEditor } = await import('./automation-registry.js'); if (!current()) return;
        node.prepend(registryFacts(item));
        if (builtin === 'push' && !item.readonly) {
          const advanced = el('details', undefined, 'registry-advanced'); advanced.append(el('summary', '高级：登记推送功能新版本'), registrationEditor(options)); node.append(advanced);
        }
      } else {
        const { renderRegistryAutomation } = await import('./automation-registry.js'); if (!current()) return;
        node = renderRegistryAutomation({ ...options, mode: id });
      }
      state.nodes.set(id, node); content.replaceChildren(node); await node.ready;
    } catch (error) { if (current()) content.replaceChildren(el('p', `功能读取失败：${error.message}`, 'error'), button('重新读取', () => state.select(id), 'ghost')); }
  };
  state.loading = state.reload(); await state.loading; return state.select(feature);
}
