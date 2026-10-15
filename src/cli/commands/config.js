import { check } from '../../core/types.js';
import { RUNTIME_SETTINGS_LIMITS } from '../../core/settings.js';
import { exact, option } from '../args.js';
import { takeConfigurationScope, scopedSettingsClient } from '../settings-scope.js';

/**
 * `lush config`：设备「运行设置」（三条调用 / 拆解限额）的用户接口。
 *
 * 读模型来自 `system.status.settings`（核心在写盘后同步的内存镜像），写走 `system.configure`。
 * 二者都是用户专属：agent 调用直接被拒，避免某次 Worker 调用顺手改掉设备设置。
 *
 * 命令面用连字符；RPC / 设置文件里是下划线（call_timeout / task_call_limit / max_depth / input_routes）。
 * 范围与核心共用 `RUNTIME_SETTINGS_LIMITS`，避免两份数字漂移。
 */
const FIELDS = [
  { flag: 'call-timeout', key: 'call_timeout', label: '单次调用超时（秒）' },
  { flag: 'worker-call-limit', key: 'task_call_limit', label: '单 Worker 调用上限' },
  { flag: 'max-depth', key: 'max_depth', label: '最大拆解深度' },
];
const byFlag = new Map(FIELDS.map(field => [field.flag, field]));
const FLAGS = FIELDS.map(field => field.flag);

/** 命令行参数转整数：先挡住 NaN / 非整数，范围交给核心（保持一致报错与不落盘）。 */
function integer(flag, raw) {
  const field = byFlag.get(flag);
  const { max } = RUNTIME_SETTINGS_LIMITS[field.key];
  const text = String(raw);
  const value = Number(text);
  check(/^\d+$/.test(text) && Number.isInteger(value) && value >= 1 && value <= max,
    `config set ${flag} must be an integer from 1 to ${max}`);
  return value;
}

/** 人类可读：每一条前缀 → 目标，以及整表来自覆盖还是默认。 */
function printRoutes(entry) {
  console.log(`快速路由 input_routes\t生效 ${entry.value.length} 条 · 环境默认 ${entry.default.length} 条 · ${entry.overridden ? '已覆盖' : '环境默认'}`);
  for (const route of entry.value) console.log(`  ${route.prefix} → ${route.target}`);
}

/** 人类可读：生效值 / 环境默认值 / 来源 / 前缀表 / 设置文件，一眼看清。 */
function printConfig(settings) {
  for (const field of FIELDS) {
    const entry = settings[field.key];
    const source = { device: '设备共享', project: '项目覆盖', default: '环境默认' }[entry.source]
      || (entry.overridden ? '已覆盖' : '环境默认');
    console.log(`${field.label} ${field.flag}\t生效 ${entry.value} · 环境默认 ${entry.default} · ${source}`);
  }
  printRoutes(settings.input_routes);
  console.log(`设置文件\t${settings.file || '—'}`);
  if (settings.configuration_scope) console.log(`编辑作用域\t${settings.configuration_scope.selected === 'device' ? '设备共享' : '本项目覆盖'}`);
}

/** 统一出口：--json 返回结构化读模型，否则打印后返回 undefined（主流程不再 print）。 */
function report(settings, json) {
  check(settings?.input_routes && FIELDS.every(field => settings?.[field.key]),
    'daemon did not return runtime settings; restart this project daemon');
  if (!json) { printConfig(settings); return; }
  return settings;
}

export async function run(command, args, { client, json }) {
  check(!client.token, 'agents cannot change runtime settings');
  const scope = takeConfigurationScope(args);
  client = scopedSettingsClient(client, scope);
  const verb = args.shift() || 'show';
  check(['show','set','reset','migrate-preview','migrate'].includes(verb), 'unknown config command; use show, set, reset, migrate-preview or migrate');
  if (verb === 'migrate' || verb === 'migrate-preview') {
    check(scope !== 'device', 'migration reads the current project; omit --scope');
    const index = args.indexOf('--confirm'), confirm = index !== -1;
    if (confirm) args.splice(index, 1);
    const revision = option(args, '--revision'); exact(args, 0);
    check(verb === 'migrate' ? confirm && typeof revision === 'string' && revision.length > 0 : !confirm && revision === null,
      'first run config migrate-preview; config migrate requires --confirm --revision REV');
    const result = await client.request(verb === 'migrate' ? 'settings.migration.apply' : 'settings.migration.preview',
      confirm ? { revision, confirm: true } : undefined);
    if (json) return result;
    console.log(result.already_migrated ? '项目设置已迁移；无需重复导入。' : confirm ? '迁移执行结果：' : '当前项目 → 设备共享设置迁移预检：');
    for (const item of result.items ?? []) console.log(`${item.kind}\t${item.action}\t${item.source} → ${item.destination}`);
    for (const blocker of result.blockers ?? []) console.log(`阻止：${blocker}`);
    for (const warning of result.warnings ?? []) console.log(`提示：${warning}`);
    if (result.backup) console.log(`私有备份：${result.backup}`);
    if (!confirm && result.can_migrate && !result.already_migrated) console.log(`确认执行：lush config migrate --confirm --revision ${result.revision}`);
    return;
  }
  if (verb === 'show') {
    exact(args, 0);
    const settings = scope === null ? (await client.request('system.status')).settings : await client.request('system.settings');
    return report(settings, json);
  }
  if (verb === 'set') {
    const flag = args.shift();
    check(byFlag.has(flag), `config set expects ${FLAGS.join(' or ')}`);
    exact(args, 1);
    const settings = { [byFlag.get(flag).key]: integer(flag, args[0]) };
    return report(await client.request('system.configure', { settings }), json);
  }
  if (verb === 'reset') {
    const target = args.shift() || 'all';
    exact(args, 0);
    const settings = {};
    if (target === 'all') for (const field of FIELDS) settings[field.key] = null;
    else {
      check(byFlag.has(target), `config reset expects ${FLAGS.join(', ')}, or all`);
      settings[byFlag.get(target).key] = null;
    }
    return report(await client.request('system.configure', { settings }), json);
  }
}
