/**
 * 「设置」视图：阅读 / 外观 / 左栏 / 行为四组本地偏好，全部经 prefs.js 读写，每项改动立即持久化、立即生效，
 * 另有「恢复默认设置」。设置页只读 localStorage，不依赖 snapshot 也能画出来。
 *
 * 幂等：每次 renderSettings() 只替换 #detail 的内容，重建控件并读回最新偏好。
 * 1.5s 轮询不会碰它——refresh.js 看到 ui.settingsOpen 就不再用概览覆盖（与 graphOpen / docsOpen 同一套排他规则）。
 */
import { $, block, button, el } from './dom.js';
import { effectiveTheme, systemThemeMedia } from './appearance.js';
import { overview } from './navigate.js';
import { PREF_NAMES, POLLING_MODES, THEME_VALUES, TOAST_MODES, onPrefChange, readPref, resetPrefs, setPref } from './prefs.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { SORT_MODES } from './tree-order.js';

/** 打开设置：清掉选中的任务详情 / 分支图 / 信息页 / 文档（右栏同一时刻只归一个视图），地址栏切到 #settings。 */
export function openSettings() {
  ui.settingsOpen = true;
  ui.graphOpen = false; ui.graphRenderKey = null;
  ui.docsOpen = false; ui.indexOpen = null;
  ui.selected = null; ui.selectedRevision = null; ui.detailDirty = false; ui.detailTask = null;
  activateDetailView({ title: '设置', context: '工作空间', hint: '本地偏好：阅读、外观、左栏与行为' });
  if (location.hash !== '#settings') window.history.pushState(null, '', '#settings');
  renderSettings();
}

function row(title, note, control) {
  const container = el('div', undefined, 'settings-row');
  const copy = el('div', undefined, 'settings-copy');
  copy.append(el('span', title, 'settings-name'));
  if (note) copy.append(el('span', note, 'settings-note'));
  container.append(copy, control);
  return container;
}

/** 勾选式偏好：控件自己读当前值，change 时只调 setPref，重画交给 onPrefChange。 */
function toggleControl(name, onLabel = '开启', offLabel = '关闭') {
  const wrap = el('label', undefined, 'settings-toggle');
  const input = el('input');
  input.type = 'checkbox';
  input.className = 'pref-toggle';
  input.dataset.pref = name;
  input.checked = Boolean(readPref(name));
  input.addEventListener('change', () => setPref(name, input.checked));
  wrap.append(input, el('span', input.checked ? onLabel : offLabel));
  return wrap;
}

/** 单选式枚举偏好（主题）。 */
function themeControl() {
  const group = el('div', undefined, 'settings-choices');
  const current = readPref('theme');
  const labels = { system: '跟随系统', light: '浅色', dark: '深色' };
  for (const value of THEME_VALUES) {
    const wrap = el('label', undefined, 'settings-choice');
    const input = el('input');
    input.type = 'radio';
    input.name = 'theme-preference';
    input.className = 'pref-radio';
    input.dataset.pref = 'theme';
    input.dataset.value = value;
    input.checked = current === value;
    input.addEventListener('change', () => { if (input.checked) setPref('theme', value); });
    wrap.append(input, el('span', labels[value] ?? value));
    group.append(wrap);
  }
  return group;
}

/** 下拉式枚举偏好。modes 是 `{ id, label }` 列表；与别处的同名控件共用同一个偏好键。 */
function selectControl(name, modes, title) {
  const select = el('select');
  select.className = 'pref-select';
  select.dataset.pref = name;
  if (title) select.title = title;
  for (const mode of modes) {
    const option = el('option', mode.label);
    option.value = mode.id;
    select.append(option);
  }
  select.value = readPref(name);
  select.addEventListener('change', () => {
    const known = modes.some(mode => mode.id === select.value);
    setPref(name, known ? select.value : modes[0]?.id);
  });
  return select;
}

/**
 * 「系统信息」组：只读镜像 daemon 的软件配置（system.status），值取自最近一次快照 ui.lastSnapshot。
 * 该组不写回任何东西，也不新增拉取：设置页打开时 refresh.js 仍在更新 lastSnapshot，直接读它即可。
 */
