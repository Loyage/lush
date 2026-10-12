// Focused list API; implementation stays with DOM primitives to avoid an extra
// cross-page startup chunk. Paging, native links and actions remain caller-owned.
export { listSurface, listEntry } from './dom.js';
