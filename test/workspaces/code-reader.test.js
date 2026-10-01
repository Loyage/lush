import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, git, repo } from '../helpers.js';
import { LIMITS, runGit, CodeReadError, readWorkspace } from '../../src/core/workspaces/code-io.js';
import { pageRows } from '../../src/core/workspaces/code-model.js';
import { encode, MAX_FRAME } from '../../src/rpc/protocol.js';
import { posixFiles } from '../../src/core/workspaces/code-posix.js';

async function setup() {
  const f = fixture(); await repo(f.root);
  const base = await git(f.root, 'rev-parse', 'HEAD');
  const workspace = path.join(f.config.home, 'worktrees', 'reader');
  await git(f.root, 'worktree', 'add', '-b', 'reader', workspace);
  const task = { id: 7, workspace, branch: 'reader', base_commit: base, head_commit: base };
  return { ...f, workspace, task,
    write(name, text) { fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true }); fs.writeFileSync(path.join(workspace, name), text); },
    state(opts) { return f.project.workspaces.codeState(task, opts); },
    tree(opts) { return f.project.workspaces.codeTree(task, opts); },
    file(name, opts) { return f.project.workspaces.codeFile(task, { path: name, ...opts }); },
    async commit() { await git(workspace, 'add', '.'); await git(workspace, 'commit', '-m', 'changes'); return git(workspace, 'rev-parse', 'HEAD'); },
  };
}

test('code reader includes unchanged files, computes task/iteration/working baselines and reads actual HEAD', async () => {
  const f = await setup();
  try {
    const clean = await f.state(); expect(clean.availability).toBe('available'); expect(clean.summary).toMatchObject({ changed_total: 0, pending_total: 0, files_total: 2 });
    expect((await f.tree()).entries.map(row => row.path)).toContain('file.txt');
    expect((await f.file('file.txt', { view: 'content' })).content.text).toBe('base\n');
    f.write('file.txt', 'first\n'); const head = await f.commit(); f.task.iteration_base_commit = head;
    f.write('file.txt', 'second\n');
    const task = await f.state(); expect(task.head_commit).toBe(head); expect(task.base_commit).toBe(f.task.base_commit);
    expect(task.files[0]).toMatchObject({ path: 'file.txt', status: 'M', unstaged: true, added: 1, deleted: 1 });
    expect((await f.state({ scope: 'iteration' })).base_commit).toBe(head);
    expect((await f.state({ scope: 'working' })).base_commit).toBe(head);
    const diff = await f.file('file.txt');
    expect(diff.availability).toBe('available');
    expect(diff.diff.hunks[0].lines).toContainEqual({ kind: 'delete', text: 'base', old_line: 1, new_line: null });
    expect(diff.diff.hunks[0].lines).toContainEqual({ kind: 'add', text: 'second', old_line: null, new_line: 1 });
    expect((await f.file('file.txt', { scope: 'working', view: 'content', side: 'old' })).content.text).toBe('first\n');
  } finally { await f.close(); }
});

test('net revert stays visible as dirty; staged/unstaged/untracked and ignored/internal files are separate', async () => {
  const f = await setup();
  try {
    f.write('file.txt', 'committed\n'); await f.commit(); f.write('file.txt', 'base\n');
    f.write('new.txt', 'new\n'); f.write('.gitignore', '.lush/\nsecret*\n');
    f.write('secret.env', 'SECRET'); f.write('.lush/private', 'PRIVATE'); f.write('.LUSH/private', 'CASE PRIVATE');
    const data = await f.state();
    expect(data.files.find(row => row.path === 'file.txt')).toMatchObject({ changed: false, unstaged: true });
    expect(data.files.find(row => row.path === 'new.txt')).toMatchObject({ changed: true, untracked: true, status: 'A' });
    const paths = (await f.tree({ query: '' })).entries.map(row => row.path);
    expect(paths).not.toContain('secret.env'); expect(paths).not.toContain('.lush'); expect(paths).not.toContain('.LUSH');
    await expect(f.file('secret.env')).rejects.toThrow('readable project file set');
    await expect(f.file('.lush/private')).rejects.toThrow('invalid project-relative');
    await expect(f.file('.LUSH/private')).rejects.toThrow('invalid project-relative');
    await git(f.workspace, 'add', 'file.txt'); f.write('file.txt', 'again\n');
    expect((await f.state()).files.find(row => row.path === 'file.txt')).toMatchObject({ staged: true, unstaged: true });
  } finally { await f.close(); }
});

