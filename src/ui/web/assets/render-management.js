// Compatibility export only: the independent settings UI has been retired.
export async function openManagement() {
  const { openRetiredManagement } = await import('./retired-pages.js');
  return openRetiredManagement();
}
