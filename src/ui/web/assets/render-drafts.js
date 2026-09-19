import { $, button, el } from './dom.js';
import { absolute, relative } from './format.js';
import { action } from './api.js';
import { syncComposer } from './composer.js';
import { refresh } from './navigate.js';
import { draftUnchecked, ui } from './state.js';

/* ---------- 待提交意图（底部 composer 面板） ---------- */
/** 点一条草稿就地编辑：Enter / 失焦保存，Esc 取消；轮询不重建正在编辑的那条。 */
function startDraftEdit(draft) {
  if (ui.draftEditing !== null) return;
  const item = $('drafts').querySelector(`[data-id="${draft.id}"]`);
  const body = item?.querySelector('.goal');
  if (!item || !body) return;
  const box = document.createElement('textarea');
  box.className = 'draft-edit';
  box.value = draft.content;
  box.rows = Math.min(10, Math.max(2, Math.ceil(draft.content.length / 40) + 1));
  let done = false;
  const finish = () => { ui.draftEditing = null; ui.draftSignature = null; };
  const cancel = () => { if (done) return; done = true; finish(); refresh(); };
  const save = async () => {
    if (done) return;
    const value = box.value.trim();
    if (!value) { $('error').textContent = '草稿不能为空'; box.focus?.(); return; }
    done = true; finish();
    if (value === draft.content) { await refresh(); return; }
    try { await action('draft.update', { id: draft.id, content: value }); }
    catch (error) { $('error').textContent = error.message; await refresh(); }
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
  box.focus?.();
}
function draftItem(draft) {
  const item = el('article', undefined, 'draft');
  item.dataset.id = draft.id;
  const row = el('span', undefined, 'row');
  const pick = document.createElement('input');
  pick.type = 'checkbox'; pick.className = 'pick';
  pick.checked = !draftUnchecked.has(draft.id);
  pick.setAttribute('aria-label', `选中待提交意图 #${draft.id} 一起提交`);
  pick.title = '勾选后「提交并规划」只提交选中的；不勾的继续留在待提交意图里';
  pick.onchange = () => { if (pick.checked) draftUnchecked.delete(draft.id); else draftUnchecked.add(draft.id); syncComposer(); };
  const edit = button('编辑', () => startDraftEdit(draft), 'edit');
  edit.setAttribute('aria-label', `编辑待提交意图 #${draft.id}`);
  const drop = button('移除', () => action('draft.remove', { id: draft.id }), 'drop');
  drop.setAttribute('aria-label', `从待提交意图里移除 #${draft.id}`); drop.title = '从待提交意图里移除这条输入（已提交的输入不可删）';
  row.append(pick, el('span', '○', 'dot c-queued'), el('span', `#${draft.id}`, 'tid'), el('span', '待规划'),
    el('span', relative(draft.created_at), 'when'), edit, drop);
  const body = el('span', draft.content, 'goal');
  body.title = '点击就地编辑这条待提交意图';
  body.onclick = () => startDraftEdit(draft);
  item.append(row, body);
  item.title = `${draft.content}\n加入于 ${absolute(draft.created_at)}`;
  return item;
}
export function renderDrafts(data) {
  const drafts = data.drafts || [];
  ui.draftIds = drafts.map(draft => draft.id);
  $('draft-count').textContent = drafts.length ? `${drafts.length} 条` : '空';
  // 被提交或移除的草稿不再保留勾选/编辑态。
  const live = new Set(ui.draftIds);
  for (const draftId of [...draftUnchecked]) if (!live.has(draftId)) draftUnchecked.delete(draftId);
  // 正在编辑的那条不重建：replaceChildren 会摘掉 textarea，把光标和未保存的内容一起冲掉。
  // 轮询在编辑期间只更新勾选态；保存 / 取消会把 draftSignature 归空，那时再重建。
  if (ui.draftEditing !== null) {
    if (live.has(ui.draftEditing)) { syncComposer(); return; }
    ui.draftEditing = null;
  }
  // 只在内容变化时重建，否则轮询会把滚动和正在输入的光标丢掉。
  const signature = drafts.map(draft => `${draft.id}:${draft.content}`).join('\u0000');
  if (signature === ui.draftSignature) { syncComposer(); return; }
  ui.draftSignature = signature;
  $('drafts').replaceChildren(...drafts.map(draftItem));
  syncComposer();
}
