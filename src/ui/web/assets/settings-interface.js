/** Device-authoritative interface preferences and their page/epoch lifecycle. */
import { $, block, button, el } from './dom.js';
import { effectiveTheme, systemThemeMedia } from './appearance.js';
import { PREF_NAMES, POLLING_MODES, THEME_VALUES, TOAST_MODES, TRANSCRIPT_ORDER_MODES, onPrefChange, readPref } from './prefs.js';
import * as devicePreferences from './prefs.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { SORT_MODES } from './tree-order.js';
import { notificationControl } from './notice-notifications.js';
import { backgroundPushControl } from './push-controls.js';
import { row } from './settings-controls.js';
import { NOTICE_CATEGORIES } from './notice-channels.js';

export function createInterfaceSettings({ renderSettings, isInterface }) {
  let preferenceActions = devicePreferences;
  let preferenceMessage = '', preferenceFailed = false, preferenceEpoch = 0, disposePreferenceStatus = null, settingsDocument = null;

  function openSettings({ preferenceActions: actions = devicePreferences } = {}) {
    disposePreferenceStatus?.(); disposePreferenceStatus = null;
    preferenceActions = actions; settingsDocument = globalThis.document;
    preferenceMessage = ''; preferenceFailed = false;
    const owner = settingsDocument, view = activateDetailView({ view: 'settings' }), epoch = ++preferenceEpoch;
    const rendering = renderSettings();
    if (typeof actions.onDevicePreferences === 'function') {
      disposePreferenceStatus = actions.onDevicePreferences(status => {
        if (globalThis.document === owner && epoch === preferenceEpoch && ui.view === view && ui.settingsOpen && isInterface()) updatePreferenceStatus($('detail'), status);
      });
    }
    return Promise.all([rendering, refreshPreferences(view, actions, epoch)]);
  }

  async function refreshPreferences(view, actions, epoch) {
    const owner = globalThis.document;
    if (typeof actions.refreshDevicePreferences !== 'function') return;
    try { await actions.refreshDevicePreferences(); }
    catch (error) { if (globalThis.document === owner && epoch === preferenceEpoch) preferenceFeedback(`读取设备偏好失败：${error.message}；未将本地缓存写回 Host。`, true, view); }
    finally {
      if (globalThis.document === owner && epoch === preferenceEpoch && ui.view === view && ui.settingsOpen && isInterface()) updatePreferenceStatus($('detail'), actions.devicePreferencesStatus?.());
    }
  }

  function preferenceHost(control, help = '设备权威偏好尚未就绪或正在保存；本地缓存不会作为保存来源。') {
    const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', help); host.append(control); return host;
  }

  function updatePreferenceStatus(root, status) {
    const note = root.querySelector('[data-device-preference-status=""]');
    if (note) {
      note.textContent = status?.error ? `设备偏好同步失败：${status.error}；可重新读取。`
        : status?.saving ? '正在保存设备偏好…'
        : status?.ready === false ? '正在读取设备权威偏好；当前仅显示缓存，读取完成前不能保存。'
        : status?.ready ? `设备权威偏好已读取${status.revision ? `（版本 ${status.revision}）` : ''}；本地浏览器只保留显示缓存。`
        : '设备偏好由 Host 保存；本地浏览器只保留显示缓存。';
      note.className = status?.error ? 'settings-error' : 'hint'; note.setAttribute('role', status?.error ? 'alert' : 'status');
    }
    const blocked = status?.ready === false || status?.saving === true;
    for (const control of [...root.querySelectorAll('input'), ...root.querySelectorAll('select')]) {
      if (Object.hasOwn(control.dataset, 'pref') && control.dataset.pref !== 'noticeNotifications') control.disabled = blocked || control.dataset.preferencePending === 'true';
    }
    const reset = root.querySelector('.pref-reset'); if (reset) reset.disabled = blocked || reset.dataset.preferencePending === 'true';
  }


  function preferenceFeedback(message, failed, view) {
    if (ui.view !== view || !ui.settingsOpen) return;
    preferenceMessage = message; preferenceFailed = failed;
    const note = $('detail').querySelector('[data-device-preference-feedback=""]');
    if (note) { note.textContent = message; note.className = failed ? 'settings-error' : 'hint'; note.setAttribute('role', failed ? 'alert' : 'status'); }
  }

  async function savePreference(name, value, input, view) {
    if (!ui.settingsOpen || ui.view !== view || input.disabled) return;
    const actions = preferenceActions, epoch = preferenceEpoch;
    input.dataset.preferencePending = 'true'; input.disabled = true; preferenceFeedback('正在保存设备偏好…', false, view);
    try {
      if (typeof actions.saveDevicePreference !== 'function') throw new Error('界面尚不支持设备偏好保存，请更新 Host');
      await actions.saveDevicePreference(name, value);
      if (epoch === preferenceEpoch) preferenceFeedback('设备偏好已保存，所有项目使用同一设置。', false, view);
    } catch (error) { if (epoch === preferenceEpoch) preferenceFeedback(`保存失败：${error.message}；未保存修改保留，未退回浏览器本地写入。`, true, view); }
    finally {
      delete input.dataset.preferencePending; input.disabled = false;
      if (epoch === preferenceEpoch && ui.view === view && ui.settingsOpen) updatePreferenceStatus($('detail'), actions.devicePreferencesStatus?.());
    }
  }

  function toggleControl(name, onLabel = '开启', offLabel = '关闭') {
    const view = ui.view;
    const wrap = el('label', undefined, 'settings-toggle');
    const input = el('input'); input.type = 'checkbox'; input.className = 'pref-toggle'; input.dataset.pref = name;
    input.checked = Boolean(readPref(name));
    input.addEventListener('change', () => savePreference(name, input.checked, input, view));
    wrap.append(input, el('span', input.checked ? onLabel : offLabel));
    return preferenceHost(wrap);
  }

  function themeControl() {
    const view = ui.view;
    const group = el('div', undefined, 'settings-choices');
    const current = readPref('theme');
    const labels = { system: '跟随系统', light: '浅色', dark: '深色' };
    for (const value of THEME_VALUES) {
      const wrap = el('label', undefined, 'settings-choice');
      const input = el('input'); input.type = 'radio'; input.name = 'theme-preference'; input.className = 'pref-radio';
      input.dataset.pref = 'theme'; input.dataset.value = value; input.checked = current === value;
      input.addEventListener('change', () => input.checked ? savePreference('theme', value, input, view) : undefined);
      wrap.append(input, el('span', labels[value] ?? value)); group.append(preferenceHost(wrap));
    }
    return group;
  }

  function selectControl(name, modes, title) {
    const view = ui.view;
    const select = el('select'); select.className = 'pref-select'; select.dataset.pref = name;
    if (title) select.setAttribute('aria-label', title);
    for (const mode of modes) { const option = el('option', mode.label); option.value = mode.id; select.append(option); }
    select.value = readPref(name);
    select.addEventListener('change', () => savePreference(name, modes.some(mode => mode.id === select.value) ? select.value : modes[0]?.id, select, view));
    return preferenceHost(select);
  }

  function noticeChannelControl(type, label) {
    const view = ui.view;
    const group = el('div', undefined, 'settings-choices');
    for (const [channel, text] of [['banner', '页面告知条'], ['system', '系统通知']]) {
      const wrap = el('label', undefined, 'settings-choice');
      const input = el('input'); input.type = 'checkbox';
      input.dataset.pref = 'noticeChannels'; input.dataset.noticeType = type; input.dataset.channel = channel;
      input.checked = readPref('noticeChannels')[type][channel];
      input.setAttribute('aria-label', `${label}：${text}`);
      input.addEventListener('change', () => {
        const value = structuredClone(readPref('noticeChannels')); value[type][channel] = input.checked;
        return savePreference('noticeChannels', value, input, view);
      });
      wrap.append(input, el('span', text)); group.append(preferenceHost(wrap));
    }
    return group;
  }

  function interfaceTab() {
    const view = ui.view;
    const content = el('div', undefined, 'settings-tab-panel');
    const status = preferenceActions.devicePreferencesStatus?.(), epoch = preferenceEpoch, actions = preferenceActions;
    const statusNote = el('p', '', 'hint'); statusNote.dataset.devicePreferenceStatus = ''; content.append(statusNote);
    if (typeof actions.refreshDevicePreferences === 'function') content.append(button('重新读取设备偏好', () => {
      if (ui.view !== view || !ui.settingsOpen || epoch !== preferenceEpoch) return;
      preferenceFeedback('', false, view); return refreshPreferences(view, actions, epoch);
    }, 'ghost', { help: '只重新读取设备权威偏好，不将浏览器缓存写回 Host，不修改项目工作状态。' }));
    const feedback = el('p', preferenceMessage, preferenceFailed ? 'settings-error' : 'hint');
    feedback.dataset.devicePreferenceFeedback = ''; feedback.setAttribute('role', preferenceFailed ? 'alert' : 'status'); content.append(feedback);
    const reading = block('阅读');
    reading.append(row('Markdown 渲染', '控制 Agent 输出的展示方式。', toggleControl('markdown')));
    reading.append(row('执行过程排序', '全屏执行详情默认最新在前，也可在阅读页直接切换为按时间正序。', selectControl('transcriptOrder', TRANSCRIPT_ORDER_MODES, '执行过程阅读顺序')));
    content.append(reading);

    const system = systemThemeMedia();
    const appearance = block('外观');
    appearance.append(row('设备主题', `所有项目共用。系统当前${system?.matches ? '深色' : '浅色'}，实际显示${effectiveTheme() === 'dark' ? '深色' : '浅色'}。`, themeControl()));
    appearance.append(row('减少动态效果', `覆盖系统偏好（系统当前${system?.matches ? '已要求减少' : '未要求'}）。`, toggleControl('reduceMotion')));
    content.append(appearance);

    const navigation = block('导航');
    navigation.append(row('信息列表排序', '各项目的 Worker 与待决事项使用同一排序习惯。', selectControl('sidebarSort', SORT_MODES, '信息列表排序方式')));
    content.append(navigation);

    const behavior = block('刷新与提示');
    behavior.append(row('轮询频率', '控制页面快照与实时状态刷新；修改后立即生效。', selectControl('polling', POLLING_MODES, '页面自动刷新频率')));
    behavior.append(row('消息停留时长', '控制顶部信息与错误提示自动消失的速度。', selectControl('toastDuration', TOAST_MODES, '消息提示停留时长')));
    behavior.append(row('系统通知总开关', '设备统一开关，默认关闭；当前浏览器仍需单独授权，后台提醒还需显式订阅。重新开启不补发积压。', notificationControl()));
    behavior.append(row('手机与后台推送', '仅管理此浏览器。iPhone／iPad 16.4+ 请先添加到主屏幕；远程访问需 HTTPS。界面在线加载，服务器更新后可重新加载，不需更新安装包。', backgroundPushControl()));
    content.append(behavior);

    const notices = block('提醒方式');
    notices.append(el('p', '所有项目共用这些提醒方式，只控制页面告知条与系统通知；是否生成待验收告知由项目自动化及具体 Worker 设置决定。系统通知还需设备总开关及当前浏览器权限。关闭提醒不删除记录、不改变未读计数；未知来源保持可见，待决事项独立显示，不能用「已知」消除。', 'settings-note'));
    for (const { id, label, note } of NOTICE_CATEGORIES) notices.append(row(label, note, noticeChannelControl(id, label)));
    content.append(notices);

    const reset = block('恢复界面默认');
    const resetButton = el('button', '恢复设备偏好默认', 'ghost pref-reset'); resetButton.type = 'button';
    resetButton.onclick = async () => {
      if (ui.view !== view || !ui.settingsOpen || resetButton.disabled) return;
      if (epoch !== preferenceEpoch) return;
      resetButton.dataset.preferencePending = 'true'; resetButton.disabled = true;
      preferenceFeedback('正在恢复设备偏好默认…', false, view);
      try {
        if (typeof actions.resetDevicePreferences !== 'function') throw new Error('界面尚不支持设备偏好重置，请更新 Host');
        await actions.resetDevicePreferences(); if (epoch === preferenceEpoch) preferenceFeedback('设备偏好已恢复默认；项目工作状态保留。', false, view);
      } catch (error) { if (epoch === preferenceEpoch) preferenceFeedback(`恢复失败：${error.message}；未修改项目工作状态。`, true, view); }
      finally {
        delete resetButton.dataset.preferencePending; resetButton.disabled = false;
        if (epoch === preferenceEpoch && ui.view === view && ui.settingsOpen) updatePreferenceStatus($('detail'), actions.devicePreferencesStatus?.());
      }
    };
    resetButton.setAttribute('data-help', '恢复设备级外观、阅读与提醒偏好；不清项目节点折叠、具体过滤、草稿或 Agent 配置。');
    reset.append(row('恢复界面默认', '只恢复设备偏好，不重置项目的折叠、过滤、输入草稿或 Agent 配置。', preferenceHost(resetButton, resetButton.getAttribute('data-help'))));
    content.append(reset); updatePreferenceStatus(content, status);
    return content;
  }

  for (const name of PREF_NAMES) onPrefChange(name, () => { if (globalThis.document === settingsDocument && ui.settingsOpen && isInterface()) renderSettings(); });

  return { open: openSettings, render: interfaceTab };
}
