import { check } from '../../core/types.js';
import { RUNTIME_SETTINGS_LIMITS } from '../../core/settings.js';
import { ROUTE_TARGETS, normalizeInputRoutes } from '../../core/input-routes.js';
import { exact, option } from '../args.js';

/**
 * `lush config`：项目级「运行设置」（目前是两条并发上限）的用户接口。
 *
 * 读模型来自 `system.status.settings`（核心在写盘后同步的内存镜像），写走 `system.configure`。
 * 二者都是用户专属：agent 调用直接被拒，避免某次任务调用顺手改掉整个项目的并发。
 *
 * 命令面用连字符（`control-concurrency`）与 help 一致；RPC / 设置文件里是下划线
 * （`control_concurrency` / `input_routes`）。范围与核心共用 `RUNTIME_SETTINGS_LIMITS`，避免两份数字漂移。
 *
 * `config route` 在同一份运行设置上管理快速路由前缀表：读当前生效表后整表写回，校验直接复用
 * `core/input-routes.js` 的 `normalizeInputRoutes`，因此与核心对前缀 / 目标的报错完全一致。
 */
const FIELDS = [
  { flag: 'concurrency', key: 'concurrency', label: '执行通道' },
  { flag: 'control-concurrency', key: 'control_concurrency', label: '控制通道' },
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
    console.log(`${field.label} ${field.flag}\t生效 ${entry.value} · 环境默认 ${entry.default} · ${entry.overridden ? '已覆盖' : '环境默认'}`);
  }
  printRoutes(settings.input_routes);
  console.log(`设置文件\t${settings.file || '—'}`);
}

/** 快速路由读模型：生效表、默认表与来源。`route` 子命令的 --json 输出。 */
function routeModel(settings) {
  const entry = settings?.input_routes;
  check(entry && Array.isArray(entry.value) && Array.isArray(entry.default),
    'daemon did not return runtime settings; restart this project daemon');
  return { file: settings.file, overridden: entry.overridden, default: entry.default, routes: entry.value };
}

/** route 子命令统一出口：--json 给读模型，否则打印生效表后返回 undefined。 */
function reportRoutes(settings, json) {
  const model = routeModel(settings);
  if (json) return model;
  printRoutes(settings.input_routes);
  return undefined;
}

/** 统一出口：--json 返回结构化读模型，否则打印后返回 undefined（主流程不再 print）。 */
function report(settings, json) {
  check(settings?.concurrency && settings?.control_concurrency && settings?.input_routes,
    'daemon did not return runtime settings; restart this project daemon');
  if (!json) { printConfig(settings); return; }
  return settings;
}

export async function run(command, args, { client, json }) {
  check(!client.token, 'agents cannot change runtime settings');
  const verb = args.shift() || 'show';
  if (verb === 'show') {
    exact(args, 0);
    const status = await client.request('system.status');
    return report(status.settings, json);
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
  if (verb === 'route') {
    const action = args.shift() || 'list';
    if (action === 'list') {
      exact(args, 0);
      return reportRoutes((await client.request('system.status')).settings, json);
    }
    if (action === 'add') {
      const prefix = args.shift();
      check(typeof prefix === 'string' && prefix.length > 0, 'config route add expects a prefix');
      const target = option(args, '--target', ROUTE_TARGETS[0]);
      exact(args, 0);
      const status = await client.request('system.status');
      const routes = normalizeInputRoutes([...routeModel(status.settings).routes, { prefix, target }]);
      const settings = await client.request('system.configure', { settings: { input_routes: routes } });
      return reportRoutes(settings, json);
    }
    if (action === 'remove') {
      const prefix = args.shift();
      check(typeof prefix === 'string' && prefix.length > 0, 'config route remove expects a prefix');
      exact(args, 0);
      const status = await client.request('system.status');
      const routes = routeModel(status.settings).routes;
      const folded = prefix.toLowerCase();
      const index = routes.findIndex(route => route.prefix.toLowerCase() === folded);
      check(index !== -1, `config route remove: prefix ${prefix} is not configured`);
      const settings = await client.request('system.configure',
        { settings: { input_routes: routes.filter((_, i) => i !== index) } });
      return reportRoutes(settings, json);
    }
    if (action === 'reset') {
      exact(args, 0);
      const settings = await client.request('system.configure', { settings: { input_routes: null } });
      return reportRoutes(settings, json);
    }
    check(false, 'config route expects list, add, remove or reset');
  }
  check(false, 'config expects show, set, reset or route');
}
