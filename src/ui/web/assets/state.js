import { GRAPH_COLLAPSED_KEY, GRAPH_EXPANDED_KEY, parseGraphCollapsed, serializeGraphCollapsed } from './graph-layout.js';
import { readPref, writePref } from './prefs.js';

/* ---------- 偏好：折叠 / 筛选 / 排序都持久化到 localStorage ---------- */
// 键名、默认值与解析规则都在 prefs.js；这里只是转发，让老 import 继续可用。
export { SIDEBAR_SORT_KEY, LEGACY_TREE_SORT_KEY, SORT_IDS } from './prefs.js';
export function readSidebarSortPref() { return readPref('sidebarSort'); }
export function readCollapsedPref() { return readPref('collapsed'); }
/** 分支图的折叠按分支名存：重画（1.5s 轮询 / 手动刷新）后仍然收起。
 *  收起与展开分两个 key 记：默认值由「未合进父分支 / 在跑」决定，用户显式切换优先且不会被重画吞掉。 */
export function readGraphCollapsedPref() {
  try { return parseGraphCollapsed(localStorage.getItem(GRAPH_COLLAPSED_KEY)); } catch { return new Set(); }
}
export function readGraphExpandedPref() {
  try { return parseGraphCollapsed(localStorage.getItem(GRAPH_EXPANDED_KEY)); } catch { return new Set(); }
}
export function saveGraphPrefs() {
  try {
    localStorage.setItem(GRAPH_COLLAPSED_KEY, serializeGraphCollapsed(ui.graphCollapsed));
    localStorage.setItem(GRAPH_EXPANDED_KEY, serializeGraphCollapsed(ui.graphExpanded));
  } catch { /* 隐私模式里忽略 */ }
}
export function readFiltersPref() { return readPref('filters'); }
export function saveCollapsedPref() { writePref('collapsed', ui.collapsed); }
export function saveFiltersPref() { writePref('filters', ui.filters); }

/**
 * 共享可变状态。面板之间只通过这个对象交换状态，不互相 import 实现；
 * 新字段加在这里就行，不用改别的文件。
 */
export const ui = {
  /** 左栏：折叠状态（Set of section id）与三组筛选条件，都持久化到 localStorage。 */
  collapsed: readCollapsedPref(),
  filters: readFiltersPref(),
  selected: null, selectedRevision: null, busy: false, offline: false, detailDirty: false, detailTask: null, detailRenderedAt: 0,
  /** 右侧信息页（notices / tasks / intents / specs）；左栏只做导航。 */
  indexOpen: null,
  /** 「文档」视图：打开期间轮询不用概览覆盖它，与 graphOpen 同一套排他规则。 */
  docsOpen: false, docsQuery: '',
  /** 「设置」视图：打开期间轮询不用概览覆盖它（设置页只受用户操作驱动）。 */
  settingsOpen: false,
  draftSignature: null,
  // 意图面板的重建哨兵：planner 状态、闸门、spec 计数、scheduler 进度变了才重画。
  intentSignature: null,
  // 拆解队列的重建哨兵：id/status/batch_id/task_id 变化才重画，轮询不冲掉滚动。
  specSignature: null,
  draftIds: [], draftEditing: null, draftPanelOpen: false, composerExpanded: false,
  // 尚未加入草稿的输入框引用；引用随 draft.add 持久化，轮询不能清掉本地选择。
  composerReferences: [],
  // 左侧「待定事项」只是索引；右侧展开的那条 notice 由 noticeFocus 记住，数据每次都取自最新 snapshot。
  noticeFocus: null, noticeIndex: new Map(),
  questionDrafts: new Map(), // 当前会话草稿；sessionStorage 可跨刷新恢复
  // 左栏四个列表共用的排序偏好（smart / updated / id）。
  sidebarSortMode: readSidebarSortPref(),
  /** 分支图视图：打开期间轮询不用概览覆盖它；指纹 + 最小时隔决定要不要重拉 /api/graph。
   *  lastGraph 是最近一次拉到的 graph.get 读模型：分支图与概览共用同一份数据，
   *  概览因此不必新增 RPC，也不会各自打一次 git。 */
  graphOpen: false, graphFingerprint: null, graphFetchedAt: 0, graphRenderKey: null, lastGraph: null,
  /** 分支图里收起的分支名（Set）：收起的是整棵子树，持久化到 localStorage。
   *  graphExpanded 是用户显式展开的分支名：默认值只在两个集合里都没有时生效。 */
  graphCollapsed: readGraphCollapsedPref(),
  graphExpanded: readGraphExpandedPref(),
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
  ui.detailDirty = false; ui.detailTask = null; ui.detailRenderedAt = 0; ui.indexOpen = null; ui.docsOpen = false; ui.docsQuery = ''; ui.settingsOpen = false;
  ui.draftSignature = null; ui.draftEditing = null; ui.draftIds = []; ui.draftPanelOpen = false; ui.composerExpanded = false; ui.composerReferences = [];
  ui.intentSignature = null; ui.specSignature = null;
  ui.noticeFocus = null; ui.noticeIndex = new Map(); ui.questionDrafts = new Map();
  ui.lastSnapshot = null; ui.overviewKey = null; ui.liveBusy = false; ui.lastMergeResult = null;
  ui.graphOpen = false; ui.graphFingerprint = null; ui.graphFetchedAt = 0; ui.graphRenderKey = null; ui.lastGraph = null;
  ui.graphCollapsed = readGraphCollapsedPref();
  ui.graphExpanded = readGraphExpandedPref();
  ui.sideNodes = new Map(); ui.sideHeads = new Map(); ui.navButtons = new Map(); ui.navCounts = new Map();
  ui.stepToggle = new Map();
  ui.collapsed = readCollapsedPref(); ui.filters = readFiltersPref(); ui.sidebarSortMode = readSidebarSortPref();
  draftUnchecked.clear(); transcriptOpen.clear(); transcriptCache.clear(); mergeSelection.clear();
}
