import { LushError, isPlainObject } from './types.js';

// Pure protocol data: Node tools, the daemon and both capability catalogues share
// these query contracts. No settings, transport, credentials or Runner imports.
export const WORKER_GRAPH_STATUSES = Object.freeze(['queued', 'running', 'waiting', 'awaiting', 'paused', 'awaiting_acceptance', 'completed', 'failed', 'cancelled']);
const graphScopes = ['all', 'tree'];
const listScopes = ['work', 'all'];
const integer = (minimum, maximum, defaultValue) => ({ type: 'integer', minimum,
  ...(maximum === undefined ? {} : { maximum }), ...(defaultValue === undefined ? {} : { default: defaultValue }) });
const object = properties => ({ type: 'object', additionalProperties: false, properties });
const scopedList = { type: 'string', enum: listScopes, default: 'work',
  description: '当前项目的列表范围：work 读取工作层，all 另含历史控制层；不是设备设置作用域。' };

export const WORKER_QUERY_CAPABILITIES = Object.freeze({
  'worker.graph': { schema: object({
    details: { type: 'boolean', default: true, description: 'false 只读结构摘要，不读取 Git 或会话正文。' },
    hidden_statuses: { type: 'array', items: { type: 'string', enum: WORKER_GRAPH_STATUSES }, uniqueItems: true,
      maxItems: WORKER_GRAPH_STATUSES.length, default: [] },
    include_archived: { type: 'boolean', default: true },
    cursor: { type: 'string', minLength: 1, maxLength: 1024, description: '原样使用上一页返回的 cursor；末页为 null，不再请求。' },
    scope: { type: 'string', enum: graphScopes, default: 'all',
      description: 'tree 读取开发卡片与 main 内 Valet 管理记录，all 另保留历史类型；管家不产生开发图边，不接受 development 或 device。' },
  }), examples: [{ details: false, scope: 'tree', hidden_statuses: ['completed', 'cancelled', 'awaiting_acceptance'] }],
  limitations: ['按返回的 cursor/has_more 续读，用户单页最多 200 节点、管家单页最多 100 条安全元数据；摘要不是全库', 'scope 是查询范围，不是设备设置；counts 不受 hidden_statuses 影响'] },
  'worker.list': { schema: object({ after: integer(0, undefined, 0), limit: integer(1, 1000, 200),
    paged: { type: 'boolean', default: false, description: '显式分页读面返回 tasks/page，游标基于实际条数和字节预算；省略时保留历史数组协议。' } }),
    examples: [{ after: 0, limit: 100, paged: true }], limitations: ['按内部 ID 升序、有界返回；after 取最后一条实际返回的内部 ID，不是 W/V 编号', 'paged=true 保留实际 has_more、总数、字节裁剪和游标；管家实际 limit 最多 100。旧数组协议不承诺完整性。'] },
  'worker.activity': { schema: object({ limit: integer(1, 200, 50), scope: scopedList }),
    examples: [{ limit: 50, scope: 'work' }], limitations: ['活动项加有界历史尾部；不是全部开发任务的完成证明'] },
  'worker.page': { schema: object({ before: { anyOf: [integer(1), { type: 'null' }], default: null },
    limit: integer(1, 200, 50), scope: scopedList }), examples: [{ before: null, limit: 50, scope: 'work' }],
    limitations: ['只读取历史终态项；活动工作用 worker.activity，续读使用返回的 cursor/has_more', '管家单页最多 100 条，返回的 limit 与 cursor 均按实际页大小计算'] },
  'manager.query': { schema: object({ id: integer(1) }), examples: [{}],
    limitations: ['省略 id 最多返回最近 100 个开发 Worker，可能另按字节裁剪；不是全库完成证明', '单目标传内部 ID；工具的 worker 参数可用真实 W/V 编号解析'] },
  'manager.history': { schema: object({ id: integer(1), before: integer(1), limit: integer(1, 100, 30) }),
    examples: [{ limit: 30 }], limitations: ['只返回安全调用元数据，按 next_cursor 续读，不含原始会话正文'] },
});

export const WORKER_QUERY_PARAMETERS = Object.freeze(Object.fromEntries(Object.entries(WORKER_QUERY_CAPABILITIES)
  .map(([method, { schema }]) => [method, Object.freeze(Object.keys(schema.properties))])));

// Only this code-owned query preflight may produce the allowlisted error code.
// Generic handler/permission/transport failures never imply "not executed".
export const INVALID_WORKER_QUERY_CODE = -32030;
function matches(schema, value) {
  if (schema.anyOf) return schema.anyOf.some(part => matches(part, value));
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= schema.minimum
    && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'string') return typeof value === 'string'
    && (schema.minLength === undefined || value.length >= schema.minLength)
    && (schema.maxLength === undefined || value.length <= schema.maxLength);
  if (schema.type === 'array') return Array.isArray(value) && value.length <= schema.maxItems
    && (!schema.uniqueItems || new Set(value).size === value.length) && value.every(item => matches(schema.items, item));
  return false;
}
function expected(schema) {
  if (schema.anyOf) return schema.anyOf.map(expected).join(' 或 ');
  if (schema.enum) return schema.enum.join(' | ');
  if (schema.type === 'integer') return `integer ≥ ${schema.minimum}${schema.maximum === undefined ? '' : ` 且 ≤ ${schema.maximum}`}`;
  if (schema.type === 'array') return `array（最多 ${schema.maxItems} 项、不可重复；每项 ${expected(schema.items)}）`;
  if (schema.type === 'string') return `string（长度 ${schema.minLength ?? 0}..${schema.maxLength ?? '不限'}）`;
  return schema.type;
}
const invalidObject = method => `${method} 查询参数必须为目录 schema 中的对象，不接受未知字段；本次查询未执行。`;
const invalidField = (method, field, schema) => `${method}.${field} 必须为 ${expected(schema)}；请按目录 schema 修正。本次查询未执行。`;
const safeMessages = new Set(Object.entries(WORKER_QUERY_CAPABILITIES).flatMap(([method, { schema }]) => [invalidObject(method),
  ...Object.entries(schema.properties).map(([field, spec]) => invalidField(method, field, spec))]));

/** A bounded validator only for the simple query schemas above, not general JSON Schema. */
export function validateWorkerQuery(method, params) {
  const schema = WORKER_QUERY_CAPABILITIES[method]?.schema;
  if (!schema) return;
  let message;
  if (!isPlainObject(params) || Object.keys(params).some(key => !Object.hasOwn(schema.properties, key))) message = invalidObject(method);
  else for (const [field, spec] of Object.entries(schema.properties)) {
    if (params[field] !== undefined && !matches(spec, params[field])) { message = invalidField(method, field, spec); break; }
  }
  if (message) throw new LushError(message, INVALID_WORKER_QUERY_CODE);
}

/** Never relay arbitrary daemon errors, even if they claim the query error code. */
export function safeWorkerQueryError(error) {
  const message = error?.message ?? error?.error;
  if (error?.code !== INVALID_WORKER_QUERY_CODE || !safeMessages.has(message)) return null;
  return { error: message, code: INVALID_WORKER_QUERY_CODE, kind: 'invalid_parameters', execution: 'not_started' };
}
