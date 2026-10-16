import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { check, isPlainObject } from './types.js';
import { validateConfigurationDirectory, withConfigurationWriteLock } from './device-config.js';

const MAX_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const FILE = 'runner-credentials.json';
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function fields(value, keys) {
  check(isPlainObject(value) && Object.keys(value).every(key => keys.includes(key)), 'invalid Runner credential fields');
}
function nodeId(value) { check(typeof value === 'string' && UUID.test(value), 'invalid Runner credential node identity'); }
function projectId(value) {
  check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value), 'invalid Runner credential project identity');
}
function expectedRevision(value) {
  check(value === 'absent' || typeof value === 'string' && UUID.test(value), 'Runner credential revision is required');
}

/** Validate encoding/represented length, NOT randomness. Never generate or echo a control credential. */
export function validateRunnerControlToken(value) {
  check(typeof value === 'string' && value.length >= 32 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value),
    'invalid Runner control credential encoding or length');
  const hex = /^[0-9a-fA-F]{64,256}$/.test(value) && value.length % 2 === 0;
  const decoded = Buffer.from(value, 'base64url');
  const base64url = decoded.length >= 32 && decoded.length <= 256 && decoded.toString('base64url') === value;
  check(hex || base64url, 'invalid Runner control credential encoding or length');
  return value;
}
function rootConfig(config) {
  const home = config?.deviceHome ?? (!config?.project ? config?.home : null);
  check(typeof home === 'string' && path.isAbsolute(home), 'Runner credential device directory is unavailable');
  return { home: path.resolve(home) };
}
const empty = () => ({ version: 1, revision: 'absent', nodes: [] });
function normalize(value) {
  fields(value, ['version', 'revision', 'nodes']);
  check(value.version === 1 && UUID.test(value.revision) && Array.isArray(value.nodes) && value.nodes.length <= 64,
    'invalid Runner credential storage');
  const ids = new Set();
  const nodes = value.nodes.map(node => {
    fields(node, ['node_id', 'machine_token', 'projects']); nodeId(node.node_id);
    check(!ids.has(node.node_id), 'duplicate Runner credential node'); ids.add(node.node_id);
    check(node.machine_token === null || typeof node.machine_token === 'string', 'invalid Runner machine credential');
    if (node.machine_token !== null) validateRunnerControlToken(node.machine_token);
    check(Array.isArray(node.projects) && node.projects.length <= 128, 'invalid Runner project credential list');
    const projects = new Set();
    return { node_id: node.node_id, machine_token: node.machine_token, projects: node.projects.map(project => {
      fields(project, ['project_id', 'control_token']); projectId(project.project_id);
      check(!projects.has(project.project_id), 'duplicate Runner project credential'); projects.add(project.project_id);
      validateRunnerControlToken(project.control_token);
      return { project_id: project.project_id, control_token: project.control_token };
    }) };
  });
  return { version: 1, revision: value.revision, nodes };
}
function load(config) {
  let fd;
  try {
    if (!validateConfigurationDirectory(config)) return { data: empty(), fingerprint: null };
    const root = fs.lstatSync(config.home), file = path.join(config.home, FILE);
    let published;
    try { published = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { data: empty(), fingerprint: null }; throw error; }
    check(!published.isSymbolicLink(), 'unsafe Runner credential file');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600
      && stat.size <= MAX_BYTES && same(stat, published), 'unsafe Runner credential file');
    const buffer = Buffer.alloc(MAX_BYTES + 1); let bytes = 0, count;
    while (bytes < buffer.length && (count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null)) > 0) bytes += count;
    const after = fs.fstatSync(fd);
    check(bytes <= MAX_BYTES && bytes === stat.size && same(stat, after) && stat.size === after.size
      && stat.mtimeMs === after.mtimeMs && stat.ctimeMs === after.ctimeMs && same(stat, fs.lstatSync(file))
      && same(root, fs.lstatSync(config.home)), 'Runner credential storage changed while reading');
    validateConfigurationDirectory(config, 'project', true);
    const source = buffer.subarray(0, bytes);
    return { data: normalize(JSON.parse(source.toString('utf8'))), fingerprint: createHash('sha256').update(source).digest('hex') };
  } catch { throw new Error('Runner credentials cannot be safely read'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function view(data) {
  // The public revision is random, not a digest of any credential. No token hashes leave this module.
  return { version: 1, revision: data.revision, nodes: data.nodes.map(node => ({ node_id: node.node_id,
    machine_configured: node.machine_token !== null,
    projects: node.projects.map(project => ({ project_id: project.project_id, control_configured: true })) })) };
}

/** Device-local secrets only. No Store/events, RPC registration, SSH or Agent/Shell environment. */
export class RunnerCredentials {
  #config;
  constructor(config) { this.#config = rootConfig(config); }
  read() { return view(load(this.#config).data); }

  /** Trusted central RunnerClient only. Never expose this method through generic JSON/RPC projections. */
  snapshot(node_id, project_id) {
    nodeId(node_id); projectId(project_id);
    const node = load(this.#config).data.nodes.find(item => item.node_id === node_id);
    const project = node?.projects.find(item => item.project_id === project_id);
    check(node?.machine_token && project?.control_token, 'Runner control credentials are not configured');
    return { machine_token: node.machine_token, control_token: project.control_token };
  }

  /** User-authorized write. A machine token and/or exactly one project token may be updated. */
  save(value, expected_revision) { return this.#save(value, expected_revision); }

  /** Trusted journal only: pair a fresh node, never update/adopt an existing credential entry. */
  pairDeployment(value, expected_revision, guard) {
    check(typeof guard === 'function', 'Deployment credential guard is required');
    const assert = () => check(!guard()?.then, 'Deployment credential guard must be synchronous');
    assert();
    check(isPlainObject(value) && ['machine_token', 'project_id', 'control_token'].every(key => Object.hasOwn(value, key)), 'Deployment requires independent machine and project credentials');
    return this.#save(value, expected_revision, { fresh: true, guard: assert });
  }

  #save(value, expected_revision, { fresh = false, guard = null } = {}) {
    fields(value, ['node_id', 'machine_token', 'project_id', 'control_token']); nodeId(value.node_id);
    const machine = Object.hasOwn(value, 'machine_token'), project = Object.hasOwn(value, 'project_id');
    check(machine || project, 'Runner credential update is empty');
    check(project === Object.hasOwn(value, 'control_token'), 'Runner project identity and control credential are both required');
    if (machine) validateRunnerControlToken(value.machine_token);
    if (project) { projectId(value.project_id); validateRunnerControlToken(value.control_token); }
    return this.#update(expected_revision, data => {
      let node = data.nodes.find(item => item.node_id === value.node_id);
      check(!fresh || !node, 'Deployment cannot overwrite existing Runner credentials');
      if (!node) { node = { node_id: value.node_id, machine_token: null, projects: [] }; data.nodes.push(node); }
      if (machine) node.machine_token = value.machine_token;
      if (project) {
        const existing = node.projects.find(item => item.project_id === value.project_id);
        if (existing) existing.control_token = value.control_token;
        else node.projects.push({ project_id: value.project_id, control_token: value.control_token });
      }
    }, guard);
  }

  /** Delete exactly one project's control token, or all credentials for one explicitly selected node. */
  remove(value, expected_revision) {
    fields(value, ['node_id', 'project_id']); nodeId(value.node_id);
    const project = Object.hasOwn(value, 'project_id'); if (project) projectId(value.project_id);
    return this.#update(expected_revision, data => {
      if (!project) data.nodes = data.nodes.filter(node => node.node_id !== value.node_id);
      else {
        const node = data.nodes.find(item => item.node_id === value.node_id);
        if (node) {
          node.projects = node.projects.filter(item => item.project_id !== value.project_id);
          if (node.machine_token === null && !node.projects.length) data.nodes = data.nodes.filter(item => item !== node);
        }
      }
    });
  }

  #update(expected_revision, change, guard = null) {
    expectedRevision(expected_revision); guard?.();
    return withConfigurationWriteLock(this.#config, 'project', lock => {
      guard?.();
      const before = load(this.#config);
      check(before.data.revision === expected_revision, 'Runner credential revision changed; reload before saving');
      const data = structuredClone(before.data); change(data); data.revision = randomUUID();
      const next = normalize(data), source = JSON.stringify(next) + '\n';
      check(Buffer.byteLength(source) <= MAX_BYTES, 'Runner credential storage exceeds its limit');
      const file = path.join(this.#config.home, FILE), temporary = `${file}.${randomUUID()}.tmp`;
      let fd;
      try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, source); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        guard?.(); lock.assert();
        const current = load(this.#config);
        check(current.data.revision === expected_revision && current.fingerprint === before.fingerprint,
          'Runner credential storage changed before publication');
        fs.renameSync(temporary, file);
        const directory = fs.openSync(this.#config.home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        return view(next);
      } catch { throw new Error('Runner credential write not confirmed; inspect configured state before retrying'); }
      finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
    });
  }
}
