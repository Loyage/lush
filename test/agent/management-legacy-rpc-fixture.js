import { managementToolCLI } from './management-tool-cli-fixture.js';
/** Retained RPC/receipt compatibility, explicitly NOT the model callable surface.
 * New CLI behavior must use managementToolCLI directly with lush_cli argv plans.
 */
export function managementLegacyRPCProvider(root, runtime, options = {}) {
  return managementToolCLI(root, runtime, { ...options, compatibilityRPCPlans: true });
}
