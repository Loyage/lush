import { COLLAPSED_KEY, FILTERS_KEY, parseCollapsed, serializeCollapsed, parseFilters } from './sidebar.js';
import { SORT_MODES } from './tree-order.js';

/* ---------- 偏好：折叠 / 筛选 / 排序都持久化到 localStorage ---------- */
// 排序以前只作用于任务树（lush.treeSort）；改成左栏全局后换 key，读取时回落旧 key，老用户的选择不丢。
export const SIDEBAR_SORT_KEY = 'lush.sidebarSort';
export const LEGACY_TREE_SORT_KEY = 'lush.treeSort';
export const SORT_IDS = new Set(SORT_MODES.map(mode => mode.id));
export function readSidebarSortPref() {
  try {
    const value = localStorage.getItem(SIDEBAR_SORT_KEY) ?? localStorage.getItem(LEGACY_TREE_SORT_KEY);
    return SORT_IDS.has(value) ? value : 'smart';
  } catch { return 'smart'; }
}
export function readCollapsedPref() {
  try { return parseCollapsed(localStorage.getItem(COLLAPSED_KEY)); } catch { return new Set(); }
}
export function readFiltersPref() {
  try { return parseFilters(localStorage.getItem(FILTERS_KEY)); } catch { return parseFilters(null); }
}
export function saveCollapsedPref() {
  try { localStorage.setItem(COLLAPSED_KEY, serializeCollapsed(ui.collapsed)); } catch { /* 隐私模式里忽略 */ }
}
export function saveFiltersPref() {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(ui.filters)); } catch { /* 隐私模式里忽略 */ }
}

/**
 * 共享可变状态。面板之间只通过这个对象交换状态，不互相 import 实现；
 * 新字段加在这里就行，不用改别的文件。
 */
export const ui = {
  /** 左栏：折叠状态（Set of section id）与三组筛选条件，都持久化到 localStorage。 */
  collapsed: readCollapsedPref(),
  filters: readFiltersPref(),
  selected: null, selectedRevision: null, busy: false, offline: false, detailDirty: false, detailTask: null, detailRenderedAt: 0,
  draftSignature: null,
  // 意图面板的重建哨兵：planner 状态、闸门、spec 计数、scheduler 进度变了才重画。
  intentSignature: null,
  // 拆解队列的重建哨兵：id/status/batch_id/task_id 变化才重画，轮询不冲掉滚动。
  specSignature: null,
  draftIds: [], draftEditing: null, draftPanelOpen: false,
  // 左侧「待定事项」只是索引；右侧展开的那条 notice 由 noticeFocus 记住，数据每次都取自最新 snapshot。
  noticeFocus: null, noticeIndex: new Map(),
  // 左栏四个列表共用的排序偏好（smart / updated / id）。
  sidebarSortMode: readSidebarSortPref(),
  /** 分支图视图：打开期间轮询不用概览覆盖它；指纹 + 最小时隔决定要不要重拉 /api/graph。 */
  graphOpen: false, graphFingerprint: null, graphFetchedAt: 0, graphRenderKey: null,
  lastSnapshot: null,   // 切排序模式要立刻重排，不必等下一次轮询
  sideNodes: new Map(),      // section id -> 区块 <section>
  sideHeads: new Map(),      // section id -> 标题按钮
  navButtons: new Map(),     // section id -> 导航按钮
  navCounts: new Map(),      // section id -> 导航计数
  /** 最近一次批量合并的逐条结果，刷新后仍留在页面上，直到用户收起。 */
  lastMergeResult: null,
  overviewKey: null,
  liveBusy: false,
  // `<taskId>:<seq>` -> 用户显式选择的展开状态，重画详情不会丢
  stepToggle: new Map(),
};

// 勾选与编辑态都按草稿 id 记，这样轮询重建时不会丢用户的意图；默认全选。
export const draftUnchecked = new Set();
export const transcriptOpen = new Set();    // 用户展开过「执行过程」的任务
export const transcriptCache = new Map();   // taskId -> 已加载的步骤窗口
/** 勾选状态按 id 存：任务树 / 阶梯每次重画都从它取，轮询不会把勾选丢掉。 */
export const mergeSelection = new Set();

/**
 * 把共享可变状态复位。boot() 在重新装配前调用：bun test 在多个测试文件之间共享模块注册表，
 * 上一个文件留下的哨兵（signature）会让新 DOM 上的第一次轮询直接 return，什么都不画。
 */
export function resetUiState() {
  ui.selected = null; ui.selectedRevision = null; ui.busy = false; ui.offline = false;
  ui.detailDirty = false; ui.detailTask = null; ui.detailRenderedAt = 0;
  ui.draftSignature = null; ui.draftEditing = null; ui.draftIds = []; ui.draftPanelOpen = false;
  ui.intentSignature = null; ui.specSignature = null;
  ui.noticeFocus = null; ui.noticeIndex = new Map();
  ui.lastSnapshot = null; ui.overviewKey = null; ui.liveBusy = false; ui.lastMergeResult = null;
  ui.graphOpen = false; ui.graphFingerprint = null; ui.graphFetchedAt = 0; ui.graphRenderKey = null;
  ui.sideNodes = new Map(); ui.sideHeads = new Map(); ui.navButtons = new Map(); ui.navCounts = new Map();
  ui.stepToggle = new Map();
  ui.collapsed = readCollapsedPref(); ui.filters = readFiltersPref(); ui.sidebarSortMode = readSidebarSortPref();
  draftUnchecked.clear(); transcriptOpen.clear(); transcriptCache.clear(); mergeSelection.clear();
}
