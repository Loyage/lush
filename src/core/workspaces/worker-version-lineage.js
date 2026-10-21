import { check } from '../types.js';
import { graphOID, encodeGraphToken, decodeGraphToken, withGraphReader, parseGraph } from './version-graph.js';

const format = '--format=%H%x00%P%x00%s%x00%an%x00%cI%x00';
const log = ['log', '--first-parent', '--topo-order', '--no-show-signature', '--no-notes', '--no-decorate', '--encoding=UTF-8'];
export const LINEAGE_COMMIT_LIMIT = 10000;

export function lineageSnapshot(workspaces, token, id, kind = 'snapshot') {
  const value = decodeGraphToken(workspaces, token);
  check(value.kind === `worker.lineage.${kind}` && value.scope === 'lineage' && value.range === 'first-parent'
    && value.id === id && graphOID(value.tip) && graphOID(value.base)
    && typeof value.branch === 'string' && value.branch.length <= 4096
    && Number.isSafeInteger(value.parent?.id) && value.parent.id > 0 && typeof value.parent.branch === 'string'
    && ['branch.ref', 'delivery.source'].includes(value.tip_evidence)
    && (value.tip_delivery_id === null || Number.isSafeInteger(value.tip_delivery_id) && value.tip_delivery_id > 0)
    && Number.isSafeInteger(value.event_max) && value.event_max >= 0
    && Number.isSafeInteger(value.child_max) && value.child_max >= 0
    && Number.isSafeInteger(value.page_limit) && value.page_limit >= 1 && value.page_limit <= 100,
  'version lineage cursor or snapshot belongs to a different scope; refresh the lineage');
  if (kind === 'cursor') check(Number.isSafeInteger(value.offset) && value.offset > 0
    && value.offset % value.page_limit === 0, 'invalid version lineage cursor');
  return value;
}
export function lineageTokens(workspaces, value, offset, limit, has_more) {
  return { snapshot: encodeGraphToken(workspaces, { ...value, kind: 'worker.lineage.snapshot' }),
    cursor: has_more ? encodeGraphToken(workspaces, { ...value, kind: 'worker.lineage.cursor', offset: offset + limit }) : null };
}

/** Only the first-parent source chain is development. Real second parents stay on
 * nodes as boundaries, never enumerated as this Worker's functional commits.
 * The bounded chain check also refuses a rewritten source that merely retains
 * origin on a second-parent path. No mutable parent ref is used to subtract old
 * delivered source commits from the lifetime history. */
export async function readLineage(workspaces, value, { offset = 0, limit = 30, commit, sample = false, fallback, deadline }) {
  return withGraphReader(workspaces, async read => {
    if (sample) {
      const refs = (await read.identity(['for-each-ref', '--format=%(refname)%00%(objectname)', `refs/heads/${value.branch}`])).split('\n');
      const tip = refs.find(line => line.startsWith(`refs/heads/${value.branch}\0`))?.split('\0')[1] ?? null;
      if (tip) Object.assign(value, { tip, tip_evidence: 'branch.ref', tip_delivery_id: null });
      else {
        check(fallback && graphOID(fallback.tip), 'Worker branch is unavailable and latest successful delivery has no traceable fixed source');
        Object.assign(value, { tip: fallback.tip, tip_evidence: 'delivery.source', tip_delivery_id: fallback.delivery_id });
      }
    }
    check(graphOID(value.tip) && graphOID(value.base), 'version lineage requires a fixed creation baseline and source tip');
    await read.git(['cat-file', '-e', `${value.base}^{commit}`]);
    await read.git(['cat-file', '-e', `${value.tip}^{commit}`]);
    const raw = (await read.git(['rev-list', '--first-parent', `--max-count=${LINEAGE_COMMIT_LIMIT + 1}`, value.tip, `^${value.base}`, '--'])).toString('utf8').trim();
    const chain = raw ? raw.split('\n') : [];
    check(chain.length <= LINEAGE_COMMIT_LIMIT, 'version lineage source chain exceeds safe limit (10000 commits)');
    check(chain.every(graphOID), 'invalid version lineage source chain');
    if (chain.length) {
      const last = parseGraph(await read.git([...log, '--max-count=1', format, chain.at(-1), '--']))[0];
      check(last?.parents[0] === value.base, 'version lineage creation baseline is not on the first-parent source chain');
    } else check(value.tip === value.base, 'version lineage source tip does not retain its creation baseline');
    const origin = parseGraph(await read.git([...log, '--max-count=1', format, value.base, '--']))[0];
    check(origin?.commit === value.base, 'version lineage origin object is unavailable');
    if (commit !== undefined) {
      check(graphOID(commit), 'version lineage commit must be a full object ID');
      check(commit === value.base || chain.includes(commit), 'commit is outside the version lineage snapshot');
      const row = parseGraph(await read.git([...log, '--max-count=1', format, commit, '--']))[0];
      check(row?.commit === commit, 'version lineage object is not a commit');
      const message = (await read.git([...log, '--max-count=1', '--format=%B', commit, '--'])).toString('utf8').trimEnd();
      check(message.length <= 131072, 'version lineage commit message exceeds safe size');
      return { origin, chain: new Set(chain), commits: [{ ...row, message }], has_more: false };
    }
    const rows = parseGraph(await read.git([...log, `--skip=${offset}`, `--max-count=${limit + 1}`, format, value.tip, `^${value.base}`, '--']));
    return { origin, chain: new Set(chain), commits: rows.slice(0, limit), has_more: rows.length > limit };
  }, deadline);
}
