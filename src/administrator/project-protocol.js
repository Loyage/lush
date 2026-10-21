/** D738: browser/Node/Bun vocabulary, never an authorization by itself. */
export const PROJECT_ELEVATION_MODE = 'administrator';
export const PROJECT_ELEVATION_SCOPE = 'current_project';
export const PROJECT_ELEVATION_RPC = Object.freeze({ submit: 'management.elevated_submit', append: 'management.elevated_append',
  receipt: 'management.elevation_receipt', call: 'manager.administrator_call' });
export const PROJECT_ELEVATION_HTTP_BYTES = 512 * 1024;
export const PROJECT_ELEVATION_HTTP = Object.freeze({ submit: '/api/management/elevate', receipt: '/api/management/elevation-receipt' });
export const PROJECT_ELEVATION_RISK = '仅本条以当前项目管理员权限执行；不管理其他项目或设备全局设置，不是系统 root。执行中不逐项询问权限，但 Git、revision、生命周期和未知副作用保护仍有效。下一条默认普通权限。';
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
export function projectElevationJSON(value, depth = 0) {
  requireValue(depth < 20, 'elevation definition nesting exceeds limit');
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => projectElevationJSON(item, depth + 1));
  requireValue(object(value), 'elevation definition must be JSON');
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, projectElevationJSON(value[key], depth + 1)]));
}
export function normalizeProjectElevation(value) {
  requireValue(object(value), 'elevation definition required');
  const allowed = ['kind', 'mode', 'scope', 'instruction', 'client_request_id', 'draft_id', 'expected_revision', ...(value.kind === 'append' ? ['id'] : ['profile'])];
  requireValue(['submit', 'append'].includes(value.kind) && Object.keys(value).every(key => allowed.includes(key)), 'invalid elevation definition fields');
  requireValue(value.mode === PROJECT_ELEVATION_MODE && value.scope === PROJECT_ELEVATION_SCOPE, 'explicit project administrator mode required');
  requireValue(typeof value.instruction === 'string' && value.instruction.trim().length > 0 && value.instruction.length <= 32000, 'elevation instruction must be 1..32000 characters');
  requireValue(typeof value.client_request_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.client_request_id), 'elevation request identity required');
  if (value.kind === 'append') requireValue(Number.isSafeInteger(value.id) && value.id > 0, 'elevation target must be a positive Worker id');
  if (Object.hasOwn(value, 'profile')) requireValue(object(value.profile), 'elevation profile must be an object');
  if (Object.hasOwn(value, 'draft_id') || Object.hasOwn(value, 'expected_revision')) {
    requireValue(Number.isSafeInteger(value.draft_id) && value.draft_id > 0
      && (value.expected_revision === null || Number.isSafeInteger(value.expected_revision) && value.expected_revision > 0),
      'elevation draft requires draft_id and an exact expected_revision');
  }
  return projectElevationJSON(value);
}
export const projectElevationText = value => JSON.stringify(normalizeProjectElevation(value));
export function publicProjectElevation(occurrence) {
  return { mode: occurrence?.elevation?.mode === PROJECT_ELEVATION_MODE ? PROJECT_ELEVATION_MODE : 'ordinary', scope: PROJECT_ELEVATION_SCOPE };
}
