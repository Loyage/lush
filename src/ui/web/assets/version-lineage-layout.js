// A bounded first-parent segment, not a reconstructed parent branch graph.
// Parent anchors are unique objects; receipts retain their independent Event identities.
export function versionLineageLayout(data) {
  const commits = [...data.commits].reverse(), own = new Set(commits.map(c => c.commit));
  const anchors = new Set([data.origin.commit]);
  const mappings = new Map();
  for (const mapping of data.deliveries) {
    const group = mappings.get(mapping.source_commit) || [];
    group.push(mapping); mappings.set(mapping.source_commit, group);
  }
  const row = (commit, origin = false) => {
    const deliveries = (mappings.get(commit.commit) || []).sort((a, b) => a.delivery_id - b.delivery_id);
    const landings = [];
    for (const mapping of deliveries) if (mapping.delivery_available && mapping.commit && !anchors.has(mapping.commit)) {
      anchors.add(mapping.commit); landings.push(mapping.commit);
    }
    return { commit, origin, deliveries, landings, edges: origin ? [] : commit.parents.map((parent, index) => ({
      child: commit.commit, parent, boundary: !own.has(parent) && !(parent === data.origin.commit && !data.has_more),
      external: index > 0 && !own.has(parent) && parent !== data.origin.commit,
    })) };
  };
  const origin = row(data.origin, true), rows = commits.map(c => row(c));
  // Node de-duplication is independent of mapping identity. Every verified pair
  // remains an edge, including an already placed landing or the origin itself.
  const pairs = new Map();
  for (const mapping of data.deliveries) if (mapping.delivery_available) {
    const key = `${mapping.source_commit}:${mapping.commit}`;
    if (!pairs.has(key)) pairs.set(key, { source: mapping.source_commit, landing: mapping.commit, events: [] });
    pairs.get(key).events.push(mapping.delivery_id);
  }
  const connections = [...pairs.values()].map(pair => ({ ...pair, events: pair.events.sort((a, b) => a - b) }));
  return { origin, rows, connections, omitted: data.has_more };
}
