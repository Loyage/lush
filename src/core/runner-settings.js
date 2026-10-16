import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { check, isPlainObject } from './types.js';
import { validateConfigurationDirectory, withConfigurationWriteLock } from './device-config.js';

const MAX_BYTES = 128 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function fields(value, keys, label) {
  check(isPlainObject(value) && Object.keys(value).every(key => keys.includes(key)), `invalid ${label} fields`);
}
function integer(value, max, label) {
  check(Number.isSafeInteger(value) && value > 0 && value <= max, `invalid Runner ${label}`);
  return value;
}

/** Only an SSH config alias, never user@host, a path, option, expansion or remote command. */
export function normalizeRunnerNode(value) {
  fields(value, ['id', 'name', 'ssh_alias', 'expected_runner_id', 'enabled', 'budgets'], 'Runner node');
  check(value.id === undefined || typeof value.id === 'string' && UUID.test(value.id), 'invalid Runner node id; local is reserved');
  check(typeof value.name === 'string' && value.name.trim() === value.name && value.name.length > 0
    && value.name.length <= 80 && !/[\x00-\x1f\x7f\u2028\u2029]/u.test(value.name), 'invalid Runner name');
  check(typeof value.ssh_alias === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.ssh_alias), 'invalid Runner SSH alias');
  const expected_runner_id = value.expected_runner_id ?? null;
  check(expected_runner_id === null || typeof expected_runner_id === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(expected_runner_id), 'invalid Runner installation identity');
  check(typeof value.enabled === 'boolean', 'Runner enabled must be boolean');
  fields(value.budgets, ['max_commands', 'timeout_ms', 'output_bytes'], 'Runner budgets');
  return { ...(value.id === undefined ? {} : { id: value.id }), name: value.name, ssh_alias: value.ssh_alias,
    expected_runner_id, enabled: value.enabled, budgets: {
      max_commands: integer(value.budgets.max_commands, 64, 'command limit'),
      timeout_ms: integer(value.budgets.timeout_ms, 86400000, 'timeout'),
      output_bytes: integer(value.budgets.output_bytes, 64 * 1024 * 1024, 'output limit'),
    } };
}

