import { check } from '../types.js';
import { LIMITS, CodeReadError, options, isolatedGit, hash, readWorkspace } from './code-io.js';
import { sample, pending, pageRows, summary, treePage, patch } from './code-model.js';

function envelope(task, opts, io = null, model = null) {
  return { version: 1, task_id: task.id, scope: opts.scope, availability: io ? 'available' : 'unavailable',
    reason: io ? !io.base ? '基线对象不可用；只能查看当前文件，不能计算净差异' : io.source === 'commit' ? '工作区已不可用；当前只显示原始已提交版本，不含曾经的未提交内容' : null : null,
    source: io?.source ?? 'none', branch: task.branch ?? null, base_commit: io?.base ?? null, head_commit: io?.head ?? null,
    sampled_at: new Date().toISOString(), revision: model?.revision ?? null, truncated: false };
}
function empty(kind, opts) {
  if (kind === 'state') return { files: [], next: opts.after, has_more: false,
    summary: { files_total: null, changed_total: null, pending_total: null, added: null, deleted: null, conflicts: null } };
  if (kind === 'tree') return { path: opts.path, query: opts.query, entries: [], next: opts.after, has_more: false };
  return { path: opts.path, previous_path: null, kind: 'file', status: null, file_revision: null,
    old: { exists: false, kind: 'file', size: null, mode: null }, new: { exists: false, kind: 'file', size: null, mode: null }, view: opts.view };
}
const activeReads = new WeakMap();
async function read(workspaces, task, raw, kind, body) {
  const opts = options(raw, kind === 'file'); let io, model;
  const active = activeReads.get(workspaces) ?? 0;
  if (active >= 4) return { ...envelope(task, opts), ...empty(kind, opts), reason: '代码读取繁忙，请稍后重试' };
  activeReads.set(workspaces, active + 1);
  try {
    io = await isolatedGit(workspaces, task, opts.scope); model = await sample(io);
    if (opts.revision && opts.revision !== model.revision) throw new CodeReadError('代码采样已变化，请加载最新版本后继续', 'stale');
    const result = { ...envelope(task, opts, io, model), ...await body(io, model, opts) };
    if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.response) throw new CodeReadError('代码响应超过安全大小上限，请缩小读取范围');
    return result;
  } catch (error) {
    if (!(error instanceof CodeReadError)) {
      // Filesystem failure details can contain absolute paths or sensitive environment data.
      if (typeof error.code !== 'string') throw error;
      error = new CodeReadError('文件现场读取失败，可能已被移动、替换或无法访问');
    }
    return { ...envelope(task, opts, io, model), ...empty(kind, opts), availability: error.type,
      reason: error.message, truncated: /上限|超时/.test(error.message) };
  } finally { activeReads.set(workspaces, (activeReads.get(workspaces) ?? 1) - 1); io?.close(); }
}
const missing = () => ({ exists: false, kind: 'file', size: 0, mode: null, buffer: Buffer.alloc(0), signature: 'missing' });
async function blob(io, item) {
  if (!item) return missing();
  const value = { exists: true, kind: item.kind, size: item.size, mode: item.mode };
  if (item.kind === 'submodule') return { ...value, buffer: Buffer.from(item.oid), note: '子模块仅显示登记的提交，不进入子模块目录' };
  if (item.size > LIMITS.blob) return { ...value, buffer: null, note: '文件超过 8 MiB 安全读取上限' };
  return { ...value, buffer: await io.git(['cat-file', 'blob', item.oid], { max: LIMITS.blob }) };
}
function textOf(value) {
  if (!value.buffer) return null;
  try {
    if (value.buffer.includes(0)) { value.kind = 'binary'; return null; }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value.buffer);
  } catch { value.kind = 'binary'; return null; }
}
const metadata = value => ({ exists: value.exists, kind: value.kind, size: value.size, mode: value.mode });

