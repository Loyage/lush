import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LIMITS, CodeReadError, hash, internal, compare, signature, fileHandle, kindOfMode, readWorkspace } from './code-io.js';

const exclusions = ['--', '.', ':(icase,exclude)**/.git/**', ':(icase,exclude)**/.lush/**', ':(icase,exclude).lush', ':(icase,exclude).git'];
export const pending = row => row.staged || row.unstaged || row.untracked || row.conflict;
export const emptyRow = name => ({ path: name, previous_path: null, kind: 'file', status: null, changed: false,
  staged: false, unstaged: false, untracked: false, conflict: false, added: 0, deleted: 0 });

export async function treeObjects(io, commit) {
  const entries = new Map(); if (!commit) return entries;
  const text = (await io.git(['ls-tree', '-r', '-l', '-z', commit])).toString('utf8');
  for (const record of text.split('\0')) {
    if (!record) continue;
    const match = /^(\d+) (\w+) ([a-f0-9]+) +(-|\d+)\t([\s\S]+)$/.exec(record);
    if (!match) throw new CodeReadError('Git 文件树格式不可读取');
    const [, mode, type, oid, size, name] = match;
    if (!internal(name)) entries.set(name, { mode, type, oid, size: size === '-' ? null : Number(size), kind: kindOfMode(mode) });
    if (entries.size > LIMITS.files) throw new CodeReadError('项目超过 20,000 文件的安全扫描上限');
  }
  return entries;
}

function statuses(buffer) {
  const parts = buffer.toString('utf8').split('\0'), entries = new Map();
  for (let i = 0; i < parts.length && parts[i]; i++) {
    const record = parts[i], code = record.slice(0, 2), name = record.slice(3).replace(/\/$/, '');
    const previous = /[RC]/.test(code) ? parts[++i] : null;
    if (internal(name)) continue;
    const conflict = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code);
    const prior = entries.get(name);
    entries.set(name, { staged: Boolean(prior?.staged || code !== '??' && code[0] !== ' '), unstaged: Boolean(prior?.unstaged || code !== '??' && code[1] !== ' '),
      untracked: Boolean(prior?.untracked || code === '??'), conflict: Boolean(prior?.conflict || conflict), pending_previous: previous ?? prior?.pending_previous });
  }
  return entries;
}
function changes(buffer) {
  const parts = buffer.toString('utf8').split('\0'), entries = new Map();
  for (let i = 0; i < parts.length && parts[i]; i++) {
    const status = parts[i][0], previous = parts[++i], name = status === 'R' || status === 'C' ? parts[++i] : previous;
    if (!name || internal(name) || internal(previous)) continue;
    entries.set(name, { status: status === 'C' ? 'A' : status, previous_path: status === 'R' ? previous : null, changed: true });
  }
  return entries;
}
function numbers(buffer) {
  const parts = buffer.toString('utf8').split('\0'), entries = new Map();
  for (let i = 0; i < parts.length && parts[i]; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[i]);
    if (!match) throw new CodeReadError('Git 文件统计格式不可读取');
    let name = match[3]; if (!name) { i++; name = parts[++i]; }
    if (!name || internal(name)) continue;
    entries.set(name, { added: match[1] === '-' ? null : Number(match[1]), deleted: match[2] === '-' ? null : Number(match[2]), binary: match[1] === '-' });
  }
  return entries;
}

