const PREFIX = '#model-sources-diagnostics';
const KEYS = ['period', 'from', 'to', 'connection_id', 'model', 'project_id'];
export function diagnosticsHash(filters = {}) {
  const search = new URLSearchParams();
  for (const key of KEYS) if (filters[key]) search.set(key, filters[key]);
  return PREFIX + (search.size ? `?${search}` : '');
}
export function diagnosticsTarget(hash) {
  if (hash !== PREFIX && !hash.startsWith(`${PREFIX}?`)) return null;
  const search = new URLSearchParams(hash.slice(PREFIX.length + 1));
  return Object.fromEntries(KEYS.filter(key => search.has(key)).map(key => [key, search.get(key)]));
}
export function diagnosticsLink(el, filters = {}, label = '运行诊断') {
  const link = el('a', label, 'nav-link diagnostics-link');
  link.href = `/${diagnosticsHash(filters)}`;
  return link;
}
