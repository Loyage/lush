const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const callKey = step => step.call_id ? JSON.stringify([step.file, step.call_id]) : null;

/** Recorded call-to-result interval, not a timer for the tool's actual execution.
 * Missing/duplicate identities and invalid clocks must not become a zero duration. */
export function toolDurationMs(step, results = step.results || []) {
  const key = callKey(step);
  if (step.kind !== 'tool' || !key || results.length !== 1) return null;
  const result = results[0];
  if (result.kind !== 'result' || callKey(result) !== key || result.seq <= step.seq) return null;
  const start = Date.parse(step.at), end = Date.parse(result.at);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

export function stepDurationText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Number((ms / 1000).toFixed(3))}s`;
  const [unit, divisor] = ms < 60000 ? ['s', 1000] : ms < 3600000 ? ['m', 60000] : ['h', 3600000];
  return `${Number((ms / divisor).toFixed(1))}${unit}`;
}

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
