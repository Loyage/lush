import { check } from './types.js';
import { runnerIdentity, RUNNER_BINDING_KEYS } from './runner-service.js';
import { OPERATIONS, hash } from '../runner/protocol.js';

export function toolOutcome(receipt, result) {
  const method = receipt.data.method;
  if (method.startsWith('file.')) {
    check(typeof result?.path === 'string' && hash(result.path) === receipt.data.path_hash && /^[a-f0-9]{64}$/.test(result.sha256), 'Runner file receipt is incomplete');
    return { state: 'completed', evidence: { verified: true, digest: result.sha256 } };
  }
  const execution_id = result?.execution_id ?? receipt.data.execution_id;
  check(typeof execution_id === 'string' && execution_id.length > 0, 'Runner command receipt is incomplete');
  return { state: result.stop_confirmed === true ? 'stopped' : 'acknowledged', evidence: {
    verified: true, execution_id, stopped: result.stop_confirmed === true,
    ...(typeof result.output_complete === 'boolean' ? { output_complete: result.output_complete } : {}),
  } };
}
export function runnerToolJournal(project, identity, authorization_version) {
  const store = project.store;
  const update = (receipt, patch) => {
    const current = store.runnerReceipt(receipt.request_id);
    if (current.terminal) return current;
    return store.updateRunnerReceipt({ ...identity, request_id: receipt.request_id }, patch, current.revision);
  };
  return {
    prepare(request) {
      check(OPERATIONS[request.method]?.tool_effect && [...RUNNER_BINDING_KEYS, 'run_id'].every(key => request.identity[key] === identity[key]),
        'Unsupported journal operation or changed Run identity');
      const { method, params } = request;
      return store.createRunnerReceipt({ ...identity, request_id: request.request_id, authorization_version,
        kind: 'tool', params_hash: request.fingerprint, data: { method,
          ...(method.startsWith('file.') ? { path_hash: hash(params.path), expected_sha256: params.expected_sha256 } : {}),
          ...(method === 'command.cancel' ? { execution_id: params.execution_id } : {}),
        } });
    },
    acknowledge(receipt, result) { return update(receipt, toolOutcome(receipt, result)); },
    reject(receipt) { return update(receipt, { state: 'rejected', evidence: { verified: true } }); },
    uncertain(receipt) {
      // A prepared row is already a durable barrier if this write also fails. Never send
      // another tool effect to compensate for any persistence failure.
      try { if (receipt) update(receipt, { state: 'unknown', error_code: 'tool_outcome_unknown' }); }
      finally {
        const binding = store.runnerBinding(identity.worker_id);
        if (RUNNER_BINDING_KEYS.every(key => binding[key] === identity[key]) && !['unknown', 'removed'].includes(binding.state)) store.markRunnerWorkspaceUnknown(runnerIdentity(binding), binding.revision);
      }
    },
    stopped(execution_id, status) {
      check(status.stop_confirmed === true, 'Runner command has not stopped');
      for (const row of store.all("SELECT request_id FROM runner_receipts WHERE run_id=? AND kind='tool' AND terminal=0", identity.run_id)) {
        const receipt = store.runnerReceipt(row.request_id);
        if (receipt.state !== 'unknown' && receipt.evidence?.execution_id === execution_id)
          update(receipt, { state: 'stopped', evidence: { verified: true, stopped: true, execution_id,
            ...(typeof status.output_complete === 'boolean' ? { output_complete: status.output_complete } : {}) } });
      }
    },
  };
}
