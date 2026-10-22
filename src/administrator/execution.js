import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Config } from '../config.js';
import { UIClient } from '../ui/client.js';
import { DeviceSettingsService, DEVICE_SETTINGS_READS, DEVICE_SETTINGS_ACTIONS } from '../host/device-settings.js';
import { startProjectDaemon, stopProjectDaemon, restartProjectDaemon } from '../host/service-control.js';
import { PARAMS } from '../rpc/registry.js';
import { check, isPlainObject } from '../core/types.js';
import { administratorProjectMethods } from './project-dispatch.js';
import { administratorHome, signAdministratorRequest, safeAdministratorValue } from './delegation.js';
import { ADMINISTRATOR_OPERATIONS, validateAdministratorToolRequest } from './tool-protocol.js';

const CLI = fileURLToPath(new URL('../../bin/lush', import.meta.url));
const deviceMethods = new Set([...DEVICE_SETTINGS_READS.values()].map(([method]) => method).concat([...DEVICE_SETTINGS_ACTIONS]));
const privateDeviceMethods = new Set(['agent.registered_models.save', 'agent.registered_models.remove', 'agent.environment', 'agent.connections.save', 'agent.connections.login.start', 'agent.connections.login.finish',
  'agent.connections.device.start', 'agent.connections.device.poll', 'agent.connections.device.cancel']);
function cleanEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('LUSH_') || ['LUSH_PROVIDER','LUSH_PI_COMMAND','LUSH_GLOBAL_CONFIG','LUSH_CALL_TIMEOUT','LUSH_TASK_CALLS','LUSH_MAX_DEPTH'].includes(key)));
}
function fields(value, allowed, required = []) {
  check(isPlainObject(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)), 'invalid administrator operation parameters');
}
function privateParams(value, depth = 0) {
  check(depth < 32, 'administrator parameter nesting limit');
  if (Array.isArray(value)) return value.forEach(item => privateParams(item, depth + 1));
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    check(!key.startsWith('_') && !/(?:^|_)(?:token|credential|password|secret|env|prompt|private_key|api_key)(?:$|_)/i.test(key)
      && !/^(?:default_prompt|append_prompt|apiKey|accessToken|refreshToken|systemPrompt|privatePrompt)$/i.test(key), 'private material is not an administrator tool parameter');
    privateParams(item, depth + 1);
  }
}
function projectConfig(project, env) {
  check(typeof project === 'string' && path.isAbsolute(project) && fs.realpathSync(project) === project, 'explicit canonical administrator project required');
  check(fs.existsSync(path.join(project, '.git')) || fs.existsSync(path.join(project, '.lush', 'project.json')), 'administrator target must be a Lush/Git project');
  return new Config({ project, env });
}
const secretName = name => name.startsWith('.') || /(?:^|[._-])(?:auth|credentials?|secrets?|tokens?|passwords?|private|id_rsa|id_ed25519)(?:[._-]|$)/i.test(name)
  || /\.(?:pem|key|p12|pfx|sqlite|db|jsonl|log)$/i.test(name);
