import { el } from './dom.js';

/** A candidate is a shortcut for the editable model name, not a second saved setting. */
export function createModelChoice({ model, candidates }) {
  const node = el('div', undefined, 'model-choice-row');
  const field = (text, control) => {
    const label = el('label', undefined, 'model-choice-field');
    label.append(el('span', text, 'model-choice-label'), control);
    return label;
  };
  node.append(field('候选模型', candidates), field('模型名称', model));
  const sync = () => {
    const value = model.value.trim();
    candidates.value = [...candidates.children].some(option => option.value === value) ? value : '';
  };
  model.addEventListener('input', sync);
  return { node, sync };
}
