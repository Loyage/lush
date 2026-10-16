import { check } from '../../core/types.js';
import { RUNNER_METHODS, validateRunnerParams, publicRunnerResult } from '../../rpc/runner-methods.js';
import { readPrivateJson } from '../private-json.js';
import { exact, option } from '../args.js';

export async function run(command, args, { client }) {
  check(!client.token, 'Runner management is user only');
  const method = Object.keys(RUNNER_METHODS).find(method => RUNNER_METHODS[method].cli.split(' ').slice(1).every((part, index) => args[index] === part));
  check(method, 'unknown Runner command');
  const spec = RUNNER_METHODS[method];
  args.splice(0, spec.cli.split(' ').length - 1);
  let params = {};
  if (spec.file) {
    const file = option(args, '--file');
    exact(args, 0); check(file && file !== '-', 'Runner changes require --file with a bounded owner-only JSON file');
    params = readPrivateJson(file, 'Runner', 128 * 1024);
  } else if (method === 'runner.worker.reconcile') {
    const revision = option(args, '--expected-revision');
    exact(args, 1);
    check(/^[1-9][0-9]*$/.test(args[0]) && typeof revision === 'string' && /^[1-9][0-9]*$/.test(revision), 'Worker id and --expected-revision N are required');
    params = { id: Number(args[0]), expected_revision: Number(revision) };
  } else if (method === 'runner.ssh.test') {
    exact(args, 1); params = { ssh_alias: args[0] };
  } else if (method === 'runner.nodes.check') {
    const project_id = option(args, '--project-id');
    exact(args, 1); params = { node_id: args[0], ...(project_id === null ? {} : { project_id }) };
  } else exact(args, 0);
  validateRunnerParams(method, params);
  // Never read-back/retry a mutation automatically: its response is the acknowledgement.
  return publicRunnerResult(await client.request(method, params), method);
}
