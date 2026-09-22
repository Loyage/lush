#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_RECOMMENDED_BYTES = 50 * 1024;

const posix = value => value.split(path.sep).join('/');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

function withoutFencedCode(source) {
  const kept = [];
  let fence = null;
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      kept.push('');
      continue;
    }
    kept.push(fence ? '' : line);
  }
  return kept.join('\n');
}

function mermaidFenceErrors(source) {
  const errors = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let open = null;
  for (let index = 0; index < lines.length; index++) {
    const match = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[index]);
    if (!match) continue;
    if (!open && match[2].toLowerCase() === 'mermaid') open = { marker: match[1][0], line: index + 1 };
    else if (open && match[1][0] === open.marker && !match[2]) open = null;
  }
  if (open) errors.push(`Mermaid fence opened on line ${open.line} is not closed`);
  return errors;
}

function markdownLinks(source) {
  const links = [];
  const text = withoutFencedCode(source);
  const pattern = /!?\[[^\]]*\]\(\s*([^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g;
  for (const match of text.matchAll(pattern)) links.push(match[1].replace(/^<|>$/g, ''));
  return links;
}

export function checkDocs(root = DEFAULT_ROOT) {
  root = path.resolve(root);
  const docsRoot = path.join(root, 'docs');
  const files = walk(docsRoot);
  const markdown = [path.join(root, 'README.md'), ...files.filter(file => path.extname(file).toLowerCase() === '.md')]
    .filter(file => fs.existsSync(file));
  const errors = [];
  const warnings = [];

  for (const file of files.filter(file => path.extname(file).toLowerCase() === '.html')) {
    errors.push(`${posix(path.relative(root, file))}: repository documentation must be Markdown, not HTML`);
  }

  for (const file of markdown) {
    const relative = posix(path.relative(root, file));
    const source = fs.readFileSync(file, 'utf8');
    const prose = withoutFencedCode(source);
    const h1 = prose.match(/^#\s+\S.*$/gm) || [];
    if (h1.length !== 1) errors.push(`${relative}: expected exactly one level-1 heading, found ${h1.length}`);
    if (Buffer.byteLength(source) > MAX_RECOMMENDED_BYTES) warnings.push(`${relative}: exceeds the recommended 50KB size`);
    for (const message of mermaidFenceErrors(source)) errors.push(`${relative}: ${message}`);

    for (const raw of markdownLinks(source)) {
      if (!raw || raw.startsWith('#') || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
      const clean = raw.split('#')[0].split('?')[0];
      if (!clean) continue;
      if (clean.startsWith('/')) { errors.push(`${relative}: repository link must be relative: ${raw}`); continue; }
      let decoded;
      try { decoded = decodeURIComponent(clean); }
      catch { errors.push(`${relative}: invalid encoded link: ${raw}`); continue; }
      const target = path.resolve(path.dirname(file), decoded);
      const inside = target === root || target.startsWith(`${root}${path.sep}`);
      if (!inside) { errors.push(`${relative}: link escapes the repository: ${raw}`); continue; }
      const resolved = fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, 'README.md') : target;
      if (!fs.existsSync(resolved)) errors.push(`${relative}: missing link target: ${raw}`);
    }
  }

  return { docs: markdown.map(file => posix(path.relative(root, file))), errors, warnings };
}

if (import.meta.main) {
  const result = checkDocs();
  for (const warning of result.warnings) console.warn(`docs: warning: ${warning}`);
  for (const error of result.errors) console.error(`docs: error: ${error}`);
  if (result.errors.length) process.exitCode = 1;
  else console.log(`docs: checked ${result.docs.length} Markdown files`);
}
