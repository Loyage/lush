/**
 * `lush daemon ...` in text mode: one aligned `key value` line per scalar
 * field, with the CLI's own view prefixed `cli.`. A daemon is long-lived, so
 * the fields that matter most are `home` (which state) and `code_dir` /
 * `fingerprint` / `started_at` (which code, from when).
 */
export function formatDaemon(result) {
  const rows = [];
  for (const [key, value] of Object.entries(result)) {
    if (key === 'cli' || value === null || typeof value === 'object') continue;
    rows.push([key, String(value)]);
  }
  for (const [key, value] of Object.entries(result.cli ?? {})) {
    if (value === null || typeof value === 'object') continue;
    rows.push([`cli.${key}`, String(value)]);
  }
  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  return rows.map(([key, value]) => `${key.padEnd(width + 2)}${value}`).join('\n');
}
