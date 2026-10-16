import { el } from './dom.js';
import { runnerDetails } from './runner-settings-controls.js';

export const previewText = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '未提供';
export const canonicalPreview = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
export const runnerActionId = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
const packageVersion = value => typeof value === 'string' && /^[0-9][A-Za-z0-9.+:~_-]*$/.test(value);
export const sameRunnerActions = (actual, expected) => Array.isArray(actual) && actual.every(runnerActionId) && new Set(actual).size === actual.length
  && actual.length === expected.length && actual.every(id => expected.includes(id));

// UI completeness only, never proof of unit safety, hash contents, permissions or package resolution.
export function runnerPlanIssues(plan, { recovery = false } = {}) {
  const issues = [], ids = new Set(), units = new Set();
  if (!Array.isArray(plan.actions) || !plan.actions.length) return ['动作集合缺失；不能确认完整部署范围。'];
  if (plan.actions_truncated === true) issues.push('动作集合已截断；不能授权不完整计划。');
  for (const item of plan.actions) {
    if (!item || !runnerActionId(item.id) || !nonempty(item.label) || typeof item.privileged !== 'boolean') {
      issues.push('动作 ID、名称或权限类型缺失／无效；不能提交未知动作。'); continue;
    }
    if (ids.has(item.id)) issues.push('动作 ID 重复；不能确认唯一授权集合。');
    ids.add(item.id);
    if (recovery && ((item.privileged && item.id !== 'start_original_unit') || item.id === 'git_install')) issues.push('恢复只允许逐项启动原安装 unit，不允许新增系统安装动作。');
    if (recovery && item.id === 'start_original_unit' && !item.privileged) issues.push('启动原安装 unit 必须逐项授予特权。');
    if (item.id === 'git_install' && !item.privileged) issues.push('Git 系统安装必须逐项授予特权；权限类型无效。');
    if (!item.privileged) continue;
    if (!nonempty(item.unit_path) || !/^\/(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\.service$/.test(item.unit_path)
      || item.unit_path.split('/').some(part => part === '.' || part === '..')) issues.push('特权动作缺少有效的 unit 路径。');
    if (units.has(item.unit_path)) issues.push('同一 unit 路径重复；不能确认系统动作归属。');
    units.add(item.unit_path);
    if (typeof item.unit_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.unit_sha256)) issues.push('特权动作 unit SHA256 摘要缺失或无效。');
    if (!nonempty(item.unit_summary) || !nonempty(item.effect)) issues.push('特权动作缺少 unit 摘要说明或启动后果。');
    if (item.id !== 'git_install') continue;
    if (item.packages_truncated !== false) issues.push('Git 包表截断或完整性未确认；不能授权不完整依赖。');
    if (!Array.isArray(item.packages) || !item.packages.length) { issues.push('Git 完整依赖包表缺失。'); continue; }
    const packages = new Set();
    for (const pkg of item.packages) {
      if (!pkg || typeof pkg.name !== 'string' || !/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9_-]+)?$/.test(pkg.name)
        || !packageVersion(pkg.version) || pkg.operation !== 'install') { issues.push('Git 依赖包名、确切版本或安装操作缺失／无效。'); continue; }
      if (packages.has(pkg.name)) issues.push('Git 包表有重复依赖，完整范围未确认。');
      packages.add(pkg.name);
      if (pkg.previous_version !== undefined && pkg.previous_version !== null) {
        if (!packageVersion(pkg.previous_version)) issues.push('Git 既有包版本信息无效，不能确认变更范围。');
        else if (pkg.previous_version !== pkg.version) issues.push('Git 依赖涉及既有包升级／版本变更；首版不允许。');
      }
    }
    if (![...packages].some(name => name === 'git' || name.startsWith('git:'))) issues.push('Git 包表未包含 Git 本身，依赖范围不完整。');
  }
  return [...new Set(issues)];
}

/** Whitelisted text nodes only. Callers own revision/lifetime guards and disabled help-host state. */
export function renderRunnerActions(plan, { prefix, confirmLabel, onToggle }) {
  const text = previewText, actions = el('fieldset'); actions.append(el('legend', '系统动作（sudo 必须逐项确认）'));
  actions.append(el('p', `点击“${confirmLabel}”才总确认冻结计划的全部动作；以下 sudo 系统动作还须逐项勾选，默认均未授权。`, 'hint'));
  for (const item of Array.isArray(plan.actions) ? plan.actions : []) {
    const action = el('div', undefined, `${prefix}-action`); actions.append(action);
    if (!item || typeof item.privileged !== 'boolean' || !runnerActionId(item.id)) { action.append(el('p', '未知或缺失的动作 ID／权限；不能提交。', 'error')); continue; }
    if (!item.privileged) { action.append(el('p', `${text(item.label)} · 无 sudo；由总确认覆盖`)); continue; }
    const label = el('label', undefined, `${prefix}-approval`), host = el('span', undefined, 'help-host'), input = el('input');
    input.type = 'checkbox'; input.checked = false; input.dataset[prefix === 'runner-deploy' ? 'deployAction' : 'recoveryAction'] = item.id;
    input.setAttribute('aria-label', `允许系统动作：${text(item.label)}`); host.append(input); label.append(host, el('span', text(item.label))); action.append(label);
    action.append(el('p', `unit 路径：${text(item.unit_path)}`), el('p', `启动后果：${text(item.effect)}`));
    if (item.id === 'git_install') {
      action.append(el('p', 'Git 完整依赖包与确切版本（包含间接依赖）'));
      for (const pkg of Array.isArray(item.packages) ? item.packages : []) action.append(el('p', `包 ${text(pkg?.name)} · 版本 ${text(pkg?.version)} · 操作 ${text(pkg?.operation)}${pkg?.previous_version != null ? ` · 既有版本 ${text(pkg.previous_version)}` : ''}`));
      if (item.packages_truncated !== false) action.append(el('p', '包表截断或完整性未知；禁止提交。', 'error'));
    }
    const detail = runnerDetails('本项 unit 摘要与说明');
    detail.append(el('p', `unit SHA256：${text(item.unit_sha256)}`), el('p', `unit 摘要说明：${text(item.unit_summary)}`)); action.append(detail);
    input.onchange = () => onToggle(item, input);
  }
  return actions;
}