/** User-facing read model only: these methods never alter index, refs or project files. */
export const methods = {
  codeState(task, raw = {}) {
    return read(this, task, raw, 'state', async (io, model, opts) => {
      const all = [...model.rows.values()].filter(row => row.changed || pending(row));
      const files = pageRows(all, opts.after, opts.limit), totals = summary(model.rows);
      if (!io.base) Object.assign(totals, { changed_total: null, added: null, deleted: null });
      if (!io.workspace) totals.pending_total = null;
      return { files, next: opts.after + files.length, has_more: opts.after + files.length < all.length, summary: totals };
    });
  },
  codeTree(task, raw = {}) {
    return read(this, task, raw, 'tree', async (_io, model, opts) => {
      const all = treePage(model, opts), entries = pageRows(all, opts.after, opts.limit);
      return { path: opts.path, query: opts.query, entries, next: opts.after + entries.length, has_more: opts.after + entries.length < all.length };
    });
  },
  codeFile(task, raw = {}) {
    return read(this, task, raw, 'file', async (io, model, opts) => {
      const row = model.rows.get(opts.path);
      check(row, 'file is not in the readable project file set');
      const old = await blob(io, model.old.get(row.previous_path ?? opts.path));
      const current = io.workspace ? model.liveAllowed.has(opts.path) ? readWorkspace(io.workspace, opts.path) : missing() : await blob(io, model.head.get(opts.path));
      if (io.workspace && model.liveStats.get(opts.path) !== current.signature) throw new CodeReadError('文件在读取期间发生变化，请加载最新版本', 'stale');
      if (row.kind === 'submodule' && (current.exists || model.index.get(opts.path)?.kind === 'submodule')) Object.assign(current, { exists: true, kind: 'submodule', mode: '160000', size: null,
        buffer: Buffer.from((io.workspace ? model.index : model.head).get(opts.path)?.oid ?? ''), note: '子模块仅显示登记的提交，不进入子模块目录' });
      const oldText = textOf(old), newText = textOf(current);
      const value = { path: opts.path, previous_path: row.previous_path, kind: current.exists ? current.kind : old.kind,
        status: row.status, old: metadata(old), new: metadata(current), view: opts.view,
        file_revision: old.buffer && current.buffer ? hash(JSON.stringify([metadata(old), metadata(current), hash(old.buffer), hash(current.buffer)])) : null };
      if (opts.view === 'content') {
        const chosen = opts.side === 'old' ? old : current, text = opts.side === 'old' ? oldText : newText;
        if (opts.side === 'old' && !io.base) throw new CodeReadError('基线对象不可用，不能查看基线版本');
        if (text === null) {
          value.content = { side: opts.side, text: '', offset: opts.offset, next_offset: opts.offset, has_more: false, line_start: 1 };
          value.reason = chosen.kind === 'binary' ? '二进制或非 UTF-8 文件仅显示元信息' : chosen.note;
          value.truncated = chosen.kind !== 'binary';
        } else {
          const part = text.slice(opts.offset, opts.offset + opts.limit), before = text.slice(0, opts.offset);
          value.content = { side: opts.side, text: part, offset: opts.offset, next_offset: opts.offset + part.length,
            has_more: opts.offset + part.length < text.length, line_start: before.split('\n').length,
            line_continued: opts.offset > 0 && text[opts.offset - 1] !== '\n' };
          if (!chosen.exists) value.reason = opts.side === 'old' ? '此文件在基线版本中不存在' : '此文件在当前版本中不存在';
          else if (chosen.note) value.reason = chosen.note;
        }
      } else {
        let diff;
        if (!io.base) diff = { hunks: [], too_large: false, reason: '基线对象不可用，不能计算差异' };
        else if ([old.kind, current.kind].some(kind => ['binary', 'symlink', 'submodule', 'directory'].includes(kind))) diff = { hunks: [], too_large: false, reason: '二进制、符号链接、子模块或目录只展示类型、模式与内容元信息，不计算文本差异' };
        else diff = await patch(io, old, current, opts.context);
        const hunks = diff.hunks.slice(opts.offset, opts.offset + opts.limit);
        value.diff = { ...diff, hunks, next_offset: opts.offset + hunks.length, has_more: opts.offset + hunks.length < diff.hunks.length };
        value.truncated = diff.too_large;
      }
      // Recheck both file metadata and Git identities after reading/constructing its response.
      const latest = await sample(io);
      if (latest.revision !== model.revision) throw new CodeReadError('代码在读取期间发生变化，请加载最新版本', 'stale');
      return value;
    });
  },
};
