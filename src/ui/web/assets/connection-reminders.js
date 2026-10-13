import { readPref, readStored, scopedKey, writeStored } from './prefs.js';
import { array, text, successful } from './connection-view-common.js';
import { resetRemaining } from './connection-resources.js';

/** Page-local reminders never query providers or change observations. */
export function createConnectionReminders({ node, current, getData, now, resetSetTimeout, resetClearTimeout }) {
  let stopped = false, resetTimer = null;
  // 额度刷新提醒是页面内的本地定时能力：只读缓存观测的 reset_at，不新增 daemon 调度，也不伪造新观测。
  const reminderNotified = new Set();
  let reminderSeeded = false;
  function reminderEntries() {
    const entries = [];
    for (const connection of array(getData()?.connections)) {
      if (connection.notify_reset !== true) continue;
      const observation = successful(connection.observation) ? connection.observation
        : successful(connection.last_success?.observation) ? connection.last_success.observation : null;
      if (!observation) continue;
      for (const resource of array(observation.resources)) {
        const resetAt = Date.parse(resource.reset_at);
        if (!Number.isFinite(resetAt)) continue;
        entries.push({ connection, resource, resetAt });
      }
    }
    return entries;
  }
  const reminderKey = entry => `${scopedKey('lush.quotaReminder')}:${entry.connection.id}:${entry.resource.id}:${entry.resetAt}`;
  function sendReminder({ connection, resource, resetAt }) {
    // 浏览器系统通知沿用既有总开关；关闭时只保留页面内标记，不主动申请授权。
    if (!readPref('noticeNotifications') || !globalThis.Notification || globalThis.isSecureContext === false
      || globalThis.Notification.permission !== 'granted') return;
    try {
      const notification = new globalThis.Notification(`Lush · 额度刷新：${text(connection.label, '模型来源')}`, {
        body: `${text(resource.label, '额度')} 已到重置时间；这不代表额度已恢复，请刷新查看最新数值。`,
        tag: reminderKey({ connection, resource, resetAt }) });
      notification.onclick = () => {
        globalThis.window?.focus?.();
        const hash = `#model-source-${connection.id}`;
        if (location.hash !== hash) location.hash = hash;
        notification.close?.();
      };
    } catch { /* 发送失败不回退成伪观测，也不阻塞其他提醒 */ }
  }
  /** seed：首次载入只标记已到期项，不补发页面关闭期间积压的提醒。 */
  function evaluateReminders(seed = false) {
    if (stopped || !current()) return;
    const currentTime = now();
    for (const entry of reminderEntries()) {
      if (currentTime < entry.resetAt) continue;
      const key = reminderKey(entry);
      if (reminderNotified.has(key)) continue;
      reminderNotified.add(key);
      if (seed) { writeStored(key, '1'); continue; }
      if (readStored(key) === '1') continue;
      writeStored(key, '1');
      sendReminder(entry);
    }
  }
  function updateResets() {
    resetClearTimeout(resetTimer); resetTimer = null;
    if (stopped || !current() || document.hidden) return;
    const currentTime = now();
    const resets = node.querySelectorAll('.agent-reset-remaining');
    for (const reset of resets) {
      const due = Date.parse(reset.dataset.resetAt) <= currentTime;
      reset.classList.toggle('is-due', due);
      reset.textContent = resetRemaining(reset.dataset.resetAt, currentTime) + (due && reset.dataset.reminder === '1' ? '（刷新提醒已开启）' : '');
    }
    if (reminderSeeded) evaluateReminders(false);
    const summaryResets = node.querySelectorAll('.model-source-reset-time');
    for (const reset of summaryResets) {
      reset.classList.toggle('is-due', Date.parse(reset.dataset.resetAt) <= currentTime);
      reset.textContent = resetRemaining(reset.dataset.resetAt, currentTime);
    }
    if ([...resets, ...summaryResets].some(reset => Date.parse(reset.dataset.resetAt) > currentTime)) {
      resetTimer = resetSetTimeout(updateResets, 60000); resetTimer?.unref?.();
    }
  }
  const visibilityChanged = () => updateResets();
  document.addEventListener?.('visibilitychange', visibilityChanged);
  return { update: updateResets,
    seed() { if (!reminderSeeded) { evaluateReminders(true); reminderSeeded = true; } },
    dispose() { stopped = true; resetClearTimeout(resetTimer); resetTimer = null; document.removeEventListener?.('visibilitychange', visibilityChanged); },
    resume() { stopped = false; document.addEventListener?.('visibilitychange', visibilityChanged); } };
}