function systemInfoBlock() {
  const section = block('系统信息');
  section.append(el('p',
    '以下都是 daemon 启动时读取的环境变量与软件配置，本组仅供查看、不提供修改；改变它们需要设置环境变量并重启 daemon 才生效。',
    'settings-note settings-readonly'));
  const snapshot = ui.lastSnapshot?.status ?? null;
  if (!snapshot) {
    section.append(el('p', '尚未收到 daemon 快照，暂时读不到系统信息；连接建立后会在下一次刷新时显示。',
      'settings-value settings-placeholder'));
    return section;
  }
  const plain = value => (value === null || value === undefined || value === '') ? '—' : String(value);
  // pi 的两个覆写参数为空表示用 pi 自己的默认，不在这里猜模型名 / provider 名。
  const pi = value => (value === null || value === undefined || value === '') ? 'pi 默认' : String(value);
  const line = (field, title, note, value) => {
    const node = el('span', value, 'settings-value');
    node.dataset.systemField = field;
    return row(title, note, node);
  };
  section.append(line('provider', 'Provider', 'Agent 后端（LUSH_PROVIDER）：pi 为真实模型，mock 为离线演示后端。', plain(snapshot.provider)));
  section.append(line('concurrency', '并发额度',
    '执行通道（LUSH_CONCURRENCY）与控制通道（LUSH_CONTROL_CONCURRENCY）各自同时在跑的任务上限。',
    `${plain(snapshot.concurrency)}（控制通道 ${plain(snapshot.control_concurrency)}）`));
  section.append(line('call_timeout', '单次调用超时', '一次 agent 调用允许的最长秒数（LUSH_CALL_TIMEOUT），超时即中断。', `${plain(snapshot.call_timeout)} 秒`));
  section.append(line('task_call_limit', '单任务调用上限', '一个任务最多允许的 agent 调用次数（LUSH_TASK_CALLS）。', plain(snapshot.task_call_limit)));
  section.append(line('max_depth', '最大拆解深度', '任务树允许的最大层数（LUSH_MAX_DEPTH）。', plain(snapshot.max_depth)));
  section.append(line('pi_model', 'pi 模型', '传给 pi 的 --model（LUSH_PI_MODEL）；未设置时由 pi 自己决定。', pi(snapshot.pi_model)));
  section.append(line('pi_provider', 'pi provider', '传给 pi 的 --provider（LUSH_PI_PROVIDER）；未设置时由 pi 自己决定。', pi(snapshot.pi_provider)));
  return section;
}

/** 设置页整体重画：不依赖快照，纯读 localStorage 里的偏好。 */
export function renderSettings() {
  const panel = $('detail');
  panel.dataset.view = 'settings';

  const view = el('div', undefined, 'settings-view');
  const head = el('div', undefined, 'settings-head');
  const intro = el('div');
  intro.append(el('span', 'PREFERENCES / 本地偏好', 'eyebrow'), el('h1', '设置'),
    el('p', '这些偏好只保存在当前浏览器，不写进项目库；每项改动立刻生效。', 'hint'));
  head.append(intro, button('返回概览', () => overview(), 'ghost'));
  view.append(head);

  const reading = block('阅读');
  reading.append(row('Markdown 渲染', '按 Markdown 渲染 agent 输出；关闭后原样显示纯文本节点。与头部「Markdown 渲染」按钮共用同一偏好。', toggleControl('markdown')));
  view.append(reading);

  const system = systemThemeMedia();
  const appearance = block('外观');
  appearance.append(row('主题', `深色 / 浅色 / 跟随系统。系统当前${system?.matches ? '深色' : '浅色'}，实际显示${effectiveTheme() === 'dark' ? '深色' : '浅色'}；头部的主题按钮与这里共用同一偏好。`, themeControl()));
  appearance.append(row('减少动态效果', `勾选后停用过渡与动画，覆盖系统偏好（系统当前${systemThemeMedia()?.matches ? '已要求减少' : '未要求'}）。`, toggleControl('reduceMotion')));
  view.append(appearance);

  const sidebar = block('左栏');
  sidebar.append(row('默认排序', '左栏四个列表共用；与左栏顶部的排序下拉是同一个偏好。', selectControl('sidebarSort', SORT_MODES, '左栏四个列表共用：与左栏顶部的排序下拉是同一个偏好。')));
  view.append(sidebar);

  const behavior = block('行为');
  behavior.append(row('轮询频率', '页面自动刷新的快慢；标准档即默认的 1.5s 快照 + 3s 实时。改动后立刻按新间隔重建定时器，不必刷新页面。',
    selectControl('polling', POLLING_MODES, '页面自动刷新的快慢')));
  behavior.append(row('消息提示停留时长', '顶部消息提示自动消失的快慢；标准档即默认的 4s（信息）/ 8s（错误）。对之后出现的提示生效。',
    selectControl('toastDuration', TOAST_MODES, '顶部消息提示自动消失的快慢')));
  view.append(behavior);

  view.append(systemInfoBlock());

  const reset = block('恢复默认');
  const resetButton = el('button', '恢复默认设置', 'ghost pref-reset');
  resetButton.type = 'button';
  resetButton.onclick = () => { resetPrefs(); };
  reset.append(row('恢复默认设置', '把上面所有偏好恢复默认：Markdown 开启、主题跟随系统、智能排序、标准轮询与标准提示时长、跟随系统动效。', resetButton));
  view.append(reset);

  panel.replaceChildren(view);
}

// 任何偏好变了都同步一次设置页（含头部主题按钮与左栏排序下拉写回的值）；不在设置页时不动。
for (const name of PREF_NAMES) onPrefChange(name, () => { if (ui.settingsOpen) renderSettings(); });
