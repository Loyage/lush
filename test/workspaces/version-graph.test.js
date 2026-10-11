import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import { Workspaces } from '../../src/core/workspaces.js';

test('graph preserves Unicode and ignores repo log configuration, notes, replace refs/grafts and process-level Git injection without writes', async () => {
  const f = fixture();
  try {
    await repo(f.root); const root = await git(f.root, 'rev-parse', 'HEAD');
    await git(f.root, 'config', 'user.name', '开发者');
    await git(f.root, 'commit', '--allow-empty', '-m', '中文摘要 <script> & literal'); const tip = await git(f.root, 'rev-parse', 'HEAD');
    await git(f.root, 'notes', 'add', '-m', 'do not show');
    await git(f.root, 'config', 'log.showSignature', 'true'); await git(f.root, 'config', 'log.decorate', 'full');
    await git(f.root, 'config', 'log.date', 'relative'); await git(f.root, 'config', 'format.pretty', 'oneline');
    await git(f.root, 'config', 'core.fsmonitor', 'touch unexpected-fsmonitor');
    const tree = await git(f.root, 'rev-parse', `${tip}^{tree}`); const replacement = await git(f.root, 'commit-tree', tree, '-m', 'replacement');
    await git(f.root, 'replace', tip, replacement);
    fs.writeFileSync(path.join(f.root, '.git', 'info', 'grafts'), `${tip}\n`);
    const configBefore = fs.readFileSync(path.join(f.root, '.git', 'config'), 'utf8');
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_INDEX_FILE', 'GIT_CONFIG']) f.config.env[key] = '/missing/injected';
    f.config.env.GIT_CONFIG_COUNT = '1'; f.config.env.GIT_CONFIG_KEY_0 = 'core.fsmonitor'; f.config.env.GIT_CONFIG_VALUE_0 = 'touch config-injection';
    const result = await f.project.branchVersionGraph();
    expect(result.tip).toBe(tip); expect(result.commits.map(c => c.commit)).toEqual([tip, root]);
    expect(result.commits[0]).toMatchObject({ parents: [root], subject: '中文摘要 <script> & literal', author: { name: '开发者' } });
    expect(result.commits[0].committed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(fs.readFileSync(path.join(f.root, '.git', 'config'), 'utf8')).toBe(configBefore);
    expect(fs.existsSync(path.join(f.root, 'unexpected-fsmonitor'))).toBe(false); expect(fs.existsSync(path.join(f.root, 'config-injection'))).toBe(false);
    expect(fs.readFileSync(path.join(f.root, '.git', 'refs', 'heads', 'main'), 'utf8').trim()).toBe(tip);
  } finally { await f.close(); }
});

test('SHA-256 main and fixed Squash source graph support full 64-character parents and signed pagination', async () => {
  const f = fixture();
  try {
    await git(f.root, 'init', '-b', 'main', '--object-format=sha256'); await git(f.root, 'config', 'user.name', 'Lush Test'); await git(f.root, 'config', 'user.email', 'test@example.invalid');
    await git(f.root, 'commit', '--allow-empty', '-m', 'root'); const root = await git(f.root, 'rev-parse', 'HEAD');
    const main = await f.project.bootstrapMain(); const t = f.store.create({ role: 'agent', goal: 'sha256 graph', task_kind: 'order', parent_id: main.id });
    f.store.update(t.id, { base_commit: root, branch: 'feature' }); await git(f.root, 'checkout', '-b', 'feature');
    fs.writeFileSync(path.join(f.root, 'source.txt'), 'source'); await git(f.root, 'add', 'source.txt'); await git(f.root, 'commit', '-m', 'one'); const one = await git(f.root, 'rev-parse', 'HEAD');
    await git(f.root, 'commit', '--allow-empty', '-m', 'two'); const source = await git(f.root, 'rev-parse', 'HEAD');
    const tree = await git(f.root, 'rev-parse', `${source}^{tree}`), landed = await git(f.root, 'commit-tree', tree, '-p', root, '-m', 'landing'); await git(f.root, 'update-ref', 'refs/heads/main', landed);
    const delivery = f.store.event(t.id, 'task.merge_integrated', { source_commit: source, commit: landed, parent_id: main.id, squash: true });
    const first = await f.project.branchVersionGraph({ limit: 1 }); expect(first.tip).toHaveLength(64); expect(first.commits[0].parents).toEqual([root]);
    const next = await f.project.branchVersionGraph({ cursor: first.cursor, limit: 1 }); expect(next.commits[0].commit).toBe(root);
    const fixed = await f.project.branchVersionGraph({ delivery, limit: 1 }); expect(fixed.tip).toBe(source); expect(fixed.base).toBe(root); expect(fixed.commits[0].parents).toEqual([one]);
    expect((await f.project.branchVersionGraph({ delivery, cursor: fixed.cursor })).commits[0].commit).toBe(one);
  } finally { await f.close(); }
});

test('foreign project and history cursors cannot be replayed, even with identical tips', async () => {
  const f = fixture(), g = fixture();
  try {
    await repo(f.root); await git(f.root, 'commit', '--allow-empty', '-m', 'second');
    const graph = await f.project.branchVersionGraph({ limit: 1 }), history = await f.project.branchHistory({ limit: 1 });
    const foreign = new Workspaces(g.config, g.store);
    await expect(foreign.versionGraphPage({ cursor: graph.cursor })).rejects.toThrow('cursor');
    await expect(f.project.branchVersionGraph({ cursor: history.cursor })).rejects.toThrow('cursor');
    await expect(f.project.branchHistory({ cursor: graph.cursor })).rejects.toThrow('cursor');
  } finally { await f.close(); await g.close(); }
});

test('graph reader bounds simultaneous reads and releases slots after completion and Git failures', async () => {
  const f = fixture();
  try {
    await repo(f.root);
    const reads = await Promise.allSettled(Array.from({ length: 5 }, () => f.project.branchVersionGraph()));
    expect(reads.filter(r => r.status === 'fulfilled')).toHaveLength(4);
    expect(reads.find(r => r.status === 'rejected').reason.message).toContain('busy');
    expect((await f.project.branchVersionGraph()).scope).toBe('main');
    fs.renameSync(path.join(f.root, '.git'), path.join(f.root, '.git.saved'));
    await expect(f.project.branchVersionGraph()).rejects.toThrow('Git');
    fs.renameSync(path.join(f.root, '.git.saved'), path.join(f.root, '.git'));
    expect((await f.project.branchVersionGraph()).scope).toBe('main');
  } finally { await f.close(); }
});

test('oversized Git graph output is rejected completely, not silently truncated into a successful page', async () => {
  const f = fixture();
  try {
    await repo(f.root); const message = path.join(f.config.home, 'large-message'); fs.writeFileSync(message, 'x'.repeat(4 * 1024 * 1024 + 1));
    await git(f.root, 'commit', '--allow-empty', '-F', message);
    await expect(f.project.branchVersionGraph({ limit: 1 })).rejects.toThrow('安全大小上限');
  } finally { await f.close(); }
});
