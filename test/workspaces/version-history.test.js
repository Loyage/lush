import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';

test('history ignores Git environment overrides and notes/signature formatting, with Unicode metadata intact', async () => {
  const f = fixture();
  try {
    await repo(f.root);
    await git(f.root, 'config', 'user.name', '开发者');
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'changed\n');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', '中文摘要 <script> & literal');
    const tip = await git(f.root, 'rev-parse', 'HEAD');
    await git(f.root, 'notes', 'add', '-m', 'notes must not enter history metadata');
    await git(f.root, 'config', 'log.showSignature', 'true');
    f.config.env.GIT_DIR = '/missing/injected'; f.config.env.GIT_WORK_TREE = '/missing/injected';
    const result = await f.project.branchHistory();
    expect(result.tip).toBe(tip); expect(result.commits[0]).toMatchObject({ subject: '中文摘要 <script> & literal', author: { name: '开发者' } });
    expect(result.commits[0].committed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.commits).toHaveLength(2);
  } finally { await f.close(); }
});

test('history supports SHA-256 object IDs and signed pagination', async () => {
  const f = fixture();
  try {
    await git(f.root, 'init', '-b', 'main', '--object-format=sha256');
    await git(f.root, 'config', 'user.name', 'Lush Test'); await git(f.root, 'config', 'user.email', 'test@example.invalid');
    await git(f.root, 'commit', '--allow-empty', '-m', 'root'); const root = await git(f.root, 'rev-parse', 'HEAD');
    await git(f.root, 'commit', '--allow-empty', '-m', 'tip');
    const first = await f.project.branchHistory({ limit: 1 }); expect(first.tip).toHaveLength(64);
    const second = await f.project.branchHistory({ cursor: first.cursor, limit: 1 });
    expect(second.tip).toBe(first.tip); expect(second.commits[0].commit).toBe(root); expect(second.has_more).toBe(false);
  } finally { await f.close(); }
});
