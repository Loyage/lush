import { onPrefChange, readPref, writePref } from './prefs.js';

/* ---------- 偏好：折叠 / 筛选 / 排序都持久化到 localStorage ---------- */
// 键名、默认值与解析规则都在 prefs.js；这里只是转发，让老 import 继续可用。
export { SIDEBAR_SORT_KEY, LEGACY_TREE_SORT_KEY, SORT_IDS } from './prefs.js';
export function readSidebarSortPref() { return readPref('sidebarSort'); }
export function readCollapsedPref() { return readPref('collapsed'); }
export function readFiltersPref() { return readPref('filters'); }
export function saveCollapsedPref() { writePref('collapsed', ui.collapsed); }
export function saveFiltersPref() { writePref('filters', ui.filters); }

/**
 * 共享可变状态。面板之间只通过这个对象交换状态，不互相 import 实现；
 * 新字段加在这里就行，不用改别的文件。
 */
export const ui = {
  view: null, // 当前页面身份；仅 sidebar-ui.js 写入，异步响应据此判断是否仍拥有画布。
  /** 左栏：折叠状态（Set of section id）与三组筛选条件，都持久化到 localStorage。 */
  collapsed: readCollapsedPref(),
  filters: readFiltersPref(),
  selected: null, selectedRevision: null, busy: false, offline: false, detailDirty: false, detailTask: null, detailRenderedAt: 0,
  /** 右侧信息页（notices / tasks / intents / specs）；左栏只做导航。 */
  indexOpen: null,
  /** 「文档」视图：打开期间轮询不用概览覆盖它，由统一页面身份保护。 */
  docsOpen: false, docsQuery: '',
  /** 「设置」视图：打开期间轮询不用概览覆盖它（设置页只受用户操作驱动）。 */
  settingsOpen: false,
  statisticsOpen: false, statisticsFilters: null,
  agentStatusPage: null, // 页面与查询身份；仅进入 Agent 状态和手动刷新时取数。
  versionsPage: null, // main 历史固定 tip、分页与请求身份；仅显式读取。
  inputsPage: null, // 全库输入搜索、分页与本地编辑；不受 overview 轮询影响。
  hooksPage: null, hookCatalogue: null, hookCataloguePending: null,
  composerParents: [], composerIdentity: null, composerTask: null, composerError: null, syncComposer: null, composerEditRevision: 0, composerReferenceRevision: 0,
  transcriptView: null,
  draftSignature: null,
  // 意图面板的重建哨兵：planner 状态、闸门、spec 计数、scheduler 进度变了才重画。
  intentSignature: null,
  // 拆解队列的重建哨兵：id/status/batch_id/task_id 变化才重画，轮询不冲掉滚动。
  specSignature: null,
  draftIds: [], draftEditing: null, draftPanelOpen: false, composerExpanded: false, composerSubmitting: false, composerStartNow: false,
  // 尚未加入草稿的输入框引用；引用随 draft.add 持久化，轮询不能清掉本地选择。
  composerReferences: [],
  // 左侧「待定事项」只是索引；右侧展开的那条 notice 由 noticeFocus 记住，数据每次都取自最新 snapshot。
  noticeFocus: null, noticeIndex: new Map(), noticeRecords: null, loadNoticeRecords: null,
  noticeReadPending: new Map(), noticeReadRows: new Map(),
  questionDrafts: new Map(), // 当前会话草稿；sessionStorage 可跨刷新恢复
  // 左栏四个列表共用的排序偏好（smart / updated / id）。
  sidebarSortMode: readSidebarSortPref(),
  deletedWorkerIds: new Set(), // 已删除身份不复用；阻止在途读响应把已删缓存/卡片复活。
  workerNumbers: new Map(), // 已知用户编号的项目作用域有界缓存，仅展示；不存储业务身份。
  taskGraphFetchedAt: 0, taskGraphIds: new Set(),
  taskGraphMinimal: readPref('taskGraphMinimal'),
  /** Task 图里是否临时显示已归档 Task（默认隐藏，随页面重开复位）。 */
  taskGraphShowArchived: false,
  taskGraphFilesExpanded: new Set(), // 文件明细只记会话内展开，轮询保留。
  lastSnapshot: null,   // 切排序模式要立刻重排，不必等下一次轮询
  taskHistory: [],      // 用户显式加载的历史任务页；有界轮询不会把它们立刻抹掉
  taskHistoryPage: null,
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

// 保留存储不可用时的本轮选择；设置页恢复默认也同步回内存。
onPrefChange('taskGraphMinimal', value => { ui.taskGraphMinimal = value; });

// 编辑态按草稿 id 记，这样轮询重建时不会丢用户的意图。
export const transcriptOpen = new Set();    // 用户展开过「执行过程」的任务
export const transcriptCache = new Map();   // taskId -> 已加载的步骤窗口
/** 勾选状态按 id 存：任务树 / 阶梯每次重画都从它取，轮询不会把勾选丢掉。 */
export const mergeSelection = new Set();

/**
 * 把共享可变状态复位。boot() 在重新装配前调用：bun test 在多个测试文件之间共享模块注册表，
 * 上一个文件留下的哨兵（signature）会让新 DOM 上的第一次轮询直接 return，什么都不画。
 */
export function resetUiState() {
  ui.view = null; ui.inputsPage = null; ui.hooksPage = null; ui.hookCatalogue = null; ui.hookCataloguePending = null; ui.deletedWorkerIds = new Set(); ui.workerNumbers = new Map();
  ui.composerParents = []; ui.composerIdentity = null; ui.composerTask = null; ui.composerError = null; ui.syncComposer = null; ui.composerEditRevision = 0; ui.composerReferenceRevision = 0;
  ui.selected = null; ui.selectedRevision = null; ui.busy = false; ui.offline = false;
  ui.statisticsOpen = false; ui.statisticsFilters = null; ui.transcriptView = null; ui.agentStatusPage = null; ui.versionsPage = null;
  ui.detailDirty = false; ui.detailTask = null; ui.detailRenderedAt = 0; ui.indexOpen = null; ui.docsOpen = false; ui.docsQuery = ''; ui.settingsOpen = false;
  ui.draftSignature = null; ui.draftEditing = null; ui.draftIds = []; ui.draftPanelOpen = false; ui.composerExpanded = false; ui.composerSubmitting = false; ui.composerStartNow = false; ui.composerReferences = [];
  ui.intentSignature = null; ui.specSignature = null;
  ui.noticeReadPending = new Map(); ui.noticeReadRows = new Map();
  ui.noticeFocus = null; ui.noticeIndex = new Map(); ui.questionDrafts = new Map(); ui.noticeRecords = null; ui.loadNoticeRecords = null;
  ui.lastSnapshot = null; ui.taskHistory = []; ui.taskHistoryPage = null; ui.overviewKey = null; ui.liveBusy = false; ui.lastMergeResult = null;
  ui.taskGraphFetchedAt = 0; ui.taskGraphIds = new Set(); ui.taskGraphShowArchived = false;
  ui.taskGraphFilesExpanded = new Set(); ui.taskGraphMinimal = readPref('taskGraphMinimal');
  ui.sideNodes = new Map(); ui.sideHeads = new Map(); ui.navButtons = new Map(); ui.navCounts = new Map();
  ui.stepToggle = new Map();
  ui.collapsed = readCollapsedPref(); ui.filters = readFiltersPref(); ui.sidebarSortMode = readSidebarSortPref();
  transcriptOpen.clear(); transcriptCache.clear(); mergeSelection.clear();
}
