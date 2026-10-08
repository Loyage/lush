import { el } from './dom.js';
import { questionnairePanel } from './render-questionnaire.js';

/** Historical questions and answers remain read-only; snapshots and reselection are disabled. */
export function settledDecision(notice) {
  const root = el('div', undefined, 'settled-decision');
  root.append(questionnairePanel(notice));
  return root;
}
