import fs from 'node:fs';
import path from 'node:path';
import { check, OPERATIONS } from './protocol.js';
import { createCodeReader } from '../core/workspaces/code.js';
import { CodeReadError, LIMITS, options, openIsolatedCode, fileHandle, signature } from '../core/workspaces/code-io.js';

const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const method = Object.freeze({ state: 'codeState', tree: 'codeTree', file: 'codeFile' });

// Never ask Git to load the repository's config to discover HEAD or its object directory.
// Only the registered standalone repository is supported (no .git file/common-dir/alternates).
function metadata(ctx, deadline) {
  const root = path.join(ctx.workspace.directory, '.git');
  const stat = fs.lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root)
    throw new CodeReadError('远端仓库目录身份已变化', 'stale');
  let count = 0;
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++count > 100000 || Date.now() >= deadline) throw new CodeReadError('远端 Git 元数据超过读取预算上限');
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new CodeReadError('远端 Git 元数据含不安全链接或特殊文件');
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  };
  visit(root);
  for (const name of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates', 'info/grafts'])
    if (fs.existsSync(path.join(root, name))) throw new CodeReadError('远端仓库包含外部对象来源或不支持的历史覆盖');
  return { root, identity: `${stat.dev}:${stat.ino}` };
}
function text(root, name, max = 4096) {
  const handle = fileHandle(root, name, true);
  try {
    if (!handle.stat) return null;
    if (!handle.stat.isFile() || handle.stat.size > BigInt(max)) throw new CodeReadError('远端 Git 元数据类型或大小不可读取');
    const bytes = Buffer.alloc(Number(handle.stat.size));
    const length = fs.readSync(handle.fd, bytes, 0, bytes.length, 0);
    if (length !== bytes.length || signature(fs.fstatSync(handle.fd, { bigint: true })) !== signature(handle.stat))
      throw new CodeReadError('远端 Git 元数据在读取期间变化', 'stale');
    return bytes.toString('utf8');
  } finally { handle.close(); }
}
function head(ctx, branch) {
  const ref = `refs/heads/${branch}`, root = ctx.workspace.directory;
  if (text(root, '.git/HEAD')?.trim() !== `ref: ${ref}`) throw new CodeReadError('远端 Worker 分支身份已变化', 'stale');
  let value = text(root, `.git/${ref}`)?.trim();
  if (!value) {
    const packed = text(root, '.git/packed-refs', LIMITS.output) ?? '';
    value = packed.split('\n').find(line => line.slice(line.indexOf(' ') + 1) === ref)?.split(' ')[0];
  }
  if (!oid(value)) throw new CodeReadError('远端 Worker 没有可读取的固定 HEAD');
  return value;
}
async function open(_owner, descriptor, scope) {
  const { context: ctx, branch, expected_commit } = descriptor;
  const deadline = Date.now() + LIMITS.timeout;
  const recheck = () => ctx.node.authorize(ctx.request, OPERATIONS[ctx.request.method], ctx.session_id);
  recheck();
  const repo = metadata(ctx, deadline), current = head(ctx, branch);
  const base = scope === 'working' ? current : scope === 'iteration'
    ? descriptor.iteration_base_commit ?? descriptor.base_commit : descriptor.base_commit;
  const io = await openIsolatedCode({ config: { env: { PATH: '/usr/bin:/bin' } }, common: repo.root,
    format: expected_commit.length === 64 ? 'sha256' : 'sha1', source: 'workspace', workspace: ctx.workspace.directory,
    index: path.join(repo.root, 'index'), head: current, base, deadline,
    async verify() {
      recheck();
      if (metadata(ctx, deadline).identity !== repo.identity || head(ctx, branch) !== current)
        throw new CodeReadError('远端代码在读取期间变化，请加载最新版本', 'stale');
    } });
  try {
    // The control plane fixes the accepted Worker tip; a local ahead commit is readable only
    // on its lineage. An arbitrary object in a shared/modified object store is not a baseline.
    for (const ancestor of new Set([expected_commit, io.base].filter(Boolean)))
      await io.git(['merge-base', '--is-ancestor', ancestor, current]);
    await io.verify();
    return io;
  } catch (error) { io.close(); throw error; }
}

/** Pure read model + registered node context; no central Worker DB or shell/Git plan endpoint. */
export function createCodeService() {
  const reader = createCodeReader(open);
  return { 'workspace.code.read': async (ctx, params) => {
    check(Object.keys(params).every(key => ['kind', 'branch', 'base_commit', 'iteration_base_commit', 'expected_commit', 'options'].includes(key)),
      'INVALID_REQUEST', 'Unknown code read parameter');
    check(Object.hasOwn(method, params.kind), 'INVALID_REQUEST', 'Invalid code read kind');
    check(typeof params.branch === 'string' && /^lush\/[a-f0-9]{10}\/[A-Za-z0-9_-]+$/.test(params.branch), 'INVALID_REQUEST', 'Invalid Worker branch');
    check(oid(params.expected_commit) && (params.base_commit === null || oid(params.base_commit))
      && (params.iteration_base_commit == null || oid(params.iteration_base_commit)), 'INVALID_REQUEST', 'Invalid fixed code baseline');
    check(params.options && typeof params.options === 'object' && !Array.isArray(params.options), 'INVALID_REQUEST', 'Invalid code options');
    check(Object.keys(params.options).every(key => ['scope', 'path', 'query', 'changed', 'after', 'limit', 'offset', 'context', 'revision', 'view', 'side'].includes(key)),
      'INVALID_REQUEST', 'Unknown code option');
    // Validate before entering the model; bad paths/options remain request errors, not an empty tree.
    try { options(params.options, params.kind === 'file'); }
    catch { check(false, 'INVALID_REQUEST', 'Invalid code path or pagination option'); }
    const descriptor = { id: ctx.identity.worker_id, branch: params.branch, base_commit: params.base_commit,
      iteration_base_commit: params.iteration_base_commit, expected_commit: params.expected_commit, context: ctx };
    let result;
    try { result = await reader[method[params.kind]](descriptor, params.options); }
    catch (error) {
      if (error.message === 'file is not in the readable project file set')
        check(false, 'INVALID_REQUEST', 'file is not in the readable project file set');
      throw error;
    }
    // A command admitted during the non-atomic sample invalidates it, never waits indefinitely.
    ctx.node.authorize(ctx.request, OPERATIONS[ctx.request.method], ctx.session_id);
    return result;
  } };
}
