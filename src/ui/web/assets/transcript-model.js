const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const callKey = step => step.call_id ? JSON.stringify([step.file, step.call_id]) : null;

export function stepSummary(step) {
  if (step.kind === 'tool') {
    let args;
    try { args = JSON.parse(step.body); } catch { /* clipped or legacy arguments */ }
    const hint = args?.command ?? args?.path ?? args?.pattern ?? args?.query ?? step.body;
    return `${step.tool_name || step.title} · ${oneLine(hint).slice(0, 220)}`;
  }
  const text = oneLine(step.excerpt ?? step.body).replaceAll('**', '');
  return `${step.title}${text ? ` · ${text.slice(0, 220)}` : ''}`;
}

/** Keep wire steps intact. Only the reading projection groups known identities. */
export function groupSteps(steps) {
  const calls = new Map(), grouped = [], attached = new Set(), results = new Map();
  for (const step of steps) if (step.kind === 'tool' && callKey(step)) {
    const key = callKey(step);
    // Duplicate identities are ambiguous: do not silently bind to the wrong call.
    calls.set(key, calls.has(key) ? null : step);
  }
  for (const step of steps) {
    if (step.kind !== 'result') continue;
    const call = calls.get(callKey(step));
    if (call) {
      attached.add(step.seq);
      const key = callKey(step);
      if (!results.has(key)) results.set(key, []);
      results.get(key).push(step);
    }
  }
  for (const step of steps) {
    if (attached.has(step.seq)) continue;
    grouped.push({ ...step, results: step.kind === 'tool' && calls.get(callKey(step)) === step
      ? results.get(callKey(step)) || [] : [] });
  }
  return grouped;
}
