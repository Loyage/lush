import { $, button, el } from './dom.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { settingsClient } from './settings-api.js';
import { skillSource } from './skill-source.js';

// Metadata and setting keys come from the Host's code-owned capability registry,
// never a second frontend catalogue or third-party resource discovery.
function skillsOf(runtime) {
  const skills = runtime?.builtin_skills;
  if (!Array.isArray(skills) || !skills.length || skills.some(skill =>
    !['id', 'name', 'title', 'description', 'setting', 'trigger', 'effect'].every(key => typeof skill?.[key] === 'string' && skill[key])
    || typeof runtime[skill.setting]?.value !== 'boolean')
    || new Set(skills.map(skill => skill.id)).size !== skills.length
    || new Set(skills.map(skill => skill.setting)).size !== skills.length) {
    throw new Error('Host 未提供完整的内置 Skills 状态，请更新界面服务后重新读取。');
  }
  return skills;
}

let pageState = null;
export function openSkills() {
  const view = activateDetailView({ view: 'skills' }), owner = globalThis.document;
  if (pageState?.view === view && pageState.owner === owner) return pageState.pending;
  const state = { view, owner, pending: null, runtime: null, saving: false, uncertain: false };
  pageState = state;
  const owns = () => owner === globalThis.document && ui.view === view && pageState === state;
  const client = settingsClient(), page = el('section', undefined, 'skills-page');
  const header = el('header', undefined, 'skills-head');
  header.append(el('h1', 'Skills'), el('p', '了解并选择 Lush 自带的 Agent 能力。所有项目共享这份设备设置，Pi 与 Codex 的后续调用统一生效。', 'hint'));
  const boundary = el('p', '关闭仅控制 Skill 入口注入及主动使用，不是权限隔离；CLI / API 权限不变，当前调用与已有子 Worker 不受影响，安全与交付边界始终保留。保存不会立即调用 Agent。本页不安装或管理第三方 Skills。', 'settings-note');
  const tools = el('div', undefined, 'skills-tools'), content = el('div', undefined, 'skills-grid');
  const feedback = el('p', '', 'settings-note'); feedback.dataset.capabilityStatus = ''; feedback.setAttribute('role', 'status');
  const refresh = button('重新读取', () => load(), 'ghost');
  const reset = button('恢复 Skills 默认', () => save(Object.fromEntries(skillsOf(state.runtime).map(skill => [skill.setting, null]))), 'ghost',
    { help: '清除所有内置 Skills 的设备开关覆盖，恢复全部开启；不删除历史、不打断当前调用，也不立即调用 Agent。' });
  reset.dataset.capabilityReset = '';
  const resetHost = el('span', undefined, 'help-host'); resetHost.append(reset);
  tools.append(refresh, resetHost); page.append(header, boundary, tools, feedback, content); $('detail').replaceChildren(page);
  const controls = [];
  function message(text, error = false) {
    feedback.textContent = text; feedback.className = error ? 'settings-error' : 'settings-note';
    feedback.setAttribute('role', error ? 'alert' : 'status');
  }
  function syncControls() {
    const blocked = state.saving || Boolean(state.pending) || state.uncertain || !state.runtime;
    const reason = state.uncertain ? '保存结果未确认，请先重新读取设备状态。'
      : state.pending || state.saving ? '正在读取或保存设备 Skills 设置，请稍候。' : '设备 Skills 状态尚未确认，请重新读取。';
    for (const { skill, input, status, host } of controls) {
      input.checked = state.runtime[skill.setting].value;
      input.disabled = blocked;
      status.textContent = input.checked ? '已开启' : '已关闭';
      host.setAttribute('data-help', blocked ? reason : `切换${skill.title}，直接保存到设备设置；所有项目后续调用生效，不立即调用 Agent。`);
    }
    reset.disabled = blocked; refresh.disabled = state.saving || Boolean(state.pending);
    if (blocked) resetHost.setAttribute('data-help', reason); else resetHost.removeAttribute('data-help');
    content.setAttribute('aria-busy', String(state.saving || Boolean(state.pending)));
  }
  let paintRevision = 0;
  function paint() {
    const revision = ++paintRevision;
    controls.length = 0; content.replaceChildren();
    for (const skill of skillsOf(state.runtime)) {
      const card = el('article', undefined, 'skill-card'); card.dataset.skill = skill.id;
      const head = el('div', undefined, 'skill-card-head'), title = el('h2', skill.title);
      title.id = `skill-${skill.id}`; card.setAttribute('aria-labelledby', title.id);
      const toggle = el('label', undefined, 'skill-toggle'), input = el('input'); input.type = 'checkbox';
      input.dataset.runtimeInput = skill.setting; input.setAttribute('aria-label', `启用${skill.title}`);
      const status = el('span'), host = el('span', undefined, 'help-host'); host.append(input);
      toggle.append(host, status); head.append(title, toggle);
      const details = el('details', undefined, 'skill-details');
      details.append(el('summary', '使用说明'), el('p', `适用时机：${skill.trigger}`), el('p', skill.effect), el('code', skill.name));
      card.append(head, el('p', skill.description, 'skill-description'), details,
        skillSource(skill, () => owns() && paintRevision === revision)); content.append(card);
      controls.push({ skill, input, status, host }); input.onchange = () => save({ [skill.setting]: input.checked });
    }
  }
  async function load() {
    if (!owns() || state.pending || state.saving) return state.pending;
    message('正在读取设备 Skills…');
    const pending = (async () => {
      try {
        const runtime = await client.read('/api/settings/runtime'); skillsOf(runtime);
        if (!owns()) return;
        state.runtime = runtime; state.uncertain = false; paint(); message('开关直接保存；所有项目后续调用生效。');
      } catch (error) { if (owns()) message(`读取失败：${error.message}${state.runtime ? ' 显示上次已确认状态。' : ''}`, true); }
      finally { state.pending = null; if (owns()) syncControls(); }
    })();
    state.pending = pending; syncControls(); return pending;
  }
  async function save(settings) {
    if (!owns() || state.saving || state.pending || state.uncertain || !state.runtime) return;
    state.saving = true; syncControls(); message('正在保存设备 Skills 设置…');
    try {
      const saved = await client.action('system.configure', { settings }); skillsOf(saved);
      if (!owns()) return;
      state.runtime = saved; message('能力设置已保存；所有项目后续调用生效，当前调用与已有子 Worker 不受影响。');
    } catch (error) {
      if (!owns()) return;
      state.uncertain = true; message(`保存未确认：${error.message}。显示上次已确认状态，请重新读取核对后再编辑。`, true);
    } finally { state.saving = false; if (owns()) syncControls(); }
  }
  return load();
}
