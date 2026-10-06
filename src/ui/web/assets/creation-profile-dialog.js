import { el, button } from './dom.js';
import { api } from './api.js';
import { formDialog, confirmDialog, closeDialog } from './dialog.js';
import { createProfileForm } from './agent-profile-form.js';
import { show } from './messages.js';

/** Private, write-only creation override. Cancelling never clears a previous local selection. */
export async function chooseCreationProfile({ profile = null, ownsPage = () => true, title = '预约 Worker 的运行设置' } = {}) {
  const unchanged = { changed: false, profile };
  let settings;
  try { settings = await api('/api/agent/config'); }
  catch (error) { if (ownsPage()) show(`运行设置读取失败：${error.message}`, 'error'); return unchanged; }
  if (!ownsPage()) return unchanged;
  const initial = profile || settings.resolved?.agent || settings.default || {};
  const form = createProfileForm({ profile: initial, settings, role: 'agent', ownsPage });
  const content = el('div', undefined, 'retry-profile-form-wrap');
  content.append(form.node, el('p', '只编辑本次发射或预约的完整运行参数。发射时保存覆盖，不修改项目默认；原有挂载的 Prompt/env 不回读。', 'hint'));
  let useDefault = false;
  content.append(button('恢复项目默认（本条不覆盖）', () => { useDefault = true; closeDialog(); }, 'ghost', { help: '清除本次发射的本地覆盖；预约挂载时冻结当时的有效默认，不改变服务器草稿。' }));
  await form.ready;
  if (!ownsPage()) return unchanged;
  for (;;) {
    useDefault = false;
    const accepted = await formDialog({ title, content, message: '选择完整运行设置；配置不会启动 Agent。', confirmLabel: '使用这份设置',
      confirmHelp: '只选择下一次发射或预约的完整运行配置，不调用 Agent。' });
    if (!ownsPage()) return unchanged;
    if (useDefault) return { changed: true, profile: null };
    if (!accepted) return unchanged;
    const error = form.validate(); if (error) { show(error, 'error'); continue; }
    if (form.mode() !== 'pi' && form.defaultPromptValue() && form.defaultPromptValue() !== form.builtInPrompt.trim()
      && form.defaultPromptValue() !== (initial.default_prompt || '')) {
      if (!await confirmDialog({ title: '用自定义 Prompt 发射或预约？', message: '替换内置 Worker 规则可能影响 API 使用、协作、工作区安全与交付协议。只影响新建 Worker 及其派生 Worker。',
        confirmLabel: '仍然使用', danger: true, confirmHelp: '将自定义 Prompt 写入本次创建的运行覆盖，不修改项目默认。' })) continue;
    }
    if (!ownsPage()) return unchanged;
    return { changed: true, profile: form.collect() };
  }
}
