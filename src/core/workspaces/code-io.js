import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { check } from '../types.js';
import { posixFiles } from './code-posix.js';

export const LIMITS = { output: 4 * 1024 * 1024, files: 20000, blob: 8 * 1024 * 1024, patch: 512 * 1024,
  response: 512 * 1024, timeout: 15000 };
export const hash = value => createHash('sha256').update(value).digest('hex');
// Case-fold reserved components too: macOS commonly uses a case-insensitive volume.
export const internal = value => value.split('/').some(part => ['.git', '.lush'].includes(part.toLowerCase()));
export const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export class CodeReadError extends Error {
  constructor(message, type = 'unavailable') { super(message); this.type = type; }
}
export function relativePath(value, root = false) {
  check(typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && (path.sep === '/' || !value.includes('\\'))
    && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/.test(value)
    && (root && value === '' || value.split('/').every(part => part && part !== '.' && part !== '..'))
    && !internal(value), 'invalid project-relative code path');
  return value;
}
export function integer(value, fallback, min, max, label) {
  const n = value === undefined ? fallback : Number(value);
  check(Number.isSafeInteger(n) && n >= min && n <= max, `invalid ${label}`); return n;
}
export function options(raw = {}, file = false) {
  const scope = raw.scope ?? 'task'; check(['task', 'iteration', 'working'].includes(scope), 'invalid code scope');
  const view = raw.view ?? 'diff', side = raw.side ?? 'new';
  check(['diff', 'content'].includes(view) && ['old', 'new'].includes(side), 'invalid code file view');
  check(raw.revision === undefined || typeof raw.revision === 'string' && /^[a-f0-9]{64}$/.test(raw.revision), 'invalid code revision');
  check(raw.query === undefined || typeof raw.query === 'string' && raw.query.length <= 500, 'invalid code query');
  check(raw.changed === undefined || typeof raw.changed === 'boolean', 'invalid changed filter');
  return { scope, path: relativePath(raw.path ?? '', !file), query: raw.query ?? '', changed: raw.changed ?? false,
    after: integer(raw.after, 0, 0, Number.MAX_SAFE_INTEGER, 'code cursor'),
    limit: integer(raw.limit, file ? view === 'content' ? 24000 : 20 : 100, 1, file ? view === 'content' ? 24000 : 100 : 200, 'code limit'),
    offset: integer(raw.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'code offset'),
    context: integer(raw.context, 3, 0, 100, 'diff context'), revision: raw.revision, view, side };
}