test('rename, deleted and unusual literal filenames retain correct versions and pageable trees', async () => {
  const f = await setup();
  try {
    const weird = 'dir/new\tname\n.txt'; fs.mkdirSync(path.join(f.workspace, 'dir'));
    await git(f.workspace, 'mv', 'file.txt', weird);
    f.write(':literal[glob]*.txt', 'literal\n'); f.write('removed.txt', 'delete me\n'); await f.commit();
    f.task.base_commit = await git(f.workspace, 'rev-parse', 'HEAD');
    fs.unlinkSync(path.join(f.workspace, 'removed.txt')); f.write(':literal[glob]*.txt', 'changed\n');
    const renamedTask = { ...f.task, base_commit: await git(f.root, 'rev-parse', 'HEAD') };
    const rename = await f.project.workspaces.codeFile(renamedTask, { path: weird, view: 'content', side: 'old' });
    expect(rename.previous_path).toBe('file.txt'); expect(rename.content.text).toBe('base\n');
    expect((await f.file('removed.txt')).new.exists).toBe(false);
    expect((await f.file('removed.txt', { view: 'content', side: 'old' })).content.text).toBe('delete me\n');
    expect((await f.file(':literal[glob]*.txt', { view: 'content' })).content.text).toBe('changed\n');
    const first = await f.tree({ limit: 1 }); expect(first.has_more).toBe(true); expect(first.entries[0].kind).toBe('directory');
    const second = await f.tree({ limit: 1, after: first.next, revision: first.revision }); expect(second.entries[0].path).not.toBe(first.entries[0].path);
    expect((await f.tree({ path: 'dir' })).entries[0].path).toBe(weird);
    expect((await f.tree({ query: 'name' })).entries[0].path).toBe(weird);
  } finally { await f.close(); }
});

test('content pagination and hunk offsets preserve CR and no-newline markers; revisions reject stale reads', async () => {
  const f = await setup();
  try {
    f.write('file.txt', 'a\r\nb\r\nlast');
    const state = await f.state(); expect((await f.state()).revision).toBe(state.revision);
    const a = await f.file('file.txt', { view: 'content', limit: 4, revision: state.revision });
    expect(a.content).toMatchObject({ text: 'a\r\nb', next_offset: 4, has_more: true, line_start: 1 });
    const b = await f.file('file.txt', { view: 'content', offset: 4, revision: state.revision });
    expect(a.content.text + b.content.text).toBe('a\r\nb\r\nlast'); expect(b.content.line_start).toBe(2);
    const diff = await f.file('file.txt'); expect(diff.diff.hunks[0].lines.some(line => line.text === 'a\r')).toBe(true);
    expect(diff.diff.hunks[0].lines.some(line => line.kind === 'meta')).toBe(true);
    f.write('file.txt', 'newer\n');
    expect((await f.file('file.txt', { revision: state.revision })).availability).toBe('stale');
    expect((await f.tree({ revision: state.revision })).availability).toBe('stale');
    const lines = Array.from({ length: 30 }, (_, i) => 'line ' + i); f.write('file.txt', lines.join('\n')); await f.commit();
    f.task.base_commit = await git(f.workspace, 'rev-parse', 'HEAD'); lines[0] = 'changed'; lines[29] = 'changed too'; f.write('file.txt', lines.join('\n'));
    const page = await f.file('file.txt', { limit: 1 }); expect(page.diff.has_more).toBe(true);
    expect((await f.file('file.txt', { offset: page.diff.next_offset, limit: 1, revision: page.revision })).diff.hunks[0].new_start).toBeGreaterThan(20);
  } finally { await f.close(); }
});

