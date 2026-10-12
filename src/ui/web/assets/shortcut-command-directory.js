import { el, button, badge } from './dom.js';
import { searchField } from './search-field.js';
import { commandKind, commandBody } from './shortcut-command-model.js';

/** Complete loaded catalogue filter. Draft text is never applied by a select change. */
export function commandDirectory({ model: initial, label, onSelect = () => {}, locked = () => false }) {
  const node = el('div', undefined, 'shortcut-directory'), list = el('div', undefined, 'shortcut-directory-list');
  let model = initial, selected = initial.items[0]?.id ?? null;
  const search = searchField({ label, placeholder: '名称、作用、场景或标签', scope: '范围：已加载的当前项目完整指令目录（本地过滤）', onSubmit: () => paint() });
  function filter(label, choices) {
    const wrap = el('label', label, 'hook-field'), input = el('select'); input.setAttribute('aria-label', label);
    for (const [value, text] of choices) { const option = el('option', text); option.value = value; input.append(option); }
    input.value = ''; input.onchange = () => paint(); wrap.append(input); return { wrap, input };
  }
  const type = filter(`${label}类型`, [['', '全部类型'], ['shell', 'Shell'], ['prompt', '提示词']]);
  const authorization = filter(`${label}授权`, [['', '全部授权'], ['yes', '已授权'], ['no', '未授权／已撤权']]);
  const filters = el('div', undefined, 'shortcut-directory-filters'); filters.append(type.wrap, authorization.wrap);
  const status = el('p', undefined, 'hint'); status.setAttribute('role', 'status'); node.append(search.root, filters, status, list);
  function paint() {
    list.replaceChildren(); const query = search.applied.toLocaleLowerCase();
    const items = model.items.filter(item => (!type.input.value || commandKind(item) === type.input.value)
      && (!authorization.input.value || item.authorized === (authorization.input.value === 'yes'))
      && [item.name, item.description, item.when_to_use, ...(item.tags || [])].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
    status.textContent = `${items.length} / ${model.items.length} 项${!items.length ? ' · 没有匹配的指令。' : ''}；一次选择一条查看详情。`;
    for (const item of items) {
      const pick = button(item.name, () => {
        if (locked()) return; selected = item.id; paint(); onSelect(item);
      }, 'ghost shortcut-directory-pick');
      pick.dataset.commandId = item.id; pick.setAttribute('aria-pressed', String(item.id === selected));
      pick.disabled = locked();
      const entry = el('div', undefined, 'shortcut-directory-entry'); entry.append(pick, badge(commandKind(item) === 'prompt' ? '提示词' : 'Shell'), badge(`v${item.version}`), badge(item.authorized ? '已授权' : '未授权'));
      if (item.description) entry.append(el('span', item.description, 'shortcut-directory-description'));
      list.append(entry);
    }
  }
  paint();
  return { node, selected: () => model.items.find(item => item.id === selected) || null,
    select(id) { selected = id; paint(); },
    update(next) { model = next; if (selected === null && next.items.length) selected = next.items[0].id; paint(); }, sync: paint };
}
export function commandDetail(command, className = 'shortcut-command') {
  const card = el('article', undefined, `hook-mount ${className}`); card.dataset.commandId = command.id;
  const head = el('div', undefined, 'hook-mount-head'); head.append(el('strong', command.name), badge(commandKind(command) === 'prompt' ? '提示词' : 'Shell'), badge(`v${command.version}`), badge(command.authorized ? '已授权' : '未授权／已撤权'));
  card.append(head);
  for (const [key, title] of [['description', '作用'], ['when_to_use', '调用场景'], ['tags', '标签'], ['examples', '示例'], ['warnings', '风险']]) {
    card.append(el('p', `${title}：${key === 'tags' ? command.tags?.join('、') || '未填写' : command[key] || '未填写'}`, 'shortcut-command-metadata'));
  }
  card.append(el('h4', commandKind(command) === 'prompt' ? '提示词正文' : 'Shell 正文'));
  const source = el('pre', commandBody(command), 'hook-action-preview'); source.setAttribute('data-worker-links', 'off'); card.append(source);
  return card;
}
