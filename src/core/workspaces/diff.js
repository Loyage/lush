import fs from 'node:fs';

// 按 Workspaces 实例隔离；缓存只包含固定提交，不缓存会随磁盘变化的 status。
const diagnosticsCaches = new WeakMap();
const FILE_LIMIT = 50;
const FILE_BYTES = 2048;

function remember(cache, key, value) {
  cache.set(key, value);
  while (cache.size > 400) cache.delete(cache.keys().next().value);
  return value;
}

/** -z numstat 的重命名格式是「added\tdeleted\t\0old\0new\0」，文件名可含换行/tab。 */
function changeSummary(output) {
  const parts = output.split('\0');
  const result = { status: 'ok', files_total: 0, added: 0, deleted: 0, binary_files: 0, files: [], truncated: false };
  let bytes = 2;
  for (let i = 0; i < parts.length && parts[i]; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[i]);
    if (!match) throw new Error('invalid git numstat');
    let path = match[3], previous_path = null;
    if (!path) { previous_path = parts[++i]; path = parts[++i]; }
    if (!path) throw new Error('missing git numstat path');
    const binary = match[1] === '-' || match[2] === '-';
    const file = { path, added: binary ? null : Number(match[1]), deleted: binary ? null : Number(match[2]) };
    if (previous_path) file.previous_path = previous_path;
    result.files_total++;
    if (binary) result.binary_files++;
    else { result.added += file.added; result.deleted += file.deleted; }
    const size = Buffer.byteLength(JSON.stringify(file)) + 1;
    if (!result.truncated && result.files.length < FILE_LIMIT && bytes + size <= FILE_BYTES) {
      result.files.push(file); bytes += size;
    } else result.truncated = true;
  }
  return result;
}

function pendingSummary(output, path) {
  const result = { status: 'clean', path, files_total: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  const parts = output.split('\0');
  for (let i = 0; i < parts.length && parts[i]; i++) {
    const code = parts[i].slice(0, 2);
    result.files_total++;
    if (code === '??') result.untracked++;
    else if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code)) result.conflicts++;
    else {
      if (code[0] !== ' ') result.staged++;
      if (code[1] !== ' ') result.unstaged++;
    }
    if (/[RC]/.test(code)) i++; // porcelain -z 的 rename/copy 另占一个原路径。
  }
  if (result.files_total) result.status = 'dirty';
  return result;
}

/** 只读审阅视图（不进写队列）。 */
export const methods = {
  /** branches: [{ name, head_commit, created_from_commit }]；失败按字段降级，不吞掉整张图。 */
  async branchDiagnostics(branches) {
    let cache = diagnosticsCaches.get(this);
    if (!cache) { cache = new Map(); diagnosticsCaches.set(this, cache); }
    const project = this.config.project;
    const worktrees = new Map();
    let worktreesKnown = true;
    try {
      const list = await this.gitOutput(project, 'worktree', 'list', '--porcelain', '-z');
      let path = null;
      for (const field of list.split('\0')) {
        if (field.startsWith('worktree ')) path = field.slice(9);
        else if (field.startsWith('branch refs/heads/') && path) worktrees.set(field.slice(18), path);
        else if (!field) path = null;
      }
    } catch { worktreesKnown = false; }
    const result = new Map();
    for (const branch of branches) {
      const head = branch.head_commit, base = branch.created_from_commit;
      const diagnostics = { changes: { status: 'unavailable', reason: !head ? 'missing_head' : 'missing_baseline' },
        latest_commit: null, working_tree: { status: worktreesKnown ? 'not_checked_out' : 'unknown' } };
      if (head) {
        const key = `commit:${head}`;
        try {
          let latest = cache.get(key);
          if (!latest) {
            const output = await this.gitOutput(project, 'log', '-1', '--format=%cI%x00%s', head, '--');
            const [committed_at, subject] = output.split('\0');
            latest = remember(cache, key, { commit: head, committed_at, subject: (subject || '').trim().slice(0, 240) });
          }
          diagnostics.latest_commit = latest;
        } catch { /* UI 将 null 明确显示为不可用。 */ }
      }
      if (head && base) {
        const key = `diff:${base}:${head}`;
        try {
          let changes = cache.get(key);
          if (!changes) {
            const output = await this.gitOutput(project, 'diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--find-renames', base, head, '--');
            changes = remember(cache, key, { ...changeSummary(output), base_commit: base, head_commit: head });
          }
          diagnostics.changes = changes;
        } catch { diagnostics.changes = { status: 'unavailable', reason: 'read_failed', base_commit: base, head_commit: head }; }
      }
      const path = worktrees.get(branch.name);
      if (path) {
        try {
          // 禁止 status 可选的 index 写回；排除 Lush 自己的运行时目录。
          const output = await this.gitOutput(path, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude).lush');
          diagnostics.working_tree = pendingSummary(output, path);
          // 检出在采样过程中可能被外部用户切换，不把另一分支的脏活归到此分支。
          const current = await this.git(path, 'symbolic-ref', '--quiet', 'HEAD');
          if (current !== `refs/heads/${branch.name}`) diagnostics.working_tree = { status: 'unknown' };
        } catch { diagnostics.working_tree = { status: 'unknown', path }; }
      }
      result.set(branch.name, diagnostics);
    }
    return result;
  },
  /** Read-only overview for review: never mutates, so it stays outside the mutation queue. */
  async diff(task) {
    const workspace = task.workspace;
    if (!workspace || !fs.existsSync(workspace)) return null;
    const lines = value => value.split('\n').filter(Boolean);
    const range = task.base_commit && task.head_commit ? `${task.base_commit}..${task.head_commit}` : null;
    // 主树允许有未提交改动，spawn 之后目标分支还可能继续前进：base 落后多少提交必须看得见，
    // 否则「相对 base」的审阅会被误读成相对当前代码。stacked 任务的 base 是上游分支，
    // 所以这个数同时含上游尚未合并的差异，合并顺序的约束见 merge。
    const behind = range
      ? this.git(this.config.project, 'rev-list', '--count', `${task.base_commit}..${task.target_branch}`).catch(() => '')
      : '';
    const [status, numstat, commits, pendingNumstat, baseBehind] = await Promise.all([
      this.git(workspace, 'status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).lush'),
      range ? this.git(workspace, 'diff', '--numstat', range) : '',
      range ? this.git(workspace, 'log', '--oneline', '--no-decorate', range) : '',
      this.git(workspace, 'diff', '--numstat', 'HEAD'),
      behind,
    ]);
    const parse = value => value.split('\n').filter(Boolean).map(line => {
      const [added, deleted, ...rest] = line.split('\t');
      return { path: rest.join('\t') || '(unknown)', added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) };
    });
    const files = parse(numstat);
    const numbers = new Map(parse(pendingNumstat).map(file => [file.path, file]));
    const pending = lines(status).map(line => {
      const match = /^(\S{1,2})\s+(.*)$/.exec(line);
      if (!match) return null;
      const path = match[2].includes(' -> ') ? match[2].split(' -> ').pop() : match[2];
      const counted = numbers.get(path) || { added: null, deleted: null };
      return { path, code: match[1].trim(), added: counted.added, deleted: counted.deleted };
    }).filter(Boolean);
    return {
      branch: task.branch, target_branch: task.target_branch,
      base_commit: task.base_commit, head_commit: task.head_commit, committed: Boolean(range),
      base_behind: baseBehind === '' ? null : Number(baseBehind),
      files: files.slice(0, 500), files_total: files.length,
      pending: pending.slice(0, 500), pending_total: pending.length,
      commits: lines(commits).slice(0, 100),
    };
  },
};