test('binary, symlinks, executable-mode changes and large files have explicit metadata/fallback', async () => {
  const f = await setup();
  try {
    f.write('binary.bin', Buffer.from([0, 1, 2])); fs.symlinkSync('/etc/passwd', path.join(f.workspace, 'link'));
    fs.chmodSync(path.join(f.workspace, 'file.txt'), 0o755);
    const binary = await f.file('binary.bin', { view: 'content' }); expect(binary.kind).toBe('binary'); expect(binary.reason).toContain('二进制');
    const link = await f.file('link', { view: 'content' }); expect(link.kind).toBe('symlink'); expect(link.content.text).toBe('/etc/passwd');
    expect((await f.file('file.txt')).new.mode).toBe('100755');
    f.write('big.txt', 'x'.repeat(1100000));
    expect((await f.file('big.txt', { view: 'content', limit: 100 })).content).toMatchObject({ has_more: true, next_offset: 100 });
    f.write('huge.txt', 'x'.repeat(9 * 1024 * 1024));
    const huge = await f.file('huge.txt', { view: 'content' }); expect(huge.truncated).toBe(true); expect(huge.reason).toContain('8 MiB');
    expect((await f.file('huge.txt')).diff.too_large).toBe(true);
  } finally { await f.close(); }
});

test('ancestor symlinks, traversal and unregistered worktrees cannot read outside task scope', async () => {
  const f = await setup();
  try {
    f.write('dir/file.txt', 'safe\n'); await f.commit();
    const external = path.join(f.config.home, 'outside'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'file.txt'), 'SECRET');
    fs.rmSync(path.join(f.workspace, 'dir'), { recursive: true }); fs.symlinkSync(external, path.join(f.workspace, 'dir'));
    const value = await f.file('dir/file.txt', { view: 'content' }); expect(value.content?.text ?? '').not.toContain('SECRET');
    for (const name of ['../file.txt', '/etc/passwd', 'dir/../../file.txt', '.git/config', 'a/.lush/token', 'a\0b']) await expect(f.file(name)).rejects.toThrow('invalid project-relative');
    f.task.workspace = f.root; expect((await f.state()).availability).toBe('unavailable');
    f.task.workspace = external; expect((await f.state()).availability).toBe('stale');
  } finally { await f.close(); }
});

test('sterile Git never invokes repository clean/textconv/external/fsmonitor helpers or changes the real index', async () => {
  const f = await setup();
  try {
    const marker = path.join(f.root, 'EXECUTED');
    f.write('.gitattributes', '*.txt filter=evil diff=evil\n'); await f.commit();
    for (const key of ['filter.evil.clean', 'filter.evil.process', 'diff.evil.textconv', 'diff.external', 'core.fsmonitor']) await git(f.root, 'config', key, `touch '${marker}'`);
    await git(f.root, 'config', 'filter.evil.required', 'true');
    f.write('file.txt', 'changed\n');
    const index = path.join(await git(f.workspace, 'rev-parse', '--absolute-git-dir'), 'index');
    const bytes = fs.readFileSync(index), stat = fs.statSync(index).mtimeMs;
    expect((await f.state()).availability).toBe('available');
    expect((await f.file('file.txt')).diff.hunks.length).toBe(1);
    expect(fs.existsSync(marker)).toBe(false); expect(fs.readFileSync(index)).toEqual(bytes); expect(fs.statSync(index).mtimeMs).toBe(stat);
  } finally { await f.close(); }
});

test('archived tasks read only original commit objects, missing baseline does not invent diff, and missing history is unavailable', async () => {
  const f = await setup();
  try {
    f.write('file.txt', 'delivered\n'); f.task.head_commit = await f.commit();
    await git(f.root, 'worktree', 'remove', f.workspace); await git(f.root, 'branch', '-D', 'reader');
    const state = await f.state(); expect(state.source).toBe('commit'); expect(state.availability).toBe('available');
    expect((await f.file('file.txt', { view: 'content' })).content.text).toBe('delivered\n');
    expect((await f.state({ scope: 'working' })).availability).toBe('unavailable');
    f.task.base_commit = '1'.repeat(40);
    expect((await f.state()).summary.changed_total).toBeNull();
    expect((await f.file('file.txt')).diff.reason).toContain('基线');
    f.task.head_commit = '2'.repeat(40); expect((await f.state()).availability).toBe('unavailable');
  } finally { await f.close(); }
});

