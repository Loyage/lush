import { $, el, button } from './dom.js';
import { api } from './api.js';
import { detail } from './navigate.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';

const REFRESH_HELP = '重新读取当前项目 main 的最新主线历史并从第一页开始；只读 Git，不启动 Agent。';
const MORE_HELP = '沿首次读取时固定的 main 提交继续查看更早版本；不会混入刷新前后新增的提交。';
const text = (value, fallback = '未知') => typeof value === 'string' && value ? value : fallback;

/** Commit metadata and original say are always plain text, never executable markup. */
export function renderVersionCommit(commit) {
  const card = el('li', undefined, 'version-commit'); card.dataset.commit = commit.commit;
  card.append(el('h2', text(commit.subject, '（无提交摘要）')));
  const metadata = el('div', undefined, 'version-metadata');
  const sha = el('code', text(commit.commit), 'version-sha');
  sha.setAttribute('aria-label', `提交 SHA ${text(commit.commit)}`);
  const time = el('time', text(commit.committed_at));
  if (commit.committed_at) time.setAttribute('datetime', commit.committed_at);
  metadata.append(sha, time, el('span', `作者：${text(commit.author?.name)}`)); card.append(metadata);
  const tasks = commit.association === 'verified' && Array.isArray(commit.tasks) ? commit.tasks : [];
  if (!tasks.length) {
    card.append(el('p', '未关联 Task', 'version-unassociated'),
      el('p', '没有确切交付证据；不会根据提交标题猜测归属。', 'hint'));
  } else {
    card.append(el('p', '已核实 Task 交付关联', 'version-associated'));
    for (const task of tasks) {
      const entry = el('section', undefined, 'version-task');
      entry.append(button(`查看 Task #${task.id}`, () => detail(task.id), 'version-task-link',
        { help: '打开这次交付对应的 Task 详情，查看开发过程与结果；不启动 Agent。' }),
      el('p', text(task.goal, '（无 Task 目标）'), 'version-goal'));
      if (task.goal_truncated) entry.append(el('p', 'Task 目标已截断，可在详情中查看完整内容。', 'hint'));
      if (task.input) {
        const input = el('details', undefined, 'version-input');
        input.append(el('summary', `原始 say #${task.input.id}`), el('p', text(task.input.content, '（空输入）'), 'version-say'));
        if (task.input.truncated || task.input.content_truncated) input.append(el('p', '原始 say 内容已截断。', 'hint'));
        entry.append(input);
      }
      card.append(entry);
    }
  }
  if (commit.subject_truncated || commit.author?.name_truncated) card.append(el('p', '提交摘要或作者信息已截断。', 'hint'));
  return card;
}

function checkedPage(data) {
  if (data?.branch !== 'main' || !Array.isArray(data.commits) || typeof data.has_more !== 'boolean'
    || !(data.tip === null || typeof data.tip === 'string')
    || (data.has_more && (typeof data.cursor !== 'string' || !data.cursor))) {
    throw new Error('版本历史数据格式不兼容，请更新项目后台与界面服务。');
  }
  return data;
}

/** Explicit entry / refresh / pagination only; page and request identities discard late reads. */
export function openVersions() {
  const view = activateDetailView({ view: 'versions' });
  if (ui.versionsPage?.view === view) return ui.versionsPage.pending || Promise.resolve();
  const page = el('div', undefined, 'versions-page'), header = el('header', undefined, 'versions-head');
  const copy = el('div');
  copy.append(el('h1', '版本迭代'), el('p', 'main 主线 · 最新在前。每条记录代表一个主线提交，侧分支内部开发提交不混入列表；同一 Task 的多次交付分别保留。', 'hint'));
  const feedback = el('p', undefined, 'versions-feedback hint'); feedback.setAttribute('role', 'status');
  const tip = el('p', undefined, 'version-tip hint');
  const list = el('ol', undefined, 'versions-list'); list.setAttribute('aria-label', 'main 主线提交历史');
  const empty = el('p', undefined, 'hint'); empty.hidden = true;
  const footer = el('div', undefined, 'versions-footer');
  const state = { view, pending: null, request: 0, tip: null, cursor: null, count: 0, loaded: false, hasMore: false };
  ui.versionsPage = state;
  const ownsPage = () => ui.view === view && ui.versionsPage === state;
  const load = (more = false) => {
    if (!ownsPage()) return Promise.resolve();
    if (more && (state.pending || !state.hasMore)) return state.pending || Promise.resolve();
    const request = ++state.request, cursor = more ? state.cursor : null;
    const current = () => ownsPage() && state.request === request;
    moreButton.disabled = true;
    feedback.textContent = more ? '正在读取更早版本…' : '正在读取 main 主线历史…';
    feedback.className = 'versions-feedback hint'; feedback.setAttribute('role', 'status');
    page.setAttribute('aria-busy', 'true');
    const pending = (async () => {
      try {
        const data = checkedPage(await api(`/api/versions?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
        if (!current()) return;
        if (more && data.tip !== state.tip) throw new Error('历史分页基线发生变化，请刷新后重新读取。');
        const cards = data.commits.map(renderVersionCommit);
        if (!more) { list.replaceChildren(); state.count = 0; }
        list.append(...cards); state.count += cards.length;
        state.tip = data.tip; state.cursor = data.cursor; state.hasMore = data.has_more; state.loaded = true;
        tip.textContent = data.tip ? `本次历史固定于 main：${data.tip}` : '';
        empty.hidden = state.count > 0;
        empty.textContent = data.tip === null ? '本项目尚无 main 分支，暂时没有版本历史。' : 'main 主线暂无提交记录。';
        feedback.textContent = `已显示 ${state.count} 条主线提交${data.has_more ? '，可继续加载更早版本。' : '，已到最早版本。'} 页面不会自动刷新。`;
        moreButton.hidden = !state.hasMore;
      } catch (error) {
        if (!current()) return;
        feedback.textContent = `读取失败：${error.message}${state.loaded ? more ? '。已加载记录保留，可重试加载；若游标失效，请刷新历史从最新 main 重新读取。' : '。以下保留上次读取的旧历史，未取得最新版本。' : '。请重试。'}`;
        feedback.className = 'versions-feedback versions-error'; feedback.setAttribute('role', 'alert');
        moreButton.textContent = more ? '重试加载更早版本' : '加载更早版本';
      } finally {
        if (current()) {
          state.pending = null; page.setAttribute('aria-busy', 'false');
          refreshButton.textContent = state.loaded ? '刷新历史' : '重试读取';
          moreButton.disabled = !state.hasMore;
        }
      }
    })();
    state.pending = pending;
    return pending;
  };
  // Refresh can supersede an in-flight page read; its late result is discarded by request identity.
  const refreshButton = el('button', '刷新历史', 'versions-refresh'); refreshButton.type = 'button';
  refreshButton.onclick = () => load(); refreshButton.setAttribute('data-help', REFRESH_HELP);
  const moreButton = el('button', '加载更早版本', 'versions-more'); moreButton.type = 'button';
  moreButton.onclick = () => { moreButton.textContent = '加载更早版本'; return load(true); };
  moreButton.setAttribute('data-help', MORE_HELP); moreButton.hidden = true;
  const moreHost = el('span', undefined, 'help-host'); moreHost.setAttribute('data-help', MORE_HELP); moreHost.append(moreButton);
  footer.append(moreHost); header.append(copy, refreshButton); page.append(header, feedback, tip, empty, list, footer);
  $('detail').replaceChildren(page);
  return load();
}
