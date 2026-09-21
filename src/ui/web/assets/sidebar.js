/**
 * 左侧栏的纯逻辑：三个列表的筛选、筛选摘要，以及折叠 / 筛选状态的持久化形态。
 *
 * 为什么单独一个模块：筛选规则要能脱离浏览器单测（bun 直接 import），而 app.js 只负责把
 * 结果画出来、控件事件接回去。这里不碰 DOM、window、localStorage——读写 localStorage 由调用方做，
 * 本模块只负责把字符串解析成规整的集合 / 对象，坏数据一律回落成默认值，不让浏览器抛异常。
 *
 * 默认（空查询、无折叠）必须与改造前完全一致：三个 filter* 在没有任何条件时原样返回入参数组。
 */
import { treeParent } from './tree-order.js';

/**
 * 左栏的四个区块：导航条、折叠状态都按这个顺序走，DOM 顺序也必须是同一个顺序。
 * 待提交意图不在这里——它挂在底部 composer 里，见 composer.js。
 * 顺序即优先级：先看要人拍板的（待定事项），再回看输入与拆解，最后才是正在跑的行动任务。
 */
export const SIDEBAR_SECTIONS = [
  { id: 'notices', label: '待你决定', long: '待你决定', icon: '◔', description: '问题与计划审批' },
  { id: 'intents', label: '历史输入', long: '历史输入', icon: '⌁', description: '原始需求与规划过程' },
  { id: 'specs', label: '规划队列', long: '规划队列', icon: '◇', description: '拆解条目与编排批次' },
  { id: 'tasks', label: '行动任务', long: '行动任务', icon: '✓', description: '执行、依赖与结果' },
];
export const COLLAPSED_KEY = 'lush.sidebar.collapsed';
export const FILTERS_KEY = 'lush.sidebar.filters';

/** 任务树「合并」筛选的语义：unmerged = 还需要人动手的三种；merged = 已进目标分支。 */
export const UNMERGED = new Set(['pending', 'review', 'conflict']);

export const DEFAULT_FILTERS = Object.freeze({
  tasks: { status: 'all', role: 'all', integration: 'all', mine: false, text: '' },
  specs: { status: 'all', planner: 'all', role: 'all', text: '' },
  intents: { flow: 'all', gate: 'all', status: 'all', text: '' },
});

const SECTION_IDS = new Set(SIDEBAR_SECTIONS.map(section => section.id));

const STATUS_LABEL = { queued: '排队', running: '运行中', waiting: '等子任务', awaiting: '等你决定',
  completed: '已完成', failed: '失败', cancelled: '已取消' };
const SPEC_STATUS_LABEL = { pending: '排队中', planned: '已排期', dropped: '已丢弃' };
const ROLE_LABEL = { planner: '规划', scheduler: '调度', worker: '执行', coordinator: '协调',
  research: '调研', verifier: '检验', merger: '解冲突' };
const FLOW_LABEL = { develop: '开发', explain: '了解' };
const INTEGRATION_LABEL = { unmerged: '待合并', merged: '已合并' };

/* ---------- 持久化形态 ---------- */

/** localStorage 里的折叠列表 → Set；只保留已知区块，坏数据当空。 */
export function parseCollapsed(raw) {
  if (typeof raw !== 'string' || !raw) return new Set();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return new Set(); }
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter(id => SECTION_IDS.has(id)));
}

/** Set/数组 → localStorage 字符串；按区块顺序输出，结果稳定可断言。 */
export function serializeCollapsed(collapsed) {
  const set = collapsed instanceof Set ? collapsed : new Set(Array.isArray(collapsed) ? collapsed : []);
  return JSON.stringify(SIDEBAR_SECTIONS.map(section => section.id).filter(id => set.has(id)));
}

/** 折叠状态是不可变更新：返回新 Set，调用方负责存回 localStorage 与重画。 */
export function toggleCollapsed(collapsed, id, force) {
  const next = new Set(collapsed instanceof Set ? collapsed : []);
  const on = force === undefined ? !next.has(id) : Boolean(force);
  if (on) next.add(id); else next.delete(id);
  return next;
}

function defaultFilters() {
  return {
    tasks: { ...DEFAULT_FILTERS.tasks },
    specs: { ...DEFAULT_FILTERS.specs },
    intents: { ...DEFAULT_FILTERS.intents },
  };
}

/** localStorage 里的筛选状态 → 规整对象：缺项补默认、类型不符的一律丢弃。 */
export function parseFilters(raw) {
  const out = defaultFilters();
  if (typeof raw !== 'string' || !raw) return out;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return out; }
  if (!parsed || typeof parsed !== 'object') return out;
  for (const section of ['tasks', 'specs', 'intents']) {
    const source = parsed[section];
    if (!source || typeof source !== 'object') continue;
    for (const [key, fallback] of Object.entries(DEFAULT_FILTERS[section])) {
      const given = source[key];
      if (typeof fallback === 'boolean') { if (typeof given === 'boolean') out[section][key] = given; }
      else if (typeof given === 'string') out[section][key] = given;
    }
  }
  return out;
}

/* ---------- 查询规整 ---------- */

/** 单值或多值 → 字符串数组；'all' / 空 / null 都表示没有这个条件。 */
function pick(value) {
  if (Array.isArray(value)) {
    return value.filter(item => item !== undefined && item !== null && item !== '' && item !== 'all').map(String);
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value);
    return text === '' || text === 'all' ? [] : [text];
  }
  return [];
}

const keyword = value => (typeof value === 'string' ? value.trim().toLowerCase() : '');

