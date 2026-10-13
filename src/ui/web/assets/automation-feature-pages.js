// A shared lazy packaging boundary avoids fragmenting the cold startup graph
// for every adapter (the existing 24-JS budget is unchanged). Directory browsing
// never imports it. Settings, records, management and tools retain independent
// rendering, routes and authoritative reads; importing this executes none.
export { renderCompletionAutomation, renderAcceptanceNoticeAutomation, renderConvergenceAutomation } from './automation-completion.js';
export { renderPushAutomation } from './automation-push.js';
// Conditional input remains in the input browser, not the project settings directory.
// Packaging only: management retains its own route, view and lifecycle.
export { openManagement } from './render-management.js';
export { openHookTools } from './render-hooks.js';
