/** Display identity only. URLs, RPC parameters and references always keep the internal id. */
export function draftLabel(record) {
  if (Number.isSafeInteger(record?.draft_number) && record.draft_number > 0) return `草稿 #${record.draft_number}`;
  const id = record?.id ?? record?.draft_id;
  return Number.isSafeInteger(id) && id > 0 ? `草稿记录 #${id}` : '草稿记录（编号未知）';
}
