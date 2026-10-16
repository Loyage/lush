import { el, kv } from './dom.js';
import { runnerVerification } from './runner-verification.js';

const states = { preparing: '准备中', ready: '已就绪（持久记录）', unknown: '未知', removed: '已回收（持久记录）' };
const barrierLabels = { bindings: '工作区／同步', runs: 'Run', receipts: '操作收据' };

/** Inspect-only location facts: never query settings, credentials or a remote workspace. */
export function renderWorkerRunner(task, previous = null, controls = null) {
  const root = el('section', undefined, 'worker-runner');
  root.setAttribute('aria-label', '执行环境');
  const runner = task.runner;
  if (!runner) {
    root.append(el('p', '执行环境：本地', 'worker-runner-summary'));
    return root;
  }
  root.append(el('p', `执行环境：远端节点 ${runner.node_id ?? '未知'} · 代次 ${runner.generation ?? '未知'}`, 'worker-runner-summary'));
  const state = states[runner.state] ?? '未知';
  root.append(el('p', `工作区状态：${state} · 项目授权：${runner.authorized === true ? '已授权' : runner.authorized === false ? '未授权' : '未知'}`, 'hint'));
  if (!Object.hasOwn(states, runner.state) || runner.state === 'unknown') {
    root.append(el('p', '远端现场未知：写入结果或停止证据尚未核实；不会自动迁移或在本地重跑。', 'error worker-runner-warning'));
  } else if (runner.state === 'preparing') {
    root.append(el('p', '工作区准备／同步尚未确认，需等待安全屏障结算。', 'error worker-runner-warning'));
  }
  if (runner.authorized !== true) root.append(el('p', runner.authorized === false
    ? '项目未授权此节点：新 Run 和工具准入受阻；撤权不代表进程已停止或现场已回收。'
    : '项目授权状态未知；不能据此确认可执行。', 'error worker-runner-warning'));
  const barriers = Object.entries(barrierLabels).map(([key, label]) => {
    const value = runner.barriers?.[key];
    return { label, count: Number.isSafeInteger(value) && value >= 0 ? value : null };
  });
  const unsettled = barriers.filter(row => row.count === null || row.count > 0);
  if (unsettled.length) root.append(el('p', `未结算屏障：${unsettled.map(row => `${row.label} ${row.count ?? '未知'}`).join(' · ')}。不代表已停止或可安全回收。`, 'error worker-runner-warning'));
  if (controls && ['ready', 'unknown'].includes(runner.state) && (runner.state === 'unknown' || unsettled.length))
    root.append(runnerVerification(task, controls));
  const advanced = el('details', undefined, 'worker-runner-details');
  advanced.open = previous?.querySelector('.worker-runner-details')?.open === true;
  advanced.append(el('summary', '执行环境详情'));
  const grid = el('div', undefined, 'grid');
  grid.append(kv('Runner 安装身份', runner.runner_id ?? '尚未确认', 'mono'), kv('远端工作区', runner.workspace_id ?? '未知', 'mono'),
    kv('中央已接收 HEAD', runner.head_commit ?? '尚未接收', 'mono'),
    kv('持久同步状态', `${runner.state ?? 'unknown'} · ${state}`),
    ...barriers.map(row => kv(`${row.label}未结算`, String(row.count ?? '未知'))));
  advanced.append(grid, el('p', '以上为中央持久记录，不是远端实时 HEAD；屏障为 0 不证明在线。项目授权不等于设备已启用或连接可用。', 'hint'));
  root.append(advanced);
  return root;
}
