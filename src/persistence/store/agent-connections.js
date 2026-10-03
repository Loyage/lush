import { createHash, randomUUID } from 'node:crypto';
import { check } from '../../core/types.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const statuses = new Set(['available','partial','unknown','error','unsupported','unconfigured']);
const sources = new Set(['usage_api','client_rpc','response_headers','none']);
const codes = new Set(['expired','unconfigured','network','unauthorized','invalid_response','unsupported','timeout','rate_limited',
  'auth_locked','auth_changed','refresh_failed','unknown','missing_metric','cancelled']);
const reasons = {
  expired: '登录已过期，请重新登录。', unconfigured: '尚未配置此连接的凭证。', network: '未能连接额度查询服务。',
  unauthorized: '额度查询未获授权；不代表账号资源已耗尽。', invalid_response: '服务商响应无法安全解析。',
  unsupported: '此连接没有已接入的额度查询来源。', timeout: '额度查询超时。', rate_limited: '额度查询接口暂时限流；不代表套餐耗尽。',
  auth_locked: '认证更新正在进行，请稍后重试。', auth_changed: '连接认证已变化，本次结果未用于当前连接。',
  refresh_failed: '登录刷新失败，请重新登录。', unknown: '没有取得可确认的资源数据。', missing_metric: '本次未取得此指标。',
  cancelled: '查询已取消。',
};
const text = (value, max = 120) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max) : null;
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function modelList(value) {
  const models = []; let bytes = 0;
  for (const raw of (Array.isArray(value) ? value : []).slice(0, 50)) {
    const model = text(raw, 256);
    if (!model || models.includes(model)) continue;
    const size = Buffer.byteLength(model);
    if (bytes + size > 2048) break;
    bytes += size; models.push(model);
  }
  return models.sort();
}
export const validConnectionId = value => typeof value === 'string' && ID.test(value);
export const validConnectionHash = value => typeof value === 'string' && HASH.test(value);
export const connectionErrorCode = value => codes.has(value) ? value : value ? 'unknown' : null;

