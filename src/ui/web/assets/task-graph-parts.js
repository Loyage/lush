import { badge, button, el } from './dom.js';
import { action } from './api.js';
import { promptDialog } from './dialog.js';
import { show } from './messages.js';
import { ui } from './state.js';
import { agentHelp } from './help.js';
import { workerLabel } from './worker-label.js';

/** Committed changes and uncommitted work are independent; unknown is never zero. */
export function branchDiagnostics(branch) {
  const data = branch.diagnostics;
  if (!data) return null;
  const box = el('div', undefined, 'graph-diagnostics');
  const changes = data.changes;
  if (changes?.status === 'ok') {
    const scale = el('div', undefined, 'graph-change-scale');
    scale.append(el('strong', `已提交：${changes.files_total} 个文件`),
      el('span', `+${changes.added}`, 'plus mono'), el('span', `−${changes.deleted} 行`, 'minus mono'));
    if (changes.binary_files) scale.append(el('span', `含 ${changes.binary_files} 个二进制文件（不计行数）`, 'meta'));
    box.append(scale, el('div', `相对创建起点 ${changes.base_commit.slice(0, 7)} → ${changes.head_commit.slice(0, 7)} · 累计净改动，不含未提交内容`, 'meta'));
    if (changes.files_total) {
      const body = el('div', undefined, 'graph-change-files');
      const list = el('ul', undefined, 'difflist');
      for (const file of changes.files || []) {
        const item = el('li');
        const name = file.previous_path ? `${file.previous_path} → ${file.path}` : file.path;
        item.append(el('span', name, 'path'), el('span', file.added === null ? '二进制' : `+${file.added} / −${file.deleted}`, 'stat'));
        list.append(item);
      }
      body.append(list);
      if (changes.truncated) body.append(el('p', `仅列出前 ${changes.files.length} / ${changes.files_total} 个文件；汇总包含全部文件。`, 'hint'));
      const toggle = button('文件改动列表', () => {
        if (ui.taskGraphFilesExpanded.has(branch.name)) ui.taskGraphFilesExpanded.delete(branch.name);
        else ui.taskGraphFilesExpanded.add(branch.name);
        paint();
      }, 'ghost');
      const paint = () => {
        const open = ui.taskGraphFilesExpanded.has(branch.name);
        body.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = `${open ? '收起' : '展开'}文件改动列表`;
      };
      paint(); box.append(toggle, body);
    }
  } else {
    const reason = { missing_head: '分支不存在', missing_baseline: '没有记录创建起点', read_failed: '无法读取起点或提交差异' }[changes?.reason] || '读取失败';
    box.append(el('div', `改动规模不可用：${reason}`, 'meta'));
  }
  const working = data.working_tree;
  if (working?.status === 'dirty' || working?.status === 'clean') {
    const text = working.files_total ? `未提交：${working.files_total} 个文件` : '工作区干净：无未提交文件';
    const counts = working.files_total ? ` · 暂存 ${working.staged} / 未暂存 ${working.unstaged} / 未跟踪 ${working.untracked} / 冲突 ${working.conflicts}` : '';
    const node = el('div', text + counts, working.files_total ? 'graph-pending warn' : 'meta');
    node.setAttribute('data-help', `${working.path}\n按文件去重计总数，分类可能重叠；不含忽略文件及 .lush 运行时目录。`);
    box.append(node);
  } else box.append(el('div', working?.status === 'not_checked_out' ? '未提交：未检出工作区' : '未提交：工作区状态未知', 'meta'));
  const latest = data.latest_commit;
  box.append(el('div', latest
    ? `最近提交：${new Date(latest.committed_at).toLocaleString('zh-CN', { hour12: false })} · ${latest.subject}`
    : '最近提交：不可用', 'graph-latest meta'));
  return box;
}

/** Inline decisions refresh only the caller's Task view. */
export function decisionRow(node, refresh) {
  const notice = node.notice;
  const decision = el('div', undefined, 'graph-decision');
  const head = el('div', undefined, 'graph-decision-head');
  head.append(badge({ question: '◔ 等你决定', plan: '计划待批' }[notice.kind] || '等你决定', 'b-awaiting'));
  if (notice.title) head.append(el('span', notice.title, 'graph-decision-title'));
  if (Number(node.notice_count) > 1) head.append(el('span', `另有 ${node.notice_count - 1} 条待决`, 'meta graph-decision-more'));
  decision.append(head, el('p', notice.body || '（没有补充说明）', 'graph-decision-body'));
  const actions = el('div', undefined, 'actions graph-decision-actions');
  const done = async message => { show(message); await refresh(); };
  if (notice.kind === 'plan') {
    actions.append(button('批准并开发', async () => {
      await action('plan.approve', { id: node.id });
      await done(`已批准 ${workerLabel(node)} 的拆解，交给 scheduler 编排`);
    }, 'primary', { agent: true, help: agentHelp('批准这份拆解并交给 scheduler 编排成真实 Worker，随后会启动开发 Agent 执行。') }));
    actions.append(button('驳回', async () => {
      const reason = await promptDialog({ title: `驳回 ${workerLabel(node)} 的拆解？`,
        message: '理由会送给 planner，让它据此重拆。', label: '驳回理由',
        placeholder: '例如：别动架构，先加个开关', confirmLabel: '驳回并重拆' });
      if (!reason?.trim()) return;
      await action('plan.reject', { id: node.id, reason: reason.trim() });
      await done(`已驳回 ${workerLabel(node)} 的拆解：${reason.trim()}`);
    }, undefined, { agent: true, help: agentHelp('把驳回理由送给 planner，让它据此重新拆解计划。') }));
    decision.append(actions); return decision;
  }
  const input = el('textarea', undefined, 'graph-decision-input');
  input.placeholder = '你的决定；⌘/Ctrl+回车提交'; input.rows = 3;
  const release = () => { input.value = ''; if (globalThis.document?.activeElement === input) input.blur?.(); };
  const reply = button('回复并继续 Worker', async () => {
    await action('notice.answer', { id: notice.id, answer: input.value });
    release(); await done(`已把答复发给 Worker ${workerLabel(node)}，它会继续跑`);
  }, undefined, { agent: true, help: agentHelp('把你的答复发给该 Worker 的 Agent，它会继续当前工作。') });
  input.addEventListener('keydown', async event => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault(); await reply.onclick();
  });
  actions.append(reply, button('忽略', async () => {
    await action('notice.dismiss', { id: notice.id });
    release(); await done(`已忽略 Worker ${workerLabel(node)} 的这条待决事项`);
  }, 'ghost', { help: '忽略这条待决事项，不代表批准；Worker 不会继续处理它。' }));
  decision.append(input, actions); return decision;
}
