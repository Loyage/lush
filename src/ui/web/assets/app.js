import { agentHelp, initHelp } from './help.js';

const $ = id => document.getElementById(id);
const prefix = /^\/p\/[a-z0-9]{16}(?=\/|$)/.exec(location.pathname)?.[0] ?? '';
const text = (tag, value, className) => {
  const node = document.createElement(tag);
  node.textContent = String(value ?? '');
  if (className) node.className = className;
  return node;
};
function button(label, callback, { help, agent = false, danger = false } = {}) {
  const node = text('button', label);
  node.type = 'button';
  if (help) node.dataset.help = agent ? agentHelp(help) : help;
  if (agent) node.classList.add('agent-call');
  if (danger) node.classList.add('danger');
  node.addEventListener('click', async () => {
    node.disabled = true;
    try { await callback(); } catch (error) { feedback(error.message, true); }
    finally { node.disabled = false; }
  });
  return node;
}
function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').classList.toggle('error', error);
}
async function request(path, options = {}) {
  const response = await fetch(prefix + path, options);
  const value = await response.json();
  if (!response.ok || value?.error) throw new Error(value?.error ?? `HTTP ${response.status}`);
  return value;
}
const action = (method, params) => request('/api/action', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }),
});
async function refresh() {
  const [tasks, notices] = await Promise.all([request('/api/tasks?limit=100'), request('/api/notices?status=open&limit=50')]);
  $('tasks').replaceChildren(...tasks.tasks.filter(task => ['say','child','main','owner'].includes(task.task_kind)).reverse().map(task => {
    const item = document.createElement('li');
    item.append(button(`#${task.id} · ${task.status} · ${task.goal?.slice(0, 140) ?? task.task_kind}`, () => openTask(task.id),
      { help: '查看目标、消息、交付状态和固定提交' }));
    return item;
  }));
  $('notices').replaceChildren(...notices.notices.map(notice => {
    const item = document.createElement('li');
    item.append(text('p', `#${notice.id} · ${notice.title}`), text('p', notice.body ?? '', 'muted'));
    if (notice.kind !== 'questionnaire') item.append(button('答复', async () => {
      const answer = prompt(`答复 #${notice.id}`);
      if (answer === null) return;
      await action('notice.answer', { id: notice.id, answer });
      await refresh();
    }, { agent: true, help: '把答案提交给等待中的任务，可能唤醒 Agent；提交后无法撤回' }));
    else item.append(text('small', `结构化问卷请用 CLI：lush notice answer ${notice.id} --answers-file FILE`));
    return item;
  }));
}
async function openTask(id) {
  const task = await request(`/api/task/${id}`);
  const detail = $('task-detail');
  detail.hidden = false;
  detail.replaceChildren(text('h2', `Task #${task.id} · ${task.status}`), text('p', task.goal),
    text('p', `分支：${task.branch ?? '无'} · 基线：${task.base_commit ?? '无'} · 顶端：${task.head_commit ?? '无'}`, 'muted'));
  if (task.result) detail.append(text('h3', '结果'), text('p', task.result));
  if (task.error) detail.append(text('p', task.error, 'muted'));
  const actions = text('div', '', 'actions');
  if (['say','child'].includes(task.task_kind) && !['completed','cancelled','failed'].includes(task.status)) {
    actions.append(button('追加消息', async () => {
      const body = prompt('给 Task 的补充说明');
      if (!body?.trim()) return;
      await action('task.message', { id, body }); await openTask(id);
    }, { agent: true, help: '下一轮调用时交给同一个 Task；可能唤醒 Agent，但不会创建新任务' }));
    actions.append(button('派子任务', async () => {
      const goal = prompt('子任务目标');
      if (!goal?.trim()) return;
      await action('task.spawn', { parent: id, goal }); await refresh(); await openTask(id);
    }, { agent: true, help: '创建独立分支和 worktree，由子 Agent 执行' }));
  }
  if (task.task_kind === 'say') {
    const reservation = task.reservation;
    if (task.status === 'waiting' || (task.status === 'completed' && reservation?.kind === 'showcase')) {
      actions.append(button('请求合并 / 复查', async () => {
        await action('task.reserve', { id, kind: 'merge' }); await openTask(id);
      }, { help: '冻结固定提交并请求父 Task 集成；不会自动推进父分支' }));
    }
    if (reservation?.kind === 'merge' && ['pending','requested'].includes(reservation.status)) {
      detail.append(text('p', `合并请求：${reservation.status} · ${reservation.blocked_reason ?? ''}`));
      actions.append(button('撤销合并请求', async () => {
        if (!confirm('撤销请求并释放父分支交付锁？分支与提交将保留。')) return;
        await action('task.unreserve', { id }); await openTask(id);
      }, { help: '撤销尚未集成的请求；保留任务、工作区和提交', danger: true }));
      if (reservation.status === 'requested' && ['main','owner'].includes(task.parent_task_kind)) {
        actions.append(button('批准固定提交', async () => {
          if (!confirm(`将 ${reservation.commit} 按基线 ${reservation.baseline} 快进到父分支？请先审阅改动。`)) return;
          await action('task.approve_merge', { id, commit: reservation.commit, baseline: reservation.baseline });
          await refresh(); await openTask(id);
        }, { help: '核对固定提交和父分支基线后快进；不会合并未提交改动' }));
      }
      if (reservation.blocked_code === 'diverged') actions.append(button('派解分歧任务', async () => {
        await action('task.resolve_divergence', { id }); await refresh(); await openTask(id);
      }, { agent: true, help: '在独立工作区处理源提交与父提交的分歧，不直接合入父分支' }));
    }
    if (task.status === 'waiting' && !task.head_commit) actions.append(button('标记已解决', async () => {
      await action('task.resolve', { id }); await refresh(); await openTask(id);
    }, { help: '仅在无代码改动、无活动 Agent 且工作区干净时完成任务' }));
  }
  if (!['completed','failed','cancelled'].includes(task.status) && !['main','owner'].includes(task.task_kind)) {
    actions.append(button('取消任务', async () => {
      if (!confirm('取消任务及子树？不会强制删除分支或工作区。')) return;
      await action('task.cancel', { id }); await refresh(); await openTask(id);
    }, { help: '停止任务及子任务；已有工作区和历史保留', danger: true }));
  }
  if (['failed','cancelled'].includes(task.status)) actions.append(button('重试', async () => {
    await action('task.retry', { id }); await refresh(); await openTask(id);
  }, { agent: true, help: '检查失败现场后重新启动该 Task 的 Agent' }));
  actions.append(button('查看改动', async () => {
    const result = await request(`/api/task/${id}/diff`);
    detail.append(text('pre', JSON.stringify(result, null, 2)));
  }));
  actions.append(button('查看执行过程', async () => {
    const result = await request(`/api/task/${id}/transcript`);
    const entries = result.steps?.map(step => `#${step.seq} ${step.kind ?? ''}\n${step.text ?? step.body ?? JSON.stringify(step)}`) ?? [];
    detail.append(text('pre', entries.join('\n\n') || '暂无会话记录'));
    if (result.has_more) detail.append(text('small', '记录未全部加载；可用 lush task transcript ID 查看完整过程。'));
  }, { help: '按需读取任务会话；页面不会执行日志中的命令' }));
  detail.append(actions);
  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function launcher() {
  const status = await request('/api/launcher');
  if (status.mode !== 'launcher' || prefix) {
    $('workspace').hidden = false;
    $('project-home').hidden = status.mode !== 'launcher';
    $('project-name').textContent = status.projects?.find(row => `/p/${row.id}` === prefix)?.name ?? status.project ?? '';
    await refresh(); return;
  }
  $('launcher').hidden = false;
  $('projects').replaceChildren(...status.projects.map(row => {
    const item = document.createElement('li');
    item.append(button(row.project, () => { location.href = `/p/${row.id}/`; }));
    return item;
  }));
  $('project-form').onsubmit = async event => {
    event.preventDefault();
    try {
      const response = await fetch('/api/launcher/select', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: $('project-path').value }) });
      const value = await response.json();
      if (!response.ok || value.error) throw new Error(value.error ?? `HTTP ${response.status}`);
      location.href = `/p/${value.id}/`;
    } catch (error) { feedback(error.message, true); }
  };
}
$('say-form').onsubmit = async event => {
  event.preventDefault();
  const submit = $('say-submit'); submit.disabled = true;
  try {
    const branch = $('parent-branch').value.trim();
    const result = await action('say.submit', { content: $('goal').value, ...(branch ? { branch } : {}) });
    $('goal').value = ''; feedback(`已创建 Task #${result.task.id}`);
    await refresh(); await openTask(result.task.id);
  } catch (error) { feedback(error.message, true); }
  finally { submit.disabled = false; }
};
$('bind-form').onsubmit = async event => {
  event.preventDefault();
  const submit = $('bind-submit'); submit.disabled = true;
  try {
    const branch = $('bind-branch').value.trim(), commit = $('bind-commit').value.trim();
    if (!confirm(`确认 ${branch} 的 HEAD 是 ${commit}？绑定不会移动 Git ref。`)) return;
    const owner = await action('branch.bind', { branch, commit });
    feedback(`已绑定 owner Task #${owner.id}`); await refresh();
  } catch (error) { feedback(error.message, true); }
  finally { submit.disabled = false; }
};
$('say-submit').dataset.help = agentHelp('从父分支创建独立 Task、分支和 worktree');
$('refresh').onclick = () => refresh().catch(error => feedback(error.message, true));
initHelp();
launcher().catch(error => feedback(error.message, true));
