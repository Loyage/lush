import { el, button } from './dom.js';
import { api } from './api.js';
import { absolute } from './format.js';
import { usageWindow } from './usage-window.js';
import { scheduledWallTime } from './hook-schedule.js';

/** Local public observations only: never query providers or infer the next reset. */
export function createSignalResetPicker({ ownsPage = () => true, timezone, onSelect }) {
  const node = el('div', undefined, 'signal-reset-picker');
  const field = el('label', undefined, 'hook-field');
  const select = el('select'); select.setAttribute('aria-label', '订阅额度刷新时间');
  field.append(el('span', '从订阅额度刷新时间填入'), select);
  const note = el('p', '正在读取本地订阅缓存…', 'hint');
  let entries = [], loading = false, busy = false;
  const placeholder = () => { const option = el('option', '请选择订阅与额度窗口'); option.value = ''; return option; };
  const reason = entry => !Number.isFinite(Date.parse(entry.at)) ? '刷新时间未知或无效'
    : Date.parse(entry.at) <= Date.now() ? '刷新时间已到，请先在模型来源刷新额度' : '';
  const sync = () => {
    select.disabled = busy || loading || !entries.some(entry => !reason(entry));
    reload.disabled = busy || loading;
    reloadHost.tabIndex = reload.disabled ? 0 : -1;
    reloadHost.setAttribute('data-help', `${busy ? '正在保存信号，请稍候。' : loading ? '正在读取本地缓存，请稍候。' : ''} ${reload.getAttribute('data-help')}`);
  };
  const paint = () => {
    select.replaceChildren(placeholder()); select.value = '';
    for (const [index, entry] of entries.entries()) {
      const unavailable = reason(entry);
      const option = el('option', `${entry.label} · ${entry.at ? absolute(entry.at) : '时间未知'}${unavailable ? `（${unavailable}）` : ''}`);
      option.value = String(index); option.disabled = Boolean(unavailable); select.append(option);
    }
    sync();
  };
  async function load() {
    if (!ownsPage() || busy || loading) return;
    loading = true; sync();
    try {
      const result = await api('/api/agent/connections');
      if (!ownsPage()) return;
      entries = [];
      for (const connection of Array.isArray(result.connections) ? result.connections : []) {
        const observation = connection.observation;
        // Do not turn last_success from a failed/new account observation into a candidate.
        if (!['available', 'partial'].includes(observation?.status)) continue;
        for (const resource of Array.isArray(observation.resources) ? observation.resources : []) {
          if (resource.kind !== 'quota' || resource.scope !== 'account') continue;
          entries.push({ at: resource.reset_at, checkedAt: observation.checked_at,
            label: `${connection.label || connection.id} · ${resource.label || '订阅额度'} · ${usageWindow(resource.window_seconds)}${connection.enabled === false ? ' · 来源已停用' : ''}${observation.status === 'partial' ? ' · 部分观测' : ''}` });
        }
      }
      paint();
      note.textContent = entries.some(entry => !reason(entry))
        ? '选择后直接填入一次性日期，保留当前时区。仅复制缓存时间，不联网、不绑定或切换账号；可继续手动修改。'
        : '暂无可填入的未来订阅刷新时间（未知、失败或已到期的缓存不可用）。请先在「模型来源」刷新额度，再重新读取缓存；也可手动填写。';
    } catch (issue) {
      if (ownsPage()) { entries = []; paint(); note.textContent = `读取订阅缓存失败：${issue.message}；仍可手动填写时间。`; }
    } finally { loading = false; if (ownsPage()) sync(); }
  }
  const reload = button('重新读取订阅缓存', load, 'ghost', {
    help: '只读取当前项目的模型来源与本地额度缓存，不联网刷新、不调用 Agent，不改动已填时间。',
  });
  const reloadHost = el('span', undefined, 'help-host'); reloadHost.append(reload);
  select.onchange = () => {
    if (!ownsPage() || busy || loading || select.value === '') return;
    const entry = entries[Number(select.value)]; if (!entry) return;
    const unavailable = reason(entry);
    if (unavailable) { note.textContent = unavailable; paint(); return; }
    try {
      const zone = timezone().trim();
      const local = scheduledWallTime(entry.at, zone);
      onSelect({ kind: 'once', at: new Date(entry.at).toISOString(), timezone: zone }, local);
      note.textContent = `已填入：${entry.label}；缓存观测：${entry.checkedAt ? absolute(entry.checkedAt) : '时间未知'}。仅复制此时刻，不跟踪后续额度变化，时间已到不证明额度恢复。`;
    } catch (issue) { note.textContent = `${issue.message} 未改动时间，请修正信号时区后重新选择。`; }
  };
  node.append(field, reloadHost, note); paint();
  return { node, load, setBusy(value) { busy = value; sync(); } };
}