function rootConfig(config) {
  // A project must name its real device root. A Host/fixture may already be rooted there.
  const home = config?.deviceHome ?? (!config?.project ? config?.home : null);
  check(typeof home === 'string' && path.isAbsolute(home), 'Runner device configuration directory is unavailable');
  return { home: path.resolve(home) };
}
const empty = () => ({ version: 1, sequence: 0, nodes: [], retired_ids: [] });
function document(value) {
  fields(value, ['version', 'sequence', 'nodes', 'retired_ids'], 'Runner settings');
  check(Number.isSafeInteger(value.sequence) && value.sequence >= 0, 'invalid Runner settings sequence');
  check(value.version === 1 && Array.isArray(value.nodes) && value.nodes.length <= 64
    && Array.isArray(value.retired_ids) && value.retired_ids.length <= 4096, 'invalid Runner settings');
  const nodes = value.nodes.map(normalizeRunnerNode), ids = nodes.map(node => node.id);
  check(ids.every(id => typeof id === 'string') && new Set(ids).size === ids.length, 'invalid or duplicate Runner node ids');
  check(value.retired_ids.every(id => typeof id === 'string' && UUID.test(id) && !ids.includes(id))
    && new Set(value.retired_ids).size === value.retired_ids.length, 'invalid retired Runner ids');
  return { version: 1, sequence: value.sequence, nodes, retired_ids: [...value.retired_ids] };
}
function load(config) {
  if (!validateConfigurationDirectory(config)) return empty();
  const file = path.join(config.home, 'runners.json'), root = fs.lstatSync(config.home);
  let fd;
  try {
    let published;
    try { published = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
    check(!published.isSymbolicLink(), 'unsafe Runner settings');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600 && stat.nlink === 1
      && stat.size <= MAX_BYTES && same(stat, published), 'unsafe Runner settings');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytes = 0, count;
    while (bytes < buffer.length && (count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null)) > 0) bytes += count;
    const after = fs.fstatSync(fd);
    check(bytes <= MAX_BYTES && bytes === stat.size && same(stat, after) && stat.size === after.size
      && stat.mtimeMs === after.mtimeMs && stat.ctimeMs === after.ctimeMs && same(stat, fs.lstatSync(file))
      && same(root, fs.lstatSync(config.home)), 'Runner settings changed while reading');
    validateConfigurationDirectory(config, 'project', true);
    return document(JSON.parse(buffer.subarray(0, bytes).toString('utf8')));
  } catch { throw new Error('Runner settings cannot be safely read'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
const revision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const view = value => ({ version: 1, revision: revision(value), nodes: structuredClone(value.nodes) });

/** Device-private data only: no discovery, SSH, installation, project mutations or model credentials. */
export class RunnerSettings {
  constructor(config) { this.config = rootConfig(config); }
  get home() { return this.config.home; }
  read() { return view(load(this.config)); }

  /** Complete replacement. Omit id only for new nodes; deleted identities can never be resurrected. */
  save(value, expected_revision) { return this.#save(value, expected_revision); }

  /** Trusted deployment journal only: pre-recorded fresh ID, disabled and unpinned.
   * Public replacement still cannot choose new IDs. Never adopt an existing/retired ID or alias.
   */
  registerDeployment(value, expected_revision, guard) {
    fields(value, ['id', 'name', 'ssh_alias', 'budgets'], 'deployment node');
    check(typeof value.id === 'string' && UUID.test(value.id) && typeof guard === 'function', 'Deployment node identity and guard are required');
    const assert = () => check(!guard()?.then, 'Deployment node guard must be synchronous');
    assert();
    const before = this.read();
    check(before.revision === expected_revision, 'Runner settings revision changed; reload before saving');
    check(!before.nodes.some(node => node.id === value.id || node.ssh_alias === value.ssh_alias), 'Deployment cannot adopt an existing Runner node or SSH alias');
    const node = normalizeRunnerNode({ ...value, enabled: false, expected_runner_id: null });
    return this.#save({ nodes: [...before.nodes, node] }, expected_revision, { new_id: node.id, guard: assert });
  }

  /** Trusted confirmation journal only. Never adopts/re-enables an already changed node. */
  pinDeployment({ node_id, runner_id, expected_node }, expected_revision, guard) {
    check(typeof guard === 'function' && typeof runner_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(runner_id), 'Deployment pin guard and installation identity are required');
    const expected = normalizeRunnerNode(expected_node);
    check(expected.id === node_id && expected.enabled === false && expected.expected_runner_id === null, 'Deployment pin must reference its original disabled node');
    const assert = () => check(!guard()?.then, 'Deployment pin guard must be synchronous');
    assert(); const before = this.read();
    check(before.revision === expected_revision, 'Runner settings revision changed; reload before saving');
    const current = before.nodes.find(node => node.id === node_id);
    check(current && current.ssh_alias === expected.ssh_alias && current.enabled === false && current.expected_runner_id === null
      && JSON.stringify(current.budgets) === JSON.stringify(expected.budgets), 'Deployment node changed before pinning');
    return this.#save({ nodes: before.nodes.map(node => node.id === node_id ? { ...node, enabled: true, expected_runner_id: runner_id } : node) }, expected_revision, { guard: assert });
  }

  #save(value, expected_revision, { new_id = null, guard = null } = {}) {
    fields(value, ['nodes'], 'Runner settings update');
    check(Array.isArray(value.nodes) && value.nodes.length <= 64, 'Runner settings require at most 64 nodes');
    const nodes = value.nodes.map(normalizeRunnerNode);
    check(typeof expected_revision === 'string' && /^[0-9a-f]{64}$/.test(expected_revision), 'Runner revision is required');
    return withConfigurationWriteLock(this.config, 'project', lock => {
      guard?.();
      const before = load(this.config);
      check(revision(before) === expected_revision, 'Runner settings revision changed; reload before saving');
      const currentIds = new Set(before.nodes.map(node => node.id));
      const used = new Set([...currentIds, ...before.retired_ids]);
      const next = nodes.map(node => {
        if (node.id !== undefined) {
          if (node.id === new_id) {
            check(!used.has(node.id) && !before.nodes.some(current => current.ssh_alias === node.ssh_alias)
              && node.enabled === false && node.expected_runner_id === null, 'Deployment node identity is not fresh');
            used.add(node.id); return node;
          }
          check(currentIds.has(node.id), 'unknown or retired Runner id; omit id for a new node');
          const original = before.nodes.find(current => current.id === node.id);
          check(original.ssh_alias === node.ssh_alias,
            'Runner SSH alias is fixed for a node identity; create a new node instead');
          check(original.expected_runner_id === null || original.expected_runner_id === node.expected_runner_id,
            'Runner installation identity is pinned; create a new node instead');
          return node;
        }
        let id; do { id = randomUUID(); } while (used.has(id));
        used.add(id); return { id, ...node };
      });
      const retained = new Set(next.map(node => node.id));
      const data = document({ version: 1, sequence: before.sequence + 1, nodes: next,
        retired_ids: [...before.retired_ids, ...currentIds].filter(id => !retained.has(id)) });
      const source = JSON.stringify(data, null, 2) + '\n';
      check(Buffer.byteLength(source) <= MAX_BYTES, 'Runner settings exceed storage limit');
      const file = path.join(this.home, 'runners.json'), temporary = `${file}.${randomUUID()}.tmp`;
      let fd;
      try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, source); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        guard?.(); lock.assert(); check(revision(load(this.config)) === expected_revision, 'Runner settings changed before publication');
        fs.renameSync(temporary, file);
        const directory = fs.openSync(this.home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        return view(data);
      } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
    });
  }
}
