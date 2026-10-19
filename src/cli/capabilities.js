/** Pure protocol contracts shared by offline CLI help and the public catalogue. */
import { AUTOMATION_CAPABILITIES } from '../core/hook-registration.js';
import { MERGE_CONDITION_CAPABILITIES } from '../core/merge-conditions.js';
import { WORKER_QUERY_CAPABILITIES } from '../core/worker-query.js';
import { CONTEXT_CAPABILITIES } from '../core/worker-context.js';
import { MANAGEMENT_RECEIPT_CAPABILITIES } from '../core/management-diagnostic.js';
import { INPUT_EMIT_CAPABILITY } from '../core/input-emission-protocol.js';
export const CLI_CAPABILITIES = Object.freeze({ ...AUTOMATION_CAPABILITIES, ...MERGE_CONDITION_CAPABILITIES,
  ...WORKER_QUERY_CAPABILITIES, ...CONTEXT_CAPABILITIES, ...MANAGEMENT_RECEIPT_CAPABILITIES, 'input.emit': INPUT_EMIT_CAPABILITY });