function sourceFile(project, relative, directory = false) {
  check(typeof relative === 'string' && relative.length <= 4096 && !path.isAbsolute(relative) && !relative.includes('\\') && !relative.includes('\0'), 'relative source path required');
  const parts = relative.split('/').filter(Boolean);
  check(parts.every(part => part !== '..' && part !== '.' && !secretName(part)), 'private source path is unavailable');
  const file = path.join(project, ...parts);
  check(file === project || file.startsWith(project + path.sep), 'source path outside project');
  let current = project;
  for (const part of parts) { current = path.join(current, part); check(!fs.lstatSync(current).isSymbolicLink(), 'source symlinks are unavailable'); }
  const stat = fs.lstatSync(file);
  check(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, 'source is not an eligible regular file');
  check(fs.realpathSync(file) === file && stat.uid === process.getuid(), 'source ownership or path changed');
  return { file, stat };
}
export function createAdministratorExecutor({ env = process.env, home = administratorHome(env), requestProject = null, deviceService = null, hostControl = null, projectControl = null } = {}) {
  const runtimeEnv = cleanEnv(env);
  const methods = administratorProjectMethods();
  let device = deviceService;
  return {
    catalog() {
      const descriptions = {
        catalog: { readOnly: true, parameters: [], mode: 'administrator', scope: 'device_user',
          confirmation: 'already_confirmed_instruction_only', consistency_checks: 'unchanged',
          exclusions: ['administrator creation/input/confirmation', 'credential material and interactive authentication', 'private prompts/environment values', 'retired and invocation-bound Agent methods', 'arbitrary shell/file execution'],
          note: '项目方法走签名管理员委托与用户级业务处理器，不是普通 Valet 权限或元数据投影。源码修改／测试通过正常开发 Worker 与其 Git 工作区完成；不直接改写 canonical 项目。认证流程需要用户实际登录，不是执行中再次请求操作授权。' },
        'project.call': { readOnly: false, parameters: ['project','method','params'], methods: methods.map(method => ({ method, parameters: PARAMS[method] })) },
        'source.list': { readOnly: true, parameters: ['project','path','offset','limit'], private_paths: 'excluded', max_entries: 100 },
        'source.read': { readOnly: true, parameters: ['project','path','offset','limit'], private_paths: 'excluded', max_lines: 2000 },
        'device.call': { readOnly: false, parameters: ['method','params'], methods: [...deviceMethods].filter(method => !privateDeviceMethods.has(method)).map(method => ({ method, parameters: PARAMS[method] })) },
        'service.project': { readOnly: false, parameters: ['project','action'], actions: ['start','stop','restart'] },
        'service.host': { readOnly: false, parameters: ['action'], actions: ['start','stop','restart','status'] },
      };
      return ADMINISTRATOR_OPERATIONS.map(name => ({ name, ...descriptions[name] }));
    },
    async execute({ operation, params, identity, signal }) {
      validateAdministratorToolRequest({ operation, params });
      check(identity && ['service_id','worker_id','instruction_id','call_id'].every(key => identity[key] !== undefined && String(identity[key]).length > 0), 'trusted administrator identity required');
      check(!signal?.aborted, 'administrator execution revoked');
      if (operation === 'catalog') { fields(params, []); return this.catalog(); }
      if (operation === 'project.call') {
        fields(params, ['project','method','params'], ['project','method','params']);
        check(methods.includes(params.method) && isPlainObject(params.params), 'administrator project method unavailable');
        privateParams(params.params);
        const config = projectConfig(params.project, runtimeEnv);
        const delegated = signAdministratorRequest(home, { project: config.project, method: params.method, params: params.params, identity });
        const result = requestProject ? await requestProject(config, 'administrator.dispatch', delegated, { signal })
          : await new UIClient(config).request('administrator.dispatch', delegated, { signal });
        return safeAdministratorValue(result);
      }
      if (operation === 'source.list' || operation === 'source.read') {
        fields(params, ['project','path','offset','limit'], ['project','path']);
        const config = projectConfig(params.project, runtimeEnv), listing = operation === 'source.list';
        const { file, stat } = sourceFile(config.project, params.path, listing);
        const offset = params.offset ?? (listing ? 0 : 1), limit = params.limit ?? (listing ? 100 : 200);
        check(Number.isSafeInteger(offset) && offset >= (listing ? 0 : 1) && Number.isSafeInteger(limit) && limit >= 1 && limit <= (listing ? 100 : 2000), 'invalid source page');
        if (listing) {
          const eligible = fs.readdirSync(file, { withFileTypes: true }).filter(item => !secretName(item.name) && !item.isSymbolicLink()).sort((a,b) => a.name.localeCompare(b.name));
          const items = eligible.slice(offset, offset + limit).map(item => ({ name: item.name, kind: item.isDirectory() ? 'directory' : 'file' }));
          return { version: 1, project: config.project, path: params.path, items, next: offset + items.length, has_more: eligible.length > offset + items.length, coverage: 'eligible_source_entries_only' };
        }
        check(stat.size <= 1024 * 1024, 'source file exceeds read budget');
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let content;
        try {
          const before = fs.fstatSync(fd); check(before.ino === stat.ino && before.dev === stat.dev, 'source changed before read');
          content = fs.readFileSync(fd, 'utf8');
          const after = fs.fstatSync(fd), current = fs.lstatSync(file);
          check(after.ino === current.ino && after.dev === current.dev && before.size === after.size && before.mtimeMs === after.mtimeMs, 'source changed while reading');
        } finally { fs.closeSync(fd); }
        check(!content.includes('\0'), 'binary source unavailable');
        const lines = content.split('\n'), selected = lines.slice(offset - 1, offset - 1 + limit).join('\n');
        check(Buffer.byteLength(selected) <= 256000, 'source page exceeds output budget');
        return { version: 1, project: config.project, path: params.path, offset, content: safeAdministratorValue(selected), next: offset + Math.min(limit, Math.max(0, lines.length - offset + 1)), has_more: lines.length >= offset + limit, coverage: 'source_text_secret_patterns_redacted' };
      }
      if (operation === 'device.call') {
        fields(params, ['method','params'], ['method','params']);
        check(deviceMethods.has(params.method) && !privateDeviceMethods.has(params.method) && isPlainObject(params.params), 'administrator device method unavailable');
        privateParams(params.params);
        device ||= new DeviceSettingsService(runtimeEnv);
        return safeAdministratorValue(await device.request(params.method, { ...params.params, scope: 'device' }));
      }
      if (operation === 'service.project') {
        fields(params, ['project','action'], ['project','action']);
        check(['start','stop','restart'].includes(params.action), 'invalid project service action');
        const config = projectConfig(params.project, runtimeEnv);
        const controls = { start: startProjectDaemon, stop: stopProjectDaemon, restart: restartProjectDaemon };
        return safeAdministratorValue(await (projectControl ? projectControl(config, params.action, signal) : controls[params.action](config)));
      }
      fields(params, ['action'], ['action']);
      check(['start','stop','restart','status'].includes(params.action), 'invalid Host service action');
      if (hostControl) return safeAdministratorValue(await hostControl(params.action, signal));
      return safeAdministratorValue(await new Promise((resolve, reject) => {
        cp.execFile(process.execPath, [CLI, 'host', params.action, '--json'], { env: runtimeEnv, timeout: 30000, maxBuffer: 256000, signal }, (error, stdout) => {
          if (error) { reject(new Error('Host 控制未确认完成；不要自动重发，请检查服务状态。')); return; }
          try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Host 控制返回不可验证；副作用未知。')); }
        });
      }));
    },
    async close() { await device?.stop?.(); },
  };
}
