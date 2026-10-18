import { button, el } from './dom.js';
import { api } from './api.js';

/** Explicit, read-only disclosure of the shipped files; never interpret their text as HTML. */
export function skillSource(skill, ownsPage) {
  const details = el('details', undefined, 'skill-source');
  const body = el('div', undefined, 'skill-source-body');
  details.append(el('summary', '查看 Skill 原文（只读）'), body);
  let pending = null, loaded = false;
  const current = () => ownsPage();
  async function load() {
    if (!current() || loaded || pending) return pending;
    body.replaceChildren(el('p', '正在读取 Skill 原文…', 'hint')); body.setAttribute('aria-busy', 'true');
    const reading = (async () => {
      try {
        const value = await api(`/api/host/skills?id=${encodeURIComponent(skill.id)}`);
        if (!current()) return;
        if (value?.version !== 1 || value.id !== skill.id
          || !['entry', 'guide'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 65536)) {
          throw new Error('Skill 原文响应不完整，请更新 Host 后重试。');
        }
        const entry = el('pre', value.entry), guide = el('pre', value.guide);
        entry.dataset.skillDocument = 'entry'; guide.dataset.skillDocument = 'guide';
        body.replaceChildren(el('p', '以下是此 Host 版本随软件提供的完整原文，仅供阅读与选择复制，不能在此修改。不是正在运行的 Worker 调用快照。', 'hint'),
          el('h3', 'SKILL.md · 入口'), entry, el('h3', 'guide.md · 完整指南'), guide);
        loaded = true;
      } catch (error) {
        if (!current()) return;
        const failure = el('p', `原文读取失败：${error.message}`, 'settings-error'); failure.setAttribute('role', 'alert');
        body.replaceChildren(failure, button('重新读取原文', load, 'ghost'));
      } finally { pending = null; if (current()) body.setAttribute('aria-busy', 'false'); }
    })();
    pending = reading; return reading;
  }
  details.ontoggle = () => details.open ? load() : undefined;
  return details;
}
