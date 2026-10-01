import { createHash } from 'node:crypto';
import { check } from '../../core/types.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safe = (value, max = 120) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : null;
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const codes = new Set(['expired','unconfigured','network','unauthorized','invalid_response','unsupported','timeout','rate_limited',
  'auth_locked','auth_changed','refresh_failed','unknown','missing_metric']);
const statuses = new Set(['available','error','unsupported','unconfigured','unknown']);
const errorCode = value => codes.has(value) ? value : value ? 'unknown' : null;
const toPoint = row => ({ at: row.checked_at, remaining: row.remaining, total: row.total, used: row.used, used_percent: row.used_percent ?? null,
  status: row.status, reset_at: row.reset_at, error_code: row.error_code });

// The projection has bounded strings and finite JSON numbers; this conservative UTF-8
// bound leaves room for every point without dropping the oldest observations afterwards.
const MAX_POINT_BYTES = 420;
function sampledPoints(store, seriesId, from, to, stats, limit) {
  if (stats.n <= limit) return store.all(`SELECT * FROM agent_usage_points
    WHERE series_id=? AND checked_at>=? AND checked_at<=? ORDER BY checked_at,query_id`, seriesId, from, to).map(toPoint);
  // Six representatives per time bucket: first/last, min/max, first failed or unknown
  // observation, and first reset transition. SQL scans the range but returns bounded rows.
  const buckets = Math.max(1, Math.floor(limit / 6));
  return store.all(`WITH observations AS (
      SELECT *,checked_at || ':' || printf('%020d',query_id) AS sort_key
      FROM agent_usage_points WHERE series_id=? AND checked_at>=? AND checked_at<=?
    ), reset_edges AS (
      SELECT sort_key,LAG(reset_at) OVER (ORDER BY checked_at,query_id) AS previous_reset
      FROM observations WHERE reset_at IS NOT NULL
    ), bucketed AS (
      SELECT o.*,r.previous_reset,MIN(?-1,MAX(0,CAST((julianday(o.checked_at)-julianday(?)) /
        MAX(julianday(?)-julianday(?),0.000000001)*? AS INTEGER))) AS bucket
      FROM observations o LEFT JOIN reset_edges r USING(sort_key)
    ), stats AS (
      SELECT bucket,MIN(sort_key) AS first_key,MAX(sort_key) AS last_key,
        MIN(remaining) AS low_value,MAX(remaining) AS high_value,
        MIN(CASE WHEN status!='available' OR remaining IS NULL THEN sort_key END) AS failure_key,
        MIN(CASE WHEN reset_at IS NOT NULL AND previous_reset IS NOT NULL AND reset_at!=previous_reset THEN sort_key END) AS reset_key
      FROM bucketed GROUP BY bucket
    ), extrema AS (
      SELECT b.bucket,MIN(CASE WHEN b.remaining=s.low_value THEN b.sort_key END) AS low_key,
        MIN(CASE WHEN b.remaining=s.high_value THEN b.sort_key END) AS high_key
      FROM bucketed b JOIN stats s USING(bucket) GROUP BY b.bucket
    ), selected AS (
      SELECT first_key AS sort_key FROM stats UNION SELECT last_key FROM stats
      UNION SELECT failure_key FROM stats UNION SELECT reset_key FROM stats
      UNION SELECT low_key FROM extrema UNION SELECT high_key FROM extrema
    ) SELECT checked_at,remaining,total,used,used_percent,status,reset_at,error_code FROM bucketed
      WHERE sort_key IN (SELECT sort_key FROM selected) ORDER BY checked_at,query_id`,
  seriesId, from, to, buckets, stats.first_at, stats.last_at, stats.first_at, buckets).map(toPoint);
}

