import { id } from '../../core/types.js';

const parse = value => JSON.parse(value);
const rows = (store, sql, ...params) => store.all(sql, ...params).map(row => ({ ...row, reference: parse(row.payload) }));

/** Input / Draft 的结构化引用元数据；它们是所属输入的附件，不是独立业务实体。 */
export const references = {
  setDraftReferences(draftId, values) {
    const owner = id(draftId);
    this.run('DELETE FROM draft_references WHERE draft_id=?', owner);
    values.forEach((reference, ordinal) => this.run(
      'INSERT INTO draft_references(draft_id,ordinal,payload) VALUES (?,?,?)', owner, ordinal + 1, JSON.stringify(reference)));
  },
  draftReferences(draftId) {
    return rows(this, 'SELECT ordinal,payload FROM draft_references WHERE draft_id=? ORDER BY ordinal', id(draftId))
      .map(row => row.reference);
  },
  /** values: [{ segment, reference }]; segment 是批量输入中对应的用户段落序号。 */
  setInputReferences(inputId, values) {
    const owner = id(inputId);
    this.run('DELETE FROM input_references WHERE input_id=?', owner);
    const ordinals = new Map();
    for (const value of values) {
      const segment = Number(value.segment) || 1;
      const ordinal = (ordinals.get(segment) || 0) + 1;
      ordinals.set(segment, ordinal);
      this.run('INSERT INTO input_references(input_id,segment,ordinal,payload) VALUES (?,?,?,?)',
        owner, segment, ordinal, JSON.stringify(value.reference));
    }
  },
  inputReferences(inputId) {
    return rows(this, 'SELECT segment,ordinal,payload FROM input_references WHERE input_id=? ORDER BY segment,ordinal', id(inputId))
      .map(row => ({ segment: row.segment, ...row.reference }));
  },
  referencesForDrafts(draftIds) {
    const result = new Map();
    for (const draftId of draftIds) result.set(Number(draftId), this.draftReferences(draftId));
    return result;
  },
};
