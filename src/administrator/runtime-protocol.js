/** Runtime wire vocabulary shared with the fixed model bridge; no daemon registry imports. */
export const ADMINISTRATOR_RPC = Object.freeze({
  status: 'administrator.status', list: 'administrator.list', detail: 'administrator.detail',
  preview: 'administrator.preview', commit: 'administrator.commit', receipt: 'administrator.receipt', stop: 'administrator.stop',
  shutdown: 'administrator.shutdown', toolCatalog: 'tool.catalog', toolCall: 'tool',
});
export const ADMINISTRATOR_TOOL_RPC = Object.freeze([ADMINISTRATOR_RPC.toolCatalog, ADMINISTRATOR_RPC.toolCall]);
export const ADMINISTRATOR_MAX_RESULT_BYTES = 256 * 1024;
