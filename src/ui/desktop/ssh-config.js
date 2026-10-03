import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

// A static picker, not an SSH interpreter: never run ssh -G, Match exec or ProxyCommand.
// OpenSSH resolves the selected alias during the existing, explicit connection workflow.
function words(text) {
  const result = []; let word = '', quote = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && /[\s"'\\#]/.test(text[i + 1] ?? '')) { word += text[++i]; continue; }
    if (quote) { if (char === quote) quote = null; else word += char; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === '#') break;
    else if (/\s/.test(char)) { if (word) { result.push(word); word = ''; } }
    else word += char;
  }
  if (quote) return null;
  if (word) result.push(word);
  return result;
}
function globMatcher(pattern) {
  if (pattern.length > 255) return null;
  const tokens = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' || char === '?') tokens.push(char);
    else if (char === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) return null;
      const content = pattern.slice(i + 1, end);
      if (!content || /[\\[]/.test(content)) return null;
      try { tokens.push(new RegExp(`^[${content.startsWith('!') ? '^' + content.slice(1) : content}]$`)); }
      catch { return null; }
      i = end;
    } else tokens.push({ literal: char });
  }
  // Bounded dynamic programming, rather than a backtracking regex for repeated stars.
  return name => {
    let previous = Array(name.length + 1).fill(false); previous[0] = true;
    for (const token of tokens) {
      const next = Array(name.length + 1).fill(false);
      next[0] = token === '*' && previous[0];
      for (let i = 1; i <= name.length; i++) next[i] = token === '*'
        ? previous[i] || next[i - 1]
        : previous[i - 1] && (token === '?' || token.literal === name[i - 1] || token instanceof RegExp && token.test(name[i - 1]));
      previous = next;
    }
    return previous[name.length];
  };
}

/** Read only local user config and Include files; expose aliases, never config text or secrets. */
export function readSSHConfig({ home = os.homedir() } = {}) {
  const root = path.join(home, '.ssh'), hosts = [], aliases = new Set(), visited = new Set(), warnings = new Set();
  let bytes = 0, entries = 0, files = 0, stopped = false;
  const warn = message => warnings.add(message);
  const limit = () => { stopped = true; warn('SSH 配置超过读取上限，列表可能不完整；仍可手动填写 Host 别名。'); };
  function expand(pattern) {
    if (pattern.length > 4096 || /[\x00-\x1f\x7f]/.test(pattern)) { warn('已跳过无效的 Include 路径。'); return []; }
    if (pattern === '~') pattern = home;
    else if (/^~[/\\]/.test(pattern)) pattern = path.join(home, pattern.slice(2));
    else if (pattern.startsWith('~') || pattern.includes('$') || pattern.includes('%')) {
      warn('部分 Include 使用动态路径或其它用户目录，未展开；仍可手动填写 Host 别名。'); return [];
    }
    const absolute = path.resolve(root, pattern), parsed = path.parse(absolute);
    const parts = absolute.slice(parsed.root.length).split(path.sep);
    if (parts.length > 32) { limit(); return []; }
    let candidates = [parsed.root];
    for (const part of parts) {
      if (!/[*?[]/.test(part)) { candidates = candidates.map(parent => path.join(parent, part)); continue; }
      const matcher = globMatcher(part);
      if (!matcher) { warn('已跳过无效的 Include 通配符。'); return []; }
      const next = [];
      for (const parent of candidates) {
        let directory;
        try { directory = fs.opendirSync(parent); }
        catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) warn('部分 Include 目录无法读取，列表可能不完整。'); continue; }
        try {
          let entry;
          while ((entry = directory.readSync())) {
            if (++entries > 4096) { limit(); break; }
            if ((!entry.name.startsWith('.') || part.startsWith('.')) && matcher(entry.name)) next.push(path.join(parent, entry.name));
          }
        } finally { directory.closeSync(); }
        if (stopped) return [];
      }
      candidates = next.sort();
    }
    return candidates;
  }
  function visit(filename, depth = 0) {
    if (stopped) return;
    if (depth > 16 || ++files > 128) { limit(); return; }
    let fd;
    try {
      // Nonblocking open avoids hanging on a FIFO. Symlinks are allowed (e.g. Nix-managed config).
      fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) { warn('已跳过非普通 SSH 配置文件。'); return; }
      const canonical = fs.realpathSync(filename);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      if (stat.size > 256 * 1024 || bytes + stat.size > 1024 * 1024) { limit(); return; }
      // Bound the read even if the file grows after stat.
      const buffer = Buffer.alloc(256 * 1024 + 1);
      let size = 0, read;
      while (size < buffer.length && (read = fs.readSync(fd, buffer, size, buffer.length - size, null))) size += read;
      bytes += size;
      if (size > 256 * 1024 || bytes > 1024 * 1024) { limit(); return; }
      for (const line of buffer.subarray(0, size).toString('utf8').split(/\r?\n/)) {
        const match = /^\s*(Host|Include)(?:\s*=\s*|\s+)(.*)$/i.exec(line);
        if (!match) continue;
        const values = words(match[2]);
        if (!values) { warn('部分 SSH 配置行的引号不完整，已跳过。'); continue; }
        if (match[1].toLowerCase() === 'include') {
          for (const pattern of values) for (const file of expand(pattern)) visit(file, depth + 1);
        } else for (const alias of values) {
          if (!ALIAS.test(alias) || aliases.has(alias)) continue;
          if (hosts.length >= 512) { limit(); break; }
          aliases.add(alias); hosts.push({ alias });
        }
        if (stopped) break;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') warn('部分本机 SSH 配置无法读取，列表可能不完整；仍可手动填写 Host 别名。');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  visit(path.join(root, 'config'));
  return { hosts, warnings: [...warnings] };
}
