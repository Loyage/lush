// Keep the retired RPC's strict outer parameter list for historical clients/receipts.
// There is deliberately no executable install schema or combined authorization capability.
import { check } from './types.js';
export const HOOK_INSTALL_PARAMETERS = Object.freeze(['id','command','hook','expected_revisions','client_request_id']);
export function validateHookInstallation() {
  check(false, 'hooks.install is retired; first hooks.register, then separately request worker.hook_attach with registered id and explicit version');
}
