import { check } from './types.js';

function gitPath(value) {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) return null;
  const bytes = [], escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '\\': 92, '"': 34 };
  for (let i = 1; i < value.length - 1; i++) {
    if (value[i] !== '\\') {
      const point = String.fromCodePoint(value.codePointAt(i)); bytes.push(...Buffer.from(point)); i += point.length - 1; continue;
    }
    const escape = value[++i];
    if (Object.hasOwn(escapes, escape)) bytes.push(escapes[escape]);
    else if (/^[0-3][0-7]{2}$/.test(value.slice(i, i + 3))) { bytes.push(parseInt(value.slice(i, i + 3), 8)); i += 2; }
    else return null;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); } catch { return null; }
}

// Bounded metadata, never a second copy of dirty contents. Unsupported status/path forms,
// staged/deleted/ignored directories or oversized files conservatively have no dirty proof.
export async function runnerDirtyManifest(client, branch, head, guard = () => {}) {
  const status = async () => {
    guard();
    const result = await client.call('workspace.git.inspect', { require_no_lease: true, steps: [
      { argv: ['symbolic-ref', '--short', 'HEAD'], expect: branch },
      { argv: ['rev-parse', '--verify', 'HEAD'], expect: head },
      { argv: ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'] },
    ] });
    guard();
    check(Array.isArray(result.results) && typeof result.results[2] === 'string', 'Runner status evidence is incomplete');
    return result.results[2];
  };
  const before = await status();
  if (!before) return Object.create(null); // No file reads introduce an additional sampling gap.
  const paths = before.split('\n');
  // The existing bounded Git channel trims stdout. Distinguish first-line worktree M
  // from staged M (two spaces); ambiguous whitespace paths remain unsupported.
  if (paths[0]?.startsWith('M ') && !paths[0].startsWith('M  ')) paths[0] = ' ' + paths[0];
  if (paths.length > 256) return null;
  const manifest = Object.create(null);
  for (const entry of paths) {
    if (!['?? ', ' M ', '!! '].includes(entry.slice(0, 3))) return null;
    const path = gitPath(entry.slice(3));
    if (!path || path.trim() !== path || path.endsWith('/') || path.includes('\\') || /[\x00-\x1f]/.test(path)) return null;
    guard();
    let file;
    try { file = await client.call('file.read', { path, limit: 1 }); }
    catch (error) {
      if (['LIMIT_EXCEEDED', 'UNSUPPORTED', 'NOT_FOUND', 'INVALID_REQUEST'].includes(error.code)) return null;
      throw error;
    }
    guard();
    check(/^[a-f0-9]{64}$/.test(file.sha256), 'Runner content digest is missing');
    manifest[path] = file.sha256;
  }
  return await status() === before ? manifest : null;
}
