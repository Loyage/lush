import { check, id, isPlainObject } from '../../core/types.js';
import { diagnosticsSearch } from '../../core/diagnostics-query.js';
import { DEVICE_SETTINGS_READS } from '../../host/device-settings.js';
import { restartProjectDaemon } from '../../host/service-control.js';
import { workerNumber } from '../../core/worker-number.js';
import { graphOptions } from '../../core/project/graph-pages.js';
import { emptyJson, settingQuery } from './server-query.js';
import { PARAMS, assertAllowed } from '../../rpc/registry.js';
import { workerRead } from './server-worker-routes.js';
import { contentRead } from './server-content-routes.js';
import { projectElevationRoute } from './server-project-elevation.js';

const MUTATIONS = new Set(['worker.cli_preview','worker.cli_execute','worker.cli_history','worker.cli_history_clear','settings.clear_override','settings.migration.apply','agent.network.configure','agent.configure','agent.environment.configure','agent.usage.configure','agent.registered_models.save','agent.registered_models.remove','agent.registered_models.resolve','agent.connections.save','agent.connections.remove','agent.connections.sampling','agent.connections.query','agent.connections.models.refresh','agent.connections.login.start','agent.connections.login.finish','agent.connections.device.start','agent.connections.device.cancel','agent.connections.device.poll','agent.packages.install','agent.packages.remove','agent.packages.update','system.configure','system.interrupt_all','system.resume_all','hooks.install','hooks.register','hooks.temporary_create','hooks.temporary_reclaim','hooks.upgrade','hooks.save','hooks.remove','hooks.command_save','hooks.command_remove','hooks.command_history_remove','hooks.command_import','hooks.auto_select','hooks.completion_defaults','hooks.automation_settings','worker.acceptance_notice','hooks.signal_save','hooks.signal_remove','management.permissions_update','management.create','management.submit','management.binding_update','management.emergency_stop','worker.completion','worker.hook_attach','worker.hook_update','worker.hook_remove','order.submit','input.emit','input.emission_cancel','input.exclusive_release','draft.add','draft.update','draft.remove','worker.create','worker.spawn','worker.message','worker.rename','worker.auto_merge','worker.reserve','worker.reserve_all','worker.resolve','worker.accept','worker.accept_preview','worker.accept_force','worker.reopen','worker.sync_parent','worker.resolve_sync','worker.resolve_divergence','worker.unreserve','worker.approve_merge','worker.cancel','worker.retry','worker.clear_override','worker.interrupt','worker.resume','worker.configure','worker.cleanup','worker.delete','notice.answer','notice.dismiss','notice.read','branch.archive','branch.integrate_start','branch.integrate_cancel','branch.integrate_retry','branch.convergence_set','branch.convergence_defaults_set','branch.convergence_retry']);
const CORE_INPUT_READ = /^\/api\/input\/(draft|input|message|management)\/([1-9]\d*)$/;
const CORE_READS = new Set(['/api/diagnostics/query','/api/branch-integrate-plan','/api/branch-integration','/api/cli/catalog','/api/management/permissions','/api/management/receipt','/api/management/emergency-preview','/api/automation/completion/workers','/api/branch-convergence','/api/branch-convergence/defaults','/api/branch-convergence/runs','/api/settings/runtime','/api/settings/migration','/api/hooks','/api/hooks/temporary/history','/api/hooks/commands/executions','/api/hooks/commands/export','/api/inputs','/api/input-parents','/api/overview','/api/snapshot','/api/workers','/api/worker-lookup','/api/notices','/api/worker-graph','/api/worker-delivery-graph','/api/versions','/api/version-graph','/api/agent/config','/api/agent/models','/api/agent/resources','/api/agent/status','/api/agent/usage/config','/api/agent/usage/history','/api/agent/registered-models','/api/agent/connections','/api/agent/connections/history','/api/agent/connections/models','/api/agent/packages','/api/agent/selection/resources','/api/agent/environment','/api/agent/network','/api/docs','/api/docs/search-index']);
const CORE_WORKER_READ = /^\/api\/worker\/\d+(?:\/(?:hooks|management-calls|relations|version-graph|version-deliveries|version-commit|version-lineage|version-lineage-commit|history|history-page|reading-page|reading-record|progress-history|runs-page|run-settings|delete-preview|diff|code-state|code-tree|code-file|usage|report|transcript|transcript-page|transcript-latest|transcript-step|transcript-search))?$/;
// 问卷选项的静态 HTML 预览：独立子文档，和报告一样有更严的 CSP，不能被上面的 Worker 读白名单漏掉。
const CORE_NOTICE_PREVIEW = /^\/api\/worker\/\d+\/notice\/\d+\/preview\/\d+\/\d+$/;
const CORE_DOC_READ = /^\/api\/docs\/[a-z0-9._-]+$/;
const PROJECT_SETTINGS_READS = new Map([...DEVICE_SETTINGS_READS].map(([suffix, spec]) =>
  [suffix === 'runtime' ? '/api/settings/runtime' : `/api/${suffix}`, spec]));