// Strip Git process-level overrides: no injected config, alternate index, object stores, hooks or pager.
function environment(config) {
  return { ...Object.fromEntries(Object.entries(config.env || process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_PAGER: 'cat', LC_ALL: 'C' };
}

/** Bounded pipes are consumed concurrently; timeout/overflow kills and reaps the child. */
export async function runGit(config, cwd, args, { env = {}, deadline = Date.now() + LIMITS.timeout, max = LIMITS.output, codes = [0] } = {}) {
  if (Date.now() >= deadline) throw new CodeReadError('代码读取超时，请重试');
  const proc = Bun.spawn(['git', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + os.devNull,
    '-c', 'core.attributesFile=' + os.devNull, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-C', cwd, ...args],
  { env: { ...environment(config), ...env }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  let failure;
  const stop = error => { failure ??= error; try { proc.kill('SIGKILL'); } catch {} };
  const timer = setTimeout(() => stop(new CodeReadError('代码读取超时，请重试')), Math.max(1, deadline - Date.now()));
  const consume = async (stream, cap) => {
    const reader = stream.getReader(), chunks = []; let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.length;
        if (total > cap) { stop(new CodeReadError('代码读取超过安全大小上限；请缩小范围')); continue; }
        if (!failure) chunks.push(value);
      }
    } catch { stop(new CodeReadError('代码读取中断，请重试')); }
    return Buffer.concat(chunks);
  };
  try {
    const [out, , exit] = await Promise.all([consume(proc.stdout, max), consume(proc.stderr, 16000), proc.exited]);
    if (failure) throw failure;
    if (!codes.includes(exit)) throw new CodeReadError('Git 对象或工作区读取失败，可能已被清理');
    return out;
  } finally { clearTimeout(timer); }
}

/** A sterile temporary Git directory prevents repository-defined filters from running.
 * No repository config is loaded by status/diff, even if it changes during a read. */
export async function isolatedGit(workspaces, task, scope) {
  const { config } = workspaces, deadline = Date.now() + LIMITS.timeout;
  const identity = (cwd, ...args) => runGit(config, cwd, args, { deadline }).then(buffer => buffer.toString('utf8').trim());
  const project = fs.realpathSync(config.project);
  const common = fs.realpathSync(await identity(project, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const format = await identity(project, 'rev-parse', '--show-object-format');
  if (!['sha1', 'sha256'].includes(format)) throw new CodeReadError('不支持的 Git 对象格式');
  let source = 'commit', workspace = null, workspaceIdentity = null, index = null, head = task.head_commit;
  if (task.workspace && fs.existsSync(task.workspace)) {
    workspace = fs.realpathSync(task.workspace);
    // No canonical fallback; only an explicitly recorded, separately registered worktree.
    if (workspace === project || workspace !== path.resolve(task.workspace)) throw new CodeReadError('该 Task 没有可安全读取的专属工作区');
    const list = (await runGit(config, project, ['worktree', 'list', '--porcelain', '-z'], { deadline })).toString('utf8');
    const records = list.split('\0\0').map(block => block.split('\0'));
    const record = records.find(fields => fields.includes(`worktree ${workspace}`));
    if (!record || task.branch && !record.includes(`branch refs/heads/${task.branch}`)) throw new CodeReadError('任务工作区身份已变化，请刷新后重试', 'stale');
    if (fs.realpathSync(await identity(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== common
      || await identity(workspace, 'rev-parse', '--show-toplevel') !== workspace) throw new CodeReadError('任务工作区不属于此项目');
    const stat = fs.statSync(workspace, { bigint: true }); workspaceIdentity = `${stat.dev}:${stat.ino}`;
    head = await identity(workspace, 'rev-parse', '--verify', 'HEAD');
    index = path.join(await identity(workspace, 'rev-parse', '--absolute-git-dir'), 'index');
    source = 'workspace';
  }
  if (!head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new CodeReadError('没有可读取的任务现场或原始提交');
  if (source === 'commit' && scope === 'working') throw new CodeReadError('工作区已不可用，不能还原未提交内容');
  let base = scope === 'working' ? head : scope === 'iteration' ? task.iteration_base_commit ?? task.base_commit : task.base_commit;
  if (base && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) base = null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-code-'));
  fs.chmodSync(root, 0o700);
  try {
    const gitDir = path.join(root, 'git'); fs.mkdirSync(gitDir); fs.mkdirSync(path.join(gitDir, 'objects')); fs.mkdirSync(path.join(gitDir, 'refs'));
    fs.writeFileSync(path.join(gitDir, 'HEAD'), `${head}\n`);
    fs.writeFileSync(path.join(gitDir, 'config'), `[core]\nrepositoryformatversion = ${format === 'sha256' ? 1 : 0}\nbare = false\n${format === 'sha256' ? '[extensions]\nobjectformat = sha256\n' : ''}`);
    const env = { GIT_DIR: gitDir, GIT_OBJECT_DIRECTORY: path.join(common, 'objects'),
      ...(workspace ? { GIT_WORK_TREE: workspace, GIT_INDEX_FILE: index } : {}) };
    const git = (args, opts = {}) => runGit(config, workspace || root, args, { env, deadline, ...opts });
    await git(['cat-file', '-e', `${head}^{commit}`]);
    let baselineMissing = false;
    if (base) { try { await git(['cat-file', '-e', `${base}^{commit}`]); } catch { base = null; baselineMissing = true; } }
    return { root, git, workspace, index, source, head, base, deadline, format, baselineMissing,
      async verify() {
        if (!workspace) return;
        const stat = fs.existsSync(workspace) ? fs.statSync(workspace, { bigint: true }) : null;
        if (!stat || `${stat.dev}:${stat.ino}` !== workspaceIdentity || fs.realpathSync(workspace) !== workspace
          || fs.realpathSync(await identity(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== common
          || await identity(workspace, 'rev-parse', '--verify', 'HEAD') !== head
          || task.branch && await identity(workspace, 'symbolic-ref', '--quiet', 'HEAD') !== `refs/heads/${task.branch}`) {
          throw new CodeReadError('工作区在读取期间发生变化，请加载最新版本', 'stale');
        }
      },
      close() { fs.rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}

export const signature = stat => stat ? stat.linkSignature ?? [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':') : 'missing';
export const kindOfMode = mode => mode === '120000' ? 'symlink' : mode === '160000' ? 'submodule' : mode === '040000' ? 'directory' : 'file';

/** Descriptor-relative traversal on Linux and macOS; every component uses O_NOFOLLOW.
 * Link metadata describes the link text itself, never the inode/content of its target. */
export function fileHandle(root, name, read = false) {
  const fds = new Set();
  const closeOne = fd => { fds.delete(fd); fs.closeSync(fd); };
  const close = () => { for (const fd of fds) try { fs.closeSync(fd); } catch {} fds.clear(); };
  try {
    let parent = posixFiles.openDirectory(root); fds.add(parent);
    const parts = name.split('/');
    for (const component of parts.slice(0, -1)) {
      const next = posixFiles.openAt(parent, component, true); fds.add(next); closeOne(parent); parent = next;
    }
    let fd;
    try { fd = posixFiles.openAt(parent, parts.at(-1)); }
    catch (error) {
      if (error.code !== 'ELOOP') throw error;
      const link = posixFiles.readLinkAt(parent, parts.at(-1));
      // Avoid a platform-specific native struct-stat layout just to show a link.
      // readlinkat returns only link text and cannot follow its target, even if the
      // entry is swapped concurrently; the subsequent sample checks this signature.
      const stat = { mode: 0o120000n, size: BigInt(Buffer.byteLength(link)), linkSignature: `link:${hash(link)}`,
        isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
      close(); return { stat, link, close() {} };
    }
    fds.add(fd); closeOne(parent);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!read || !stat.isFile()) { close(); return { stat, link: null, close() {} }; }
    return { fd, stat, close };
  } catch (error) {
    close();
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { stat: null, close() {} };
    if (error.code === 'ELOOP') throw new CodeReadError('路径包含符号链接，不能进入其目标');
    if (error.code === 'ESTALE') throw new CodeReadError('工作区目录身份变化', 'stale');
    if (error.code === 'ENOSYS') throw new CodeReadError('无法加载系统安全文件描述符接口；现场读取不可用');
    throw error;
  }
}

export function readWorkspace(root, name) {
  const handle = fileHandle(root, name, true);
  try {
    const { stat } = handle;
    if (!stat) return { exists: false, kind: 'file', size: 0, mode: null, buffer: Buffer.alloc(0), signature: 'missing' };
    const mode = stat.isSymbolicLink() ? '120000' : stat.isDirectory() ? '040000' : (stat.mode & 0o111n) ? '100755' : '100644';
    const kind = kindOfMode(mode), result = { exists: true, kind, size: stat.isDirectory() ? null : Number(stat.size), mode, signature: signature(stat) };
    if (kind !== 'file') return { ...result, buffer: Buffer.from(handle.link ?? ''), note: kind === 'symlink' ? '符号链接仅显示链接文本，不跟随目标' : '子模块或目录仅显示元信息' };
    if (!stat.isFile()) throw new CodeReadError('不支持读取此文件类型');
    if (stat.size > BigInt(LIMITS.blob)) return { ...result, buffer: null, note: '文件超过 8 MiB 安全读取上限' };
    const buffer = Buffer.alloc(Number(stat.size)); let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(handle.fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count;
    }
    if (offset !== buffer.length || signature(fs.fstatSync(handle.fd, { bigint: true })) !== signature(stat)) throw new CodeReadError('文件在读取期间发生变化，请加载最新版本', 'stale');
    return { ...result, buffer };
  } finally { handle.close(); }
}
