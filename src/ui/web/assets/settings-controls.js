/** DOM primitives shared only by the device settings editors. */
import { el } from './dom.js';
export function row(title, note, control) {
  const container = el('div', undefined, 'settings-row');
  const copy = el('div', undefined, 'settings-copy');
  copy.append(el('span', title, 'settings-name'));
  if (note) copy.append(el('span', note, 'settings-note'));
  container.append(copy, control);
  return container;
}

export const thinkingLabel = value => value || 'CLI 默认';
export function selectOptions(select, values, selected, label = value => value) {
  select.replaceChildren(...values.map(value => { const option = el('option', label(value)); option.value = value; return option; }));
  select.value = values.includes(selected) ? selected : '';
}

export function field(label, control, note = '', extraClass = '') {
  const wrap = el('label', undefined, `agent-field${extraClass ? ` ${extraClass}` : ''}`);
  wrap.append(el('span', label, 'agent-field-label'), control);
  if (note) wrap.append(el('span', note, 'settings-note'));
  return wrap;
}
