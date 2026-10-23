import { RuntimeDiagnostics, diagnosticsTime } from '../runtime-diagnostics.js';
import { prunePiDiagnostics } from '../../agent/pi-diagnostics.js';
import { diagnosticsQuery, emptyDiagnosticQuery, finishDiagnosticQuery, diagnosticTotals, addDiagnosticTotals,
  sampleTotals, matchesDiagnostic, DIAGNOSTICS_LIMITS } from '../diagnostics-query.js';
import { normalizeConnectionObservation } from '../../persistence/store/agent-connections.js';

export default {
  startDiagnosticsRetention() {
    if (this.diagnosticsRetentionTimer) return;
    const prune = () => {
      try { this.store.pruneDiagnostics(); } catch { /* Retry on the next maintenance tick. */ }
      this.diagnosticsPrunePromise ??= prunePiDiagnostics(this.config).finally(() => { this.diagnosticsPrunePromise = null; });
    };
    prune(); this.diagnosticsRetentionTimer = setInterval(prune, 3600_000);
    this.diagnosticsRetentionTimer.unref?.();
  },
  async stopDiagnosticsRetention() {
    clearInterval(this.diagnosticsRetentionTimer); this.diagnosticsRetentionTimer = null;
    await this.diagnosticsPrunePromise;
  },
  queryRuntimeDiagnostics(params = {}) {
    const now = Date.now(), range = diagnosticsQuery(params, now), result = emptyDiagnosticQuery(range, now);
    const data = this.store.diagnosticsRows(range), groups = new Map(), start = Date.parse(result.buckets[0].at);
    for (const sample of data.samples) {
      const row = JSON.parse(sample.payload), totals = sampleTotals(row);
      addDiagnosticTotals(result.summary, totals);
      addDiagnosticTotals(result.buckets[Math.floor((Date.parse(row.at) - start) / range.bucket_ms)], totals);
      const key = JSON.stringify([sample.connection_id,sample.model]);
      if (!groups.has(key) && groups.size < DIAGNOSTICS_LIMITS.groups)
        groups.set(key, { connection_id: sample.connection_id, model: sample.model, ...diagnosticTotals() });
      if (groups.has(key)) addDiagnosticTotals(groups.get(key), totals);
      else result.coverage.truncated = true;
    }
    result.groups = [...groups.values()];
    result.coverage.samples = data.samples.length;
    for (const run of data.runs) {
      // No frozen attribution is not proof that an old invocation was outside the selected source/model.
      if (run.captured !== null && !matchesDiagnostic(run, range)) continue;
      result.coverage.runs++;
      if (!run.captured || !run.samples || run.status === 'running') result.coverage.unknown_runs++;
      result.coverage.dropped_samples += run.dropped ?? 0;
    }
    result.coverage.truncated ||= data.truncated;
    result.coverage.complete = !result.coverage.truncated && !result.coverage.unknown_runs && !result.coverage.dropped_samples
      && !result.summary.unknown_usage && !result.summary.unknown_cost;
    Object.assign(result.quota, this.store.readDiagnosticsQuota(range));
    result.quota.current_status = 'available';
    try {
      const manager = this.agentConnections.getManager(), connections = manager.config().connections;
      for (const connection of connections.slice(0, 50)) {
        if (range.connection_id && range.connection_id !== connection.id) continue;
        const cached = manager.cachedObservation(connection.id);
        result.quota.current.push({ connection_id: connection.id, label: connection.label,
          observation: normalizeConnectionObservation(cached?.observation, new Date(now).toISOString()),
          last_success: cached?.last_success ? { checked_at: cached.last_success.checked_at,
            observation: normalizeConnectionObservation(cached.last_success.observation) } : null });
      }
    } catch { result.quota.current_status = 'unavailable'; result.quota.current = []; }
    finishDiagnosticQuery(result);
    // Bound the entire RPC, not just row counts (labels/models may be multi-byte).
    while (Buffer.byteLength(JSON.stringify(result)) > 850000 && result.quota.series.length) {
      result.quota.series.pop(); result.quota.truncated = true;
    }
    while (Buffer.byteLength(JSON.stringify(result)) > 850000 && result.quota.current.length) {
      result.quota.current.pop(); result.quota.truncated = true;
    }
    return result;
  },
  runtimeDiagnostics() {
    this.diagnosticsReader ??= new RuntimeDiagnostics(this.config, { runs: now => {
      // Indexed newest-first read; do not fetch the complete invocation history.
      const recent = this.store.all('SELECT id,task_id,provider,started_at,ended_at FROM agent_runs ORDER BY id DESC LIMIT 2049');
      const rows = recent.slice(0, 2048).filter(run => (diagnosticsTime(run.ended_at) ?? diagnosticsTime(run.started_at) ?? now) >= now - 600_000);
      for (const taskId of [...this.running.keys()].slice(0, 256)) {
        const run = this.store.get('SELECT id,task_id,provider,started_at,ended_at FROM agent_runs WHERE task_id=? ORDER BY id DESC LIMIT 1', taskId);
        if (run && !rows.some(row => row.id === run.id)) rows.push(run);
      }
      return { rows, truncated: this.running.size > 256 || recent.length > 2048
        && (diagnosticsTime(recent[2048].ended_at) ?? diagnosticsTime(recent[2048].started_at) ?? now) >= now - 600_000 };
    } });
    return this.diagnosticsReader.read();
  },
};
