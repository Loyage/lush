import { api, action } from './api.js';
import { emissionRequestId } from './emission-form.js';

/** Shared by the draft page and the reading-page composer. Never infer editability from a preview alone. */
export function editableDraft(record) {
  return record?.kind === 'draft' && Number.isSafeInteger(record.id) && record.id > 0
    && (record.revision === null || Number.isSafeInteger(record.revision) && record.revision > 0)
    && !record.input_id && !record.hook_mount && (!record.dispatch || record.dispatch.state === 'cancelled')
    && (!record.status || ['draft', 'cancelled'].includes(record.status))
    && (!record.mode || ['order', 'append'].includes(record.mode));
}
export function draftOptions(record) {
  return { conditions: (record.conditions || []).map(({ kind, worker_id }) => ({ kind, ...(worker_id == null ? {} : { worker_id }) })), exclusive: Boolean(record.exclusive) };
}
export function matchesDraft(record, { mode, target_id, parent_id, branch }) {
  return (record.mode || 'order') === mode && (mode === 'append' ? record.target_id === target_id
    : parent_id != null && record.parent_id === parent_id && record.branch === branch);
}
/** Walk the complete server-filtered result, not just the first page. An interrupted read is not an empty result. */
export async function matchingDrafts(target, current = () => true) {
  const items = [], seen = new Set(); let cursor = null;
  do {
    const query = new URLSearchParams({ view: 'drafts', modes: JSON.stringify([target.mode]), limit: '100', ...(cursor ? { cursor } : {}) });
    const page = await api(`/api/inputs?${query}`);
    if (!current()) return null;
    if (!Array.isArray(page.items)) throw new Error('暂存列表格式不兼容');
    items.push(...page.items.filter(item => editableDraft(item) && matchesDraft(item, target)));
    cursor = page.next_cursor;
    if (cursor && seen.has(cursor)) throw new Error('暂存分页重复，未能查完；请稍后重试');
    seen.add(cursor);
  } while (cursor);
  return items;
}
export async function updateDraft(saved, values) {
  if (!editableDraft(saved)) throw new Error('草稿已授权、已发送或版本未知；本地编辑保留，请核验草稿状态');
  if (!values.content?.trim()) throw new Error('草稿正文不能为空。');
  if ((values.mode || saved.mode) === 'append' && values.references?.length) throw new Error('追加指令暂不支持引用附件；原文和引用已保留。');
  const previous = { ...saved };
  const updated = await action('draft.update', { id: saved.id, ...values, expected_revision: saved.revision }, { refresh: false });
  const mode = values.mode || previous.mode || 'order';
  const sameTarget = (updated.mode || 'order') === mode && (mode === 'append'
    ? updated.target_id === (values.target_id ?? previous.target_id)
    : updated.branch === (values.branch ?? previous.branch) && (values.branch != null || updated.parent_id === previous.parent_id));
  if (updated.id !== previous.id || !editableDraft(updated) || !sameTarget || !Number.isSafeInteger(updated.revision) || updated.revision <= (previous.revision ?? 0)
    || typeof updated.content !== 'string' || !Array.isArray(updated.references))
    throw new Error('保存响应缺少可靠草稿版本；本地编辑保留，请核验服务器状态，不会自动覆盖');
  return updated;
}
export async function emitDraft(saved, profile, request) {
  if (!editableDraft(saved)) throw new Error('草稿不可编辑或已授权，请先核验状态。');
  const definition = JSON.stringify([saved.id, saved.revision, profile]);
  if (request.requestDefinition !== definition) { request.requestDefinition = definition; request.requestId = emissionRequestId(); }
  const result = await action('input.emit', { draft_id: saved.id, expected_revision: saved.revision,
    client_request_id: request.requestId, ...(profile ? { profile } : {}) }, { refresh: false });
  if (result.emitted !== true || result.draft_id !== saved.id) throw new Error('提交响应缺少可靠草稿收据，请核验历史输入与服务版本，不会自动重试。');
  return result;
}
