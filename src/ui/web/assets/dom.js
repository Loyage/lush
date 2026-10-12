// Single shared UI foundation. Leaf implementations depend on dom-base, not this
// barrel, so modules/search/lists share startup packaging without circular imports.
export * from './dom-base.js';
export { enhanceModule, revealModule, observeModules, disposeModules } from './shared-module.js';
export { captureModuleReading, restoreModuleReading } from './module-reading.js';
export { pageModules, pageBlocks, replacePageContent, disposePageModules } from './page-modules.js';
