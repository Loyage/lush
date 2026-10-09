/** Safe text-only project identity, available even when the project daemon is offline. */
export function setProjectIdentity(name = '', project = '') {
  const label = String(name || project.split(/[\\/]/).filter(Boolean).at(-1) || '');
  if (globalThis.document) document.title = label ? `${label} · Lush` : 'Lush';
  const node = globalThis.document?.getElementById('project');
  if (node && label) { node.textContent = label; node.title = project; }
}