/** Resolve fixed project identity before forwarding; attachment never starts a daemon. */
export async function projectRoutes(context, projectHost, staticAssets) {
  const { request, url, headers, json } = context;
  // ---- 项目路由：/p/<id>/** 显式携带项目身份；无前缀项目读写只在单项目模式保留 ----
  const prefix = /^\/p\/([a-z0-9]{16})(\/.*)?$/.exec(url.pathname);
  const inner = prefix ? (prefix[2] || '/') : url.pathname;
  if (prefix && inner === '/' && !projectHost.hasRoute(prefix[1])) {
    // 未知 / 已移除的身份绝不回退到「当前项目」：全局模式回项目列表，单项目模式 404。
    if (projectHost.launcher) return new Response(null, { status: 303, headers: { Location: '/', ...headers } });
    return json({ error: `未知或已失效的项目身份：${prefix[1]}` }, 404);
  }
  if (prefix) url.pathname = inner;
  const projectApi = inner.startsWith('/api/') && !inner.startsWith('/api/docs') && !inner.startsWith('/api/host');
  if (projectHost.launcher && !prefix && projectApi) {
    // 旧页面发出的无项目身份请求：拒绝并提示刷新，绝不用另一标签页选中的项目代答。
    return json({ error: '缺少项目身份：全局 Web 的项目读写必须经 /p/<project>/ 路由；请刷新页面或从项目列表重新打开' }, 400);
  }
  const binding = projectApi ? (prefix ? await projectHost.openRoute(prefix[1]) : await projectHost.require()) : null;
  const client = binding?.client;
  const elevated = await projectElevationRoute(context, binding);
  if (elevated) return elevated;
  if (request.method === 'POST' && url.pathname === '/api/service/restart') {
    await emptyJson(request);
    return json(await restartProjectDaemon(binding.config));
  }
  if (request.method === 'GET') {
    if (url.pathname === '/api/diagnostics/query') return json(await client.request('system.diagnostics.query',
      diagnosticsSearch(url.searchParams), { signal: request.signal }));
    if (url.pathname === '/api/settings/migration') {
      check(!url.search, 'settings migration preview accepts no query parameters');
      return json(await client.request('settings.migration.preview'));
    }
    const settingsRead = PROJECT_SETTINGS_READS.get(url.pathname);
    if (settingsRead && (url.pathname === '/api/settings/runtime' || url.searchParams.has('scope'))) {
      return json(await client.request(settingsRead[0], settingQuery(url, settingsRead[1])));
    }
    if (url.pathname.startsWith('/api/') && !CORE_READS.has(url.pathname) && !CORE_WORKER_READ.test(url.pathname) && !CORE_INPUT_READ.test(url.pathname) && !CORE_NOTICE_PREVIEW.test(url.pathname) && !CORE_DOC_READ.test(url.pathname))
      return json({ error: 'not found' }, 404);
    if (url.pathname === '/api/sleep') return json(await client.request('sleep.status'));
    if (url.pathname === '/api/sleep/choices') return json(await client.request('sleep.choices', {
      before: url.searchParams.has('before') ? id(url.searchParams.get('before')) : null,
      limit: Number(url.searchParams.get('limit') ?? 30),
    }));
    if (url.pathname === '/api/usage') return json(await client.request('system.usage', {
      start: url.searchParams.get('start'), end: url.searchParams.get('end'), interval: url.searchParams.get('interval') ?? 'auto',
    }));
    if (url.pathname === '/api/snapshot') return json(await client.snapshot());
    if (url.pathname === '/api/overview') return json(await client.overview(url.searchParams.get('revision')));
    if (url.pathname === '/api/notices') {
      const page = await client.request('notice.page', {
        status: url.searchParams.get('status') ?? 'all',
        before: url.searchParams.get('before'),
        limit: Number(url.searchParams.get('limit') ?? 30),
      });
      // Web retires historical plans; RPC totals still include them. Only
      // a source-provided count for this same projection is exact. Older
      // daemons retain their cursor/has_more but must not imply a total.
      const total = Number.isSafeInteger(page.non_plan_total) && page.non_plan_total >= 0
        ? page.non_plan_total : undefined;
      return json({ ...page, total, notices: page.notices.filter(notice => notice.kind !== 'plan') });
    }
    if (url.pathname === '/api/inputs') {
      const params = {};
      for (const [key, value] of url.searchParams) {
        check(['cursor','limit','q','status','integration','conditional','view','modes'].includes(key) && !(key in params), 'unknown or duplicate input history query parameter');
        if (key === 'modes') {
          try { params.modes = JSON.parse(value); } catch { check(false, 'modes must be a JSON array'); }
          check(Array.isArray(params.modes), 'modes must be a JSON array');
        } else params[key] = key === 'limit' ? Number(value) : value;
      }
      return json(await client.request('input.history', params));
    }
    if (url.pathname === '/api/branch-integrate-plan' || url.pathname === '/api/branch-integration') {
      const method = url.pathname === '/api/branch-integrate-plan' ? 'branch.integrate_plan' : 'branch.integration';
      const params = {};
      for (const [key, value] of url.searchParams) {
        check(PARAMS[method].includes(key) && !Object.hasOwn(params, key), 'unknown or duplicate branch integration query parameter');
        if (key === 'id') {
          check(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)), 'integration id must be a positive integer');
          params.id = Number(value);
        } else params[key] = value;
      }
      check(PARAMS[method].every(key => Object.hasOwn(params, key)), 'branch integration query requires branch or id');
      assertAllowed(method, params, null);
      return json(await client.request(method, params));
    }
    if (url.pathname === '/api/branch-convergence/defaults') {
      check(!url.search, 'branch convergence defaults accepts no query parameters');
      return json(await client.request('branch.convergence_defaults'));
    }
    if (url.pathname === '/api/branch-convergence' || url.pathname === '/api/branch-convergence/runs') {
      const runs = url.pathname.endsWith('/runs'), params = {};
      for (const [key, value] of url.searchParams) {
        check((runs ? ['branch','before','limit'] : ['branch']).includes(key) && !Object.hasOwn(params, key),
          'unknown or duplicate branch convergence query parameter');
        if (key === 'branch') params.branch = value;
        else {
          check(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
            && (key !== 'limit' || Number(value) <= 50), 'convergence cursor and limit must be positive integers (limit up to 50)');
          params[key] = Number(value);
        }
      }
      if (runs) {
        check(Object.hasOwn(params, 'branch'), 'convergence runs requires branch');
        return json(await client.request('branch.convergence_runs', params));
      }
      return json(await client.request(Object.hasOwn(params, 'branch') ? 'branch.convergence' : 'branch.convergence_list', params));
    }
    if (url.pathname === '/api/automation/completion/workers') {
      const params = {};
      for (const [key, value] of url.searchParams) {
        check(['before','limit'].includes(key) && !Object.hasOwn(params, key), 'unknown or duplicate completion page query parameter');
        check(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
          && (key !== 'limit' || Number(value) <= 50), 'completion cursor and limit must be positive integers (limit up to 50)');
        params[key] = Number(value);
      }
      return json(await client.request('worker.completion_page', params));
    }
    if (url.pathname === '/api/cli/catalog') {
      check(!url.search, 'CLI catalog accepts no query parameters');
      return json(await client.request('cli.catalog'));
    }
    if (url.pathname === '/api/management/receipt') {
      const params = {};
      for (const [key, value] of url.searchParams) {
        check(PARAMS['management.receipt'].includes(key) && !Object.hasOwn(params, key), 'unknown or duplicate management receipt query parameter');
        check(/^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)), 'invalid management receipt numeric query parameter');
        params[key] = Number(value);
      }
      return json(await client.request('management.receipt', params));
    }
    if (url.pathname === '/api/management/emergency-preview') {
      check(!url.search, 'management emergency preview accepts no query parameters');
      return json(await client.request('management.emergency_preview'));
    }
    if (url.pathname === '/api/management/permissions') {
      check(!url.search, 'management permissions accepts no query parameters');
      return json(await client.request('management.permissions'));
    }
    if (url.pathname === '/api/hooks' || url.pathname === '/api/hooks/temporary/history') {
      const history = url.pathname.endsWith('/history'), method = history ? 'hooks.temporary_history' : 'hooks.list', params = {};
      for (const [key, value] of url.searchParams) {
        check(PARAMS[method].includes(key) && !Object.hasOwn(params, key), 'unknown or duplicate automation query parameter');
        if (key === 'include_reclaimed') { check(['true','false'].includes(value), 'include_reclaimed must be true or false'); params[key] = value === 'true'; }
        else if (['before','limit'].includes(key)) {
          check(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)), 'automation cursor and limit must be positive integers'); params[key] = Number(value);
        } else params[key] = value;
      }
      return json(await client.request(method, params));
    }
    const workerHooks = /^\/api\/worker\/([1-9]\d*)\/hooks$/.exec(url.pathname);
    if (workerHooks) {
      check(!url.search, 'Worker Hooks accepts no query parameters');
      return json(await client.request('worker.hooks', { id: id(workerHooks[1]) }));
    }
    if (url.pathname === '/api/input-parents') {
      check(!url.search, 'input parents accepts no query parameters');
      return json(await client.request('input.parents'));
    }
    const input = CORE_INPUT_READ.exec(url.pathname);
    if (input) {
      check(!url.search, 'input detail accepts no query parameters');
      return json(await client.request('input.get', { kind: input[1], id: id(input[2]) }));
    }
    if (url.pathname === '/api/worker-lookup') {
      check([...url.searchParams.keys()].length === 1 && url.searchParams.has('number'), 'Worker lookup requires only number');
      const number = workerNumber(url.searchParams.get('number'));
      return json(await client.request('worker.lookup', { number }));
    }
    if (url.pathname === '/api/workers') return json(await client.request('worker.page', {
      scope: url.searchParams.get('scope') ?? 'work',
      before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null,
      limit: Number(url.searchParams.get('limit') ?? 50),
    }));
    if (url.pathname === '/api/agent/config') return json(await client.request('agent.config'));
    if (url.pathname === '/api/agent/models') return json(await client.request('agent.models', { agent: url.searchParams.get('agent') || '' }));
    if (url.pathname === '/api/agent/resources') return json(await client.request('agent.resources'));
    if (url.pathname === '/api/hooks/commands/export') {
      const keys = [...url.searchParams.keys()];
      check(keys.length === 2 && keys.includes('id') && keys.includes('version'), 'command export requires only id and version');
      const version = url.searchParams.get('version');
      check(/^[1-9]\d*$/.test(version) && Number.isSafeInteger(Number(version)), 'command export version must be a positive integer');
      return json(await client.request('hooks.command_export', { id: url.searchParams.get('id'), version: Number(version) }));
    }
    if (url.pathname === '/api/hooks/commands/executions') {
      const params = {};
      for (const [key, value] of url.searchParams) {
        check(['before','limit','execution_id'].includes(key) && !Object.hasOwn(params, key),
          'unknown or duplicate command history query parameter');
        if (key === 'execution_id') params[key] = value;
        else {
          check(/^[1-9]\d*$/.test(value), 'command history cursor and limit must be positive integers');
          params[key] = Number(value);
        }
      }
      return json(await client.request('hooks.command_history', params));
    }
    if (url.pathname === '/api/agent/status') return json(await client.request('agent.status'));
    if (url.pathname === '/api/agent/selection/resources') {
      check(!url.search, 'model selection resources accepts no query parameters');
      return json(await client.request('agent.selection.resources'));
    }
    if (url.pathname === '/api/agent/registered-models') {
      check(!url.search, 'registered model list accepts no query parameters');
      return json(await client.request('agent.registered_models.list'));
    }
    if (url.pathname === '/api/agent/connections') {
      check(!url.search, 'connection list accepts no query parameters');
      return json(await client.request('agent.connections.list'));
    }
    if (url.pathname === '/api/agent/connections/history') {
      const params = {};
      for (const [key, value] of url.searchParams) {
        check(['id','days'].includes(key) && !(key in params), 'unknown or duplicate connection history query parameter');
        params[key] = key === 'days' ? Number(value) : value;
      }
      return json(await client.request('agent.connections.history', params));
    }
    if (url.pathname === '/api/agent/connections/models') {
      const params = {};
      for (const [key, value] of url.searchParams) {
        check(['id'].includes(key) && !(key in params), 'unknown or duplicate connection model query parameter');
        params[key] = value;
      }
      check(params.id, 'connection id is required');
      return json(await client.request('agent.connections.models', params));
    }
    if (url.pathname === '/api/agent/packages') {
      check(!url.search, 'installed resource list accepts no query parameters');
      return json(await client.request('agent.packages.list'));
    }
    if (url.pathname === '/api/agent/usage/config') return json(await client.request('agent.usage.config'));
    if (url.pathname === '/api/agent/usage/history') return json(await client.request('agent.usage.history', {
      ...(url.searchParams.has('provider') ? { provider: url.searchParams.get('provider') } : {}),
      ...(url.searchParams.has('account_key') ? { account_key: url.searchParams.get('account_key') } : {}),
      ...(url.searchParams.has('days') ? { days: Number(url.searchParams.get('days')) } : {}),
    }));
    if (url.pathname === '/api/agent/network') {
      check(!url.search, 'network settings do not accept query parameters');
      return json(await client.request('agent.network'));
    }
    if (url.pathname === '/api/agent/environment') return json(await client.request('agent.environment', { target: url.searchParams.get('target') || '' }));
    // Worker 图的 Git 诊断单独按需取数，不进概览的常规轮询。
    if (url.pathname === '/api/worker-graph') {
      const params = {};
      for (const [key, value] of url.searchParams) {
        check(['details','hidden_statuses','include_archived','cursor','scope'].includes(key) && !(key in params), 'unknown or duplicate Worker graph query parameter');
        if (key === 'details' || key === 'include_archived') {
          check(value === '0' || value === '1', `${key} must be 0 or 1`);
          params[key] = value === '1';
        } else if (key === 'hidden_statuses') {
          try { params[key] = JSON.parse(value); } catch { check(false, 'hidden_statuses must be a JSON array'); }
          check(Array.isArray(params[key]), 'hidden_statuses must be a JSON array');
        } else params[key] = value;
      }
      graphOptions(params);
      return json(await client.request('worker.graph', params));
    }
    if (url.pathname === '/api/worker-delivery-graph') {
      const params = {};
      for (const [key, value] of url.searchParams) {
        check(['history','cursor','limit'].includes(key) && !(key in params), 'unknown or duplicate delivery graph query parameter');
        if (key === 'history') {
          check(value === '0' || value === '1', 'history must be 0 or 1'); params.history = value === '1';
        } else if (key === 'limit') {
          check(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)), 'delivery graph limit must be a positive integer');
          params.limit = Number(value);
        } else params.cursor = value;
      }
      return json(await client.request('worker.delivery_graph', params));
    }
    if (url.pathname === '/api/version-graph') {
      const params = {};
      for (const [key, value] of url.searchParams) {
        check(['delivery','cursor','limit'].includes(key) && !(key in params), 'unknown or duplicate version graph query parameter');
        if (key !== 'cursor') check(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)), 'version graph delivery and limit must be positive integers');
        params[key] = key === 'cursor' ? value : Number(value);
      }
      return json(await client.request('branch.version_graph', params));
    }
    if (url.pathname === '/api/versions') {
      const params = {};
      for (const [key, value] of url.searchParams) {
        check(['cursor','limit'].includes(key) && !(key in params), 'unknown or duplicate version history query parameter');
        params[key] = key === 'limit' ? Number(value) : value;
      }
      return json(await client.request('branch.history', params));
    }
    const worker = await workerRead(context, binding);
    if (worker) return worker;
    const content = contentRead(context, staticAssets);
    if (content) return content;
  }
  if (request.method === 'POST' && url.pathname === '/api/action') {
    check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
    const body = await request.json();
    const { method, params } = body;
    check(MUTATIONS.has(method), 'method not allowed from Web UI');
    if (method === 'management.emergency_stop') {
      check(!url.search, 'management emergency accepts no query parameters');
      check(isPlainObject(body) && Object.keys(body).every(key => ['method','params'].includes(key)),
        'management emergency action accepts only method and params');
      check(isPlainObject(params) && !Object.hasOwn(params, '_token') && !Object.hasOwn(params, '_cli_trial'),
        'management emergency params must be an object without execution credentials');
      assertAllowed(method, params, null);
    }
    if (['worker.cli_preview','worker.cli_execute','worker.cli_history','worker.cli_history_clear'].includes(method)) {
      check(!url.search, 'Worker CLI action accepts no query parameters');
      check(isPlainObject(body) && Object.keys(body).every(key => ['method','params'].includes(key)),
        'Worker CLI action accepts only method and params');
      check(isPlainObject(params) && !Object.hasOwn(params, '_token') && !Object.hasOwn(params, '_cli_trial'),
        'Worker CLI params must be an object without execution credentials');
      assertAllowed(method, params, null);
    }
    if (method === 'system.interrupt_all' || method === 'system.resume_all') {
      check(!url.search, 'project maintenance accepts no query parameters');
      check(isPlainObject(body) && Object.keys(body).every(key => ['method','params'].includes(key)),
        'project maintenance action accepts only method and params');
      check(params === undefined || isPlainObject(params) && !Object.hasOwn(params, '_token'),
        'project maintenance params must be an object without agent tokens');
      assertAllowed(method, params ?? {}, null);
      check(params?.notify_completion === undefined || typeof params.notify_completion === 'boolean',
        'notify_completion must be boolean');
    }
    if (['branch.integrate_start','branch.integrate_cancel','branch.integrate_retry'].includes(method)) {
      check(!url.search, 'branch integration action accepts no query parameters');
      check(isPlainObject(body) && Object.keys(body).every(key => ['method','params'].includes(key)),
        'branch integration action accepts only method and params');
      check(isPlainObject(params) && !Object.hasOwn(params, '_token'), 'branch integration params must be an object without agent tokens');
      assertAllowed(method, params, null);
    }
    if (['branch.convergence_set','branch.convergence_defaults_set','branch.convergence_retry'].includes(method)) {
      check(!url.search, 'branch convergence action accepts no query parameters');
      check(isPlainObject(body) && Object.keys(body).every(key => ['method','params'].includes(key)),
        'branch convergence action accepts only method and params');
      check(isPlainObject(params) && !Object.hasOwn(params, '_token'), 'branch convergence params must be an object without agent tokens');
    }
    check(!params?._token, 'agent tokens are not accepted by Web UI');
    check(!Object.hasOwn(params ?? {}, '_cli_trial'), 'private CLI execution contexts are not accepted by Web UI');
    return json(await client.request(method, params));
  }
  return json({ error: 'not found' }, 404);
}
