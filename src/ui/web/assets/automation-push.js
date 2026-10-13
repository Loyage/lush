import { el, button, block } from './dom.js';
import { api } from './api.js';
import { detail } from './navigate.js';
import { mountCard, openHookTools } from './render-hooks.js';
import { renderShortcutCommandManagement } from './shortcut-commands.js';
import { validCommands } from './shortcut-command-model.js';
import { commandResultText } from './shortcut-command-runs.js';
import { absolute } from './format.js';
import { confirmDialog } from './dialog.js';

const labels = { 'hook.command_submitted': '触发已提交，等待安全执行', 'hook.execution_started': '开始执行',
  'hook.action_completed': '动作结果', 'hook.execution_succeeded': '执行成功', 'hook.execution_failed': '执行失败',
  'hook.execution_unknown': '结果未知，不自动重放', 'hook.execution_skipped': '已跳过' };

/** The actual main attachment, its referenced latest command definitions, and its own durable events. */
export function renderPushAutomation({ ownsPage, catalogue: initial }) {
  const node = el('div', undefined, 'automation-push');
  const settings = el('section', undefined, 'push-settings'), history = block('推送 Hook 运行记录');
  history.classList.add('push-history');
  const mountHost = el('div', undefined, 'command-hook-example'), commandHost = el('div', undefined, 'push-command-editor');
  const status = el('p', undefined, 'hint'); status.setAttribute('role', 'status');
  const settingsStatus = el('p', undefined, 'hint'); settingsStatus.setAttribute('role', 'status');
  const records = el('div', undefined, 'push-executions');
  let catalogue = initial, disposed = false, busy = false, mountEditing = false, commandEditing = false, commands = null;
  let reading = false, historyRead = false, resumeHistory = false, sequence = 0, cursor = null, hasMore = false, scanned = 0, tab = 'settings';
  const events = new Map(), owns = () => !disposed && ownsPage();
  const mount = () => catalogue?.command_example?.hooks?.mounts?.find(item => item.id === catalogue.command_example.hook_id);
  const example = () => catalogue?.command_example;
  const commandIds = () => new Set((mount()?.actions || []).filter(action => ['command', 'prompt_command'].includes(action.type)).map(action => action.command_id));
  function paintMount() {
    if (!owns() || mountEditing) return;
    const current = mount(), source = example(), model = source?.hooks;
    if (current && Number.isSafeInteger(source.worker_id) && model?.worker_id === source.worker_id && typeof model.revision === 'string' && model.revision) {
      mountHost.replaceChildren(mountCard({ id: source.worker_id, task_kind: 'main', status: 'waiting' }, current, model,
        () => loadCatalogue(), owns, { catalogue, scope: '仅 main Worker', busy: () => busy || commandEditing, setEditing(value) { mountEditing = value; } }));
      mountHost.append(button('查看 main Worker 自动化', () => owns() ? detail(source.worker_id) : undefined, 'ghost', { worker: source.worker_id }));
    } else mountHost.replaceChildren(el('p', source ? '挂载已删除或不可用；不会自动重装。已有历史保留，可在指令与 Hook 工具中显式配置规则。' : '推送挂载读面不可用；请更新服务后刷新，不会默认启用或创建。', 'hint'));
    if (source?.template_id) mountHost.append(button('管理来源模板', () => owns() ? openHookTools() : undefined, 'ghost', { help: '前往独立模板工具；修改模板不会改变 main 上的实际挂载。' }));
  }
  function paintCommands() {
    if (!owns()) return;
    if (!validCommands(catalogue?.commands)) {
      if (commands) commands.updateCommands?.(catalogue?.commands, catalogue);
      else commandHost.replaceChildren(el('p', '快捷指令目录不可用；不能编辑或校验指令引用。', 'error'));
      return;
    }
    if (!commands) {
      commands = renderShortcutCommandManagement({ catalogue, model: catalogue.commands, ownsPage: owns, busy: () => busy || mountEditing,
        setBusy(value) { busy = value; if (!value && owns()) mountHost.querySelector('.hook-mount')?.resume?.(); },
        setEditing(value) { commandEditing = value; }, allowCreate: false,
        filterCommand: command => commandIds().has(command.id), onCatalogue(result) { if (owns()) { catalogue = result; paintMount(); paintCommands(); } } });
      commandHost.replaceChildren(el('h2', '引用指令编辑'), el('p', '仅列出此挂载引用的指令。编辑影响所有引用的未来执行；已有挂载跟随最新定义，保存不执行，不停用挂载。', 'hint'), commands);
    }
    commands.updateCommands?.(catalogue.commands, catalogue); commands.setActive?.(tab === 'settings');
  }
  async function loadCatalogue() {
    if (!owns()) return;
    const result = await api('/api/hooks'); if (!owns()) return;
    catalogue = result; paintMount(); paintCommands(); settingsStatus.textContent = '';
  }
  function paintHistory() {
    records.replaceChildren();
    for (const event of [...events.values()].sort((a, b) => b.id - a.id)) {
      const card = el('article', undefined, 'hook-execution push-execution');
      card.append(el('h3', labels[event.type]), el('p', `${absolute(event.created_at)} · 事件 #${event.id}`, 'hint'));
      if (event.data.execution_id) card.append(el('p', `运行身份：${event.data.execution_id}`, 'hint'));
      if (event.data.command_result) card.append(el('p', commandResultText(event.data.command_result), ['failed', 'unknown'].includes(event.data.command_result.status) ? 'error' : 'hint'));
      if (typeof event.data.error === 'string') card.append(el('p', event.data.error, 'error'));
      records.append(card);
    }
    if (!events.size) records.append(el('p', historyRead ? hasMore ? '已读取范围内尚无该挂载记录，仍有更早事件未读取。' : '尚无该挂载运行记录。' : '尚未读取运行记录。', 'hint'));
    more.hidden = !hasMore; more.disabled = reading; refresh.disabled = reading;
  }
  async function loadHistory(older = false) {
    const source = example();
    if (!owns() || reading || older && !hasMore) return;
    if (!Number.isSafeInteger(source?.worker_id) || source.worker_id < 1 || typeof source.hook_id !== 'string' || !source.hook_id) {
      status.textContent = '推送挂载身份不可用，不能猜测或混入其他 Hook 的记录。'; return;
    }
    const epoch = ++sequence, before = older ? cursor : null; reading = true; resumeHistory = false; paintHistory(); status.textContent = '正在读取推送运行记录…';
    try {
      const page = await api(`/api/worker/${source.worker_id}/history-page?limit=100${before ? `&before=${before}` : ''}`);
      if (!owns() || epoch !== sequence) return;
      const remaining = page.has_more ?? page.truncated;
      if (!Array.isArray(page.events) || typeof remaining !== 'boolean' || page.events.some(event => !Number.isSafeInteger(event.id) || event.id < 1 || before && event.id >= before)
        || remaining && (!Number.isSafeInteger(page.cursor) || page.cursor < 1 || before && page.cursor >= before)) throw new Error('事件分页格式不兼容');
      if (!older) { events.clear(); scanned = 0; }
      for (const event of page.events) {
        let data; try { data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { continue; }
        if (data?.hook_id === source.hook_id && Object.hasOwn(labels, event.type)) events.set(event.id, { ...event, data });
      }
      scanned += page.events.length; cursor = page.cursor; hasMore = remaining; historyRead = true;
      status.textContent = `已读取 main 的 ${scanned} 条事件，匹配 ${events.size} 条该推送挂载的运行事件${hasMore ? '；仍可读取更早事件。' : '。'} 不含其他 Hook 或手动指令运行。`;
    } catch (error) { if (owns() && epoch === sequence) status.textContent = `记录读取失败：${error.message}；已加载记录保留，不代表推送失败，不会重跑。`; }
    finally {
      if (!disposed && epoch === sequence) {
        reading = false; resumeHistory = !owns(); if (owns()) paintHistory();
      }
    }
  }
  const refresh = button('刷新推送记录', () => loadHistory(), 'ghost'), more = button('读取更早运行事件', () => loadHistory(true), 'ghost');
  history.append(el('p', '按持久推送挂载身份读取 main 的执行事件。删除挂载不删除历史；失败不撤销已合并代码，未知结果不自动重跑。', 'hint'), status, records, refresh, more);
  const reload = button('刷新推送设置', async () => {
    if (!owns() || busy) return;
    if (mountEditing && !await confirmDialog({ title: '放弃挂载编辑并刷新？', message: '未保存的挂载编辑会丢失，指令草稿保留原 revision。', confirmLabel: '放弃并刷新' })) return;
    if (!owns()) return; mountEditing = false;
    try { await loadCatalogue(); } catch (error) { if (owns()) settingsStatus.textContent = `设置读取失败：${error.message}`; }
  }, 'ghost');
  settings.append(el('p', '成功收到合并后，由 main 的实际启用 Hook 执行所引用指令的最新定义。Git remote、跟踪分支和认证由你的 Git 配置决定；不会自动修改 Git 配置。', 'hint'), settingsStatus, mountHost, commandHost, reload);
  node.append(settings, history);
  node.setSubpage = next => {
    tab = next === 'history' ? 'history' : 'settings'; settings.hidden = tab !== 'settings'; history.hidden = tab !== 'history';
    commands?.setActive?.(tab === 'settings');
    const row = mountHost.querySelector('.hook-mount'); row?.resume?.();
    if (tab === 'settings' && (row?.needsRefresh || commands?.needsRefresh)) {
      settingsStatus.textContent = '离开期间有操作结束；不自动重发。草稿保留，请核对最新指令定义和挂载。';
      node.ready = loadCatalogue().catch(error => { if (owns()) settingsStatus.textContent = `设置读取失败：${error.message}；草稿保留，请只读刷新，不要重发。`; });
    }
    if (tab === 'history' && (!historyRead || resumeHistory)) node.ready = loadHistory();
    return node.ready;
  };
  node.setActive = active => commands?.setActive?.(active && tab === 'settings');
  node.updateCatalogue = result => { catalogue = result; paintMount(); paintCommands(); };
  node.dispose = () => { disposed = true; ++sequence; commands?.setActive?.(false); };
  paintMount(); paintCommands(); paintHistory(); node.setSubpage('settings'); node.ready = Promise.resolve(); return node;
}
