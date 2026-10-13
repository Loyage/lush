import { check } from '../types.js';
import { graphOID, encodeGraphToken, decodeGraphToken, withGraphReader, parseGraph } from './version-graph.js';

export function workerSnapshot(workspaces, token, id, delivery, kind = 'snapshot') {
  const value = decodeGraphToken(workspaces, token);
  check(value.kind === `worker.version.${kind}` && value.id === id
    && (delivery === undefined || value.delivery === delivery)
    && (value.delivery === null || Number.isSafeInteger(value.delivery) && value.delivery > 0)
    && ['current', 'delivery', 'main'].includes(value.scope)
    && (value.tip === null || graphOID(value.tip)) && (value.base === null || graphOID(value.base))
    && Array.isArray(value.exclude) && value.exclude.length <= 2 && value.exclude.every(graphOID)
    && Number.isSafeInteger(value.event_max) && value.event_max >= 0,
  'version graph cursor or snapshot belongs to a different scope; refresh the graph');
  if (kind === 'cursor') check(Number.isSafeInteger(value.offset) && value.offset > 0, 'invalid version graph cursor');
  return value;
}
const format = '--format=%H%x00%P%x00%s%x00%an%x00%cI%x00';
export async function currentWorkerRange(workspaces, { branch, parent, base, parent_evidence = [] }, deadline) {
  return withGraphReader(workspaces, async read => {
    const refs = (await read.identity(['for-each-ref', '--format=%(refname)%00%(objectname)', `refs/heads/${branch}`, `refs/heads/${parent}`])).split('\n');
    const ref = name => refs.find(line => line.startsWith(`refs/heads/${name}\0`))?.split('\0')[1] ?? null;
    const tip = ref(branch), parent_tip = ref(parent);
    if (tip === null) return null;
    check(graphOID(tip) && graphOID(parent_tip) && graphOID(base), 'current Worker graph is not traceable: missing fixed refs or baseline');
    await read.git(['merge-base', '--is-ancestor', base, tip]);
    await read.git(['cat-file', '-e', `${parent_tip}^{commit}`]);
    for (const evidence of parent_evidence) {
      check(graphOID(evidence), 'current Worker graph is not traceable: invalid parent evidence');
      const ancestors = (await read.git(['merge-base', '--all', evidence, parent_tip], { codes: [0, 1] })).toString().trim().split('\n');
      check(ancestors.includes(evidence), 'current Worker graph is not traceable: parent ref no longer contains fixed parent evidence');
    }
    return { tip, base, exclude: [...new Set([base, parent_tip])] };
  }, deadline);
}
export async function workerGraphPage(workspaces, value, offset, limit, deadline) {
  check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'version graph limit must be 1..100');
  const commits = value.tip === null ? [] : await withGraphReader(workspaces, async read => {
    const rows = parseGraph(await read.git(['log', '--topo-order', '--no-show-signature', '--no-notes', '--no-decorate', '--encoding=UTF-8',
      `--skip=${offset}`, `--max-count=${limit + 1}`, format, value.tip, ...value.exclude.map(sha => `^${sha}`), '--']));
    return rows;
  }, deadline);
  const has_more = commits.length > limit;
  const snapshot = encodeGraphToken(workspaces, { ...value, kind: 'worker.version.snapshot' });
  return { ...value, snapshot, commits: commits.slice(0, limit), has_more,
    cursor: has_more ? encodeGraphToken(workspaces, { ...value, kind: 'worker.version.cursor', offset: offset + limit }) : null };
}
export async function workerGraphCommit(workspaces, value, commit) {
  check(graphOID(commit), 'version graph commit must be a full object ID');
  check(value.tip !== null, 'commit is outside the version graph snapshot');
  return withGraphReader(workspaces, async read => {
    const ancestor = async (a, b) => (await read.git(['merge-base', '--all', a, b], { codes: [0, 1] }))
      .toString('utf8').trim().split('\n').includes(a);
    check(await ancestor(commit, value.tip), 'commit is outside the version graph snapshot');
    for (const excluded of value.exclude) check(!await ancestor(commit, excluded), 'commit is outside the version graph snapshot');
    const row = parseGraph(await read.git(['log', '--no-show-signature', '--no-notes', '--encoding=UTF-8', '--max-count=1', format, commit, '--']))[0];
    check(row?.commit === commit, 'version graph object is not a commit');
    const message = (await read.git(['log', '--no-show-signature', '--no-notes', '--encoding=UTF-8', '--max-count=1', '--format=%B', commit, '--'])).toString('utf8').trimEnd();
    check(message.length <= 131072, 'version graph commit message exceeds safe size');
    return { ...row, message };
  });
}
