import { el, block, button, kv } from './dom.js';
import { api, action } from './api.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { show } from './messages.js';
import { detail } from './navigate.js';

export async function startBranchShowcase(branch) {
  const graph = await api('/api/graph');
  const node = (graph.nodes || []).find(item => item.kind === 'branch' && item.name === branch);
  if (node?.showcase?.allowed !== true) {
    show(node?.showcase?.reason || '该分支暂不满足效果展示条件，请刷新分支详情。', 'error');
    return;
  }
  if (!await confirmDialog({ title: `展示 ${branch} 的效果？`,
    message: '专用 agent 会在隔离工作区分析修改、设计并执行展示方案。可能运行项目代码与本机预览；展示不代表检验通过，不自动合并。',
    detail: `对比起点：${node.created_from_commit}\n预览保留到你停止或 daemon 退出；不改变用户当前分支。`,
    confirmLabel: '开始效果展示',
    agent: true, confirmHelp: agentHelp('启动专用展示 Agent 分析修改并生成可运行的效果展示。') })) return;
  const task = await action('showcase.start', { branch, baseline: null });
  if (task?.id) await detail(task.id);
  return task;
}

export function renderShowcase(task) {
  const value = task.showcase;
  const section = block('效果展示');
  section.classList.add('showcase-panel');
  if (!value) return section;
  section.append(kv('展示分支', value.branch), kv('固定提交', value.commit), kv('对比起点', value.baseline_commit));
  section.append(el('p', '展示完成 ≠ 检验通过。未提交修改不在展示中；合并仍需你明确批准。', 'hint'));
  if (task.report) {
    if (['failed','cancelled'].includes(task.status)) section.append(el('p',
      `本次调用${task.status === 'failed' ? '失败' : '已取消'}；下方是中断前写入的未确认展示页，可能不完整。请结合错误与执行过程检查，必要时重试。`,
      'hint warn showcase-partial'));
    const report = el('a', '新窗口打开展示页', 'link');
    report.href = `/api/task/${task.id}/report`; report.target = '_blank'; report.rel = 'noopener noreferrer';
    const frame = el('iframe');
    frame.title = `效果展示 #${task.id}`; frame.src = report.href;
    frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.className = 'showcase-report';
    section.append(report, frame);
  } else section.append(el('p', ['failed','cancelled'].includes(task.status) ? '未生成展示页；查看执行过程与错误，可检查后重试。' : 'agent 正在分析修改并准备展示，展示页就绪后会出现在这里。', 'hint'));
  const preview = value.preview;
  if (preview?.status === 'running' && preview.url) {
    // Only accept the runtime's loopback URL, never arbitrary HTML/agent schemes.
    let url;
    try { url = new URL(preview.url); } catch { /* invalid */ }
    if (url?.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && !url.username && !url.password) {
      const link = el('a', '打开可操作预览 ↗', 'link');
      link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      section.append(link, button('停止预览', async () => { await action('showcase.stop', { id: task.id }); await detail(task.id); }, 'ghost',
        { help: '停止本机预览服务；静态展示页不受影响。' }));
      section.append(el('p', '本机预览：请在 daemon 所在电脑打开。服务独立于 Lush 登录会话；daemon 退出后停止，不自动重启。', 'hint'));
    }
  } else section.append(el('p', `可运行预览：${preview?.status === 'starting' ? '正在启动' : '未运行'}。${preview?.error || '静态展示页不受影响。'}`, 'hint'));
  return section;
}
