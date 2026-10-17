import { AUTOMATION_METADATA, automationMetadata, DISPLAY_PRINCIPLES, automationDefaultShown } from './render-hooks.js';
export { AUTOMATION_METADATA, automationMetadata, DISPLAY_PRINCIPLES, automationDefaultShown };

/** UI feature directory only; configuration and execution authority stay in their engines. */
const renderers = { completion: 'renderCompletionAutomation', push: 'renderPushAutomation', acceptance_notice: 'renderAcceptanceNoticeAutomation' };
export const AUTOMATION_FEATURES = Object.freeze(AUTOMATION_METADATA.map(item => ({ ...item,
  load: () => import('./automation-feature-pages.js').then(module => module[renderers[item.id]]),
})));
export const automationFeature = id => AUTOMATION_FEATURES.find(feature => feature.id === id);
export function automationHash(feature = null) {
  return feature === 'emission' ? '#inputs' : !feature ? '#hooks' : ['completion', 'push', 'acceptance_notice', 'convergence'].includes(feature) ? `#hooks-${feature}` : `#hooks-feature-${encodeURIComponent(feature)}`;
}
export function automationTarget(hash) {
  if (hash === '#hooks' || hash === '#hooks-history') return { feature: null, subpage: 'settings' };
  if (hash.startsWith('#hooks-feature-')) { try { return { feature: decodeURIComponent(hash.slice(15)), subpage: 'settings' }; } catch { return null; } }
  const match = /^#hooks-(completion|push|convergence|acceptance_notice|emission)(-history)?$/.exec(hash);
  return match ? { feature: match[1], subpage: 'settings' } : null;
}