test('merge conflicts remain read-only and show conflict status; branch identity drift is stale', async () => {
  const f = await setup();
  try {
    f.write('file.txt', 'reader\n'); await f.commit();
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'main\n'); await git(f.root, 'commit', '-am', 'main');
    await expect(git(f.workspace, 'merge', 'main')).rejects.toThrow();
    const original = fs.readFileSync(path.join(f.workspace, 'file.txt'));
    expect((await f.state()).files.find(row => row.path === 'file.txt')).toMatchObject({ conflict: true, status: 'U' });
    expect((await f.file('file.txt', { view: 'content' })).content.text).toContain('<<<<<<<');
    expect(fs.readFileSync(path.join(f.workspace, 'file.txt'))).toEqual(original);
    f.task.branch = 'wrong'; expect((await f.state()).availability).toBe('stale');
  } finally { await f.close(); }
});

test('index removal plus readable untracked file is netted, ignored replacement is never exposed', async () => {
  const f = await setup();
  try {
    await git(f.workspace, 'rm', '--cached', 'file.txt');
    const row = (await f.state()).files.find(row => row.path === 'file.txt');
    expect(row).toMatchObject({ staged: true, untracked: true, changed: false, status: null });
    expect((await f.file('file.txt')).diff.hunks).toEqual([]);
    f.write('.gitignore', '.lush/\nfile.txt\n'); f.write('file.txt', 'NEW IGNORED SECRET');
    const file = await f.file('file.txt', { view: 'content' });
    expect(file.new.exists).toBe(false); expect(file.content.text).toBe('');
    expect((await f.file('file.txt', { view: 'content', side: 'old' })).content.text).toBe('base\n');
  } finally { await f.close(); }
});

test('submodule index commit changes are metadata-only and nested repositories are opaque', async () => {
  const f = await setup();
  try {
    const old = f.task.base_commit;
    await git(f.workspace, 'update-index', '--add', '--cacheinfo', `160000,${old},module`);
    await git(f.workspace, 'commit', '-m', 'module'); f.task.base_commit = await git(f.workspace, 'rev-parse', 'HEAD');
    // An uninitialised submodule still has a readable registered gitlink; never initialise it.
    await git(f.workspace, 'update-index', '--cacheinfo', `160000,${f.task.base_commit},module`);
    const row = (await f.state()).files.find(row => row.path === 'module');
    expect(row).toMatchObject({ kind: 'submodule', staged: true, changed: true, status: 'M' });
    const value = await f.file('module', { view: 'content' }); expect(value.kind).toBe('submodule'); expect(value.content.text).toBe(f.task.base_commit);
    expect((await f.file('module')).diff.reason).toContain('子模块');
    fs.mkdirSync(path.join(f.workspace, 'nested')); await repo(path.join(f.workspace, 'nested'));
    expect((await f.tree()).entries.find(row => row.path === 'nested')).toMatchObject({ kind: 'directory' });
    await expect(f.file('nested/file.txt')).rejects.toThrow('readable project file set');
  } finally { await f.close(); }
});

test('literal backslashes and UTF-8 BOM are preserved and continuation is explicit', async () => {
  const f = await setup();
  try {
    const name = 'back\\slash.txt'; f.write(name, '\ufefflongline\n');
    const a = await f.file(name, { view: 'content', limit: 3 }); expect(a.content.text).toBe('\ufefflo');
    const b = await f.file(name, { view: 'content', offset: 3 }); expect(b.content.line_continued).toBe(true);
    const c = await f.file(name, { view: 'content', offset: 10 }); expect(c.content.line_continued).toBe(false);
  } finally { await f.close(); }
});

test('descriptor reads never follow final symlinks swapped before or after openat', async () => {
  const f = await setup(); const open = posixFiles.openAt;
  try {
    const secret = path.join(f.config.home, 'secret'); fs.writeFileSync(secret, 'SECRET');
    for (const when of ['before', 'after']) {
      fs.rmSync(path.join(f.workspace, 'file.txt')); f.write('file.txt', 'safe');
      let swapped = false;
      const swap = () => { swapped = true; fs.unlinkSync(path.join(f.workspace, 'file.txt')); fs.symlinkSync(secret, path.join(f.workspace, 'file.txt')); };
      posixFiles.openAt = (parent, name, directory) => {
        if (name !== 'file.txt' || swapped) return open(parent, name, directory);
        if (when === 'before') swap();
        const fd = open(parent, name, directory);
        if (when === 'after') swap();
        return fd;
      };
      const result = readWorkspace(f.workspace, 'file.txt');
      expect(result.buffer.toString()).toBe(when === 'before' ? secret : 'safe');
      expect(result.buffer.toString()).not.toBe('SECRET'); expect(swapped).toBe(true);
    }
  } finally { posixFiles.openAt = open; await f.close(); }
});

