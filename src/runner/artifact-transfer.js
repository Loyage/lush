import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { check, fail, hash, stable, identifier, integer, OPERATIONS } from './protocol.js';
import { commandResourceCleanup, resourceRow } from './command-resources.js';

export const TRANSFER_LIMIT = 64 * 1024 * 1024;
export const TRANSFER_CHUNK = 64 * 1024;
const digest = value => check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'INVALID_REQUEST', 'Invalid artifact digest');
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });

/** Private, ID-addressed transfer files. Never a caller-supplied host path. */
export function createArtifactTransferService({ store, cleanup_controller } = {}) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS transfers (
    id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL,
    size INTEGER NOT NULL, digest TEXT, received INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS resource_cleanup (workspace_key TEXT PRIMARY KEY, request_id TEXT NOT NULL, state TEXT NOT NULL);`);
  const directory = path.join(store.root, 'transfers');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = identity(fs.lstatSync(directory, { bigint: true }));
  function rootCheck() {
    const stat = fs.lstatSync(directory, { bigint: true });
    check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(directory) === directory
      && String(stat.dev) === root.dev && String(stat.ino) === root.ino, 'STALE', 'Transfer directory changed');
  }
  function filename(id) { identifier(id, 'artifact_id'); rootCheck(); return path.join(directory, hash(id)); }
  function row(ctx, id) {
    identifier(id, 'artifact_id');
    const value = store.db.query('SELECT * FROM transfers WHERE id=?').get(id);
    check(value && value.workspace_key === ctx.workspace.workspace_key, 'NOT_FOUND', 'Artifact does not belong to workspace');
    return value;
  }
  function open(value) {
    const fd = fs.openSync(filename(value.id), fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || String(stat.dev) !== value.dev || String(stat.ino) !== value.ino) {
      fs.closeSync(fd); fail('STALE', 'Transfer file identity changed');
    }
    return fd;
  }
  function allocate(ctx, id, size, sha256, state) {
    identifier(id, 'artifact_id');
    check(!store.db.query('SELECT id FROM transfers WHERE id=?').get(id), 'CONFLICT', 'Artifact ID already exists');
    // Cap retained transfer files per workspace; no eviction of uncertain objects.
    const usage = store.db.query('SELECT COUNT(*) AS n,COALESCE(SUM(size),0) AS bytes FROM transfers WHERE workspace_key=?').get(ctx.workspace.workspace_key);
    check(usage.n < 32 && usage.bytes + size <= 2 * TRANSFER_LIMIT, 'LIMIT_EXCEEDED', 'Transfer retention budget exhausted');
    const fd = fs.openSync(filename(id), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const stat = identity(fs.fstatSync(fd, { bigint: true }));
      store.db.query('INSERT INTO transfers(id,workspace_key,dev,ino,size,digest,state) VALUES (?,?,?,?,?,?,?)')
        .run(id, ctx.workspace.workspace_key, stat.dev, stat.ino, size, sha256, state);
    } finally { fs.closeSync(fd); }
    return row(ctx, id);
  }
  function read(value) {
    const fd = open(value);
    try {
      const stat = fs.fstatSync(fd);
      check(stat.size === value.size && stat.size <= TRANSFER_LIMIT, 'STALE', 'Artifact size changed');
      const bytes = fs.readFileSync(fd);
      check(bytes.length === value.size && hash(bytes) === value.digest, 'STALE', 'Artifact digest changed');
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  function recheck(ctx) {
    ctx.node.authorize(ctx.request, OPERATIONS[ctx.request.method], ctx.session_id);
    if (ctx.capture_run_id !== undefined) {
      const workspace = store.workspace(ctx.identity), lease = store.lease({ ...ctx.identity, run_id: ctx.capture_run_id });
      check(workspace.last_run_id === ctx.capture_run_id && lease && !lease.revoked && lease.expires_at > Date.now(),
        'STALE', 'Captured Run lease no longer owns this workspace');
    }
    if (ctx.require_no_lease) check(!store.db.query('SELECT lease_id FROM leases WHERE workspace_key=? AND revoked=0 AND expires_at>?')
      .get(ctx.workspace.workspace_key, Date.now()), 'BUSY', 'Final workspace observation requires released invocation lease');
  }
  function validateArgv(ctx, argv) {
    const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
    const branch = value => typeof value === 'string' && /^lush\/[a-f0-9]{10}\/[A-Za-z0-9_-]+$/.test(value);
    const artifact = value => value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.artifact_id === 'string';
    const [name, ...args] = argv;
    const valid = name === 'symbolic-ref' && stableArgs(args, ['--short', 'HEAD'])
      || name === 'rev-parse' && stableArgs(args, ['--verify', 'HEAD'])
      || name === 'status' && (stableArgs(args, ['--porcelain=v1', '--untracked-files=all']) || stableArgs(args, ['--porcelain=v1', '--untracked-files=all', '--ignored']))
      || name === 'merge-base' && args.length === 3 && args[0] === '--is-ancestor' && args.slice(1).every(oid)
      || name === 'bundle' && (args.length === 2 && ['verify', 'list-heads'].includes(args[0]) && artifact(args[1])
        || args.length === 3 && args[0] === 'create' && artifact(args[1]) && args[2].startsWith('refs/heads/') && branch(args[2].slice(11)))
      || name === 'init' && args.length === 2 && args[0].startsWith('--initial-branch=') && branch(args[0].slice(17)) && ['--object-format=sha1', '--object-format=sha256'].includes(args[1])
      || name === 'fetch' && args.length === 4 && args[0] === '--no-tags' && args[1] === '--no-write-fetch-head' && artifact(args[2]) && oid(args[3])
      || name === 'checkout' && args.length === 3 && args[0] === '-b' && branch(args[1]) && oid(args[2])
      || name === 'merge' && args.length === 2 && args[0] === '--ff-only' && oid(args[1]);
    check(valid, 'INVALID_REQUEST', 'Git argv is outside the fixed workspace plan grammar');
    if (ctx.request.method !== 'workspace.git.apply') check(['symbolic-ref', 'rev-parse', 'status', 'merge-base', 'bundle'].includes(name), 'UNAUTHORIZED', 'Read/export plan cannot modify repository');
  }
  function stableArgs(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
  function repository(ctx) {
    const root = path.join(ctx.workspace.directory, '.git');
    check(fs.realpathSync(root) === root && fs.lstatSync(root).isDirectory(), 'STALE', 'Git directory ownership changed');
    let count = 0;
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        check(++count <= 100000, 'LIMIT_EXCEEDED', 'Git metadata traversal exceeds budget');
        check(!entry.isSymbolicLink(), 'STALE', 'Git metadata contains a symlink');
        if (entry.isDirectory()) visit(path.join(directory, entry.name));
        else check(entry.isFile(), 'STALE', 'Git metadata contains a special file');
      }
    };
    visit(root);
    // Runtime Git never executes repository-defined hooks, filters, alternates, or external helpers.
    const configFile = path.join(root, 'config');
    const fd = fs.openSync(configFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let config;
    try {
      check(fs.fstatSync(fd).size < 8192, 'LIMIT_EXCEEDED', 'Repository config exceeds budget');
      config = fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
    check(config.split('\n').every(line => !line.trim() || /^\s*\[(core|extensions)\]\s*$/.test(line)
      || /^\s*objectformat\s*=\s*sha256\s*$/i.test(line)
      || /^\s*(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)\s*=\s*(0|1|true|false)\s*$/i.test(line)),
    'UNAUTHORIZED', 'Repository config contains unsupported runtime Git behavior');
    check(!fs.existsSync(path.join(root, 'objects', 'info', 'alternates')), 'UNAUTHORIZED', 'Git alternate object stores are not supported');
  }
  async function git(ctx, argv) {
    check(Array.isArray(argv) && argv.length > 0 && argv.length <= 64, 'INVALID_REQUEST', 'Expected bounded Git argv');
    const allowed = ctx.request.method === 'workspace.git.apply'
      ? ['init', 'fetch', 'checkout', 'merge', 'rev-parse', 'symbolic-ref', 'status', 'merge-base', 'fsck', 'bundle']
      : ['rev-parse', 'symbolic-ref', 'status', 'merge-base', 'fsck', 'bundle'];
    check(allowed.includes(argv[0]), 'UNAUTHORIZED', 'Git command is not permitted');
    if (argv[0] === 'bundle') {
      check(['create', 'verify', 'list-heads'].includes(argv[1]), 'INVALID_REQUEST', 'Invalid bundle operation');
      check(typeof argv[2] === 'object', 'INVALID_REQUEST', 'Bundle requires a registered artifact');
      if (argv[1] === 'create') check(ctx.request.method === 'workspace.git.export', 'UNAUTHORIZED', 'Bundle export requires export authority');
    }
    if (argv[0] === 'fetch') check(typeof argv[3] === 'object', 'INVALID_REQUEST', 'Fetch requires a registered artifact');
    const resolved = argv.map(arg => {
      if (typeof arg === 'string') { check(arg.length < 2048 && !arg.includes('\0') && !path.isAbsolute(arg)
        && !arg.startsWith('--git-dir') && !arg.startsWith('--work-tree'), 'INVALID_REQUEST', 'Invalid Git argument'); return arg; }
      check(arg && Object.keys(arg).length === 1, 'INVALID_REQUEST', 'Invalid artifact argument');
      const value = row(ctx, arg.artifact_id);
      if (value.state === 'complete') read(value);
      else check(value.state === 'exporting' && argv[0] === 'bundle' && argv[1] === 'create', 'CONFLICT', 'Artifact is not complete');
      return filename(value.id);
    });
    recheck(ctx);
    if (argv[0] !== 'init') repository(ctx);
    const proc = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...resolved], {
      detached: true, cwd: ctx.workspace.directory, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_ALLOW_PROTOCOL: 'file', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', resolve); });
    const stop = () => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already exited */ } };
    let exceeded = false, timedout = false;
    const timer = setTimeout(() => { timedout = true; stop(); }, Math.max(1, Math.min(10000, ctx.git_deadline - Date.now())));
    const outputPath = argv[0] === 'bundle' && argv[1] === 'create' ? resolved[2] : null;
    const sizeTimer = outputPath ? setInterval(() => {
      for (const file of [outputPath, outputPath + '.lock']) {
        try { if (fs.lstatSync(file).size > TRANSFER_LIMIT) { exceeded = true; stop(); } } catch { /* not published */ }
      }
    }, 10) : null;
    async function bounded(stream) {
      const chunks = []; let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 1024 * 1024) { exceeded = true; stop(); }
        else chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString();
    }
    try {
      const [stdout, , code] = await Promise.all([bounded(proc.stdout), bounded(proc.stderr), exited]);
      check(!exceeded && !timedout, 'UNKNOWN', 'Git operation exceeded its execution/output budget');
      check(code === 0, 'UNKNOWN', 'Git operation failed; preserve workspace and reconcile request');
      recheck(ctx);
      return stdout.trim();
    } finally { clearTimeout(timer); clearInterval(sizeTimer); }
  }
  async function plan(ctx, params) {
    ctx.git_deadline = Math.min(Date.now() + 10000, ctx.authorization_expires_at);
    if (params.capture_run_id !== undefined) ctx.capture_run_id = integer(params.capture_run_id, 'capture_run_id');
    check(params.require_no_lease === undefined || typeof params.require_no_lease === 'boolean', 'INVALID_REQUEST', 'Invalid lease precondition');
    ctx.require_no_lease = params.require_no_lease === true;
    check(!(ctx.capture_run_id !== undefined && ctx.require_no_lease), 'INVALID_REQUEST', 'Conflicting lease preconditions');
    recheck(ctx);
    check(Array.isArray(params.steps) && params.steps.length > 0 && params.steps.length <= 16, 'INVALID_REQUEST', 'Expected bounded Git plan');
    for (const step of params.steps) {
      check(step && Array.isArray(step.argv) && step.argv.length <= 64 && step.argv.every(arg => typeof arg === 'string' || arg && typeof arg === 'object'), 'INVALID_REQUEST', 'Invalid Git step');
      validateArgv(ctx, step.argv);
    }
    if (ctx.request.method === 'workspace.cleanup') check(params.steps.length === 3 && params.steps[0].argv[0] === 'symbolic-ref'
      && params.steps[1].argv[0] === 'rev-parse' && /^[a-f0-9]{40,64}$/.test(params.steps[1].expect)
      && params.steps[2].argv[0] === 'status' && params.steps[2].argv.includes('--ignored') && params.steps[2].expect === '',
    'INVALID_REQUEST', 'Cleanup requires exact branch, HEAD and complete cleanliness assertions');
    if (params.empty) check(fs.readdirSync(ctx.workspace.directory).length === 0, 'CONFLICT', 'Workspace is not empty');
    // Output allocation is owned by the durable request before Git writes it.
    if (params.output_artifact) allocate(ctx, params.output_artifact, TRANSFER_LIMIT, null, 'exporting');
    const results = [];
    for (const step of params.steps) {
      const result = await git(ctx, step.argv);
      if (step.expect !== undefined) check(result === step.expect, 'STALE', 'Git precondition changed');
      results.push(result);
    }
    let artifact;
    if (params.output_artifact) {
      const before = row(ctx, params.output_artifact);
      const stat = fs.lstatSync(filename(before.id), { bigint: true });
      check(stat.isFile() && !stat.isSymbolicLink(), 'STALE', 'Export artifact is not a regular file');
      // Git bundle publishes by rename; only this locked request may replace its registered output.
      store.db.query('UPDATE transfers SET dev=?,ino=? WHERE id=?').run(String(stat.dev), String(stat.ino), before.id);
      const value = row(ctx, params.output_artifact), fd = open(value);
      try {
        const size = fs.fstatSync(fd).size;
        check(size > 0 && size <= TRANSFER_LIMIT, 'LIMIT_EXCEEDED', 'Bundle exceeds transfer budget');
        const sha256 = hash(fs.readFileSync(fd)); fs.fsyncSync(fd);
        store.db.query("UPDATE transfers SET size=?,received=?,digest=?,state='complete' WHERE id=?").run(size, size, sha256, value.id);
        artifact = { artifact_id: value.id, size, sha256 };
      } finally { fs.closeSync(fd); }
    }
    return { results, ...(artifact ? { artifact } : {}) };
  }
  const services = {
    'artifact.upload': (ctx, params) => {
      digest(params.sha256); integer(params.size, 'size', 1, TRANSFER_LIMIT); integer(params.offset, 'offset', 0, params.size);
      check(typeof params.data === 'string' && params.data.length <= 4 * Math.ceil(TRANSFER_CHUNK / 3), 'LIMIT_EXCEEDED', 'Artifact chunk exceeds budget');
      const bytes = Buffer.from(params.data, 'base64');
      check(bytes.toString('base64') === params.data && bytes.length > 0 && bytes.length <= TRANSFER_CHUNK, 'INVALID_REQUEST', 'Invalid artifact chunk');
      let value = store.db.query('SELECT * FROM transfers WHERE id=?').get(params.artifact_id);
      if (!value) { check(params.offset === 0, 'CONFLICT', 'Missing initial upload'); value = allocate(ctx, params.artifact_id, params.size, params.sha256, 'uploading'); }
      value = row(ctx, params.artifact_id);
      check(value.state === 'uploading' && value.digest === params.sha256 && value.size === params.size && value.received === params.offset
        && params.offset + bytes.length <= value.size, 'CONFLICT', 'Upload offset or identity changed');
      const fd = open(value);
      try {
        recheck(ctx);
        check(fs.fstatSync(fd).size === value.received, 'STALE', 'Upload file changed');
        let written = 0;
        while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written, value.received + written);
        fs.fsyncSync(fd);
        const received = value.received + bytes.length;
        if (received === value.size) check(hash(fs.readFileSync(fd)) === value.digest, 'STALE', 'Uploaded digest mismatch');
        store.db.query('UPDATE transfers SET received=?,state=? WHERE id=?').run(received, received === value.size ? 'complete' : 'uploading', value.id);
        return { artifact_id: value.id, received, complete: received === value.size };
      } finally { fs.closeSync(fd); }
    },
    'artifact.download': (ctx, params) => {
      check(params.path === undefined, 'INVALID_REQUEST', 'Artifacts use IDs, never host paths');
      const value = row(ctx, params.artifact_id); digest(params.expected_sha256);
      check(value.state === 'complete' && value.digest === params.expected_sha256, 'STALE', 'Artifact is not complete or changed');
      const offset = integer(params.offset ?? 0, 'offset', 0, value.size), bytes = read(value);
      const next_offset = Math.min(value.size, offset + TRANSFER_CHUNK);
      return { artifact_id: value.id, sha256: value.digest, size: value.size, offset, next_offset,
        data: bytes.subarray(offset, next_offset).toString('base64'), complete: next_offset === value.size };
    },
    'workspace.git.apply': plan,
    'workspace.git.inspect': plan,
    'workspace.git.export': plan,
    'workspace.cleanup': async (ctx, params) => {
      await plan(ctx, params);
      const active = store.db.query('SELECT execution_id FROM executions WHERE workspace_key=? AND stop_confirmed=0').get(ctx.workspace.workspace_key);
      check(!active, 'BUSY', 'Workspace still has unconfirmed executions');
      const executions = store.db.query('SELECT * FROM executions WHERE workspace_key=? ORDER BY created_at,execution_id').all(ctx.workspace.workspace_key);
      // Historical homes remain unowned. New resources have durable per-item creation/removal receipts.
      const legacy = executions.filter(execution => JSON.parse(execution.spec_json).resources_version !== 1 || !resourceRow(store, execution.execution_id));
      if (legacy.length) return { removed: false, partial: true, reason: 'command_resource_identity_unrecorded', retained_executions: legacy.length };
      const removeCommands = commandResourceCleanup(store, executions, ctx.config,
        { ...(cleanup_controller ? { controller: cleanup_controller } : {}), guard: () => recheck(ctx) });
      const artifacts = store.db.query('SELECT * FROM transfers WHERE workspace_key=?').all(ctx.workspace.workspace_key);
      for (const value of artifacts) { const fd = open(value); fs.closeSync(fd); }
      recheck(ctx);
      store.db.query('INSERT OR REPLACE INTO resource_cleanup VALUES (?,?,?)').run(ctx.workspace.workspace_key, ctx.request_id, 'removing');
      removeCommands();
      for (const value of artifacts) {
        const fd = open(value); fs.closeSync(fd); fs.unlinkSync(filename(value.id));
        store.db.query('DELETE FROM transfers WHERE id=?').run(value.id);
      }
      // Preserve registration and its directory inode as a tombstone; remove only its owned contents.
      for (const name of fs.readdirSync(ctx.workspace.directory)) fs.rmSync(path.join(ctx.workspace.directory, name), { recursive: true });
      store.db.query("UPDATE workspaces SET state='removed' WHERE workspace_key=?").run(ctx.workspace.workspace_key);
      store.db.query("UPDATE resource_cleanup SET state='removed' WHERE workspace_key=?").run(ctx.workspace.workspace_key);
      return { removed: true, partial: false, tombstone: true };
    },
  };
  return Object.fromEntries(Object.entries(services).map(([method, handler]) => [method, async (ctx, params) => ({
    ...await handler(ctx, params), request_fingerprint: hash(stable({ method, identity: ctx.identity, params })),
  })]));
}
