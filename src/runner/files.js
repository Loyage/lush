import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { LIMITS, OPERATIONS, check, fail, hash, identifier, integer } from './protocol.js';
import { WorkspaceFiles, relativeFile, fileError, signature } from './files-posix.js';
import { readContext, checkContext } from './files-context.js';

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;
const utf8 = buffer => {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { fail('INVALID_REQUEST', 'File is not valid UTF-8 text'); }
};
function imageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0,4).toString('ascii') === 'RIFF' && buffer.subarray(8,12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 2 && buffer.subarray(0,2).toString('ascii') === 'BM') return 'image/bmp';
  return null;
}
function expected(value, { optional = false } = {}) {
  check(optional && value === undefined || value === null || typeof value === 'string' && digestPattern.test(value),
    'INVALID_REQUEST', 'expected_sha256 must be a SHA-256 digest, or null for a new file');
}
function withFile(ctx, name, callback, { create = false } = {}) {
  const parts = relativeFile(name), io = new WorkspaceFiles(ctx.workspace);
  try {
    const parent = io.directory(parts.slice(0, -1), create);
    const handle = io.open(parent, parts.at(-1));
    return callback({ io, parts, parent, handle });
  } catch (error) { fileError(error); }
  finally { io.close(); }
}
function validatePaging(params, defaultLimit, maxLimit) {
  const offset = integer(params.offset ?? 0, 'offset', 0);
  const limit = integer(params.limit ?? defaultLimit, 'limit', 1, maxLimit);
  expected(params.expected_sha256, { optional: true });
  if (offset) check(typeof params.expected_sha256 === 'string', 'INVALID_REQUEST', 'Continuation reads require expected_sha256');
  return { offset, limit };
}
function readFile(ctx, params) {
  return withFile(ctx, params.path, ({ io, parts, parent, handle }) => {
    check(handle, 'NOT_FOUND', 'File does not exist');
    const buffer = io.read(handle, LIMITS.file_bytes), sha256 = hash(buffer);
    expected(params.expected_sha256, { optional: true });
    if (params.expected_sha256 !== undefined) check(params.expected_sha256 === sha256, 'STALE', 'File content version changed');
    const format = params.format ?? 'auto';
    check(['auto', 'text', 'base64'].includes(format), 'INVALID_REQUEST', 'Invalid file read format');
    const mime = imageMime(buffer);
    let text = null;
    if (format !== 'base64' && !(format === 'auto' && mime)) {
      try { text = utf8(buffer); }
      catch (error) { if (format === 'text') throw error; }
      if (text?.includes('\0')) { if (format === 'text') fail('INVALID_REQUEST', 'Binary file cannot be read as text'); text = null; }
    }
    let content, offset, next, total;
    if (text !== null) {
      const page = validatePaging(params, 16000, LIMITS.output_chunk_bytes);
      offset = page.offset; total = text.length;
      check(offset <= total, 'INVALID_REQUEST', 'Offset is beyond file content');
      check(!(offset > 0 && offset < total && /[\uDC00-\uDFFF]/.test(text[offset]) && /[\uD800-\uDBFF]/.test(text[offset-1])),
        'INVALID_REQUEST', 'Offset splits a UTF-16 surrogate pair');
      next = Math.min(total, offset + page.limit);
      if (next < total && /[\uD800-\uDBFF]/.test(text[next-1]) && /[\uDC00-\uDFFF]/.test(text[next])) next--;
      if (next === offset && offset < total) next = Math.min(total, offset + 2);
      content = { encoding: 'utf8', unit: 'utf16', text: text.slice(offset, next), mime_type: 'text/plain' };
    } else {
      const page = validatePaging(params, mime ? LIMITS.file_bytes : LIMITS.output_chunk_bytes, LIMITS.file_bytes);
      offset = page.offset; total = buffer.length;
      check(offset <= total, 'INVALID_REQUEST', 'Offset is beyond file content');
      next = Math.min(total, offset + page.limit);
      content = { encoding: 'base64', unit: 'byte', data: buffer.subarray(offset, next).toString('base64'), mime_type: mime ?? 'application/octet-stream' };
    }
    io.verifyNamed(parent, parts.at(-1), handle); io.verifyParent(parts.slice(0, -1), parent);
    return { path: params.path, size: buffer.length, sha256, ...content, offset, next_offset: next,
      truncated: next < total, complete: offset === 0 && next === total };
  });
}
function replacementBuffer(params) {
  check(typeof params.content === 'string', 'INVALID_REQUEST', 'write requires string content');
  const encoding = params.encoding ?? 'utf8';
  check(encoding === 'utf8' || encoding === 'base64', 'INVALID_REQUEST', 'Invalid write encoding');
  check(Buffer.byteLength(params.content) <= 2 * LIMITS.file_bytes, 'LIMIT_EXCEEDED', 'Write content exceeds budget');
  const buffer = Buffer.from(params.content, encoding === 'base64' ? 'base64' : 'utf8');
  check(encoding !== 'base64' || buffer.toString('base64') === params.content, 'INVALID_REQUEST', 'Invalid canonical base64 content');
  check(buffer.length <= LIMITS.file_bytes, 'LIMIT_EXCEEDED', 'Write exceeds file budget');
  return buffer;
}
function editedBuffer(buffer, edits) {
  const text = utf8(buffer);
  check(!text.includes('\0'), 'INVALID_REQUEST', 'Cannot edit a binary file');
  check(Array.isArray(edits) && edits.length > 0 && edits.length <= 256, 'INVALID_REQUEST', 'Expected 1–256 edits');
  let budget = 0;
  const ranges = edits.map(edit => {
    check(edit && typeof edit.oldText === 'string' && edit.oldText.length > 0 && typeof edit.newText === 'string',
      'INVALID_REQUEST', 'Each edit needs non-empty oldText and string newText');
    budget += Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText);
    check(budget <= 2 * LIMITS.file_bytes, 'LIMIT_EXCEEDED', 'Edit input exceeds budget');
    const start = text.indexOf(edit.oldText);
    check(start >= 0 && text.indexOf(edit.oldText, start + 1) === -1, 'CONFLICT', 'oldText must match exactly once in the original file');
    return { start, end: start + edit.oldText.length, replacement: edit.newText };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) check(ranges[i-1].end <= ranges[i].start, 'CONFLICT', 'Edits must not overlap in the original file');
  let output = '', end = 0;
  for (const range of ranges) { output += text.slice(end, range.start) + range.replacement; end = range.end; }
  const result = Buffer.from(output + text.slice(end), 'utf8');
  check(result.length <= LIMITS.file_bytes, 'LIMIT_EXCEEDED', 'Edited file exceeds budget');
  return result;
}
function mutateFile(ctx, params, edit) {
  expected(params.expected_sha256);
  checkContext(ctx, params); // Recheck after the dispatcher's awaited precondition boundary.
  const provided = edit ? null : replacementBuffer(params);
  return withFile(ctx, params.path, ({ io, parts, parent, handle }) => {
    check(!edit || handle, 'NOT_FOUND', 'File does not exist');
    const original = handle ? io.read(handle, LIMITS.file_bytes) : null;
    check(params.expected_sha256 === (original ? hash(original) : null), 'CONFLICT', 'File content precondition did not match');
    const replacement = edit ? editedBuffer(original, params.edits) : provided;
    io.replace(parent, parts.at(-1), replacement, handle, () => {
      // No asynchronous gap between final authorization/path/version checks and atomic publication.
      ctx.node.authorize(ctx.request, OPERATIONS[ctx.request.method], ctx.session_id);
      checkContext(ctx, params);
      io.verifyParent(parts.slice(0, -1), parent);
      io.verifyNamed(parent, parts.at(-1), handle);
      if (handle) check(signature(fs.fstatSync(handle.fd, { bigint: true })) === signature(handle.stat), 'STALE', 'File changed before replacement');
    });
    return { path: params.path, size: replacement.length, sha256: hash(replacement), replaced: Boolean(handle) };
  }, { create: !edit && params.expected_sha256 === null });
}
function registerArtifact(ctx, params) {
  identifier(params.artifact_id, 'artifact_id');
  relativeFile(params.path);
  check(typeof params.sha256 === 'string' && digestPattern.test(params.sha256), 'INVALID_REQUEST', 'Artifact digest is required');
  integer(params.size, 'size', 0, MAX_ARTIFACT_BYTES);
  const ttl_ms = integer(params.ttl_ms ?? 86400000, 'ttl_ms', 1000, 7 * 86400000);
  return withFile(ctx, params.path, ({ io, parts, parent, handle }) => {
    check(handle && handle.stat.size === BigInt(params.size), 'STALE', 'Artifact size does not match');
    const digest = createHash('sha256'), scratch = Buffer.alloc(LIMITS.output_chunk_bytes);
    let position = 0;
    while (position < params.size) {
      const count = fs.readSync(handle.fd, scratch, 0, Math.min(scratch.length, params.size - position), position);
      check(count > 0, 'STALE', 'Artifact changed while registering');
      digest.update(scratch.subarray(0, count)); position += count;
    }
    check(digest.digest('hex') === params.sha256 && signature(fs.fstatSync(handle.fd, { bigint: true })) === signature(handle.stat),
      'STALE', 'Artifact digest does not match');
    io.verifyNamed(parent, parts.at(-1), handle); io.verifyParent(parts.slice(0, -1), parent);
    ctx.node.authorize(ctx.request, OPERATIONS[ctx.request.method], ctx.session_id);
    return ctx.store.transaction(() => {
      const previous = ctx.store.db.query('SELECT * FROM artifacts WHERE artifact_id=?').get(params.artifact_id);
      if (previous) {
        check(previous.workspace_key === ctx.workspace.workspace_key && previous.relative_path === params.path
          && previous.digest === params.sha256 && previous.size === params.size, 'CONFLICT', 'Artifact ID already identifies another object');
        return { artifact_id: previous.artifact_id, sha256: previous.digest, size: previous.size, expires_at: previous.expires_at };
      }
      const expires_at = Date.now() + ttl_ms;
      ctx.store.db.query('INSERT INTO artifacts (artifact_id,workspace_key,relative_path,digest,size,expires_at) VALUES (?,?,?,?,?,?)')
        .run(params.artifact_id, ctx.workspace.workspace_key, params.path, params.sha256, params.size, expires_at);
      return { artifact_id: params.artifact_id, sha256: params.sha256, size: params.size, expires_at };
    });
  });
}
function readArtifact(ctx, params) {
  identifier(params.artifact_id, 'artifact_id');
  check(params.path === undefined, 'INVALID_REQUEST', 'Artifacts are addressed by registered ID, not path');
  const artifact = ctx.store.db.query('SELECT * FROM artifacts WHERE artifact_id=?').get(params.artifact_id);
  check(artifact && artifact.workspace_key === ctx.workspace.workspace_key, 'NOT_FOUND', 'Artifact is not registered for this workspace');
  check(artifact.expires_at > Date.now(), 'NOT_FOUND', 'Artifact retention expired');
  check(Number.isSafeInteger(artifact.size) && artifact.size >= 0 && artifact.size <= MAX_ARTIFACT_BYTES && digestPattern.test(artifact.digest),
    'LIMIT_EXCEEDED', 'Artifact metadata or size is outside the supported bound');
  const { offset, limit } = validatePaging(params, LIMITS.output_chunk_bytes, LIMITS.output_chunk_bytes);
  if (params.expected_sha256 !== undefined) check(params.expected_sha256 === artifact.digest, 'STALE', 'Artifact version changed');
  check(offset <= artifact.size, 'INVALID_REQUEST', 'Offset is beyond artifact content');
  return withFile(ctx, artifact.relative_path, ({ io, parts, parent, handle }) => {
    check(handle && handle.stat.size === BigInt(artifact.size), 'STALE', 'Registered artifact size changed');
    const digest = createHash('sha256'), scratch = Buffer.alloc(LIMITS.output_chunk_bytes);
    const next = Math.min(artifact.size, offset + limit), page = Buffer.alloc(next - offset);
    let position = 0;
    while (position < artifact.size) {
      const count = fs.readSync(handle.fd, scratch, 0, Math.min(scratch.length, artifact.size - position), position);
      check(count > 0, 'STALE', 'Registered artifact was truncated');
      digest.update(scratch.subarray(0, count));
      const start = Math.max(position, offset), end = Math.min(position + count, next);
      if (start < end) scratch.copy(page, start - offset, start - position, end - position);
      position += count;
    }
    check(digest.digest('hex') === artifact.digest && signature(fs.fstatSync(handle.fd, { bigint: true })) === signature(handle.stat),
      'STALE', 'Registered artifact digest changed');
    io.verifyNamed(parent, parts.at(-1), handle); io.verifyParent(parts.slice(0, -1), parent);
    check(artifact.expires_at > Date.now(), 'NOT_FOUND', 'Artifact retention expired during read');
    return { artifact_id: artifact.artifact_id, sha256: artifact.digest, size: artifact.size, encoding: 'base64', unit: 'byte',
      data: page.toString('base64'), offset, next_offset: next, truncated: next < artifact.size, complete: offset === 0 && next === artifact.size };
  });
}

export function createFileService() {
  return {
    'file.read': readFile,
    'file.write': (ctx, params) => mutateFile(ctx, params, false),
    'file.edit': (ctx, params) => mutateFile(ctx, params, true),
    'file.context': readContext,
    'artifact.register': registerArtifact,
    'artifact.read': readArtifact,
    check_context: checkContext,
  };
}
