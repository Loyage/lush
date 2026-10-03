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

test('docs check respects fence length, marker, closing whitespace and nested examples', () => {
  const root = docsFixture();
  try {
    const file = path.join(root, 'docs', 'guide', 'README.md');
    for (const fence of ['````', '~~~~']) {
      for (const invalidClose of [fence.slice(1), fence + 'mermaid', fence[0] === '`' ? '~~~~' : '````']) {
        fs.writeFileSync(file, `# Guide\n${fence}mermaid\nflowchart LR\n${invalidClose}\n`);
        expect(checkDocs(root).errors).toContain('docs/guide/README.md: Mermaid fence opened on line 2 is not closed');
      }
      fs.writeFileSync(file, `# Guide\n${fence}mermaid\nflowchart LR\n${fence}${fence[0]}  \t\n`);
      expect(checkDocs(root).errors).toEqual([]);
    }
    // All headings and links here are examples, not documentation to validate.
    fs.writeFileSync(file, '# Guide\n````markdown\n```mermaid\n# Fake H1\n[Fake](missing.md)\n```\n````\n');
    expect(checkDocs(root).errors).toEqual([]);
    fs.writeFileSync(file, '# Guide\n~~~~text\n```mermaid\n# Fake H1\n[Fake](missing.md)\n~~~~\n');
    expect(checkDocs(root).errors).toEqual([]);
    fs.writeFileSync(file, '# Guide\n````text\n```\n````\n[Real](missing.md)\n');
    expect(checkDocs(root).errors).toContain('docs/guide/README.md: missing link target: missing.md');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('docs check warns about long chapters without introducing a hard gate', () => {
  const root = docsFixture();
  try {
    fs.writeFileSync(path.join(root, 'docs', 'guide', 'README.md'), '# Guide\n' + 'Short line\n'.repeat(200));
    const result = checkDocs(root);
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toContain('201 lines exceeds the recommended 150');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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
