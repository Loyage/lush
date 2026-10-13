/** Display type is independent of historical development roles. */
export const isValet = work => work?.role === 'manager' || work?.task_kind === 'management';
export const workType = work => isValet(work) ? 'valet' : 'worker';
export const workTypeLabel = work => isValet(work) ? 'Valet' : 'Worker';
export function validWorkNumber(value) {
  return typeof value === 'string' && value.length <= 2048
    && /^(?:W[1-9]\d*(?:-[1-9]\d*)*|V[1-9]\d*)$/.test(value)
    && value.slice(1).split('-').every(segment => Number.isSafeInteger(Number(segment)));
}
