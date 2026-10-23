import { check } from '../../core/types.js';
import { diagnosticSample, diagnosticText, DIAGNOSTICS_RETENTION_MS, DIAGNOSTICS_LIMITS } from '../../core/diagnostics-query.js';

export const diagnostics = {
  pruneDiagnostics(now = Date.now()) {
    const before = new Date(now - DIAGNOSTICS_RETENTION_MS).toISOString();
    this.run('DELETE FROM diagnostic_samples WHERE at<?', before);
    this.run('DELETE FROM diagnostic_runs WHERE started_at<? AND NOT EXISTS (SELECT 1 FROM diagnostic_samples WHERE run_id=diagnostic_runs.run_id)', before);
  },
  beginDiagnosticsRun(runId, connectionId, model) {
    const run = this.get('SELECT id,started_at FROM agent_runs WHERE id=?', runId);
    check(run, 'diagnostic invocation missing');
    this.pruneDiagnostics();
    this.run('INSERT OR IGNORE INTO diagnostic_runs(run_id,connection_id,model,started_at) VALUES (?,?,?,?)', runId,
      diagnosticText(connectionId, 128) ? connectionId : null, diagnosticText(model) ? model : null, run.started_at);
  },
  recordDiagnosticsRun(runId, report) {
    if (!report) return;
    check(Array.isArray(report.rows) && report.rows.length <= 1024 && Number.isSafeInteger(report.dropped) && report.dropped >= 0, 'invalid diagnostics capture');
    const run = this.get('SELECT * FROM diagnostic_runs WHERE run_id=?', runId);
    check(run, 'diagnostic invocation missing');
    if (run.captured) return; // Duplicate completion cannot replay expenditure.
    const rows = report.rows.map(diagnosticSample), now = Date.now();
    this.transaction(() => {
      let dropped = report.dropped, retained = 0;
      for (let sequence = 0; sequence < rows.length; sequence++) {
        const row = rows[sequence], at = Date.parse(row.at);
        if (at < Date.parse(run.started_at) || at > now + 5000 || at < now - DIAGNOSTICS_RETENTION_MS) { dropped++; continue; }
        this.run('INSERT INTO diagnostic_samples(run_id,sequence,at,connection_id,model,payload) VALUES (?,?,?,?,?,?)',
          runId, sequence, row.at, row.model === run.model ? run.connection_id : null, row.model, JSON.stringify(row)); retained++;
      }
      this.run('UPDATE diagnostic_runs SET captured=1,dropped=?,samples=? WHERE run_id=?', dropped, retained, runId);
    });
    this.pruneDiagnostics(now);
  },
  diagnosticsRows(range) {
    const filters = ['at>=?', 'at<?'], values = [range.from, range.to];
    for (const key of ['connection_id','model']) if (range[key]) {
      if (range[key] === '@unknown') filters.push(`${key} IS NULL`);
      else { filters.push(`${key}=?`); values.push(range[key]); }
    }
    const samples = this.all(`SELECT run_id,connection_id,model,payload FROM diagnostic_samples WHERE ${filters.join(' AND ')}
      ORDER BY at,run_id,sequence LIMIT ?`, ...values, DIAGNOSTICS_LIMITS.samples + 1);
    // Old, interrupted and unsupported invocations remain visible as coverage gaps after every refresh/restart.
    const runs = this.all(`SELECT r.id,r.provider,r.model AS requested_model,r.status,d.connection_id,d.model,d.captured,d.dropped,d.samples
      FROM agent_runs r LEFT JOIN diagnostic_runs d ON d.run_id=r.id
      WHERE r.started_at<? AND (r.ended_at IS NULL OR r.ended_at>=?)
      ORDER BY r.started_at DESC,r.id DESC LIMIT ?`, range.to, range.from, DIAGNOSTICS_LIMITS.runs + 1);
    return { samples: samples.slice(0, DIAGNOSTICS_LIMITS.samples), runs: runs.slice(0, DIAGNOSTICS_LIMITS.runs),
      truncated: samples.length > DIAGNOSTICS_LIMITS.samples || runs.length > DIAGNOSTICS_LIMITS.runs };
  },
};