/** Whole scan has a hard file/output/time budget; API pagination never implies unbounded buffering. */
export async function sample(io) {
  const old = await treeObjects(io, io.base), head = await treeObjects(io, io.head);
  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--find-renames', '-l200'];
  const dirty = io.workspace ? statuses(await io.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', ...exclusions])) : new Map();
  const range = io.base ? [io.base, ...(io.workspace ? [] : [io.head])] : [];
  const changed = io.base ? changes(await io.git([...diffArgs, '--name-status', '-z', ...range, ...exclusions])) : new Map();
  const stats = io.base ? numbers(await io.git([...diffArgs, '--numstat', '-z', ...range, ...exclusions])) : new Map();
  const paths = new Set([...old.keys(), ...head.keys(), ...dirty.keys(), ...changed.keys()]);
  // Staged additions which are net unchanged versus base still belong to the file universe.
  const index = new Map(), liveAllowed = new Set([...dirty].filter(([, row]) => row.untracked).map(([name]) => name));
  if (io.workspace) {
    const tracked = (await io.git(['ls-files', '-z', '--stage'])).toString('utf8').split('\0');
    for (const record of tracked) {
      if (!record) continue;
      const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(record);
      if (!match || internal(match[4])) continue;
      const [, mode, oid, stage, name] = match;
      paths.add(name); liveAllowed.add(name);
      if (stage === '0') index.set(name, { mode, oid, kind: kindOfMode(mode) });
    }
  }
  if (paths.size > LIMITS.files) throw new CodeReadError('项目超过 20,000 文件的安全扫描上限');
  const rows = new Map(), fingerprints = [], liveStats = new Map();
  if (io.index) fingerprints.push(['index', signature(fs.statSync(io.index, { bigint: true }))]);
  const renamed = new Set([...changed.values()].map(row => row.previous_path).filter(Boolean));
  for (const name of [...paths].sort(compare)) {
    if (Date.now() > io.deadline) throw new CodeReadError('项目扫描超时，请重试');
    if (renamed.has(name) && !changed.has(name) && !dirty.has(name)) continue;
    let stat = null;
    if (io.workspace) {
      // A known path that cannot be safely sampled invalidates the scan. Never
      // silently omit it while claiming a complete, successful file universe.
      stat = liveAllowed.has(name) ? fileHandle(io.workspace, name).stat : null;
      liveStats.set(name, signature(stat)); fingerprints.push([name, signature(stat)]);
    }
    const metadata = index.get(name) ?? head.get(name) ?? old.get(name);
    // Files absent in both endpoints and not dirty are not project files.
    if (io.workspace && !stat && !old.has(name) && !dirty.has(name)) continue;
    const row = { ...emptyRow(name), ...changed.get(name), ...dirty.get(name) };
    delete row.pending_previous;
    row.kind = metadata?.kind ?? (stat?.isSymbolicLink() ? 'symlink' : stat?.isDirectory() ? 'directory' : 'file');
    if (stat) row.kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? metadata?.kind === 'submodule' ? 'submodule' : 'directory' : 'file';
    if (row.untracked && !old.has(name) && io.base) Object.assign(row, { changed: true, status: 'A', added: null, deleted: 0 });
    if (row.untracked && old.has(name) && stat) {
      const current = readWorkspace(io.workspace, name), baseline = old.get(name);
      const oid = current.buffer && createHash(io.format).update(`blob ${current.buffer.length}\0`).update(current.buffer).digest('hex');
      const differs = !oid || oid !== baseline.oid || current.mode !== baseline.mode;
      Object.assign(row, { changed: differs, status: differs ? 'M' : null, added: differs ? null : 0, deleted: differs ? null : 0 });
      stats.delete(name); // Git treats index removal as deletion; the readable untracked file is the actual new endpoint.
    }
    if (row.conflict) row.status = 'U';
    if (row.kind === 'submodule') {
      const a = old.get(name), b = io.workspace ? index.get(name) : head.get(name);
      if (io.workspace && b?.oid !== head.get(name)?.oid) row.staged = true;
      if (io.base && a?.oid !== b?.oid) Object.assign(row, { changed: true, status: a ? b ? 'M' : 'D' : 'A' });
      row.added = row.deleted = null;
    } else if (stats.has(name)) {
      const { binary, ...counts } = stats.get(name); Object.assign(row, counts);
      if (binary && row.kind === 'file') row.kind = 'binary';
    }
    rows.set(name, row);
  }
  await io.verify();
  const serialized = JSON.stringify({ head: io.head, base: io.base, source: io.source, rows: [...rows], fingerprints });
  return { old, head, index, liveAllowed, rows, liveStats, revision: hash(serialized) };
}

/** Byte-bound complete rows; byte pagination uses the same cursor as row pagination. */
export function pageRows(rows, after, limit) {
  const page = []; let bytes = 2;
  const budget = LIMITS.response - 32768; // reserve room for envelope, paths, metadata and RPC framing
  for (let index = after; index < rows.length && page.length < limit; index++) {
    const size = Buffer.byteLength(JSON.stringify(rows[index])) + (page.length ? 1 : 0);
    if (bytes + size > budget) {
      if (!page.length) throw new CodeReadError('单个文件条目超过响应安全大小上限，不能完整列出此页');
      break;
    }
    page.push(rows[index]); bytes += size;
  }
  return page;
}

export function summary(rows) {
  const values = [...rows.values()], selected = values.filter(row => row.changed || pending(row));
  const counts = field => selected.some(row => row[field] === null) ? null : selected.reduce((total, row) => total + row[field], 0);
  return { files_total: values.length, changed_total: values.filter(row => row.changed).length,
    pending_total: values.filter(pending).length, added: counts('added'), deleted: counts('deleted'), conflicts: values.filter(row => row.conflict).length };
}
export function treePage(model, opts) {
  const prefix = opts.path ? opts.path + '/' : '', found = new Map(), query = opts.query.toLocaleLowerCase();
  for (const row of model.rows.values()) {
    if (!row.path.startsWith(prefix) || opts.changed && !(row.changed || pending(row))) continue;
    if (query) {
      if (row.path.toLocaleLowerCase().includes(query)) found.set(row.path, { ...row, name: path.posix.basename(row.path) });
    } else {
      const remainder = row.path.slice(prefix.length), slash = remainder.indexOf('/');
      if (slash < 0) found.set(row.path, { ...row, name: remainder });
      else {
        const name = remainder.slice(0, slash), key = prefix + name;
        const directory = found.get(key) ?? { ...emptyRow(key), name, kind: 'directory' };
        directory.changed ||= row.changed || pending(row); directory.conflict ||= row.conflict; found.set(key, directory);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.kind === 'directory' && b.kind !== 'directory' ? -1 : b.kind === 'directory' && a.kind !== 'directory' ? 1 : compare(a.path, b.path));
}

export function parsePatch(text) {
  const hunks = []; let hunk = null, oldLine = 0, newLine = 0;
  for (const line of text.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      oldLine = Number(match[1]); newLine = Number(match[3]);
      hunk = { old_start: oldLine, old_count: Number(match[2] ?? 1), new_start: newLine, new_count: Number(match[4] ?? 1), lines: [] };
      hunks.push(hunk); continue;
    }
    if (!hunk) continue;
    if (line.startsWith(' ')) hunk.lines.push({ kind: 'context', old_line: oldLine++, new_line: newLine++, text: line.slice(1) });
    else if (line.startsWith('+')) hunk.lines.push({ kind: 'add', old_line: null, new_line: newLine++, text: line.slice(1) });
    else if (line.startsWith('-')) hunk.lines.push({ kind: 'delete', old_line: oldLine++, new_line: null, text: line.slice(1) });
    else if (line.startsWith('\\')) hunk.lines.push({ kind: 'meta', old_line: null, new_line: null, text: line });
  }
  return hunks;
}

export async function patch(io, old, current, context) {
  if (!old.buffer || !current.buffer || old.buffer.length + current.buffer.length > 2 * 1024 * 1024) {
    return { hunks: [], too_large: true, reason: '文件超过差异计算上限，请分段查看原文' };
  }
  const before = path.join(io.root, 'before'), after = path.join(io.root, 'after');
  fs.writeFileSync(before, old.buffer, { mode: 0o600 }); fs.writeFileSync(after, current.buffer, { mode: 0o600 });
  try {
    const output = await io.git(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', `--unified=${context}`, '--', before, after], { codes: [0, 1], max: LIMITS.patch });
    const hunks = parsePatch(output.toString('utf8'));
    if (Buffer.byteLength(JSON.stringify(hunks)) > Math.min(LIMITS.patch, LIMITS.response - 32768)) return { hunks: [], too_large: true, reason: '差异展开后超过响应上限，请分段查看原文' };
    return { hunks, too_large: false, reason: null };
  } catch (error) {
    if (!(error instanceof CodeReadError)) throw error;
    return { hunks: [], too_large: true, reason: error.message + '；可尝试分段查看原文' };
  }
}