/** Store accepts only the safe projection, never an upstream response or auth object. */
export const agentUsage = {
  recordAgentUsage(record) {
    check(/^[a-z][a-z0-9_-]{0,79}$/i.test(record.provider || '') && /^[a-zA-Z0-9_-]{1,128}$/.test(record.account_key || '')
      && /^[a-f0-9]{64}$/.test(record.source_key || '') && typeof record.query_key === 'string' && record.query_key.length <= 256, 'invalid usage observation identity');
    const at = iso(record.at); check(at, 'invalid usage observation time');
    const status = statuses.has(record.status) ? record.status : 'unknown', code = errorCode(record.error_code);
    const kind = ['quota','balance'].includes(record.kind) ? record.kind : null;
    const items = (Array.isArray(record.items) ? record.items : []).slice(0, 10).flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const id = safe(item.id, 120); if (!id) return [];
      return [{ id, label: safe(item.label) || id, unit: safe(item.unit, 24),
        remaining: status === 'available' ? numeric(item.remaining) : null,
        total: status === 'available' ? numeric(item.total) : null, used: status === 'available' ? numeric(item.used) : null,
        used_percent: status === 'available' && numeric(item.used_percent) !== null && item.used_percent >= 0 && item.used_percent <= 100 ? item.used_percent : null,
        reset_at: iso(item.reset_at), window_seconds: Number.isSafeInteger(item.window_seconds) && item.window_seconds > 0 ? item.window_seconds : null }];
    });
    return this.transaction(() => {
      const payload = JSON.stringify({ status, kind, items, error_code: code, checked_at: at });
      const insert = this.run(`INSERT OR IGNORE INTO agent_usage_queries
        (query_key,provider,account_key,source_key,checked_at,status,error_code,payload) VALUES (?,?,?,?,?,?,?,?)`,
      record.query_key, record.provider, record.account_key, record.source_key, at, status, code, payload);
      if (!insert.changes) return false;
      const queryId = Number(insert.lastInsertRowid);
      const current = new Map();
      for (const item of items) {
        const id = digest([record.provider, record.account_key, record.source_key, kind, item.id, item.unit, item.window_seconds]);
        this.run(`INSERT INTO agent_usage_series (id,provider,account_key,source_key,metric_id,kind,label,unit,window_seconds,last_at)
          VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,last_at=MAX(last_at,excluded.last_at)`,
        id, record.provider, record.account_key, record.source_key, item.id, kind, item.label, item.unit, item.window_seconds, at);
        current.set(id, item);
      }
      // Failed/missing metrics are gaps in every known series for this exact account/source.
      const series = this.all(`SELECT * FROM agent_usage_series WHERE provider=? AND account_key=? AND source_key=? ORDER BY last_at DESC LIMIT 40`,
        record.provider, record.account_key, record.source_key);
      if (!series.length) {
        const id = digest([record.provider, record.account_key, record.source_key, 'query-status']);
        this.run(`INSERT INTO agent_usage_series (id,provider,account_key,source_key,metric_id,kind,label,unit,window_seconds,last_at)
          VALUES (?,?,?,?,?,NULL,?,NULL,NULL,?)`, id, record.provider, record.account_key, record.source_key, 'query-status', '查询状态（尚无成功数值）', at);
        series.push({ id });
      }
      for (const entry of series) {
        const item = current.get(entry.id), itemStatus = item ? status : status === 'available' ? 'unknown' : status;
        this.run(`INSERT INTO agent_usage_points (series_id,query_id,checked_at,remaining,total,used,used_percent,status,reset_at,error_code)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, entry.id, queryId, at, item?.remaining ?? null, item?.total ?? null, item?.used ?? null, item?.used_percent ?? null,
        itemStatus, item?.reset_at ?? null, item ? code : code || 'missing_metric');
        this.run('UPDATE agent_usage_series SET last_at=MAX(last_at,?) WHERE id=?', at, entry.id);
      }
      return true;
    });
  },

  lastAgentUsageSuccess(provider, accountKey, sourceKey) {
    const row = this.get(`SELECT checked_at,payload FROM agent_usage_queries
      WHERE provider=? AND account_key=? AND source_key=? AND status='available' ORDER BY checked_at DESC,id DESC LIMIT 1`, provider, accountKey, sourceKey);
    return row ? { checked_at: row.checked_at, balance: JSON.parse(row.payload) } : null;
  },

  pruneAgentUsage(before) {
    check(iso(before), 'invalid usage retention time');
    return this.transaction(() => {
      const removed = this.get('SELECT COUNT(*) AS n FROM agent_usage_queries WHERE checked_at<?', before).n;
      this.run('DELETE FROM agent_usage_queries WHERE checked_at<?', before);
      this.run('DELETE FROM agent_usage_series WHERE NOT EXISTS (SELECT 1 FROM agent_usage_points WHERE series_id=agent_usage_series.id)');
      return removed;
    });
  },

  readAgentUsageHistory({ provider = null, account_key = null, from, to, retention_days }) {
    const where = ['s.last_at>=?', 'EXISTS (SELECT 1 FROM agent_usage_points p WHERE p.series_id=s.id AND p.checked_at>=? AND p.checked_at<=?)'];
    const params = [from, from, to];
    if (provider) { where.push('s.provider=?'); params.push(provider); }
    if (account_key) { where.push('s.account_key=?'); params.push(account_key); }
    const candidates = this.all(`SELECT s.* FROM agent_usage_series s WHERE ${where.join(' AND ')} ORDER BY s.last_at DESC,s.id LIMIT 41`, ...params);
    let truncated = candidates.length > 40;
    const series = [], budget = Math.floor(680000 / Math.max(1, Math.min(candidates.length, 40)));
    for (const row of candidates.slice(0, 40)) {
      const stats = this.get(`SELECT COUNT(*) AS n,MIN(checked_at) AS first_at,MAX(checked_at) AS last_at
        FROM agent_usage_points WHERE series_id=? AND checked_at>=? AND checked_at<=?`, row.id, from, to);
      const entry = { id: row.id, provider: row.provider, account_key: row.account_key, kind: row.kind, label: row.label,
        unit: row.unit, window_seconds: row.window_seconds, points: [], sample_count: stats.n };
      const metadataBytes = Buffer.byteLength(JSON.stringify(entry));
      const pointLimit = Math.min(500, Math.max(6, Math.floor((budget - metadataBytes) / MAX_POINT_BYTES)));
      entry.points = sampledPoints(this, row.id, from, to, stats, pointLimit);
      if (entry.points.length < stats.n) truncated = true;
      series.push(entry);
    }
    return { version: 1, from, to, retention_days, series, truncated };
  },
};
