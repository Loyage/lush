/** In-memory full-document history. Only changed fields are published, never a read projection. */
export const DASHBOARD_FIELDS = ['cards', 'hidden_projects', 'layout', 'content', 'account_view', 'widgets', 'diagnostics', 'quick_actions'];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function dashboardPatch(base, next) {
  return Object.fromEntries(DASHBOARD_FIELDS.filter(key => !equal(base[key], next[key])).map(key => [key, structuredClone(next[key])]));
}
export function createDashboardHistory(initial) {
  let entries = [structuredClone(initial)], index = 0;
  return {
    push(value) {
      if (equal(entries[index], value)) return false;
      entries = entries.slice(0, index + 1); entries.push(structuredClone(value)); index++;
      return true;
    },
    undo() { if (index > 0) index--; return structuredClone(entries[index]); },
    redo() { if (index < entries.length - 1) index++; return structuredClone(entries[index]); },
    get canUndo() { return index > 0; },
    get canRedo() { return index < entries.length - 1; },
  };
}