test('read concurrency, query validation and elapsed deadline are bounded', async () => {
  const f = await setup();
  try {
    const reads = Array.from({ length: 5 }, () => f.state());
    const results = await Promise.all(reads);
    expect(results[4]).toMatchObject({ availability: 'unavailable', reason: '代码读取繁忙，请稍后重试' });
    expect(results.slice(0, 4).every(result => result.availability === 'available')).toBe(true);
    for (const opts of [{ scope: 'main' }, { limit: 201 }, { after: -1 }]) await expect(f.state(opts)).rejects.toThrow('invalid');
    await expect(f.file('file.txt', { offset: 0.5 })).rejects.toThrow('invalid');
    await expect(f.tree({ changed: 'true' })).rejects.toThrow('invalid');
    await expect(runGit(f.config, f.root, ['status'], { deadline: Date.now() - 1 })).rejects.toThrow('超时');
  } finally { await f.close(); }
});

test('blocked known paths fail the whole sample instead of silently disappearing', async () => {
  const f = await setup(); const open = posixFiles.openAt;
  try {
    f.write('blocked/known.txt', 'known\n'); await f.commit();
    posixFiles.openAt = (parent, name, directory) => {
      if (name === 'blocked') throw Object.assign(new Error('blocked test path'), { code: 'ELOOP' });
      return open(parent, name, directory);
    };
    const state = await f.state();
    expect(state.availability).toBe('unavailable'); expect(state.reason).toContain('符号链接');
    expect(state.summary.files_total).toBeNull(); expect(state.summary.changed_total).toBeNull(); expect(state.files).toEqual([]);
    const tree = await f.tree(); expect(tree.availability).toBe('unavailable'); expect(tree.entries).toEqual([]);
    const file = await f.file('file.txt'); expect(file.availability).toBe('unavailable');
  } finally { posixFiles.openAt = open; await f.close(); }
});

test('state and tree byte pagination preserves every long escaped path and fits real RPC frames', async () => {
  const f = await setup();
  try {
    const directory = Array.from({ length: 8 }, (_, i) => `d${i}-` + '\t'.repeat(170)).join('/');
    for (let i = 0; i < 210; i++) f.write(`${directory}/file-${String(i).padStart(3, '0')}-${'\t'.repeat(160)}.txt`, 'line\n');
    await f.commit();
    for (const kind of ['state', 'tree']) {
      let after = 0, revision, more = true; const names = [];
      while (more) {
        const page = kind === 'state' ? await f.state({ after, limit: 200 }) : await f.tree({ after, limit: 200, query: 'file-', revision });
        expect(page.availability).toBe('available'); expect(page.truncated).toBe(false);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(LIMITS.response);
        expect(encode({ jsonrpc: '2.0', id: 7, result: page }).length).toBeLessThan(MAX_FRAME);
        const rows = kind === 'state' ? page.files : page.entries;
        if (after === 0) { expect(rows.length).toBeLessThan(200); expect(page.has_more).toBe(true); }
        expect(page.next).toBe(after + rows.length); names.push(...rows.map(row => row.path));
        after = page.next; revision = page.revision; more = page.has_more;
      }
      expect(names).toHaveLength(210); expect(new Set(names).size).toBe(210);
    }
  } finally { await f.close(); }
});

test('list byte budget includes previous paths and JSON escaping; oversized single rows fail explicitly', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ path: `${i}/` + '\n'.repeat(2000), previous_path: '\t'.repeat(2000), kind: 'file' }));
  const first = pageRows(rows, 0, 200); expect(first.length).toBeGreaterThan(0); expect(first.length).toBeLessThan(200);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(LIMITS.response - 32768);
  expect(pageRows(rows, first.length, 200)[0]).toEqual(rows[first.length]);
  expect(() => pageRows([{ path: 'x'.repeat(LIMITS.response) }], 0, 200)).toThrow('单个文件条目超过响应安全大小上限');
});

test('bounded git output fails explicitly instead of buffering unbounded data', async () => {
  const f = await setup();
  try { await expect(runGit(f.config, f.root, ['log', '-1', '--format=%H'], { max: 3 })).rejects.toBeInstanceOf(CodeReadError); }
  finally { await f.close(); }
});