/** A final whitelist boundary: no raw provider objects, exception text or credentials enter SQLite/RPC. */
export function normalizeConnectionObservation(value, fallbackAt = new Date().toISOString()) {
  let status = statuses.has(value?.status) ? value.status : 'unknown';
  const source = sources.has(value?.source) ? value.source : 'none';
  let error_code = connectionErrorCode(value?.error_code);
  const checked_at = iso(value?.checked_at) || iso(fallbackAt);
  check(checked_at, 'invalid connection observation time');
  const resources = [], seen = new Set();
  for (const raw of (Array.isArray(value?.resources) ? value.resources : []).slice(0, 20)) {
    if (!raw || !ID.test(raw.id || '') || !['balance','quota'].includes(raw.kind) || !['account','key','model'].includes(raw.scope)) continue;
    const key = `${raw.kind}:${raw.scope}:${raw.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const usable = status === 'available' || status === 'partial';
    const percent = numeric(raw.used_percent);
    resources.push({ id: raw.id, kind: raw.kind, scope: raw.scope, label: text(raw.label) || raw.id,
      unit: text(raw.unit, 24), remaining: usable ? numeric(raw.remaining) : null,
      total: usable ? numeric(raw.total) : null, used: usable ? numeric(raw.used) : null,
      used_percent: usable && percent !== null && percent >= 0 && percent <= 100 ? percent : null,
      reset_at: iso(raw.reset_at), window_seconds: Number.isSafeInteger(raw.window_seconds) && raw.window_seconds > 0 && raw.window_seconds <= 315360000 ? raw.window_seconds : null,
      models: modelList(raw.models) });
  }
  if (['available','partial'].includes(status) && !resources.some(resource =>
    [resource.remaining,resource.total,resource.used,resource.used_percent].some(number => number !== null))) {
    status = 'unknown'; error_code = 'invalid_response';
  }
  if (status === 'unknown' && !error_code) error_code = 'unknown';
  if (status === 'unconfigured' && !error_code) error_code = 'unconfigured';
  if (status === 'unsupported' && !error_code) error_code = 'unsupported';
  return { status, checked_at, source, resources, error_code, reason: error_code ? reasons[error_code] : null };
}

const point = row => ({ at: row.checked_at, remaining: row.remaining, total: row.total, used: row.used,
  used_percent: row.used_percent, status: row.status, reset_at: row.reset_at, error_code: row.error_code, source: row.source });
// Conservative UTF-8 bound, including timestamps, finite numbers, and every safe error code.
const MAX_POINT_BYTES = 460;
function sample(store, id, from, to, stats, limit) {
  if (stats.n <= limit) return store.all(`SELECT * FROM agent_connection_points
    WHERE series_id=? AND checked_at>=? AND checked_at<=? ORDER BY checked_at,query_id`, id, from, to).map(point);
  const buckets = Math.max(1, Math.floor(limit / 8));
  // Sample across the full span rather than taking the newest N rows. Preserve a
  // representative failure, reset timestamp change and remaining-value increase.
  return store.all(`WITH observations AS (
      SELECT *,checked_at || ':' || printf('%020d',query_id) AS sort_key,
        LAG(reset_at) OVER (ORDER BY checked_at,query_id) AS previous_reset,
        LAG(remaining) OVER (ORDER BY checked_at,query_id) AS previous_remaining
      FROM agent_connection_points WHERE series_id=? AND checked_at>=? AND checked_at<=?
    ), reset_edges AS (
      SELECT sort_key,LAG(reset_at) OVER (ORDER BY checked_at,query_id) AS last_known_reset
      FROM observations WHERE reset_at IS NOT NULL
    ), bucketed AS (
      SELECT o.*,r.last_known_reset,MIN(?-1,MAX(0,CAST((julianday(o.checked_at)-julianday(?)) /
        MAX(julianday(?)-julianday(?),0.000000001)*? AS INTEGER))) AS bucket
      FROM observations o LEFT JOIN reset_edges r USING(sort_key)
    ), stats AS (
      SELECT bucket,MIN(sort_key) AS first_key,MAX(sort_key) AS last_key,
        MIN(remaining) AS low_value,MAX(remaining) AS high_value,
        MIN(CASE WHEN status NOT IN ('available','partial') OR remaining IS NULL THEN sort_key END) AS failure_key,
        MIN(CASE WHEN reset_at IS NOT NULL AND last_known_reset IS NOT NULL AND reset_at!=last_known_reset THEN sort_key END) AS reset_key,
        MIN(CASE WHEN remaining>previous_remaining THEN sort_key END) AS increase_key,
        MIN(CASE WHEN remaining>previous_remaining OR (reset_at IS NOT NULL AND last_known_reset IS NOT NULL AND reset_at!=last_known_reset)
          THEN LAG_KEY END) AS before_reset_key
      FROM (SELECT *,LAG(sort_key) OVER (ORDER BY checked_at,query_id) AS LAG_KEY FROM bucketed) GROUP BY bucket
    ), extrema AS (
      SELECT b.bucket,MIN(CASE WHEN b.remaining=s.low_value THEN b.sort_key END) AS low_key,
        MIN(CASE WHEN b.remaining=s.high_value THEN b.sort_key END) AS high_key
      FROM bucketed b JOIN stats s USING(bucket) GROUP BY b.bucket
    ), selected AS (
      SELECT first_key AS sort_key FROM stats UNION SELECT last_key FROM stats
      UNION SELECT failure_key FROM stats UNION SELECT reset_key FROM stats
      UNION SELECT increase_key FROM stats UNION SELECT before_reset_key FROM stats
      UNION SELECT low_key FROM extrema UNION SELECT high_key FROM extrema
    ) SELECT checked_at,remaining,total,used,used_percent,status,reset_at,error_code,source FROM bucketed
      WHERE sort_key IN (SELECT sort_key FROM selected) ORDER BY checked_at,query_id`,
  id, from, to, buckets, stats.first_at, stats.last_at, stats.first_at, buckets).map(point);
}

/** All managed-connection SQL is separate from the legacy account cache. */
export const agentConnections = {
  ensureAgentConnectionState(id, fingerprint, invalidate = false) {
    check(validConnectionId(id) && validConnectionHash(fingerprint), 'invalid connection state identity');
    const prior = this.get('SELECT * FROM agent_connection_state WHERE connection_id=?', id);
    if (prior && prior.fingerprint === fingerprint && !invalidate) return prior;
    const revision = randomUUID();
    this.run(`INSERT INTO agent_connection_state (connection_id,fingerprint,revision,account_key,source_key)
      VALUES (?,?,?,NULL,NULL) ON CONFLICT(connection_id) DO UPDATE SET fingerprint=excluded.fingerprint,
      revision=excluded.revision,account_key=NULL,source_key=NULL`, id, fingerprint, revision);
    return this.get('SELECT * FROM agent_connection_state WHERE connection_id=?', id);
  },
  agentConnectionState(id) { return this.get('SELECT * FROM agent_connection_state WHERE connection_id=?', id); },
  forgetAgentConnectionState(id) { this.run('DELETE FROM agent_connection_state WHERE connection_id=?', id); },
  rememberAgentConnectionIdentity(id, revision, accountKey, sourceKey) {
    check(validConnectionId(id) && validConnectionHash(accountKey) && validConnectionHash(sourceKey), 'invalid connection observation identity');
    this.run('UPDATE agent_connection_state SET account_key=?,source_key=? WHERE connection_id=? AND revision=?', accountKey, sourceKey, id, revision);
  },
  recordAgentConnectionObservation(record) {
    check(validConnectionId(record.connection_id) && /^[a-z][a-z0-9_-]{0,79}$/i.test(record.provider || '')
      && validConnectionHash(record.account_key) && validConnectionHash(record.source_key)
      && typeof record.query_key === 'string' && record.query_key.length <= 256, 'invalid connection observation identity');
    const observation = normalizeConnectionObservation(record.observation);
    return this.transaction(() => {
      const insert = this.run(`INSERT OR IGNORE INTO agent_connection_queries
        (query_key,connection_id,revision,provider,account_key,source_key,checked_at,status,error_code,source,payload)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, record.query_key, record.connection_id, record.revision ?? null, record.provider,
      record.account_key, record.source_key, observation.checked_at, observation.status, observation.error_code, observation.source, JSON.stringify(observation));
      if (!insert.changes) return false;
      const queryId = Number(insert.lastInsertRowid), current = new Map();
      for (const resource of observation.resources) {
        const models = JSON.stringify(resource.models);
        const id = digest([record.connection_id,record.provider,record.account_key,record.source_key,
          resource.kind,resource.scope,resource.id,resource.unit,resource.window_seconds,resource.models]);
        this.run(`INSERT INTO agent_connection_series
          (id,connection_id,provider,account_key,source_key,metric_id,kind,scope,label,unit,window_seconds,models,last_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,last_at=MAX(last_at,excluded.last_at)`,
        id, record.connection_id, record.provider, record.account_key, record.source_key, resource.id, resource.kind, resource.scope,
        resource.label, resource.unit, resource.window_seconds, models, observation.checked_at);
        current.set(id, resource);
      }
      const series = this.all(`SELECT * FROM agent_connection_series
        WHERE connection_id=? AND account_key=? AND source_key=? ORDER BY last_at DESC LIMIT 80`, record.connection_id, record.account_key, record.source_key);
      if (!series.length) {
        const id = digest([record.connection_id,record.account_key,record.source_key,'query-status']);
        this.run(`INSERT INTO agent_connection_series
          (id,connection_id,provider,account_key,source_key,metric_id,kind,scope,label,unit,window_seconds,models,last_at)
          VALUES (?,?,?,?,?,'query-status',NULL,'account',?,NULL,NULL,'[]',?)`, id, record.connection_id, record.provider,
        record.account_key, record.source_key, '查询状态（尚无成功数值）', observation.checked_at);
        series.push({ id });
      }
      for (const entry of series) {
        const resource = current.get(entry.id);
        const usable = resource && [resource.remaining,resource.total,resource.used,resource.used_percent].some(value => value !== null);
        const status = usable ? 'available' : ['available','partial'].includes(observation.status) ? 'unknown' : observation.status;
        const errorCode = usable ? null : observation.error_code || 'missing_metric';
        this.run(`INSERT INTO agent_connection_points
          (series_id,query_id,checked_at,remaining,total,used,used_percent,status,reset_at,error_code,source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, entry.id, queryId, observation.checked_at, resource?.remaining ?? null,
        resource?.total ?? null, resource?.used ?? null, resource?.used_percent ?? null, status, resource?.reset_at ?? null, errorCode, observation.source);
        this.run('UPDATE agent_connection_series SET last_at=MAX(last_at,?) WHERE id=?', observation.checked_at, entry.id);
      }
      return true;
    });
  },
  latestAgentConnectionObservation(id, revision, accountKey, sourceKey) {
    if (!accountKey || !sourceKey) return null;
    const row = this.get(`SELECT payload FROM agent_connection_queries
      WHERE connection_id=? AND revision=? AND account_key=? AND source_key=? ORDER BY checked_at DESC,id DESC LIMIT 1`, id, revision, accountKey, sourceKey);
    return row ? JSON.parse(row.payload) : null;
  },
  lastAgentConnectionSuccess(id, accountKey, sourceKey) {
    if (!accountKey || !sourceKey) return null;
    const row = this.get(`SELECT checked_at,payload FROM agent_connection_queries
      WHERE connection_id=? AND account_key=? AND source_key=? AND status IN ('available','partial')
      ORDER BY checked_at DESC,id DESC LIMIT 1`, id, accountKey, sourceKey);
    return row ? { checked_at: row.checked_at, observation: JSON.parse(row.payload) } : null;
  },
  pruneAgentConnections(before) {
    check(iso(before), 'invalid connection retention time');
    return this.transaction(() => {
      const removed = this.get('SELECT COUNT(*) AS n FROM agent_connection_queries WHERE checked_at<?', before).n;
      this.run('DELETE FROM agent_connection_queries WHERE checked_at<?', before);
      this.run('DELETE FROM agent_connection_series WHERE NOT EXISTS (SELECT 1 FROM agent_connection_points WHERE series_id=agent_connection_series.id)');
      return removed;
    });
  },
  readAgentConnectionHistory({ id, from, to, retention_days }) {
    check(validConnectionId(id) && iso(from) && iso(to) && from <= to, 'invalid connection history range');
    const candidates = this.all(`SELECT s.* FROM agent_connection_series s WHERE connection_id=? AND last_at>=?
      AND EXISTS (SELECT 1 FROM agent_connection_points p WHERE p.series_id=s.id AND p.checked_at>=? AND p.checked_at<=?)
      ORDER BY last_at DESC,id LIMIT 41`, id, from, from, to);
    const result = { version: 1, from, to, retention_days, series: [], truncated: candidates.length > 40 };
    // Equal per-series UTF-8 budgets mean the total remains below the RPC frame cap.
    const budget = Math.floor(670000 / Math.max(1, Math.min(candidates.length, 40)));
    for (const row of candidates.slice(0, 40)) {
      const stats = this.get(`SELECT COUNT(*) AS n,MIN(checked_at) AS first_at,MAX(checked_at) AS last_at FROM agent_connection_points
        WHERE series_id=? AND checked_at>=? AND checked_at<=?`, row.id, from, to);
      const entry = { id: row.id, connection_id: row.connection_id, provider: row.provider, account_key: row.account_key,
        source_key: row.source_key, kind: row.kind, scope: row.scope, label: row.label, unit: row.unit,
        window_seconds: row.window_seconds, models: JSON.parse(row.models), source: null, points: [], sample_count: stats.n };
      const latestSource = this.get(`SELECT source FROM agent_connection_points WHERE series_id=? AND checked_at>=? AND checked_at<=?
        ORDER BY checked_at DESC,query_id DESC LIMIT 1`, row.id, from, to);
      entry.source = latestSource?.source ?? 'none';
      const metadataBytes = Buffer.byteLength(JSON.stringify(entry));
      const limit = Math.min(500, Math.max(8, Math.floor((budget - metadataBytes) / MAX_POINT_BYTES)));
      entry.points = sample(this, row.id, from, to, stats, limit);
      if (entry.points.length < stats.n) result.truncated = true;
      result.series.push(entry);
    }
    return result;
  },
};
