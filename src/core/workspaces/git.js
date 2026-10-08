import { check, LushError } from '../types.js';

// These commands can write the checkout's branch. Object creation (commit-tree),
// snapshots, and writes to other refs must not excuse movement of a watched branch.
const HEAD_WRITE_COMMANDS = new Set(['commit', 'merge', 'reset', 'rebase', 'cherry-pick', 'revert', 'am', 'pull']);
/** 跳过 `-c name=value`、`--git-dir` 这类前置选项，找真正被调用的子命令。 */
function gitSubcommand(args) {
  for (let i = 0; i < args.length; i++) {
    if (['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(args[i])) { i++; continue; }
    if (typeof args[i] !== 'string' || args[i].startsWith('-')) continue;
    return { name: args[i], index: i };
  }
  return null;
}

async function writtenRef(workspaces, cwd, args) {
  const command = gitSubcommand(args);
  if (HEAD_WRITE_COMMANDS.has(command?.name)) {
    return workspaces.git(cwd, 'symbolic-ref', '--quiet', 'HEAD').catch(() => null);
  }
  if (command?.name !== 'update-ref') return null;
  for (let i = command.index + 1; i < args.length; i++) {
    if (args[i] === '-m') { i++; continue; }
    if (args[i] === '--stdin') return null; // Custom transactions carry explicit exact receipts.
    if (args[i].startsWith('-')) continue;
    return args[i] === 'HEAD'
      ? workspaces.git(cwd, 'symbolic-ref', '--quiet', 'HEAD').catch(() => null) : args[i];
  }
  return null;
}

/** porcelain 明细可能很长（含未跟踪文件）：报错和事件里都要有界，但不能省掉「哪些文件」。 */
export function dirtDetail(status, limit = 20) {
  const lines = status.split('\n').filter(Boolean);
  return { files: lines.length, sample: lines.slice(0, limit), more: Math.max(0, lines.length - limit) };
}

/** Git 原语与串行队列（无 shell 插值）。 */
export const methods = {
  exclusive(fn) {
    this.pending = (this.pending ?? 0) + 1;
    const next = this.queue.then(fn);
    // Observe settlement without replacing next or changing queue/awaiter timing.
    const settled = () => { this.pending -= 1; };
    next.then(settled, settled);
    this.queue = next.catch(() => {});
    return next;
  },
  async git(cwd, ...args) {
    return (await this.gitOutput(cwd, ...args)).trim();
  },
  /** 需要保留行内空白时用它：porcelain 的首行状态位就是一个前导空格（" M path"）。 */
  async gitOutput(cwd, ...args) {
    const execute = async () => {
      const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...this.config.env, GIT_TERMINAL_PROMPT: '0' } });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new LushError(`git ${args[0]}: ${err.trim() || out.trim()}`);
      return out;
    };
    const ref = await writtenRef(this, cwd, args);
    // Register even without a current watcher: an invocation may start while this
    // command is in flight, before its actual ref write or receipt is published.
    return ref?.startsWith('refs/heads/') ? this.trackRefWrite(ref, execute) : execute();
  },
  /** porcelain 明细（含未跟踪文件，排除 .lush）；空字符串表示干净。 */
  async porcelain(cwd) {
    const out = await this.gitOutput(cwd, 'status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).lush');
    return out.replace(/\n+$/, '');
  },
  /** 硬门槛：worker 自己的 worktree（必须提交）与 merge 时的主树。错误必须点出是哪些文件。 */
  async clean(cwd) {
    const status = await this.porcelain(cwd);
    const { sample, more } = dirtDetail(status);
    check(!status, `working tree is dirty: ${cwd}; commit or stash changes first\n${sample.join('\n')}${more ? `\n… ${more} more` : ''}`);
  },
  async isAncestor(cwd, commit, ref) {
    try { await this.git(cwd, 'merge-base', '--is-ancestor', commit, ref); return true; } catch { return false; }
  },
  /** main 上是否正卡着一次合并：只有这时才需要（也才能）abort。快进失败不会留下中间态。 */
  async merging(cwd) {
    try { await this.git(cwd, 'rev-parse', '--quiet', '--verify', 'MERGE_HEAD'); return true; } catch { return false; }
  },
  /** 未解决冲突的文件路径；空数组表示不是内容冲突，而是别的 git 失败。 */
  async unmerged(cwd) {
    const out = await this.gitOutput(cwd, 'diff', '--name-only', '--diff-filter=U');
    return out.split('\n').map(line => line.trim()).filter(Boolean);
  },
  /** 返回检出指定分支的 worktree；分支没有被检出时返回 null。 */
  async workspaceForBranch(branch) {
    const list = await this.git(this.config.project, 'worktree', 'list', '--porcelain');
    let workspace = null;
    for (const line of list.split('\n')) {
      if (line.startsWith('worktree ')) workspace = line.slice('worktree '.length);
      else if (line === `branch refs/heads/${branch}`) return workspace;
      else if (!line) workspace = null;
    }
    return null;
  },
  /** 分支是否正被某个 worktree 检出：删掉它会让那个检出的 HEAD 失效，所以先问清楚。 */
  async checkedOut(branch) { return Boolean(await this.workspaceForBranch(branch)); },
};
