import { block, button, el } from './dom.js';
import { confirmDialog } from './dialog.js';
import { renderUsageSeries } from './render-agent-usage.js';
import { array, field, select, positive, note, SCOPES, SOURCES } from './connection-view-common.js';

/** Local history and sampling settings, independent of source/editor selection. */
export function createConnectionArchive({ read, post, current, getData, load, invalidateList, projectHistory, sharedSampling }) {
  let samplingDirty = false, samplingRevision = 0, samplingSaving = false;
  let historySequence = 0, historyFlight = null, historyKey = '', activeHistoryKey = '';
  const historyChoices = new Map();
  const samplingHost = block('后台采样'), samplingFeedback = el('p', undefined, 'hint'); samplingFeedback.setAttribute('role', 'status');
  const samplingForm = el('div', undefined, 'agent-connection-form');
  const samplingEnabled = field(samplingForm, '启用后台采样', 'sampling-enabled', 'checkbox', false);
  const interval = field(samplingForm, '采样间隔（分钟）', 'interval_minutes', 'number', 5); interval.min = '1'; interval.max = '1440'; interval.step = '1';
  const retention = field(samplingForm, '保留天数', 'retention_days', 'number', 90); retention.min = '1'; retention.max = '3650'; retention.step = '1';
  note(samplingHost, sharedSampling
    ? '设备采样配置由所有项目各自执行，后续读取来源或调用时刷新调度。历史仍归各项目，Host 不运行采样；缩短保留期限只影响各项目之后的清理。'
    : '默认关闭。开启后关闭页面仍采样，daemon 停止期间留空、不补查询；缩短保留天数会清理到期历史。');
  samplingHost.append(samplingForm, samplingFeedback);
  const historyHost = block('连接资源历史'), historyControls = el('div', undefined, 'agent-connection-history-controls');
  const historyConnection = select(historyControls, '历史连接', 'history-connection', [['', '请选择连接']], '');
  const historyId = field(historyControls, '已删除连接 ID（可选）', 'history-id', 'text', '', '连接删除不删除历史；可粘贴原连接 ID 查询。'); historyId.maxLength = 128;
  const days = select(historyControls, '历史范围', 'history-days', [['1', '24 小时'], ['7', '7 天'], ['30', '30 天'], ['90', '90 天']], '7');
  const historyFeedback = el('p', '选择连接后读取本地历史，不访问服务商。', 'hint agent-connection-history-feedback'); historyFeedback.setAttribute('role', 'status');
  const historyContent = el('div', undefined, 'agent-connection-history-content');
  historyHost.append(historyControls, historyFeedback, historyContent);
  samplingHost.hidden = historyHost.hidden = true;
  const historicalId = () => historyId.value.trim() || historyConnection.value;
  function paintHistoryChoices() {
    for (const connection of array(getData()?.connections)) historyChoices.set(connection.id, connection.label);
    const selected = historyConnection.value, ids = new Set(array(getData()?.connections).map(connection => connection.id));
    historyConnection.replaceChildren(); const blank = el('option', '请选择连接'); blank.value = ''; historyConnection.append(blank);
    for (const [id, name] of historyChoices) { const option = el('option', `${ids.has(id) ? '' : '已删除 · '}${name} · ${id}`); option.value = id; historyConnection.append(option); }
    historyConnection.value = historyChoices.has(selected) ? selected : '';
  }
  function loadHistory() {
    if (!current() || !projectHistory) return Promise.resolve();
    const id = historicalId(), key = `${id}\n${days.value}`;
    if (!id) { historySequence++; historyContent.replaceChildren(); historyFeedback.textContent = '请选择连接或填写原连接 ID。'; return Promise.resolve(); }
    if (historyFlight && historyKey === key) return historyFlight;
    const sequence = ++historySequence; historyKey = key;
    if (activeHistoryKey !== key) historyContent.replaceChildren();
    historyFeedback.textContent = '正在读取本地历史…'; historyFeedback.setAttribute('role', 'status');
    const pending = (async () => {
      try {
        const value = await read(`/api/agent/connections/history?id=${encodeURIComponent(id)}&days=${encodeURIComponent(days.value)}`);
        if (!current() || sequence !== historySequence || key !== `${historicalId()}\n${days.value}`) return;
        if (value?.version !== 1 || !Array.isArray(value.series)) throw new Error('invalid history');
        activeHistoryKey = key; historyContent.replaceChildren();
        for (const series of value.series) {
          const wrap = el('section', undefined, 'agent-connection-history-series');
          note(wrap, `${SCOPES[series.scope] || '范围未知'} · 来源：${SOURCES[series.source] || '历史来源'}${array(series.models).length ? ` · 模型：${series.models.join('、')}` : ''}`);
          wrap.append(renderUsageSeries(series, value, getData()?.sampling || {})); historyContent.append(wrap);
        }
        if (!value.series.length) note(historyContent, '暂无缓存样本；只有真实观测才会产生历史，未知不补零。');
        historyFeedback.textContent = value.truncated ? '历史已截断 / 降采样；不同账号、来源和单位分开显示，不跨缺失记录连线。' : '历史来自本地缓存，不访问服务商；账号和来源变化不会混为一条曲线。';
      } catch { if (current() && sequence === historySequence) { historyFeedback.textContent = '历史读取失败；已有图表仅为上次缓存，不代表当前资源状态。'; historyFeedback.setAttribute('role', 'alert'); } }
      finally { if (historyFlight === pending) historyFlight = null; }
    })();
    historyFlight = pending; return pending;
  }
  for (const input of [samplingEnabled, interval, retention]) {
    const changed = () => { samplingDirty = true; samplingRevision++; samplingFeedback.textContent = '有未保存的采样修改，刷新不会覆盖编辑。'; };
    input.type === 'checkbox' ? input.onchange = changed : input.oninput = changed;
  }
  samplingHost.append(button('保存采样设置', async () => {
    if (!current() || samplingSaving) return;
    let sampling;
    try { sampling = { enabled: samplingEnabled.checked, interval_minutes: positive(interval, 1440, '采样间隔'), retention_days: positive(retention, 3650, '保留天数') }; }
    catch (error) { samplingFeedback.textContent = error.message; samplingFeedback.setAttribute('role', 'alert'); return; }
    if (getData()?.sampling && sampling.retention_days < getData().sampling.retention_days) {
      const accepted = await confirmDialog({ title: '缩短历史保留期限？', message: '到期的连接观测历史将被永久清理。', confirmLabel: '保存并清理', danger: true,
        confirmHelp: '保存较短的保留期限并清理过期历史；清理不可撤销。' });
      if (!accepted || !current()) return;
    }
    samplingSaving = true; const revision = samplingRevision; invalidateList();
    try {
      await post('agent.connections.sampling', { sampling }); if (!current()) return;
      if (revision === samplingRevision) samplingDirty = false;
      await load(true); if (current()) { samplingFeedback.textContent = sharedSampling ? '设备采样配置已保存；所有项目后续读取时刷新调度，历史各归项目。' : '采样设置已保存；开启后关闭页面仍运行，daemon 停机期间留空。'; samplingFeedback.setAttribute('role', 'status'); }
    } catch { if (current()) { samplingFeedback.textContent = '采样设置保存失败；修改保留，请重试。'; samplingFeedback.setAttribute('role', 'alert'); } }
    finally { samplingSaving = false; }
  }));
  historyConnection.onchange = () => { historyId.value = ''; return loadHistory(); };
  days.onchange = loadHistory;
  historyControls.append(button('读取历史', loadHistory, 'ghost'));
  return { samplingHost, historyHost, loadHistory,
    apply(value) {
      paintHistoryChoices();
      if (!samplingDirty && !samplingSaving) {
        samplingEnabled.checked = Boolean(value.sampling?.enabled);
        interval.value = String(value.sampling?.interval_minutes ?? 5); retention.value = String(value.sampling?.retention_days ?? 90);
      }
    },
    invalidateHistory(clear = false) { historySequence++; if (clear) { historyHost.hidden = true; historyContent.replaceChildren(); } },
    showHistory(id) { historyConnection.value = id; historyId.value = ''; return loadHistory(); },
    focusHistory() { historyConnection.focus(); }, focusSampling() { samplingEnabled.focus(); } };
}
