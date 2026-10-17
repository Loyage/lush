import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check, isPlainObject } from './types.js';
import { hookRevision } from './hooks.js';
import { MANAGEMENT_GROUPS, managementPermissionMethods } from '../rpc/management-policy.js';
import { validateConfigurationDirectory, withConfigurationWriteLock } from './device-config.js';

// Previous device policy is historical only; never read, migrate or overwrite it.
const FILE = 'management-permissions-v2.json';
const MAX_BYTES = 256 * 1024;
const empty = () => ({ version: 1, generation: 0, permissions: {} });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const root = config => ({ home: config.deviceHome || config.home });

/** The reviewed method set and ceilings have exactly one source. */
export function normalizeManagementPermissions(permissions) {
  const methods = managementPermissionMethods();
  check(isPlainObject(permissions) && Object.keys(permissions).length === methods.length
    && Object.keys(permissions).every(method => methods.some(item => item.method === method)),
  'permissions must be a complete known method-to-access mapping');
  for (const item of methods) check(Object.hasOwn(permissions, item.method) && item.allowed_access.includes(permissions[item.method]),
    `invalid or elevated management permission: ${item.method}`);
  return Object.fromEntries(methods.map(item => [item.method, permissions[item.method]]));
}

export function managementPermissionsView(value, scope = 'project', configured = true) {
  // A newly reviewed method inherits its reviewed default, never a historical snapshot.
  const methods = managementPermissionMethods().map(item => {
    const access = value.permissions[item.method] ?? item.base_access;
    return { ...item, access: item.allowed_access.includes(access) ? access : 'unavailable' };
  });
  return { version: 1, scope, configured, revision: hookRevision(value), groups: MANAGEMENT_GROUPS.map(group => ({ ...group })),
    methods, permissions: Object.fromEntries(methods.map(item => [item.method, item.access])) };
}

function load(config) {
  let fd;
  try {
    if (!validateConfigurationDirectory(config)) return null;
    const file = path.join(config.home, FILE), directory = fs.lstatSync(config.home);
    let published;
    try { published = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    check(!published.isSymbolicLink(), 'unsafe management permissions file');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600
      && stat.nlink === 1 && stat.size <= MAX_BYTES && same(stat, published), 'unsafe management permissions file');
    const source = fs.readFileSync(fd, 'utf8'), after = fs.fstatSync(fd);
    check(Buffer.byteLength(source) <= MAX_BYTES && same(stat, after) && stat.size === after.size
      && stat.mtimeMs === after.mtimeMs && stat.ctimeMs === after.ctimeMs
      && same(stat, fs.lstatSync(file)) && same(directory, fs.lstatSync(config.home)), 'management permissions changed while reading');
    validateConfigurationDirectory(config, 'project', true);
    const data = JSON.parse(source);
    check(isPlainObject(data) && Object.keys(data).length === 3 && data.version === 1
      && Number.isSafeInteger(data.generation) && data.generation > 0 && isPlainObject(data.permissions), 'invalid management permissions document');
    // Old reviewed entries remain history when a method is retired. Existing entries must not exceed today's ceiling.
    for (const item of managementPermissionMethods()) if (Object.hasOwn(data.permissions, item.method))
      check(item.allowed_access.includes(data.permissions[item.method]), 'invalid management permission');
    check(Object.values(data.permissions).every(access => ['read','automatic','confirmation','unavailable'].includes(access)), 'invalid management permission');
    return data;
  } catch { throw new Error('device management permissions cannot be safely read'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Missing storage activates the built-in reviewed defaults without creating storage. */
export function readDeviceManagementPermissions(config) {
  const value = load(root(config));
  return managementPermissionsView(value ?? empty(), 'device', value !== null);
}

export function managementPermissionView(config, method, scope) {
  check(scope === 'device', 'management permissions require explicit device scope');
  const view = readDeviceManagementPermissions(config);
  const item = view.methods.find(item => item.method === method);
  check(item, 'unknown management permission method');
  return { version: 1, scope: 'device', configured: view.configured, revision: view.revision, ...item };
}

export function saveDeviceManagementPermission(config, method, access, expectedRevision, scope) {
  const item = managementPermissionView(config, method, scope);
  check(item.allowed_access.includes(access), `invalid or elevated management permission: ${method}`);
  // The full writer re-reads under the shared publication lock. A concurrent
  // change anywhere on this device invalidates this exact single-item CAS too.
  const current = readDeviceManagementPermissions(config);
  const saved = saveDeviceManagementPermissions(config, { ...current.permissions, [method]: access }, expectedRevision);
  return { method, access, revision: saved.revision };
}

export function saveDeviceManagementPermissions(config, permissions, expectedRevision) {
  const selected = root(config), normalized = normalizeManagementPermissions(permissions);
  check(typeof expectedRevision === 'string' && expectedRevision.length > 0, 'management permissions revision is required');
  return withConfigurationWriteLock(selected, 'project', lock => {
    const current = load(selected) ?? empty();
    check(hookRevision(current) === expectedRevision, 'management permissions revision changed; reload before saving');
    check(current.generation < Number.MAX_SAFE_INTEGER, 'management permissions generation exhausted');
    const next = { version: 1, generation: current.generation + 1, permissions: normalized };
    const file = path.join(selected.home, FILE), temporary = `${file}.${randomUUID()}.tmp`;
    const source = JSON.stringify(next, null, 2) + '\n';
    check(Buffer.byteLength(source) <= MAX_BYTES, 'management permissions are too large');
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, source); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      lock.assert();
      check(hookRevision(load(selected) ?? empty()) === expectedRevision, 'management permissions changed before publication');
      fs.renameSync(temporary, file);
      return managementPermissionsView(next, 'device');
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
  });
}
