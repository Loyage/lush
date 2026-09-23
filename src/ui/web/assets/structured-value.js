import { el, button } from './dom.js';

/** Text-only JSON tree: lazy children, bounded depth/width; raw text always remains available. */
export function structuredValue(text) {
  const root = el('div', undefined, 'structured-value');
  let value;
  try { value = JSON.parse(text); } catch { root.append(el('pre', text, 'raw-value')); return root; }
  if (!value || typeof value !== 'object') { root.append(el('pre', text, 'raw-value')); return root; }
  const tree = el('div', undefined, 'json-tree');
  let nodes = 0;
  const node = (key, item, depth) => {
    nodes++;
    if (!item || typeof item !== 'object') return el('div', `${key}: ${JSON.stringify(item)}`, `json-leaf json-${typeof item}`);
    const entries = Object.entries(item), array = Array.isArray(item);
    const row = el('details', undefined, 'json-branch');
    row.append(el('summary', `${key} ${array ? '[' : '{'}${entries.length}${array ? ']' : '}'}`));
    let loaded = false;
    row.addEventListener('toggle', () => {
      if (!row.open || loaded) return;
      loaded = true;
      if (depth >= 12 || nodes >= 1500) { row.append(el('p', '结构预览已达上限，请看原文。', 'hint')); return; }
      for (const [name, child] of entries.slice(0, 100)) {
        if (nodes >= 1500) break;
        row.append(node(name, child, depth + 1));
      }
      if (entries.length > 100 || nodes >= 1500) row.append(el('p', '仅显示部分节点，完整内容见原文。', 'hint'));
    });
    return row;
  };
  tree.append(node('$', value, 0));
  const raw = el('pre', text, 'raw-value'); raw.hidden = true;
  const toggle = button('查看原文', () => {
    raw.hidden = !raw.hidden; tree.hidden = !raw.hidden;
    toggle.textContent = raw.hidden ? '查看原文' : '结构视图';
  }, 'ghost');
  root.append(toggle, el('span', ' 结构预览；精确数值以原文为准', 'hint'), tree, raw);
  return root;
}
