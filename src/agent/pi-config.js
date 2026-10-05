import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check } from '../core/types.js';
import { PI_CREDENTIAL_ENV_NAMES } from './status-accounts.js';

const MAX_FILE = 256 * 1024;
const DEFAULT_SETTINGS = Object.freeze({ defaultProjectTrust: 'never', enableInstallTelemetry: false,
  enableAnalytics: false, cacheWarming: 'off' });
export const PI_RUNTIME_SETTINGS = ['thinkingBudgets', 'modelThinkingLevels', 'defaultTools', 'compaction', 'branchSummary',
  'transport', 'httpIdleTimeoutMs', 'websocketConnectTimeoutMs', 'retry', 'shellPath', 'shellCommandPrefix', 'images', 'warnings'];

function validateDirectory(dir, required = false) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch (error) {
    if (error.code === 'ENOENT' && !required) return false;
    throw new Error('Lush Pi configuration directory unavailable');
  }
  check(typeof process.getuid === 'function' && stat.isDirectory() && !stat.isSymbolicLink()
    && stat.uid === process.getuid() && !(stat.mode & 0o077), 'unsafe Lush Pi configuration directory');
  return true;
}

/** Project-owned path, never an environment override or a user-level Pi directory. */
export function piConfigDirectory(config) {
  check(typeof config.home === 'string' && path.isAbsolute(config.home), 'Lush Pi configuration requires project home');
  validateDirectory(config.home);
  const dir = path.join(config.home, 'pi');
  validateDirectory(dir);
  return dir;
}

/** Private, bounded JSON; absent files are empty, unsafe or corrupt files fail without raw diagnostics. */
export function readPiConfiguration(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    check(typeof process.getuid === 'function' && stat.isFile() && stat.uid === process.getuid()
      && !(stat.mode & 0o077) && stat.size <= MAX_FILE, 'unsafe Lush Pi configuration file');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    check(value && typeof value === 'object' && !Array.isArray(value), 'invalid Lush Pi configuration');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('Lush Pi configuration cannot be safely read');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Atomic create-only initialization; never overwrite an existing project file, even during races. */
export function ensurePiConfiguration(config) {
  const dir = piConfigDirectory(config);
  if (!fs.existsSync(config.home)) fs.mkdirSync(config.home, { recursive: true, mode: 0o700 });
  validateDirectory(config.home, true);
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw new Error('Lush Pi configuration directory unavailable'); }
  validateDirectory(dir, true);
  const file = path.join(dir, 'settings.json'), temporary = path.join(dir, `.settings-${randomUUID()}.tmp`);
  try {
    // Read first to reject an existing symlink, bad permissions or damaged settings rather than repair it.
    readPiConfiguration(file);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(temporary, JSON.stringify(DEFAULT_SETTINGS, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      try { fs.linkSync(temporary, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const settings = readPiConfiguration(file);
    const models = readPiConfiguration(path.join(dir, 'models.json'));
    return { dir, settings: { ...Object.fromEntries(PI_RUNTIME_SETTINGS.filter(key => Object.hasOwn(settings, key))
      .map(key => [key, settings[key]])), ...DEFAULT_SETTINGS }, models };
  } catch { throw new Error('Lush Pi configuration cannot be safely prepared'); }
  finally { fs.rmSync(temporary, { force: true }); }
}

/** Configuration isolation is not an OS sandbox. Keep tool env, but never Pi's ambient model authentication. */
export function isolatedPiEnvironment(config, environment = config.env, directory = piConfigDirectory(config)) {
  const values = { ...environment };
  for (const key of Object.keys(values)) {
    if (PI_CREDENTIAL_ENV_NAMES.has(key) || key.startsWith('PI_SESSION')
      || ['PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL', 'PI_CODING_AGENT_SESSION_DIR'].includes(key)) delete values[key];
  }
  return { ...values, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
}
