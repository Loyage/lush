import { AUTOMATION_METADATA, automationMetadata, DISPLAY_PRINCIPLES, automationDefaultShown } from './render-hooks.js';
export { AUTOMATION_METADATA, automationMetadata, DISPLAY_PRINCIPLES, automationDefaultShown };

/** UI feature directory only; configuration and execution authority stay in their engines. */
const renderers = { completion: 'renderCompletionAutomation', push: 'renderPushAutomation', acceptance_notice: 'renderAcceptanceNoticeAutomation' };
export const AUTOMATION_FEATURES = Object.freeze(AUTOMATION_METADATA.map(item => ({ ...item,
  load: () => import('./automation-feature-pages.js').then(module => module[renderers[item.id]]),
})));
export const automationFeature = id => AUTOMATION_FEATURES.find(feature => feature.id === id);
export function automationHash(feature = null) {
  return feature === 'emission' ? '#inputs' : feature ? `#hooks-${feature}` : '#hooks';
}
export function automationTarget(hash) {
  if (hash === '#hooks' || hash === '#hooks-history') return { feature: null, subpage: 'settings' };
  const match = /^#hooks-(completion|push|convergence|acceptance_notice|emission)(-history)?$/.exec(hash);
  return match ? { feature: match[1], subpage: 'settings' } : null;
}
