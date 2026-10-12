import { RuntimeDiagnostics, diagnosticsTime } from '../runtime-diagnostics.js';

export default {
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
