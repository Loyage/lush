import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, sign, verify } from 'node:crypto';
import { launcherStateDir } from '../host/registry.js';
import { check, isPlainObject } from '../core/types.js';
import { ensurePrivateDirectory, assertPrivateDirectory, assertPrivateFile } from './paths.js';
import { ensureAdministratorDelegation, administratorDelegationPaths } from './delegation.js';
import { normalizeProjectElevation, projectElevationText, projectElevationJSON, PROJECT_ELEVATION_MODE, PROJECT_ELEVATION_SCOPE } from './project-protocol.js';
import { assertManager } from '../core/project/management-auth.js';
import { managementInstruction } from '../core/project/management-data.js';
export const projectElevationHash = value => createHash('sha256').update(value).digest('hex');
function authorityHome(config) {
  return path.join(config.deviceHome || path.join(launcherStateDir(config.env), 'shared'), 'project-elevation-authority');
}
function proofText(value) { return JSON.stringify(projectElevationJSON(value)); }

/** Only the authenticated Host password gate calls this; no password or grant signer enters a model. */
export function signProjectElevation(config, definition, userBinding, now = Date.now()) {
  check(typeof config.project === 'string' && path.isAbsolute(config.project) && fs.realpathSync(config.project) === config.project, 'canonical elevation project required');
  check(typeof userBinding === 'string' && /^[a-f0-9]{64}$/.test(userBinding), 'trusted Web session binding required');
  const normalized = normalizeProjectElevation(definition), home = authorityHome(config);
  ensurePrivateDirectory(home);
  const request = { version: 1, project: config.project, definition: normalized, definition_hash: projectElevationHash(projectElevationText(normalized)),
    grant_id: randomUUID(), session_hash: projectElevationHash(`project-elevation:${userBinding}`), issued_at: now, expires_at: now + 300000 };
  const { privateKey } = ensureAdministratorDelegation(home);
  return { request, signature: sign(null, Buffer.from(proofText(request)), privateKey).toString('base64url') };
}
export function verifyProjectElevation(config, proof, now = Date.now()) {
  check(isPlainObject(proof) && Object.keys(proof).sort().join(',') === 'request,signature', 'signed elevation proof required');
  const { request, signature } = proof;
  check(isPlainObject(request) && Object.keys(request).sort().join(',') === 'definition,definition_hash,expires_at,grant_id,issued_at,project,session_hash,version', 'invalid elevation proof fields');
  check(request.version === 1 && request.project === config.project, 'elevation proof project mismatch');
  check(typeof request.grant_id === 'string' && /^[a-f0-9-]{36}$/.test(request.grant_id) && /^[a-f0-9]{64}$/.test(request.session_hash), 'invalid elevation proof identity');
  check(Number.isSafeInteger(request.issued_at) && Number.isSafeInteger(request.expires_at) && request.issued_at <= now + 5000
    && request.expires_at > now && request.expires_at <= request.issued_at + 300000, 'elevation proof expired');
  const definition = normalizeProjectElevation(request.definition);
  check(request.definition_hash === projectElevationHash(projectElevationText(definition)), 'elevation proof content changed');
  const home = authorityHome(config); assertPrivateDirectory(home);
  const publicPath = administratorDelegationPaths(home).publicKey; assertPrivateFile(publicPath);
  const fd = fs.openSync(publicPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let publicKey;
  try { check(fs.fstatSync(fd).size <= 8192, 'invalid elevation public key'); publicKey = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
  check(typeof signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(signature)
    && verify(null, Buffer.from(proofText(request)), publicKey, Buffer.from(signature, 'base64url')), 'elevation proof signature rejected');
  return { definition, grant_id: request.grant_id, definition_hash: request.definition_hash, verified_at: new Date(now).toISOString() };
}

/** Active native invocation plus immutable private occurrence and code-owned accepted Event. */
export function assertProjectElevatedInvocation(project, actorId) {
  const { task, state } = assertManager(project, actorId), occurrence = state.pending_signal, elevation = occurrence?.elevation;
  check(elevation?.version === 1 && elevation.mode === PROJECT_ELEVATION_MODE && elevation.scope === PROJECT_ELEVATION_SCOPE
    && elevation.project === project.config.project && elevation.occurrence_id === occurrence.id
    && elevation.instruction_hash === projectElevationHash(managementInstruction(project, task, state)), 'this management input has no project elevation');
  const source = project.store.get("SELECT task_id,data FROM events WHERE id=? AND type='management.elevation_accepted'", elevation.source_event_id);
  const accepted = source ? JSON.parse(source.data) : null;
  check(source?.task_id === task.id && accepted?.grant_id === elevation.grant_id && accepted.occurrence_id === occurrence.id
    && accepted.definition_hash === elevation.definition_hash && accepted.instruction_hash === elevation.instruction_hash,
  'project elevation lacks its accepted user-password event');
  return { task, state, elevation, run: project.running.get(task.id) };
}
