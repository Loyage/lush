import { el, syncChildren } from './dom.js';
import { ROLE, STATUS, SPEC_STATUS } from './format.js';

// 选项随数据变化的筛选控件（角色 / planner / 意图状态）
export const filterUi = {};              // 选项随数据变化的筛选控件（角色 / planner / 意图状态）
/* ---------- 筛选条控件：节点建一次就够，轮询只换 option、不重建输入框 ---------- */
export function syncSelectOptions(select, options, value) {
  const signature = options.map(option => `${option.value}\u0000${option.label}`).join('\u0001');
  if (select.dataset.options !== signature) {
    select.dataset.options = signature;
    select.replaceChildren(...options.map(option => { const node = el('option', option.label); node.value = option.value; return node; }));
  }
  select.value = value;
}
export function filterSelect(label, options, value, onChange) {
  const wrap = el('label', undefined, 'filter');
  wrap.append(el('span', label, 'filter-label'));
  const select = el('select', undefined, 'filter-select');
  select.title = label;
  syncSelectOptions(select, options, value);
  select.addEventListener('change', () => onChange(select.value));
  wrap.append(select);
  return { wrap, select };
}
export function filterToggle(label, checked, onChange) {
  const wrap = el('label', undefined, 'filter filter-check');
  const box = el('input', undefined, 'filter-toggle');
  box.type = 'checkbox'; box.checked = checked; box.title = label;
  box.addEventListener('change', () => onChange(box.checked));
  wrap.append(box, el('span', label, 'filter-label'));
  return { wrap, box };
}
/** 展开的多选组；空集合代表全部。复用选项节点，轮询不打断焦点。 */
export function filterMulti(label, options, value, onChange) {
  const wrap = el('fieldset', undefined, 'filter-multi');
  wrap.append(el('legend', label, 'filter-label'));
  const choices = el('div', undefined, 'filter-options');
  wrap.append(choices);
  let selected = [], latestOptions = options;
  const sync = (nextOptions, current) => {
    latestOptions = nextOptions;
    selected = (Array.isArray(current) ? current : [current]).filter(value => typeof value === 'string' && value && value !== 'all');
    const known = new Map([...choices.children].map(node => [node.dataset.value, node]));
    const allOptions = [{ value: 'all', label: '全部' }, ...nextOptions];
    for (const value of selected) if (!allOptions.some(option => option.value === value)) allOptions.push({ value, label: value });
    const nodes = allOptions.map(option => {
      let node = known.get(option.value);
      if (!node) {
        const control = filterToggle(option.label, false, checked => {
          const next = option.value === 'all' ? [] : checked
            ? [...new Set([...selected, option.value])] : selected.filter(value => value !== option.value);
          sync(latestOptions, next);
          onChange(next);
        });
        node = control.wrap;
        node.dataset.value = option.value;
        control.box.value = option.value;
      }
      node.querySelector('input').checked = option.value === 'all' ? !selected.length : selected.includes(option.value);
      return node;
    });
    syncChildren(choices, nodes);
  };
  sync(options, value);
  return { wrap, sync };
}
export function filterInput(value, onChange) {
  const wrap = el('label', undefined, 'filter filter-text');
  const input = el('input', undefined, 'filter-input');
  input.type = 'search'; input.value = value; input.placeholder = '关键字';
  input.setAttribute('aria-label', '按关键字筛选');
  input.addEventListener('input', () => onChange(input.value));
  wrap.append(input);
  return { wrap, input };
}
export const roleOption = value => ({ value, label: ROLE[value] || value });
export const statusOption = value => ({ value, label: STATUS[value]?.label || value });
export const specStatusOption = value => ({ value, label: SPEC_STATUS[value]?.label || value });
export const plannerOption = value => ({ value: String(value), label: `planner #${value}` });
/** 角色 / planner 这类选项随数据出现：把当前值补进去，免得筛选值从选项里消失、select 被清空。 */
export function withCurrent(options, current, label) {
  if (current === 'all' || options.some(option => option.value === current)) return options;
  const option = label(current);
  return [...options, typeof option === 'object' ? option : { value: current, label: option }];
}
export function uniqueValues(rows, field) {
  return [...new Set((rows || []).map(row => row[field]).filter(value => value !== null && value !== undefined))]
    .sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
}