/** 未答复 notice 的 task id：接受 Set、id 数组，或 notice 行对象（任一种调用方都方便）。 */
function noticeIds(value) {
  const raw = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
  return new Set(raw
    .map(entry => (entry && typeof entry === 'object' ? entry.task_id ?? entry.id : entry))
    .filter(id => id !== undefined && id !== null));
}

/* ---------- 三条筛选规则 ---------- */

/** 一个任务是否命中筛选条件（不含「保留祖先」那部分，祖先规则在 filterTasks 里）。 */
export function matchTask(task, query = {}) {
  const statuses = pick(query.status);
  if (statuses.length && !statuses.includes(task.status)) return false;
  const roles = pick(query.role);
  if (roles.length && !roles.includes(task.role)) return false;
  if (query.integration === 'unmerged' && !UNMERGED.has(task.integration)) return false;
  if (query.integration === 'merged' && task.integration !== 'merged') return false;
  // 只看待我处理 = 有未答复问题，或已完成且等你批准合并（pending / review）。
  if (query.mine) {
    const open = noticeIds(query.openNoticeIds);
    const pendingMerge = task.status === 'completed' && (task.integration === 'pending' || task.integration === 'review');
    if (!open.has(task.id) && !pendingMerge) return false;
  }
  const needle = keyword(query.text);
  if (needle) {
    const hay = `#${task.id}\n${task.id}\n${task.goal ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export function matchSpec(spec, query = {}) {
  const statuses = pick(query.status);
  if (statuses.length && !statuses.includes(spec.status)) return false;
  const planners = pick(query.planner);
  if (planners.length && !planners.includes(String(spec.planner_task_id))) return false;
  const roles = pick(query.role);
  if (roles.length && !roles.includes(spec.role)) return false;
  const needle = keyword(query.text);
  if (needle && !`${spec.goal ?? ''}\n${spec.name ?? ''}`.toLowerCase().includes(needle)) return false;
  return true;
}

export function matchIntent(intent, query = {}) {
  const flows = pick(query.flow);
  if (flows.length && !flows.includes(intent.flow)) return false;
  if (query.gate === 'proposed' && intent.plan_gate !== 'proposed') return false;
  const statuses = pick(query.status);
  if (statuses.length && !statuses.includes(intent.status)) return false;
  const needle = keyword(query.text);
  if (needle && !String(intent.content ?? '').toLowerCase().includes(needle)) return false;
  return true;
}

/** 有没有生效中的条件；没有就必须走「与改造前一致」的那条路径。 */
export function isFiltering(query = {}) {
  if (!query || typeof query !== 'object') return false;
  return pick(query.status).length > 0 || pick(query.role).length > 0 || pick(query.planner).length > 0
    || pick(query.flow).length > 0
    || (typeof query.integration === 'string' && query.integration !== '' && query.integration !== 'all')
    || (typeof query.gate === 'string' && query.gate !== '' && query.gate !== 'all')
    || query.mine === true || keyword(query.text) !== '';
}

/**
 * 任务树筛选：命中项 + 命中项的全部祖先（父被筛掉但有命中后代时，父作为通路保留）。
 * 子任务被筛掉时父仍可见——不反向补子节点，树只往上补。
 * 空查询返回入参数组本身，保证默认路径零开销、行为与改造前一致。
 */
export function filterTasks(tasks, query = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!isFiltering(query)) return list;
  const ids = new Set(list.map(task => task.id));
  const byId = new Map(list.map(task => [task.id, task]));
  const matched = new Set(list.filter(task => matchTask(task, query)).map(task => task.id));
  const visible = new Set(matched);
  for (const id of matched) {
    const seen = new Set([id]);
    let current = byId.get(id);
    while (current) {
      const parent = treeParent(current, ids);
      if (!parent || seen.has(parent)) break;   // 防环：坏数据下不无限上溯
      seen.add(parent);
      visible.add(parent);
      current = byId.get(parent);
    }
  }
  return list.filter(task => visible.has(task.id));
}

export function filterSpecs(specs, query = {}) {
  const list = Array.isArray(specs) ? specs : [];
  if (!isFiltering(query)) return list;
  return list.filter(spec => matchSpec(spec, query));
}

export function filterIntents(intents, query = {}) {
  const list = Array.isArray(intents) ? intents : [];
  if (!isFiltering(query)) return list;
  return list.filter(intent => matchIntent(intent, query));
}

/* ---------- 筛选摘要 ---------- */

/** 「匹配 N / 共 M」——列表计数统一用它，避免各处拼得不一样。 */
export function countText(matched, total) {
  return `匹配 ${matched} / 共 ${total}`;
}

/** 生效条件拼成一句短摘要，放进 title 与计数旁边；没有条件返回空串。 */
export function describeFilters(query = {}) {
  if (!query || typeof query !== 'object') return '';
  const parts = [];
  const statuses = pick(query.status);
  if (statuses.length) parts.push(`状态：${statuses.map(value => STATUS_LABEL[value] || SPEC_STATUS_LABEL[value] || value).join('/')}`);
  const roles = pick(query.role);
  if (roles.length) parts.push(`角色：${roles.map(value => ROLE_LABEL[value] || value).join('/')}`);
  if (query.integration === 'unmerged' || query.integration === 'merged') parts.push(`合并：${INTEGRATION_LABEL[query.integration]}`);
  const planners = pick(query.planner);
  if (planners.length) parts.push(`planner #${planners.join('、#')}`);
  const flows = pick(query.flow);
  if (flows.length) parts.push(`流程：${flows.map(value => FLOW_LABEL[value] || value).join('/')}`);
  if (query.gate === 'proposed') parts.push('等你批准');
  if (query.mine === true) parts.push('只看待我处理');
  const needle = keyword(query.text);
  if (needle) parts.push(`关键字“${needle}”`);
  return parts.join(' · ');
}
