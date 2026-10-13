import { el, button, badge, listSurface, listEntry } from './dom.js';
import { searchField } from './search-field.js';
import { commandKind, commandBody } from './shortcut-command-model.js';

/** Complete loaded catalogue filter. Draft text is never applied by a select change. */
export function commandDirectory({ model: initial, label, onSelect = () => {}, locked = () => false }) {
  const node = el('div', undefined, 'shortcut-directory'), list = el('div', undefined, 'shortcut-directory-list');
  const tools = el('div'), card = el('section'), heading = el('div', undefined, 'section-title'); heading.append(el('h2', '项目指令'));
  const count = el('span', undefined, 'count'); heading.append(count);
  let model = initial, selected = null;
  const search = searchField({ label, placeholder: '名称、作用、场景或标签', scope: '范围：已加载的当前项目完整指令目录（本地过滤）', onSubmit: () => paint() });
  function filter(label, choices, visibleLabel) {
    const wrap = el('label', visibleLabel, 'hook-field'), input = el('select'); input.setAttribute('aria-label', label);
    for (const [value, text] of choices) { const option = el('option', text); option.value = value; input.append(option); }
    input.value = ''; input.onchange = () => paint(); wrap.append(input); return { wrap, input };
  }
  const type = filter(`${label}类型`, [['', '全部类型'], ['shell', 'Shell'], ['prompt', '提示词']], '类型');
  const filters = el('div', undefined, 'shortcut-directory-filters'); filters.append(type.wrap);
  const status = el('p', undefined, 'hint'); status.setAttribute('role', 'status');
  tools.append(search.root, filters); card.append(heading, status, list); node.append(tools, card);
  listSurface({ root: node, tools, card, heading, body: list });
  function paint() {
    list.replaceChildren(); const query = search.applied.toLocaleLowerCase();
    const items = model.items.filter(item => (!type.input.value || commandKind(item) === type.input.value)
      && [item.name, item.description, item.when_to_use, ...(item.tags || [])].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
    count.textContent = `${items.length} / ${model.items.length}`;
    status.textContent = !model.items.length ? '尚未注册快捷指令；可增加指令供 Hook 引用。' : !items.length ? '没有匹配的指令；请调整搜索或筛选。' : `${items.length} 项；选择一条查看详情。`;
    for (const item of items) {
      const pick = listEntry(button(item.name, () => {
        if (locked()) return; selected = item.id; paint(); onSelect(item);
      }, 'ghost shortcut-directory-pick'));
      pick.dataset.commandId = item.id; pick.setAttribute('aria-pressed', String(item.id === selected));
      pick.disabled = locked(); pick.classList.toggle('selected', item.id === selected);
      const head = el('span', undefined, 'shortcut-directory-entry'); head.append(el('strong', item.name), badge(commandKind(item) === 'prompt' ? '提示词' : 'Shell'), badge(`v${item.version}`));
      pick.replaceChildren(head);
      if (item.description) pick.append(el('span', item.description, 'shortcut-directory-description'));
      if (pick.disabled) { const host = el('span', undefined, 'help-host'); host.tabIndex = 0; host.setAttribute('data-help', '请先保存或取消当前指令草稿；确认或保存期间不能选择另一条指令。'); host.append(pick); list.append(host); }
      else list.append(pick);
    }
  }
  paint();
  return { node, selected: () => model.items.find(item => item.id === selected) || null,
    select(id) { selected = id; paint(); },
    update(next) { model = next; paint(); }, sync: paint,
    focusSelected() { [...list.querySelectorAll('button')].find(item => item.dataset.commandId === selected)?.focus({ preventScroll: true }); } };
}
export function commandDetail(command, className = 'shortcut-command') {
  const card = el('article', undefined, `hook-mount ${className}`); card.dataset.commandId = command.id;
  const head = el('div', undefined, 'hook-mount-head'); head.append(el('strong', command.name), badge(commandKind(command) === 'prompt' ? '提示词' : 'Shell'), badge(`v${command.version}`));
  card.append(head);
  for (const [key, title] of [['description', '作用'], ['when_to_use', '调用场景'], ['tags', '标签'], ['examples', '示例'], ['warnings', '风险']]) {
    card.append(el('p', `${title}：${key === 'tags' ? command.tags?.join('、') || '未填写' : command[key] || '未填写'}`, 'shortcut-command-metadata'));
  }
  card.append(el('h4', commandKind(command) === 'prompt' ? '提示词正文' : 'Shell 正文'));
  const source = el('pre', commandBody(command), 'hook-action-preview'); source.setAttribute('data-worker-links', 'off'); card.append(source);
  return card;
}
