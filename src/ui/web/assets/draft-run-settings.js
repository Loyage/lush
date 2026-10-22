import { el, button } from './dom.js';
import { api } from './api.js';
import { confirmDialog } from './dialog.js';

/** One lazy inline form per active entry. Opening/refreshing never creates an override. */
export function createDraftRunSettings({ entry, current, changed }) {
  const node = el('div', undefined, 'draft-run-settings');
  const status = el('p', undefined, 'hint'); status.setAttribute('role', 'status');
  const fields = el('fieldset', undefined, 'draft-run-fields');
  const note = el('p', '修改后作为本条运行选择，仅提交时生效；不修改项目默认，不写入服务器草稿。', 'hint');
  const reset = button('恢复默认（本条不覆盖）', () => {
    if (!current() || entry.flight || entry.operation) return;
    generation++; profileForm = null; loading = null; edited = false; issue = ''; acceptedPrompt = '';
    entry.profile = null; fields.replaceChildren(); changed(); void load();
  }, 'ghost', { help: '清除本条运行覆盖，提交时使用有效默认配置；不修改项目默认、正文或服务器草稿。' });
  const retry = button('重试读取运行设置', () => load(), 'ghost'); retry.hidden = true;
  node.append(note, status, fields, reset, retry);
  let profileForm = null, loading = null, edited = false, issue = '', baseline = '', generation = 0, acceptedPrompt = '';
  const followup = entry.mode === 'append' || entry.target_id != null;
  if (followup) {
    note.textContent = '追加输入沿用目标已有运行设置，不能在此覆盖。'; fields.hidden = reset.hidden = true;
  }
  const fingerprint = () => JSON.stringify(profileForm.collect());
  function update() {
    if (!current() || !profileForm || loading || !edited) return;
    issue = profileForm.validate() || '';
    const invalid = fields.querySelectorAll('input');
    if (!issue && [...invalid].some(input => !input.disabled && input.validity?.valid === false)) issue = '请检查数值范围与字段格式';
    if (!issue) {
      try {
        const profile = profileForm.collect();
        if (JSON.stringify(profile) !== JSON.stringify(entry.profile)) { entry.profile = profile; changed(); }
      } catch (error) { issue = error.message; }
    }
    paint();
  }
  function edit(event) {
    if (!current() || !profileForm || loading || entry.flight || entry.operation) return;
    // Button actions (reset Prompt/default parameters) change values without DOM input events.
    if (event.type === 'click') {
      if (!event.target.closest?.('button')) return;
      try { if (fingerprint() === baseline) return; } catch { /* preserve invalid field text */ }
    }
    edited = true; update();
    try { baseline = fingerprint(); } catch { baseline = ''; }
    changed(); // invalid local edits also affect authorization readiness
  }
  fields.addEventListener('input', edit); fields.addEventListener('change', edit); fields.addEventListener('click', edit);
  // Enter in a settings field must not implicitly submit the outer draft form.
  fields.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && event.target.tagName === 'INPUT') event.preventDefault();
  });
  function paint() {
    fields.disabled = Boolean(loading || entry.flight || entry.operation);
    reset.disabled = Boolean(entry.flight || entry.operation);
    status.textContent = issue ? `运行设置未就绪：${issue}。修改仍保留，请修正或恢复默认。`
      : loading ? '正在读取运行设置…' : edited ? '本条运行设置已选择；尚未提交。' : '';
    status.classList.toggle('draft-run-error', Boolean(issue));
  }
  async function load() {
    if (followup || profileForm || loading || !current()) return loading;
    const token = ++generation, live = () => current() && generation === token;
    retry.hidden = true; issue = '';
    const pending = (async () => {
      const settings = await api('/api/agent/config'); if (!live()) return;
      if (entry.mode === 'management') {
        const { createManagementProfileForm } = await import('./management-profile-form.js'); if (!live()) return;
        profileForm = createManagementProfileForm(settings, { profile: entry.profile, ownsPage: live });
      } else {
        const { createProfileForm } = await import('./agent-profile-form.js'); if (!live()) return;
        const defaults = settings.resolved?.agent || settings.default || {};
        profileForm = createProfileForm({ profile: entry.profile || defaults, defaultProfile: defaults, settings, role: 'agent', ownsPage: live, showDefaults: false,
          onChange: () => { if (live()) update(); } });
      }
      fields.replaceChildren(profileForm.node);
      await profileForm.ready; if (!live()) return;
      baseline = fingerprint();
    })();
    loading = pending; paint();
    try { await pending; }
    catch (error) {
      if (live()) { issue = error.message; profileForm = null; fields.replaceChildren(); retry.hidden = false; }
    } finally { if (live()) { loading = null; paint(); } }
  }
  function validate() {
    update();
    // Merely opening a failed/unfinished read must not invalidate the unchanged default or local override.
    return edited ? issue : '';
  }
  return { node, load, paint, validate, get issue() { return edited ? issue : ''; },
    async confirm() {
      const error = validate(); if (error) throw Error(error);
      const profile = entry.profile, prompt = profile?.default_prompt?.trim();
      if (entry.mode !== 'order' || profile?.config_mode === 'pi' || !prompt || prompt === acceptedPrompt) return true;
      const snapshot = JSON.stringify(profile);
      const accepted = await confirmDialog({ title: '用自定义 Prompt 提交或预约？',
        message: '替换内置 Worker 规则可能影响 API 使用、协作、工作区安全与交付协议。只影响新建 Worker 及其派生 Worker。',
        confirmLabel: '仍然使用', danger: true, confirmHelp: '将自定义 Prompt 写入本次创建的运行覆盖，不修改项目默认。' });
      if (!accepted || !current() || JSON.stringify(entry.profile) !== snapshot) return false;
      acceptedPrompt = prompt; return true;
    },
    dispose() { generation++; fields.removeEventListener('input', edit); fields.removeEventListener('change', edit); fields.removeEventListener('click', edit); },
  };
}
