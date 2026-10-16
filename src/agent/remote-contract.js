import { PROTOCOL_VERSION } from '../runner/protocol.js';

export const REMOTE_BRIDGE_VERSION = 1;
export const REMOTE_PI_VERSION = '1.0.4'; // Verified public SDK contract, not a permissive semver guess.
export const REMOTE_IDENTITY_KEYS = Object.freeze(['project_id', 'node_id', 'runner_id', 'worker_id', 'workspace_id', 'generation', 'run_id']);
export const REMOTE_RUNNER_METHODS = Object.freeze(['file.context', 'file.read', 'file.edit', 'file.write',
  'command.start', 'command.status', 'command.output', 'command.cancel', 'workspace.barrier']);
const string = { type: 'string' }, integer = { type: 'integer', minimum: 1 };
const optional = properties => ({ type: 'object', properties, additionalProperties: false });
const schema = (properties, required) => ({ ...optional(properties), required });
const ack = { type: 'string', description: 'Current workspace_context fingerprint; omit to use the rules supplied at invocation startup.' };
export const REMOTE_TOOLS = Object.freeze([
  { name: 'read', description: 'Read a remote workspace file or image. Text offset is a 1-based line number; bounded to 2000 lines / 50 KiB. No local filesystem fallback.',
    parameters: schema({ path: string, offset: integer, limit: integer, expected_sha256: string }, ['path']) },
  { name: 'edit', description: 'Apply exact unique non-overlapping edits against the original remote file, atomically. Rules must be acknowledged.',
    parameters: schema({ path: string, edits: { type: 'array', minItems: 1, maxItems: 256,
      items: schema({ oldText: { type: 'string', minLength: 1 }, newText: string }, ['oldText', 'newText']) }, context_ack: ack }, ['path', 'edits']) },
  { name: 'write', description: 'Create or replace a remote UTF-8 file. Creates parent directories. Never writes local control files.',
    parameters: schema({ path: string, content: string, context_ack: ack }, ['path', 'content']) },
  { name: 'bash', description: 'Run shell only in the remote code workspace; wait for real stop and bounded output. Use the dedicated lushc tool for collaboration, NOT shell lushc. Never executes locally.',
    parameters: schema({ command: string, timeout: { type: 'number', exclusiveMinimum: 0 }, context_ack: ack }, ['command']) },
  { name: 'workspace_context', description: 'Read current remote AGENTS rules (including nested scopes) and their context_ack fingerprint before mutations.', parameters: schema({}, []) },
  { name: 'lushc', description: 'Restricted CENTRAL collaboration CLI. Supply argv (without lushc); no shell expansion, project override or management commands. --questions-file accepts only control:questionnaire.',
    parameters: schema({ argv: { type: 'array', items: string, minItems: 1, maxItems: 128 } }, ['argv']) },
  { name: 'control', description: 'Read an allowlisted CENTRAL startup/skill resource by logical id; or write this Worker questionnaire JSON with id questionnaire. No arbitrary local paths.',
    parameters: schema({ action: { enum: ['read', 'write'] }, id: string, content: string, offset: { type: 'integer', minimum: 0 }, limit: integer }, ['action', 'id']) },
].map(tool => Object.freeze(tool)));
export const REMOTE_TOOL_NAMES = Object.freeze(REMOTE_TOOLS.map(tool => tool.name));
export function sameRemoteIdentity(a, b) {
  return Boolean(a && b && REMOTE_IDENTITY_KEYS.every(key => a[key] === b[key])
    && Object.keys(a).length === REMOTE_IDENTITY_KEYS.length && Object.keys(b).length === REMOTE_IDENTITY_KEYS.length);
}
/** Public, secret-free descriptor accepted ONLY by explicit Provider.run({remote_workspace}).
 * {version:1, runner_protocol:1, pi_version:'1.0.4', socket:absolute local restricted socket,
 *  identity:{project_id,node_id,runner_id,worker_id,workspace_id,generation,run_id}, path:absolute remote code path}.
 * cwd remains the central control directory. No clients, leases, machine/control/Run secrets here.
 */
export function assertRemoteDescriptor(value, taskId, runId) {
  if (!value || Object.keys(value).some(key => !['version', 'runner_protocol', 'pi_version', 'socket', 'identity', 'path'].includes(key))
    || value.version !== REMOTE_BRIDGE_VERSION || value.runner_protocol !== PROTOCOL_VERSION || value.pi_version !== REMOTE_PI_VERSION
    || typeof value.socket !== 'string' || !value.socket.startsWith('/') || value.socket.includes('\0')
    || typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.includes('\0')
    || !sameRemoteIdentity(value.identity, value.identity)
    || ['project_id', 'node_id', 'runner_id', 'workspace_id'].some(key => typeof value.identity[key] !== 'string' || !value.identity[key] || value.identity[key].length > 256)
    || ['worker_id', 'generation', 'run_id'].some(key => !Number.isSafeInteger(value.identity[key]) || value.identity[key] <= 0)
    || value.identity.worker_id !== taskId || value.identity.run_id !== runId) throw new Error('Unsupported remote workspace descriptor or invocation identity');
}
