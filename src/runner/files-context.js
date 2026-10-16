import { posixFiles } from '../core/workspaces/code-posix.js';
import { LIMITS, check, fail, hash, stable } from './protocol.js';
import { WorkspaceFiles, relativeFile, fileError } from './files-posix.js';

const MAX_ENTRIES = 20000, MAX_DEPTH = 128;
const ignored = name => ['.git', '.lush'].includes(name.toLowerCase());
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Path scope means the ancestors of a target file. Empty path means root rules only. */
export function readContext(ctx, params = {}) {
  const scope = params.scope ?? 'path';
  check(scope === 'path' || scope === 'workspace', 'INVALID_REQUEST', 'Invalid context scope');
  const target = params.path ?? '';
  const parts = relativeFile(target, { root: true });
  check(scope !== 'workspace' || target === '', 'INVALID_REQUEST', 'Workspace context requires empty path');
  const io = new WorkspaceFiles(ctx.workspace);
  const files = []; let total = 0, entries = 0;
  const addRules = (directory, components) => {
    for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
      const handle = io.open(directory, name);
      if (!handle) continue;
      try {
        const buffer = io.read(handle, LIMITS.context_bytes);
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
        catch { fail('INVALID_REQUEST', 'Project rules must be UTF-8 text'); }
        check(!content.includes('\0'), 'INVALID_REQUEST', 'Project rules must be text');
        const item = { path: [...components, name].join('/'), content, sha256: hash(buffer) };
        total += Buffer.byteLength(JSON.stringify(item));
        check(total <= LIMITS.context_bytes, 'LIMIT_EXCEEDED', 'Project rules exceed context budget', { max_bytes: LIMITS.context_bytes });
        io.verifyNamed(directory, name, handle);
        files.push(item);
      } finally { io.release(handle.fd); }
      break; // A present override, even empty, replaces AGENTS.md at that directory.
    }
    io.verifyParent(components, directory);
  };
  const scan = (directory, components) => {
    check(components.length <= MAX_DEPTH, 'LIMIT_EXCEEDED', 'Project context directory depth exceeds budget');
    addRules(directory, components);
    const children = [];
    io.entries(directory, entry => {
      check(++entries <= MAX_ENTRIES, 'LIMIT_EXCEEDED', 'Project context scan exceeds entry budget', { max_entries: MAX_ENTRIES });
      if (!ignored(entry.name) && entry.isDirectory()) children.push(entry.name);
    });
    children.sort(compare);
    for (const name of children) {
      const child = io.own(posixFiles.openAt(directory, name, true));
      try { scan(child, [...components, name]); } finally { io.release(child); }
    }
    io.verifyParent(components, directory);
  };
  try {
    if (scope === 'workspace') scan(io.root, []);
    else {
      addRules(io.root, []);
      let directory = io.root;
      const ancestors = parts.slice(0, -1);
      for (let i = 0; i < ancestors.length; i++) {
        let child;
        try { child = io.own(posixFiles.openAt(directory, ancestors[i], true)); }
        catch (error) { if (error.code === 'ENOENT') break; throw error; }
        if (directory !== io.root) io.release(directory);
        directory = child;
        addRules(directory, ancestors.slice(0, i + 1));
      }
    }
    return { scope, path: target, files, fingerprint: hash(stable({ workspace_key: ctx.workspace.workspace_key,
      scope, path: target, files: files.map(({ path, sha256 }) => ({ path, sha256 })) })), complete: true };
  } catch (error) { fileError(error); }
  finally { io.close(); }
}

export function checkContext(ctx, params) {
  const command = ctx.request.method === 'command.start';
  const context = readContext(ctx, command ? { scope: 'workspace', path: '' } : { scope: 'path', path: params.path });
  check(typeof params.context_ack === 'string' && params.context_ack === context.fingerprint,
    'CONTEXT_REQUIRED', 'Read and acknowledge the current project rules before mutating this scope', context);
  return context;
}
