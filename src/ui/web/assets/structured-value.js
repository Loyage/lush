import { el, button } from './dom.js';

/** Text-only JSON tree: lazy children, bounded depth/width; raw text always remains available. */
export function structuredValue(text, { openRoot = false, preview = true } = {}) {
  const root = el('div', undefined, 'structured-value');
  let value;
  try { value = JSON.parse(text); } catch { root.append(el('pre', text, 'raw-value')); return root; }
  if (!value || typeof value !== 'object') { root.append(el('pre', text, 'raw-value')); return root; }
  const tree = el('div', undefined, 'json-tree');
  let nodes = 0;
  const node = (key, item, depth) => {
    nodes++;
    if (!item || typeof item !== 'object') {
      const leaf = el('div', undefined, `json-leaf json-${typeof item}`);
      const value = typeof item === 'string' ? item : JSON.stringify(item);
      const excerpt = typeof item === 'string' && preview ? value.split('\n').slice(0, 10).join('\n').slice(0, 1000) : value;
      const content = el('span', excerpt, 'json-value');
      leaf.append(el('span', `${key}: `, 'json-key'), content);
      if (excerpt.length < value.length) {
        let full = false;
        const toggle = button('展开剩余字符串', () => {
          full = !full; content.textContent = full ? value : excerpt;
          toggle.textContent = full ? '收起为预览' : '展开剩余字符串'; toggle.setAttribute('aria-expanded', String(full));
        }, 'ghost');
        toggle.setAttribute('aria-expanded', 'false'); leaf.append(toggle);
      }
      return leaf;
    }
    const entries = Object.entries(item), array = Array.isArray(item);
    const row = el('details', undefined, 'json-branch');
    row.append(el('summary', `${key} ${array ? '[' : '{'}${entries.length}${array ? ']' : '}'}`));
    let loaded = false;
    const expand = () => {
      if (!row.open || loaded) return;
      loaded = true;
      if (depth >= 12 || nodes >= 1500) { row.append(el('p', '结构预览已达上限，请看原文。', 'hint')); return; }
      for (const [name, child] of entries.slice(0, 100)) {
        if (nodes >= 1500) break;
        row.append(node(name, child, depth + 1));
      }
      if (entries.length > 100 || nodes >= 1500) row.append(el('p', '仅显示部分节点，完整内容见原文。', 'hint'));
    };
    row.addEventListener('toggle', expand);
    if (openRoot && depth === 0) { row.open = true; expand(); }
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
