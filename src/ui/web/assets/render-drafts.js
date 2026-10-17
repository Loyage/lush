import { $, button, el } from './dom.js';
import { absolute, relative } from './format.js';
import { action } from './api.js';
import { show } from './messages.js';
import { syncComposer } from './composer.js';
import { refresh } from './navigate.js';
import { locateReference, locatable } from './context-references.js';
import { ui } from './state.js';
import { agentHelp } from './help.js';

/* ---------- 待提交意图（底部 composer 面板） ---------- */
// Keep acknowledged revisions across late overview snapshots, scoped to this boot/document.
let session = null;
function draftSession() {
  if (session?.owner !== document || session?.boot !== ui.workerNumbers)
    session = { owner: document, boot: ui.workerNumbers, acknowledged: new Map(), pending: new Set() };
  return session;
}
const currentSession = state => state === session && state.owner === document && state.boot === ui.workerNumbers;
async function refreshAfterAck(state, message) {
  if (!currentSession(state)) return;
  const view = ui.view;
  try {
    await refresh();
    if (currentSession(state) && ui.view === view && ui.offline) show(`${message}，但页面更新失败；请稍后刷新，不要重复提交。`, 'error');
  } catch (error) {
    if (currentSession(state) && ui.view === view) show(`${message}，但页面更新失败：${error.message}；请稍后刷新，不要重复提交。`, 'error');
  }
}
function reconcileDraft(state, draft) {
  const ack = state.acknowledged.get(draft.id);
  if (!ack) return draft;
  if (ack.emitted) {
    // Only a newer, explicitly cancelled emission can become editable again.
    if (draft.dispatch?.state !== 'cancelled' || !(draft.revision > ack.draft.revision)) return null;
    state.acknowledged.set(draft.id, { draft }); return draft;
  }
  if (draft.revision > ack.draft.revision) { ack.draft = draft; return draft; }
  return ack.draft;
}
/** 点一条草稿就地编辑：Enter / 失焦保存，Esc 取消；轮询不重建正在编辑的那条。 */
function startDraftEdit(draft, item, state) {
  if (!currentSession(state) || state.pending.has(draft.id) || state.acknowledged.get(draft.id)?.emitted
    || item.parentNode !== $('drafts') || ui.draftEditing !== null) return;
  const body = item.querySelector('.goal');
  if (!body) return;
  const box = document.createElement('textarea');
  box.className = 'draft-edit';
  box.value = draft.content;
  box.rows = Math.min(10, Math.max(2, Math.ceil(draft.content.length / 40) + 1));
  let done = false, pending = false;
  const active = () => currentSession(state) && item.parentNode === $('drafts');
  const finish = () => { if (active()) { ui.draftEditing = null; ui.draftSignature = null; } };
  const cancel = () => {
    if (done || pending || !active()) return;
    done = true; finish(); box.remove(); item.append(body);
  };
  const save = async () => {
    if (done || pending || !active()) return;
    const value = box.value.trim();
    if (!value) { show('草稿不能为空', 'error'); box.focus?.(); return; }
    if (value === draft.content) { cancel(); return; }
    pending = true; state.pending.add(draft.id); box.disabled = true;
    let saved = null;
    try {
      // Omission preserves the persisted environment, including old absent fields.
      const result = await action('draft.update', { id: draft.id, content: value, expected_revision: draft.revision }, { refresh: false });
      if (result?.id !== draft.id || !Number.isSafeInteger(result.revision) || result.revision <= (draft.revision ?? 0)
        || typeof result.content !== 'string' || !Array.isArray(result.references)) throw new Error('保存响应缺少可靠草稿版本，请核对历史输入；原文保留，不会自动重试。');
      saved = result; done = true;
      state.acknowledged.set(draft.id, { draft: saved }); finish();
    } catch (error) { if (active()) show(error.message, 'error'); }
    finally { pending = false; state.pending.delete(draft.id); box.disabled = done; }
    if (saved) {
      // Replace old controls immediately, before any read can fail or arrive late.
      if (active()) { const next = draftItem(saved, state); item.parentNode.insertBefore(next, item); item.remove(); }
      void refreshAfterAck(state, '草稿已保存');
    }
  };
  box.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    else if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) { event.preventDefault(); save(); }
  });
  box.addEventListener('blur', save);
  ui.draftEditing = draft.id;
  body.remove();
  item.append(box);
  // Focus after the node is in the document, then drop the caret at the end so a tap lands
  // inside the text instead of on a blank box; preventScroll keeps the mobile viewport put.
  box.focus?.({ preventScroll: true });
  try { box.setSelectionRange?.(box.value.length, box.value.length); } catch { /* unsupported */ }
}
function draftItem(draft, state) {
  const item = el('article', undefined, 'draft');
  item.dataset.id = draft.id;
  const row = el('span', undefined, 'row');
  const writable = () => currentSession(state) && item.parentNode === $('drafts') && !state.pending.has(draft.id)
    && !state.acknowledged.get(draft.id)?.emitted && ui.draftEditing !== draft.id;
  const run = button('发送', async () => {
    if (!writable()) return;
    state.pending.add(draft.id); run.disabled = true;
    let acknowledged = false;
    try {
      const result = await action('input.emit', { draft_id: draft.id, expected_revision: draft.revision }, { refresh: false });
      if (result?.emitted !== true || result.draft_id !== draft.id) throw new Error('提交响应缺少可靠草稿收据，请核对历史输入；原文保留，不会自动重试。');
      acknowledged = true;
      state.acknowledged.set(draft.id, { emitted: true, draft: { ...draft, revision: result.revision ?? draft.revision } });
      if (currentSession(state) && item.parentNode === $('drafts')) {
        ui.draftSignature = null;
        item.replaceChildren(el('p', `草稿 #${draft.id} 已提交，等待安全准入；不代表 Worker 已创建。`, 'hint'), el('p', draft.content, 'goal'));
      }
    } catch (error) { if (currentSession(state) && item.parentNode === $('drafts')) show(error.message, 'error'); }
    finally { state.pending.delete(draft.id); run.disabled = acknowledged; }
    if (acknowledged) void refreshAfterAck(state, '草稿已提交');
  }, 'run', { agent: true, help: agentHelp(`只发送草稿 #${draft.id}，不触碰输入框或其它草稿。`) });
  run.setAttribute('aria-label', `发送草稿 #${draft.id}`);
  const runHost = el('span', undefined, 'help-host'); runHost.setAttribute('data-help', run.getAttribute('data-help')); runHost.append(run);
  const edit = button('编辑', () => { if (writable()) startDraftEdit(draft, item, state); }, 'edit');
  edit.setAttribute('aria-label', `编辑待提交意图 #${draft.id}`);
  const drop = button('移除', () => writable() && action('draft.remove', { id: draft.id, expected_revision: draft.revision }), 'drop');
  drop.setAttribute('aria-label', `从待提交意图里移除 #${draft.id}`);
  drop.setAttribute('data-help', '从待提交意图里移除这条输入（已提交的输入不可删）');
  row.append(el('span', '○', 'dot c-queued'), el('span', `#${draft.id}`, 'tid'), el('span', '待规划'),
    el('span', relative(draft.created_at), 'when'), runHost, edit, drop);
  const body = el('span', draft.content, 'goal');
  body.title = '点击就地编辑这条待提交意图';
  body.onclick = () => { if (writable()) startDraftEdit(draft, item, state); };
  item.append(row, body);
  if (draft.references?.length) {
    const references = el('div', undefined, 'draft-references');
    draft.references.forEach((reference, index) => {
      const chip = el('span', undefined, 'draft-reference');
      const canLocate = locatable(reference);
      const label = canLocate ? button(reference.label, () => locateReference(reference), 'draft-reference-label') : el('span', reference.label);
      label.setAttribute('data-help', canLocate ? `${reference.quote}\n点击定位到来源` : reference.quote);
      const remove = button('×', () => writable() && action('draft.update', { id: draft.id, content: draft.content, expected_revision: draft.revision,
        references: draft.references.filter((_value, at) => at !== index) }), 'context-remove');
      remove.setAttribute('aria-label', `从待提交意图 #${draft.id} 移除引用：${reference.label}`);
      remove.setAttribute('data-help', '从这条待提交意图移除该引用，不改动输入原文');
      chip.append(label, remove); references.append(chip);
    });
    item.append(references);
  }
  item.title = `${draft.content}\n加入于 ${absolute(draft.created_at)}`;
  return item;
}
export function renderDrafts(data) {
  const state = draftSession();
  const drafts = (data.drafts || []).map(draft => reconcileDraft(state, draft)).filter(Boolean);
  ui.draftIds = drafts.map(draft => draft.id);
  $('draft-count').textContent = drafts.length ? `${drafts.length} 条` : '空';
  // 正在编辑的那条不重建：replaceChildren 会摘掉 textarea，把光标和未保存的内容一起冲掉。
  // 轮询在编辑期间只更新条数；保存 / 取消会把 draftSignature 归空，那时再重建。
  if (state.pending.size) { syncComposer(); return; }
  const live = new Set(ui.draftIds);
  if (ui.draftEditing !== null) {
    if (live.has(ui.draftEditing)) { syncComposer(); return; }
    ui.draftEditing = null;
  }
  // 只在内容变化时重建，否则轮询会把滚动和正在输入的光标丢掉。
  const signature = drafts.map(draft => `${draft.id}:${draft.revision}:${draft.content}:${JSON.stringify(draft.references || [])}`).join('\u0000');
  if (signature === ui.draftSignature) { syncComposer(); return; }
  ui.draftSignature = signature;
  $('drafts').replaceChildren(...drafts.map(draft => draftItem(draft, state)));
  syncComposer();
}
