// 前端唯一入口：装配顶部按钮、hashchange 与两个定时器；其余职责都在同目录的模块里。
import { $, el } from './dom.js';
import { LIVE_INTERVAL } from './live.js';
import { detail, overview } from './navigate.js';
import { liveRefresh, refresh } from './refresh.js';
import { renderTree } from './render-tree.js';
import { initSidebar } from './sidebar-init.js';
import { SORT_IDS, TREE_SORT_KEY, resetUiState, ui } from './state.js';
import { syncMarkdownToggle, toggleMarkdown } from './text.js';
import { initComposer } from './composer.js';
import { SORT_MODES } from './tree-order.js';

/* ---------- 任务树排序偏好 ---------- */
function syncTreeSortSelect() {
  const select = $('tree-sort');
  select.replaceChildren(...SORT_MODES.map(mode => { const option = el('option', mode.label); option.value = mode.id; return option; }));
  select.value = ui.treeSortMode;
  select.title = '智能排序：有未答复问题的任务排最前，正在跑的次之，等你批准合并的再次之，已合并 / 失败 / 取消的沉到最后；父任务带着活跃子树一起靠前，只有同一层兄弟会换位置。';
}
function onTreeSortChange() {
  const value = $('tree-sort').value;
  ui.treeSortMode = SORT_IDS.has(value) ? value : 'smart';
  try { localStorage.setItem(TREE_SORT_KEY, ui.treeSortMode); } catch { /* 隐私模式里忽略 */ }
  if (ui.lastSnapshot) renderTree(ui.lastSnapshot);
}

const linked = taskId => /^#task-(\d+)$/.test(taskId) ? Number(taskId.slice(6)) : null;
function onHashChange() {
  const next = linked(location.hash);
  // 后退到没有 hash 的地址＝用户想回概览：只画详情不换面板会让合并按钮彻底消失。
  if (!next) { if (ui.selected !== null) overview().catch(error => { $('error').textContent = error.message; }); return; }
  if (next !== ui.selected) detail(next).catch(error => { $('error').textContent = error.message; });
}

// 上一次注册的定时器与监听器；重复 boot() 前必须先清掉（bun test 在文件之间复用模块注册表）。
let refreshTimer = null, liveTimer = null, hashListener = null;

/**
 * 装配页面：先清掉上一次的定时器 / window 监听器，再按当前全局 DOM 重新接一遍。
 * 浏览器里只跑一次；DOM 测试会重复调用它来换上自己的 stub。
 */
export async function boot() {
  if (refreshTimer !== null && typeof clearInterval === 'function') clearInterval(refreshTimer);
  if (liveTimer !== null && typeof clearInterval === 'function') clearInterval(liveTimer);
  if (hashListener !== null && typeof removeEventListener === 'function') removeEventListener('hashchange', hashListener);
  refreshTimer = null; liveTimer = null; hashListener = null;
  resetUiState();
  $('md-toggle').onclick = toggleMarkdown;
  syncMarkdownToggle();
  syncTreeSortSelect();
  $('tree-sort').addEventListener('change', onTreeSortChange);
  initComposer();
  $('home').onclick = () => { overview().catch(error => { $('error').textContent = error.message; }); };
  initSidebar();
  await refresh();
  const initial = linked(location.hash);
  if (initial) { try { await detail(initial); } catch (error) { $('error').textContent = error.message; } }
  hashListener = onHashChange;
  addEventListener('hashchange', hashListener);
  refreshTimer = setInterval(refresh, 1500);
  liveTimer = setInterval(liveRefresh, LIVE_INTERVAL);
}

await boot();
