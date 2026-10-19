import { check } from '../../core/types.js';
import { RUNTIME_SETTINGS_LIMITS } from '../../core/settings.js';
import { exact, option } from '../args.js';
import { takeConfigurationScope, scopedSettingsClient } from '../settings-scope.js';
import { takeJsonInput } from '../private-json.js';
import { runAgentConfiguration, runNetworkConfiguration } from './agent.js';

// Configuration grouping changes the CLI only. Scope, revisions and authorization
// still belong to the original narrow RPCs; reads never fall back to system.status.
const FIELDS = [
  { flag: 'call-timeout', key: 'call_timeout', label: '单次调用超时（秒）' },
  { flag: 'worker-call-limit', key: 'task_call_limit', label: '单 Worker 调用上限' },
  { flag: 'max-depth', key: 'max_depth', label: '最大拆解深度' },
];
const byFlag = new Map(FIELDS.map(field => [field.flag, field]));
const FLAGS = FIELDS.map(field => field.flag);

function integer(flag, raw) {
  const field = byFlag.get(flag);
  const { max } = RUNTIME_SETTINGS_LIMITS[field.key];
  const text = String(raw), value = Number(text);
  check(/^[1-9]\d*$/.test(text) && Number.isSafeInteger(value) && value <= max,
    `config runtime set ${flag} must be an integer from 1 to ${max}`);
  return value;
}

function printConfig(settings) {
  for (const field of FIELDS) {
    const entry = settings[field.key];
    const source = { device: '设备共享', project: '项目覆盖', default: '环境默认' }[entry.source]
      || (entry.overridden ? '已覆盖' : '环境默认');
    console.log(`${field.label} ${field.flag}\t生效 ${entry.value} · 环境默认 ${entry.default} · ${source}`);
  }
  const entry = settings.input_routes;
  console.log(`历史路由 input_routes\t生效 ${entry.value.length} 条 · 环境默认 ${entry.default.length} 条 · ${entry.overridden ? '已覆盖' : '环境默认'}（只读）`);
  for (const route of entry.value) console.log(`  ${route.prefix} → ${route.target}`);
  console.log(`设置文件\t${settings.file || '—'}`);
  if (settings.configuration_scope) console.log(`编辑作用域\t${settings.configuration_scope.selected === 'device' ? '设备共享' : '本项目覆盖'}`);
}

function report(settings, json) {
  if (settings?.receipt_id) return settings;
  check(settings?.input_routes && FIELDS.every(field => settings?.[field.key]),
    'daemon did not return runtime settings; inspect code identity before updating this project daemon');
  if (!json) { printConfig(settings); return; }
  return settings;
}

function revision(args) {
  const value = option(args, '--revision');
  check(typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value), 'first read the corresponding show command, then provide --revision REV');
  return value;
}

export async function run(command, args, ctx) {
  let { client, json } = ctx;
  check(!client.token || client.management, 'device configuration requires user or trusted management identity');
  const scope = takeConfigurationScope(args);
  check(!args.includes('--scope'), 'duplicate CLI option --scope');
  client = scopedSettingsClient(client, scope);
  const group = args.shift();
  if (group === 'agent') return runAgentConfiguration(args, { ...ctx, client });
  if (group === 'network') return runNetworkConfiguration(args, { ...ctx, client });
  if (group === 'auto-answer') return autoAnswer(args, client, scope);
  if (group === 'valet-permission') return valetPermission(args, client, scope);
  if (group === 'migration') return migration(args, client, json, scope);
  check(group === 'runtime', 'config requires runtime, agent, network, auto-answer, valet-permission or migration');
  const verb = args.shift();
  if (verb === 'show') {
    exact(args, 0);
    return report(await client.request('system.settings'), json);
  }
  if (verb === 'set') {
    let settings;
    if (args.includes('--data') || args.includes('--file')) {
      settings = takeJsonInput(args, client, 'runtime settings');
      exact(args, 0); // Reject mixed KEY VALUE and structured-input modes before RPC.
    } else {
      const flag = args.shift();
      check(byFlag.has(flag), `config runtime set expects ${FLAGS.join(' or ')} or --data JSON`);
      exact(args, 1);
      settings = { [byFlag.get(flag).key]: integer(flag, args[0]) };
    }
    return report(await client.request('system.configure', { settings }), json);
  }
  if (verb === 'reset') {
    const target = args.shift() || 'all'; exact(args, 0);
    const settings = {};
    if (target === 'all') for (const field of FIELDS) settings[field.key] = null;
    else {
      check(byFlag.has(target), `config runtime reset expects ${FLAGS.join(', ')}, or all`);
      settings[byFlag.get(target).key] = null;
    }
    return report(await client.request('system.configure', { settings }), json);
  }
  check(false, 'config runtime requires show, set or reset');
}

async function autoAnswer(args, client, scope) {
  const verb = args.shift();
  if (verb === 'show') {
    exact(args, 0);
    const value = await client.request('hooks.list');
    check(value?.daemon_hooks && typeof value.daemon_hooks.revision === 'string', 'automatic-answer policy is unavailable');
    return value.daemon_hooks; // Keep availability/error/revision, not just a guessed boolean.
  }
  check(verb === 'set', 'config auto-answer requires show or set');
  const expected_revision = revision(args); exact(args, 1);
  check(['on', 'off'].includes(args[0]), 'config auto-answer set expects on|off');
  return client.request('hooks.auto_select', { enabled: args[0] === 'on', expected_revision,
    ...(client.management && scope !== null ? { scope } : {}) });
}

async function valetPermission(args, client, scope) {
  check(scope === 'device', 'Valet permissions require --scope device');
  const verb = args.shift();
  check(['show', 'set'].includes(verb), 'config valet-permission requires show or set');
  const expected_revision = verb === 'set' ? revision(args) : undefined;
  exact(args, verb === 'set' ? 2 : 1);
  return client.request(verb === 'set' ? 'management.permission_set' : 'management.permission_get', {
    method: args[0], scope, ...(verb === 'set' ? { access: args[1], expected_revision } : {}),
  });
}

async function migration(args, client, json, scope) {
  check(scope === null, 'migration reads the current project; omit --scope');
  const verb = args.shift();
  check(['preview', 'apply'].includes(verb), 'config migration requires preview or apply');
  const index = args.indexOf('--confirm'), confirm = index !== -1;
  if (confirm) args.splice(index, 1);
  const expected = option(args, '--revision'); exact(args, 0);
  check(verb === 'apply' ? confirm && typeof expected === 'string' && expected.length > 0 : !confirm && expected === null,
    'first run config migration preview; apply requires --confirm --revision REV');
  const result = await client.request(verb === 'apply' ? 'settings.migration.apply' : 'settings.migration.preview',
    confirm ? { revision: expected, confirm: true } : undefined);
  if (json) return result;
  console.log(result.already_migrated ? '项目设置已迁移；无需重复导入。' : confirm ? '迁移执行结果：' : '当前项目 → 设备共享设置迁移预检：');
  for (const item of result.items ?? []) console.log(`${item.kind}\t${item.action}\t${item.source} → ${item.destination}`);
  for (const blocker of result.blockers ?? []) console.log(`阻止：${blocker}`);
  for (const warning of result.warnings ?? []) console.log(`提示：${warning}`);
  if (result.backup) console.log(`私有备份：${result.backup}`);
  if (!confirm && result.can_migrate && !result.already_migrated)
    console.log(`确认执行：lush config migration apply --confirm --revision ${result.revision}`);
}
