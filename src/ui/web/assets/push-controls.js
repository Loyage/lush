import { button, el } from './dom.js';
import { confirmDialog } from './dialog.js';
import { onPrefChange, readPref } from './prefs.js';
import { checkBackgroundPush, enableBackgroundPush, disableBackgroundPush, testBackgroundPush, pushUnsupportedReason } from './push-subscriptions.js';

const descriptions = Object.freeze({
  unsupported: '此浏览器不支持后台推送；iPhone／iPad 16.4+ 请先添加到主屏幕，再从主屏幕打开。',
  denied: '此浏览器通知权限未获允许，请在系统／站点设置中允许后重新检查。',
  unsubscribed: '此浏览器尚未启用后台推送，页面打开期间的提醒仍按原设置工作。',
  unregistered: '浏览器有本地订阅，但 Host 未登记；请显式启用以恢复，状态检查不会自动登记。',
  'key-changed': 'Host 推送密钥已变化；请显式启用以替换旧订阅，不会自动重新订阅。',
  subscribed: '已核验此浏览器与 Host 的后台订阅；关闭页面后仍可提醒，实际送达由系统和网络决定。',
  unknown: '后台订阅状态未确认，请重新检查；未自动重试订阅或撤销。',
});

/** No background timers/listeners owned by the view; late reads never repaint a detached page. */
export function backgroundPushControl() {
  const owner = globalThis.document, root = el('div', undefined, 'push-notification-control');
  let current = { status: 'unknown', local: false, subscribed: false }, busy = false, message = '', failed = false, generation = 0;
  const controls = [];
  const live = () => globalThis.document === owner && root.isConnected !== false;
  const status = el('span', '', 'hint'); status.setAttribute('role', 'status');
  function paint() {
    if (!live()) return;
    const unsupported = pushUnsupportedReason();
    for (const { node, host, kind, help } of controls) {
      const blocked = busy || kind === 'enable' && Boolean(unsupported)
        || kind === 'disable' && !current.local || kind === 'test' && !current.subscribed;
      node.disabled = blocked;
      host.setAttribute('data-help', busy ? '正在处理当前浏览器的推送操作，请等待结果后重新检查。'
        : unsupported && kind === 'enable' ? unsupported
        : blocked ? '请先重新检查并确认此浏览器的后台订阅状态。' : help);
    }
    const global = readPref('noticeNotifications') ? '' : '系统通知总开关关闭：正常工作提醒暂不发送；本浏览器订阅与测试独立保留。';
    status.textContent = [global, busy ? '正在处理…' : message || unsupported || descriptions[current.status]].filter(Boolean).join(' ');
    status.setAttribute('role', failed ? 'alert' : 'status');
  }
  async function inspect() {
    const epoch = ++generation;
    const value = await checkBackgroundPush({ force: true });
    if (epoch !== generation || !live()) return;
    current = value; paint();
  }
  async function action(kind, work) {
    if (busy) return;
    busy = true; message = ''; failed = false; ++generation; paint();
    try {
      const result = await work();
      if (kind === 'test') message = '推送服务已接受测试请求，不代表手机已收到；请锁屏检查通知并点击核对。';
      else current = result;
    } catch (error) {
      failed = true;
      message = error.pushSafe ? error.message : '后台推送操作未确认，请重新检查；未自动重复提交。';
      current = await checkBackgroundPush({ force: true });
    } finally { busy = false; paint(); }
  }
  function control(label, kind, help, work) {
    const node = button(label, () => action(kind, work), 'ghost'); node.dataset.pushAction = kind;
    const host = el('span', undefined, 'help-host'); host.tabIndex = 0; host.setAttribute('data-help', help); host.append(node);
    // button() restores generic disabled state after an async handler, so repaint after that boundary.
    const click = node.onclick; node.onclick = async () => { await click(); paint(); };
    controls.push({ node, host, kind, help }); root.append(host);
  }
  control('启用此浏览器后台推送', 'enable', '只授权并登记当前浏览器，不修改其它客户端的系统通知总开关；失败或密钥变化不会静默重新订阅。', enableBackgroundPush);
  control('停用此浏览器后台推送', 'disable', '先确认 Host 撤销，再清理本浏览器订阅；不关闭设备总开关，不删除项目通知记录。', disableBackgroundPush);
  control('重新检查', 'check', '核对当前浏览器和 Host 的真实订阅，不自动创建或恢复订阅。', () => checkBackgroundPush({ force: true }));
  control('发送测试通知', 'test', '只向当前浏览器发送测试；服务商接受不代表手机已收到，不调用 Agent。', testBackgroundPush);
  control('重新加载界面', 'reload', '从服务器重新加载当前界面；请先保存或复制未提交的输入，不自动提交或执行任务。', async () => {
    const ok = await confirmDialog({ title: '重新加载界面？', message: '请先保存或复制未提交的输入。重新加载不会提交它们，也不会停止服务器上的工作。', confirmLabel: '重新加载' });
    if (ok && live()) globalThis.location?.reload?.();
    return current;
  });
  root.append(status); paint(); void inspect();
  // Repaint only currently displayed controls when the shared switch changes; no view subscriptions leak.
  root.repaintPushControl = paint;
  return root;
}

onPrefChange('noticeNotifications', () => {
  for (const root of globalThis.document?.querySelectorAll?.('.push-notification-control') || []) root.repaintPushControl?.();
});
