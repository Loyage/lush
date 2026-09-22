import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDocs } from '../scripts/docs-check.js';

function docsFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-docs-'));
  fs.mkdirSync(path.join(root, 'docs', 'guide'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Project\n\n[Docs](docs/README.md)\n');
  fs.writeFileSync(path.join(root, 'docs', 'README.md'), '# Docs\n\n[Guide](guide/README.md)\n');
  fs.writeFileSync(path.join(root, 'docs', 'guide', 'README.md'), '# Guide\n\n```mermaid\nflowchart LR\n  A --> B\n```\n');
  return root;
}

test('docs check accepts linked Markdown and closed Mermaid fences', () => {
  const root = docsFixture();
  try {
    const result = checkDocs(root);
    expect(result.errors).toEqual([]);
    expect(result.docs).toContain('docs/guide/README.md');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('docs check rejects authored HTML, broken links, duplicate H1 and open Mermaid fences', () => {
  const root = docsFixture();
  try {
    fs.writeFileSync(path.join(root, 'docs', 'legacy.html'), '<h1>legacy</h1>');
    fs.writeFileSync(path.join(root, 'docs', 'guide', 'README.md'), '# One\n# Two\n\n[Missing](missing.md)\n\n```mermaid\nflowchart LR\n');
    const errors = checkDocs(root).errors.join('\n');
    expect(errors).toContain('repository documentation must be Markdown');
    expect(errors).toContain('expected exactly one level-1 heading');
    expect(errors).toContain('missing link target: missing.md');
    expect(errors).toContain('Mermaid fence opened');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
