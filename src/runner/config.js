import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { posixFiles } from '../core/workspaces/code-posix.js';
import { RunnerError, check } from './protocol.js';
import { normalizeConfig } from './node.js';

export const defaultConfigPath = () => process.env.LUSH_RUNNER_CONFIG || path.join(os.homedir(), '.config', 'lush-runner', 'config.json');

/** Node-user provisioned private config. Never accept a config path in protocol frames. */
export function readRunnerConfig(file = defaultConfigPath()) {
  check(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file, 'INVALID_REQUEST', 'Runner config path must be absolute and canonical');
  let parent, fd;
  try {
    parent = posixFiles.openDirectory(path.dirname(file));
    fd = posixFiles.openAt(parent, path.basename(file));
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.size <= 64 * 1024 && stat.size > 0 && (stat.mode & 0o077) === 0
      && (typeof process.getuid !== 'function' || stat.uid === process.getuid()), 'UNAUTHORIZED', 'Runner config must be an owner-only regular file');
    let raw;
    try { raw = JSON.parse(fs.readFileSync(fd, 'utf8')); }
    catch { throw new RunnerError('INVALID_REQUEST', 'Runner config is not valid JSON'); }
    check(raw && raw.version === 1, 'VERSION_MISMATCH', 'Unsupported Runner configuration version');
    const allowed = ['version', 'root', 'node_id', 'machine_token_hash', 'projects', 'cgroup_root', 'max_commands',
      'memory_reserve_bytes', 'output_storage_bytes', 'budgets', 'command_env_allowlist', 'command_path'];
    check(Object.keys(raw).every(key => allowed.includes(key)), 'INVALID_REQUEST', 'Unknown Runner configuration field');
    check(typeof raw.root === 'string' && path.isAbsolute(raw.root) && path.resolve(raw.root) === raw.root,
      'INVALID_REQUEST', 'Runner root must be absolute and canonical');
    check(typeof raw.cgroup_root === 'string' && path.isAbsolute(raw.cgroup_root) && path.resolve(raw.cgroup_root) === raw.cgroup_root,
      'INVALID_REQUEST', 'Runner cgroup_root must be absolute and canonical');
    return normalizeConfig(raw);
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError('UNAVAILABLE', 'Runner private configuration could not be read safely');
  } finally { if (fd !== undefined) fs.closeSync(fd); if (parent !== undefined) fs.closeSync(parent); }
}
