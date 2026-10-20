import { el } from './dom-base.js';
import { show } from './messages.js';

/** Pure presentation: callers own state, persistence, reading and draft guards. */
export function disclosureIcon(node, expanded) {
  node.classList.add('view-disclosure-icon');
  node.setAttribute('aria-hidden', 'true');
  node.dataset.expanded = String(Boolean(expanded));
}

/** Use on a standalone disclosure, not an entire tree row or native summary. */
export function paintDisclosure(node, expanded, { expand = '展开', collapse = '收起', help } = {}) {
  if (!node.viewLabel) {
    node.viewIcon = el('span'); node.viewLabel = el('span', undefined, 'view-control-label');
    node.replaceChildren(node.viewIcon, node.viewLabel);
    node.classList.add('view-control');
  }
  disclosureIcon(node.viewIcon, expanded);
  const label = expanded ? collapse : expand;
  if (node.viewLabel.textContent !== label) node.viewLabel.textContent = label;
  node.setAttribute('aria-expanded', String(Boolean(expanded)));
  if (help) node.setAttribute('data-help', help);
}

function control(run, describe, className = '') {
  const root = el('span', undefined, 'help-host view-control-host');
  const button = el('button', undefined, `ghost view-control ${className}`.trim()); button.type = 'button';
  root.append(button);
  let busy = false;
  const sync = () => {
    const state = describe(button);
    button.disabled = busy || Boolean(state.disabled);
    const help = busy ? '正在应用视图设置，请稍候。' : state.disabled || state.help;
    root.setAttribute('data-help', help); button.setAttribute('data-help', help);
    root.tabIndex = button.disabled ? 0 : -1;
  };
  button.onclick = async () => {
    if (button.disabled) return;
    busy = true; sync();
    try { await run(); } catch (error) { show(error.message, 'error'); }
    finally { busy = false; sync(); }
  };
  sync();
  return { root, button, sync };
}

/** One button names the current order; help names the next action and actual scope. */
export function sortControl({ getOrder, setOrder, scope, disabled = () => '', className = '' }) {
  return control(() => setOrder(getOrder() === 'asc' ? 'desc' : 'asc'), node => {
    const asc = getOrder() === 'asc', label = asc ? '最早在前' : '最新在前';
    if (!node.viewLabel) {
      const icon = el('span', undefined, 'view-sort-icon'); icon.setAttribute('aria-hidden', 'true');
      icon.append(el('i'), el('i'), el('i'));
      node.viewLabel = el('span', undefined, 'view-control-label'); node.append(icon, node.viewLabel);
    }
    node.dataset.order = asc ? 'asc' : 'desc'; node.viewLabel.textContent = label;
    return { disabled: disabled(), help: `当前${label}；点击切换为${asc ? '最新在前' : '最早在前'}。${scope}` };
  }, className);
}

/** Mixed state always expands first. Only the caller decides whether future pages inherit it. */
export function batchDisclosure({ getItems, isExpanded, setExpanded, scope, empty = '当前范围没有可展开或收起的内容。', className = '' }) {
  return control(() => {
    const items = [...getItems()];
    if (items.length) return setExpanded(!items.every(isExpanded));
  }, node => {
    const items = [...getItems()], allOpen = items.length > 0 && items.every(isExpanded);
    paintDisclosure(node, allOpen, { expand: '全部展开', collapse: '全部收起' });
    // A batch action is not itself a disclosure region (mixed state has no aria-expanded value).
    node.removeAttribute('aria-expanded');
    return { disabled: items.length ? '' : empty, help: `${allOpen ? '全部已展开；点击全部收起' : '存在收起项；点击全部展开'}。${scope}` };
  }, className);
}
