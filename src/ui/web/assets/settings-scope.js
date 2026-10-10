import { el } from './dom.js';

export const scopeLabel = () => '设备设置';
export const scopeImpact = () => '保存在运行 Lush 的机器上，供同一系统用户的所有项目使用；项目不再单独覆盖。只影响后续调用，不打断在途调用，Worker 显式运行参数保留。';

/** Capture the owning pane's editable values before an asynchronous save. */
export function draftFingerprint(node) {
  let root = node;
  for (let parent = node; parent; parent = parent.parentNode) {
    if (parent.classList?.contains('agent-settings') || parent.classList?.contains('settings-scope-pane')) { root = parent; break; }
  }
  return JSON.stringify(['input', 'select', 'textarea'].flatMap(tag => [...root.querySelectorAll(tag)]
    .map(control => [control.value || '', Boolean(control.checked)])));
}

export function scopeSummary(model) {
  const metadata = model?.configuration_scope;
  const source = metadata?.selected === 'device' && ['device', 'default', 'mixed'].includes(metadata.source);
  const labels = { device: '设备设置', default: '环境 / 内置默认', mixed: '设备设置与环境 / 内置默认' };
  return el('p', source ? `当前读取：${labels[metadata.source]}。所有项目使用同一份设备配置。`
    : '设备配置来源未确认；请更新 Host 并重新读取，不使用旧项目覆盖。', 'hint settings-scope-summary');
}
