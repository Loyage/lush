import { api, action, projectApi } from './api.js';
import { editableDraft, draftOptions, updateDraft, emitDraft } from './draft-editor.js';
import { emissionRequestId } from './emission-form.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function draftValues(record) {
  return { content: record.content, references: record.references || [], mode: record.mode || 'order',
    ...(record.mode === 'management' ? { target_id: record.target_id ?? null }
      : record.mode === 'append' ? { target_id: record.target_id } : { branch: record.branch }),
    ...draftOptions(record) };
}

/** One session per workspace entry, independent of the portable/detail DOM host.
 * Creation retries retain the ORIGINAL definition/key, including across browser recovery.
 * A single queue owns saves, leave-autosaves and exact-version authorization.
 */
export function createInputSession({ entry, read, current, changed, authorize, accepted, editVersion = () => null }) {
  const scope = projectApi('/api/');
  const live = () => current() && projectApi('/api/') === scope;
  const dirty = () => !entry.saved || !same(draftValues(entry.saved), read());
  function notify() { if (live()) changed(); }
  async function persist() {
    if (!live()) throw Error('编辑身份已切换，未发送请求。');
    if (entry.conflict) throw Error('版本冲突尚未整理，请读取最新版并明确选择整理方式。');
    while (dirty()) {
      const values = read();
      if (!values.content.trim()) throw Error('草稿正文不能为空；编辑仍保留。');
      if (values.mode !== 'order' && values.references.length) throw Error('追加和管理不支持引用附件；请先显式移除，原文保留。');
      try {
        if (!entry.saved) {
          entry.creation ||= { client_request_id: emissionRequestId(), values };
          notify(); // persist the exact creation identity BEFORE crossing the transport boundary
          const original = entry.creation.values;
          const result = await action('draft.add', { ...original, client_request_id: entry.creation.client_request_id }, { refresh: false });
          if (result?.kind !== 'draft' || !Number.isSafeInteger(result.id) || typeof result.content !== 'string' || !Array.isArray(result.references)
            || !Number.isSafeInteger(result.revision) || result.revision < 1)
            throw Error('创建响应没有可靠版本，请用原创建请求核验，不会换 key 重建。');
          entry.saved = result; entry.creation = null;
          if (!editableDraft(result) || !same(draftValues(result), original)) {
            entry.conflict = { revision: result.revision, latest: result };
            throw Error('原创建已被其它编辑更新或授权；本地内容保留，请对照返回版本显式整理。');
          }
        } else entry.saved = await updateDraft(entry.saved, values);
      } catch (error) {
        entry.error = error.message;
        // Do not retry optimistic conflicts against a newer revision automatically.
        if (/revision|版本|conflict/i.test(error.message)) entry.conflict ||= { revision: entry.saved?.revision };
        notify(); throw error;
      }
      entry.error = null; notify();
      if (!live()) return entry.saved;
      // Edits made during transport remain local and are saved in the SAME draft.
    }
    entry.error = null;
    return entry.saved;
  }
  function run(operation, kind = 'save') {
    if (entry.operation) return Promise.reject(Error('当前草稿正在确认删除，不能并发保存或提交。'));
    if (entry.flight) return entry.flight;
    const flight = Promise.resolve().then(operation);
    entry.flight = flight; entry.flightKind = kind; notify();
    return flight.finally(() => { if (entry.flight === flight) { entry.flight = null; entry.flightKind = null; } notify(); });
  }
  async function submit() {
      if (entry.consumed) throw Error('此输入已提交，请查看真实收据，不重复授权。');
      const saved = await persist();
      if (!live()) return;
      const values = read(), version = editVersion();
      const result = authorize ? await authorize(saved) : await emitDraft(saved, entry.profile, entry.request ||= {});
      if (!result) return; // password confirmation cancelled; saved draft remains editable
      entry.consumed = result; entry.error = null;
      if (live()) await accepted(result, same(version, editVersion()) && same(values, read()), saved);
      return result;
  }
  return { entry, dirty, get busy() { return Boolean(entry.flight); },
    save: () => run(persist),
    submit: () => {
      if (entry.pendingSubmit) return entry.pendingSubmit;
      if (entry.flight && entry.flightKind === 'save') {
        // One explicit authorization can queue behind autosave; repeated shortcuts share it.
        entry.pendingSubmit = entry.flight.then(() => run(submit, 'submit')).finally(() => { entry.pendingSubmit = null; });
        return entry.pendingSubmit;
      }
      return run(submit, 'submit');
    },
    async latest() {
      if (!entry.saved || entry.flight || !live()) return;
      const latest = await api(`/api/input/draft/${entry.saved.id}`);
      if (!live()) return;
      entry.conflict = { ...entry.conflict, latest }; notify();
      return latest;
    },
    reconcile(keepLocal) {
      const latest = entry.conflict?.latest;
      if (!latest || !editableDraft(latest) || entry.flight || !live()) return null;
      entry.saved = latest; entry.conflict = null; entry.error = null; notify();
      return keepLocal ? null : latest;
    },
  };
}
