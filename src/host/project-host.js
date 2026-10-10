import path from 'node:path';
import fs from 'node:fs';
import { Config } from '../config.js';
import { UIClient } from '../ui/client.js';
import { startProjectDaemon, stopProjectDaemon } from './service-control.js';
import { check } from '../core/types.js';
import { readProjectAppearance, saveProjectAppearance } from './project-appearance.js';
import { canonicalProjectPath, readLauncherState, removeLauncherProject, projectRouteId, writeLauncherState } from './registry.js';

export function createProjectHost(initialConfig = null, options = {}) {
  const launcher = !initialConfig;
  const env = options.env || process.env;
  const allowedProjects = options.allowedProjects ? new Set(options.allowedProjects) : null;
  const openProject = options.openProject || (async project => {
    const config = new Config({ project, env });
    await startProjectDaemon(config);
    return { config, client: new UIClient(config) };
  });
  // Attaching an API client is read-only. A stale tab or a second Host must never
  // undo an explicit stop merely by polling a registered project.
  const attachProject = options.attachProject || (async project => {
    const config = new Config({ project, env });
    return { config, client: new UIClient(config) };
  });
  const stopProject = options.stopProject || stopProjectDaemon;
  const boundProject = initialConfig ? initialConfig.project : null;
  /** 每个 canonical 路径一份连接与客户端；连接失败只脏这一格，不影响其它项目。 */
  const connections = new Map();
  const inflight = new Map();
  const stopping = new Set();
  const failures = new Map();
  /** 摘要读取的退避：不可达项目不每轮重试，但不影响其它项目的行。 */
  const summaryBackoff = new Map();
  const SUMMARY_TIMEOUT_MS = 4000, SUMMARY_BACKOFF_MS = 60_000;
  if (initialConfig) connections.set(boundProject, { config: initialConfig, client: new UIClient(initialConfig) });

  /** 已登记项目：公网模式只认白名单（不退化为仅控制选择器）；本地全局模式认启动器列表；单项目模式只有自己。 */
  function registry() {
    if (allowedProjects) return [...allowedProjects];
    const list = [];
    if (boundProject) list.push(boundProject);
    if (launcher) for (const project of readLauncherState(env).projects) if (!list.includes(project)) list.push(project);
    return list;
  }

  /**
   * URL 里的不透明 ID → canonical 路径。只认已登记集合，绝不把 URL 片段当路径。
   * 登记项与磁盘 realpath 不一致（符号链接 / 目录搬家）时按真实路径匹配，但只在它仍存在时。
   */
  function routePath(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) return null;
    for (const entry of registry()) {
      if (projectRouteId(entry) === id) return entry;
      try {
        const real = fs.realpathSync(entry);
        if (projectRouteId(real) === id) return real;
      } catch { /* 目录不在了：保留原登记项，解析失败时显式报错而不是绑定别的目录 */ }
    }
    return null;
  }

  /** Only explicit select/start may launch a daemon; API attachment never does. */
  async function connect(project, start = false) {
    check(!stopping.has(project), '项目后台正在停止，请稍后再试');
    const pending = inflight.get(project);
    if (pending) {
      await pending;
      // A read-only attachment is not evidence that explicit start completed.
      if (!start || pending.startsDaemon) return connections.get(project);
      return await connect(project, true);
    }
    const existing = connections.get(project);
    if (existing && !start) return existing;
    const attempt = (async () => {
      const next = await (start ? openProject : attachProject)(project);
      check(next?.config && next?.client, 'project opener returned an invalid binding');
      connections.set(project, next);
      failures.delete(project);
      summaryBackoff.delete(project);
      return next;
    })();
    attempt.startsDaemon = start;
    inflight.set(project, attempt);
    try { return await attempt; }
    catch (error) { failures.set(project, error.message); throw error; }
    finally { inflight.delete(project); }
  }

  function entries() {
    const state = launcher ? readLauncherState(env) : { last_project: boundProject };
    const last = state.last_project && (!allowedProjects || allowedProjects.has(state.last_project)) ? state.last_project : null;
    return registry().map(project => ({ id: projectRouteId(project), project, name: path.basename(project) || project,
      connected: connections.has(project) || inflight.has(project), last: project === last,
      error: failures.get(project) ?? null }));
  }

  async function select(value) {
    check(launcher, 'this Web UI is bound to one project; restart it without --project to switch projects');
    const project = canonicalProjectPath(value, env);
    check(!allowedProjects || allowedProjects.has(project), `项目不在全局 Web 白名单中：${project}`);
    writeLauncherState(project, env);
    await connect(project, true);
    return project;
  }

  function requirePath(id) {
    const project = routePath(id);
    check(project, `未知或已失效的项目身份：${id}（请刷新页面或从项目列表重新打开）`);
    return project;
  }

  function appearanceMetadata(id, update, write = false) {
    // Unlike daemon routing, appearance storage never follows a moved registry
    // entry to a different canonical path or accepts a symlink alias identity.
    const project = registry().find(entry => projectRouteId(entry) === id);
    check(typeof id === 'string' && /^[a-f0-9]{16}$/.test(id) && project, `未知或已失效的项目身份：${id}`);
    const appearance = write ? saveProjectAppearance(project, update, { projects: registry(), env })
      : readProjectAppearance(project);
    return { id, name: path.basename(project) || project, project, appearance };
  }

  return {
    launcher,
    appearance(id) { return appearanceMetadata(id); },
    saveAppearance(id, body) { return appearanceMetadata(id, body, true); },
    async status() {
      const state = launcher ? readLauncherState(env) : { last_project: boundProject };
      const last = state.last_project && (!allowedProjects || allowedProjects.has(state.last_project)) ? state.last_project : null;
      return { mode: launcher ? 'host' : 'bound', project: boundProject, project_control: true,
        last_project: last, last_project_id: last ? projectRouteId(last) : null,
        error: null, ...(launcher && allowedProjects ? { allowed_projects: [...allowedProjects] } : {}),
        projects: entries() };
    },
    /** 项目列表 + 仅对已经连接的项目读一次有界摘要；不因为列表面板就启动没打开过的 daemon。
     *  每个项目独立计时、失败独立退避：一个卡住的 daemon 不能拖住整张列表。 */
    async projects() {
      return await Promise.all(entries().map(async row => {
        const binding = connections.get(row.project);
        const retryAt = summaryBackoff.get(row.project) ?? 0;
        if (retryAt > Date.now()) return { ...row, running: false, error: failures.get(row.project) ?? '项目暂时不可达' };
        let timer = null;
        try {
          // 未打开的项目只探测已存在的 socket；列表读取绝不启动 lushd。
          const config = binding?.config || new Config({ project: row.project, env });
          if (!binding && !fs.existsSync(config.socket)) return { ...row, running: false };
          const status = await Promise.race([
            (binding?.client || new UIClient(config)).request('system.summary'),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('项目摘要读取超时')), SUMMARY_TIMEOUT_MS); timer.unref?.(); }),
          ]);
          check(status.project === row.project, 'lushd 项目身份与登记路径不符');
          summaryBackoff.delete(row.project);
          return { ...row, running: true, error: null, summary: { project: status.project, revision: status.revision, provider: status.provider,
            agents_total: status.agents_total ?? 0, notices: status.notices ?? 0,
            ...(Number.isSafeInteger(status.pid) && status.pid > 0 ? { pid: status.pid } : {}),
            ...(typeof status.auto_select?.enabled === 'boolean' && typeof status.auto_select.revision === 'string'
              && status.auto_select.revision.length <= 256 ? { auto_select: { enabled: status.auto_select.enabled,
              revision: status.auto_select.revision, ...(['device','project'].includes(status.auto_select.scope)
                ? { scope: status.auto_select.scope } : {}) } } : {}),
            waiting_approval: status.intents?.waiting_approval ?? 0, pending_merges: status.pending_merges?.length ?? 0 } };
        } catch (error) {
          summaryBackoff.set(row.project, Date.now() + SUMMARY_BACKOFF_MS);
          failures.set(row.project, '后台状态读取失败；未确认当前进程状态');
          return { ...row, running: false, error: '后台状态读取失败；未确认当前进程状态' };
        } finally { if (timer) clearTimeout(timer); }
      }));
    },
    async select(value) { return await select(value); },
    async start(id) {
      const project = requirePath(id);
      await connect(project, true);
      return { started: true, id: projectRouteId(project), project };
    },
    async stop(id) {
      const project = requirePath(id);
      check(!stopping.has(project) && !inflight.has(project), '项目后台正在启动、停止或连接，请稍后再试');
      stopping.add(project);
      try {
        const config = connections.get(project)?.config || new Config({ project, env });
        const result = await stopProject(config);
        connections.delete(project);
        failures.delete(project);
        summaryBackoff.delete(project);
        return { ...result, id: projectRouteId(project) };
      } finally { stopping.delete(project); }
    },
    /** API requests attach only; unavailable projects stay offline until explicit start. */
    async openRoute(id) { return await connect(requirePath(id)); },
    /** 从列表移除：只删入口并断开 Web 连接，不停止 daemon。 */
    remove(id) {
      check(launcher, 'this Web UI is bound to one project');
      const project = routePath(id);
      check(project, `未知的项目身份：${id}`);
      check(!stopping.has(project) && !inflight.has(project), '项目后台正在启动、停止或连接，请稍后再试');
      const state = removeLauncherProject(project, env);
      connections.delete(project);
      failures.delete(project);
      summaryBackoff.delete(project);
      return { project, ...state };
    },
    async require() { check(!launcher, '请通过 /p/<project>/ 访问具体项目'); return await connect(boundProject); },
    hasRoute(id) { return Boolean(routePath(id)); },
    rememberCurrent() { if (launcher && connections.size) writeLauncherState(boundProject ?? [...connections.keys()].at(-1), env); },
  };
}
